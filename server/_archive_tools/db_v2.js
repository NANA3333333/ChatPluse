const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const userDbCache = new Map();

function getUserDb(userId) {
    if (!userId) throw new Error("getUserDb requires a valid userId");
    if (userDbCache.has(userId)) return userDbCache.get(userId);

    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = path.join(dataDir, `chatpulse_user_${userId}.db`);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // --- ENCLOSED DB FUNCTIONS ---


    function initDb() {
        db.exec(`
        CREATE TABLE IF NOT EXISTS characters (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            avatar TEXT,
            persona TEXT,
            world_info TEXT,
            api_endpoint TEXT,
            api_key TEXT,
            model_name TEXT,
            memory_api_endpoint TEXT,
            memory_api_key TEXT,
            memory_model_name TEXT,
            interval_min INTEGER DEFAULT 10,
            interval_max INTEGER DEFAULT 120,
            affinity INTEGER DEFAULT 50,
            initial_affinity INTEGER DEFAULT 50,
            status TEXT DEFAULT 'active',
            pressure_level INTEGER DEFAULT 0,
            last_user_msg_time INTEGER DEFAULT 0,
            is_blocked INTEGER DEFAULT 0,
            system_prompt TEXT,
            is_diary_unlocked INTEGER DEFAULT 0,
            hidden_state TEXT DEFAULT '',
            jealousy_level INTEGER DEFAULT 0,
            jealousy_target TEXT DEFAULT '',
            stat_int INTEGER DEFAULT 50,
            stat_sta INTEGER DEFAULT 50,
            stat_cha INTEGER DEFAULT 50,
            sweep_limit INTEGER DEFAULT 30,
            impression_q_limit INTEGER DEFAULT 3
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            read INTEGER DEFAULT 0,
            hidden INTEGER DEFAULT 0,
            is_summarized INTEGER DEFAULT 0,
            FOREIGN KEY (character_id) REFERENCES characters(id)
        );

        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            time TEXT,
            location TEXT,
            people TEXT,
            event TEXT NOT NULL,
            relationships TEXT,
            items TEXT,
            importance INTEGER DEFAULT 5,
            embedding BLOB,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (character_id) REFERENCES characters(id)
        );

        CREATE TABLE IF NOT EXISTS moments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            content TEXT NOT NULL,
            image_url TEXT,
            visibility TEXT DEFAULT 'all',
            timestamp INTEGER NOT NULL,
            likes INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS diaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            content TEXT NOT NULL,
            emotion TEXT,
            is_unlocked INTEGER DEFAULT 0,
            timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS user_profile (
            id TEXT PRIMARY KEY DEFAULT 'default',
            name TEXT DEFAULT 'User',
            avatar TEXT,
            bio TEXT DEFAULT '',
            theme TEXT DEFAULT 'light',
            group_msg_limit INTEGER DEFAULT 20,
            group_skip_rate INTEGER DEFAULT 10,
            group_proactive_enabled INTEGER DEFAULT 0,
            group_interval_max INTEGER DEFAULT 60,
            theme_config TEXT DEFAULT '{}',
            banner TEXT,
            private_msg_limit_for_group INTEGER DEFAULT 3
        );
        CREATE TABLE IF NOT EXISTS moment_likes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            moment_id INTEGER NOT NULL,
            liker_id TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            UNIQUE(moment_id, liker_id)
        );

        CREATE TABLE IF NOT EXISTS moment_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            moment_id INTEGER NOT NULL,
            author_id TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS character_friends (
            char1_id TEXT NOT NULL,
            char2_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (char1_id, char2_id),
            FOREIGN KEY (char1_id) REFERENCES characters(id) ON DELETE CASCADE,
            FOREIGN KEY (char2_id) REFERENCES characters(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS token_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            context_type TEXT NOT NULL,
            prompt_tokens INTEGER DEFAULT 0,
            completion_tokens INTEGER DEFAULT 0,
            timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS group_chats (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            avatar TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS group_members (
            group_id TEXT NOT NULL,
            member_id TEXT NOT NULL,
            role TEXT DEFAULT 'member',
            joined_at INTEGER DEFAULT 0,
            PRIMARY KEY (group_id, member_id)
        );

        CREATE TABLE IF NOT EXISTS group_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            is_summarized INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS char_relationships (
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            affinity INTEGER DEFAULT 50,
            impression TEXT DEFAULT '',
            source TEXT DEFAULT 'recommend',
            PRIMARY KEY (source_id, target_id, source)
        );

        CREATE TABLE IF NOT EXISTS char_impression_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id TEXT NOT NULL,
            target_id TEXT NOT NULL,
            impression TEXT NOT NULL,
            trigger_event TEXT NOT NULL,
            timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS group_red_packets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'lucky',
            total_amount REAL NOT NULL,
            per_amount REAL,
            count INTEGER NOT NULL,
            remaining_count INTEGER NOT NULL,
            amounts TEXT NOT NULL,
            note TEXT DEFAULT '',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS group_red_packet_claims (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            packet_id INTEGER NOT NULL,
            claimer_id TEXT NOT NULL,
            amount REAL NOT NULL,
            claimed_at INTEGER NOT NULL,
            UNIQUE(packet_id, claimer_id)
        );

        CREATE TABLE IF NOT EXISTS private_transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            char_id TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            recipient_id TEXT NOT NULL,
            amount REAL NOT NULL,
            note TEXT DEFAULT '',
            claimed INTEGER DEFAULT 0,
            claimed_at INTEGER,
            message_id INTEGER,
            created_at INTEGER NOT NULL
        );
    `);

        // Add system_prompt for existing DBs (Migration)
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN system_prompt TEXT').run();
        } catch (e) {
            // Ignore error if column already exists
        }

        // Add emoji for existing DBs (Migration)
        try {
            db.prepare("ALTER TABLE characters ADD COLUMN emoji TEXT DEFAULT '🙂'").run();
        } catch (e) {
            // Ignore error if column already exists
        }

        // Add joined_at for group_members (Migration)
        try {
            db.prepare('ALTER TABLE group_members ADD COLUMN joined_at INTEGER DEFAULT 0').run();
        } catch (e) { }

        // Add banner for existing DBs
        try {
            db.prepare('ALTER TABLE user_profile ADD COLUMN banner TEXT').run();
        } catch (e) { }

        // Add initial_affinity for existing DBs (migration for the chat wipe bug)
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN initial_affinity INTEGER').run();
            db.prepare('UPDATE characters SET initial_affinity = affinity WHERE initial_affinity IS NULL').run();
        } catch (e) { }

        // Add max_tokens for existing DBs
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN max_tokens INTEGER DEFAULT 800').run();
        } catch (e) {
        }

        // Add is_blocked for older DBs
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN is_blocked INTEGER DEFAULT 0').run();
        } catch (e) {
        }

        // Add impression_q_limit for existing DBs
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN impression_q_limit INTEGER DEFAULT 3').run();
        } catch (e) {
        }

        // Add master toggles for systems
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN sys_proactive INTEGER DEFAULT 1').run();
            db.prepare('ALTER TABLE characters ADD COLUMN sys_timer INTEGER DEFAULT 1').run();
            db.prepare('ALTER TABLE characters ADD COLUMN sys_pressure INTEGER DEFAULT 1').run();
            db.prepare('ALTER TABLE characters ADD COLUMN sys_jealousy INTEGER DEFAULT 1').run();
        } catch (e) {
        }

        // Add is_diary_unlocked to characters
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN is_diary_unlocked INTEGER DEFAULT 0').run();
        } catch (e) {
        }

        // Add sweep_limit to characters
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN sweep_limit INTEGER DEFAULT 30').run();
        } catch (e) {
        }

        // Add diary_password to characters (password-lock mechanic)
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN diary_password TEXT').run();
        } catch (e) {
        }

        // Add hidden_state to characters (hybrid context mechanic)
        try {
            db.prepare("ALTER TABLE characters ADD COLUMN hidden_state TEXT DEFAULT ''").run();
        } catch (e) {
        }

        // --- Data Migration: Backfill char_impression_history ---
        try {
            const historyCount = db.prepare('SELECT COUNT(*) as c FROM char_impression_history').get().c;
            if (historyCount === 0) {
                // If history is completely empty, backfill it from existing impressions
                const existingRels = db.prepare('SELECT * FROM char_relationships WHERE impression IS NOT NULL AND impression != \'\'').all();
                if (existingRels.length > 0) {
                    const insertStmt = db.prepare('INSERT INTO char_impression_history (source_id, target_id, impression, trigger_event, timestamp) VALUES (?, ?, ?, ?, ?)');
                    db.transaction(() => {
                        for (const r of existingRels) {
                            insertStmt.run(r.source_id, r.target_id, r.impression, `Migration: ${r.source}`, Date.now());
                        }
                    })();
                    console.log(`[DB Migration] Backfilled ${existingRels.length} impression histories for user ${userId}.`);
                }
            }
        } catch (e) {
            console.error('[DB Migration] Failed to backfill impression history:', e.message);
        }

        // Add hidden column to messages (context hide mechanic)
        try {
            db.prepare('ALTER TABLE messages ADD COLUMN hidden INTEGER DEFAULT 0').run();
        } catch (e) {
        }

        // Add metadata column to messages (memory visualization)
        try {
            db.prepare('ALTER TABLE messages ADD COLUMN metadata TEXT DEFAULT NULL').run();
        } catch (e) {
        }

        // Add is_summarized for overflow memory feature
        try {
            db.prepare('ALTER TABLE messages ADD COLUMN is_summarized INTEGER DEFAULT 0').run();
            db.prepare('ALTER TABLE group_messages ADD COLUMN is_summarized INTEGER DEFAULT 0').run();
        } catch (e) {
        }

        // Add memory API config for existing DBs
        try { db.prepare('ALTER TABLE characters ADD COLUMN memory_api_endpoint TEXT').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN memory_api_key TEXT').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN memory_model_name TEXT').run(); } catch (e) { }

        // Add sender_name and sender_avatar to group_messages (so deleted chars still display)
        try {
            db.prepare('ALTER TABLE group_messages ADD COLUMN sender_name TEXT').run();
            db.prepare('ALTER TABLE group_messages ADD COLUMN sender_avatar TEXT').run();
            // Backfill existing records
            const msgs = db.prepare('SELECT DISTINCT sender_id FROM group_messages WHERE sender_name IS NULL').all();
            for (const m of msgs) {
                if (m.sender_id === 'user') {
                    const profile = db.prepare('SELECT name, avatar FROM user_profile WHERE id = ?').get('default');
                    if (profile) {
                        db.prepare('UPDATE group_messages SET sender_name = ?, sender_avatar = ? WHERE sender_id = ? AND sender_name IS NULL')
                            .run(profile.name || 'User', profile.avatar || '', 'user');
                    }
                } else {
                    const char = db.prepare('SELECT name, avatar FROM characters WHERE id = ?').get(m.sender_id);
                    if (char) {
                        db.prepare('UPDATE group_messages SET sender_name = ?, sender_avatar = ? WHERE sender_id = ? AND sender_name IS NULL')
                            .run(char.name, char.avatar || '', m.sender_id);
                    }
                }
            }
        } catch (e) {
        }

        ensureAllDiaryPasswords();

        // Migrate old max_tokens=800 (old default) to 2000
        try {
            db.prepare("UPDATE characters SET max_tokens = 2000 WHERE max_tokens IS NULL OR max_tokens <= 800").run();
        } catch (e) { }

        // Add group_id to memories (tracks which group a memory came from)
        try {
            db.prepare('ALTER TABLE memories ADD COLUMN group_id TEXT DEFAULT NULL').run();
        } catch (e) { }

        // Add hidden column to group_messages (context hide mechanic)
        try {
            db.prepare('ALTER TABLE group_messages ADD COLUMN hidden INTEGER DEFAULT 0').run();
        } catch (e) { }

        // Add metadata column to group_messages (memory visualization)
        try {
            db.prepare('ALTER TABLE group_messages ADD COLUMN metadata TEXT DEFAULT NULL').run();
        } catch (e) { }

        // Add group_msg_limit to user_profile for controlling group context injection
        try {
            db.prepare('ALTER TABLE user_profile ADD COLUMN group_msg_limit INTEGER DEFAULT 20').run();
        } catch (e) { }

        // Add private_msg_limit_for_group to user_profile for controlling dual-layer memory injection size
        try {
            db.prepare('ALTER TABLE user_profile ADD COLUMN private_msg_limit_for_group INTEGER DEFAULT 3').run();
        } catch (e) { }

        // Add group_skip_rate to user_profile (% chance a char skips reply in group chat)
        try {
            db.prepare('ALTER TABLE user_profile ADD COLUMN group_skip_rate INTEGER DEFAULT 10').run();
        } catch (e) { }

        // Add jealousy_chance to user_profile (% chance a char gets jealous when user talks to someone else)
        try {
            db.prepare('ALTER TABLE user_profile ADD COLUMN jealousy_chance INTEGER DEFAULT 5').run();
        } catch (e) { }

        // Add group proactive settings
        try { db.prepare('ALTER TABLE user_profile ADD COLUMN group_proactive_enabled INTEGER DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE user_profile ADD COLUMN group_interval_min INTEGER DEFAULT 10').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE user_profile ADD COLUMN group_interval_max INTEGER DEFAULT 60').run(); } catch (e) { }

        // Add wallet fields
        try { db.prepare('ALTER TABLE characters ADD COLUMN wallet REAL DEFAULT 200').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE user_profile ADD COLUMN wallet REAL DEFAULT 520').run(); } catch (e) { }
        // Ensure existing users start at 520 if null
        try { db.prepare("UPDATE user_profile SET wallet = 520 WHERE wallet IS NULL").run(); } catch (e) { }

        // Add refunded column to private_transfers (for refund feature)
        try { db.prepare('ALTER TABLE private_transfers ADD COLUMN refunded INTEGER DEFAULT 0').run(); } catch (e) { }

        // Add theme and custom_css for UI skinning
        try { db.prepare('ALTER TABLE user_profile ADD COLUMN theme TEXT DEFAULT "default"').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE user_profile ADD COLUMN custom_css TEXT DEFAULT ""').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE user_profile ADD COLUMN theme_config TEXT DEFAULT "{}"').run(); } catch (e) { }

        // Add per-group inject_limit (how many messages from this group get injected into private/other group contexts)
        try { db.prepare('ALTER TABLE group_chats ADD COLUMN inject_limit INTEGER DEFAULT 5').run(); } catch (e) { }

        // Moments DLC: token limit and reaction rate
        try { db.prepare('ALTER TABLE user_profile ADD COLUMN moments_token_limit INTEGER DEFAULT 500').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE user_profile ADD COLUMN moments_reaction_rate INTEGER DEFAULT 30').run(); } catch (e) { }
        // Track last moment posted by each character (cooldown)
        try { db.prepare('ALTER TABLE characters ADD COLUMN last_moment_at INTEGER DEFAULT 0').run(); } catch (e) { }
        // Enhanced jealousy system
        try { db.prepare('ALTER TABLE characters ADD COLUMN jealousy_level INTEGER DEFAULT 0').run(); } catch (e) { }
        try { db.prepare("ALTER TABLE characters ADD COLUMN jealousy_target TEXT DEFAULT ''").run(); } catch (e) { }

        // City DLC: per-character toggle for city event notifications to private chat
        try { db.prepare('ALTER TABLE characters ADD COLUMN sys_city_notify INTEGER DEFAULT 0').run(); } catch (e) { }
        // City DLC: schedule & activity frequency
        try { db.prepare('ALTER TABLE characters ADD COLUMN is_scheduled INTEGER DEFAULT 1').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN city_action_frequency INTEGER DEFAULT 1').run(); } catch (e) { }

        // Character Base Stats
        try { db.prepare('ALTER TABLE characters ADD COLUMN stat_int INTEGER DEFAULT 50').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN stat_sta INTEGER DEFAULT 50').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN stat_cha INTEGER DEFAULT 50').run(); } catch (e) { }

        console.log('[DB] Database initialized successfully.');
    }

    // 鈹€鈹€鈹€ Character Queries 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    function getCharacters() {
        return db.prepare('SELECT * FROM characters').all();
    }

    function getCharacter(id) {
        return db.prepare('SELECT * FROM characters WHERE id = ?').get(id);
    }

    const characterColumns = [
        'id', 'name', 'avatar', 'persona', 'world_info', 'api_endpoint',
        'api_key', 'model_name', 'memory_api_endpoint', 'memory_api_key',
        'memory_model_name', 'interval_min', 'interval_max', 'affinity', 'initial_affinity',
        'status', 'pressure_level', 'last_user_msg_time', 'is_blocked', 'system_prompt', 'max_tokens',
        'sys_proactive', 'sys_timer', 'sys_pressure', 'sys_jealousy', 'is_diary_unlocked', 'diary_password', 'wallet', 'emoji', 'last_moment_at',
        'jealousy_level', 'jealousy_target',
        'stat_int', 'stat_sta', 'stat_cha', 'sweep_limit',
        // City DLC fields
        'calories', 'city_status', 'location', 'education', 'sys_survival', 'sys_city_notify',
        'impression_q_limit', 'is_scheduled', 'city_action_frequency'
    ];

    // Generates a memorable random diary password (4-digit number)
    function generateDiaryPassword() {
        return String(Math.floor(1000 + Math.random() * 9000));
    }

    function updateCharacter(id, data) {
        // Filter out 'id' from data keys 鈥?it's always passed as a separate parameter
        const fields = Object.keys(data).filter(k => characterColumns.includes(k) && k !== 'id');
        if (fields.length === 0) return;

        const values = fields.map(f => data[f]);

        // Insert if not exists, else update
        const existing = getCharacter(id);
        if (!existing) {
            // Auto-assign a diary password for new characters
            if (!data.diary_password) {
                const pw = generateDiaryPassword();
                fields.push('diary_password');
                values.push(pw);
            }

            // Snapshot initial affinity on creation
            if (!fields.includes('initial_affinity')) {
                const startAffinity = fields.includes('affinity') ? data.affinity : 50;
                fields.push('initial_affinity');
                values.push(startAffinity);
            }

            // Initialize hidden state
            if (!fields.includes('hidden_state')) {
                fields.push('hidden_state');
                values.push('');
            }
            // Ensure emoji has a default
            if (!fields.includes('emoji')) {
                fields.push('emoji');
                values.push('🙂');
            }

            const placeholders = fields.map(() => '?').join(', ');
            db.prepare(`INSERT INTO characters (id, ${fields.join(', ')}) VALUES (?, ${placeholders})`)
                .run(id, ...values);
        } else {
            const setClause = fields.map(f => `${f} = ?`).join(', ');
            db.prepare(`UPDATE characters SET ${setClause} WHERE id = ?`)
                .run(...values, id);
        }
    }

    // Backfill diary passwords for existing characters that don't have one
    function ensureAllDiaryPasswords() {
        const chars = db.prepare("SELECT id FROM characters WHERE diary_password IS NULL OR diary_password = ''").all();
        for (const c of chars) {
            db.prepare('UPDATE characters SET diary_password = ? WHERE id = ?').run(generateDiaryPassword(), c.id);
        }
        if (chars.length > 0) console.log(`[DB] Auto-assigned diary passwords to ${chars.length} character(s).`);
    }

    function getCharacterHiddenState(id) {
        const row = db.prepare('SELECT hidden_state FROM characters WHERE id = ?').get(id);
        return row ? row.hidden_state : '';
    }

    function updateCharacterHiddenState(id, hidden_state) {
        db.prepare('UPDATE characters SET hidden_state = ? WHERE id = ?').run(hidden_state || '', id);
    }

    // 鈹€鈹€鈹€ Message Queries 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    function getMessages(characterId, limit = 100) {
        return db.prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY id DESC LIMIT ?')
            .all(characterId, limit)
            .reverse();
    }

    function getMessagesBefore(characterId, beforeId, limit = 100) {
        return db.prepare('SELECT * FROM messages WHERE character_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(characterId, beforeId, limit)
            .reverse();
    }

    // Returns messages excluding hidden ones 鈥?used for LLM context
    // Pass limit=0 to get ALL visible messages (no cap)
    function getVisibleMessages(characterId, limit = 0) {
        if (limit > 0) {
            return db.prepare('SELECT * FROM messages WHERE character_id = ? AND hidden = 0 ORDER BY id DESC LIMIT ?')
                .all(characterId, limit)
                .reverse();
        }
        return db.prepare('SELECT * FROM messages WHERE character_id = ? AND hidden = 0 ORDER BY id ASC')
            .all(characterId);
    }

    function getVisibleMessagesSince(characterId, sinceTimestamp = 0) {
        return db.prepare('SELECT * FROM messages WHERE character_id = ? AND hidden = 0 AND timestamp >= ? ORDER BY timestamp ASC')
            .all(characterId, sinceTimestamp);
    }

    // Hide a range of messages by index (0-based from oldest)
    function hideMessagesByRange(characterId, startIdx, endIdx) {
        const allMsgs = db.prepare('SELECT id FROM messages WHERE character_id = ? ORDER BY timestamp ASC').all(characterId);
        const toHide = allMsgs.slice(startIdx, endIdx + 1).map(m => m.id);
        if (toHide.length === 0) return 0;
        const placeholders = toHide.map(() => '?').join(', ');
        const info = db.prepare(`UPDATE messages SET hidden = 1 WHERE id IN (${placeholders})`).run(...toHide);
        return info.changes;
    }

    // Hide an array of exact message IDs
    function hideMessagesByIds(characterId, messageIds) {
        if (!messageIds || messageIds.length === 0) return 0;
        const placeholders = messageIds.map(() => '?').join(', ');
        // Security check: ONLY hide messages belonging to this characterId
        const info = db.prepare(`UPDATE messages SET hidden = 1 WHERE character_id = ? AND id IN (${placeholders})`).run(characterId, ...messageIds);
        return info.changes;
    }

    // Unhide all messages for a character
    function unhideMessages(characterId) {
        const info = db.prepare('UPDATE messages SET hidden = 0 WHERE character_id = ?').run(characterId);
        return info.changes;
    }

    // Overflow memory summarization support
    function getUnsummarizedMessages(characterId, olderThanTimestamp, limit = 50) {
        return db.prepare('SELECT * FROM messages WHERE character_id = ? AND hidden = 0 AND is_summarized = 0 AND timestamp < ? ORDER BY timestamp ASC LIMIT ?')
            .all(characterId, olderThanTimestamp, limit);
    }

    function countUnsummarizedMessages(characterId, olderThanTimestamp) {
        const row = db.prepare('SELECT COUNT(*) as count FROM messages WHERE character_id = ? AND hidden = 0 AND is_summarized = 0 AND timestamp < ?')
            .get(characterId, olderThanTimestamp);
        return row ? row.count : 0;
    }

    function markMessagesSummarized(messageIds) {
        if (!messageIds || messageIds.length === 0) return 0;
        const placeholders = messageIds.map(() => '?').join(', ');
        const info = db.prepare(`UPDATE messages SET is_summarized = 1 WHERE id IN (${placeholders})`).run(...messageIds);
        return info.changes;
    }

    function addMessage(characterId, role, content, metadata = null) {
        const ts = Date.now();
        const metadataStr = metadata ? JSON.stringify(metadata) : null;
        let info;
        try {
            info = db.prepare('INSERT INTO messages (character_id, role, content, timestamp, metadata) VALUES (?, ?, ?, ?, ?)')
                .run(characterId, role, content, ts, metadataStr);
        } catch (e) {
            // Fallback for old databases without metadata column
            info = db.prepare('INSERT INTO messages (character_id, role, content, timestamp) VALUES (?, ?, ?, ?)')
                .run(characterId, role, content, ts);
        }
        return { id: info.lastInsertRowid, timestamp: ts };
    }

    function deleteMessage(messageId) {
        db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    }

    function markMessagesRead(characterId) {
        db.prepare('UPDATE messages SET read = 1 WHERE character_id = ? AND read = 0 AND role = ?')
            .run(characterId, 'character');
    }

    function getUnreadCount(characterId) {
        const row = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE character_id = ? AND role = ? AND read = 0').get(characterId, 'character');
        return row?.cnt || 0;
    }

    function clearMessages(characterId) {
        db.prepare('DELETE FROM messages WHERE character_id = ?').run(characterId);
    }

    function clearMemories(characterId) {
        db.prepare('DELETE FROM memories WHERE character_id = ?').run(characterId);
    }

    function clearMoments(characterId) {
        // Delete likes and comments ON this character's moments
        const momentIds = db.prepare('SELECT id FROM moments WHERE character_id = ?').all(characterId).map(m => m.id);
        if (momentIds.length > 0) {
            const placeholders = momentIds.map(() => '?').join(', ');
            db.prepare(`DELETE FROM moment_likes WHERE moment_id IN (${placeholders})`).run(...momentIds);
            db.prepare(`DELETE FROM moment_comments WHERE moment_id IN (${placeholders})`).run(...momentIds);
        }
        // Delete the moments themselves
        db.prepare('DELETE FROM moments WHERE character_id = ?').run(characterId);
        // Also remove this character's likes and comments on OTHER people's moments
        db.prepare('DELETE FROM moment_likes WHERE liker_id = ?').run(characterId);
        db.prepare('DELETE FROM moment_comments WHERE author_id = ?').run(characterId);
    }

    function clearDiaries(characterId) {
        db.prepare('DELETE FROM diaries WHERE character_id = ?').run(characterId);
    }

    function exportCharacterData(characterId) {
        const character = getCharacter(characterId);
        if (!character) return null;
        const messages = db.prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY timestamp ASC').all(characterId);
        const memories = db.prepare('SELECT * FROM memories WHERE character_id = ? ORDER BY created_at ASC').all(characterId);
        const moments = db.prepare('SELECT * FROM moments WHERE character_id = ? ORDER BY timestamp ASC').all(characterId);
        return { character, messages, memories, moments };
    }

    // 鈹€鈹€鈹€ Memory Queries 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    function getMemories(characterId) {
        return db.prepare('SELECT * FROM memories WHERE character_id = ? ORDER BY created_at DESC').all(characterId);
    }

    function getMemory(id) {
        return db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    }

    function addMemory(characterId, memoryData, groupId = null) {
        const { time, location, people, event, relationships, items, importance, embedding } = memoryData;
        const info = db.prepare(`
        INSERT INTO memories 
        (character_id, time, location, people, event, relationships, items, importance, embedding, created_at, group_id) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(characterId, time, location, people, event, relationships, items, importance, embedding, Date.now(), groupId);
        return info.lastInsertRowid;
    }

    function updateMemory(id, memoryData) {
        const fields = Object.keys(memoryData);
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => memoryData[f]);
        db.prepare(`UPDATE memories SET ${setClause} WHERE id = ?`).run(...values, id);
    }

    function deleteMemory(id) {
        db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    }

    // 鈹€鈹€鈹€ Phase 3: Moments & Diaries 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    function getMoments() {
        return db.prepare('SELECT * FROM moments ORDER BY timestamp DESC LIMIT 100').all();
    }

    function getMomentsSince(characterId, sinceTimestamp = 0) {
        const friends = getFriends(characterId) || [];
        const friendIds = friends.map(f => f.id);
        const authors = [characterId, 'user', ...friendIds];
        const placeholders = authors.map(() => '?').join(',');
        return db.prepare(`SELECT * FROM moments WHERE character_id IN (${placeholders}) AND timestamp >= ? ORDER BY timestamp ASC`)
            .all(...authors, sinceTimestamp);
    }

    function getCharacterMoments(characterId) {
        return db.prepare('SELECT * FROM moments WHERE character_id = ? ORDER BY timestamp DESC').all(characterId);
    }

    function deleteMoment(momentId) {
        db.prepare('DELETE FROM moment_likes WHERE moment_id = ?').run(momentId);
        db.prepare('DELETE FROM moment_comments WHERE moment_id = ?').run(momentId);
        db.prepare('DELETE FROM moments WHERE id = ?').run(momentId);
    }

    function addMoment(characterId, content, imageUrl = null, visibility = 'all') {
        const info = db.prepare(`
        INSERT INTO moments (character_id, content, image_url, visibility, timestamp) 
        VALUES (?, ?, ?, ?, ?)
    `).run(characterId, content, imageUrl, visibility, Date.now());
        return info.lastInsertRowid;
    }

    function getDiaries(characterId) {
        return db.prepare('SELECT * FROM diaries WHERE character_id = ? ORDER BY timestamp DESC').all(characterId);
    }

    function addDiary(characterId, content, emotion = null) {
        const info = db.prepare(`
        INSERT INTO diaries (character_id, content, emotion, timestamp) 
        VALUES (?, ?, ?, ?)
    `).run(characterId, content, emotion, Date.now());
        return info.lastInsertRowid;
    }

    function deleteDiary(diaryId) {
        db.prepare('DELETE FROM diaries WHERE id = ?').run(diaryId);
    }

    function unlockDiaries(characterId) {
        db.prepare('UPDATE characters SET is_diary_unlocked = 1 WHERE id = ?').run(characterId);
    }

    // Set the diary password (called when AI generates [DIARY_PASSWORD:xxxx] tag)
    function setDiaryPassword(characterId, password) {
        db.prepare('UPDATE characters SET diary_password = ? WHERE id = ?').run(password, characterId);
    }

    // Verify and unlock the diary if password matches. Returns true on success.
    function verifyAndUnlockDiary(characterId, inputPassword) {
        const char = db.prepare('SELECT diary_password, is_diary_unlocked FROM characters WHERE id = ?').get(characterId);
        if (!char) return { success: false, reason: 'Character not found.' };
        if (char.is_diary_unlocked) return { success: true, alreadyUnlocked: true };
        if (!char.diary_password) return { success: false, reason: 'No password has been set yet. Keep building your bond.' };
        if (char.diary_password.trim().toLowerCase() === inputPassword.trim().toLowerCase()) {
            db.prepare('UPDATE characters SET is_diary_unlocked = 1 WHERE id = ?').run(characterId);
            return { success: true };
        }
        return { success: false, reason: 'Wrong password.' };
    }

    // Toggle like: user_id = 'user' for the human user, or char id
    function toggleLike(momentId, likerId) {
        const existing = db.prepare('SELECT id FROM moment_likes WHERE moment_id=? AND liker_id=?').get(momentId, likerId);
        if (existing) {
            db.prepare('DELETE FROM moment_likes WHERE id=?').run(existing.id);
            return false; // unliked
        } else {
            db.prepare('INSERT INTO moment_likes(moment_id,liker_id,timestamp) VALUES(?,?,?)').run(momentId, likerId, Date.now());
            return true; // liked
        }
    }

    function getLikesForMoment(momentId) {
        return db.prepare('SELECT liker_id FROM moment_likes WHERE moment_id=?').all(momentId);
    }

    function addComment(momentId, authorId, content) {
        const info = db.prepare('INSERT INTO moment_comments(moment_id,author_id,content,timestamp) VALUES(?,?,?,?)').run(momentId, authorId, content, Date.now());
        return info.lastInsertRowid;
    }

    function getComments(momentId) {
        return db.prepare('SELECT * FROM moment_comments WHERE moment_id=? ORDER BY timestamp ASC').all(momentId);
    }

    // 鈹€鈹€鈹€ Moments Context Builder for LLM Injection 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    function getMomentsContextForChar(charId, charLimit = 500) {
        if (charLimit <= 0) return '';

        const allChars = getCharacters();
        const userProfile = getUserProfile();
        const userName = userProfile?.name || 'User';

        // Helper: resolve name by id
        const resolveName = (id) => {
            if (id === 'user') return userName;
            const c = allChars.find(ch => ch.id === id);
            return c?.name || '???';
        };

        // Helper: format a single moment with likes & comments
        const formatMoment = (m) => {
            const timeAgo = formatTimeAgo(m.timestamp);
            const likers = getLikesForMoment(m.id).map(l => resolveName(l.liker_id));
            const comments = getComments(m.id).map(c => `${resolveName(c.author_id)}: ${c.content}`);
            let line = `  [ID:${m.id}] "${m.content}" (${timeAgo})`;
            if (likers.length > 0) line += ` ❤️ ${likers.join(", ")}`;
            if (comments.length > 0) line += `\n    评论: ${comments.join(' | ')}`;
            return line;
            return line;
        };

        // Helper: simple time ago
        // Helper: simple time ago
        function formatTimeAgo(ts) {
            const diffMin = Math.floor((Date.now() - ts) / 60000);
            if (diffMin < 60) return `${diffMin}分钟前`;
            const diffH = Math.floor(diffMin / 60);
            if (diffH < 24) return `${diffH}小时前`;
            return `${Math.floor(diffH / 24)}天前`;
        }

        // Collect moments from 3 sources: own, user's, acquainted chars'
        const ownMoments = db.prepare('SELECT * FROM moments WHERE character_id = ? ORDER BY timestamp DESC LIMIT 10').all(charId);
        const userMoments = db.prepare("SELECT * FROM moments WHERE character_id = 'user' ORDER BY timestamp DESC LIMIT 10").all();
        const acquaintedCharIds = allChars
            .filter(c => c.id !== charId && !c.is_blocked && isCharAcquainted(charId, c.id))
            .map(c => c.id);
        const friendMoments = [];
        for (const fId of acquaintedCharIds) {
            const fms = db.prepare('SELECT * FROM moments WHERE character_id = ? ORDER BY timestamp DESC LIMIT 5').all(fId);
            friendMoments.push(...fms);
        }

        let result = '====== [朋友圈动态 / Moments Feed] ======';
        let totalLen = result.length;

        // Build sections, respecting char limit
        const sections = [
            { label: '[你的朋友圈]', moments: ownMoments },
            { label: `[${userName}的朋友圈]`, moments: userMoments },
        ];
        // Group friend moments by char
        const friendByChar = {};
        for (const fm of friendMoments) {
            if (!friendByChar[fm.character_id]) friendByChar[fm.character_id] = [];
            friendByChar[fm.character_id].push(fm);
        }
        for (const [fId, fms] of Object.entries(friendByChar)) {
            sections.push({ label: `[${resolveName(fId)}的朋友圈]`, moments: fms });
        }

        for (const section of sections) {
            if (section.moments.length === 0) continue;
            const sectionHeader = `\n${section.label}:`;
            if (totalLen + sectionHeader.length > charLimit) break;
            result += sectionHeader;
            totalLen += sectionHeader.length;
            for (const m of section.moments) {
                const line = '\n' + formatMoment(m);
                if (totalLen + line.length > charLimit) break;
                result += line;
                totalLen += line.length;
            }
        }

        // Mark which moments the char has already liked/commented
        // Mark which moments the char has already liked/commented
        const charLiked = db.prepare('SELECT moment_id FROM moment_likes WHERE liker_id = ?').all(charId).map(r => r.moment_id);
        const charCommented = db.prepare('SELECT DISTINCT moment_id FROM moment_comments WHERE author_id = ?').all(charId).map(r => r.moment_id);
        if (charLiked.length > 0) result += `\n(你已点赞的朋友圈 ID: ${charLiked.join(", ")})`;
        if (charCommented.length > 0) result += `\n(你已评论过的朋友圈 ID: ${charCommented.join(", ")})`;



        result += '\n===========================================';
        return result;
    }


    // 鈹€鈹€鈹€ User Profile 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    function getUserProfile() {
        let profile = db.prepare('SELECT * FROM user_profile WHERE id = ?').get('default');
        if (!profile) {
            db.prepare(`INSERT INTO user_profile (id, name, avatar) VALUES (?, ?, ?)`)
                .run('default', 'User', 'https://api.dicebear.com/7.x/notionists/svg?seed=User');
            profile = db.prepare('SELECT * FROM user_profile WHERE id = ?').get('default');
        }
        return profile;
    }

    function updateUserProfile(data) {
        const allowedFields = ['name', 'avatar', 'banner', 'bio', 'theme', 'custom_css', 'theme_config', 'group_msg_limit', 'group_skip_rate', 'group_proactive_enabled', 'group_interval_min', 'group_interval_max', 'jealousy_chance', 'wallet', 'private_msg_limit_for_group', 'moments_token_limit'];
        const fields = Object.keys(data).filter(k => allowedFields.includes(k));
        if (fields.length === 0) return;
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => data[f]);
        db.prepare(`UPDATE user_profile SET ${setClause} WHERE id = ?`).run(...values, 'default');
    }

    // 鈹€鈹€鈹€ Friendship Management 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    function addFriend(char1Id, char2Id) {
        if (char1Id === char2Id) return false;
        const stmt = db.prepare('INSERT OR IGNORE INTO character_friends (char1_id, char2_id, created_at) VALUES (?, ?, ?)');
        const now = Date.now();
        const info1 = stmt.run(char1Id, char2Id, now);
        const info2 = stmt.run(char2Id, char1Id, now);
        return info1.changes > 0 || info2.changes > 0;
    }

    function clearFriends(charId) {
        db.prepare('DELETE FROM character_friends WHERE char1_id = ? OR char2_id = ?').run(charId, charId);
    }

    // Clear all char-to-char relationships involving this character (both directions)
    function clearCharRelationships(charId) {
        db.prepare('DELETE FROM char_relationships WHERE source_id = ? OR target_id = ?').run(charId, charId);
    }

    // Clear all private transfers involving this character
    function clearTransfers(charId) {
        db.prepare('DELETE FROM private_transfers WHERE char_id = ? OR sender_id = ? OR recipient_id = ?').run(charId, charId, charId);
    }

    // Clear moment likes & comments on this character's moments, and by this character
    function clearMomentInteractions(charId) {
        // Delete likes/comments ON this char's moments
        const momentIds = db.prepare('SELECT id FROM moments WHERE character_id = ?').all(charId).map(r => r.id);
        if (momentIds.length > 0) {
            const placeholders = momentIds.map(() => '?').join(',');
            db.prepare(`DELETE FROM moment_likes WHERE moment_id IN (${placeholders})`).run(...momentIds);
            db.prepare(`DELETE FROM moment_comments WHERE moment_id IN (${placeholders})`).run(...momentIds);
        }
        // Delete likes/comments BY this char on others' moments
        db.prepare('DELETE FROM moment_likes WHERE user_id = ?').run(charId);
        db.prepare('DELETE FROM moment_comments WHERE user_id = ?').run(charId);
    }

    function getFriends(charId) {
        // Return list of character objects that are friends with charId
        return db.prepare(`
        SELECT c.* FROM characters c
        JOIN character_friends f ON c.id = f.char2_id
        WHERE f.char1_id = ?
    `).all(charId);
    }

    function isFriend(charId, targetId) {
        if (charId === targetId) return true;
        const relation = db.prepare('SELECT 1 FROM character_friends WHERE char1_id = ? AND char2_id = ?').get(charId, targetId);
        return !!relation;
    }

    // 鈹€鈹€鈹€ Group Chat Management 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    function createGroup(id, name, memberIds, avatar = null) {
        db.prepare('INSERT INTO group_chats (id, name, avatar, created_at) VALUES (?, ?, ?, ?)').run(id, name, avatar, Date.now());
        const stmt = db.prepare('INSERT OR IGNORE INTO group_members (group_id, member_id, role) VALUES (?, ?, ?)');
        stmt.run(id, 'user', 'owner');
        for (const mid of memberIds) {
            stmt.run(id, mid, 'member');
        }
        return id;
    }

    function getGroups() {
        const groups = db.prepare('SELECT * FROM group_chats ORDER BY created_at DESC').all();
        return groups.map(g => ({
            ...g,
            members: db.prepare('SELECT member_id, role, joined_at FROM group_members WHERE group_id = ?').all(g.id)
        }));
    }

    function getGroup(id) {
        const group = db.prepare('SELECT * FROM group_chats WHERE id = ?').get(id);
        if (!group) return null;
        group.members = db.prepare('SELECT member_id, role, joined_at FROM group_members WHERE group_id = ?').all(id);
        return group;
    }

    function deleteGroup(id) {
        db.prepare('DELETE FROM group_messages WHERE group_id = ?').run(id);
        db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
        db.prepare('DELETE FROM char_relationships WHERE source = ?').run(`group:${id}`);
        db.prepare('DELETE FROM memories WHERE group_id = ?').run(id);
        db.prepare('DELETE FROM group_chats WHERE id = ?').run(id);
    }

    function getGroupMessages(groupId, limit = 100) {
        return db.prepare('SELECT * FROM group_messages WHERE group_id = ? ORDER BY timestamp DESC LIMIT ?').all(groupId, limit).reverse();
    }

    function getVisibleGroupMessages(groupId, limit = 50, sinceTimestamp = 0) {
        return db.prepare('SELECT * FROM group_messages WHERE group_id = ? AND hidden = 0 AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?').all(groupId, sinceTimestamp, limit).reverse();
    }

    function getUnsummarizedGroupMessages(groupId, olderThanTimestamp, limit = 50) {
        return db.prepare('SELECT * FROM group_messages WHERE group_id = ? AND hidden = 0 AND is_summarized = 0 AND timestamp < ? ORDER BY timestamp ASC LIMIT ?')
            .all(groupId, olderThanTimestamp, limit);
    }

    function countUnsummarizedGroupMessages(groupId, olderThanTimestamp) {
        const row = db.prepare('SELECT COUNT(*) as count FROM group_messages WHERE group_id = ? AND hidden = 0 AND is_summarized = 0 AND timestamp < ?')
            .get(groupId, olderThanTimestamp);
        return row ? row.count : 0;
    }

    function markGroupMessagesSummarized(messageIds) {
        if (!messageIds || messageIds.length === 0) return 0;
        const placeholders = messageIds.map(() => '?').join(', ');
        const info = db.prepare(`UPDATE group_messages SET is_summarized = 1 WHERE id IN (${placeholders})`).run(...messageIds);
        return info.changes;
    }

    function addGroupMessage(groupId, senderId, content, senderName = null, senderAvatar = null, metadata = null) {
        const metadataStr = metadata ? JSON.stringify(metadata) : null;
        let info;
        try {
            info = db.prepare('INSERT INTO group_messages (group_id, sender_id, content, timestamp, sender_name, sender_avatar, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(groupId, senderId, content, Date.now(), senderName, senderAvatar, metadataStr);
        } catch (e) {
            info = db.prepare('INSERT INTO group_messages (group_id, sender_id, content, timestamp, sender_name, sender_avatar) VALUES (?, ?, ?, ?, ?, ?)')
                .run(groupId, senderId, content, Date.now(), senderName, senderAvatar);
        }
        return info.lastInsertRowid;
    }

    function clearGroupMessages(groupId) {
        db.prepare('DELETE FROM group_messages WHERE group_id = ?').run(groupId);
        db.prepare('DELETE FROM char_relationships WHERE source = ?').run(`group:${groupId}`);
        db.prepare('DELETE FROM memories WHERE group_id = ?').run(groupId);
    }

    function deleteGroupMessages(messageIds) {
        if (!messageIds || messageIds.length === 0) return 0;
        const placeholders = messageIds.map(() => '?').join(',');
        const info = db.prepare(`DELETE FROM group_messages WHERE id IN (${placeholders})`).run(...messageIds);
        return info.changes;
    }

    function addGroupMember(groupId, memberId, role = 'member') {
        db.prepare('INSERT OR IGNORE INTO group_members (group_id, member_id, role, joined_at) VALUES (?, ?, ?, ?)').run(groupId, memberId, role, Date.now());
    }

    function removeGroupMember(groupId, memberId) {
        db.prepare('DELETE FROM group_members WHERE group_id = ? AND member_id = ?').run(groupId, memberId);
    }

    function hideGroupMessagesByRange(groupId, startIdx, endIdx) {
        const allMsgs = db.prepare('SELECT id FROM group_messages WHERE group_id = ? ORDER BY timestamp ASC').all(groupId);
        const toHide = allMsgs.slice(startIdx, endIdx + 1).map(m => m.id);
        if (toHide.length === 0) return 0;
        const placeholders = toHide.map(() => '?').join(', ');
        const info = db.prepare(`UPDATE group_messages SET hidden = 1 WHERE id IN (${placeholders})`).run(...toHide);
        return info.changes;
    }

    // Hide an array of exact group message IDs
    function hideGroupMessagesByIds(groupId, messageIds) {
        if (!messageIds || messageIds.length === 0) return 0;
        const placeholders = messageIds.map(() => '?').join(', ');
        const info = db.prepare(`UPDATE group_messages SET hidden = 1 WHERE group_id = ? AND id IN (${placeholders})`).run(groupId, ...messageIds);
        return info.changes;
    }

    function unhideGroupMessages(groupId) {
        const info = db.prepare('UPDATE group_messages SET hidden = 0 WHERE group_id = ?').run(groupId);
        return info.changes;
    }

    // 鈹€鈹€鈹€ Character Management 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    function deleteCharacter(id) {
        db.prepare('DELETE FROM messages WHERE character_id = ?').run(id);
        db.prepare('DELETE FROM memories WHERE character_id = ?').run(id);
        // clean up moment interactions authored by this character
        const charMoments = db.prepare('SELECT id FROM moments WHERE character_id=?').all(id);
        for (const m of charMoments) {
            db.prepare('DELETE FROM moment_likes WHERE moment_id=?').run(m.id);
            db.prepare('DELETE FROM moment_comments WHERE moment_id=?').run(m.id);
        }
        db.prepare('DELETE FROM moment_likes WHERE liker_id=?').run(id);
        db.prepare('DELETE FROM moment_comments WHERE author_id=?').run(id);
        db.prepare('DELETE FROM moments WHERE character_id = ?').run(id);
        db.prepare('DELETE FROM diaries WHERE character_id = ?').run(id);
        db.prepare('DELETE FROM character_friends WHERE char1_id = ? OR char2_id = ?').run(id, id);
        db.prepare('DELETE FROM char_relationships WHERE source_id = ? OR target_id = ?').run(id, id);
        db.prepare('DELETE FROM group_members WHERE member_id = ?').run(id); // Auto-kick from groups
        db.prepare('DELETE FROM characters WHERE id = ?').run(id);
    }

    // 鈹€鈹€鈹€ Character Relationships (Inter-char Social System) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    function initCharRelationship(sourceId, targetId, affinity, impression, source = 'recommend') {
        const safeImpression = impression || '';
        // Check existing record to avoid duplicate history entries
        const existing = db.prepare('SELECT affinity, impression FROM char_relationships WHERE source_id = ? AND target_id = ? AND source = ?')
            .get(sourceId, targetId, source);

        db.prepare(`INSERT OR REPLACE INTO char_relationships (source_id, target_id, affinity, impression, source) VALUES (?, ?, ?, ?, ?)`)
            .run(sourceId, targetId, affinity, safeImpression, source);

        // Only add history if: impression changed AND (affinity changed by 鈮? OR it's a brand new relationship)
        const impressionChanged = !existing || existing.impression !== safeImpression;
        const affinityDelta = existing ? Math.abs(affinity - existing.affinity) : 999;
        if (safeImpression.trim() !== '' && impressionChanged && (!existing || affinityDelta >= 5)) {
            addCharImpressionHistory(sourceId, targetId, safeImpression, `Formed: ${source}`);
        }
    }

    function getCharRelationship(sourceId, targetId) {
        // Returns all relationship records between source鈫抰arget (may have multiple sources)
        const rows = db.prepare('SELECT * FROM char_relationships WHERE source_id = ? AND target_id = ?').all(sourceId, targetId);
        if (rows.length === 0) return null;
        // Merge: total affinity = recommend base + sum of group deltas
        const recommend = rows.find(r => r.source === 'recommend');
        const groupRows = rows.filter(r => r.source !== 'recommend');
        const totalAffinity = (recommend?.affinity || 50) + groupRows.reduce((sum, r) => sum + (r.affinity - 50), 0);

        // Fetch the most recent impression from history
        const history = getCharImpressionHistory(sourceId, targetId, 1);
        const latestImpression = history.length > 0 ? history[0].impression : (recommend?.impression || groupRows[0]?.impression || '');

        return {
            sourceId, targetId,
            affinity: Math.max(0, Math.min(100, totalAffinity)),
            impression: latestImpression,
            isAcquainted: !!recommend,
            sources: rows
        };
    }

    function getCharRelationships(charId) {
        // Get all unique targets this char has a relationship with
        const rows = db.prepare('SELECT DISTINCT target_id FROM char_relationships WHERE source_id = ?').all(charId);
        return rows.map(r => getCharRelationship(charId, r.target_id)).filter(Boolean);
    }

    function updateCharRelationship(sourceId, targetId, source, data) {
        const existing = db.prepare('SELECT * FROM char_relationships WHERE source_id = ? AND target_id = ? AND source = ?').get(sourceId, targetId, source);
        if (existing) {
            const fields = [];
            const values = [];
            if (data.affinity !== undefined) { fields.push('affinity = ?'); values.push(data.affinity); }
            if (data.impression !== undefined) {
                fields.push('impression = ?');
                values.push(data.impression);

                // Only log history if impression text actually changed AND affinity shifted by 鈮?
                const affinityDelta = data.affinity !== undefined ? Math.abs(data.affinity - existing.affinity) : 0;
                if (data.impression !== existing.impression && String(data.impression).trim() !== '' && affinityDelta >= 5) {
                    addCharImpressionHistory(sourceId, targetId, data.impression, `Updated: ${source}`);
                }
            }
            if (fields.length > 0) {
                values.push(sourceId, targetId, source);
                db.prepare(`UPDATE char_relationships SET ${fields.join(', ')} WHERE source_id = ? AND target_id = ? AND source = ?`).run(...values);
            }
        } else {
            // Auto-create if doesn't exist
            initCharRelationship(sourceId, targetId, data.affinity || 50, data.impression || '', source);
        }
    }

    function addCharImpressionHistory(sourceId, targetId, impression, triggerEvent) {
        db.prepare('INSERT INTO char_impression_history (source_id, target_id, impression, trigger_event, timestamp) VALUES (?, ?, ?, ?, ?)')
            .run(sourceId, targetId, impression, triggerEvent, Date.now());
    }

    function getCharImpressionHistory(sourceId, targetId, limit = 50) {
        return db.prepare('SELECT * FROM char_impression_history WHERE source_id = ? AND target_id = ? ORDER BY timestamp DESC LIMIT ?')
            .all(sourceId, targetId, limit);
    }

    function deleteGroupRelationships(groupId) {
        db.prepare('DELETE FROM char_relationships WHERE source = ?').run(`group:${groupId}`);
    }

    // 鈹€鈹€鈹€ Private Transfer System 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    function createTransfer({ charId, senderId, recipientId, amount, note, messageId }) {
        // Deduct from sender wallet
        if (senderId === 'user') {
            const profile = db.prepare('SELECT wallet FROM user_profile WHERE id = ?').get('default');
            const bal = profile?.wallet ?? 520;
            if (bal < amount) throw new Error('余额不足');
            db.prepare('UPDATE user_profile SET wallet = ? WHERE id = ?').run(+(bal - amount).toFixed(2), 'default');
        } else {
            const char = db.prepare('SELECT wallet FROM characters WHERE id = ?').get(senderId);
            const bal = char?.wallet ?? 0;
            if (bal < amount) throw new Error('余额不足');
            db.prepare('UPDATE characters SET wallet = ? WHERE id = ?').run(+(bal - amount).toFixed(2), senderId);
        }
        const info = db.prepare(
            'INSERT INTO private_transfers (char_id, sender_id, recipient_id, amount, note, claimed, message_id, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)'
        ).run(charId, senderId, recipientId, amount, note || '', messageId ?? null, Date.now());
        return info.lastInsertRowid;
    }

    function getTransfer(transferId) {
        return db.prepare('SELECT * FROM private_transfers WHERE id = ?').get(transferId);
    }

    function claimTransfer(transferId, claimerId) {
        const t = db.prepare('SELECT * FROM private_transfers WHERE id = ?').get(transferId);
        if (!t) return { success: false, error: '转账不存在' };
        if (t.claimed) return { success: false, error: '已经领取过了' };
        if (t.refunded) return { success: false, error: '已经退回了' };
        if (t.recipient_id !== claimerId) return { success: false, error: '不是这笔转账的收款方' };

        db.prepare('UPDATE private_transfers SET claimed = 1, claimed_at = ? WHERE id = ?').run(Date.now(), transferId);

        // Credit to recipient
        if (claimerId === 'user') {
            const profile = db.prepare('SELECT wallet FROM user_profile WHERE id = ?').get('default');
            const bal = profile?.wallet ?? 520;
            db.prepare('UPDATE user_profile SET wallet = ? WHERE id = ?').run(+(bal + t.amount).toFixed(2), 'default');
        } else {
            const char = db.prepare('SELECT wallet FROM characters WHERE id = ?').get(claimerId);
            const bal = char?.wallet ?? 0;
            db.prepare('UPDATE characters SET wallet = ? WHERE id = ?').run(+(bal + t.amount).toFixed(2), claimerId);
        }
        return { success: true, amount: t.amount };
    }

    function getUnclaimedTransfersFrom(senderId, charId) {
        return db.prepare(
            'SELECT * FROM private_transfers WHERE sender_id = ? AND char_id = ? AND claimed = 0 AND refunded = 0 AND created_at > ? ORDER BY created_at DESC'
        ).all(senderId, charId, Date.now() - 24 * 60 * 60 * 1000); // last 24h
    }

    function refundTransfer(transferId, refunderId) {
        const t = db.prepare('SELECT * FROM private_transfers WHERE id = ?').get(transferId);
        if (!t) return { success: false, error: '转账不存在' };
        if (t.refunded) return { success: false, error: '已经退回过了' };
        // Allow sender to refund anytime if still pending, allow recipient to refund anytime
        const canRefund = (refunderId === t.sender_id && !t.claimed) || (refunderId === t.recipient_id);
        if (!canRefund) return { success: false, error: '无权退回' };

        db.prepare('UPDATE private_transfers SET refunded = 1, claimed = 0 WHERE id = ?').run(transferId);

        // Return money to original sender
        if (t.sender_id === 'user') {
            const profile = db.prepare('SELECT wallet FROM user_profile WHERE id = ?').get('default');
            const bal = profile?.wallet ?? 520;
            db.prepare('UPDATE user_profile SET wallet = ? WHERE id = ?').run(+(bal + t.amount).toFixed(2), 'default');
        } else {
            const char = db.prepare('SELECT wallet FROM characters WHERE id = ?').get(t.sender_id);
            const bal = char?.wallet ?? 0;
            db.prepare('UPDATE characters SET wallet = ? WHERE id = ?').run(+(bal + t.amount).toFixed(2), t.sender_id);
        }
        // If the recipient had already claimed, also deduct from their wallet
        if (t.claimed) {
            if (t.recipient_id === 'user') {
                const profile = db.prepare('SELECT wallet FROM user_profile WHERE id = ?').get('default');
                const bal = profile?.wallet ?? 0;
                db.prepare('UPDATE user_profile SET wallet = ? WHERE id = ?').run(Math.max(0, +(bal - t.amount).toFixed(2)), 'default');
            } else {
                const char = db.prepare('SELECT wallet FROM characters WHERE id = ?').get(t.recipient_id);
                const bal = char?.wallet ?? 0;
                db.prepare('UPDATE characters SET wallet = ? WHERE id = ?').run(Math.max(0, +(bal - t.amount).toFixed(2)), t.recipient_id);
            }
        }
        return { success: true, amount: t.amount, senderId: t.sender_id };
    }

    // 鈹€鈹€鈹€ Red Packet System 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    // Generates lucky (拼手气) amounts: random splits of total into N pieces, min 0.01 each
    function generateLuckyAmounts(total, count) {
        const amounts = [];
        let remaining = Math.round(total * 100); // work in cents to avoid float issues
        for (let i = 0; i < count - 1; i++) {
            const maxCents = Math.floor(remaining * 2 / (count - i));
            const cents = Math.max(1, Math.floor(Math.random() * maxCents) + 1);
            const safe = Math.min(cents, remaining - (count - i - 1));
            amounts.push(safe);
            remaining -= safe;
        }
        amounts.push(remaining);
        // Fisher-Yates shuffle
        for (let i = amounts.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [amounts[i], amounts[j]] = [amounts[j], amounts[i]];
        }
        return amounts.map(c => +(c / 100).toFixed(2));
    }

    function createRedPacket({ groupId, senderId, type, totalAmount, perAmount, count, note }) {
        // Deduct from sender wallet
        if (senderId === 'user') {
            const profile = db.prepare('SELECT wallet FROM user_profile WHERE id = ?').get('default');
            const bal = profile?.wallet ?? 520;
            if (bal < totalAmount) throw new Error('余额不足');
            db.prepare('UPDATE user_profile SET wallet = ? WHERE id = ?').run(+(bal - totalAmount).toFixed(2), 'default');
        } else {
            const char = db.prepare('SELECT wallet FROM characters WHERE id = ?').get(senderId);
            const bal = char?.wallet ?? 0;
            if (bal < totalAmount) throw new Error('余额不足');
            db.prepare('UPDATE characters SET wallet = ? WHERE id = ?').run(+(bal - totalAmount).toFixed(2), senderId);
        }

        // Pre-generate amounts
        let amounts;
        if (type === 'lucky') {
            amounts = generateLuckyAmounts(totalAmount, count);
        } else {
            const each = perAmount ?? +(totalAmount / count).toFixed(2);
            amounts = Array(count).fill(each);
        }

        const info = db.prepare(
            'INSERT INTO group_red_packets (group_id, sender_id, type, total_amount, per_amount, count, remaining_count, amounts, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(groupId, senderId, type, totalAmount, perAmount ?? null, count, count, JSON.stringify(amounts), note || '', Date.now());
        return info.lastInsertRowid;
    }

    function getRedPacket(packetId) {
        const pkt = db.prepare('SELECT * FROM group_red_packets WHERE id = ?').get(packetId);
        if (!pkt) return null;
        pkt.amounts = JSON.parse(pkt.amounts);
        pkt.claims = db.prepare('SELECT * FROM group_red_packet_claims WHERE packet_id = ? ORDER BY claimed_at ASC').all(packetId);
        return pkt;
    }

    // Returns { success, amount, error }
    function claimRedPacket(packetId, claimerId) {
        const pkt = db.prepare('SELECT * FROM group_red_packets WHERE id = ?').get(packetId);
        if (!pkt) return { success: false, error: '红包不存在' };
        if (pkt.remaining_count <= 0) return { success: false, error: '红包已经被抢光' };

        const already = db.prepare('SELECT id FROM group_red_packet_claims WHERE packet_id = ? AND claimer_id = ?').get(packetId, claimerId);
        if (already) return { success: false, error: '你已经领过了' };

        // Pick next available amount (in order, pre-shuffled)
        const claimedCount = pkt.count - pkt.remaining_count;
        const amounts = JSON.parse(pkt.amounts);
        const amount = amounts[claimedCount];

        // Atomic update
        db.prepare('UPDATE group_red_packets SET remaining_count = remaining_count - 1 WHERE id = ?').run(packetId);
        db.prepare('INSERT INTO group_red_packet_claims (packet_id, claimer_id, amount, claimed_at) VALUES (?, ?, ?, ?)').run(packetId, claimerId, amount, Date.now());

        // Credit to claimer wallet
        if (claimerId === 'user') {
            const profile = db.prepare('SELECT wallet FROM user_profile WHERE id = ?').get('default');
            const bal = profile?.wallet ?? 520;
            db.prepare('UPDATE user_profile SET wallet = ? WHERE id = ?').run(+(bal + amount).toFixed(2), 'default');
        } else {
            const char = db.prepare('SELECT wallet FROM characters WHERE id = ?').get(claimerId);
            const bal = char?.wallet ?? 0;
            db.prepare('UPDATE characters SET wallet = ? WHERE id = ?').run(+(bal + amount).toFixed(2), claimerId);
        }

        return { success: true, amount };
    }

    // Get unclaimed red packets in a group for a specific character
    function getUnclaimedRedPacketsForGroup(groupId, claimerId) {
        const packets = db.prepare(
            'SELECT * FROM group_red_packets WHERE group_id = ? AND remaining_count > 0'
        ).all(groupId);
        return packets.filter(pkt => {
            const already = db.prepare(
                'SELECT id FROM group_red_packet_claims WHERE packet_id = ? AND claimer_id = ?'
            ).get(pkt.id, claimerId);
            return !already;
        });
    }

    function getWallet(id) {
        if (id === 'user') {
            const p = db.prepare('SELECT wallet FROM user_profile WHERE id = ?').get('default');
            return +(p?.wallet ?? 520).toFixed(2);
        }
        const c = db.prepare('SELECT wallet FROM characters WHERE id = ?').get(id);
        return +(c?.wallet ?? 0).toFixed(2);
    }

    function isCharAcquainted(charId, targetId) {
        const row = db.prepare("SELECT 1 FROM char_relationships WHERE source_id = ? AND target_id = ? AND source = 'recommend'").get(charId, targetId);
        return !!row;
    }


    // --- END ENCLOSED DB FUNCTIONS ---

    // Generic SQL runner for plugin-level updates
    function rawRun(sql, params = []) {
        return db.prepare(sql).run(...params);
    }

    // --- Token Tracking ---
    function addTokenUsage(characterId, contextType, promptTokens, completionTokens) {
        try {
            const stmt = db.prepare('INSERT INTO token_usage (character_id, context_type, prompt_tokens, completion_tokens, timestamp) VALUES (?, ?, ?, ?, ?)');
            stmt.run(characterId, contextType, promptTokens, completionTokens, Date.now());
        } catch (e) {
            console.error('[DB] Error logging token usage:', e.message);
        }
    }

    const dbInstance = {

        rawRun,
        addTokenUsage,
        initDb,
        getCharacters,
        getCharacter,
        getCharacterHiddenState,
        updateCharacterHiddenState,
        updateCharacter,
        deleteCharacter,
        getMessages,
        getMessagesBefore,
        getVisibleMessages,
        getVisibleMessagesSince,
        getUnsummarizedMessages,
        countUnsummarizedMessages,
        markMessagesSummarized,
        hideMessagesByRange,
        hideMessagesByIds,
        unhideMessages,
        addMessage,
        deleteMessage,
        markMessagesRead,
        getUnreadCount,
        clearMessages,
        clearMemories,
        clearMoments,
        clearDiaries,
        exportCharacterData,
        getMemories,
        getMemory,
        addMemory,
        updateMemory,
        deleteMemory,
        getMoments,
        getMomentsSince,
        getCharacterMoments,
        addMoment,
        deleteMoment,
        toggleLike,
        getLikesForMoment,
        addComment,
        getComments,
        getDiaries,
        addDiary,
        deleteDiary,
        unlockDiaries,
        setDiaryPassword,
        verifyAndUnlockDiary,
        getUserProfile,
        updateUserProfile,
        addFriend,
        clearFriends,
        clearCharRelationships,
        clearTransfers,
        clearMomentInteractions,
        getFriends,
        isFriend,
        createGroup,
        getGroups,
        getGroup,
        deleteGroup,
        getGroupMessages,
        addGroupMessage,
        clearGroupMessages,
        deleteGroupMessages,
        addGroupMember,
        removeGroupMember,
        getVisibleGroupMessages,
        getUnsummarizedGroupMessages,
        countUnsummarizedGroupMessages,
        markGroupMessagesSummarized,
        hideGroupMessagesByRange,
        hideGroupMessagesByIds,
        unhideGroupMessages,
        initCharRelationship,
        getCharRelationship,
        getCharRelationships,
        updateCharRelationship,
        addCharImpressionHistory,
        getCharImpressionHistory,
        deleteGroupRelationships,
        isCharAcquainted,
        // Private Transfer
        createTransfer,
        getTransfer,
        claimTransfer,
        refundTransfer,
        getUnclaimedTransfersFrom,
        // Red Packet
        createRedPacket,
        getRedPacket,
        claimRedPacket,
        getUnclaimedRedPacketsForGroup,
        getWallet,
        getMomentsContextForChar,
        getRawDb: () => db,
        close: () => db.close(),
        getDbPath: () => dbPath,
        checkpoint: () => {
            try { db.pragma('wal_checkpoint(RESTART)'); } catch (e) { }
        },
        backup: async (destPath) => {
            db.pragma('wal_checkpoint(TRUNCATE)');
            return db.backup(destPath);
        }
    };

    initDb(); // auto-initialize tables for this user's db if they don't exist

    userDbCache.set(userId, dbInstance);
    return dbInstance;
}

module.exports = { getUserDb, userDbCache };
