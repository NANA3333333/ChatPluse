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

function initAuthDb() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS invite_codes (
            code TEXT PRIMARY KEY,
            used_by TEXT,
            created_at INTEGER NOT NULL
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

    // Auto-seed root admin account "Nana"
    const rootUser = db.prepare('SELECT id FROM users WHERE username = ?').get('Nana');
    if (!rootUser) {
        const adminPw = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
        if (!process.env.ADMIN_PASSWORD) {
            console.log(`[AuthDB] ⚠️  No ADMIN_PASSWORD env var set. Generated random admin password: ${adminPw}`);
            console.log('[AuthDB] Set ADMIN_PASSWORD environment variable to use a fixed password.');
        }
        const id = generateId();
        const hash = bcrypt.hashSync(adminPw, 10);
        db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(id, 'Nana', hash, Date.now());
        console.log('[AuthDB] Root user Nana seeded successfully.');
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
        if (!password || password.length < 6) {
            return { success: false, error: 'Password must be at least 6 characters long' };
        }

        if (username !== 'Nana') {
            if (!inviteCode) return { success: false, error: 'Invite code is required' };
            const invite = db.prepare('SELECT used_by FROM invite_codes WHERE code = ?').get(inviteCode);
            if (!invite) return { success: false, error: 'Invalid invite code' };
            if (invite.used_by) return { success: false, error: 'Invite code has already been used' };
        }

        const id = generateId();
        const hash = bcrypt.hashSync(password, 10);

        db.transaction(() => {
            db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(id, username, hash, Date.now());
            if (username !== 'Nana') {
                db.prepare('UPDATE invite_codes SET used_by = ? WHERE code = ?').run(username, inviteCode);
            }
        })();

        return { success: true, user: { id, username } };
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

    const isValid = bcrypt.compareSync(password, user.password_hash);
    if (!isValid) return { success: false, error: 'Invalid username or password' };

    return { success: true, user: { id: user.id, username: user.username } };
}

function getUserById(id) {
    return db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id);
}

function generateInviteCode() {
    // Use crypto for unpredictable invite codes (12 chars)
    const code = crypto.randomBytes(9).toString('base64url').substring(0, 12).toUpperCase();
    db.prepare('INSERT INTO invite_codes (code, created_at) VALUES (?, ?)').run(code, Date.now());
    return code;
}

function getInviteCodes() {
    return db.prepare('SELECT code, used_by, created_at FROM invite_codes ORDER BY created_at DESC').all();
}

function getAllUsers() {
    return db.prepare('SELECT id, username, created_at, last_active_at FROM users ORDER BY created_at DESC').all();
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

function deleteInviteCode(code) {
    db.prepare('DELETE FROM invite_codes WHERE code = ?').run(code);
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
    getUserById,
    generateInviteCode,
    getInviteCodes,
    getAllUsers,
    updateLastActive,
    deleteUser,
    deleteInviteCode,
    getLatestAnnouncement,
    setAnnouncement
};
