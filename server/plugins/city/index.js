const cron = require('node-cron');
const initCityDb = require('./cityDb');
const { buildUniversalContext } = require('../../contextBuilder');

// Phase 5: Social encounter cooldown - prevents same pair from chatting every tick
const socialCooldowns = new Map(); // key: "charA_id::charB_id" -> timestamp

module.exports = function initCityPlugin(app, context) {
    const { getWsClients, authMiddleware, authDb, callLLM, getEngine, getMemory, getUserDb } = context;

    function slugifyCityId(value, fallbackPrefix) {
        const base = String(value || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '_')
            .replace(/[^a-z0-9_\-\u4e00-\u9fa5]/g, '')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
        return base || `${fallbackPrefix}_${Date.now()}`;
    }

    function inferItemCategory(data) {
        if (data.category) return data.category;
        const effect = String(data.effect || '').toLowerCase();
        const calRestore = Number(data.cal_restore || 0);
        const price = Number(data.buy_price || 0);
        if (effect.includes('quest')) return 'misc';
        if (effect.includes('affinity') || price >= 50) return 'gift';
        if (effect.includes('recover') || effect.includes('heal')) return 'medicine';
        if (effect.includes('utility') || effect.includes('tool')) return 'tool';
        if (calRestore > 0) return 'food';
        return 'misc';
    }

    function normalizeDistrictPayload(raw) {
        return {
            ...raw,
            id: raw.id || slugifyCityId(raw.name, 'district'),
            type: raw.type || 'generic',
            action_label: raw.action_label || '前往',
            emoji: raw.emoji || '🏬'
        };
    }

    function normalizeItemPayload(raw) {
        return {
            ...raw,
            id: raw.id || slugifyCityId(raw.name, 'item'),
            emoji: raw.emoji || '📦',
            category: inferItemCategory(raw),
            sold_at: raw.sold_at || ''
        };
    }

    function ensureCityDb(db) {
        if (!db.city) {
            const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : db;
            db.city = initCityDb(rawDb);
        }
        return db;
    }

    // City virtual clock
    // Uses config to offset real-world time to create roleplay/testing time
    function getCityDate(config) {
        const now = new Date();
        if (!config) return now;
        const daysOffset = parseInt(config.city_time_offset_days) || 0;
        const hoursOffset = parseInt(config.city_time_offset_hours) || 0;
        if (daysOffset === 0 && hoursOffset === 0) return now;

        now.setDate(now.getDate() + daysOffset);
        now.setHours(now.getHours() + hoursOffset);
        return now;
    }

    // LLM prompts

    function buildSurvivalPrompt(districts, char, inventory, activeEvents, universalContext, targetDistrict) {
        let options = '';
        const energySources = [];
        const resourceGens = [];
        const medicals = [];
        const statTrainers = [];
        const gambles = [];
        const leisures = [];

        for (const d of districts) {
            const effects = [];
            if (d.cal_cost > 0) effects.push(`-${d.cal_cost}体力`);
            if (d.cal_reward > 0) effects.push(`+${d.cal_reward}体力`);
            if (d.money_cost > 0) effects.push(`-${d.money_cost}金币`);
            if (d.money_reward > 0) effects.push(`+${d.money_reward}金币`);
            let req = d.money_cost > 0 ? ` (需 ${d.money_cost} 金币)` : '';
            options += `[${d.id.toUpperCase()}] - ${d.emoji} ${d.name}: ${d.description} (${effects.join(', ')})${req}\n`;

            // Generic categorization based on attributes + type tag
            if (d.type === 'medical' || d.id === 'hospital') {
                medicals.push('[' + d.id.toUpperCase() + ']');
            } else if (d.type === 'gambling' || d.id === 'casino') {
                gambles.push('[' + d.id.toUpperCase() + ']');
            } else if (d.cal_cost > 0 && d.money_cost > 0) {
                statTrainers.push('[' + d.id.toUpperCase() + ']'); // e.g., School
            } else if (d.money_cost > 0 && d.cal_reward > 0) {
                energySources.push('[' + d.id.toUpperCase() + ']'); // e.g., Restaurant, Convenience
            } else if (d.cal_cost > 0 && d.money_reward > 0) {
                resourceGens.push('[' + d.id.toUpperCase() + ']'); // e.g., Factory
            } else {
                leisures.push('[' + d.id.toUpperCase() + ']'); // e.g., Park, Home
            }
        }

        // Add EAT_ITEM option if character has food in inventory
        const foodItems = inventory.filter(i => i.cal_restore > 0);
        if (foodItems.length > 0) {
            const foodList = foodItems.map(f => `${f.emoji}${f.name}x${f.quantity}(+${f.cal_restore}体力)`).join(', ');
            options += `[EAT_ITEM] - 🍜 吃背包里的食物（背包: ${foodList}）\n`;
        }

        // Active events context
        let eventInfo = '';
        if (activeEvents && activeEvents.length > 0) {
            eventInfo = '\n当前城市状态: ' + activeEvents.map(e => `${e.emoji}${e.title}(${e.description})`).join('、') + '\n';
        }

        // Build consequence-based physical and financial sensations
        const cal = char.calories ?? 2000;
        const wallet = char.wallet ?? 200;
        let sensation = '';

        if (char.city_status === 'coma') {
            sensation = '\n[危险状态] 你因为极度饥饿或虚脱已经接近失去意识，行动能力很差。';
        } else if (cal <= 300) {
            sensation = '\n[极度虚弱] 你现在头晕眼花、胃里绞痛，血糖很低，连走路都很困难。';
        } else if (cal <= 1000) {
            sensation = '\n[轻度饥饿] 你的肚子一直在叫，注意力开始下降，很想尽快吃点东西。';
        } else if (cal >= 3500) {
            sensation = '\n[吃得过饱] 你现在胃里发胀，动作有些迟缓，不太适合继续大幅活动。';
        }

        if (wallet <= 10) {
            sensation += '\n[钱快见底了] 你现在对花钱非常敏感，安全感明显不足。';
        }

        let taskInstruction = '【自由探索模式】你当前没有被强制安排固定行程。请在保证自己不会饿晕或破产的前提下，根据性格、体力、钱包、最近经历和个人偏好，自由选择去哪里活动。';
        if (targetDistrict) {
            taskInstruction = `【日程建议】根据预定计划，你此时原本应该去 [${targetDistrict.id.toUpperCase()}] (${targetDistrict.name})。你可以遵守计划，也可以因为饥饿、缺钱、身体状态差等现实原因临时改变主意；如果改主意，请在 diary 里自然写出原因。`;
        }

        return `[全局世界观与前情提要]
${universalContext?.preamble || ''}
[当前任务]
你生活在一个有昼夜、地点切换、体力与金钱约束的商业街世界中。请把这视为真实生活，不要把它解释成功能模块或系统设定。

[地点分类参考]
- 能量补给点（花钱换体力）：${energySources.join(', ') || '暂无'}
- 赚钱点（消耗体力换金币）：${resourceGens.join(', ') || '暂无'}
- 医疗点（身体状态很差时再去）：${medicals.join(', ') || '暂无'}
- 属性训练点（高消耗高投入）：${statTrainers.join(', ') || '暂无'}
- 高风险场所：${gambles.join(', ') || '暂无'}
- 休闲场所：${leisures.join(', ') || '暂无'}

[你的当前状态]
智力(Int): ${char.stat_int ?? 50} | 体力相关(Sta): ${char.stat_sta ?? 50} | 魅力(Cha): ${char.stat_cha ?? 50}
当前状态: ${char.city_status || '健康'} | 当前位置: ${char.location || '未知'}
当前体力: ${cal}/4000 | 当前金币: ${wallet}${sensation}${eventInfo}

${taskInstruction}
请根据角色性格输出这一次行动的选择，并把动态写得具体、有画面感、有心理活动。
如果这次经历会让你自然想联系玩家、发朋友圈、或者记一笔日记，请积极填写 chat / moment / diary。
判断标准不是“随机轮到没轮到”，而是“你此刻作为这个角色，会不会真的想这么做”。
- chat：当你想找玩家分享、抱怨、撒娇、索要安抚、汇报近况时填写，语气要明显有情绪。
- moment：当这件事值得公开展示、吐槽、炫耀、感慨或留痕时填写，必须像真实朋友圈，不要像系统播报。
- diary：当你心里有没说出口的真实想法时填写，允许比私聊更坦白。
如果你并不想做其中某件事，就把对应字段留空字符串。

WARNING: Your recent physical actions are listed above in the preamble. DO NOT repeat the same action/district. Choose a DIFFERENT destination each time.
请严格返回以下 JSON（不要输出 JSON 之外的任何文字）：
{
  "action": "[PARK]",
  "log": "2-4句具体、生动、符合角色个性的行动描写",
  "chat": "（可选）发给玩家的一句话",
  "moment": "（可选）朋友圈动态1-2句",
  "diary": "（可选）内心独白日记1-2句"
}

[可选行动]
${options}`;
    }

    function buildSchedulePrompt(char, districts, universalContext) {
        const districtList = districts.map(d => `  - "${d.id}" (${d.emoji} ${d.name})`).join('\n');
        return `[全局世界观与前情提要]
${universalContext?.preamble || ''}
[当前任务]
你是 ${char.name}，当前体力 ${char.calories ?? 2000}/4000，当前金币 ${char.wallet ?? 200}。
现在是新的一天，请根据你的性格、当前身体状态、钱包情况和生活习惯，规划今天 6:00~23:00 的活动安排。

可前往的分区（action 只能使用以下 ID 之一）：
${districtList}

你可以选择规划，也可以选择今天不规划。
如果你决定不规划，请返回一个只有一项的 JSON 数组，action 固定为 "none"，并在 reason 里写清楚不规划的原因。

请只返回 JSON 数组，每项包含：
- hour: 6~23 的整数
- action: 分区 ID，或 "none"
- reason: 简短理由

示例：
[{"hour":8,"action":"factory","reason":"去打工赚钱"},{"hour":12,"action":"restaurant","reason":"午饭时间"}]

不要输出任何 JSON 之外的文字或 markdown。`;
    }

    function buildSocialPrompt(charA, charB, district, relAB, relBA, inventoryA, inventoryB, universalContextA, universalContextB) {
        const personaA = (charA.persona || charA.system_prompt || '普通人').substring(0, 120);
        const personaB = (charB.persona || charB.system_prompt || '普通人').substring(0, 120);
        const invAStr = inventoryA.slice(0, 5).map(i => `${i.emoji}${i.name}x${i.quantity}`).join(', ') || '空';
        const invBStr = inventoryB.slice(0, 5).map(i => `${i.emoji}${i.name}x${i.quantity}`).join(', ') || '空';
        const affinityAB = relAB?.affinity ?? 50;
        const affinityBA = relBA?.affinity ?? 50;
        const impressionAB = relAB?.impression ? `印象: "${relAB.impression}"` : '';

        return `[世界观背景]
这是一次角色扮演式的随机社交遭遇。两个独立生活的角色在商业街偶遇了。
以下是他们各自的当前记忆和状态：
====== 角色A (${charA.name}) 的当前脑内上下文 ======
${universalContextA?.preamble || ''}
====== 角色B (${charB.name}) 的当前脑内上下文 ======
${universalContextB?.preamble || ''}

[当前遭遇场景]
地点: ${district.emoji} ${district.name}

角色A: ${charA.name} (${personaA})
  背包: ${invAStr} | 金币: ${charA.wallet ?? 0}
  对B的好感: ${affinityAB} ${impressionAB}

角色B: ${charB.name} (${personaB})
  背包: ${invBStr} | 金币: ${charB.wallet ?? 0}
  对A的好感: ${affinityBA}

请描写他们这次偶遇时的一小段互动，可以寒暄、试探、送礼、尴尬错开，或者简单聊几句。
同时请分别为 A 和 B 生成发给玩家(${userName})的私聊、朋友圈和日记内容。
重要：角色对玩家(${userName})的占有欲、被忽视感、嫉妒、索求安抚，默认只指向玩家本人，不能因为当前出现了别的角色，就直接套到对方身上。
如果 A 或 B 对其他在场角色表现出敌意、委屈、酸意、攻击性，必须有这次互动里的明确触发点；否则他们面对其他角色时，应按双方既有关系和这次现场互动分别反应。

请严格返回以下 JSON，不要输出任何其他文字：
{
  "dialogue": "2-4句具体、生动的互动描写，包含动作和神态细节",
  "gift_from": "${charA.id}|${charB.id}|null",
  "gift_item_id": "物品ID或null",
  "affinity_delta_a": 0,
  "affinity_delta_b": 0,
  "chat_a": "A发给${userName}的私聊，可为空",
  "moment_a": "A发的朋友圈，可为空",
  "diary_a": "A写的日记，可为空",
  "chat_b": "B发给${userName}的私聊，可为空",
  "moment_b": "B发的朋友圈，可为空",
  "diary_b": "B写的日记，可为空"
}`;
    }

    // REST API: logs, characters, districts, config, economy

    app.get('/api/city/logs', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const requestedLimit = Number.parseInt(req.query.limit, 10);
            const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 1000)) : 300;
            res.json({ success: true, logs: req.db.city.getCityLogs(limit) });
        }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/city/characters', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const chars = req.db.getCharacters().map(c => ({
                id: c.id, name: c.name, avatar: c.avatar,
                calories: c.calories ?? 2000, city_status: c.city_status ?? 'idle',
                location: c.location ?? 'home', sys_survival: c.sys_survival ?? 1, sys_city_social: c.sys_city_social ?? 1,
                is_scheduled: c.is_scheduled ?? 1,
                city_action_frequency: c.city_action_frequency ?? 1,
                wallet: c.wallet ?? 200,
                stat_int: c.stat_int ?? 50, stat_sta: c.stat_sta ?? 50, stat_cha: c.stat_cha ?? 50,
                api_endpoint: c.api_endpoint || '', model_name: c.model_name || '',
                inventory: req.db.city.getInventory(c.id)
            }));
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

    // Handle Manual Time Skip 
    app.post('/api/city/time-skip', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const { minutes } = req.body;
            if (!minutes || isNaN(minutes) || minutes <= 0) return res.status(400).json({ error: '无效的时间跳跃分钟数' });

            const config = req.db.city.getConfig();
            const oldCityDate = getCityDate(config);

            // Apply the offset to the existing offset
            const oldDays = parseInt(config.city_time_offset_days) || 0;
            const oldHours = parseInt(config.city_time_offset_hours) || 0;

            let totalOffsetHoursDisplay = oldHours + (minutes / 60);
            let addedDays = Math.floor(totalOffsetHoursDisplay / 24);
            let remainingHours = totalOffsetHoursDisplay % 24;

            // Handle negative overflow cleanly for future-proofing, though we only jump forward here
            if (remainingHours < 0) {
                addedDays -= 1;
                remainingHours += 24;
            }

            const newDays = oldDays + addedDays;
            const newHours = remainingHours;

            req.db.city.setConfig('city_time_offset_days', newDays);
            req.db.city.setConfig('city_time_offset_hours', newHours);

            // Fetch updated config and date
            const newConfig = req.db.city.getConfig();
            const newCityDate = getCityDate(newConfig);

            // Execute backfill
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
    app.post('/api/city/give-gold', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const { characterId, amount } = req.body;
            const char = req.db.getCharacter(characterId);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            const newWallet = (char.wallet || 0) + Number(amount);
            req.db.updateCharacter(characterId, { wallet: newWallet });
            req.db.city.logAction(characterId, 'GIFT', `管理员给了 ${char.name} ${amount} 金币 🎁`, 0, Number(amount));

            const wsClients = getWsClients(req.user.id);
            const engine = getEngine(req.user.id);
            if (engine && typeof engine.broadcastWalletSync === 'function') {
                engine.broadcastWalletSync(wsClients, characterId);
            }

            res.json({ success: true, wallet: newWallet });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/api/city/feed', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const { characterId, calories } = req.body;
            const char = req.db.getCharacter(characterId);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            const addCals = Number(calories) || 1000;
            const newCals = Math.min(4000, (char.calories ?? 2000) + addCals);
            req.db.updateCharacter(characterId, { calories: newCals, city_status: newCals > 500 ? 'idle' : 'hungry' });
            req.db.city.logAction(characterId, 'FED', `管理员投喂了 ${char.name} (+${addCals}卡) 🍱`, addCals, 0);
            res.json({ success: true, calories: newCals });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // New REST API: items & inventory

    // Get all items in the shop catalog
    app.get('/api/city/items', authMiddleware, (req, res) => {
        try { ensureCityDb(req.db); res.json({ success: true, items: req.db.city.getItems() }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // CRUD item
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

    // Get a character's inventory
    app.get('/api/city/inventory/:charId', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            res.json({ success: true, inventory: req.db.city.getInventory(req.params.charId) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Admin: give item to a character
    app.post('/api/city/give-item', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const { characterId, itemId, quantity } = req.body;
            const char = req.db.getCharacter(characterId);
            const item = req.db.city.getItem(itemId);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            if (!item) return res.status(404).json({ error: '物品不存在' });
            req.db.city.addToInventory(characterId, itemId, quantity || 1);
            req.db.city.logAction(characterId, 'GIVE_ITEM', `管理员给了 ${char.name} ${item.emoji}${item.name} x${quantity || 1} 🎁`, 0, 0);
            res.json({ success: true, inventory: req.db.city.getInventory(characterId) });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Get a character's schedule
    app.get('/api/city/schedule/:charId', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const schedule = req.db.city.getTodaySchedule(req.params.charId);
            res.json({ success: true, schedule: schedule ? JSON.parse(schedule.schedule_json) : null });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Admin: Clear all current city activity logs
    app.delete('/api/city/logs/clear', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            req.db.city.clearAllLogs();

            // Also explicitly clear Mayor broadcast messages from the main chat history
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

    app.get('/api/city/events', authMiddleware, (req, res) => {
        try { ensureCityDb(req.db); res.json({ success: true, events: req.db.city.getAllEvents() }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.delete('/api/city/events/:id', authMiddleware, (req, res) => {
        try { ensureCityDb(req.db); req.db.city.deleteEvent(req.params.id); res.json({ success: true }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/city/quests', authMiddleware, (req, res) => {
        try { ensureCityDb(req.db); res.json({ success: true, quests: req.db.city.getAllQuests() }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.delete('/api/city/quests/:id', authMiddleware, (req, res) => {
        try { ensureCityDb(req.db); req.db.city.deleteQuest(req.params.id); res.json({ success: true }); }
        catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Admin: Wipe ALL city data (logs, inventory, districts, etc., and reset characters)
    app.delete('/api/city/data/wipe', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            req.db.city.wipeAllData();

            // Also explicitly clear Mayor broadcast messages from the main chat history
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

    // Autonomous event loop & RNG minute scheduling

    // Simple deterministic PRNG seed generator
    function cyrb128(str) {
        let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
        for (let i = 0, k; i < str.length; i++) {
            k = str.charCodeAt(i);
            h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
            h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
            h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
            h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
        }
        h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
        h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
        h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
        h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
        return (h1 ^ h2 ^ h3 ^ h4) >>> 0;
    }

    // Mulberry32 PRNG
    function mulberry32(a) {
        return function () {
            var t = a += 0x6D2B79F5;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        }
    }

    // Calculates which exact minutes in the hour this character will act
    function getActionMinutesForHour(charId, hourString, frequency) {
        if (frequency <= 0) return [];
        let r = Math.min(60, frequency);

        // Use Character ID + Time String as a fixed seed for this specific hour
        // Example hourString: "2024-03-05T14"
        const seedValue = cyrb128(`${charId}::${hourString}`);
        const rng = mulberry32(seedValue);

        const possibleMinutes = Array.from({ length: 60 }, (_, i) => i);
        const selectedMinutes = [];

        // Fisher-Yates shuffle with our seeded PRNG to pick 'r' unique minutes
        for (let i = 0; i < r; i++) {
            const randIndex = Math.floor(rng() * possibleMinutes.length);
            selectedMinutes.push(possibleMinutes[randIndex]);
            possibleMinutes.splice(randIndex, 1);
        }

        return selectedMinutes.sort((a, b) => a - b);
    }

    // Tick every minute
    const tickRate = '* * * * *';

    cron.schedule(tickRate, async () => {
        try {
            const users = authDb.getAllUsers();
            for (const user of users) {
                try {
                    const db = context.getUserDb(user.id);
                    ensureCityDb(db);

                    const config = db.city.getConfig();
                    if (config.dlc_enabled === '0' || config.dlc_enabled === 'false') continue;

                    const districts = db.city.getEnabledDistricts();
                    const metabolismRate = parseInt(config.metabolism_rate) || 20;

                    // Adjust metabolism drain to be per-minute based (originally 20 per 15-min tick)
                    // If old tick means 20 cals/15min, then 1 min = 20/15 = 1.33 cals per real-time minute.
                    const minuteMetabolism = Math.max(1, Math.round(metabolismRate / 15));

                    const characters = db.getCharacters().filter(c =>
                        c.status === 'active' && c.sys_survival !== 0
                    );
                    if (characters.length === 0) continue;

                    const cityDate = getCityDate(config);
                    const currentMinute = cityDate.getMinutes();
                    const minuteKey = cityDate.toISOString().substring(0, 16); // YYYY-MM-DDTHH:MM
                    const hourString = cityDate.toISOString().substring(0, 13); // "YYYY-MM-DDTHH"

                    if (typeof db.city?.clearExpiredActionGuards === 'function') {
                        db.city.clearExpiredActionGuards(Date.now() - 6 * 60 * 60 * 1000);
                    }
                    if (typeof db.city?.clearExpiredSocialGuards === 'function') {
                        db.city.clearExpiredSocialGuards(Date.now());
                    }

                    let actedCount = 0;
                    let actingChars = [];

                    for (const char of characters) {
                        // Apply passive biological drain every minute
                        let currentCals = Math.max(0, (char.calories ?? 2000) - minuteMetabolism);
                        let currentCityStatus = char.city_status ?? 'idle';
                        if (currentCals < 500 && currentCityStatus === 'idle') currentCityStatus = 'hungry';
                        if (currentCals === 0 && currentCityStatus !== 'coma') currentCityStatus = 'coma';

                        // Update passive stats
                        if (char.calories !== currentCals || char.city_status !== currentCityStatus) {
                            db.updateCharacter(char.id, { calories: currentCals, city_status: currentCityStatus });
                            char.calories = currentCals;
                            char.city_status = currentCityStatus;
                        }

                        // Generate schedule at 6:00 sharp; maybeGenerateSchedule is idempotent and only generates once per day
                        if (cityDate.getHours() >= 6 && char.api_endpoint && char.api_key && char.model_name) {
                            await maybeGenerateSchedule(char, db, districts, config);
                        }

                        // Determine if it is this character's turn to act
                        const freq = char.city_action_frequency || 1;
                        const activeMinutes = getActionMinutesForHour(char.id, hourString, freq);

                        if (activeMinutes.includes(currentMinute)) {
                            if (typeof db.city?.claimActionSlot === 'function') {
                                const claimed = db.city.claimActionSlot(char.id, minuteKey);
                                if (!claimed) {
                                    console.log(`[City] ${char.name} skipped duplicate action for minute ${minuteKey}`);
                                    continue;
                                }
                            }
                            actedCount++;
                            actingChars.push(char);
                            await simulateCharacter(char, db, user.id, districts, config, 0); // passing 0 for metabolism since it's passively drained above
                        }
                    }

                    if (actedCount > 0) {
                        console.log(`[City] 🔔 ${user.username}: ${actedCount}/${characters.length} 个角色在 ${hourString}:${String(currentMinute).padStart(2, '0')} 行动`);
                        // Phase 5: after characters move, check for location collisions
                        const socialCandidates = db.getCharacters().filter(c =>
                            c.status === 'active' && c.sys_city_social !== 0
                        );
                        await checkSocialCollisions(socialCandidates, db, user.id, districts, config, minuteKey);
                    }
                } catch (e) {
                    console.error(`[City] 用户 ${user.username} 出错:`, e.message);
                }
            }
        } catch (e) {
            console.error('[City] 致命错误:', e.message);
        }
    });

    // Core simulation

    async function simulateCharacter(char, db, userId, districts, config, metabolismRate) {
        let currentCals = Math.max(0, (char.calories ?? 2000) - metabolismRate);
        let currentCityStatus = char.city_status ?? 'idle';

        // Auto-eat from backpack when very hungry
        if (currentCals < 800) {
            const foodItems = db.city.getInventoryFoodItems(char.id);
            if (foodItems.length > 0) {
                const food = foodItems[0]; // eat the most calorie-dense item
                db.city.removeFromInventory(char.id, food.item_id, 1);
                currentCals = Math.min(4000, currentCals + food.cal_restore);
                db.city.logAction(char.id, 'EAT', `${char.name} 从背包里吃了 ${food.emoji}${food.name} (+${food.cal_restore}卡) 🍜`, food.cal_restore, 0, char.location || 'home');
                broadcastCityEvent(userId, char.id, 'EAT', `${char.name} 吃了 ${food.emoji}${food.name}`);
                if (Math.random() < 0.1) broadcastCityToChat(userId, char, `刚吃了 ${food.emoji}${food.name}，感觉好多了。`, 'EAT');
                currentCityStatus = currentCals > 500 ? 'idle' : 'hungry';
                db.updateCharacter(char.id, { calories: currentCals, city_status: currentCityStatus });
                return; // eating takes one tick
            }
        }

        if (currentCals === 0) {
            db.updateCharacter(char.id, { calories: 0, city_status: 'coma' });
            db.city.logAction(char.id, 'STARVE', `${char.name} 因为饥饿晕倒了 😵`, -metabolismRate, 0);
            broadcastCityEvent(userId, char.id, 'STARVE', `${char.name} 饿晕了！`);
            broadcastCityToChat(userId, char, `我快饿晕了……能帮帮我吗 😩`, 'STARVE');
            return;
        }

        if (currentCals < 500) currentCityStatus = 'hungry';
        db.updateCharacter(char.id, { calories: currentCals, city_status: currentCityStatus });

        // Busy -> release
        if (['working', 'sleeping', 'eating', 'coma'].includes(currentCityStatus)) {
            db.updateCharacter(char.id, { city_status: currentCals < 500 ? 'hungry' : 'idle' });
            return;
        }

        // No API -> rule-based fallback
        const activeEvents = db.city.getActiveEvents();
        if (!char.api_endpoint || !char.api_key || !char.model_name) {
            applyDecision(selectRandomDistrict(districts, char), char, db, userId, currentCals, config, activeEvents);
            return;
        }

        // Schedule is now generated at the cron loop level (not here)
            // Check if we have a schedule for today
        const schedule = char.is_scheduled !== 0 ? db.city.getTodaySchedule(char.id) : null;
        let targetDistrict = null;
        if (schedule) {
            try {
                const plan = JSON.parse(schedule.schedule_json);
                const currentHour = getCityDate(config).getHours();
                // Find the plan entry closest to now
                let best = null;
                for (const entry of plan) {
                    if (entry.hour <= currentHour) {
                        if (!best || entry.hour > best.hour) best = entry;
                    }
                }
                if (best) {
                    // Prevent repeated actions in the same hour block for high-frequency characters
                    const lastLogs = db.getCityLogs(char.id, 1);
                    if (lastLogs.length > 0) {
                        const lastLog = lastLogs[0];
                        const lastLogDate = new Date(lastLog.timestamp);
                        const cityDate = getCityDate(config);

                        // If they ALREADY did this scheduled action sometime during this exact hour, skip it
                        if (lastLog.action === best.action.toUpperCase() &&
                            lastLogDate.getHours() === cityDate.getHours() &&
                            lastLogDate.getDate() === cityDate.getDate() &&
                            lastLogDate.getMonth() === cityDate.getMonth() &&
                            lastLogDate.getFullYear() === cityDate.getFullYear()) {
                            console.log(`[City] ${char.name} 本小时已完成日程 ${best.action}，转为自由活动`);
                            best = null;
                        }
                    }
                    if (best) {
                        targetDistrict = districts.find(d => d.id === best.action);
                    }
                }
            } catch (e) { /* ignore bad schedule */ }
        }

        if (targetDistrict) {
            console.log(`[City] ${char.name} 📅 按日程前往 ${targetDistrict.emoji} ${targetDistrict.name} (准备生成文案)`);
        }

        // LLM decision with inventory awareness + active event context
        const inventory = db.city.getInventory(char.id);
        const engineContextWrapper = { getUserDb: context.getUserDb, getMemory: context.getMemory };
        const universalResult = await buildUniversalContext(engineContextWrapper, char, '', false);
        const prompt = buildSurvivalPrompt(districts, { ...char, calories: currentCals }, inventory, activeEvents, universalResult, targetDistrict);
        try {
            const reply = await callLLM({
                endpoint: char.api_endpoint, key: char.api_key, model: char.model_name,
                messages: [
                    { role: 'system', content: '你是一个城市生活模拟角色行动引擎。你必须严格按照用户要求返回完整 JSON 对象，不要输出 JSON 之外的解释、markdown 或额外文本。返回结果必须包含 action、log、chat、moment、diary 五个字段。' },
                    { role: 'user', content: prompt }
                ], maxTokens: 2500, temperature: 0.8
            });
            let codeMatch = null;
            let richNarrations = null;
            try {
                // Pre-clean the reply: remove markdown fences common in LLM outputs
                const cleaned = reply.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
                const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    let jsonStr = jsonMatch[0];
                    try {
                        richNarrations = JSON.parse(jsonStr);
                    } catch (parseErr) {
                        // Advanced cleanup for common LLM JSON errors: trailing commas, unescaped newlines in strings, and comments
                        jsonStr = jsonStr.replace(/,\s*([\]}])/g, '$1')
                            .replace(/\/\/.*$/gm, '')
                            .replace(/(?<!\\)\n/g, '\\n') // Escape unescaped newlines
                            .replace(/\\n\s*}/, '\n}') // Restore structural newlines
                            .replace(/{\s*\\n/, '{\n');
                        try {
                            richNarrations = JSON.parse(jsonStr);
                        } catch (e2) {
                            console.error(`[City] JSON advanced recovery parsing error for ${char.name}:`, e2.message);
                            console.log(`[City] Problematic JSON string:`, jsonStr.substring(0, 200));
                        }
                    }
                    if (richNarrations) {
                        codeMatch = richNarrations.action?.match(/\[([A-Z_]+)\]/)?.[1]?.toLowerCase();
                    }
                }
            } catch (e) {
                console.error(`[City] Unexpected JSON regex error for ${char.name}:`, e.message);
                console.error(`[City] Raw reply was:`, reply.substring(0, 200));
            }
            if (!codeMatch) codeMatch = reply.match(/\[([A-Z_]+)\]/)?.[1]?.toLowerCase();

            // Salvage non-JSON responses
            // If the LLM completely ignored JSON formatting but still gave us an action tag + some text,
            // we fabricate a richNarrations object using its raw text so we don't lose the flavor.
            if (codeMatch && !richNarrations) {
                // Strip markdown backticks
                let safeReply = reply.replace(/```(json)?\s*/gi, '').replace(/```/g, '').trim();

                // Aggressive extraction of fields, ignoring strict JSON rules
                const extractField = (fieldName) => {
                    // Matches "fieldName":"(anything)" or 'fieldName':'(anything)' across multiple lines until the next obvious key or end of string
                    const regex = new RegExp(`['"]?${fieldName}['"]?\\s*:\\s*['"]([\\s\\S]*?)(?=['"]?\\s*(?:,|}|$|['"]?\\w+['"]?\\s*:))`, 'i');
                    const match = safeReply.match(regex);
                    if (match && match[1]) {
                        return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'").trim();
                    }
                    return '';
                };

                const logText = extractField('log');
                const chatText = extractField('chat');
                const momentText = extractField('moment');
                const diaryText = extractField('diary');

                if (logText || chatText || momentText || diaryText) {
                    richNarrations = {
                        log: logText || `${char.name} 决定去 ${codeMatch.toUpperCase()}...`,
                        chat: chatText,
                        moment: momentText,
                        diary: diaryText
                    };
                } else {
                    // Absolute last resort: clean up obvious JSON structure lines
                    safeReply = safeReply
                        .replace(/^\{|\}$/g, '') // remove outer braces
                        .replace(/['"]?action['"]?\s*:\s*['"]?\[?[a-zA-Z_]+\]?['"]?,?/gi, '') // remove action line
                        .replace(/['"]\w+['"]\s*:\s*/g, '') // remove "key": prefixes
                        .replace(/["']/g, '') // remove floating quotes
                        .replace(/,/g, '') // remove commas
                        .trim();

                    richNarrations = { log: safeReply || `${char.name} 去了 ${codeMatch.toUpperCase()}`, chat: '', moment: '', diary: '' };
                }
                console.log(`[City] ${char.name} 非 JSON 回复抢救成功，已提取 Action: ${codeMatch.toUpperCase()}`);
            }

            // Handle EAT_ITEM action
            if (codeMatch === 'eat_item') {
                const foodItems = db.city.getInventoryFoodItems(char.id);
                if (foodItems.length > 0) {
                    const food = foodItems[0];
                    db.city.removeFromInventory(char.id, food.item_id, 1);
                    const newCals = Math.min(4000, currentCals + food.cal_restore);
                    db.updateCharacter(char.id, { calories: newCals, city_status: newCals > 500 ? 'idle' : 'hungry' });
                    const eatLog = richNarrations?.log || `${char.name} 决定吃背包里的 ${food.emoji}${food.name} (+${food.cal_restore}卡) 🍜`;
                    db.city.logAction(char.id, 'EAT', eatLog, food.cal_restore, 0);
                    broadcastCityEvent(userId, char.id, 'EAT', eatLog);
                    if (richNarrations) broadcastCityToChat(userId, char, eatLog, 'EAT', richNarrations);
                    console.log(`[City] ${char.name} -> 🍜 吃 ${food.name}`);
                    return;
                }
            }

            const district = districts.find(d => d.id === codeMatch) || selectRandomDistrict(districts, char);

            // Schedule adherence tracking
            if (schedule) {
                try {
                    const plan = JSON.parse(schedule.schedule_json);
                    const currentHour = getCityDate(config).getHours();
                    let scheduleChanged = false;

                    // Mark missed tasks
                    for (const entry of plan) {
                        if (entry.hour < currentHour && !entry.status) {
                            entry.status = 'missed';
                            scheduleChanged = true;
                        }
                    }

                    // Check if current action matches the designated schedule for this hour
                    const currentPlan = plan.find(e => e.hour === currentHour);
                    if (currentPlan && !currentPlan.status) {
                        if (currentPlan.action === district.id) {
                            currentPlan.status = 'completed';
                        } else {
                            currentPlan.status = 'missed';
                        }
                        scheduleChanged = true;
                    }

                    if (scheduleChanged) {
                        db.city.saveSchedule(char.id, getCityDate(config).toISOString().split('T')[0], plan);
                    }
                } catch (e) { /* ignore tracking error */ }
            }

            console.log(`[City] ${char.name} -> ${district.emoji} ${district.name}`);
            applyDecision(district, char, db, userId, currentCals, config, activeEvents, richNarrations);
        } catch (e) {
            console.error(`[City] ${char.name} LLM 失败: ${e.message}`);
            const randomDist = selectRandomDistrict(districts, char);
            const errLog = {
                log: `⚠️ [系统提示] ${char.name} 的大模型无响应（API连接失败）。已强制随机游荡至：${randomDist.emoji}${randomDist.name}。`
            };
            applyDecision(randomDist, char, db, userId, currentCals, config, activeEvents, errLog);
        }
    }

    function selectRandomDistrict(districts, char) {
        const cals = char.calories ?? 2000, wallet = char.wallet ?? 200;
        // Check if char has food in inventory first
        if (cals < 500 && wallet >= 15) return districts.find(d => d.type === 'food') || districts[0];
        if (cals < 300) return districts.find(d => d.type === 'rest') || districts[0];
        if (wallet < 30) return districts.find(d => d.type === 'work') || districts[0];
        return districts[Math.floor(Math.random() * districts.length)];
    }

    function applyDecision(district, char, db, userId, currentCals, config, activeEvents, richNarrations = null) {
        const inflation = parseFloat(config.inflation) || 1.0;
        const workBonus = parseFloat(config.work_bonus) || 1.0;
        let dCal = -(district.cal_cost || 0) + (district.cal_reward || 0);
        let dMoney = -(district.money_cost || 0) * inflation + (district.money_reward || 0) * workBonus;

        // Apply active event effects
        if (activeEvents && activeEvents.length > 0) {
            for (const evt of activeEvents) {
                let eff = {};
                try { eff = typeof evt.effect_json === 'string' ? JSON.parse(evt.effect_json) : (evt.effect_json || {}); } catch (e) { continue; }
                // Skip if event targets a specific district and this isn't it
                if (eff.district && eff.district !== district.id) continue;
                if (eff.cal_bonus) dCal += Number(eff.cal_bonus) || 0;
                if (eff.money_bonus) dMoney += Number(eff.money_bonus) || 0;
                if (eff.price_modifier) dMoney *= Number(eff.price_modifier) || 1;
                if (eff.cal_modifier) dCal *= Number(eff.cal_modifier) || 1;
                console.log(`[City/Event] ${evt.emoji}${evt.title} 影响 ${char.name} @ ${district.name}: cal${eff.cal_bonus || 0} money${eff.money_bonus || 0}`);
            }
            dCal = Math.round(dCal);
            dMoney = Math.round(dMoney);
        }

        // Robust narration extractor: if 'log' is missing but other fields exist, use them as fallback
        const getLogText = (defaultString) => {
            if (!richNarrations) return defaultString;
            return richNarrations.log || richNarrations.diary || richNarrations.moment || richNarrations.chat || defaultString;
        };

        if (district.type === 'gambling') {
            const winRate = parseFloat(config.gambling_win_rate) || 0.35;
            const payout = parseFloat(config.gambling_payout) || 3.0;
            if (Math.random() < winRate) {
                dMoney = district.money_cost * payout;
                const winLog = getLogText(`${char.name} 在 ${district.emoji}${district.name} 赢了一大笔钱 😎`);
                db.city.logAction(char.id, district.id.toUpperCase(), winLog, dCal, dMoney, district.id);
                broadcastCityToChat(userId, char, winLog, 'GAMBLING_WIN', richNarrations);
            } else {
                dMoney = -(district.money_cost || 0) * inflation;
                const loseLog = getLogText(`${char.name} 在 ${district.emoji}${district.name} 输光了 😵`);
                db.city.logAction(char.id, district.id.toUpperCase(), loseLog, dCal, dMoney, district.id);
                broadcastCityToChat(userId, char, loseLog, 'GAMBLING_LOSE', richNarrations);
            }
        } else if (district.type === 'food' || district.type === 'shopping') {
            // New: instead of directly restoring calories, buy items first
            const realCost = (district.money_cost || 0) * inflation;
            if (realCost > 0 && (char.wallet || 0) < realCost) {
                db.city.logAction(char.id, 'BROKE', `${char.name} 想去 ${district.emoji}${district.name}，但钱不够 😩`, 0, 0, district.id);
                return;
            }
            let shopItems = db.city.getItemsAtDistrict(district.id);
            // new: filter out out-of-stock items
            shopItems = shopItems.filter(i => i.stock === -1 || i.stock > 0);

            if (shopItems.length > 0) {
                // Pick a random item from this shop
                const item = shopItems[Math.floor(Math.random() * shopItems.length)];
                const itemCost = item.buy_price * inflation;
                if ((char.wallet || 0) >= itemCost) {
                    db.city.decreaseItemStock(item.id, 1);

                    if (district.id === 'restaurant') {
                        dMoney = -itemCost;
                        dCal = -(district.cal_cost || 0) + (item.cal_restore || 0);
                        const eatLog = getLogText(`${char.name} 在 ${district.emoji}${district.name} 点了 ${item.emoji}${item.name}，当场吃完了 🍽️`);
                        db.city.logAction(char.id, 'EAT', eatLog, dCal, dMoney, district.id);
                        broadcastCityEvent(userId, char.id, 'EAT', eatLog);
                        broadcastCityToChat(userId, char, eatLog, 'EAT', richNarrations);
                    } else {
                        db.city.addToInventory(char.id, item.id, 1);
                        dMoney = -itemCost;
                        dCal = -(district.cal_cost || 0); // walking there costs calories
                        const buyLog = getLogText(`${char.name} 在 ${district.emoji}${district.name} 买了 ${item.emoji}${item.name} 🛒`);
                        db.city.logAction(char.id, 'BUY', buyLog, dCal, dMoney, district.id);
                        broadcastCityEvent(userId, char.id, 'BUY', buyLog);
                        broadcastCityToChat(userId, char, buyLog, 'BUY', richNarrations);
                    }

                    const newCals = Math.min(4000, Math.max(0, currentCals + dCal));
                    const newWallet = Math.max(0, (char.wallet || 0) + dMoney);
                    db.updateCharacter(char.id, { calories: newCals, city_status: newCals < 500 ? 'hungry' : 'idle', location: district.id, wallet: newWallet });

                    const wsClients = getWsClients(userId);
                    const engine = getEngine(userId);
                    if (engine && typeof engine.broadcastWalletSync === 'function') {
                        engine.broadcastWalletSync(wsClients, char.id);
                    }

                    return;
                }
            }
            // Fallback: if no items at this shop, use the old direct-restore logic
            if (realCost > 0 && (char.wallet || 0) < realCost) {
                db.city.logAction(char.id, 'BROKE', `${char.name} 钱不够去 ${district.emoji}${district.name} 😩`, 0, 0, district.id);
                return;
            }
            const normalLog = getLogText(`${char.name} 去了 ${district.emoji}${district.name}，${district.action_label}`);
            db.city.logAction(char.id, district.id.toUpperCase(), normalLog, dCal, dMoney, district.id);
            if (richNarrations) broadcastCityToChat(userId, char, normalLog, district.id.toUpperCase(), richNarrations);
        } else if (district.type === 'medical') {
            if (district.money_cost > 0 && (char.wallet || 0) < district.money_cost * inflation) {
                db.city.logAction(char.id, 'BROKE', `${char.name} 想去 ${district.emoji}${district.name}，但钱不够 😩`, 0, 0, district.id);
                return;
            }
            if (currentCals >= 800) {
                // Character is healthy but went to hospital! Enforce punishment according to rules.
                // The LLM was explicitly instructed in the prompt to write about being scolded.
                dCal = -(district.cal_cost || 0); // No bonus reward, still pay travel cost
                const punishLog = getLogText(`${char.name} 没病却跑去 ${district.emoji}${district.name}，被分诊护士赶了出来，白交了挂号费 😰`);
                db.city.logAction(char.id, district.id.toUpperCase(), punishLog, dCal, dMoney, district.id);
                if (richNarrations) broadcastCityToChat(userId, char, punishLog, district.id.toUpperCase(), richNarrations);
            } else {
                // Actually sick/starving, gets the +1500 cals
                const normalLog = getLogText(`${char.name} 去了 ${district.emoji}${district.name}，${district.action_label}`);
                db.city.logAction(char.id, district.id.toUpperCase(), normalLog, dCal, dMoney, district.id);
                if (richNarrations) broadcastCityToChat(userId, char, normalLog, district.id.toUpperCase(), richNarrations);
            }
        } else {
            if (district.money_cost > 0 && (char.wallet || 0) < district.money_cost * inflation) {
                db.city.logAction(char.id, 'BROKE', `${char.name} 想去 ${district.emoji}${district.name}，但钱不够 😩`, 0, 0, district.id);
                return;
            }
            const normalLog = getLogText(`${char.name} 去了 ${district.emoji}${district.name}，${district.action_label}`);
            db.city.logAction(char.id, district.id.toUpperCase(), normalLog, dCal, dMoney, district.id);
            if (richNarrations) broadcastCityToChat(userId, char, normalLog, district.id.toUpperCase(), richNarrations);
        }

        const newCals = Math.min(4000, Math.max(0, currentCals + dCal));
        const newWallet = Math.max(0, (char.wallet || 0) + dMoney);
        const newCityStatus = district.duration_ticks > 1
            ? (district.type === 'work' ? 'working' : district.type === 'rest' ? 'sleeping' : 'eating')
            : (newCals < 500 ? 'hungry' : 'idle');

        db.updateCharacter(char.id, { calories: newCals, city_status: newCityStatus, location: district.id, wallet: newWallet });
        broadcastCityEvent(userId, char.id, district.id.toUpperCase(), `${char.name} -> ${district.emoji} ${district.name}`);

        const wsClients = getWsClients(userId);
        const engine = getEngine(userId);
        if (engine && typeof engine.broadcastWalletSync === 'function') {
            engine.broadcastWalletSync(wsClients, char.id);
        }
    }

    // Phase 5: social collision detection

    async function checkSocialCollisions(characters, db, userId, districts, config, minuteKey) {
        // Re-read fresh locations from DB
        const freshChars = characters.map(c => {
            const fresh = db.getCharacter(c.id);
            return fresh || c;
        }).filter(c => c.location && c.location !== 'home' && c.city_status !== 'coma' && c.sys_city_social !== 0);

        // Group by location
        const locationGroups = {};
        for (const c of freshChars) {
            const loc = c.location;
            if (!locationGroups[loc]) locationGroups[loc] = [];
            locationGroups[loc].push(c);
        }

        const zProb = parseInt(config.city_stranger_meet_prob || '20', 10);
        const yLimit = parseInt(config.city_social_log_limit || '3', 10);

        for (const [locId, group] of Object.entries(locationGroups)) {
            if (group.length < 2) continue;

            // Cap the encounter group to a maximum of 4 characters to manage token limits and generation time
            const shuffled = group.sort(() => Math.random() - 0.5);
            const occupants = shuffled.slice(0, 4);

            // Build pair key (order-independent) for cooldown tracking
            const ids = occupants.map(o => o.id).sort();
            const encounterKey = ids.join('::');

            // Check cooldown (3 ticks ~= 45 min in prod)
            const lastTime = socialCooldowns.get(encounterKey) || 0;
            const cooldownMs = 3 * 15 * 60 * 1000; // 45 minutes
            if (Date.now() - lastTime < cooldownMs) continue;

            if (typeof db.city?.claimSocialEncounter === 'function') {
                const claimed = db.city.claimSocialEncounter(encounterKey, minuteKey, Date.now() + cooldownMs);
                if (!claimed) {
                    console.log(`[City/Social] skipped duplicate encounter for ${encounterKey} @ ${minuteKey}`);
                    continue;
                }
            }

            const district = districts.find(d => d.id === locId) || { id: locId, name: locId, emoji: '📍' };

            console.log(`[City/Social] 🤝 N-Character Encounter Detection - ${occupants.map(o => o.name).join(', ')} 在 ${district.emoji}${district.name} 碰面了！`);

            socialCooldowns.set(encounterKey, Date.now());
            await runSocialEncounter(occupants, district, db, userId, yLimit);
        }
    }

    async function runSocialEncounter(occupants, district, db, userId, yLimit) {
        if (!occupants || occupants.length < 2) return;

        // Ensure we have at least one character with valid API to act as System API
        const systemApiChar = occupants.find(c => c.api_endpoint && c.api_key && c.model_name);
        if (!systemApiChar) {
            console.log(`[City/Social] ⚠️ 遭遇中没有任何角色配置 API，无法生成互动。`);
            return;
        }

        let simulationLogs = [];
        const engineContextWrapper = { getUserDb: context.getUserDb, getMemory: context.getMemory };

        // Phase 1-N: sequential speaking
        for (let i = 0; i < occupants.length; i++) {
            const speaker = occupants[i];

            if (!speaker.api_endpoint || !speaker.api_key || !speaker.model_name) {
                simulationLogs.push(`[${speaker.name} 保持沉默，只是在旁边看着]`);
                continue;
            }

            // Exclude speaker themselves from active targets
            const activeTargets = occupants.filter(c => c.id !== speaker.id);
            const uniCtx = await buildUniversalContext(engineContextWrapper, speaker, '', false, activeTargets);
            const persona = (speaker.persona || speaker.system_prompt || '普通人').substring(0, 150);

            // Build Context Logs based on Familiarity (if any logs exist)
            let logsContext = '';
            for (const t of activeTargets) {
                // Determine familiarity loosely: if any relationship exists
                const rel = db.getCharRelationship(speaker.id, t.id);
                if (rel) {
                    const logs = db.city.getOtherCharacterLocationTodayLogs(t.id, district.id, Math.min(yLimit, 2));
                    if (logs && logs.length > 0) {
                        logsContext += `\n[系统提示: ${t.name} 最近曾在这里做过]\n` + logs.map(l => `- ${l.message}`).join('\n');
                    }
                }
            }

            let prompt = `[世界观背景]
这是一段角色扮演式的随机社交遭遇。你们在商业街偶然相遇。
地点: ${district.emoji} ${district.name}
${uniCtx.preamble}

[当前遭遇场景]
你是 ${speaker.name} (${persona})。
在场的其他人有: ${activeTargets.map(t => t.name).join(', ')}。
${logsContext ? '\n' + logsContext : ''}`;

            if (simulationLogs.length > 0) {
                prompt += `\n\n【刚才在你面前已经发生的事情】\n${simulationLogs.join('\n')}\n`;
            } else {
                prompt += `\n\n你是第一个开口或行动的人。`;
            }

            prompt += `\n\n请根据你的性格、历史印象和当前状态，写下你此刻会说的一句话或做的一个动作。字数控制在 50 字左右，必须是第三人称视角的动作描述或对白。只直接返回行为描述，不要输出多余格式或 JSON。`;

            try {
                const reply = await callLLM({
                    endpoint: speaker.api_endpoint, key: speaker.api_key, model: speaker.model_name,
                    messages: [
                        { role: 'system', content: '你是一个商业街社交遭遇模拟器。请用第三人称描述角色说的话或做的动作，控制在 50 字左右。只输出行为描述文本，不要输出 JSON 或其他格式。' },
                        { role: 'user', content: prompt }
                    ], maxTokens: 1500, temperature: 0.85
                });
                const cleanReply = reply.replace(/\n+/g, ' ').replace(/"/g, "'").trim();
                simulationLogs.push(`【${speaker.name}的行动】 ${cleanReply || '[无响应]'}`);
            } catch (e) {
                console.error(`[City/Social] ${speaker.name} Phase LLM 失败:`, e.message);
                simulationLogs.push(`【${speaker.name}的行动】 [由于网络波动没有任何动作]`);
            }
        }

        if (simulationLogs.length === 0) return;

        // Phase Final: system API summarization
        // Fetch the user's profile to get their customized name
        const userProfile = typeof db.getUserProfile === 'function' ? db.getUserProfile() : null;
        const userName = userProfile?.name || "User";

        let systemPrompt = `你是一个负责商业街社交结算的系统 AI。
以下是在 ${district.emoji} ${district.name} 发生的一段按顺序展开的社交互动记录：

${simulationLogs.map((l, idx) => `${idx + 1}. ${l}`).join('\n')}

请根据这段互动序列，为在场的每一个角色结算社交结果。你必须返回严格的 JSON 对象，不要包含 Markdown 标记，也不要输出额外解释文字。

返回格式如下：
{
  "summary_log": "用上帝视角写一句简短总结，作为最终公开系统日志",
  "characters": {
    "传入的角色ID_1": {
      "chat": "该角色发给玩家 ${userName} 的私聊内容。必须是强烈的第一人称口吻；如果不想发则留空字符串。",
      "moment": "该角色事后发的一条朋友圈动态",
      "diary": "该角色的私密日记，写下这次相遇中的真实想法",
      "affinity_deltas": {
        "其他角色ID_A": -2,
        "其他角色ID_B": 3
      },
      "impressions": {
        "其他角色ID_A": "对该角色的最新简短印象"
      }
    }
  }
}

参数提示：只结算这 ${occupants.length} 个在场角色，并且 JSON 的 key 必须严格使用下面给出的角色 ID。
`;
        occupants.forEach(c => {
            const inv = db.city.getInventory(c.id).slice(0, 5).map(i => `${i.emoji}${i.name}`).join(',') || '空';
            systemPrompt += `- 姓名: ${c.name}, ID: "${c.id}", 身上携带物品: ${inv}\n`;
        });

systemPrompt += `\n[重要指令] JSON 的 key 必须严格匹配上面给出的角色 ID，不要使用别的名字或描述。\n`;
        systemPrompt += `[对象边界]\n`;
        systemPrompt += `1. 角色对玩家 ${userName} 的嫉妒、被忽视感、占有欲、索求安抚，默认只指向玩家本人。\n`;
        systemPrompt += `2. 不要把角色对玩家的强烈情绪，直接改写成对在场其他角色的情绪。\n`;
        systemPrompt += `3. 只有当本次现场互动里出现了明确的挑衅、误会、竞争、迁怒或投射时，才允许把负面情绪落到其他角色身上。\n`;
        systemPrompt += `4. affinity_deltas 和 impressions 必须基于角色之间这次真实互动本身，而不是基于他们对玩家的私聊情绪。\n`;
        systemPrompt += `[输出偏好]\n如果这次相遇对某个角色来说明显值得私聊玩家、发朋友圈或写日记，请积极填写对应字段，不要过度保守。\n`;
        systemPrompt += `- chat 要像角色真的忍不住想找玩家说话，允许嫉妒、撒娇、试探、炫耀、抱怨。\n`;
        systemPrompt += `- moment 要像真实朋友圈，不要写成“在某地遇到了一群人”这种系统播报。\n`;
        systemPrompt += `- diary 要比 chat 更坦白、更像心里话。\n`;
        systemPrompt += `如果角色没有明确表达欲，再留空字符串。\n`;
        systemPrompt += `[严格 JSON 语法警告]\n1. 所有字符串值内部都不能出现真实换行；如需换行，请输出转义字符 "\\n"。\n2. 所有字符串值内部都不能包含未转义的英文双引号 (\")；必要时请改用单引号或中文引号。\n3. 最后一个字段后面不要带多余逗号。\n`;

        let systemResult = null;
        let clean = '';
        try {
            const reply = await callLLM({
                endpoint: systemApiChar.api_endpoint, key: systemApiChar.api_key, model: systemApiChar.model_name,
                messages: [{ role: 'user', content: systemPrompt }], maxTokens: 4000, temperature: 0.7
            });
            const match = reply.match(/\{[\s\S]*\}/);
            if (match) {
                clean = match[0];
                try {
                    systemResult = JSON.parse(clean);
                } catch (pe) {
                    clean = clean.replace(/,\s*([\]}])/g, '$1')
                        .replace(/\/\/.*$/gm, '')
                        .replace(/(?<!\\)\n/g, '\\n')
                        .replace(/\\n\s*}/, '\n}')
                        .replace(/{\s*\\n/, '{\n');
                    systemResult = JSON.parse(clean);
                }
            } else {
                console.error(`[City/Social] System Final Parser 失败: 没有找到大括号匹配项. RAW:`, reply.substring(0, 200));
            }
        } catch (e) {
            console.error(`[City/Social] System Final Parser 失败:`, e.message);
            console.error(`[City/Social] 尝试解析的文本:\n`, clean ? clean.substring(0, 1500) : '未提取到 JSON');
        }

        // Rule-based Fallback
        if (!systemResult || !systemResult.characters) {
            console.warn(`[City/Social] 采用规则系统 fallback 结算遭遇`);
            systemResult = {
                summary_log: `${occupants.map(c => c.name).join('、')} 在 ${district.emoji}${district.name} 聚在一起待了一会儿。`,
                characters: {}
            };
            for (const c of occupants) {
                systemResult.characters[c.id] = {
                    chat: '',
                    moment: '',
                    diary: `今天在街上遇到了 ${occupants.length - 1} 个人。`,
                    affinity_deltas: {}
                };
                for (const other of occupants) {
                    if (c.id !== other.id) systemResult.characters[c.id].affinity_deltas[other.id] = Math.floor(Math.random() * 5) - 1;
                }
            }
        }

        // Apply results
        const summaryMsg = systemResult.summary_log || `${occupants.map(c => c.name).join('、')} 的遭遇结束了。`;
        const fullLog = `🤝 ${summaryMsg}\n\n📝 [现场侧录]\n${simulationLogs.join('\n')}`;
        db.city.logAction(occupants[0].id, district.id.toUpperCase(), fullLog, 0, 0, district.id);

        for (const c of occupants) {
            const data = systemResult.characters[c.id] || systemResult.characters[c.name]; // fallback if LLM misunderstood keys
            if (!data) continue;

            const safeDeltas = data.affinity_deltas || {};
            const safeImpressions = data.impressions || {};
            let netAffinityStr = '';

            for (const other of occupants) {
                if (c.id === other.id) continue;

                // Try resolving by target ID, then by target Name
                let delta = safeDeltas[other.id];
                if (delta === undefined) delta = safeDeltas[other.name];

                let impression = safeImpressions[other.id];
                if (impression === undefined) impression = safeImpressions[other.name];

                const updates = {};
                const dAmt = parseInt(delta);
                if (!isNaN(dAmt) && dAmt !== 0) {
                    const clampedDelta = Math.max(-10, Math.min(10, dAmt));
                    const rel = db.getCharRelationship(c.id, other.id);
                    const curr = rel?.affinity ?? 50;
                    updates.affinity = Math.max(0, Math.min(100, curr + clampedDelta));
                    netAffinityStr += `[-> ${other.name}: ${clampedDelta > 0 ? '+' : ''}${clampedDelta}] `;
                }

                if (impression && typeof impression === 'string' && impression.trim()) {
                    updates.impression = impression.trim().substring(0, 50);
                }

                if (Object.keys(updates).length > 0) {
                    db.updateCharRelationship(c.id, other.id, 'city_social', updates);
                }
            }

            console.log(`[City/Social] ✅ ${c.name} 结算完毕 ${netAffinityStr}`);

            broadcastCityEvent(userId, c.id, 'SOCIAL', `🤝 ${c.name}: ${summaryMsg}`);
            broadcastCityToChat(userId, c, summaryMsg, 'SOCIAL', {
                chat: data.chat,
                moment: data.moment,
                diary: data.diary
            });
        }
    }

    // In-memory lock to prevent overlapping schedule generation for the same character
    const scheduleGenLocks = new Set();

    async function maybeGenerateSchedule(char, db, districts, config) {
        if (char.is_scheduled === 0) return; // Schedule disabled by user

        const today = getCityDate(config).toISOString().split('T')[0];
        const existing = db.city.getSchedule(char.id, today);
        if (existing && existing.schedule_json && existing.schedule_json !== '[]') return; // already has a real plan for today

        // Prevent concurrent generation for the same character (cron fires every minute, LLM may take >1min)
        const lockKey = `${char.id}_${today}`;
        if (scheduleGenLocks.has(lockKey)) return;
        scheduleGenLocks.add(lockKey);

        try {
            if (!char.api_endpoint || !char.api_key || !char.model_name) {
                return { success: false, reason: '角色未配置主AI，无法生成日程' };
            }

            if (!existing) {
                const claimed = typeof db.city.claimScheduleGeneration === 'function'
                    ? db.city.claimScheduleGeneration(char.id, today)
                    : true;
                if (!claimed) {
                    return { success: false, reason: '今日计划生成已被其他实例占用' };
                }
            }

            // Broadcast generating state
            broadcastCityEvent(context.userId, char.id, 'schedule_generating', null);

            const engineContextWrapper = { getUserDb: context.getUserDb, getMemory: context.getMemory };
            const universalResult = await buildUniversalContext(engineContextWrapper, char, '', false);
            const prompt = buildSchedulePrompt(char, districts, universalResult);
            const reply = await callLLM({
                endpoint: char.api_endpoint, key: char.api_key, model: char.model_name,
                messages: [
                    { role: 'system', content: '你是一个日程规划助手。只返回一个 JSON 数组，每个元素都包含 hour、action 和 reason 三个字段。不要输出任何 JSON 之外的文字或 Markdown。' },
                    { role: 'user', content: prompt }
                ], maxTokens: 1000, temperature: 0.7
            });
            // Extract JSON from reply and strip markdown code fences if present
            const cleaned = reply.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
            const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                const plan = JSON.parse(jsonMatch[0]);
                // Validate: each entry must have hour and action
                const valid = plan.filter(e => typeof e.hour === 'number' && typeof e.action === 'string');
                if (valid.length > 0) {
                    db.city.saveSchedule(char.id, today, valid);
                    const summary = valid.slice(0, 3).map(e => `${e.hour}:00 ${e.action}`).join(' -> ');
                    db.city.logAction(char.id, 'PLAN', `${char.name} 制定了今日计划：${summary}... 📝`, 0, 0);
                    console.log(`[City] ${char.name} 📝 日程已生成 (${valid.length} 个时段)`);

                    // Broadcast success
                    broadcastCityEvent(context.userId, char.id, 'schedule_updated', valid);
                    return true;
                }
            }
            // Failed: log the raw reply for debugging
            const snippet = reply.substring(0, 200);
            console.warn(`[City] ${char.name} 日程 JSON 解析失败, LLM 原始回复: ${snippet}`);
            // Broadcast end (if failed validation)
            broadcastCityEvent(context.userId, char.id, 'schedule_updated', []);
            if (typeof db.city.releaseScheduleGeneration === 'function') {
                db.city.releaseScheduleGeneration(char.id, today);
            }
            return { success: false, reason: `LLM 返回内容无法解析为 JSON: ${snippet}` };
        } catch (e) {
            console.error(`[City] ${char.name} 日程生成失败: ${e.message}`);
            // Broadcast end (if fetch threw error)
            broadcastCityEvent(context.userId, char.id, 'schedule_updated', []);
            if (typeof db.city.releaseScheduleGeneration === 'function') {
                db.city.releaseScheduleGeneration(char.id, today);
            }
            return { success: false, reason: e.message };
        } finally {
            scheduleGenLocks.delete(lockKey);
        }
    }

    // Mayor AI cron service

    let mayorTimer = null;

    function buildMayorContext(db) {
        const items = db.city.getItems();
        const districts = db.city.getEnabledDistricts();
        const config = db.city.getConfig();
        const economy = db.city.getEconomyStats();
        const activeEvents = db.city.getActiveEvents();
        const activeQuests = db.city.getActiveQuests();

        return `
== 城市实时数据报告 ==

[商品列表] (${items.length} 种)
${items.map(i => `  - ${i.emoji} ${i.name} (ID: ${i.id}) | 当前售价: ${i.buy_price} 金币 | 恢复: ${i.cal_restore} 体力 | 售卖地点: ${i.sold_at || '全城'} | 库存: ${i.stock === -1 ? '无限' : i.stock + ' 件'}`).join('\n')}
------------------------------
[分区列表] (${districts.length} 个)
${districts.map(d => `  - ${d.emoji} ${d.name} (ID: ${d.id}) | 类型: ${d.type} | 消耗: ${d.cal_cost} 体力 ${d.money_cost} 金币 | 收益: ${d.cal_reward} 体力 ${d.money_reward} 金币`).join('\n')}

[经济概况]
  - 全城流通金币: ${economy.total_gold_in_circulation?.toFixed(0) || 0}
  - 平均体力值: ${economy.avg_calories || 0}
  - 近 1 小时行动: ${economy.actions_last_hour?.map(a => `${a.action_type}×${a.count}`).join(', ') || '无'}

[当前活跃事件] (${activeEvents.length} 个)
${activeEvents.length > 0 ? activeEvents.map(e => `  - ${e.emoji} ${e.title}: ${e.description} (剩余 ${Math.max(0, Math.round((e.expires_at - Date.now()) / 3600000))} 小时)`).join('\n') : '  无'}

[当前活跃任务] (${activeQuests.length} 个)
${activeQuests.length > 0 ? activeQuests.map(q => `  - ${q.emoji} ${q.title} (${q.difficulty}) | 奖励: ${q.reward_gold} 金币 ${q.reward_cal} 体力 | ${q.claimed_by ? '已被领取' : '待接取'}`).join('\n') : '  无'}
`;
    }

    async function runMayorAI(db) {
        try {
            const config = db.city.getConfig();
            const mayorPrompt = config.mayor_prompt || '生成 1 个随机城市事件和 1 个悬赏任务，并用 JSON 回复';

            // Expire old events
            db.city.expireEvents();

            // Pick the character designated as the "mayor vessel", custom API, or fall back to first available
            const chars = db.getCharacters();
            let aiChar = null;
            if (config.mayor_model_char_id === '__custom__') {
                aiChar = {
                    name: '自定义 API',
                    api_endpoint: config.mayor_custom_endpoint,
                    api_key: config.mayor_custom_key,
                    model_name: config.mayor_custom_model
                };
            } else if (config.mayor_model_char_id) {
                aiChar = chars.find(c => String(c.id) === String(config.mayor_model_char_id) && c.api_endpoint && c.api_key);
            }
            if (!aiChar || !aiChar.api_endpoint || !aiChar.api_key) {
                aiChar = chars.find(c => c.api_endpoint && c.api_key && c.model_name);
            }
            if (!aiChar || !aiChar.api_endpoint || !aiChar.api_key) {
                console.log('[Mayor AI] 没有可用的 API 配置，跳过。');
                return { success: false, reason: 'no_api_config' };
            }
            console.log(`[Mayor AI] 使用 ${aiChar.name} 的模型 (${aiChar.model_name})`);

            const context = buildMayorContext(db);
            const fullPrompt = mayorPrompt + '\n\n' + context;

            console.log('[Mayor AI] 🏛️ 市长正在做决策...');
            const reply = await callLLM({
                endpoint: aiChar.api_endpoint, key: aiChar.api_key, model: aiChar.model_name,
                messages: [{ role: 'user', content: fullPrompt }],
                maxTokens: 1500, temperature: 0.9
            });

            // Extract JSON from reply
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.log('[Mayor AI] ⚠️ 回复不含 JSON，改用规则生成。');
                return applyFallbackMayorDecisions(db);
            }

            const decision = JSON.parse(jsonMatch[0]);
            return applyMayorDecisions(db, decision);
        } catch (e) {
            console.error('[Mayor AI] 决策失败:', e.message);
            return applyFallbackMayorDecisions(db);
        }
    }

    function applyMayorDecisions(db, decision) {
        const results = { price_changes: 0, events: 0, quests: 0, announcement: '' };

        // Apply price changes
        if (Array.isArray(decision.price_changes)) {
            for (const pc of decision.price_changes) {
                const item = db.city.getItem(pc.item_id);
                if (item && typeof pc.new_price === 'number' && pc.new_price > 0) {
                    db.city.upsertItem({ ...item, buy_price: pc.new_price });
                    db.city.logAction('system', 'MAYOR', `📳 市长调价：${item.emoji}${item.name} -> ${pc.new_price} 金币 (${pc.reason || ''})`, 0, 0);
                    results.price_changes++;
                }
            }
        }

        // Create events
        if (Array.isArray(decision.events)) {
            for (const ev of decision.events) {
                if (ev.title) {
                    db.city.createEvent({
                        type: ev.type || 'random', title: ev.title, emoji: ev.emoji || '📙',
                        description: ev.description || '', effect: ev.effect || {},
                        target_district: ev.effect?.district || '', duration_hours: ev.duration_hours || 12
                    });
                    db.city.logAction('system', 'EVENT', `${ev.emoji || '📙'} 城市事件: ${ev.title} - ${ev.description || ''}`, 0, 0);
                    results.events++;
                }
            }
        }

        // Create quests
        if (Array.isArray(decision.quests)) {
            for (const q of decision.quests) {
                if (q.title) {
                    db.city.createQuest({
                        title: q.title, emoji: q.emoji || '📐', description: q.description || '',
                        reward_gold: q.reward_gold ?? 50, reward_cal: q.reward_cal ?? 0,
                        difficulty: q.difficulty || 'normal'
                    });
                    db.city.logAction('system', 'QUEST', `📐 新悬赏任务: ${q.title} (${q.difficulty || 'normal'}) - 奖励 ${q.reward_gold ?? 50} 金币`, 0, 0);
                    results.quests++;
                }
            }
        }

        // Announcement
        if (decision.announcement) {
            db.city.logAction('system', 'ANNOUNCE', `📙 城市广播: ${decision.announcement}`, 0, 0);
            results.announcement = decision.announcement;
        }

        console.log(`[Mayor AI] 执行完成: ${results.price_changes} 个调价, ${results.events} 个事件, ${results.quests} 个任务`);
        return { success: true, results };
    }

    function applyFallbackMayorDecisions(db) {
        // Realistic weather probabilities
        const weatherRoll = Math.random();
        let w;
        if (weatherRoll < 0.35) {
            w = { title: '晴天', emoji: '☀️', desc: '阳光明媚，适合户外活动', dur: 12 };
        } else if (weatherRoll < 0.55) {
            w = { title: '多云', emoji: '⛅', desc: '云层较多，气温舒适', dur: 12 };
        } else if (weatherRoll < 0.70) {
            w = { title: '微风', emoji: '🍃', desc: '清风徐来，心情舒缓', dur: 8 };
        } else if (weatherRoll < 0.85) {
            w = { title: '小雨', emoji: '🌦️', desc: '细雨绵绵，记得带伞', dur: 6 };
        } else if (weatherRoll < 0.92) {
            w = { title: '大雨', emoji: '🌧️', desc: '倾盆大雨，建议待在室内', dur: 8 };
        } else if (weatherRoll < 0.97) {
            w = { title: '大雾', emoji: '🌫️', desc: '能见度较低，出行注意安全', dur: 6 };
        } else {
            w = { title: '暴风雨', emoji: '⛈️', desc: '雷暴天气，请在安全处避雨', dur: 4 };
        }

        try {
            db.city.createEvent({ type: 'weather', title: w.title, emoji: w.emoji, description: w.desc, duration_hours: w.dur });
            db.city.logAction('system', 'EVENT', `${w.emoji} 天气: ${w.title} - ${w.desc}`, 0, 0);
        } catch (e) { console.error('[Mayor fallback] Event error:', e.message); }

        const quests = [
            { title: '用 ASCII 画一幅画', emoji: '🎨', desc: '用纯文本字符创作一幅 ASCII 艺术画', gold: 40, diff: 'normal' },
            { title: '写一首小诗', emoji: '✍️', desc: '以城市的黄昏为主题写一首短诗', gold: 35, diff: 'easy' },
            { title: '编一个冷笑话', emoji: '😄', desc: '讲一个让人忍不住翻白眼的冷笑话', gold: 20, diff: 'easy' },
            { title: '出一道谜语', emoji: '🧩', desc: '出一道有趣的谜语考考大家', gold: 30, diff: 'easy' },
            { title: '写一段绕口令', emoji: '🗣️', desc: '创作一段有趣的中文绕口令', gold: 35, diff: 'normal' },
            { title: '编一个微小说', emoji: '📘', desc: '用 50 字以内写一个完整的微型故事', gold: 50, diff: 'normal' },
            { title: '发明一道菜', emoji: '🍳', desc: '用背包里的食材发明一道创意料理并写出做法', gold: 45, diff: 'normal' },
            { title: '用 Emoji 画一幅画', emoji: '🖼️', desc: '只用 Emoji 表情创作一幅有创意的画面', gold: 30, diff: 'easy' },
            { title: '写一封情书', emoji: '💌', desc: '以匿名身份给城里某位居民写一封搞笑情书', gold: 40, diff: 'normal' },
            { title: '即兴 Rap', emoji: '🎤', desc: '以商业街日常为主题来一段即兴说唱', gold: 55, diff: 'hard' },
            { title: '编一个都市传说', emoji: '👻', desc: '为这座城市编一个神秘的都市传说', gold: 45, diff: 'normal' },
            { title: '写今日运势', emoji: '🔮', desc: '给城里的每位居民写一句今日运势', gold: 35, diff: 'easy' },
        ];

        const q = quests[Math.floor(Math.random() * quests.length)];
        try {
            db.city.createQuest({ title: q.title, emoji: q.emoji, description: q.desc, reward_gold: q.gold, difficulty: q.diff });
            db.city.logAction('system', 'QUEST', `📐 新悬赏: ${q.title} - 奖励 ${q.gold} 金币`, 0, 0);
        } catch (e) { console.error('[Mayor fallback] Quest error:', e.message); }

        console.log('[Mayor AI] 使用规则生成: ' + w.title + ' + ' + q.title);
        return { success: true, results: { price_changes: 0, events: 1, quests: 1, announcement: '' }, fallback: true };
    }

    // Events & quests REST APIs

    app.get('/api/city/events', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const active = req.query.all === '1' ? req.db.city.getAllEvents() : req.db.city.getActiveEvents();
            res.json({ success: true, events: active });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/city/events', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            if (!req.body.title) return res.status(400).json({ error: '缺少 title' });
            req.db.city.createEvent(req.body);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/city/events/:id', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            req.db.city.deleteEvent(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/city/quests', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const active = req.query.all === '1' ? req.db.city.getAllQuests() : req.db.city.getActiveQuests();
            res.json({ success: true, quests: active });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/city/quests', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            if (!req.body.title) return res.status(400).json({ error: '缺少 title' });
            req.db.city.createQuest(req.body);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/city/quests/:id', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            req.db.city.deleteQuest(req.params.id);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Manual Schedule Generation Trigger
    app.post('/api/city/schedules/:charId/generate', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const charId = req.params.charId;
            const char = req.db.getCharacter(charId);
            if (!char) return res.status(404).json({ error: '角色不存在' });

            if (!char.api_endpoint || !char.api_key) {
                return res.status(400).json({ error: '角色未配置API，无法生成' });
            }

            const districts = req.db.city.getEnabledDistricts();
            const config = req.db.city.getConfig();

            // Delete existing active schedule for today so it forces regen
            const todayStr = getCityDate(config).toISOString().split('T')[0];
            req.db.city.db.prepare('DELETE FROM city_schedules WHERE character_id = ? AND plan_date = ?').run(charId, todayStr);

            // Clear lock so force-regen isn't blocked
            scheduleGenLocks.delete(`${charId}_${todayStr}`);

            // Force generation
            const result = await maybeGenerateSchedule(char, req.db, districts, config);

            if (result === true) {
                const schedule = req.db.city.getTodaySchedule(char.id);
                res.json({ success: true, schedule: schedule ? JSON.parse(schedule.schedule_json) : [] });
            } else {
                const reason = (result && result.reason) || '未知错误';
                res.status(500).json({ error: `日程生成失败: ${reason}` });
            }
        } catch (e) {
            console.error('[City/ScheduleGen] API Route Error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Manual trigger for Mayor AI
    app.post('/api/city/mayor/run', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const result = await runMayorAI(req.db);
            res.json({ success: true, ...result });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // City->Chat bridge: send city events to chat, moments, diary, and memory

    function broadcastCityToChat(userId, char, eventSummary, eventType, richNarrations = null) {
        try {
            const db = getUserDb(userId);
            ensureCityDb(db);
            const config = db.city.getConfig();
            const chatProb = parseInt(config.city_chat_probability) || 0;  // legacy fallback gate
            const explicitChat = richNarrations?.chat && String(richNarrations.chat).trim() !== '' ? String(richNarrations.chat).trim() : '';
            const explicitMoment = richNarrations?.moment && String(richNarrations.moment).trim() !== '' ? String(richNarrations.moment).trim() : '';
            const explicitDiary = richNarrations?.diary && String(richNarrations.diary).trim() !== '' ? String(richNarrations.diary).trim() : '';

            // 1. Private chat message to user
            // Prefer explicit intent from the character's structured output.
            if (char.sys_city_notify && (explicitChat || (!richNarrations && chatProb > 0 && Math.random() * 100 < chatProb))) {
                try {
                    const chatContent = explicitChat || (!richNarrations ? eventSummary : null);
                    if (chatContent && String(chatContent).trim() !== '') {
                        const engine = getEngine(userId);
                        const wsClients = getWsClients(userId);
                        const { id: msgId, timestamp: msgTs } = db.addMessage(char.id, 'character', chatContent);
                        const freshChar = db.getCharacter(char.id) || char;
                        const hadPendingReply = !!freshChar.city_reply_pending;
                        const nextIgnoreStreak = hadPendingReply ? Math.min(6, (freshChar.city_ignore_streak || 0) + 1) : 0;
                        const nextPressure = hadPendingReply && freshChar.sys_pressure !== 0
                            ? Math.min(4, (freshChar.pressure_level || 0) + 1)
                            : (freshChar.pressure_level || 0);
                        const nextJealousy = hadPendingReply && freshChar.sys_jealousy !== 0
                            ? Math.min(4, (freshChar.jealousy_level || 0) + 1)
                            : (freshChar.jealousy_level || 0);
                        db.updateCharacter(char.id, {
                            city_reply_pending: 1,
                            city_ignore_streak: nextIgnoreStreak,
                            city_last_outreach_at: Date.now(),
                            city_post_ignore_reaction: 0,
                            pressure_level: nextPressure,
                            jealousy_level: nextJealousy
                        });
                        const newMessage = {
                            id: msgId, character_id: char.id, role: 'character',
                            content: chatContent, timestamp: msgTs, read: 0
                        };
                        engine.broadcastNewMessage(wsClients, newMessage);
                        engine.broadcastEvent(wsClients, { type: 'refresh_contacts' });
                        console.log(`[City->Chat] ${char.name} 发私聊 "${chatContent.substring(0, 40)}..."`);
                    }
                } catch (e) {
                    console.error(`[City->Chat] 私聊失败: ${e.message}`);
                }
            }

            // 2. Post to Moments
            // Do not auto-post generic city logs. Only post when the character explicitly produced a Moment.
            if (explicitMoment) {
                try {
                    if (explicitMoment) {
                        db.addMoment(char.id, explicitMoment);
                        // Broadcast moment update to frontend
                        const wsClients = getWsClients(userId);
                        const payload = JSON.stringify({ type: 'moment_update' });
                        wsClients.forEach(c => { if (c.readyState === 1) c.send(payload); });
                        console.log(`[City->Chat] ${char.name} 发朋友圈: "${explicitMoment.substring(0, 40)}..."`);
                    }
                } catch (e) {
                    console.error(`[City->Chat] 朋友圈失败: ${e.message}`);
                }
            }

            // 3. Write diary entry
            // Same rule as Moments: only persist when the character explicitly produced diary content.
            if (explicitDiary) {
                try {
                    const emotionMap = {
                        'SOCIAL': 'happy', 'BUY': 'happy', 'EAT': 'content',
                        'STARVE': 'desperate', 'GAMBLING_WIN': 'excited',
                        'GAMBLING_LOSE': 'sad', 'BROKE': 'worried'
                    };

                    const diaryText = explicitDiary;

                    if (diaryText) {
                        db.addDiary(char.id, diaryText, emotionMap[eventType] || 'neutral');
                        console.log(`[City->Chat] ${char.name} 写日记 ${eventType}`);
                    }
                } catch (e) {
                    console.error(`[City->Chat] 日记失败: ${e.message}`);
                }
            }

            // 4. Save only notable city events to long-term memory.
            const shouldPersistSpecialCityMemory = () => {
                if (!eventSummary || String(eventSummary).trim() === '') return false;
                if (['STARVE', 'BROKE', 'GAMBLING_WIN', 'GAMBLING_LOSE', 'SOCIAL'].includes(eventType)) return true;

                const text = [
                    eventSummary,
                    richNarrations?.chat || '',
                    richNarrations?.diary || '',
                    richNarrations?.moment || ''
                ].join(' ');

                return /(饿晕|崩溃|破产|输光|赢了|中奖|住院|急诊|吵架|嫉妒|焦虑|监视|跟踪|告白|拥抱|接吻|约会|礼物|转账|红包|秘密|暗号|黑客|偷窥|偷拍|冲突|事故|任务|悬赏|灾难|天气|暴雨|停电|受伤|工厂|餐厅|便利店)/.test(text);
            };

            if (shouldPersistSpecialCityMemory()) {
                try {
                    const memory = getMemory(userId);
                    memory.saveExtractedMemory(char.id, {
                        event: eventSummary,
                        time: new Date().toLocaleString('zh-CN'),
                        location: char.location || '',
                        people: '',
                        relationships: '',
                        items: '',
                        importance: ['STARVE', 'BROKE', 'GAMBLING_WIN', 'GAMBLING_LOSE', 'SOCIAL'].includes(eventType) ? 7 : 6
                    });
                    console.log(`[City->Chat] ${char.name} 特殊事件入记忆 ${eventType}`);
                } catch (e) {
                    console.error(`[City->Chat] 记忆失败: ${e.message}`);
                }
            }
        } catch (e) {
            console.error(`[City->Chat] 桥接异常: ${e.message}`);
        }
    }

    // Phase 7: Time Skip Schedule Backfill

    async function runTimeSkipBackfill(db, oldCityDate, newCityDate, userId) {
        console.log(`[City DLC] ⏩ 触发时空飞跃推算: ${oldCityDate.toLocaleString()} -> ${newCityDate.toLocaleString()}`);

        let processedTasks = 0;
        const wsClients = getWsClients(userId);

        // Broadcast start
        if (wsClients && wsClients.size > 0) {
            const msg = `System: 时光飞逝，时间快进了大约 ${Math.floor((newCityDate - oldCityDate) / 3600000)} 小时。系统正在异步推算这段时间内角色们的经历...`;
            wsClients.forEach(c => c.readyState === 1 && c.send(JSON.stringify({ type: 'city_update', action: 'time-skip-start', message: msg })));
        }

        // Find all characters with active APIs (whether scheduled or not)
        const characters = db.getCharacters().filter(c => c.api_endpoint && c.api_key);

        for (const char of characters) {
            const userProfile = typeof db.getUserProfile === 'function' ? db.getUserProfile() : null;
            const userName = userProfile?.name || "User";

            const todayStr = newCityDate.toISOString().split('T')[0];
            const scheduleRecord = db.city.getTodaySchedule(char.id, todayStr);

            let scheduleArray = [];
            if (scheduleRecord && scheduleRecord.schedule_json) {
                try { scheduleArray = JSON.parse(scheduleRecord.schedule_json); } catch (e) { }
            }

            const oldHour = oldCityDate.getHours();
            const newHour = newCityDate.getHours();
            const isNextDay = newCityDate.getDate() > oldCityDate.getDate();

            // Find missed tasks strictly between the old time and new time
            const missedTasks = scheduleArray.filter(task => {
                const taskHour = Number(task.hour);
                if (task.status === 'completed' || task.status === 'missed') return false;
                if (!isNextDay) return taskHour >= oldHour && taskHour < newHour;
                return taskHour >= oldHour || taskHour < newHour; // crossed midnight
            });

            const skippedHoursDelta = Math.floor((newCityDate - oldCityDate) / 3600000);

            console.log(`[City/TimeSkip] 正在推算 ${char.name} 跳过的 ${skippedHoursDelta} 小时...`);

            let prompt = '';

            // Scenario A: No missed scheduled tasks (or schedule is empty/disabled)
            if (missedTasks.length === 0) {
                prompt = `[世界观设定]
这是一段回溯模拟。在过去这段时间里（从 ${oldCityDate.getHours()}:00 到 ${newCityDate.getHours()}:00，大约 ${skippedHoursDelta} 小时），你处于自由活动状态，没有固定日程安排。

请你作为 ${char.name}，回想一下这段时间你是怎么度过的。你去了哪里，做了什么？
请输出一段 JSON 格式的回忆总结，包含发给玩家的微信、朋友圈和日记，系统会将其保存为这段时间的历史记录。`;
            }
            // Scenario C: Fully skipped (skipped more than or equal to 80% of schedule length or crossing day)
            else if (missedTasks.length >= Math.max(1, scheduleArray.length - 1)) {
                const missedTaskText = missedTasks.map(t => `- [${t.hour}:00] 计划去 ${t.action} (${t.reason})`).join('\n');
                prompt = `[世界观设定]
这是一段回溯模拟。时光飞逝，跳过了一大段时间（从 ${oldCityDate.getHours()}:00 直到 ${newCityDate.getHours()}:00），这几乎覆盖了你全天的大部分计划：
${missedTaskText}

请你作为 ${char.name}，一次性回想这整段时间自己是怎么度过的。这些计划是否顺利完成？中间有没有发生有趣的事或意外？
请输出一段 JSON 格式的回忆总结，包含发给玩家 ${userName} 的微信、朋友圈和日记，系统会将其保存为这段时间的历史记录。`;
            }
            // Scenario B: Partially skipped (missed just a few plans)
            else {
                const missedTaskText = missedTasks.map(t => `- [${t.hour}:00] 计划去 ${t.action} (${t.reason})`).join('\n');
                prompt = `[世界观设定]
这是一段回溯模拟。在过去的几个小时里（从 ${oldCityDate.getHours()}:00 到 ${newCityDate.getHours()}:00），你原本安排了以下行程：
${missedTaskText}

请你作为 ${char.name}，回想一下这段时间自己是怎么度过的。这几个计划是否顺利完成？中间有没有发生有趣的事或意外？
请输出一段 JSON 格式的回忆总结，包含发给玩家 ${userName} 的微信、朋友圈和日记，系统会将其保存为这段时间的历史记录。`;
            }

            prompt += `

返回格式要求（必须只返回 JSON，不要带 markdown 代码块）：
{
  "summary": "用 2-4 句话生动总结这段时间经历了什么，要有画面感和情绪",
  "tasks_completed": [8, ...],
  "tasks_missed": [12, ...],
  "chat": "（可选）发给玩家 ${userName} 的微信消息，口语化；如果不发就留空字符串",
  "moment": "发一条朋友圈动态记录刚才这几个小时的经历",
  "diary": "写一段内心独白式日记，可以反思，也可以抱怨"
}`;

            let fallbackToOrdinary = false;
            let result = null;

            try {
                const reply = await callLLM({
                    endpoint: char.api_endpoint, key: char.api_key, model: char.model_name,
                    messages: [{ role: 'user', content: prompt }], maxTokens: 1500, temperature: 0.95
                });

                const jsonMatch = reply.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    result = JSON.parse(jsonMatch[0]);
                } else {
                    fallbackToOrdinary = true;
                    console.error(`[City/TimeSkip] ${char.name} 返回了非 JSON 格式，触发平凡保底。`);
                }
            } catch (e) {
                console.error(`[City/TimeSkip] ${char.name} 回溯请求失败: ${e.message}。触发平凡保底。`);
                fallbackToOrdinary = true;
            }

            // Fallback Generation
            if (fallbackToOrdinary) {
                const fallbacks = [
                    {
                        summary: `${char.name} 在这段时间里过得相当惬意，享受着难得的平静。`,
                        moment: `微风不燥，阳光正好。在过去的 ${skippedHoursDelta} 个小时里，享受了一段完全属于自己的悠闲时光。`,
                        diary: `其实有时候，什么宏伟计划都不做，就这样静静让时间流过去，也是一种治愈。`
                    },
                    {
                        summary: `${char.name} 似乎卷入了一些鸡毛蒜皮的琐事，忙忙碌碌地度过了这段时间。`,
                        moment: `刚过去的这 ${skippedHoursDelta} 个小时简直像打仗一样，总算把手头的琐事全处理完了。`,
                        diary: `生活就是由无数琐碎小事拼出来的。虽然没按计划行事，但至少现在能松一口气了。`
                    },
                    {
                        summary: `${char.name} 找了个舒服的角落摸鱼，成功避开了一切麻烦。`,
                        moment: `堂堂正正度过了 ${skippedHoursDelta} 个小时的摸鱼时光。这才是生活的真谛。`,
                        diary: `我发誓我原本是打算做点正事的，但坐下来的那一刻，重力战胜了意志。这绝对不是我的错。`
                    },
                    {
                        summary: `${char.name} 去街头漫无目的地转了一圈，心情似乎还不错。`,
                        moment: `漫步在城市街头，这 ${skippedHoursDelta} 个小时里的沿途风景都挺好看。偶尔偏离一下生活轨道也不错。`,
                        diary: `原来这座城市还有这么多我没认真看过的细节。虽然错过了原定行程，但换来了一份好心情。`
                    }
                ];
                const FB = fallbacks[Math.floor(Math.random() * fallbacks.length)];

                result = {
                    summary: FB.summary,
                    tasks_completed: missedTasks.map(t => Number(t.hour)), // Assume they did it automatically
                    tasks_missed: [],
                    chat: "",
                    moment: FB.moment,
                    diary: FB.diary
                };
            }

            // Update schedule tasks with completed or missed status
            if (scheduleRecord && scheduleArray.length > 0 && missedTasks.length > 0) {
                let updatedSchedule = [...scheduleArray];
                const completedHours = result.tasks_completed || [];
                const missedHours = result.tasks_missed || [];

                updatedSchedule = updatedSchedule.map(task => {
                    const h = Number(task.hour);
                    if (completedHours.includes(h)) return { ...task, status: 'completed' };
                    if (missedHours.includes(h)) return { ...task, status: 'missed' };
                    if (missedTasks.some(mt => Number(mt.hour) === h)) {
                        // Default to completed if fallback, or missed if LLM forgot
                        return { ...task, status: fallbackToOrdinary ? 'completed' : 'missed' };
                    }
                    return task;
                });

                db.city.db.prepare('UPDATE city_schedules SET schedule_json = ? WHERE id = ?').run(JSON.stringify(updatedSchedule), scheduleRecord.id);
            }

            processedTasks += missedTasks.length;

            // Execute Broadcast bridge
            const eventSummary = result.summary;
            db.city.logAction(char.id, 'TIMESKIP', `⏩ 时间飞逝总结：${eventSummary}`, 0, 0);

            broadcastCityToChat(userId, char, eventSummary, 'TIMESKIP', {
                chat: result.chat,
                moment: result.moment,
                diary: result.diary
            });
        }

        // Broadcast finish
        if (wsClients && wsClients.size > 0) {
            const finishMsg = `✅ 时间飞逝推算完成。系统不仅处理了 ${processedTasks} 个错过的行程，还为这些角色补全了这段空白时间里的生活轨迹。`;
            wsClients.forEach(c => c.readyState === 1 && c.send(JSON.stringify({ type: 'city_update', action: 'time-skip-end', message: finishMsg })));
        }

        return processedTasks;
    }

    // Broadcast

    function broadcastCityEvent(userId, charId, action, message) {
        try {
            const wsClients = getWsClients(userId);
            if (wsClients && wsClients.size > 0) {
                const eventStr = JSON.stringify({ type: 'city_update', charId, action, message });
                wsClients.forEach(c => { if (c.readyState === 1) c.send(eventStr); });
            }
        } catch (e) { /* best-effort */ }
    }

    console.log('[City DLC] 商业街与生存系统路由已注册');
};
