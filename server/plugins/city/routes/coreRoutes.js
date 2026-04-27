function registerCoreCityRoutes(app, deps) {
    const {
        authMiddleware,
        ensureCityDb,
        deriveEmotion,
        normalizeDistrictPayload,
        normalizeItemPayload,
        getCityDate,
        runTimeSkipBackfill,
        triggerAdminGrantChat,
        getWsClients,
        getEngine
    } = deps;

    app.get('/api/city/logs', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const requestedLimit = Number.parseInt(req.query.limit, 10);
            const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 1000)) : 300;
            res.json({ success: true, logs: req.db.city.getCityLogs(limit) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/city/announcements', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const requestedLimit = Number.parseInt(req.query.limit, 10);
            const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 50;
            res.json({ success: true, announcements: req.db.city.getCityAnnouncements(limit) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/city/characters', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const chars = req.db.getCharacters().map(c => {
                const emotion = deriveEmotion(c);
                return {
                    id: c.id, name: c.name, avatar: c.avatar,
                    calories: c.calories ?? 2000, city_status: c.city_status ?? 'idle',
                    location: c.location ?? 'home', sys_survival: c.sys_survival ?? 1, sys_city_social: c.sys_city_social ?? 1,
                    is_scheduled: c.is_scheduled ?? 1,
                    city_action_frequency: c.city_action_frequency ?? 1,
                    wallet: c.wallet ?? 200,
                    energy: c.energy ?? 100, sleep_debt: c.sleep_debt ?? 0, mood: c.mood ?? 50,
                    stress: c.stress ?? 20, social_need: c.social_need ?? 50, health: c.health ?? 100,
                    satiety: c.satiety ?? 45, stomach_load: c.stomach_load ?? 0,
                    emotion_state: emotion.state, emotion_label: emotion.label, emotion_emoji: emotion.emoji, emotion_color: emotion.color,
                    api_endpoint: c.api_endpoint || '', model_name: c.model_name || '',
                    inventory: req.db.city.getInventory(c.id)
                };
            });
            res.json({ success: true, characters: chars });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/city/districts', authMiddleware, (req, res) => {
        try { ensureCityDb(req.db); res.json({ success: true, districts: req.db.city.getDistricts() }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/city/districts', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            if (!req.body.name) return res.status(400).json({ error: '缺少名称' });
            const payload = normalizeDistrictPayload(req.body);
            req.db.city.upsertDistrict(payload);
            res.json({ success: true, district: req.db.city.getDistrict(payload.id) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/city/districts/:id', authMiddleware, (req, res) => {
        try { ensureCityDb(req.db); req.db.city.deleteDistrict(req.params.id); res.json({ success: true }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.patch('/api/city/districts/:id/toggle', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const d = req.db.city.getDistrict(req.params.id);
            if (!d) return res.status(404).json({ error: '分区不存在' });
            req.db.city.upsertDistrict({ ...d, is_enabled: d.is_enabled ? 0 : 1 });
            res.json({ success: true, district: req.db.city.getDistrict(req.params.id) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/city/config', authMiddleware, (req, res) => {
        try { ensureCityDb(req.db); res.json({ success: true, config: req.db.city.getConfig() }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/city/config', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            if (!req.body.key) return res.status(400).json({ error: '缺少 key' });
            req.db.city.setConfig(req.body.key, req.body.value);
            res.json({ success: true, config: req.db.city.getConfig() });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/city/time-skip', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const { minutes } = req.body;
            if (!minutes || isNaN(minutes) || minutes <= 0) return res.status(400).json({ error: '无效的时间跳跃分钟数' });

            const config = req.db.city.getConfig();
            const oldCityDate = getCityDate(config);
            const oldDays = parseInt(config.city_time_offset_days) || 0;
            const oldHours = parseInt(config.city_time_offset_hours) || 0;

            let totalOffsetHoursDisplay = oldHours + (minutes / 60);
            let addedDays = Math.floor(totalOffsetHoursDisplay / 24);
            let remainingHours = totalOffsetHoursDisplay % 24;
            if (remainingHours < 0) {
                addedDays -= 1;
                remainingHours += 24;
            }

            req.db.city.setConfig('city_time_offset_days', oldDays + addedDays);
            req.db.city.setConfig('city_time_offset_hours', remainingHours);

            const newCityDate = getCityDate(req.db.city.getConfig());
            const processedTasks = await runTimeSkipBackfill(req.db, oldCityDate, newCityDate, req.user.id);
            res.json({ success: true, processedTasks });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/city/economy', authMiddleware, (req, res) => {
        try { ensureCityDb(req.db); res.json({ success: true, stats: req.db.city.getEconomyStats() }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/city/schedules/:charId', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const schedule = req.db.city.getTodaySchedule(req.params.charId);
            if (!schedule) return res.json({ success: true, schedule: [] });
            res.json({ success: true, schedule: JSON.parse(schedule.schedule_json) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/city/give-gold', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const { characterId, amount } = req.body;
            const char = req.db.getCharacter(characterId);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            const userName = String(req.db.getUserProfile?.()?.name || '用户').trim() || '用户';
            const giftAmount = Number(amount) || 0;
            const newWallet = (char.wallet || 0) + giftAmount;
            req.db.updateCharacter(characterId, { wallet: newWallet });
            req.db.city.logAction(characterId, 'GIFT', `${userName}给 ${char.name} 送了 ${giftAmount} 金币 🎁`, 0, giftAmount);

            const wsClients = getWsClients(req.user.id);
            const engine = getEngine(req.user.id);
            if (engine && typeof engine.broadcastWalletSync === 'function') {
                engine.broadcastWalletSync(wsClients, characterId);
            }
            await triggerAdminGrantChat(req.user.id, req.db.getCharacter(characterId) || char, 'gold', {
                amount: giftAmount
            });

            res.json({ success: true, wallet: newWallet });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/city/feed', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const { characterId, calories } = req.body;
            const char = req.db.getCharacter(characterId);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            const userName = String(req.db.getUserProfile?.()?.name || '用户').trim() || '用户';
            const addCals = Number(calories) || 1000;
            const newCals = Math.min(4000, (char.calories ?? 2000) + addCals);
            req.db.updateCharacter(characterId, { calories: newCals, city_status: newCals > 500 ? 'idle' : 'hungry' });
            req.db.city.logAction(characterId, 'FED', `${userName}给 ${char.name} 送了补给 (+${addCals}卡) 🍱`, addCals, 0);
            await triggerAdminGrantChat(req.user.id, req.db.getCharacter(characterId) || char, 'calories', {
                amount: addCals
            });
            res.json({ success: true, calories: newCals });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/city/items', authMiddleware, (req, res) => {
        try { ensureCityDb(req.db); res.json({ success: true, items: req.db.city.getItems() }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/city/items', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            if (!req.body.name) return res.status(400).json({ error: '缺少名称' });
            const payload = normalizeItemPayload(req.body);
            req.db.city.upsertItem(payload);
            res.json({ success: true, item: req.db.city.getItem(payload.id) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/city/items/:id', authMiddleware, (req, res) => {
        try { ensureCityDb(req.db); req.db.city.deleteItem(req.params.id); res.json({ success: true }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/city/inventory/:charId', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            res.json({ success: true, inventory: req.db.city.getInventory(req.params.charId) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/city/give-item', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const { characterId, itemId, quantity } = req.body;
            const char = req.db.getCharacter(characterId);
            const item = req.db.city.getItem(itemId);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            if (!item) return res.status(404).json({ error: '物品不存在' });
            const userName = String(req.db.getUserProfile?.()?.name || '用户').trim() || '用户';
            const safeQuantity = quantity || 1;
            req.db.city.addToInventory(characterId, itemId, safeQuantity);
            req.db.city.logAction(characterId, 'GIVE_ITEM', `${userName}给 ${char.name} 送了 ${item.emoji}${item.name} x${safeQuantity} 🎁`, 0, 0);
            await triggerAdminGrantChat(req.user.id, req.db.getCharacter(characterId) || char, 'item', {
                itemName: item.name,
                itemEmoji: item.emoji,
                quantity: safeQuantity
            });
            res.json({ success: true, inventory: req.db.city.getInventory(characterId) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/city/schedule/:charId', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const schedule = req.db.city.getTodaySchedule(req.params.charId);
            res.json({ success: true, schedule: schedule ? JSON.parse(schedule.schedule_json) : null });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/city/logs/clear', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            req.db.city.clearAllLogs();
            try {
                const getRawDb = req.db.getRawDb || (() => req.db._db);
                if (getRawDb && typeof getRawDb === 'function') {
                    const rdb = getRawDb();
                    rdb.prepare("DELETE FROM messages WHERE role = 'system' AND content LIKE '【市长播报】%'").run();
                }
            } catch (err) { console.error('[City] Failed to clear mayor messages:', err.message); }

            res.json({ success: true, message: '商业街活动记录与市长广播已清空' });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/city/data/wipe', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            req.db.city.wipeAllData();
            try {
                const getRawDb = req.db.getRawDb || (() => req.db._db);
                if (getRawDb && typeof getRawDb === 'function') {
                    const rdb = getRawDb();
                    rdb.prepare("DELETE FROM messages WHERE role = 'system' AND content LIKE '【市长播报】%'").run();
                }
            } catch (err) { console.error('[City] Failed to clear mayor messages on wipe:', err.message); }

            res.json({ success: true, message: '商业街所有数据已清空' });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
}

module.exports = { registerCoreCityRoutes };
