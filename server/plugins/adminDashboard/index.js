const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { clearMemoryCache } = require('../../memory');
const { userDbCache, markUserDbDeleting, unmarkUserDbDeleting } = require('../../db');
const { closeSchedulerDb } = require('../scheduler/db');
const qdrant = require('../../qdrant');

const pendingUserDeletionJobs = new Map();

module.exports = function initAdminDashboard(app, context) {
    const { authMiddleware, authDb, wss, getWsClients } = context;

    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const removeFileIfExists = async (filePath, options = {}) => {
        const retries = Math.max(1, Number(options.retries || 6));
        const delayMs = Math.max(20, Number(options.delayMs || 120));
        for (let attempt = 0; attempt < retries; attempt += 1) {
            try {
                if (!fs.existsSync(filePath)) return;
                fs.unlinkSync(filePath);
                return;
            } catch (e) {
                const isBusy = e && ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(String(e.code || ''));
                if (!isBusy || attempt === retries - 1) {
                    throw e;
                }
                await wait(delayMs * (attempt + 1));
            }
        }
    };

    const disconnectUserSessions = (userId) => {
        const clients = getWsClients(userId);
        if (clients && clients.size > 0) {
            clients.forEach(c => c.close());
        }
    };

    const getDirectorySize = (dirPath) => {
        if (!dirPath || !fs.existsSync(dirPath)) return 0;
        let total = 0;
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
            const fullPath = path.join(dirPath, entry.name);
            try {
                if (entry.isDirectory()) {
                    total += getDirectorySize(fullPath);
                } else if (entry.isFile()) {
                    total += fs.statSync(fullPath).size;
                }
            } catch (e) { }
        }
        return total;
    };

    const removeDirectoryIfExists = async (dirPath, options = {}) => {
        const retries = Math.max(1, Number(options.retries || 6));
        const delayMs = Math.max(20, Number(options.delayMs || 120));
        for (let attempt = 0; attempt < retries; attempt += 1) {
            try {
                if (!fs.existsSync(dirPath)) return;
                fs.rmSync(dirPath, { recursive: true, force: true });
                return;
            } catch (e) {
                const isBusy = e && ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(String(e.code || ''));
                if (!isBusy || attempt === retries - 1) {
                    throw e;
                }
                await wait(delayMs * (attempt + 1));
            }
        }
    };

    const removeUserVectorArtifacts = async (userId) => {
        const vectorsRoot = path.join(__dirname, '..', '..', 'data', 'vectors');
        if (!fs.existsSync(vectorsRoot)) return;
        const entries = fs.readdirSync(vectorsRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const candidateDir = path.join(vectorsRoot, entry.name, String(userId));
            await removeDirectoryIfExists(candidateDir);
        }
    };

    const cleanupUserStorage = async (userId) => {
        closeSchedulerDb(userId);
        const db = userDbCache.get(userId);
        if (db) {
            try { db.checkpoint(); } catch (e) { }
            try { db.close(); } catch (e) { }
            userDbCache.delete(userId);
        }
        clearMemoryCache(userId);
        await wait(250);

        try {
            await qdrant.deleteUserCollection(userId);
        } catch (e) { }
        await removeUserVectorArtifacts(userId);
        clearMemoryCache(userId);

        const dbPath = path.join(__dirname, '..', '..', 'data', `chatpulse_user_${userId}.db`);
        await removeFileIfExists(dbPath);
        await removeFileIfExists(`${dbPath}-wal`);
        await removeFileIfExists(`${dbPath}-shm`);
    };

    const scheduleDeferredUserDeletion = (userId) => {
        const key = String(userId);
        if (pendingUserDeletionJobs.has(key)) return;
        const timer = setInterval(async () => {
            try {
                await cleanupUserStorage(key);
                clearInterval(timer);
                pendingUserDeletionJobs.delete(key);
                unmarkUserDbDeleting(key);
                console.log(`[Admin] Deferred user storage cleanup completed for ${key}.`);
            } catch (e) {
                const code = String(e?.code || '');
                if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code)) {
                    clearInterval(timer);
                    pendingUserDeletionJobs.delete(key);
                    unmarkUserDbDeleting(key);
                    console.error(`[Admin] Deferred user storage cleanup failed for ${key}:`, e);
                }
            }
        }, 5000);
        pendingUserDeletionJobs.set(key, timer);
    };

    const toUploadRelativePath = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return null;
        const marker = '/uploads/';
        const markerIdx = raw.indexOf(marker);
        if (markerIdx >= 0) {
            return raw.slice(markerIdx + 1).replaceAll('/', path.sep);
        }
        if (raw.startsWith('uploads/')) {
            return raw.replaceAll('/', path.sep);
        }
        return null;
    };

    const collectUploadReferences = (userDb, sql, mapper = (row) => Object.values(row || {})) => {
        const refs = new Set();
        try {
            const rows = userDb.prepare(sql).all();
            for (const row of rows) {
                for (const value of mapper(row)) {
                    const relPath = toUploadRelativePath(value);
                    if (relPath) refs.add(relPath);
                }
            }
        } catch (e) { }
        return refs;
    };

    const getUserStats = (user) => {
        const dbPath = path.join(__dirname, '..', '..', 'data', `chatpulse_user_${user.id}.db`);
        const vectorDir = path.join(__dirname, '..', '..', 'data', 'vectors', String(user.id));
        const uploadsRoot = path.join(__dirname, '..', '..', 'public');
        const stats = {
            db_size_bytes: 0,
            vector_size_bytes: 0,
            upload_size_bytes: 0,
            total_storage_bytes: 0,
            characters_count: 0,
            messages_count: 0,
            memories_count: 0,
            moments_count: 0,
            diaries_count: 0,
            token_total: 0,
            account_age_ms: Math.max(0, Date.now() - Number(user.created_at || Date.now()))
        };
        if (!fs.existsSync(dbPath)) {
            return stats;
        }
        try {
            stats.db_size_bytes = fs.statSync(dbPath).size;
        } catch (e) { }
        try {
            stats.vector_size_bytes = getDirectorySize(vectorDir);
        } catch (e) { }
        let userDb;
        try {
            userDb = new Database(dbPath, { readonly: true, fileMustExist: true });
            const count = (table) => userDb.prepare(`SELECT COUNT(*) as c FROM ${table}`).get()?.c || 0;
            stats.characters_count = count('characters');
            stats.messages_count = count('messages');
            stats.memories_count = count('memories');
            stats.moments_count = count('moments');
            stats.diaries_count = count('diaries');
            stats.token_total = userDb.prepare('SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) as total FROM token_usage').get()?.total || 0;

            const uploadRefs = new Set([
                ...collectUploadReferences(userDb, 'SELECT avatar, banner FROM user_profile'),
                ...collectUploadReferences(userDb, 'SELECT avatar FROM characters'),
                ...collectUploadReferences(userDb, 'SELECT avatar FROM group_chats'),
                ...collectUploadReferences(userDb, 'SELECT image_url FROM moments'),
            ]);
            for (const relPath of uploadRefs) {
                const fullPath = path.join(uploadsRoot, relPath);
                try {
                    if (fs.existsSync(fullPath)) {
                        stats.upload_size_bytes += fs.statSync(fullPath).size;
                    }
                } catch (e) { }
            }
        } catch (e) {
            stats.read_error = e.message;
        } finally {
            try { userDb?.close(); } catch (e) { }
        }
        stats.total_storage_bytes = stats.db_size_bytes + stats.vector_size_bytes + stats.upload_size_bytes;
        return stats;
    };

    const adminMiddleware = (req, res, next) => {
        if (!req.user || !authDb.isAdminRole(req.user.role)) {
            return res.status(403).json({ error: 'Forbidden. Admin level restricted.' });
        }
        next();
    };

    const getQdrantMode = () => {
        const config = qdrant.getQdrantConfig();
        if (!config.enabled) return 'disabled';
        const localBinaryPath = path.join(__dirname, '..', '..', '..', 'tools', 'qdrant', 'current', 'qdrant.exe');
        if (fs.existsSync(localBinaryPath)) return 'local';
        if (/127\.0\.0\.1|localhost/i.test(config.url)) return 'self-hosted';
        return 'external';
    };

    app.get('/api/admin/qdrant/status', authMiddleware, adminMiddleware, async (req, res) => {
        const config = qdrant.getQdrantConfig();
        const status = {
            enabled: !!config.enabled,
            reachable: false,
            url: config.url,
            mode: getQdrantMode(),
            collectionPrefix: process.env.QDRANT_COLLECTION_PREFIX || 'chatpulse_memories',
            backend: config.enabled ? 'qdrant-primary-with-vectra-fallback' : 'vectra-fallback-only',
            collectionsCount: 0,
            collections: [],
            indexedPoints: 0,
            lastError: ''
        };

        if (!config.enabled) {
            return res.json({ success: true, status });
        }

        try {
            const collections = await qdrant.listCollections();
            const ownCollections = collections
                .map(item => String(item?.name || ''))
                .filter(Boolean)
                .filter(name => name.startsWith(`${status.collectionPrefix}_`));

            let indexedPoints = 0;
            for (const collectionName of ownCollections.slice(0, 20)) {
                try {
                    const info = await qdrant.getCollectionInfo(collectionName);
                    indexedPoints += Number(
                        info?.points_count ??
                        info?.vectors_count ??
                        info?.indexed_vectors_count ??
                        0
                    );
                } catch (e) { }
            }

            status.reachable = true;
            status.collectionsCount = ownCollections.length;
            status.collections = ownCollections.slice(0, 8);
            status.indexedPoints = indexedPoints;
            return res.json({ success: true, status });
        } catch (e) {
            status.lastError = e.message;
            status.backend = 'vectra-fallback-active';
            return res.json({ success: true, status });
        }
    });

    app.get('/api/admin/invites', authMiddleware, adminMiddleware, (req, res) => {
        try {
            const code = authDb.generateInviteCode({
                maxUses: req.query.maxUses,
                expiresAt: req.query.expiresAt,
                note: req.query.note,
                createdBy: req.user.username
            });
            res.json({ success: true, code });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
        try {
            const users = authDb.getAllUsers().map(user => ({
                ...user,
                stats: getUserStats(user)
            }));
            res.json({ success: true, users });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/admin/invites/all', authMiddleware, adminMiddleware, (req, res) => {
        try {
            const codes = authDb.getInviteCodes();
            res.json({ success: true, codes });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/admin/invites/:code', authMiddleware, adminMiddleware, (req, res) => {
        try {
            authDb.deleteInviteCode(req.params.code);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/admin/invites/:code', authMiddleware, adminMiddleware, (req, res) => {
        try {
            authDb.updateInviteCode(req.params.code, {
                status: req.body?.status,
                note: req.body?.note,
                maxUses: req.body?.maxUses,
                expiresAt: req.body?.expiresAt
            });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
        try {
            const targetId = req.params.id;
            if (targetId === req.user.id) return res.status(400).json({ error: "Cannot delete yourself" });
            markUserDbDeleting(targetId);

            // 1. Force disconnect websocket
            disconnectUserSessions(targetId);
            authDb.deleteUser(targetId);

            try {
                await cleanupUserStorage(targetId);
                unmarkUserDbDeleting(targetId);
                res.json({ success: true, queuedCleanup: false });
            } catch (e) {
                const code = String(e?.code || '');
                if (['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code)) {
                    scheduleDeferredUserDeletion(targetId);
                    return res.json({ success: true, queuedCleanup: true });
                }
                throw e;
            }
        } catch (e) {
            try { unmarkUserDbDeleting(req.params.id); } catch (err) { }
            console.error(e);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/admin/users/:id/ban', authMiddleware, adminMiddleware, (req, res) => {
        try {
            const targetId = req.params.id;
            if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot ban yourself' });
            const banned = !!req.body?.banned;
            authDb.setUserStatus(targetId, banned ? 'banned' : 'active');
            authDb.bumpTokenVersion(targetId);
            disconnectUserSessions(targetId);
            res.json({ success: true, status: banned ? 'banned' : 'active' });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/admin/users/:id/role', authMiddleware, adminMiddleware, (req, res) => {
        try {
            if (req.user.role !== 'root') {
                return res.status(403).json({ error: 'Only root can change roles' });
            }
            const targetId = req.params.id;
            const nextRole = String(req.body?.role || '').trim();
            if (!['user', 'admin'].includes(nextRole)) {
                return res.status(400).json({ error: 'Invalid role' });
            }
            const allUsers = authDb.getAllUsers();
            const targetUser = allUsers.find(u => String(u.id) === String(targetId));
            if (!targetUser) return res.status(404).json({ error: 'User not found' });
            if (targetUser.role === 'root') {
                return res.status(400).json({ error: 'Cannot change root role' });
            }
            authDb.setUserRole(targetId, nextRole);
            authDb.bumpTokenVersion(targetId);
            disconnectUserSessions(targetId);
            res.json({ success: true, role: nextRole });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/admin/users/:id/reset-password', authMiddleware, adminMiddleware, (req, res) => {
        try {
            const targetId = req.params.id;
            const newPassword = String(req.body?.password || '');
            if (newPassword.length < 6) {
                return res.status(400).json({ error: 'Password must be at least 6 characters long' });
            }
            authDb.resetPassword(targetId, newPassword);
            disconnectUserSessions(targetId);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/admin/users/:id/force-logout', authMiddleware, adminMiddleware, (req, res) => {
        try {
            const targetId = req.params.id;
            authDb.bumpTokenVersion(targetId);
            disconnectUserSessions(targetId);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/admin/announcement', authMiddleware, adminMiddleware, (req, res) => {
        try {
            const { content } = req.body;
            authDb.setAnnouncement(content);

            // Broadcast over WS to all active users
            const messageStr = JSON.stringify({ type: 'announcement', content });
            wss.clients.forEach(client => {
                if (client.readyState === 1 && client.userId) {
                    client.send(messageStr);
                }
            });
            res.json({ success: true, announcement: { content } });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
};
