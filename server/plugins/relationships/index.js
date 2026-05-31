/**
 * Relationships DLC — Social Graph & Inter-Character Impressions
 * Extracted from server/index.js
 */
const { scheduleInitialImpressions, regenerateImpression } = require('./impressionService');

const MAX_IMPRESSION_HISTORY_LIMIT = 200;

function hasQueryValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}

function normalizeImpressionHistoryLimit(value, fallback = 50) {
    if (!hasQueryValue(value)) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_IMPRESSION_HISTORY_LIMIT) return null;
    return parsed;
}

module.exports = function initRelationships(app, context) {
    const { authMiddleware, getUserDb, callLLM } = context;

    // 13. Friendships
    app.get('/api/characters/:id/friends', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const sourceChar = db.getCharacter(req.params.id);
            if (!sourceChar) return res.status(404).json({ error: 'Character not found' });
            const friends = db.getFriends(sourceChar.id);
            res.json(friends);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/characters/:id/friends', authMiddleware, async (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const { target_id } = req.body;
            const targetId = String(target_id || '').trim();
            if (!targetId) return res.status(400).json({ error: 'target_id is required' });

            const sourceChar = db.getCharacter(req.params.id);
            const targetChar = db.getCharacter(targetId);
            if (!sourceChar || !targetChar) return res.status(404).json({ error: 'Character not found' });

            const added = db.addFriend(sourceChar.id, targetChar.id);
            if (added) {
                db.addMessage(sourceChar.id, 'user', `[CONTACT_CARD:${targetChar.id}:${targetChar.name}:${targetChar.avatar}]`);
                db.addMessage(targetChar.id, 'user', `[CONTACT_CARD:${sourceChar.id}:${sourceChar.name}:${sourceChar.avatar}]`);
                scheduleInitialImpressions({ db, callLLM, sourceChar, targetChar });
            }
            res.json({ success: true, added });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 13.5 Get character relationships (inter-char affinity)
    app.get('/api/characters/:id/relationships', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const sourceChar = db.getCharacter(req.params.id);
            if (!sourceChar) return res.status(404).json({ error: 'Character not found' });
            const relationships = db.getCharRelationships(sourceChar.id);
            // Enrich with character names and avatars — skip if target no longer exists
            const enriched = relationships
                .filter(r => db.getCharacter(r.targetId) !== undefined)
                .map(r => {
                    const targetChar = db.getCharacter(r.targetId);
                    return {
                        ...r,
                        targetName: targetChar?.name || 'Unknown',
                        targetAvatar: targetChar?.avatar || ''
                    };
                });
            res.json(enriched);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 13.5.5 Get character impression history
    app.get('/api/characters/:id/impressions/:targetId', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const limit = normalizeImpressionHistoryLimit(req.query.limit);
            if (!limit) return res.status(400).json({ error: 'Invalid impression history limit' });
            const sourceChar = db.getCharacter(req.params.id);
            const targetChar = db.getCharacter(req.params.targetId);
            if (!sourceChar || !targetChar) return res.status(404).json({ error: 'Character not found' });
            const history = db.getCharImpressionHistory(sourceChar.id, targetChar.id, limit);
            res.json(history);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 13.6 Regenerate impression for a specific relationship pair
    app.post('/api/characters/:id/relationships/regenerate', authMiddleware, async (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const { target_id } = req.body;
            if (!target_id) return res.status(400).json({ error: 'target_id required' });
            const fromChar = db.getCharacter(req.params.id);
            const toChar = db.getCharacter(target_id);
            if (!fromChar || !toChar) return res.status(404).json({ error: 'Character not found' });

            const out = await regenerateImpression({ callLLM, fromChar, toChar });
            if (!out) return res.status(500).json({ error: `Both attempts returned no valid JSON.Check your Gemini API config.` });

            db.initCharRelationship(fromChar.id, toChar.id, out.affinity, out.impression, 'recommend');
            res.json({ success: true, affinity: out.affinity, impression: out.impression });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    console.log('[Relationships DLC] Relationship matching routes registered.');
};
