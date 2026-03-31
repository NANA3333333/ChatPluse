const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// master.db is intended strictly for authentication and tracking which user maps to which personal db file
const dbPath = path.join(dataDir, 'master.db');
const db = new Database(dbPath);
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '12345';

db.pragma('journal_mode = WAL');

function initAuthDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            status TEXT NOT NULL DEFAULT 'active',
            token_version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS invite_codes (
            code TEXT PRIMARY KEY,
            used_by TEXT,
            created_at INTEGER NOT NULL,
            max_uses INTEGER NOT NULL DEFAULT 1,
            use_count INTEGER NOT NULL DEFAULT 0,
            expires_at INTEGER DEFAULT 0,
            note TEXT DEFAULT '',
            created_by TEXT DEFAULT '',
            status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
    `);

    try {
        db.exec("ALTER TABLE users ADD COLUMN last_active_at INTEGER DEFAULT 0;");
    } catch (e) {
        // Column may already exist, ignore error
    }
    try {
        db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';");
    } catch (e) {
        // Column may already exist, ignore error
    }
    try {
        db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';");
    } catch (e) {
        // Column may already exist, ignore error
    }
    try {
        db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;");
    } catch (e) {
        // Column may already exist, ignore error
    }
    const inviteColumns = [
        ["max_uses", "INTEGER NOT NULL DEFAULT 1"],
        ["use_count", "INTEGER NOT NULL DEFAULT 0"],
        ["expires_at", "INTEGER DEFAULT 0"],
        ["note", "TEXT DEFAULT ''"],
        ["created_by", "TEXT DEFAULT ''"],
        ["status", "TEXT NOT NULL DEFAULT 'active'"]
    ];
    for (const [name, type] of inviteColumns) {
        try {
            db.exec(`ALTER TABLE invite_codes ADD COLUMN ${name} ${type};`);
        } catch (e) {
            // Column may already exist, ignore error
        }
    }

    // Auto-seed root admin account "Nana"
    const rootUser = db.prepare('SELECT id FROM users WHERE username = ?').get('Nana');
    if (!rootUser) {
        const adminPw = DEFAULT_ADMIN_PASSWORD;
        if (!process.env.ADMIN_PASSWORD) {
            console.log(`[AuthDB] ⚠️  No ADMIN_PASSWORD env var set. Generated random admin password: ${adminPw}`);
            console.log('[AuthDB] Set ADMIN_PASSWORD in server/.env if you want a different first-run password.');
        }
        const id = generateId();
        const hash = bcrypt.hashSync(adminPw, 10);
        db.prepare('INSERT INTO users (id, username, password_hash, created_at, role, status, token_version) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'Nana', hash, Date.now(), 'root', 'active', 0);
        console.log('[AuthDB] Root user Nana seeded successfully.');
    } else {
        db.prepare('UPDATE users SET role = ?, status = COALESCE(status, ?), token_version = COALESCE(token_version, 0) WHERE username = ?').run('root', 'active', 'Nana');
    }
    console.log('[AuthDB] Master auth database initialized successfully.');
}

// Generate a simple alphanumeric ID
function generateId() {
    return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

function createUser(username, password, inviteCode) {
    try {
        // Password strength validation
        if (!password || password.length < 5) {
            return { success: false, error: 'Password must be at least 5 characters long' };
        }

        if (!inviteCode) return { success: false, error: 'Invite code is required' };
        const invite = db.prepare('SELECT code, status, use_count, max_uses, expires_at FROM invite_codes WHERE code = ?').get(inviteCode);
        if (!invite) return { success: false, error: 'Invalid invite code' };
        if (invite.status !== 'active') return { success: false, error: 'Invite code is not active' };
        if (invite.expires_at && Date.now() > invite.expires_at) return { success: false, error: 'Invite code has expired' };
        if ((invite.use_count || 0) >= (invite.max_uses || 1)) return { success: false, error: 'Invite code has reached its usage limit' };

        const id = generateId();
        const hash = bcrypt.hashSync(password, 10);
        const role = 'user';

        db.transaction(() => {
            db.prepare('INSERT INTO users (id, username, password_hash, created_at, role, status, token_version) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, username, hash, Date.now(), role, 'active', 0);
            db.prepare(`
                UPDATE invite_codes
                SET used_by = CASE WHEN max_uses <= 1 THEN ? ELSE COALESCE(used_by, '') END,
                    use_count = COALESCE(use_count, 0) + 1,
                    status = CASE
                        WHEN (COALESCE(use_count, 0) + 1) >= COALESCE(max_uses, 1) THEN 'used'
                        ELSE status
                    END
                WHERE code = ?
            `).run(username, inviteCode);
        })();

        return { success: true, user: { id, username, role, status: 'active', tokenVersion: 0 } };
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return { success: false, error: 'Username already exists' };
        }
        return { success: false, error: e.message };
    }
}

function verifyUser(username, password) {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) return { success: false, error: 'Invalid username or password' };

    if (user.status === 'banned') {
        return { success: false, error: 'This account has been banned' };
    }

    const isValid = bcrypt.compareSync(password, user.password_hash);
    if (!isValid) return { success: false, error: 'Invalid username or password' };

    return {
        success: true,
        user: {
            id: user.id,
            username: user.username,
            role: user.role || 'user',
            status: user.status || 'active',
            tokenVersion: user.token_version || 0
        }
    };
}

function updateOwnAccount(id, options = {}) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return { success: false, error: 'User not found' };

    const currentPassword = String(options.currentPassword || '');
    const nextUsername = typeof options.username === 'string' ? options.username.trim() : '';
    const nextPassword = typeof options.newPassword === 'string' ? options.newPassword : '';

    if (!currentPassword) return { success: false, error: 'Current password is required' };
    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
        return { success: false, error: 'Current password is incorrect' };
    }

    const updates = [];
    const values = [];
    let tokenVersion = Number(user.token_version || 0);

    if (nextUsername && nextUsername !== user.username) {
        const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').get(nextUsername, id);
        if (existing) return { success: false, error: 'Username already exists' };
        updates.push('username = ?');
        values.push(nextUsername);
        tokenVersion += 1;
    }

    if (nextPassword) {
        if (nextPassword.length < 5) {
            return { success: false, error: 'New password must be at least 5 characters long' };
        }
        updates.push('password_hash = ?');
        values.push(bcrypt.hashSync(nextPassword, 10));
        tokenVersion += 1;
    }

    if (updates.length === 0) {
        return {
            success: true,
            user: {
                id: user.id,
                username: user.username,
                role: user.role || 'user',
                status: user.status || 'active',
                tokenVersion
            }
        };
    }

    updates.push('token_version = ?');
    values.push(tokenVersion);
    values.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    const updatedUser = db.prepare('SELECT id, username, role, status, token_version FROM users WHERE id = ?').get(id);
    return {
        success: true,
        user: {
            id: updatedUser.id,
            username: updatedUser.username,
            role: updatedUser.role || 'user',
            status: updatedUser.status || 'active',
            tokenVersion: updatedUser.token_version || 0
        }
    };
}

function getUserById(id) {
    return db.prepare('SELECT id, username, created_at, role, status, token_version, last_active_at FROM users WHERE id = ?').get(id);
}

function generateInviteCode(options = {}) {
    // Use crypto for unpredictable invite codes (12 chars)
    const code = crypto.randomBytes(9).toString('base64url').substring(0, 12).toUpperCase();
    const createdAt = Date.now();
    const maxUses = Math.max(1, Number(options.maxUses || 1));
    const expiresAt = Math.max(0, Number(options.expiresAt || 0));
    const note = String(options.note || '').trim();
    const createdBy = String(options.createdBy || '').trim();
    db.prepare(`
        INSERT INTO invite_codes (code, created_at, max_uses, use_count, expires_at, note, created_by, status)
        VALUES (?, ?, ?, 0, ?, ?, ?, 'active')
    `).run(code, createdAt, maxUses, expiresAt, note, createdBy);
    return code;
}

function getInviteCodes() {
    return db.prepare(`
        SELECT code, used_by, created_at, max_uses, use_count, expires_at, note, created_by, status
        FROM invite_codes
        ORDER BY created_at DESC
    `).all();
}

function getAllUsers() {
    return db.prepare('SELECT id, username, created_at, last_active_at, role, status, token_version FROM users ORDER BY created_at DESC').all();
}

function isAdminRole(role) {
    return role === 'root' || role === 'admin';
}

function updateLastActive(id) {
    try {
        db.prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(Date.now(), id);
    } catch (e) {
        console.error('[AuthDB] Failed to update last active:', e.message);
    }
}

function deleteUser(id) {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function setUserStatus(id, status) {
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
}

function setUserRole(id, role) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

function bumpTokenVersion(id) {
    db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(id);
}

function resetPassword(id, newPassword) {
    const passwordHash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ?, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(passwordHash, id);
}

function deleteInviteCode(code) {
    db.prepare('DELETE FROM invite_codes WHERE code = ?').run(code);
}

function updateInviteCode(code, data = {}) {
    const fields = [];
    const values = [];
    if (data.status) {
        fields.push('status = ?');
        values.push(data.status);
    }
    if (typeof data.note !== 'undefined') {
        fields.push('note = ?');
        values.push(String(data.note || '').trim());
    }
    if (typeof data.maxUses !== 'undefined') {
        fields.push('max_uses = ?');
        values.push(Math.max(1, Number(data.maxUses || 1)));
    }
    if (typeof data.expiresAt !== 'undefined') {
        fields.push('expires_at = ?');
        values.push(Math.max(0, Number(data.expiresAt || 0)));
    }
    if (!fields.length) return;
    values.push(code);
    db.prepare(`UPDATE invite_codes SET ${fields.join(', ')} WHERE code = ?`).run(...values);
}

function getLatestAnnouncement() {
    return db.prepare('SELECT content, created_at FROM announcements ORDER BY created_at DESC LIMIT 1').get();
}

function setAnnouncement(content) {
    db.prepare('INSERT INTO announcements (content, created_at) VALUES (?, ?)').run(content, Date.now());
}

module.exports = {
    initAuthDb,
    createUser,
    verifyUser,
    updateOwnAccount,
    getUserById,
    generateInviteCode,
    getInviteCodes,
    getAllUsers,
    updateLastActive,
    deleteUser,
    setUserStatus,
    setUserRole,
    bumpTokenVersion,
    resetPassword,
    deleteInviteCode,
    updateInviteCode,
    getLatestAnnouncement,
    setAnnouncement,
    isAdminRole
};
