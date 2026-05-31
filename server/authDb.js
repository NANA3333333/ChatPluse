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

db.pragma('journal_mode = WAL');

function generateInitialAdminPassword() {
    return crypto.randomBytes(18).toString('base64url');
}

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
        const adminPw = process.env.ADMIN_PASSWORD || generateInitialAdminPassword();
        if (!process.env.ADMIN_PASSWORD) {
            console.log(`[AuthDB] ⚠️  No ADMIN_PASSWORD env var set. Generated random admin password: ${adminPw}`);
            console.log('[AuthDB] Save this password now, then set ADMIN_PASSWORD in server/.env before the next fresh initialization if you want a fixed first-run password.');
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
    const maxUses = normalizeInviteMaxUses(options.maxUses);
    const expiresAt = normalizeInviteExpiresAt(options.expiresAt);
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

function getInviteCode(code) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode) return null;
    return db.prepare(`
        SELECT code, used_by, created_at, max_uses, use_count, expires_at, note, created_by, status
        FROM invite_codes
        WHERE code = ?
    `).get(cleanCode) || null;
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

const USER_STATUSES = new Set(['active', 'banned']);
const MUTABLE_USER_ROLES = new Set(['user', 'admin']);

function normalizeUserId(id) {
    return String(id || '').trim();
}

function deleteUser(id) {
    const cleanId = normalizeUserId(id);
    if (!cleanId) return 0;
    return db.prepare('DELETE FROM users WHERE id = ?').run(cleanId).changes || 0;
}

function setUserStatus(id, status) {
    const cleanId = normalizeUserId(id);
    const nextStatus = String(status || '').trim();
    if (!cleanId || !USER_STATUSES.has(nextStatus)) return 0;
    return db.prepare('UPDATE users SET status = ? WHERE id = ?').run(nextStatus, cleanId).changes || 0;
}

function setUserRole(id, role) {
    const cleanId = normalizeUserId(id);
    const nextRole = String(role || '').trim();
    if (!cleanId || !MUTABLE_USER_ROLES.has(nextRole)) return 0;
    return db.prepare('UPDATE users SET role = ? WHERE id = ?').run(nextRole, cleanId).changes || 0;
}

function bumpTokenVersion(id) {
    const cleanId = normalizeUserId(id);
    if (!cleanId) return 0;
    return db.prepare('UPDATE users SET token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(cleanId).changes || 0;
}

function resetPassword(id, newPassword) {
    const cleanId = normalizeUserId(id);
    if (!cleanId) return 0;
    const passwordHash = bcrypt.hashSync(newPassword, 10);
    return db.prepare('UPDATE users SET password_hash = ?, token_version = COALESCE(token_version, 0) + 1 WHERE id = ?').run(passwordHash, cleanId).changes || 0;
}

function deleteInviteCode(code) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode) return 0;
    return db.prepare('DELETE FROM invite_codes WHERE code = ?').run(cleanCode).changes || 0;
}

const MAX_INVITE_USES = 100000;
const INVITE_STATUSES = new Set(['active', 'used', 'revoked']);

class AuthValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AuthValidationError';
        this.statusCode = 400;
    }
}

function hasInviteValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}

function normalizeInviteMaxUses(value, fallback = 1) {
    if (!hasInviteValue(value)) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_INVITE_USES) {
        throw new AuthValidationError('Invalid invite max uses');
    }
    return parsed;
}

function normalizeInviteExpiresAt(value, fallback = 0) {
    if (!hasInviteValue(value)) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new AuthValidationError('Invalid invite expiry');
    }
    return parsed;
}

function normalizeInviteStatus(value) {
    const status = String(value || '').trim();
    if (!INVITE_STATUSES.has(status)) {
        throw new AuthValidationError('Invalid invite status');
    }
    return status;
}

function updateInviteCode(code, data = {}) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode) return 0;
    const fields = [];
    const values = [];
    if (data.status) {
        fields.push('status = ?');
        values.push(normalizeInviteStatus(data.status));
    }
    if (typeof data.note !== 'undefined') {
        fields.push('note = ?');
        values.push(String(data.note || '').trim());
    }
    if (typeof data.maxUses !== 'undefined') {
        fields.push('max_uses = ?');
        values.push(normalizeInviteMaxUses(data.maxUses));
    }
    if (typeof data.expiresAt !== 'undefined') {
        fields.push('expires_at = ?');
        values.push(normalizeInviteExpiresAt(data.expiresAt));
    }
    if (!fields.length) return getInviteCode(cleanCode) ? 1 : 0;
    values.push(cleanCode);
    return db.prepare(`UPDATE invite_codes SET ${fields.join(', ')} WHERE code = ?`).run(...values).changes || 0;
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
    getInviteCode,
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
