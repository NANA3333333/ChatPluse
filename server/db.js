const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const userDbCache = new Map();
const deletingUserDbIds = new Set();

function getUserDb(userId) {
    if (!userId) throw new Error("getUserDb requires a valid userId");
    if (deletingUserDbIds.has(String(userId))) {
        throw new Error(`User DB is being deleted: ${userId}`);
    }
    if (userDbCache.has(userId)) return userDbCache.get(userId);

    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    const dbPath = path.join(dataDir, `chatpulse_user_${userId}.db`);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // --- ENCLOSED DB FUNCTIONS ---


    function safeParseJson(value, fallback) {
        if (value == null || value === '') return fallback;
        if (typeof value !== 'string') return value;
        try {
            return JSON.parse(value);
        } catch (e) {
            return fallback;
        }
    }

    function normalizeArrayField(value, fallback = []) {
        if (Array.isArray(value)) {
            return value.filter(Boolean);
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return fallback;
            const parsed = safeParseJson(trimmed, null);
            if (Array.isArray(parsed)) return parsed.filter(Boolean);
            return trimmed.split(/[,，、\n]/).map(v => v.trim()).filter(Boolean);
        }
        return fallback;
    }

    function normalizeRelationshipField(value, fallback = []) {
        if (Array.isArray(value)) return value.filter(Boolean);
        if (value && typeof value === 'object') return [value];
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return fallback;
            const parsed = safeParseJson(trimmed, null);
            if (Array.isArray(parsed)) return parsed.filter(Boolean);
            if (parsed && typeof parsed === 'object') return [parsed];
            return [{ summary: trimmed }];
        }
        return fallback;
    }

    function stringifyJson(value, fallback = '[]') {
        try {
            return JSON.stringify(value);
        } catch (e) {
            return fallback;
        }
    }

    function normalizeMemoryRow(row) {
        if (!row) return row;
        const peopleList = normalizeArrayField(row.people_json ?? row.people, []);
        const itemList = normalizeArrayField(row.items_json ?? row.items, []);
        const relationshipList = normalizeRelationshipField(row.relationship_json ?? row.relationships, []);
        const sourceMessageIds = normalizeArrayField(row.source_message_ids_json, []);
        const summary = (row.summary || row.event || '').trim();
        const content = (row.content || row.event || summary).trim();
        return {
            ...row,
            memory_type: row.memory_type || 'event',
            memory_tier: row.memory_tier || 'ambient',
            memory_focus: row.memory_focus || 'general',
            summary,
            content,
            people_json: peopleList,
            items_json: itemList,
            relationship_json: relationshipList,
            source_message_ids_json: sourceMessageIds,
            people: row.people || peopleList.join(', '),
            items: row.items || itemList.join(', '),
            relationships: row.relationships || relationshipList.map(rel => {
                if (typeof rel === 'string') return rel;
                return rel.summary || rel.type || JSON.stringify(rel);
            }).join('; '),
            event: row.event || summary || content,
            emotion: row.emotion || '',
            dedupe_key: row.dedupe_key || '',
            updated_at: row.updated_at || row.created_at || Date.now(),
            is_archived: Number(row.is_archived || 0),
            source_started_at: Number(row.source_started_at || 0),
            source_ended_at: Number(row.source_ended_at || 0),
            source_time_text: row.source_time_text || '',
            source_message_count: Number(row.source_message_count || 0)
        };
    }

    function normalizeConversationDigestRow(row) {
        if (!row) return row;
        return {
            ...row,
            relationship_state_json: normalizeArrayField(row.relationship_state_json, []),
            open_loops_json: normalizeArrayField(row.open_loops_json, []),
            recent_facts_json: normalizeArrayField(row.recent_facts_json, []),
            scene_state_json: normalizeArrayField(row.scene_state_json, []),
            last_message_id: Number(row.last_message_id || 0),
            hit_count: Number(row.hit_count || 0),
            created_at: Number(row.created_at || row.updated_at || 0),
            last_hit_at: Number(row.last_hit_at || 0),
            updated_at: Number(row.updated_at || 0)
        };
    }

    function normalizeGroupConversationDigestRow(row) {
        if (!row) return row;
        return {
            ...row,
            relationship_state_json: normalizeArrayField(row.relationship_state_json, []),
            open_loops_json: normalizeArrayField(row.open_loops_json, []),
            recent_facts_json: normalizeArrayField(row.recent_facts_json, []),
            scene_state_json: normalizeArrayField(row.scene_state_json, []),
            last_message_id: Number(row.last_message_id || 0),
            hit_count: Number(row.hit_count || 0),
            created_at: Number(row.created_at || row.updated_at || 0),
            last_hit_at: Number(row.last_hit_at || 0),
            updated_at: Number(row.updated_at || 0)
        };
    }

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
            city_reply_pending INTEGER DEFAULT 0,
            city_ignore_streak INTEGER DEFAULT 0,
            city_last_outreach_at INTEGER DEFAULT 0,
            city_post_ignore_reaction INTEGER DEFAULT 0,
            city_status_started_at INTEGER DEFAULT 0,
            city_status_until_at INTEGER DEFAULT 0,
            city_medical_last_recovery_at INTEGER DEFAULT 0,
            stat_int INTEGER DEFAULT 50,
            stat_sta INTEGER DEFAULT 50,
            stat_cha INTEGER DEFAULT 50,
            energy INTEGER DEFAULT 100,
            sleep_debt INTEGER DEFAULT 0,
            sleep_pressure INTEGER DEFAULT 20,
            mood INTEGER DEFAULT 50,
            stress INTEGER DEFAULT 20,
            social_need INTEGER DEFAULT 50,
            explicit_emotion_state TEXT DEFAULT '',
            health INTEGER DEFAULT 100,
            satiety INTEGER DEFAULT 45,
            stomach_load INTEGER DEFAULT 0,
            work_distraction INTEGER DEFAULT 0,
            sleep_disruption INTEGER DEFAULT 0,
            llm_debug_capture INTEGER DEFAULT 0,
            sweep_limit INTEGER DEFAULT 30,
            sweep_initialized INTEGER DEFAULT 1,
            sweep_last_error TEXT DEFAULT '',
            sweep_last_run_at INTEGER DEFAULT 0,
            sweep_last_success_at INTEGER DEFAULT 0,
            sweep_last_saved_count INTEGER DEFAULT 0,
            impression_q_limit INTEGER DEFAULT 3,
            context_msg_limit INTEGER DEFAULT 60
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
            last_retrieved_at INTEGER,
            retrieval_count INTEGER DEFAULT 0,
            group_id TEXT DEFAULT NULL,
            memory_type TEXT DEFAULT 'event',
            summary TEXT DEFAULT '',
            content TEXT DEFAULT '',
            people_json TEXT DEFAULT '[]',
            items_json TEXT DEFAULT '[]',
            relationship_json TEXT DEFAULT '[]',
            emotion TEXT DEFAULT '',
            source_message_ids_json TEXT DEFAULT '[]',
            dedupe_key TEXT DEFAULT '',
            updated_at INTEGER DEFAULT 0,
            is_archived INTEGER DEFAULT 0,
            source_started_at INTEGER DEFAULT 0,
            source_ended_at INTEGER DEFAULT 0,
            source_time_text TEXT DEFAULT '',
            source_message_count INTEGER DEFAULT 0,
            memory_tier TEXT DEFAULT 'ambient',
            memory_focus TEXT DEFAULT 'general',
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

        CREATE TABLE IF NOT EXISTS llm_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cache_key TEXT NOT NULL UNIQUE,
            cache_type TEXT NOT NULL DEFAULT 'generic',
            cache_scope TEXT DEFAULT '',
            character_id TEXT DEFAULT '',
            model TEXT DEFAULT '',
            prompt_hash TEXT DEFAULT '',
            prompt_preview TEXT DEFAULT '',
            response_text TEXT DEFAULT '',
            response_meta TEXT DEFAULT '{}',
            prompt_tokens INTEGER DEFAULT 0,
            completion_tokens INTEGER DEFAULT 0,
            hit_count INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_hit_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_llm_cache_type_expires ON llm_cache(cache_type, expires_at);
        CREATE INDEX IF NOT EXISTS idx_llm_cache_last_hit ON llm_cache(last_hit_at);

        CREATE TABLE IF NOT EXISTS llm_cache_stats (
            scope TEXT PRIMARY KEY,
            lookup_count INTEGER NOT NULL DEFAULT 0,
            hit_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS emotion_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            source TEXT NOT NULL,
            reason TEXT DEFAULT '',
            old_state TEXT DEFAULT '',
            new_state TEXT DEFAULT '',
            old_mood INTEGER,
            new_mood INTEGER,
            old_stress INTEGER,
            new_stress INTEGER,
            old_social_need INTEGER,
            new_social_need INTEGER,
            old_pressure INTEGER,
            new_pressure INTEGER,
            old_jealousy INTEGER,
            new_jealousy INTEGER,
            timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS llm_debug_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            direction TEXT NOT NULL,
            context_type TEXT DEFAULT 'chat',
            payload TEXT NOT NULL,
            meta TEXT DEFAULT '{}',
            timestamp INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS reply_dispatch_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'unknown',
            route TEXT NOT NULL DEFAULT '',
            request_id TEXT NOT NULL DEFAULT '',
            latest_user_message_id INTEGER,
            latest_user_message_timestamp INTEGER,
            payload TEXT NOT NULL DEFAULT '{}',
            note TEXT NOT NULL DEFAULT '',
            timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reply_dispatch_logs_char_time
            ON reply_dispatch_logs(character_id, timestamp DESC);

        CREATE TABLE IF NOT EXISTS prompt_block_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            block_type TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            compiled_text TEXT NOT NULL,
            hit_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            last_hit_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            UNIQUE(character_id, block_type)
        );
        CREATE INDEX IF NOT EXISTS idx_prompt_block_cache_lookup ON prompt_block_cache(character_id, block_type, source_hash);

        CREATE TABLE IF NOT EXISTS history_window_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL,
            window_type TEXT NOT NULL,
            window_size INTEGER NOT NULL DEFAULT 0,
            source_hash TEXT NOT NULL,
            message_ids_json TEXT NOT NULL DEFAULT '[]',
            compiled_json TEXT NOT NULL DEFAULT '[]',
            hit_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            last_hit_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            UNIQUE(character_id, window_type, window_size)
        );
        CREATE INDEX IF NOT EXISTS idx_history_window_cache_lookup ON history_window_cache(character_id, window_type, window_size, source_hash);

        CREATE TABLE IF NOT EXISTS conversation_digest_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            character_id TEXT NOT NULL UNIQUE,
            source_hash TEXT NOT NULL DEFAULT '',
            digest_text TEXT NOT NULL DEFAULT '',
            emotion_state TEXT NOT NULL DEFAULT '',
            relationship_state_json TEXT NOT NULL DEFAULT '[]',
            open_loops_json TEXT NOT NULL DEFAULT '[]',
            recent_facts_json TEXT NOT NULL DEFAULT '[]',
            scene_state_json TEXT NOT NULL DEFAULT '[]',
            last_message_id INTEGER NOT NULL DEFAULT 0,
            hit_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            last_hit_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_digest_lookup ON conversation_digest_cache(character_id, source_hash);

        CREATE TABLE IF NOT EXISTS group_conversation_digest_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT NOT NULL,
            character_id TEXT NOT NULL,
            source_hash TEXT NOT NULL DEFAULT '',
            digest_text TEXT NOT NULL DEFAULT '',
            emotion_state TEXT NOT NULL DEFAULT '',
            relationship_state_json TEXT NOT NULL DEFAULT '[]',
            open_loops_json TEXT NOT NULL DEFAULT '[]',
            recent_facts_json TEXT NOT NULL DEFAULT '[]',
            scene_state_json TEXT NOT NULL DEFAULT '[]',
            last_message_id INTEGER NOT NULL DEFAULT 0,
            hit_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0,
            last_hit_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            UNIQUE(group_id, character_id)
        );
        CREATE INDEX IF NOT EXISTS idx_group_conversation_digest_lookup ON group_conversation_digest_cache(group_id, character_id, source_hash);

        CREATE TABLE IF NOT EXISTS group_chats (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            avatar TEXT,
            context_msg_limit INTEGER DEFAULT 60,
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
            db.prepare("ALTER TABLE characters ADD COLUMN emoji TEXT DEFAULT '👤'").run();
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

        // Add context_msg_limit for group_chats
        try {
            db.prepare('ALTER TABLE group_chats ADD COLUMN context_msg_limit INTEGER DEFAULT 60').run();
        } catch (e) { }

        // Memory retrieval stats
        try {
            db.prepare('ALTER TABLE memories ADD COLUMN last_retrieved_at INTEGER').run();
        } catch (e) { }
        try {
            db.prepare('ALTER TABLE memories ADD COLUMN retrieval_count INTEGER DEFAULT 0').run();
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

        // Add context_msg_limit for characters
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN context_msg_limit INTEGER DEFAULT 60').run();
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

        // Existing characters should start W from zero after upgrade; new characters default to initialized
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN sweep_initialized INTEGER DEFAULT 1').run();
            db.prepare('UPDATE characters SET sweep_initialized = 0').run();
        } catch (e) {
        }
        try {
            db.prepare("ALTER TABLE characters ADD COLUMN sweep_last_error TEXT DEFAULT ''").run();
        } catch (e) {
        }
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN sweep_last_run_at INTEGER DEFAULT 0').run();
        } catch (e) {
        }
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN sweep_last_success_at INTEGER DEFAULT 0').run();
        } catch (e) {
        }
        try {
            db.prepare('ALTER TABLE characters ADD COLUMN sweep_last_saved_count INTEGER DEFAULT 0').run();
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

        // Upgrade memories table for structured long-term memory storage
        try { db.prepare('ALTER TABLE memories ADD COLUMN group_id TEXT DEFAULT NULL').run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN memory_type TEXT DEFAULT 'event'").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN summary TEXT DEFAULT ''").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN content TEXT DEFAULT ''").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN people_json TEXT DEFAULT '[]'").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN items_json TEXT DEFAULT '[]'").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN relationship_json TEXT DEFAULT '[]'").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN emotion TEXT DEFAULT ''").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN source_message_ids_json TEXT DEFAULT '[]'").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN dedupe_key TEXT DEFAULT ''").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN updated_at INTEGER DEFAULT 0").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN is_archived INTEGER DEFAULT 0").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN source_started_at INTEGER DEFAULT 0").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN source_ended_at INTEGER DEFAULT 0").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN source_time_text TEXT DEFAULT ''").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN source_message_count INTEGER DEFAULT 0").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN memory_tier TEXT DEFAULT 'ambient'").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE memories ADD COLUMN memory_focus TEXT DEFAULT 'general'").run(); } catch (e) { }
        try {
            db.prepare(`
                UPDATE memories
                SET
                    summary = CASE WHEN COALESCE(summary, '') = '' THEN COALESCE(event, '') ELSE summary END,
                    content = CASE WHEN COALESCE(content, '') = '' THEN COALESCE(event, '') ELSE content END,
                    people_json = CASE WHEN COALESCE(people_json, '') = '' THEN json_array() ELSE people_json END,
                    items_json = CASE WHEN COALESCE(items_json, '') = '' THEN json_array() ELSE items_json END,
                    relationship_json = CASE WHEN COALESCE(relationship_json, '') = '' THEN json_array() ELSE relationship_json END,
                    source_message_ids_json = CASE WHEN COALESCE(source_message_ids_json, '') = '' THEN json_array() ELSE source_message_ids_json END,
                    updated_at = CASE WHEN COALESCE(updated_at, 0) = 0 THEN COALESCE(created_at, strftime('%s','now') * 1000) ELSE updated_at END,
                    source_started_at = CASE WHEN COALESCE(source_started_at, 0) = 0 THEN COALESCE(created_at, 0) ELSE source_started_at END,
                    source_ended_at = CASE WHEN COALESCE(source_ended_at, 0) = 0 THEN COALESCE(updated_at, created_at, 0) ELSE source_ended_at END,
                    source_time_text = CASE WHEN COALESCE(source_time_text, '') = '' AND COALESCE(time, '') <> '' THEN COALESCE(time, '') ELSE source_time_text END,
                    source_message_count = CASE WHEN COALESCE(source_message_count, 0) = 0 THEN CASE WHEN json_valid(source_message_ids_json) THEN json_array_length(source_message_ids_json) ELSE 0 END ELSE source_message_count END,
                    memory_tier = CASE WHEN COALESCE(memory_tier, '') = '' THEN 'ambient' ELSE memory_tier END,
                    memory_focus = CASE WHEN COALESCE(memory_focus, '') = '' THEN 'general' ELSE memory_focus END
            `).run();
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
        try { db.prepare('ALTER TABLE user_profile ADD COLUMN response_style_constitution TEXT DEFAULT ""').run(); } catch (e) { }

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
        try { db.prepare('ALTER TABLE characters ADD COLUMN city_reply_pending INTEGER DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN city_ignore_streak INTEGER DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN city_last_outreach_at INTEGER DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN city_post_ignore_reaction INTEGER DEFAULT 0').run(); } catch (e) { }

        // City DLC: per-character toggle for city event notifications to private chat
        try { db.prepare('ALTER TABLE characters ADD COLUMN sys_city_notify INTEGER DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN sys_city_social INTEGER DEFAULT 1').run(); } catch (e) { }
        // City DLC: schedule & activity frequency
        try { db.prepare('ALTER TABLE characters ADD COLUMN is_scheduled INTEGER DEFAULT 1').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN city_action_frequency INTEGER DEFAULT 1').run(); } catch (e) { }

        // Character Base Stats
        try { db.prepare('ALTER TABLE characters ADD COLUMN stat_int INTEGER DEFAULT 50').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN stat_sta INTEGER DEFAULT 50').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN stat_cha INTEGER DEFAULT 50').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN energy INTEGER DEFAULT 100').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN sleep_debt INTEGER DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN sleep_pressure INTEGER DEFAULT 20').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN mood INTEGER DEFAULT 50').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN stress INTEGER DEFAULT 20').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN social_need INTEGER DEFAULT 50').run(); } catch (e) { }
        try { db.prepare("ALTER TABLE characters ADD COLUMN explicit_emotion_state TEXT DEFAULT ''").run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN health INTEGER DEFAULT 100').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN satiety INTEGER DEFAULT 45').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN stomach_load INTEGER DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN work_distraction INTEGER DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN sleep_disruption INTEGER DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE characters ADD COLUMN llm_debug_capture INTEGER DEFAULT 0').run(); } catch (e) { }
        try { db.prepare("ALTER TABLE llm_cache ADD COLUMN cache_scope TEXT DEFAULT ''").run(); } catch (e) { }
        try { db.prepare("ALTER TABLE llm_cache ADD COLUMN character_id TEXT DEFAULT ''").run(); } catch (e) { }
        try { db.prepare('CREATE INDEX IF NOT EXISTS idx_llm_cache_character ON llm_cache(character_id, expires_at)').run(); } catch (e) { }
        try { db.prepare('CREATE TABLE IF NOT EXISTS llm_cache_stats (scope TEXT PRIMARY KEY, lookup_count INTEGER NOT NULL DEFAULT 0, hit_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE prompt_block_cache ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE prompt_block_cache ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE prompt_block_cache ADD COLUMN last_hit_at INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE history_window_cache ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE history_window_cache ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { }
        try { db.prepare('ALTER TABLE history_window_cache ADD COLUMN last_hit_at INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { }

        console.log('[DB] Database initialized successfully.');
    }

    function repairHistoryWindowCacheHitCounts() {
        try {
            const suspiciousThreshold = 1000000;
            const result = db.prepare(`
                UPDATE history_window_cache
                SET hit_count = 0,
                    last_hit_at = 0,
                    updated_at = CASE
                        WHEN COALESCE(updated_at, 0) > 0 THEN updated_at
                        ELSE ?
                    END
                WHERE COALESCE(hit_count, 0) > ?
            `).run(Date.now(), suspiciousThreshold);
            if (Number(result.changes || 0) > 0) {
                console.warn(`[DB] Repaired ${result.changes} corrupted history window cache hit counters.`);
            }
        } catch (e) {
            console.error('[DB] Error repairing history window cache hit counters:', e.message);
        }
    }

    // ─── Character Queries ──────────────────────────────────────────────────

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
        'jealousy_level', 'jealousy_target', 'city_reply_pending', 'city_ignore_streak', 'city_last_outreach_at', 'city_post_ignore_reaction',
        'city_status_started_at', 'city_status_until_at', 'city_medical_last_recovery_at',
        'stat_int', 'stat_sta', 'stat_cha', 'energy', 'sleep_debt', 'sleep_pressure', 'mood', 'stress', 'social_need', 'explicit_emotion_state', 'health', 'satiety', 'stomach_load', 'work_distraction', 'sleep_disruption', 'llm_debug_capture',
        'sweep_limit', 'sweep_last_error', 'sweep_last_run_at', 'sweep_last_success_at', 'sweep_last_saved_count',
        // City DLC fields
        'calories', 'city_status', 'location', 'education', 'sys_survival', 'sys_city_notify', 'sys_city_social',
        'impression_q_limit', 'is_scheduled', 'city_action_frequency', 'context_msg_limit'
    ];

    // Generates a memorable random diary password (4-digit number)
    function generateDiaryPassword() {
        return String(Math.floor(1000 + Math.random() * 9000));
    }

    function updateCharacter(id, data) {
        // Filter out 'id' from data keys — it's always passed as a separate parameter
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
                values.push('👤');
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

    function addEmotionLog(entry) {
        const stmt = db.prepare(`
            INSERT INTO emotion_logs (
                character_id, source, reason, old_state, new_state,
                old_mood, new_mood, old_stress, new_stress,
                old_social_need, new_social_need,
                old_pressure, new_pressure,
                old_jealousy, new_jealousy,
                timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const ts = entry.timestamp || Date.now();
        stmt.run(
            entry.character_id,
            entry.source || 'system',
            entry.reason || '',
            entry.old_state || '',
            entry.new_state || '',
            entry.old_mood ?? null,
            entry.new_mood ?? null,
            entry.old_stress ?? null,
            entry.new_stress ?? null,
            entry.old_social_need ?? null,
            entry.new_social_need ?? null,
            entry.old_pressure ?? null,
            entry.new_pressure ?? null,
            entry.old_jealousy ?? null,
            entry.new_jealousy ?? null,
            ts
        );
        return ts;
    }

    function getEmotionLogs(characterId, limit = 50) {
        return db.prepare('SELECT * FROM emotion_logs WHERE character_id = ? ORDER BY id DESC LIMIT ?')
            .all(characterId, limit);
    }

    function addLlmDebugLog(entry) {
        const stmt = db.prepare(`
            INSERT INTO llm_debug_logs (
                character_id, direction, context_type, payload, meta, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            entry.character_id,
            entry.direction || 'unknown',
            entry.context_type || 'chat',
            entry.payload || '',
            typeof entry.meta === 'string' ? entry.meta : JSON.stringify(entry.meta || {}),
            entry.timestamp || Date.now()
        );
    }

    function getLlmDebugLogs(characterId, limit = 50) {
        return db.prepare('SELECT * FROM llm_debug_logs WHERE character_id = ? ORDER BY id DESC LIMIT ?')
            .all(characterId, limit);
    }

    function addReplyDispatchLog(entry) {
        const stmt = db.prepare(`
            INSERT INTO reply_dispatch_logs (
                character_id,
                source,
                route,
                request_id,
                latest_user_message_id,
                latest_user_message_timestamp,
                payload,
                note,
                timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            entry.character_id,
            String(entry.source || 'unknown'),
            String(entry.route || ''),
            String(entry.request_id || ''),
            entry.latest_user_message_id ?? null,
            entry.latest_user_message_timestamp ?? null,
            typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload || {}),
            String(entry.note || ''),
            entry.timestamp || Date.now()
        );
    }

    function getReplyDispatchLogs(characterId, limit = 50) {
        return db.prepare(`
            SELECT * FROM reply_dispatch_logs
            WHERE character_id = ?
            ORDER BY id DESC
            LIMIT ?
        `).all(characterId, limit).map(row => {
            let payload = row.payload;
            if (typeof payload === 'string' && payload.trim()) {
                try {
                    payload = JSON.parse(payload);
                } catch (e) {
                    payload = { raw: payload };
                }
            }
            return { ...row, payload: payload || {} };
        });
    }

    function normalizeMessageRow(row) {
        if (!row) return row;
        let metadata = row.metadata;
        if (typeof metadata === 'string' && metadata.trim()) {
            try {
                metadata = JSON.parse(metadata);
            } catch (e) {
                metadata = null;
            }
        }
        return { ...row, metadata: metadata || null };
    }

    // ─── Message Queries ────────────────────────────────────────────────────

    function getMessages(characterId, limit = 100) {
        return db.prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY id DESC LIMIT ?')
            .all(characterId, limit)
            .reverse()
            .map(normalizeMessageRow);
    }

    function getMessagesBefore(characterId, beforeId, limit = 100) {
        return db.prepare('SELECT * FROM messages WHERE character_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(characterId, beforeId, limit)
            .reverse()
            .map(normalizeMessageRow);
    }

    function getLatestUserMessage(characterId) {
        const row = db.prepare(`
            SELECT * FROM messages
            WHERE character_id = ? AND role = 'user'
            ORDER BY id DESC
            LIMIT 1
        `).get(characterId);
        return normalizeMessageRow(row);
    }

    // Returns messages excluding hidden ones — used for LLM context
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

    function getRecentUserConversationIntel(spyCharacterId, options = {}) {
        const sinceHours = Math.max(1, Number(options.sinceHours || 5));
        const maxMessages = Math.max(1, Number(options.maxMessages || 20));
        const maxCharacters = Math.max(1, Number(options.maxCharacters || 20));
        const sinceTimestamp = Date.now() - sinceHours * 60 * 60 * 1000;

        const recentCharacters = db.prepare(`
            SELECT
                character_id,
                MAX(timestamp) AS last_user_timestamp
            FROM messages
            WHERE hidden = 0
              AND role = 'user'
              AND timestamp >= ?
              AND character_id != ?
            GROUP BY character_id
            ORDER BY last_user_timestamp DESC
            LIMIT ?
        `).all(sinceTimestamp, spyCharacterId, maxCharacters);

        if (!Array.isArray(recentCharacters) || recentCharacters.length === 0) {
            return {
                since_timestamp: sinceTimestamp,
                since_hours: sinceHours,
                max_messages: maxMessages,
                max_characters: maxCharacters,
                per_character_limit: 0,
                characters: [],
                total_messages: 0
            };
        }

        const selectedCharacters = recentCharacters.slice(0, Math.min(maxCharacters, maxMessages));
        const perCharacterLimit = Math.max(1, Math.floor(maxMessages / selectedCharacters.length));
        const characters = [];
        let totalMessages = 0;

        for (const row of selectedCharacters) {
            const character = getCharacter(row.character_id);
            if (!character) continue;
            const messages = db.prepare(`
                SELECT *
                FROM messages
                WHERE character_id = ?
                  AND hidden = 0
                  AND timestamp >= ?
                  AND role IN ('user', 'character')
                ORDER BY timestamp DESC
                LIMIT ?
            `)
                .all(row.character_id, sinceTimestamp, perCharacterLimit)
                .reverse()
                .map(normalizeMessageRow);

            characters.push({
                character_id: row.character_id,
                character_name: character.name,
                last_user_timestamp: Number(row.last_user_timestamp || 0),
                messages
            });
            totalMessages += messages.length;
        }

        return {
            since_timestamp: sinceTimestamp,
            since_hours: sinceHours,
            max_messages: maxMessages,
            max_characters: maxCharacters,
            per_character_limit: perCharacterLimit,
            characters,
            total_messages: totalMessages
        };
    }

    function getLastUserMessageTimestamp(characterId) {
        const row = db.prepare('SELECT timestamp FROM messages WHERE character_id = ? AND role = ? ORDER BY id DESC LIMIT 1')
            .get(characterId, 'user');
        return row ? row.timestamp : 0;
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

    function getOverflowMessages(characterId, windowLimit = 0, limit = 50) {
        if (windowLimit <= 0) return [];
        return db.prepare(`
            SELECT * FROM messages
            WHERE character_id = ?
              AND hidden = 0
              AND is_summarized = 0
              AND id NOT IN (
                SELECT id FROM messages
                WHERE character_id = ? AND hidden = 0
                ORDER BY id DESC
                LIMIT ?
              )
            ORDER BY timestamp ASC
            LIMIT ?
        `).all(characterId, characterId, windowLimit, limit);
    }

    function countOverflowMessages(characterId, windowLimit = 0) {
        if (windowLimit <= 0) return 0;
        const row = db.prepare(`
            SELECT COUNT(*) as count FROM messages
            WHERE character_id = ?
              AND hidden = 0
              AND is_summarized = 0
              AND id NOT IN (
                SELECT id FROM messages
                WHERE character_id = ? AND hidden = 0
                ORDER BY id DESC
                LIMIT ?
              )
        `).get(characterId, characterId, windowLimit);
        return row ? row.count : 0;
    }

    function markOverflowMessagesSummarized(characterId, windowLimit = 0) {
        if (windowLimit <= 0) return 0;
        const info = db.prepare(`
            UPDATE messages
            SET is_summarized = 1
            WHERE character_id = ?
              AND hidden = 0
              AND is_summarized = 0
              AND id NOT IN (
                SELECT id FROM messages
                WHERE character_id = ? AND hidden = 0
                ORDER BY id DESC
                LIMIT ?
              )
        `).run(characterId, characterId, windowLimit);
        return info ? info.changes : 0;
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

    function getMessageCharacterId(messageId) {
        const row = db.prepare('SELECT character_id FROM messages WHERE id = ? LIMIT 1').get(messageId);
        return row?.character_id || null;
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
        clearCharacterMessageCaches(characterId);
    }

    function clearCharacterMessageCaches(characterId) {
        const id = String(characterId || '').trim();
        if (!id) return 0;
        let changes = 0;
        changes += db.prepare('DELETE FROM history_window_cache WHERE character_id = ?').run(id).changes || 0;
        changes += db.prepare('DELETE FROM conversation_digest_cache WHERE character_id = ?').run(id).changes || 0;
        changes += db.prepare('DELETE FROM prompt_block_cache WHERE character_id = ?').run(id).changes || 0;
        changes += db.prepare('DELETE FROM llm_cache WHERE character_id = ? OR cache_scope = ?').run(id, `character:${id}`).changes || 0;
        return changes;
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

    function clearConversationDigest(characterId) {
        db.prepare('DELETE FROM conversation_digest_cache WHERE character_id = ?').run(characterId);
    }

    function clearGroupConversationDigest(groupId, characterId = null) {
        if (characterId) {
            db.prepare('DELETE FROM group_conversation_digest_cache WHERE group_id = ? AND character_id = ?').run(groupId, characterId);
            return;
        }
        db.prepare('DELETE FROM group_conversation_digest_cache WHERE group_id = ?').run(groupId);
    }

    function exportCharacterData(characterId) {
        const character = getCharacter(characterId);
        if (!character) return null;
        const messages = db.prepare('SELECT * FROM messages WHERE character_id = ? ORDER BY timestamp ASC').all(characterId);
        const memories = db.prepare('SELECT * FROM memories WHERE character_id = ? ORDER BY created_at ASC').all(characterId);
        const moments = db.prepare('SELECT * FROM moments WHERE character_id = ? ORDER BY timestamp ASC').all(characterId);
        return { character, messages, memories, moments };
    }

    // ─── Memory Queries ─────────────────────────────────────────────────────

    function getMemories(characterId) {
        const rows = db.prepare(`
            SELECT * FROM memories
            WHERE character_id = ?
            ORDER BY
                COALESCE(updated_at, created_at) DESC,
                created_at DESC
        `).all(characterId);
        return rows.map(normalizeMemoryRow);
    }

    function getMemoriesByTimeRange(characterId, startTimestamp, endTimestamp, limit = 80) {
        const safeStart = Number(startTimestamp || 0);
        const safeEnd = Number(endTimestamp || 0);
        const safeLimit = Math.max(1, Math.min(200, Number(limit || 80) || 80));
        if (!characterId || safeStart <= 0 || safeEnd <= 0) return [];
        const rangeStart = Math.min(safeStart, safeEnd);
        const rangeEnd = Math.max(safeStart, safeEnd);
        const rows = db.prepare(`
            SELECT * FROM memories
            WHERE character_id = ?
              AND COALESCE(is_archived, 0) = 0
              AND COALESCE(source_started_at, created_at, 0) <= ?
              AND COALESCE(source_ended_at, source_started_at, created_at, 0) >= ?
            ORDER BY
                COALESCE(source_started_at, created_at) ASC,
                COALESCE(source_ended_at, source_started_at, created_at) ASC,
                created_at ASC
            LIMIT ?
        `).all(characterId, rangeEnd, rangeStart, safeLimit);
        return rows.map(normalizeMemoryRow);
    }

    function getMemory(id) {
        return normalizeMemoryRow(db.prepare('SELECT * FROM memories WHERE id = ?').get(id));
    }

    function getMemoryByDedupeKey(characterId, dedupeKey) {
        if (!characterId || !dedupeKey) return null;
        return normalizeMemoryRow(db.prepare(`
            SELECT * FROM memories
            WHERE character_id = ? AND dedupe_key = ?
            ORDER BY COALESCE(updated_at, created_at) DESC
            LIMIT 1
        `).get(characterId, dedupeKey));
    }

    function addMemory(characterId, memoryData, groupId = null) {
        const now = Date.now();
        const peopleList = normalizeArrayField(memoryData.people_json ?? memoryData.people, []);
        const itemList = normalizeArrayField(memoryData.items_json ?? memoryData.items, []);
        const relationshipList = normalizeRelationshipField(memoryData.relationship_json ?? memoryData.relationships, []);
        const sourceMessageIds = normalizeArrayField(memoryData.source_message_ids_json, []);
        const summary = (memoryData.summary || memoryData.event || '').trim();
        const content = (memoryData.content || memoryData.event || summary).trim();
        const legacyPeople = (memoryData.people || peopleList.join(', ')).trim();
        const legacyItems = (memoryData.items || itemList.join(', ')).trim();
        const legacyRelationships = (memoryData.relationships || relationshipList.map(rel => {
            if (typeof rel === 'string') return rel;
            return rel.summary || rel.type || JSON.stringify(rel);
        }).join('; ')).trim();
        const info = db.prepare(`
        INSERT INTO memories 
        (character_id, time, location, people, event, relationships, items, importance, embedding, created_at, group_id, memory_type, summary, content, people_json, items_json, relationship_json, emotion, source_message_ids_json, dedupe_key, updated_at, is_archived, source_started_at, source_ended_at, source_time_text, source_message_count, memory_tier, memory_focus) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
            characterId,
            memoryData.time || '',
            memoryData.location || '',
            legacyPeople,
            memoryData.event || summary || content || '(empty memory)',
            legacyRelationships,
            legacyItems,
            memoryData.importance ?? 5,
            memoryData.embedding || null,
            now,
            groupId,
            memoryData.memory_type || 'event',
            summary,
            content,
            stringifyJson(peopleList),
            stringifyJson(itemList),
            stringifyJson(relationshipList),
            memoryData.emotion || '',
            stringifyJson(sourceMessageIds),
            memoryData.dedupe_key || '',
            memoryData.updated_at || now,
            Number(memoryData.is_archived || 0),
            Number(memoryData.source_started_at || 0),
            Number(memoryData.source_ended_at || 0),
            memoryData.source_time_text || '',
            Number(memoryData.source_message_count || sourceMessageIds.length || 0),
            memoryData.memory_tier || 'ambient',
            memoryData.memory_focus || 'general'
        );
        return info.lastInsertRowid;
    }

    function updateMemory(id, memoryData) {
        const patch = { ...memoryData };
        if (Object.prototype.hasOwnProperty.call(patch, 'people_json') || Object.prototype.hasOwnProperty.call(patch, 'people')) {
            const peopleList = normalizeArrayField(patch.people_json ?? patch.people, []);
            patch.people_json = stringifyJson(peopleList);
            patch.people = patch.people || peopleList.join(', ');
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'items_json') || Object.prototype.hasOwnProperty.call(patch, 'items')) {
            const itemList = normalizeArrayField(patch.items_json ?? patch.items, []);
            patch.items_json = stringifyJson(itemList);
            patch.items = patch.items || itemList.join(', ');
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'relationship_json') || Object.prototype.hasOwnProperty.call(patch, 'relationships')) {
            const relationshipList = normalizeRelationshipField(patch.relationship_json ?? patch.relationships, []);
            patch.relationship_json = stringifyJson(relationshipList);
            patch.relationships = patch.relationships || relationshipList.map(rel => {
                if (typeof rel === 'string') return rel;
                return rel.summary || rel.type || JSON.stringify(rel);
            }).join('; ');
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'source_message_ids_json')) {
            patch.source_message_ids_json = stringifyJson(normalizeArrayField(patch.source_message_ids_json, []));
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'summary') || Object.prototype.hasOwnProperty.call(patch, 'content') || Object.prototype.hasOwnProperty.call(patch, 'event')) {
            const summary = (patch.summary || patch.event || '').trim();
            const content = (patch.content || patch.event || summary).trim();
            if (summary) {
                patch.summary = summary;
                patch.event = patch.event || summary;
            }
            if (content) {
                patch.content = content;
            }
        }
        patch.updated_at = patch.updated_at || Date.now();
        const fields = Object.keys(patch);
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => patch[f]);
        db.prepare(`UPDATE memories SET ${setClause} WHERE id = ?`).run(...values, id);
    }

    function deleteMemory(id) {
        db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    }

    function markMemoriesRetrieved(memoryIds = []) {
        const ids = (memoryIds || []).filter(Boolean);
        if (ids.length === 0) return;
        const now = Date.now();
        const stmt = db.prepare(`
            UPDATE memories
            SET last_retrieved_at = ?, retrieval_count = COALESCE(retrieval_count, 0) + 1
            WHERE id = ?
        `);
        const tx = db.transaction((rows) => {
            for (const id of rows) stmt.run(now, id);
        });
        tx(ids);
    }

    // ─── Phase 3: Moments & Diaries ──────────────────────────────────────────

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

    // ─── Moments Context Builder for LLM Injection ─────────────────────────
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
            if (likers.length > 0) line += ` ❤️ ${likers.join(', ')}`;
            if (comments.length > 0) line += `\n    评论: ${comments.join(' | ')}`;
            return line;
        };

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
            { label: `[你的朋友圈]`, moments: ownMoments },
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
        const charLiked = db.prepare('SELECT moment_id FROM moment_likes WHERE liker_id = ?').all(charId).map(r => r.moment_id);
        const charCommented = db.prepare('SELECT DISTINCT moment_id FROM moment_comments WHERE author_id = ?').all(charId).map(r => r.moment_id);
        if (charLiked.length > 0) result += `\n(你已点赞的朋友圈ID: ${charLiked.join(', ')})`;
        if (charCommented.length > 0) result += `\n(你已评论过的朋友圈ID: ${charCommented.join(', ')})`;

        result += '\n===========================================';
        return result;
    }


    // ─── User Profile ───────────────────────────────────────────────────────

    function getUserProfile() {
        let profile = db.prepare('SELECT * FROM user_profile WHERE id = ?').get('default');
        if (!profile) {
            db.prepare(`INSERT INTO user_profile (id, name, avatar) VALUES (?, ?, ?)`)
                .run('default', 'User', 'https://api.dicebear.com/7.x/notionists/svg?seed=User');
            profile = db.prepare('SELECT * FROM user_profile WHERE id = ?').get('default');
        }
        if (profile) {
            if (!String(profile.response_style_constitution || '').trim()) {
                profile.response_style_constitution = [
                    '这是最高优先级的长期表达风格约束。',
                    '避免连续几轮使用相同句式骨架、相同情绪推进、相同emoji顺序。',
                    '不要把回复写成固定模板，不要总是同一种委屈、安抚、阴阳怪气节奏。',
                    '可以保留角色性格，但表达方式必须有变化感。',
                    '除非角色本来就极度依赖表情，否则emoji默认少用，并避免固定排列。'
                ].join('\n');
            }
            // Older DBs may still store percentages as whole numbers instead of 0-1 decimals.
            if (typeof profile.group_skip_rate === 'number' && profile.group_skip_rate > 1) {
                profile.group_skip_rate = profile.group_skip_rate / 100;
            }
            if (typeof profile.jealousy_chance === 'number' && profile.jealousy_chance > 1) {
                profile.jealousy_chance = profile.jealousy_chance / 100;
            }
        }
        return profile;
    }

    function updateUserProfile(data) {
        const allowedFields = ['name', 'avatar', 'banner', 'bio', 'theme', 'custom_css', 'theme_config', 'group_msg_limit', 'group_skip_rate', 'group_proactive_enabled', 'group_interval_min', 'group_interval_max', 'jealousy_chance', 'wallet', 'private_msg_limit_for_group', 'moments_token_limit', 'moments_reaction_rate'];
        const fields = Object.keys(data).filter(k => allowedFields.includes(k));
        if (fields.length === 0) return;
        const normalizedData = { ...data };
        if (normalizedData.group_skip_rate !== undefined) {
            normalizedData.group_skip_rate = Math.max(0, Math.min(1, Number(normalizedData.group_skip_rate) || 0));
        }
        if (normalizedData.jealousy_chance !== undefined) {
            normalizedData.jealousy_chance = Math.max(0, Math.min(1, Number(normalizedData.jealousy_chance) || 0));
        }
        if (normalizedData.moments_reaction_rate !== undefined) {
            normalizedData.moments_reaction_rate = Math.max(0, Math.min(100, parseInt(normalizedData.moments_reaction_rate, 10) || 0));
        }
        const setClause = fields.map(f => `${f} = ?`).join(', ');
        const values = fields.map(f => normalizedData[f]);
        db.prepare(`UPDATE user_profile SET ${setClause} WHERE id = ?`).run(...values, 'default');
    }

    function getJealousyState(characterId) {
        const row = db.prepare('SELECT jealousy_level, jealousy_target FROM characters WHERE id = ?').get(characterId);
        if (!row) return null;
        return {
            level: row.jealousy_level || 0,
            target_id: row.jealousy_target || '',
            active: (row.jealousy_level || 0) > 0
        };
    }

    function getTokenUsageSummary(characterId) {
        const totals = db.prepare(`
            SELECT
                COUNT(*) as request_count,
                COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) as completion_tokens
            FROM token_usage
            WHERE character_id = ?
        `).get(characterId);
        const byContext = db.prepare(`
            SELECT
                context_type,
                COUNT(*) as request_count,
                COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) as completion_tokens
            FROM token_usage
            WHERE character_id = ?
            GROUP BY context_type
        `).all(characterId);
        return {
            request_count: totals?.request_count || 0,
            prompt_tokens: totals?.prompt_tokens || 0,
            completion_tokens: totals?.completion_tokens || 0,
            by_context: byContext || []
        };
    }

    // ─── Friendship Management ──────────────────────────────────────────────
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
        db.prepare('DELETE FROM moment_likes WHERE liker_id = ?').run(charId);
        db.prepare('DELETE FROM moment_comments WHERE author_id = ?').run(charId);
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

    // ─── Group Chat Management ──────────────────────────────────────────────
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
        db.prepare('DELETE FROM group_conversation_digest_cache WHERE group_id = ?').run(id);
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

    function getOverflowGroupMessages(groupId, windowLimit = 0, limit = 50) {
        if (windowLimit <= 0) return [];
        return db.prepare(`
            SELECT * FROM group_messages
            WHERE group_id = ?
              AND hidden = 0
              AND is_summarized = 0
              AND id NOT IN (
                SELECT id FROM group_messages
                WHERE group_id = ? AND hidden = 0
                ORDER BY id DESC
                LIMIT ?
              )
            ORDER BY timestamp ASC
            LIMIT ?
        `).all(groupId, groupId, windowLimit, limit);
    }

    function countOverflowGroupMessages(groupId, windowLimit = 0) {
        if (windowLimit <= 0) return 0;
        const row = db.prepare(`
            SELECT COUNT(*) as count FROM group_messages
            WHERE group_id = ?
              AND hidden = 0
              AND is_summarized = 0
              AND id NOT IN (
                SELECT id FROM group_messages
                WHERE group_id = ? AND hidden = 0
                ORDER BY id DESC
                LIMIT ?
              )
        `).get(groupId, groupId, windowLimit);
        return row ? row.count : 0;
    }

    function markOverflowGroupMessagesSummarized(groupId, windowLimit = 0) {
        if (windowLimit <= 0) return 0;
        const info = db.prepare(`
            UPDATE group_messages
            SET is_summarized = 1
            WHERE group_id = ?
              AND hidden = 0
              AND is_summarized = 0
              AND id NOT IN (
                SELECT id FROM group_messages
                WHERE group_id = ? AND hidden = 0
                ORDER BY id DESC
                LIMIT ?
              )
        `).run(groupId, groupId, windowLimit);
        return info ? info.changes : 0;
    }

    function markGroupMessagesSummarized(messageIds) {
        if (!messageIds || messageIds.length === 0) return 0;
        const placeholders = messageIds.map(() => '?').join(', ');
        const info = db.prepare(`UPDATE group_messages SET is_summarized = 1 WHERE id IN (${placeholders})`).run(...messageIds);
        return info.changes;
    }

    function initializeSweepBaseline(characterId, privateWindow = 0, groupWindows = []) {
        let changed = 0;
        changed += markOverflowMessagesSummarized(characterId, privateWindow);
        for (const gw of groupWindows || []) {
            if (!gw || !gw.groupId) continue;
            changed += markOverflowGroupMessagesSummarized(gw.groupId, gw.windowLimit || 0);
        }
        db.prepare('UPDATE characters SET sweep_initialized = 1 WHERE id = ?').run(characterId);
        return changed;
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
        db.prepare('DELETE FROM group_conversation_digest_cache WHERE group_id = ?').run(groupId);
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
        db.prepare('DELETE FROM group_conversation_digest_cache WHERE group_id = ? AND character_id = ?').run(groupId, memberId);
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

    // ─── Character Management ───────────────────────────────────────────────

    function deleteCharacter(id) {
        db.prepare('DELETE FROM messages WHERE character_id = ?').run(id);
        db.prepare('DELETE FROM memories WHERE character_id = ?').run(id);
        db.prepare('DELETE FROM history_window_cache WHERE character_id = ?').run(id);
        db.prepare('DELETE FROM prompt_block_cache WHERE character_id = ?').run(id);
        db.prepare('DELETE FROM conversation_digest_cache WHERE character_id = ?').run(id);
        db.prepare('DELETE FROM group_conversation_digest_cache WHERE character_id = ?').run(id);
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

    // ─── Character Relationships (Inter-char Social System) ────────────────

    function initCharRelationship(sourceId, targetId, affinity, impression, source = 'recommend') {
        const safeImpression = impression || '';
        // Check existing record to avoid duplicate history entries
        const existing = db.prepare('SELECT affinity, impression FROM char_relationships WHERE source_id = ? AND target_id = ? AND source = ?')
            .get(sourceId, targetId, source);

        db.prepare(`INSERT OR REPLACE INTO char_relationships (source_id, target_id, affinity, impression, source) VALUES (?, ?, ?, ?, ?)`)
            .run(sourceId, targetId, affinity, safeImpression, source);

        // Only add history if: impression changed AND (affinity changed by ≥5 OR it's a brand new relationship)
        const impressionChanged = !existing || existing.impression !== safeImpression;
        const affinityDelta = existing ? Math.abs(affinity - existing.affinity) : 999;
        if (safeImpression.trim() !== '' && impressionChanged && (!existing || affinityDelta >= 5)) {
            addCharImpressionHistory(sourceId, targetId, safeImpression, `Formed: ${source}`);
        }
    }

    function getCharRelationship(sourceId, targetId) {
        // Returns all relationship records between source→target (may have multiple sources)
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

                // Only log history if impression text actually changed AND affinity shifted by ≥5
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

    // ─── Private Transfer System ──────────────────────────────────────

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
        if (t.refunded) return { success: false, error: '已退还' };
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
        if (t.refunded) return { success: false, error: '已经退还过了' };
        // Allow sender to refund anytime if still pending, allow recipient to refund anytime
        const canRefund = (refunderId === t.sender_id && !t.claimed) || (refunderId === t.recipient_id);
        if (!canRefund) return { success: false, error: '无权退还' };

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

    // ─── Red Packet System ──────────────────────────────────────────────────

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
        if (pkt.remaining_count <= 0) return { success: false, error: '红包已被抢光' };

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

    function getLlmCache(cacheKey) {
        try {
            const now = Date.now();
            const row = db.prepare(`
                SELECT *
                FROM llm_cache
                WHERE cache_key = ?
                  AND expires_at > ?
                LIMIT 1
            `).get(cacheKey, now);
            if (!row) return null;
            db.prepare('UPDATE llm_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?').run(now, row.id);
            return {
                ...row,
                response_meta: safeParseJson(row.response_meta, {})
            };
        } catch (e) {
            console.error('[DB] Error reading llm cache:', e.message);
            return null;
        }
    }

    function incrementLlmCacheLookup(scope = 'global', wasHit = false) {
        try {
            const now = Date.now();
            db.prepare(`
                INSERT INTO llm_cache_stats (scope, lookup_count, hit_count, updated_at)
                VALUES (?, 1, ?, ?)
                ON CONFLICT(scope) DO UPDATE SET
                    lookup_count = lookup_count + 1,
                    hit_count = hit_count + excluded.hit_count,
                    updated_at = excluded.updated_at
            `).run(String(scope || 'global'), wasHit ? 1 : 0, now);
            return true;
        } catch (e) {
            console.error('[DB] Error updating llm cache stats:', e.message);
            return false;
        }
    }

    function getLlmCacheStats(scope = 'global') {
        try {
            return db.prepare(`
                SELECT scope, lookup_count, hit_count, updated_at
                FROM llm_cache_stats
                WHERE scope = ?
                LIMIT 1
            `).get(String(scope || 'global')) || null;
        } catch (e) {
            console.error('[DB] Error reading llm cache stats:', e.message);
            return null;
        }
    }

    function upsertLlmCache(entry = {}) {
        try {
            const now = Date.now();
            const expiresAt = Number(entry.expires_at || now + 3600000);
            db.prepare(`
                INSERT INTO llm_cache (
                    cache_key, cache_type, cache_scope, character_id, model, prompt_hash, prompt_preview,
                    response_text, response_meta, prompt_tokens, completion_tokens,
                    hit_count, created_at, last_hit_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    cache_type = excluded.cache_type,
                    cache_scope = excluded.cache_scope,
                    character_id = excluded.character_id,
                    model = excluded.model,
                    prompt_hash = excluded.prompt_hash,
                    prompt_preview = excluded.prompt_preview,
                    response_text = excluded.response_text,
                    response_meta = excluded.response_meta,
                    prompt_tokens = excluded.prompt_tokens,
                    completion_tokens = excluded.completion_tokens,
                    expires_at = excluded.expires_at
            `).run(
                String(entry.cache_key || ''),
                String(entry.cache_type || 'generic'),
                String(entry.cache_scope || ''),
                String(entry.character_id || ''),
                String(entry.model || ''),
                String(entry.prompt_hash || ''),
                String(entry.prompt_preview || ''),
                String(entry.response_text || ''),
                stringifyJson(entry.response_meta || {}),
                Number(entry.prompt_tokens || 0),
                Number(entry.completion_tokens || 0),
                Number(entry.hit_count || 0),
                Number(entry.created_at || now),
                Number(entry.last_hit_at || 0),
                expiresAt
            );
            return true;
        } catch (e) {
            console.error('[DB] Error writing llm cache:', e.message);
            return false;
        }
    }

    function deleteLlmCache(cacheKey) {
        try {
            return db.prepare('DELETE FROM llm_cache WHERE cache_key = ?').run(String(cacheKey || '')).changes || 0;
        } catch (e) {
            console.error('[DB] Error deleting llm cache:', e.message);
            return 0;
        }
    }

    function pruneExpiredLlmCache(limit = 500) {
        try {
            const now = Date.now();
            return db.prepare(`
                DELETE FROM llm_cache
                WHERE id IN (
                    SELECT id
                    FROM llm_cache
                    WHERE expires_at <= ?
                    ORDER BY expires_at ASC
                    LIMIT ?
                )
            `).run(now, Math.max(1, Number(limit || 500))).changes || 0;
        } catch (e) {
            console.error('[DB] Error pruning llm cache:', e.message);
            return 0;
        }
    }

    function getPromptBlockCache(characterId, blockType, sourceHash) {
        try {
            const now = Date.now();
            const row = db.prepare(`
                SELECT *
                FROM prompt_block_cache
                WHERE character_id = ?
                  AND block_type = ?
                  AND source_hash = ?
                LIMIT 1
            `).get(String(characterId || ''), String(blockType || ''), String(sourceHash || '')) || null;
            if (!row) return null;
            db.prepare('UPDATE prompt_block_cache SET hit_count = COALESCE(hit_count, 0) + 1, last_hit_at = ? WHERE id = ?').run(now, row.id);
            return {
                ...row,
                hit_count: Number(row.hit_count || 0) + 1,
                last_hit_at: now
            };
        } catch (e) {
            console.error('[DB] Error reading prompt block cache:', e.message);
            return null;
        }
    }

    function upsertPromptBlockCache(entry = {}) {
        try {
            const now = Date.now();
            db.prepare(`
                INSERT INTO prompt_block_cache (
                    character_id, block_type, source_hash, compiled_text, hit_count, created_at, last_hit_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(character_id, block_type) DO UPDATE SET
                    source_hash = excluded.source_hash,
                    compiled_text = excluded.compiled_text,
                    hit_count = COALESCE(prompt_block_cache.hit_count, 0) + COALESCE(excluded.hit_count, 0),
                    created_at = CASE
                        WHEN COALESCE(prompt_block_cache.created_at, 0) > 0 THEN prompt_block_cache.created_at
                        ELSE excluded.created_at
                    END,
                    last_hit_at = CASE
                        WHEN COALESCE(excluded.last_hit_at, 0) > COALESCE(prompt_block_cache.last_hit_at, 0) THEN excluded.last_hit_at
                        ELSE prompt_block_cache.last_hit_at
                    END,
                    updated_at = excluded.updated_at
            `).run(
                String(entry.character_id || ''),
                String(entry.block_type || ''),
                String(entry.source_hash || ''),
                String(entry.compiled_text || ''),
                Number(entry.hit_count || 0),
                Number(entry.created_at || now),
                Number(entry.last_hit_at || 0),
                Number(entry.updated_at || now)
            );
            return true;
        } catch (e) {
            console.error('[DB] Error writing prompt block cache:', e.message);
            return false;
        }
    }

    function getHistoryWindowCache(characterId, windowType, windowSize, sourceHash) {
        try {
            const now = Date.now();
            const row = db.prepare(`
                SELECT *
                FROM history_window_cache
                WHERE character_id = ?
                  AND window_type = ?
                  AND window_size = ?
                  AND source_hash = ?
                LIMIT 1
            `).get(
                String(characterId || ''),
                String(windowType || ''),
                Number(windowSize || 0),
                String(sourceHash || '')
            );
            if (!row) return null;
            db.prepare('UPDATE history_window_cache SET hit_count = COALESCE(hit_count, 0) + 1, last_hit_at = ? WHERE id = ?').run(now, row.id);
            return {
                ...row,
                message_ids_json: safeParseJson(row.message_ids_json, []),
                compiled_json: safeParseJson(row.compiled_json, []),
                hit_count: Number(row.hit_count || 0) + 1,
                last_hit_at: now
            };
        } catch (e) {
            console.error('[DB] Error reading history window cache:', e.message);
            return null;
        }
    }

    function getLatestHistoryWindowCache(characterId, windowType, windowSize) {
        try {
            const row = db.prepare(`
                SELECT *
                FROM history_window_cache
                WHERE character_id = ?
                  AND window_type = ?
                  AND window_size = ?
                LIMIT 1
            `).get(
                String(characterId || ''),
                String(windowType || ''),
                Number(windowSize || 0)
            );
            if (!row) return null;
            return {
                ...row,
                message_ids_json: safeParseJson(row.message_ids_json, []),
                compiled_json: safeParseJson(row.compiled_json, [])
            };
        } catch (e) {
            console.error('[DB] Error reading latest history window cache:', e.message);
            return null;
        }
    }

    function upsertHistoryWindowCache(entry = {}) {
        try {
            const now = Date.now();
            db.prepare(`
                INSERT INTO history_window_cache (
                    character_id, window_type, window_size, source_hash, message_ids_json, compiled_json, hit_count, created_at, last_hit_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(character_id, window_type, window_size) DO UPDATE SET
                    source_hash = excluded.source_hash,
                    message_ids_json = excluded.message_ids_json,
                    compiled_json = excluded.compiled_json,
                    hit_count = COALESCE(history_window_cache.hit_count, 0),
                    created_at = CASE
                        WHEN COALESCE(history_window_cache.created_at, 0) > 0 THEN history_window_cache.created_at
                        ELSE excluded.created_at
                    END,
                    last_hit_at = CASE
                        WHEN COALESCE(excluded.last_hit_at, 0) > COALESCE(history_window_cache.last_hit_at, 0) THEN excluded.last_hit_at
                        ELSE history_window_cache.last_hit_at
                    END,
                    updated_at = excluded.updated_at
            `).run(
                String(entry.character_id || ''),
                String(entry.window_type || ''),
                Number(entry.window_size || 0),
                String(entry.source_hash || ''),
                stringifyJson(entry.message_ids_json || []),
                stringifyJson(entry.compiled_json || []),
                Number(entry.hit_count || 0),
                Number(entry.created_at || now),
                Number(entry.last_hit_at || 0),
                Number(entry.updated_at || now)
            );
            return true;
        } catch (e) {
            console.error('[DB] Error writing history window cache:', e.message);
            return false;
        }
    }

    function getConversationDigest(characterId, options = {}) {
        try {
            const row = db.prepare(`
                SELECT *
                FROM conversation_digest_cache
                WHERE character_id = ?
                LIMIT 1
            `).get(String(characterId || ''));
            if (!row) return null;
            const normalized = normalizeConversationDigestRow(row);
            if (options.trackHit === false) {
                return normalized;
            }
            const now = Date.now();
            db.prepare('UPDATE conversation_digest_cache SET hit_count = COALESCE(hit_count, 0) + 1, last_hit_at = ? WHERE id = ?').run(now, row.id);
            return {
                ...normalized,
                hit_count: normalized.hit_count + 1,
                last_hit_at: now
            };
        } catch (e) {
            console.error('[DB] Error reading conversation digest cache:', e.message);
            return null;
        }
    }

    function getGroupConversationDigest(groupId, characterId, options = {}) {
        try {
            const row = db.prepare(`
                SELECT *
                FROM group_conversation_digest_cache
                WHERE group_id = ? AND character_id = ?
                LIMIT 1
            `).get(String(groupId || ''), String(characterId || ''));
            if (!row) return null;
            const normalized = normalizeGroupConversationDigestRow(row);
            if (options.trackHit === false) {
                return normalized;
            }
            const now = Date.now();
            db.prepare('UPDATE group_conversation_digest_cache SET hit_count = COALESCE(hit_count, 0) + 1, last_hit_at = ? WHERE id = ?').run(now, row.id);
            return {
                ...normalized,
                hit_count: normalized.hit_count + 1,
                last_hit_at: now
            };
        } catch (e) {
            console.error('[DB] Error reading group conversation digest cache:', e.message);
            return null;
        }
    }

    function upsertConversationDigest(entry = {}) {
        try {
            const now = Date.now();
            db.prepare(`
                INSERT INTO conversation_digest_cache (
                    character_id, source_hash, digest_text, emotion_state,
                    relationship_state_json, open_loops_json, recent_facts_json, scene_state_json,
                    last_message_id, hit_count, created_at, last_hit_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(character_id) DO UPDATE SET
                    source_hash = excluded.source_hash,
                    digest_text = excluded.digest_text,
                    emotion_state = excluded.emotion_state,
                    relationship_state_json = excluded.relationship_state_json,
                    open_loops_json = excluded.open_loops_json,
                    recent_facts_json = excluded.recent_facts_json,
                    scene_state_json = excluded.scene_state_json,
                    last_message_id = excluded.last_message_id,
                    hit_count = COALESCE(conversation_digest_cache.hit_count, 0) + COALESCE(excluded.hit_count, 0),
                    created_at = CASE
                        WHEN COALESCE(conversation_digest_cache.created_at, 0) > 0 THEN conversation_digest_cache.created_at
                        ELSE excluded.created_at
                    END,
                    last_hit_at = CASE
                        WHEN COALESCE(excluded.last_hit_at, 0) > COALESCE(conversation_digest_cache.last_hit_at, 0) THEN excluded.last_hit_at
                        ELSE conversation_digest_cache.last_hit_at
                    END,
                    updated_at = excluded.updated_at
            `).run(
                String(entry.character_id || ''),
                String(entry.source_hash || ''),
                String(entry.digest_text || ''),
                String(entry.emotion_state || ''),
                stringifyJson(entry.relationship_state_json || []),
                stringifyJson(entry.open_loops_json || []),
                stringifyJson(entry.recent_facts_json || []),
                stringifyJson(entry.scene_state_json || []),
                Number(entry.last_message_id || 0),
                Number(entry.hit_count || 0),
                Number(entry.created_at || now),
                Number(entry.last_hit_at || 0),
                Number(entry.updated_at || now)
            );
            return true;
        } catch (e) {
            console.error('[DB] Error writing conversation digest cache:', e.message);
            return false;
        }
    }

    function upsertGroupConversationDigest(entry = {}) {
        try {
            const now = Date.now();
            db.prepare(`
                INSERT INTO group_conversation_digest_cache (
                    group_id, character_id, source_hash, digest_text, emotion_state,
                    relationship_state_json, open_loops_json, recent_facts_json, scene_state_json,
                    last_message_id, hit_count, created_at, last_hit_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(group_id, character_id) DO UPDATE SET
                    source_hash = excluded.source_hash,
                    digest_text = excluded.digest_text,
                    emotion_state = excluded.emotion_state,
                    relationship_state_json = excluded.relationship_state_json,
                    open_loops_json = excluded.open_loops_json,
                    recent_facts_json = excluded.recent_facts_json,
                    scene_state_json = excluded.scene_state_json,
                    last_message_id = excluded.last_message_id,
                    hit_count = COALESCE(group_conversation_digest_cache.hit_count, 0) + COALESCE(excluded.hit_count, 0),
                    created_at = CASE
                        WHEN COALESCE(group_conversation_digest_cache.created_at, 0) > 0 THEN group_conversation_digest_cache.created_at
                        ELSE excluded.created_at
                    END,
                    last_hit_at = CASE
                        WHEN COALESCE(excluded.last_hit_at, 0) > COALESCE(group_conversation_digest_cache.last_hit_at, 0) THEN excluded.last_hit_at
                        ELSE group_conversation_digest_cache.last_hit_at
                    END,
                    updated_at = excluded.updated_at
            `).run(
                String(entry.group_id || ''),
                String(entry.character_id || ''),
                String(entry.source_hash || ''),
                String(entry.digest_text || ''),
                String(entry.emotion_state || ''),
                stringifyJson(entry.relationship_state_json || []),
                stringifyJson(entry.open_loops_json || []),
                stringifyJson(entry.recent_facts_json || []),
                stringifyJson(entry.scene_state_json || []),
                Number(entry.last_message_id || 0),
                Number(entry.hit_count || 0),
                Number(entry.created_at || now),
                Number(entry.last_hit_at || 0),
                Number(entry.updated_at || now)
            );
            return true;
        } catch (e) {
            console.error('[DB] Error writing group conversation digest cache:', e.message);
            return false;
        }
    }

    const dbInstance = {

        rawRun,
        addTokenUsage,
        getLlmCache,
        getLlmCacheStats,
        getPromptBlockCache,
        getHistoryWindowCache,
        getLatestHistoryWindowCache,
        getConversationDigest,
        getGroupConversationDigest,
        initDb,
        getCharacters,
        getCharacter,
        addEmotionLog,
        addLlmDebugLog,
        addReplyDispatchLog,
        getEmotionLogs,
        getLlmDebugLogs,
        getReplyDispatchLogs,
        getCharacterHiddenState,
        updateCharacterHiddenState,
        updateCharacter,
        deleteCharacter,
        getMessages,
        getMessagesBefore,
        getLatestUserMessage,
        getVisibleMessages,
        getVisibleMessagesSince,
        getRecentUserConversationIntel,
        getLastUserMessageTimestamp,
        getUnsummarizedMessages,
        countUnsummarizedMessages,
        getOverflowMessages,
        countOverflowMessages,
        markOverflowMessagesSummarized,
        markMessagesSummarized,
        hideMessagesByRange,
        hideMessagesByIds,
        unhideMessages,
        addMessage,
        deleteMessage,
        markMessagesRead,
        getUnreadCount,
        getMessageCharacterId,
        clearMessages,
        clearCharacterMessageCaches,
        clearMemories,
        clearMoments,
        clearDiaries,
        clearConversationDigest,
        clearGroupConversationDigest,
        exportCharacterData,
        getMemories,
        getMemoriesByTimeRange,
        getMemory,
        getMemoryByDedupeKey,
        addMemory,
        markMemoriesRetrieved,
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
        getJealousyState,
        getTokenUsageSummary,
        pruneExpiredLlmCache,
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
        getOverflowGroupMessages,
        countOverflowGroupMessages,
        markOverflowGroupMessagesSummarized,
        markGroupMessagesSummarized,
        initializeSweepBaseline,
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
        incrementLlmCacheLookup,
        deleteLlmCache,
        upsertLlmCache,
        upsertPromptBlockCache,
        upsertHistoryWindowCache,
        upsertConversationDigest,
        upsertGroupConversationDigest,
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
    repairHistoryWindowCacheHitCounts();

    userDbCache.set(userId, dbInstance);
    return dbInstance;
}

function markUserDbDeleting(userId) {
    if (!userId) return;
    deletingUserDbIds.add(String(userId));
}

function unmarkUserDbDeleting(userId) {
    if (!userId) return;
    deletingUserDbIds.delete(String(userId));
}

function isUserDbDeleting(userId) {
    return deletingUserDbIds.has(String(userId));
}

module.exports = {
    getUserDb,
    userDbCache,
    markUserDbDeleting,
    unmarkUserDbDeleting,
    isUserDbDeleting
};
