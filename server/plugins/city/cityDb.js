module.exports = function initCityDb(db) {
    // Disable FK enforcement — city_logs uses 'system' as character_id for mayor/system actions
    try { db.pragma('foreign_keys = OFF'); } catch (e) { }
    // ═══════════════════════════════════════════════════════════════════════
    //  1. Extend characters table for survival mechanics
    // ═══════════════════════════════════════════════════════════════════════
    try { db.exec("ALTER TABLE characters ADD COLUMN calories INTEGER DEFAULT 2000;"); } catch (e) { }
    try { db.exec("ALTER TABLE characters ADD COLUMN city_status TEXT DEFAULT 'idle';"); } catch (e) { }
    try { db.exec("ALTER TABLE characters ADD COLUMN location TEXT DEFAULT 'home';"); } catch (e) { }
    try { db.exec("ALTER TABLE characters ADD COLUMN education TEXT DEFAULT 'none';"); } catch (e) { }
    try { db.exec("ALTER TABLE characters ADD COLUMN sys_survival INTEGER DEFAULT 1;"); } catch (e) { }
    try { db.exec("ALTER TABLE characters ADD COLUMN sys_city_social INTEGER DEFAULT 1;"); } catch (e) { }
    try { db.exec("ALTER TABLE characters ADD COLUMN is_scheduled INTEGER DEFAULT 1;"); } catch (e) { }
    try { db.exec("ALTER TABLE characters ADD COLUMN city_action_frequency INTEGER DEFAULT 1;"); } catch (e) { }
    try { db.exec("ALTER TABLE characters ADD COLUMN city_status_started_at INTEGER DEFAULT 0;"); } catch (e) { }
    try { db.exec("ALTER TABLE characters ADD COLUMN city_status_until_at INTEGER DEFAULT 0;"); } catch (e) { }
    try { db.exec("ALTER TABLE characters ADD COLUMN city_medical_last_recovery_at INTEGER DEFAULT 0;"); } catch (e) { }

    // ═══════════════════════════════════════════════════════════════════════
    //  2. City Action Logs
    // ═══════════════════════════════════════════════════════════════════════
    db.exec(`
        CREATE TABLE IF NOT EXISTS city_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            action_type TEXT NOT NULL,
            content TEXT NOT NULL,
            delta_calories INTEGER DEFAULT 0,
            delta_money REAL DEFAULT 0,
            location TEXT DEFAULT '',
            timestamp INTEGER NOT NULL
        );
    `);
    try { db.exec("ALTER TABLE city_quests ADD COLUMN target_district TEXT DEFAULT 'street';"); } catch (e) { }
    try { db.exec("ALTER TABLE city_quests ADD COLUMN source_announcement_id INTEGER DEFAULT 0;"); } catch (e) { }
    try { db.exec("ALTER TABLE city_quests ADD COLUMN quest_type TEXT DEFAULT 'errand';"); } catch (e) { }
    try { db.exec("ALTER TABLE city_quests ADD COLUMN completion_target INTEGER DEFAULT 2;"); } catch (e) { }
    try { db.exec("ALTER TABLE city_quests ADD COLUMN status TEXT DEFAULT 'open';"); } catch (e) { }
    try { db.exec("ALTER TABLE city_quests ADD COLUMN completed_by TEXT DEFAULT '';"); } catch (e) { }
    db.exec(`
        CREATE TABLE IF NOT EXISTS city_quest_claims (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            quest_id INTEGER NOT NULL,
            character_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'accepted',
            progress_count INTEGER DEFAULT 0,
            resolution_note TEXT DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(quest_id, character_id)
        );
    `);
    try { db.exec("ALTER TABLE city_logs ADD COLUMN location TEXT DEFAULT '';"); } catch (e) { }

    db.exec(`
        CREATE TABLE IF NOT EXISTS city_announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_type TEXT NOT NULL DEFAULT 'system',
            title TEXT DEFAULT '',
            content TEXT NOT NULL,
            location TEXT DEFAULT 'street',
            timestamp INTEGER NOT NULL
        );
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS city_action_guard (
            character_id TEXT NOT NULL,
            minute_key TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (character_id, minute_key)
        );
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS city_social_guard (
            encounter_key TEXT PRIMARY KEY,
            minute_key TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
    `);

    // ═══════════════════════════════════════════════════════════════════════
    //  3. City Districts
    // ═══════════════════════════════════════════════════════════════════════
    db.exec(`
        CREATE TABLE IF NOT EXISTS city_districts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            emoji TEXT DEFAULT '🏠',
            type TEXT NOT NULL DEFAULT 'generic',
            description TEXT DEFAULT '',
            action_label TEXT DEFAULT 'Visit',
            cal_cost INTEGER DEFAULT 0,
            cal_reward INTEGER DEFAULT 0,
            money_cost REAL DEFAULT 0,
            money_reward REAL DEFAULT 0,
            duration_ticks INTEGER DEFAULT 1,
            capacity INTEGER DEFAULT 0,
            is_enabled INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0
        );
    `);

    // ═══════════════════════════════════════════════════════════════════════
    //  4. City Config
    // ═══════════════════════════════════════════════════════════════════════
    db.exec(`
        CREATE TABLE IF NOT EXISTS city_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);


    // ═══════════════════════════════════════════════════════════════════════
    //  5. ★ NEW: Item Catalog (商品大全)
    // ═══════════════════════════════════════════════════════════════════════
    db.exec(`
        CREATE TABLE IF NOT EXISTS city_items (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            emoji TEXT DEFAULT '📦',
            category TEXT NOT NULL DEFAULT 'food',
            description TEXT DEFAULT '',
            buy_price REAL DEFAULT 10,
            sell_price REAL DEFAULT 0,
            cal_restore INTEGER DEFAULT 0,
            effect TEXT DEFAULT '',
            sold_at TEXT DEFAULT '',
            is_available INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            stock INTEGER DEFAULT -1
        );
    `);

    // ═══════════════════════════════════════════════════════════════════════
    //  6. ★ NEW: Character Inventory / Backpack (角色背包)
    // ═══════════════════════════════════════════════════════════════════════
    db.exec(`
        CREATE TABLE IF NOT EXISTS city_inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            quantity INTEGER DEFAULT 1,
            acquired_at INTEGER NOT NULL,
            FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
            FOREIGN KEY (item_id) REFERENCES city_items(id) ON DELETE CASCADE,
            UNIQUE(character_id, item_id)
        );
    `);

    // ═══════════════════════════════════════════════════════════════════════
    //  7. Character Daily Schedule (角色日程表)
    // ═══════════════════════════════════════════════════════════════════════
    db.exec(`
        CREATE TABLE IF NOT EXISTS city_schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            plan_date TEXT NOT NULL,
            schedule_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
            UNIQUE(character_id, plan_date)
        );
    `);

    // ═══════════════════════════════════════════════════════════════════════
    //  8. ★ City Events (城市事件 — 天气/经济/随机事件)
    // ═══════════════════════════════════════════════════════════════════════
    db.exec(`
        CREATE TABLE IF NOT EXISTS city_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL DEFAULT 'weather',
            title TEXT NOT NULL,
            emoji TEXT DEFAULT '📢',
            description TEXT DEFAULT '',
            effect_json TEXT DEFAULT '{}',
            target_district TEXT DEFAULT '',
            duration_hours INTEGER DEFAULT 24,
            is_active INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
    `);

    // ═══════════════════════════════════════════════════════════════════════
    //  9. ★ City Quests / Bounty Board (悬赏任务)
    // ═══════════════════════════════════════════════════════════════════════
    db.exec(`
        CREATE TABLE IF NOT EXISTS city_quests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            emoji TEXT DEFAULT '📜',
            description TEXT DEFAULT '',
            reward_gold REAL DEFAULT 50,
            reward_cal INTEGER DEFAULT 0,
            reward_item_id TEXT DEFAULT '',
            difficulty TEXT DEFAULT 'normal',
            claimed_by TEXT DEFAULT '',
            target_district TEXT DEFAULT 'street',
            source_announcement_id INTEGER DEFAULT 0,
            quest_type TEXT DEFAULT 'errand',
            completion_target INTEGER DEFAULT 2,
            status TEXT DEFAULT 'open',
            completed_by TEXT DEFAULT '',
            is_completed INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
    `);

    // ═══════════════════════════════════════════════════════════════════════
    //  SEED: Default Districts, Items, and Config
    // ═══════════════════════════════════════════════════════════════════════
    function seedDefaults(dbInstance) {
        const districtCount = dbInstance.prepare('SELECT COUNT(*) as c FROM city_districts').get().c;
        if (districtCount === 0) {
            const defaults = [
                { id: 'factory', name: '工厂', emoji: '🏭', type: 'work', desc: '辛苦搬砖赚金币', action: '打工', calCost: 300, calReward: 0, moneyCost: 0, moneyReward: 20, dur: 2, sort: 1 },
                { id: 'restaurant', name: '餐厅', emoji: '🍜', type: 'food', desc: '吃一顿热饭', action: '就餐', calCost: 0, calReward: 1000, moneyCost: 15, moneyReward: 0, dur: 1, sort: 2 },
                { id: 'convenience', name: '便利店', emoji: '🏪', type: 'food', desc: '买点速食和饮料', action: '购物', calCost: 0, calReward: 0, moneyCost: 5, moneyReward: 0, dur: 1, sort: 3 },
                { id: 'park', name: '中央公园', emoji: '🌳', type: 'leisure', desc: '散步放松心情', action: '散步', calCost: 50, calReward: 0, moneyCost: 0, moneyReward: 0, dur: 1, sort: 4 },
                { id: 'mall', name: '商场', emoji: '🛍️', type: 'shopping', desc: '逛街买东西', action: '逛街', calCost: 100, calReward: 0, moneyCost: 30, moneyReward: 0, dur: 1, sort: 5 },
                { id: 'school', name: '夜校', emoji: '📚', type: 'education', desc: '上课提升技能', action: '上课', calCost: 200, calReward: 0, moneyCost: 10, moneyReward: 0, dur: 2, sort: 6 },
                { id: 'hospital', name: '医院', emoji: '🏥', type: 'medical', desc: '治疗疾病或抢救', action: '治疗', calCost: 0, calReward: 1500, moneyCost: 50, moneyReward: 0, dur: 1, sort: 7 },
                { id: 'home', name: '家', emoji: '🏠', type: 'rest', desc: '睡觉休息恢复精力', action: '休息', calCost: 100, calReward: 0, moneyCost: 0, moneyReward: 0, dur: 2, sort: 8 },
                { id: 'street', name: '商业街', emoji: '🚶', type: 'wander', desc: '闲逛看看有什么新鲜事', action: '闲逛', calCost: 150, calReward: 0, moneyCost: 0, moneyReward: 0, dur: 1, sort: 9 },
                { id: 'casino', name: '地下赌场', emoji: '🎰', type: 'gambling', desc: '赌一把试试运气', action: '赌博', calCost: 50, calReward: 0, moneyCost: 20, moneyReward: 0, dur: 1, sort: 10 },
            ];
            const stmt = dbInstance.prepare(`
                INSERT INTO city_districts (id, name, emoji, type, description, action_label, cal_cost, cal_reward, money_cost, money_reward, duration_ticks, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const d of defaults) {
                stmt.run(d.id, d.name, d.emoji, d.type, d.desc, d.action, d.calCost, d.calReward, d.moneyCost, d.moneyReward, d.dur, d.sort);
            }
            console.log('[City DB] 已初始化默认分区');
        }

        const itemCount = dbInstance.prepare('SELECT COUNT(*) as c FROM city_items').get().c;
        if (itemCount === 0) {
            const items = [
                // Food items (便利店)
                { id: 'rice_ball', name: '饭团', emoji: '🍙', cat: 'food', desc: '简单的一餐', price: 5, cal: 400, soldAt: 'convenience' },
                { id: 'instant_noodle', name: '泡面', emoji: '🍜', cat: 'food', desc: '便宜又管饱', price: 3, cal: 300, soldAt: 'convenience' },
                { id: 'cola', name: '可乐', emoji: '🥤', cat: 'food', desc: '冰凉爽快', price: 2, cal: 100, soldAt: 'convenience' },
                { id: 'bread', name: '面包', emoji: '🍞', cat: 'food', desc: '百搭主食', price: 4, cal: 350, soldAt: 'convenience' },
                { id: 'energy_bar', name: '能量棒', emoji: '⚡', cat: 'food', desc: '快速补充体力', price: 8, cal: 600, soldAt: 'convenience' },
                // Restaurant items
                { id: 'hot_pot', name: '火锅', emoji: '🫕', cat: 'food', desc: '热气腾腾的火锅', price: 25, cal: 1200, soldAt: 'restaurant' },
                { id: 'steak', name: '牛排', emoji: '🥩', cat: 'food', desc: '高级西餐', price: 40, cal: 1000, soldAt: 'restaurant' },
                { id: 'ramen', name: '拉面', emoji: '🍜', cat: 'food', desc: '一碗暖心拉面', price: 15, cal: 800, soldAt: 'restaurant' },
                // Gift items (商场)
                { id: 'flower', name: '鲜花', emoji: '💐', cat: 'gift', desc: '送人好感度+', price: 20, cal: 0, soldAt: 'mall' },
                { id: 'perfume', name: '香水', emoji: '🧴', cat: 'gift', desc: '高级社交礼物', price: 50, cal: 0, soldAt: 'mall' },
                { id: 'teddy_bear', name: '玩偶熊', emoji: '🧸', cat: 'gift', desc: '超可爱的礼物', price: 35, cal: 0, soldAt: 'mall' },
                // Medicine (医院)
                { id: 'bandage', name: '绷带', emoji: '🩹', cat: 'medicine', desc: '基础急救', price: 10, cal: 200, soldAt: 'hospital' },
                { id: 'medicine', name: '特效药', emoji: '💊', cat: 'medicine', desc: '快速恢复', price: 30, cal: 800, soldAt: 'hospital' },
                // Misc
                { id: 'book', name: '教科书', emoji: '📖', cat: 'tool', desc: '学习加速', price: 15, cal: 0, soldAt: 'school' },
                { id: 'lottery', name: '彩票', emoji: '🎫', cat: 'misc', desc: '试试你的运气', price: 5, cal: 0, soldAt: 'casino' },
            ];
            const stmt = dbInstance.prepare(`
                INSERT INTO city_items (id, name, emoji, category, description, buy_price, cal_restore, sold_at, sort_order, stock)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            items.forEach((it, i) => {
                stmt.run(it.id, it.name, it.emoji, it.cat, it.desc, it.price, it.cal, it.soldAt, i + 1, it.stock ?? 10);
            });
            console.log('[City DB] 已初始化默认商品 (' + items.length + ' 件)');
        }

        const configDefaults = [
            ['dlc_enabled', '0'],
            ['city_actions_paused', '0'],
            ['metabolism_rate', '20'],
            ['inflation', '1.0'],
            ['work_bonus', '1.0'],
            ['gambling_win_rate', '0.35'],
            ['gambling_payout', '3.0'],
            ['city_self_log_limit', '5'],          // X: Own log limit
            ['city_social_log_limit', '3'],        // Y: Familiar log limit
            ['city_announcement_limit', '5'],      // A: Public announcement limit
            ['city_global_log_limit', '5'],        // Shared city/world log limit
            ['city_stranger_meet_prob', '20'],     // Z: Stranger encounter probability (%)
            ['mayor_enabled', '0'],
            ['mayor_interval_hours', '6'],
            ['mayor_model_char_id', 'auto'],
            ['mayor_last_run_at', '0'],
            ['mayor_custom_endpoint', ''],
            ['mayor_custom_key', ''],
            ['mayor_custom_model', ''],
            ['city_chat_probability', '0'],
            ['city_moment_probability', '30'],
            ['city_diary_probability', '100'],
            ['mayor_prompt', `你是这座城市的"市长AI"（The Mayor），拥有上帝视角，负责管理整座城市的经济、天气、突发事件和悬赏任务。\n\n你必须根据以下实时数据来做出决策：\n1. 查看昨天的商品销量和库存，决定今天的物价涨跌\n2. 随机生成1-3个城市事件（天气变化、限时活动、突发事故等）\n3. 在布告栏发布1-2个悬赏任务供市民接单\n\n请严格按照以下JSON格式回复，不要添加任何其他文字：\n{\n  "price_changes": [{"item_id": "bread", "new_price": 5, "reason": "供不应求"}],\n  "events": [{"type": "weather|economy|random|disaster", "title": "事件标题", "emoji": "🌧️", "description": "具体描述", "effect": {"district": "park", "cal_bonus": -50, "money_bonus": 0}, "duration_hours": 12}],\n  "quests": [{"title": "任务名", "emoji": "📜", "description": "任务描述", "reward_gold": 50, "reward_cal": 0, "difficulty": "easy|normal|hard"}],\n  "announcement": "今日城市广播内容（一句话）"\n}`]
        ];

        const checkCfgStmt = dbInstance.prepare("SELECT COUNT(*) as c FROM city_config WHERE key = ?");
        const insertCfgStmt = dbInstance.prepare("INSERT INTO city_config (key, value) VALUES (?, ?)");

        for (const [k, v] of configDefaults) {
            if (checkCfgStmt.get(k).c === 0) {
                insertCfgStmt.run(k, v);
            }
        }

    }

    // Migration: add stock to city_items for existing users
    try { db.prepare("ALTER TABLE city_items ADD COLUMN stock INTEGER DEFAULT -1").run(); } catch (e) { }

    // Migration: delete deprecated clock settings that pollute the UI
    try { db.prepare("DELETE FROM city_config WHERE key IN ('tick_label', 'tick_interval_minutes')").run(); } catch (e) { }

    console.log('[City DB] 已添加并清理过时配置');

    // Call seedDefaults on boot
    seedDefaults(db);

    // Migration: city-to-chat integration config (probability sliders)
    const hasChatProb = db.prepare("SELECT value FROM city_config WHERE key = 'city_chat_probability'").get();
    if (!hasChatProb) {
        db.prepare("INSERT INTO city_config (key, value) VALUES ('city_chat_probability', '0')").run();
        db.prepare("INSERT INTO city_config (key, value) VALUES ('city_moment_probability', '30')").run();
        db.prepare("INSERT INTO city_config (key, value) VALUES ('city_diary_probability', '100')").run();
        console.log('[City DB] 已添加城市-聊天桥接概率配置');
    }
    // Migration: ensure diary probability key exists
    const hasDiaryProb = db.prepare("SELECT value FROM city_config WHERE key = 'city_diary_probability'").get();
    if (!hasDiaryProb) {
        db.prepare("INSERT INTO city_config (key, value) VALUES ('city_diary_probability', '100')").run();
        console.log('[City DB] 已添加日记/记忆概率配置');
    }

    try { db.prepare("DELETE FROM city_config WHERE key = 'city_memory_probability'").run(); } catch (e) { }

    // Migration: rename old English district names to Chinese
    const districtNameMap = {
        'factory': { name: '工厂', desc: '辛苦搬砖赚金币', action: '打工' },
        'restaurant': { name: '餐厅', desc: '吃一顿热饭', action: '就餐' },
        'convenience': { name: '便利店', desc: '买点速食和饮料', action: '购物' },
        'park': { name: '中央公园', desc: '散步放松心情', action: '散步' },
        'mall': { name: '商场', desc: '逛街买东西', action: '逛街' },
        'school': { name: '夜校', desc: '上课提升技能', action: '上课' },
        'hospital': { name: '医院', desc: '治疗疾病或抢救', action: '治疗' },
        'home': { name: '家', desc: '睡觉休息恢复精力', action: '休息' },
        'street': { name: '商业街', desc: '闲逛看看有什么新鲜事', action: '闲逛' },
        'casino': { name: '地下赌场', desc: '赌一把试试运气', action: '赌博' },
    };
    const updateNameStmt = db.prepare('UPDATE city_districts SET name = ?, description = ?, action_label = ? WHERE id = ? AND name NOT LIKE ?');
    for (const [id, cn] of Object.entries(districtNameMap)) {
        // only update if name is NOT already Chinese (contains no CJK characters)
        updateNameStmt.run(cn.name, cn.desc, cn.action, id, '%' + cn.name + '%');
    }

    console.log('[City DB] Schema verified and updated.');

    // ═══════════════════════════════════════════════════════════════════════
    //  HELPER FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════

    // --- Logs ---
    const STRUCTURED_CITY_LOG_ACTIONS = new Set([
        'GIFT',
        'FED',
        'GIVE_ITEM',
        'MAYOR',
        'EVENT',
        'QUEST',
        'ANNOUNCE',
        'TIMESKIP',
        'BUY',
        'EAT',
        'STARVE',
        'BROKE'
    ]);

    function stripTrailingClosers(text) {
        return String(text || '').trim().replace(/[\s"'”’」』）)\]}\.~]+$/u, '');
    }

    function endsWithEmojiLike(text) {
        const stripped = stripTrailingClosers(text);
        if (!stripped) return false;
        return /[\p{Extended_Pictographic}\p{Emoji_Presentation}]$/u.test(stripped);
    }

    function hasNaturalSentenceEnding(text) {
        const normalized = String(text || '').trim();
        if (!normalized) return false;
        return /[。？！!?…][\s"'”’」』）)\]}\.~]*$/u.test(normalized) || endsWithEmojiLike(normalized);
    }

    function shouldDetectTruncation(log) {
        const actionType = String(log?.action_type || '').trim().toUpperCase();
        const content = String(log?.content || '').trim();
        if (!content) return false;
        if (/\[系统提示\]|系统提示|系统广播|城市广播/u.test(content)) return false;
        if (STRUCTURED_CITY_LOG_ACTIONS.has(actionType)) return false;
        return true;
    }

    function decorateCityLogForUser(log) {
        const originalContent = String(log?.content || '').trim();
        const isTruncated = shouldDetectTruncation(log) && !hasNaturalSentenceEnding(originalContent);
        return {
            ...log,
            is_truncated: isTruncated,
            truncated_original_content: isTruncated ? originalContent : null,
        };
    }

    function isVisibleCityLogForCharacter(log) {
        const content = String(log?.content || '').trim();
        if (!content) return false;
        if (!shouldDetectTruncation(log)) return true;
        return hasNaturalSentenceEnding(content);
    }

    function logAction(charId, actionType, content, dCal = 0, dMoney = 0, loc = '') {
        const now = Date.now();
        const normalizedContent = String(content || '').replace(/\s+/g, ' ').trim();
        if (charId && normalizedContent) {
            const recent = db.prepare(`
                SELECT id, action_type, location, content, timestamp
                FROM city_logs
                WHERE character_id = ?
                ORDER BY timestamp DESC
                LIMIT 1
            `).get(charId);
            if (recent) {
                const recentContent = String(recent.content || '').replace(/\s+/g, ' ').trim();
                const withinShortWindow = Math.abs(now - Number(recent.timestamp || 0)) <= 5 * 60 * 1000;
                const sameContent = recentContent === normalizedContent;
                const sameLocation = String(recent.location || '') === String(loc || '');
                if (withinShortWindow && sameContent && sameLocation) {
                    return;
                }
            }
        }

        db.prepare(`
            INSERT INTO city_logs (character_id, action_type, content, delta_calories, delta_money, location, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(charId, actionType, content, dCal, dMoney, loc, now);
    }

    function getCityLogs(arg1 = 100, arg2 = null) {
        const hasCharacterFilter = typeof arg1 === 'string';
        const characterId = hasCharacterFilter ? arg1 : null;
        const limitInput = hasCharacterFilter ? arg2 : arg1;
        const limit = Number.isFinite(Number(limitInput)) ? Math.max(1, Number(limitInput)) : 100;
        const rows = hasCharacterFilter
            ? db.prepare(`
                SELECT c.name as char_name, c.avatar as char_avatar, l.* 
                FROM city_logs l 
                LEFT JOIN characters c ON l.character_id = c.id
                WHERE l.character_id = ?
                ORDER BY l.timestamp DESC 
                LIMIT ?
            `).all(characterId, limit)
            : db.prepare(`
                SELECT c.name as char_name, c.avatar as char_avatar, l.* 
                FROM city_logs l 
                LEFT JOIN characters c ON l.character_id = c.id
                ORDER BY l.timestamp DESC 
                LIMIT ?
            `).all(limit);
        return rows.map(decorateCityLogForUser);
    }

    function addCityAnnouncement(sourceType = 'system', title = '', content = '', location = 'street') {
        const normalizedContent = String(content || '').replace(/\s+/g, ' ').trim();
        if (!normalizedContent) return null;
        const normalizedTitle = String(title || '').replace(/\s+/g, ' ').trim();
        const normalizedLocation = String(location || 'street').trim() || 'street';
        const now = Date.now();
        const recent = db.prepare(`
            SELECT id, source_type, title, content, location, timestamp
            FROM city_announcements
            ORDER BY timestamp DESC
            LIMIT 1
        `).get();
        if (recent) {
            const withinShortWindow = Math.abs(now - Number(recent.timestamp || 0)) <= 5 * 60 * 1000;
            const sameContent = String(recent.content || '').trim() === normalizedContent;
            const sameTitle = String(recent.title || '').trim() === normalizedTitle;
            const sameSource = String(recent.source_type || '').trim() === String(sourceType || 'system').trim();
            if (withinShortWindow && sameContent && sameTitle && sameSource) {
                return recent.id;
            }
        }

        const result = db.prepare(`
            INSERT INTO city_announcements (source_type, title, content, location, timestamp)
            VALUES (?, ?, ?, ?, ?)
        `).run(String(sourceType || 'system').trim() || 'system', normalizedTitle, normalizedContent, normalizedLocation, now);
        return result.lastInsertRowid;
    }

    function deleteCityAnnouncement(id) {
        return db.prepare('DELETE FROM city_announcements WHERE id = ?').run(id).changes > 0;
    }

    function getCityAnnouncements(limit = 20) {
        const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 20;
        const rows = db.prepare(`
            SELECT id, source_type, title, content, location, timestamp
            FROM city_announcements
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(safeLimit * 2);

        const fallbackRows = db.prepare(`
            SELECT
                id,
                CASE
                    WHEN action_type = 'MAYOR' THEN 'mayor'
                    WHEN action_type = 'ANNOUNCE' AND (
                        content LIKE '%市长%' OR
                        content LIKE '%城市广播%' OR
                        content LIKE '%市民们注意%'
                    ) THEN 'mayor'
                    WHEN action_type = 'ANNOUNCE' AND (
                        content LIKE '%中介所广告%' OR
                        content LIKE '%安家置业%' OR
                        content LIKE '%安居顾问%'
                    ) THEN 'agency'
                    ELSE 'system'
                END AS source_type,
                '' AS title,
                content,
                location,
                timestamp
            FROM city_logs
            WHERE action_type IN ('ANNOUNCE', 'MAYOR', 'EVENT')
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(safeLimit * 2);

        const merged = [...rows, ...fallbackRows]
            .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
            .filter((item, index, list) => {
                const key = `${String(item.source_type || '')}|${String(item.title || '')}|${String(item.content || '')}`;
                return list.findIndex((other) => `${String(other.source_type || '')}|${String(other.title || '')}|${String(other.content || '')}` === key) === index;
            })
            .slice(0, safeLimit);

        return merged;
    }

    // Get recent city logs for a specific character, regardless of day.
    // This is used as the character's own commercial-street memory window.
    function getCharacterRecentLogs(charId, limit = 5) {
        return db.prepare(`
            SELECT content as message, action_type, timestamp, location 
            FROM city_logs 
            WHERE character_id = ?
            ORDER BY timestamp DESC 
            LIMIT ?
        `)
            .all(charId, limit * 3)
            .filter(isVisibleCityLogForCharacter)
            .slice(0, limit)
            .map(log => ({
                ...log,
                message: String(log.message || '').trim()
            }));
    }

    // Get recent city logs for someone else at a specific location
    function getOtherCharacterLocationTodayLogs(otherCharId, locId, limit = 3) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        return db.prepare(`
            SELECT content as message, timestamp 
            FROM city_logs 
            WHERE character_id = ? AND timestamp >= ? AND location = ?
            ORDER BY timestamp DESC 
            LIMIT ?
        `)
            .all(otherCharId, startOfDay.getTime(), locId, limit * 3)
            .filter(isVisibleCityLogForCharacter)
            .slice(0, limit)
            .map(log => ({
                ...log,
                message: String(log.message || '').trim()
            }));
    }

    function clearAllLogs() {
        db.prepare('DELETE FROM city_logs').run();
        // Reset sqlite autoincrement for city_logs if needed
        try { db.prepare("DELETE FROM sqlite_sequence WHERE name='city_logs'").run(); } catch (e) { }
    }
    function clearCharacterCityData(charId) {
        db.prepare('DELETE FROM city_logs WHERE character_id = ?').run(charId);
        db.prepare('DELETE FROM city_inventory WHERE character_id = ?').run(charId);
        db.prepare('DELETE FROM city_schedules WHERE character_id = ?').run(charId);
        db.prepare('DELETE FROM city_action_guard WHERE character_id = ?').run(charId);
        db.prepare("UPDATE city_quests SET claimed_by = '' WHERE claimed_by = ?").run(charId);
    }

    function claimActionSlot(charId, minuteKey) {
        const info = db.prepare(`
            INSERT OR IGNORE INTO city_action_guard (character_id, minute_key, created_at)
            VALUES (?, ?, ?)
        `).run(charId, minuteKey, Date.now());
        return (info?.changes || 0) > 0;
    }

    function clearExpiredActionGuards(beforeTs) {
        return db.prepare('DELETE FROM city_action_guard WHERE created_at < ?').run(beforeTs).changes;
    }

    function claimSocialEncounter(encounterKey, minuteKey, expiresAt) {
        const now = Date.now();
        const tx = db.transaction(() => {
            db.prepare('DELETE FROM city_social_guard WHERE encounter_key = ? AND expires_at < ?').run(encounterKey, now);
            const info = db.prepare(`
                INSERT OR IGNORE INTO city_social_guard (encounter_key, minute_key, created_at, expires_at)
                VALUES (?, ?, ?, ?)
            `).run(encounterKey, minuteKey, now, expiresAt);
            return (info?.changes || 0) > 0;
        });
        return tx();
    }

    function clearExpiredSocialGuards(beforeTs) {
        return db.prepare('DELETE FROM city_social_guard WHERE expires_at < ?').run(beforeTs).changes;
    }

    function wipeAllData() {
        const tables = [
            'city_logs', 'city_districts', 'city_items', 'city_inventory',
            'city_schedules', 'city_events', 'city_quests', 'city_quest_claims', 'city_config'
        ];
        const runStmt = db.prepare('BEGIN TRANSACTION');
        runStmt.run();
        try {
            for (const table of tables) {
                db.prepare(`DELETE FROM ${table}`).run();
                try { db.prepare(`DELETE FROM sqlite_sequence WHERE name='${table}'`).run(); } catch (e) { }
            }

            // Reset character physical states back to default (for all active characters)
            db.prepare(`UPDATE characters SET calories=2000, wallet=200, city_status='idle', location='home', education='none'`).run();
            db.prepare('COMMIT').run();
            // Re-seed defaults after wipe
            seedDefaults(db);
        } catch (e) {
            db.prepare('ROLLBACK').run();
            throw e;
        }
    }

    // --- Districts ---
    function getDistricts() {
        return db.prepare('SELECT * FROM city_districts ORDER BY sort_order ASC').all();
    }
    function getDistrict(id) {
        return db.prepare('SELECT * FROM city_districts WHERE id = ?').get(id);
    }
    function getEnabledDistricts() {
        return db.prepare('SELECT * FROM city_districts WHERE is_enabled = 1 ORDER BY sort_order ASC').all();
    }
    function upsertDistrict(data) {
        const existing = getDistrict(data.id);
        if (existing) {
            db.prepare(`UPDATE city_districts SET 
                name=?, emoji=?, type=?, description=?, action_label=?,
                cal_cost=?, cal_reward=?, money_cost=?, money_reward=?,
                duration_ticks=?, capacity=?, is_enabled=?, sort_order=?
                WHERE id=?`).run(
                data.name, data.emoji, data.type, data.description, data.action_label,
                data.cal_cost, data.cal_reward, data.money_cost, data.money_reward,
                data.duration_ticks, data.capacity ?? 0, data.is_enabled ?? 1, data.sort_order ?? 0,
                data.id
            );
        } else {
            db.prepare(`INSERT INTO city_districts 
                (id, name, emoji, type, description, action_label, cal_cost, cal_reward, money_cost, money_reward, duration_ticks, capacity, is_enabled, sort_order)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
                data.id, data.name, data.emoji, data.type, data.description, data.action_label,
                data.cal_cost, data.cal_reward, data.money_cost, data.money_reward,
                data.duration_ticks, data.capacity ?? 0, data.is_enabled ?? 1, data.sort_order ?? 0
            );
        }
    }
    function deleteDistrict(id) {
        db.prepare('DELETE FROM city_districts WHERE id = ?').run(id);
    }

    // --- Config ---
    function getConfig() {
        const rows = db.prepare('SELECT * FROM city_config').all();
        const cfg = {};
        for (const r of rows) cfg[r.key] = r.value;
        return cfg;
    }
    function setConfig(key, value) {
        db.prepare('INSERT OR REPLACE INTO city_config (key, value) VALUES (?, ?)').run(key, String(value));
    }

    // --- Economy Stats ---
    function getEconomyStats() {
        const totalGold = db.prepare('SELECT SUM(wallet) as total FROM characters WHERE status = ?').get('active');
        const totalCals = db.prepare('SELECT SUM(calories) as total, AVG(calories) as avg FROM characters WHERE status = ?').get('active');
        const recentLogs = db.prepare('SELECT action_type, COUNT(*) as count FROM city_logs WHERE timestamp > ? GROUP BY action_type').all(Date.now() - 3600000);
        return {
            total_gold_in_circulation: totalGold?.total || 0,
            total_calories: totalCals?.total || 0,
            avg_calories: Math.round(totalCals?.avg || 0),
            actions_last_hour: recentLogs
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ★ NEW: Item & Inventory Helpers
    // ═══════════════════════════════════════════════════════════════════════

    function getItems() {
        return db.prepare('SELECT * FROM city_items ORDER BY sort_order ASC').all();
    }
    function getItem(id) {
        return db.prepare('SELECT * FROM city_items WHERE id = ?').get(id);
    }
    function getItemsAtDistrict(districtId) {
        return db.prepare("SELECT * FROM city_items WHERE sold_at = ? AND is_available = 1 ORDER BY sort_order").all(districtId);
    }
    function upsertItem(data) {
        db.prepare(`INSERT OR REPLACE INTO city_items 
            (id, name, emoji, category, description, buy_price, sell_price, cal_restore, effect, sold_at, is_available, sort_order, stock)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            data.id, data.name, data.emoji || '📦', data.category || 'food', data.description || '',
            data.buy_price ?? 10, data.sell_price ?? 0, data.cal_restore ?? 0,
            data.effect || '', data.sold_at || '', data.is_available ?? 1, data.sort_order ?? 0, data.stock ?? -1
        );
    }
    function deleteItem(id) {
        db.prepare('DELETE FROM city_items WHERE id = ?').run(id);
        db.prepare('DELETE FROM city_inventory WHERE item_id = ?').run(id);
    }
    function decreaseItemStock(id, amount = 1) {
        db.prepare('UPDATE city_items SET stock = stock - ? WHERE id = ? AND stock > 0').run(amount, id);
    }

    // --- Inventory (背包) ---
    function getInventory(charId) {
        return db.prepare(`
            SELECT inv.*, it.name, it.emoji, it.category, it.cal_restore, it.buy_price, it.description as item_desc
            FROM city_inventory inv
            JOIN city_items it ON inv.item_id = it.id
            WHERE inv.character_id = ?
            ORDER BY inv.acquired_at DESC
        `).all(charId);
    }
    function addToInventory(charId, itemId, qty = 1) {
        const existing = db.prepare('SELECT * FROM city_inventory WHERE character_id = ? AND item_id = ?').get(charId, itemId);
        if (existing) {
            db.prepare('UPDATE city_inventory SET quantity = quantity + ? WHERE id = ?').run(qty, existing.id);
        } else {
            db.prepare('INSERT INTO city_inventory (character_id, item_id, quantity, acquired_at) VALUES (?, ?, ?, ?)').run(charId, itemId, qty, Date.now());
        }
    }
    function removeFromInventory(charId, itemId, qty = 1) {
        const existing = db.prepare('SELECT * FROM city_inventory WHERE character_id = ? AND item_id = ?').get(charId, itemId);
        if (!existing) return false;
        if (existing.quantity <= qty) {
            db.prepare('DELETE FROM city_inventory WHERE id = ?').run(existing.id);
        } else {
            db.prepare('UPDATE city_inventory SET quantity = quantity - ? WHERE id = ?').run(qty, existing.id);
        }
        return true;
    }
    function getInventoryFoodItems(charId) {
        return db.prepare(`
            SELECT inv.*, it.name, it.emoji, it.cal_restore
            FROM city_inventory inv
            JOIN city_items it ON inv.item_id = it.id
            WHERE inv.character_id = ? AND it.cal_restore > 0 AND inv.quantity > 0
            ORDER BY it.cal_restore DESC
        `).all(charId);
    }

    // --- Schedules (日程) ---
    function getSchedule(charId, date) {
        return db.prepare('SELECT * FROM city_schedules WHERE character_id = ? AND plan_date = ?').get(charId, date);
    }
    function claimScheduleGeneration(charId, date) {
        const info = db.prepare(`INSERT OR IGNORE INTO city_schedules (character_id, plan_date, schedule_json, created_at)
            VALUES (?, ?, ?, ?)`).run(charId, date, JSON.stringify([]), Date.now());
        return info.changes > 0;
    }
    function releaseScheduleGeneration(charId, date) {
        db.prepare(`DELETE FROM city_schedules
            WHERE character_id = ? AND plan_date = ? AND schedule_json = ?`).run(charId, date, JSON.stringify([]));
    }
    function saveSchedule(charId, date, scheduleJson) {
        const payload = JSON.stringify(scheduleJson);
        const update = db.prepare(`UPDATE city_schedules
            SET schedule_json = ?, created_at = ?
            WHERE character_id = ? AND plan_date = ?`).run(payload, Date.now(), charId, date);
        if (update.changes === 0) {
            db.prepare(`INSERT OR REPLACE INTO city_schedules (character_id, plan_date, schedule_json, created_at)
                VALUES (?, ?, ?, ?)`).run(charId, date, payload, Date.now());
        }
    }
    function getTodaySchedule(charId) {
        const today = new Date().toISOString().split('T')[0];
        return getSchedule(charId, today);
    }

    function getActiveEvents() {
        return db.prepare('SELECT * FROM city_events WHERE is_active = 1 AND expires_at > ? ORDER BY created_at DESC').all(Date.now());
    }
    function getAllEvents(limit = 50) {
        return db.prepare('SELECT * FROM city_events ORDER BY created_at DESC LIMIT ?').all(limit);
    }
    function createEvent(data) {
        const now = Date.now();
        const expires = now + (data.duration_hours || 24) * 3600000;
        if ((data.type || 'random') === 'weather') {
            db.prepare('UPDATE city_events SET is_active = 0 WHERE is_active = 1 AND event_type = ?').run('weather');
        }
        db.prepare(`INSERT INTO city_events (event_type, title, emoji, description, effect_json, target_district, duration_hours, is_active, created_at, expires_at)
            VALUES (?,?,?,?,?,?,?,1,?,?)`).run(
            data.type || 'random', data.title, data.emoji || '📢', data.description || '',
            JSON.stringify(data.effect || {}), data.target_district || '', data.duration_hours || 24, now, expires
        );
    }
    function expireEvents() {
        db.prepare('UPDATE city_events SET is_active = 0 WHERE expires_at <= ? AND is_active = 1').run(Date.now());
    }
    function deleteEvent(id) {
        db.prepare('DELETE FROM city_events WHERE id = ?').run(id);
    }

    function getActiveQuests() {
        return db.prepare('SELECT * FROM city_quests WHERE is_completed = 0 AND expires_at > ? ORDER BY created_at DESC').all(Date.now());
    }
    function getAllQuests(limit = 50) {
        return db.prepare('SELECT * FROM city_quests ORDER BY created_at DESC LIMIT ?').all(limit);
    }
    function createQuest(data) {
        const now = Date.now();
        const expires = now + 24 * 3600000;
        db.prepare(`INSERT INTO city_quests (title, emoji, description, reward_gold, reward_cal, reward_item_id, difficulty, created_at, expires_at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(
            data.title, data.emoji || '📜', data.description || '',
            data.reward_gold ?? 50, data.reward_cal ?? 0, data.reward_item_id || '',
            data.difficulty || 'normal', now, expires
        );
    }
    function claimQuest(questId, charId) {
        const info = db.prepare("UPDATE city_quests SET claimed_by = ? WHERE id = ? AND claimed_by = ''").run(charId, questId);
        return info.changes > 0;
    }
    function completeQuest(questId) {
        const info = db.prepare('UPDATE city_quests SET is_completed = 1 WHERE id = ?').run(questId);
        return info.changes > 0;
    }
    function deleteQuest(id) {
        db.prepare('DELETE FROM city_quests WHERE id = ?').run(id);
    }

    function inferQuestTargetDistrict(data = {}) {
        const explicit = String(data.target_district || '').trim();
        if (explicit) return explicit;
        const haystack = `${data.title || ''} ${data.description || ''}`.toLowerCase();
        const districts = getDistricts().slice().sort((a, b) => String(b.name || '').length - String(a.name || '').length);
        for (const district of districts) {
            const id = String(district.id || '').toLowerCase();
            const name = String(district.name || '').toLowerCase();
            if ((id && haystack.includes(id)) || (name && haystack.includes(name))) return district.id;
        }
        return 'street';
    }
    function inferQuestType(data = {}) {
        const explicit = String(data.quest_type || '').trim();
        if (explicit) return explicit;
        const haystack = `${data.title || ''} ${data.description || ''}`.toLowerCase();
        if (/清理|打扫|修缮|抢修|维修|疏通|搬运|救援/.test(haystack)) return 'service';
        if (/采购|买|送|配送|跑腿|运送|领取|交付/.test(haystack)) return 'delivery';
        if (/调查|搜集|查明|寻找|线索|侦查/.test(haystack)) return 'investigation';
        if (/值守|巡逻|护送|护送|看守/.test(haystack)) return 'patrol';
        return 'errand';
    }
    function inferQuestCompletionTarget(type = 'errand', data = {}) {
        const explicit = Number(data.completion_target || 0);
        if (explicit > 0) return explicit;
        switch (String(type || '').toLowerCase()) {
            case 'service':
                return 3;
            case 'investigation':
                return 2;
            case 'patrol':
                return 3;
            case 'delivery':
                return 2;
            default:
                return 2;
        }
    }
    function getQuestById(id) {
        return db.prepare('SELECT * FROM city_quests WHERE id = ?').get(id);
    }
    function getQuestClaims(questId) {
        return db.prepare(`
            SELECT qc.*, c.name AS char_name
            FROM city_quest_claims qc
            LEFT JOIN characters c ON c.id = qc.character_id
            WHERE qc.quest_id = ?
            ORDER BY qc.created_at ASC
        `).all(questId);
    }
    function hydrateQuestRows(rows = []) {
        return rows.map((quest) => {
            const claims = getQuestClaims(quest.id);
            const activeClaims = claims.filter((claim) => !['failed', 'completed'].includes(String(claim.status || '')));
            const completedClaim = claims.find((claim) => String(claim.status || '') === 'completed');
            return {
                ...quest,
                claims,
                claim_count: activeClaims.length,
                claimant_ids: activeClaims.map((claim) => claim.character_id),
                claimant_names: activeClaims.map((claim) => claim.char_name || claim.character_id),
                completed_by_name: completedClaim?.char_name || '',
                claimed_by: quest.claimed_by || activeClaims[0]?.character_id || ''
            };
        });
    }
    function getActiveQuests() {
        const rows = db.prepare(`
            SELECT * FROM city_quests
            WHERE is_completed = 0 AND status != 'completed' AND expires_at > ?
            ORDER BY created_at DESC
        `).all(Date.now());
        return hydrateQuestRows(rows);
    }
    function getAllQuests(limit = 50) {
        const rows = db.prepare('SELECT * FROM city_quests ORDER BY created_at DESC LIMIT ?').all(limit);
        return hydrateQuestRows(rows);
    }
    function createQuest(data) {
        const now = Date.now();
        const expires = data.expires_at ? Number(data.expires_at) : now + 24 * 3600000;
        const targetDistrict = inferQuestTargetDistrict(data);
        const questType = inferQuestType(data);
        const completionTarget = inferQuestCompletionTarget(questType, data);
        const info = db.prepare(`INSERT INTO city_quests (title, emoji, description, reward_gold, reward_cal, reward_item_id, difficulty, claimed_by, target_district, source_announcement_id, quest_type, completion_target, status, completed_by, created_at, expires_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            data.title, data.emoji || '馃摐', data.description || '',
            data.reward_gold ?? 50, data.reward_cal ?? 0, data.reward_item_id || '',
            data.difficulty || 'normal', '', targetDistrict, Number(data.source_announcement_id || 0), questType, completionTarget, data.status || 'open', '',
            now, expires
        );
        return Number(info.lastInsertRowid || 0);
    }
    function attachQuestAnnouncement(questId, announcementId) {
        db.prepare('UPDATE city_quests SET source_announcement_id = ? WHERE id = ?').run(Number(announcementId || 0), questId);
    }
    function getCharacterActiveQuestClaim(charId) {
        return db.prepare(`
            SELECT qc.*, q.title, q.description, q.emoji, q.reward_gold, q.reward_cal, q.target_district, q.status AS quest_status, q.is_completed, q.completed_by, q.source_announcement_id
            FROM city_quest_claims qc
            JOIN city_quests q ON q.id = qc.quest_id
            WHERE qc.character_id = ?
              AND qc.status IN ('accepted', 'in_progress', 'ready_to_report', 'reporting')
              AND q.expires_at > ?
            ORDER BY qc.updated_at DESC
            LIMIT 1
        `).get(charId, Date.now()) || null;
    }
    function claimQuest(questId, charId) {
        const quest = getQuestById(questId);
        if (!quest || quest.is_completed || String(quest.status || '') === 'completed' || Number(quest.expires_at || 0) <= Date.now()) {
            return { success: false, reason: 'quest_unavailable' };
        }
        const existing = db.prepare('SELECT * FROM city_quest_claims WHERE quest_id = ? AND character_id = ?').get(questId, charId);
        if (existing) {
            if (['accepted', 'in_progress', 'ready_to_report', 'reporting', 'completed'].includes(String(existing.status || ''))) {
                return { success: true, alreadyClaimed: true, claim: existing };
            }
            db.prepare(`
                UPDATE city_quest_claims
                SET status = 'accepted', progress_count = 0, resolution_note = '', updated_at = ?
                WHERE quest_id = ? AND character_id = ?
            `).run(Date.now(), questId, charId);
        } else {
            db.prepare(`
                INSERT INTO city_quest_claims (quest_id, character_id, status, progress_count, resolution_note, created_at, updated_at)
                VALUES (?, ?, 'accepted', 0, '', ?, ?)
            `).run(questId, charId, Date.now(), Date.now());
        }
        const firstClaim = db.prepare(`
            SELECT character_id FROM city_quest_claims
            WHERE quest_id = ? AND status IN ('accepted', 'in_progress', 'ready_to_report', 'reporting', 'completed')
            ORDER BY created_at ASC
            LIMIT 1
        `).get(questId);
        db.prepare(`UPDATE city_quests
            SET claimed_by = COALESCE(?, claimed_by), status = CASE WHEN status = 'open' THEN 'claimed' ELSE status END
            WHERE id = ?`).run(firstClaim?.character_id || charId, questId);
        return { success: true, quest: getQuestById(questId) };
    }
    function updateQuestClaimStage(questId, charId, nextStage, progressDelta = 0, note = '') {
        const claim = db.prepare('SELECT * FROM city_quest_claims WHERE quest_id = ? AND character_id = ?').get(questId, charId);
        if (!claim) return null;
        const nextProgress = Math.max(0, Number(claim.progress_count || 0) + Number(progressDelta || 0));
        db.prepare(`
            UPDATE city_quest_claims
            SET status = ?, progress_count = ?, resolution_note = ?, updated_at = ?
            WHERE quest_id = ? AND character_id = ?
        `).run(nextStage, nextProgress, note || claim.resolution_note || '', Date.now(), questId, charId);
        return db.prepare('SELECT * FROM city_quest_claims WHERE quest_id = ? AND character_id = ?').get(questId, charId);
    }
    function advanceQuestProgress(questId, charId, increment = 1) {
        const claim = db.prepare('SELECT * FROM city_quest_claims WHERE quest_id = ? AND character_id = ?').get(questId, charId);
        const quest = getQuestById(questId);
        if (!claim) return null;
        const nextProgress = Math.max(0, Number(claim.progress_count || 0) + Number(increment || 0));
        const target = Math.max(1, Number(quest?.completion_target || 2));
        const nextStage = nextProgress >= target ? 'ready_to_report' : 'in_progress';
        db.prepare(`
            UPDATE city_quest_claims
            SET status = ?, progress_count = ?, updated_at = ?
            WHERE quest_id = ? AND character_id = ?
        `).run(nextStage, nextProgress, Date.now(), questId, charId);
        return db.prepare('SELECT * FROM city_quest_claims WHERE quest_id = ? AND character_id = ?').get(questId, charId);
    }
    function resolveQuestCompletion(questId, charId) {
        const quest = getQuestById(questId);
        const claim = db.prepare('SELECT * FROM city_quest_claims WHERE quest_id = ? AND character_id = ?').get(questId, charId);
        if (!quest) return { success: false, reason: 'quest_missing' };
        if (!claim) return { success: false, reason: 'claim_missing' };
        if (quest.is_completed || String(quest.status || '') === 'completed') {
            db.prepare(`
                UPDATE city_quest_claims
                SET status = 'failed', resolution_note = ?, updated_at = ?
                WHERE quest_id = ? AND character_id = ?
            `).run('任务已被其他角色抢先交付。', Date.now(), questId, charId);
            return { success: true, won: false, reason: 'already_completed', quest: getQuestById(questId) };
        }
        db.prepare(`
            UPDATE city_quests
            SET is_completed = 1, status = 'completed', completed_by = ?, claimed_by = ?
            WHERE id = ?
        `).run(charId, charId, questId);
        db.prepare(`
            UPDATE city_quest_claims
            SET status = CASE WHEN character_id = ? THEN 'completed' ELSE 'failed' END,
                resolution_note = CASE WHEN character_id = ? THEN '任务已成功交付。' ELSE '任务已被其他角色抢先交付。' END,
                updated_at = ?
            WHERE quest_id = ? AND status IN ('accepted', 'in_progress', 'ready_to_report', 'reporting')
        `).run(charId, charId, Date.now(), questId);
        return { success: true, won: true, quest: getQuestById(questId), reward_gold: Number(quest.reward_gold || 0), reward_cal: Number(quest.reward_cal || 0) };
    }
    function completeQuest(questId) {
        const info = db.prepare('UPDATE city_quests SET is_completed = 1, status = ? WHERE id = ?').run('completed', questId);
        return info.changes > 0;
    }
    function deleteQuest(id) {
        db.prepare('DELETE FROM city_quest_claims WHERE quest_id = ?').run(id);
        db.prepare('DELETE FROM city_quests WHERE id = ?').run(id);
    }

    // ═══════════════════════════════════════════════════════════════════════
    return {
        logAction, addCityAnnouncement, deleteCityAnnouncement, getCityAnnouncements, getCityLogs, getCharacterRecentLogs, getOtherCharacterLocationTodayLogs, clearAllLogs, wipeAllData,
        clearCharacterCityData,
        claimActionSlot, clearExpiredActionGuards, claimSocialEncounter, clearExpiredSocialGuards,
        getDistricts, getDistrict, getEnabledDistricts, upsertDistrict, deleteDistrict,
        getConfig, setConfig, getEconomyStats,
        getItems, getItem, getItemsAtDistrict, upsertItem, deleteItem, decreaseItemStock,
        getInventory, addToInventory, removeFromInventory, getInventoryFoodItems,
        getSchedule, claimScheduleGeneration, releaseScheduleGeneration, saveSchedule, getTodaySchedule,
        // ★ Events & Quests
        getActiveEvents, getAllEvents, createEvent, expireEvents, deleteEvent,
        getActiveQuests, getAllQuests, createQuest, attachQuestAnnouncement, getQuestById, getQuestClaims, getCharacterActiveQuestClaim, claimQuest, updateQuestClaimStage, advanceQuestProgress, resolveQuestCompletion, completeQuest, deleteQuest,
        db: db // Exposed to allow direct query access to City tables
    };
};
