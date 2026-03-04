const fs = require('fs');
const path = require('path');
const { getMemory } = require('../../memory');
const { userDbCache } = require('../../db');

module.exports = function initAdminDashboard(app, context) {
    const { authMiddleware, authDb, wss, getWsClients } = context;

    const adminMiddleware = (req, res, next) => {
        if (!req.user || req.user.username !== 'Nana') {
            return res.status(403).json({ error: 'Forbidden. Admin level restricted.' });
        }
        next();
    };

    app.get('/api/admin/invites', authMiddleware, adminMiddleware, (req, res) => {
        try {
            const code = authDb.generateInviteCode();
            res.json({ success: true, code });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
        try {
            const users = authDb.getAllUsers();
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

    app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
        try {
            const targetId = req.params.id;
            if (targetId === req.user.id) return res.status(400).json({ error: "Cannot delete yourself" });

            // 1. Force disconnect websocket
            const clients = getWsClients(targetId);
            if (clients && clients.size > 0) {
                clients.forEach(c => c.close());
            }

            // 2. Shut down engine memory and close DB
            const db = userDbCache.get(targetId);
            if (db) {
                db.close();
                userDbCache.delete(targetId);
            }

            // Delete memory index
            try {
                const memory = getMemory(targetId);
                const chars = db ? db.getCharacters() : [];
                for (const c of chars) {
                    await memory.wipeIndex(c.id);
                }
            } catch (e) { }

            // 3. Delete db file
            const dbPath = path.join(__dirname, '..', '..', 'data', `chatpulse_user_${targetId}.db`);
            if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

            // 4. Delete from authDb
            authDb.deleteUser(targetId);

            res.json({ success: true });
        } catch (e) {
            console.error(e);
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
