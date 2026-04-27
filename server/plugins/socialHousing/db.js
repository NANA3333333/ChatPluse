function slugify(value, fallbackPrefix) {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_\-\u4e00-\u9fa5]/g, '')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
    return normalized || `${fallbackPrefix}_${Date.now()}`;
}

function parseLocations(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    const text = String(value || '').trim();
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch (e) {
        // fall through
    }
    return text.split(/[,\n，]/).map((v) => v.trim()).filter(Boolean);
}

const DEFAULT_CLASSES = [
    { id: 'lower', name: '底层', emoji: '🧩', description: '优先考虑生存和眼前压力，消费更谨慎。', work_bias: 3, consumption_bias: -3, prestige_bias: -2, social_barrier: 2, locations: ['factory', 'convenience', 'street'], sort: 1 },
    { id: 'working', name: '工薪', emoji: '💼', description: '围绕工作、房租和日常消费打转。', work_bias: 2, consumption_bias: -1, prestige_bias: 0, social_barrier: 1, locations: ['factory', 'restaurant', 'home'], sort: 2 },
    { id: 'petite_bourgeois', name: '小资', emoji: '✨', description: '重视体面和日常品质，更挑场景。', work_bias: 0, consumption_bias: 1, prestige_bias: 2, social_barrier: 1, locations: ['mall', 'park', 'restaurant'], sort: 3 },
    { id: 'middle', name: '中产', emoji: '🏡', description: '重视稳定、安全感和社会评价。', work_bias: -1, consumption_bias: 2, prestige_bias: 3, social_barrier: 2, locations: ['mall', 'school', 'park'], sort: 4 },
    { id: 'elite', name: '权贵', emoji: '👑', description: '对圈层和排面更敏感，很讲究身份感。', work_bias: -3, consumption_bias: 4, prestige_bias: 5, social_barrier: 4, locations: ['mall', 'casino', 'restaurant'], sort: 5 }
];

const DEFAULT_HOUSING = [
    { id: 'old_apartment', name: '老破小', emoji: '🏚️', description: '便宜，压抑，但能住。', weekly_rent: 22, deposit: 40, sale_price: 380, comfort: 8, prestige: 2, privacy: 4, sort: 1 },
    { id: 'shared_room', name: '合租单间', emoji: '🛏️', description: '预算友好，但很难真正放松。', weekly_rent: 28, deposit: 60, sale_price: 0, comfort: 12, prestige: 6, privacy: 8, sort: 2 },
    { id: 'shared_flat', name: '普通合租', emoji: '🏠', description: '城里最常见的稳定住法。', weekly_rent: 35, deposit: 80, sale_price: 0, comfort: 18, prestige: 10, privacy: 14, sort: 3 },
    { id: 'studio', name: '独立公寓', emoji: '🏢', description: '自己的空间更多，体面感也更强。', weekly_rent: 58, deposit: 120, sale_price: 980, comfort: 28, prestige: 22, privacy: 24, sort: 4 },
    { id: 'riverside', name: '江景公寓', emoji: '🌉', description: '贵，但舒适和体面都明显更高。', weekly_rent: 95, deposit: 220, sale_price: 1680, comfort: 40, prestige: 38, privacy: 32, sort: 5 },
    { id: 'luxury_loft', name: '高档 loft', emoji: '🌇', description: '高租金换来圈层门槛和强烈排面。', weekly_rent: 150, deposit: 360, sale_price: 2880, comfort: 48, prestige: 55, privacy: 38, sort: 6 }
];

const DEFAULT_AGENCY = {
    agency_name: '安家置业',
    agent_name: '安居顾问',
    business_scope: '租房,买房,换房,圈层建议'
};

module.exports = function initSocialHousingDb(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS social_housing_classes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            emoji TEXT DEFAULT '🧩',
            description TEXT DEFAULT '',
            work_bias INTEGER DEFAULT 0,
            consumption_bias INTEGER DEFAULT 0,
            prestige_bias INTEGER DEFAULT 0,
            social_barrier INTEGER DEFAULT 0,
            common_locations_json TEXT DEFAULT '[]',
            is_enabled INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0
        );
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS social_housing_homes (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            emoji TEXT DEFAULT '🏠',
            description TEXT DEFAULT '',
            weekly_rent REAL DEFAULT 0,
            deposit REAL DEFAULT 0,
            sale_price REAL DEFAULT 0,
            comfort INTEGER DEFAULT 0,
            prestige INTEGER DEFAULT 0,
            privacy INTEGER DEFAULT 0,
            is_enabled INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0
        );
    `);
    try { db.exec("ALTER TABLE social_housing_homes ADD COLUMN sale_price REAL DEFAULT 0;"); } catch (e) { }

    db.exec(`
        CREATE TABLE IF NOT EXISTS social_housing_bindings (
            character_id TEXT PRIMARY KEY,
            social_class_id TEXT DEFAULT '',
            housing_id TEXT DEFAULT '',
            housing_status TEXT DEFAULT 'stable',
            rent_weekly REAL DEFAULT 0,
            rent_due_day INTEGER DEFAULT 7,
            rent_due_at INTEGER DEFAULT 0,
            rent_last_paid_at INTEGER DEFAULT 0,
            deposit_paid REAL DEFAULT 0,
            missed_rent_count INTEGER DEFAULT 0,
            note TEXT DEFAULT '',
            updated_at INTEGER DEFAULT 0,
            FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
        );
    `);
    try { db.exec("ALTER TABLE social_housing_bindings ADD COLUMN rent_due_at INTEGER DEFAULT 0;"); } catch (e) { }
    try { db.exec("ALTER TABLE social_housing_bindings ADD COLUMN rent_last_paid_at INTEGER DEFAULT 0;"); } catch (e) { }
    try { db.exec("ALTER TABLE social_housing_bindings ADD COLUMN deposit_paid REAL DEFAULT 0;"); } catch (e) { }
    try { db.exec("ALTER TABLE social_housing_bindings ADD COLUMN missed_rent_count INTEGER DEFAULT 0;"); } catch (e) { }

    db.exec(`
        CREATE TABLE IF NOT EXISTS social_housing_agency (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER DEFAULT 1,
            agency_name TEXT DEFAULT '安家置业',
            agent_name TEXT DEFAULT '安居顾问',
            office_district TEXT DEFAULT 'street',
            business_scope TEXT DEFAULT '租房,买房,换房,圈层建议',
            persona_prompt TEXT DEFAULT '',
            llm_endpoint TEXT DEFAULT '',
            llm_key TEXT DEFAULT '',
            llm_model TEXT DEFAULT '',
            ad_enabled INTEGER DEFAULT 1,
            ad_min_interval_minutes INTEGER DEFAULT 120,
            ad_max_interval_minutes INTEGER DEFAULT 360,
            last_ad_at INTEGER DEFAULT 0,
            next_ad_at INTEGER DEFAULT 0,
            updated_at INTEGER DEFAULT 0
        );
    `);

    try { db.exec("ALTER TABLE social_housing_agency ADD COLUMN decision_interval_hours INTEGER DEFAULT 6;"); } catch (e) { }
    try { db.exec("ALTER TABLE social_housing_agency ADD COLUMN model_char_id TEXT DEFAULT 'auto';"); } catch (e) { }
    try { db.exec("ALTER TABLE social_housing_agency ADD COLUMN last_error TEXT DEFAULT '';"); } catch (e) { }
    try { db.exec("ALTER TABLE social_housing_agency ADD COLUMN last_error_at INTEGER DEFAULT 0;"); } catch (e) { }

    db.exec(`
        CREATE TABLE IF NOT EXISTS social_housing_ads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT DEFAULT '',
            content TEXT NOT NULL,
            trigger_type TEXT DEFAULT 'manual',
            office_district TEXT DEFAULT 'street',
            created_at INTEGER NOT NULL
        );
    `);

    function seedDefaults() {
        const classCount = db.prepare('SELECT COUNT(*) as c FROM social_housing_classes').get()?.c || 0;
        if (classCount === 0) {
            const stmt = db.prepare(`
                INSERT INTO social_housing_classes
                (id, name, emoji, description, work_bias, consumption_bias, prestige_bias, social_barrier, common_locations_json, is_enabled, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const item of DEFAULT_CLASSES) {
                stmt.run(
                    item.id,
                    item.name,
                    item.emoji,
                    item.description,
                    Number(item.work_bias || 0),
                    Number(item.consumption_bias || 0),
                    Number(item.prestige_bias || 0),
                    Number(item.social_barrier || 0),
                    JSON.stringify(item.locations || []),
                    1,
                    Number(item.sort || 0)
                );
            }
        }

        const housingCount = db.prepare('SELECT COUNT(*) as c FROM social_housing_homes').get()?.c || 0;
        if (housingCount === 0) {
            const stmt = db.prepare(`
                INSERT INTO social_housing_homes
                (id, name, emoji, description, weekly_rent, deposit, sale_price, comfort, prestige, privacy, is_enabled, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const item of DEFAULT_HOUSING) {
                stmt.run(
                    item.id,
                    item.name,
                    item.emoji,
                    item.description,
                    Number(item.weekly_rent || 0),
                    Number(item.deposit || 0),
                    Number(item.sale_price || 0),
                    Number(item.comfort || 0),
                    Number(item.prestige || 0),
                    Number(item.privacy || 0),
                    1,
                    Number(item.sort || 0)
                );
            }
        }

        const agencyExists = db.prepare('SELECT id FROM social_housing_agency WHERE id = 1').get();
        if (!agencyExists) {
            db.prepare(`
                INSERT INTO social_housing_agency
                (id, enabled, agency_name, agent_name, office_district, business_scope, persona_prompt, llm_endpoint, llm_key, llm_model, ad_enabled, ad_min_interval_minutes, ad_max_interval_minutes, last_ad_at, next_ad_at, updated_at, decision_interval_hours, model_char_id, last_error, last_error_at)
                VALUES (1, 1, ?, ?, 'street', ?, '', '', '', '', 1, 360, 360, 0, 0, ?, 6, 'auto', '', 0)
            `).run(DEFAULT_AGENCY.agency_name, DEFAULT_AGENCY.agent_name, DEFAULT_AGENCY.business_scope, Date.now());
        }
    }

    seedDefaults();

    function repairSeedData() {
        const updateClass = db.prepare(`
            UPDATE social_housing_classes
            SET
                name = ?,
                emoji = ?,
                description = ?,
                work_bias = ?,
                consumption_bias = ?,
                prestige_bias = ?,
                social_barrier = ?,
                common_locations_json = ?,
                is_enabled = 1,
                sort_order = ?
            WHERE id = ?
        `);
        for (const item of DEFAULT_CLASSES) {
            updateClass.run(
                item.name,
                item.emoji,
                item.description,
                Number(item.work_bias || 0),
                Number(item.consumption_bias || 0),
                Number(item.prestige_bias || 0),
                Number(item.social_barrier || 0),
                JSON.stringify(item.locations || []),
                Number(item.sort || 0),
                item.id
            );
        }

        const updateHousing = db.prepare(`
            UPDATE social_housing_homes
            SET
                name = ?,
                emoji = ?,
                description = ?,
                weekly_rent = ?,
                deposit = ?,
                sale_price = ?,
                comfort = ?,
                prestige = ?,
                privacy = ?,
                is_enabled = 1,
                sort_order = ?
            WHERE id = ?
        `);
        for (const item of DEFAULT_HOUSING) {
            updateHousing.run(
                item.name,
                item.emoji,
                item.description,
                Number(item.weekly_rent || 0),
                Number(item.deposit || 0),
                Number(item.sale_price || 0),
                Number(item.comfort || 0),
                Number(item.prestige || 0),
                Number(item.privacy || 0),
                Number(item.sort || 0),
                item.id
            );
        }

        db.prepare(`
            UPDATE social_housing_agency
            SET
                agency_name = COALESCE(NULLIF(agency_name, ''), ?),
                agent_name = COALESCE(NULLIF(agent_name, ''), ?),
                business_scope = COALESCE(NULLIF(business_scope, ''), ?),
                office_district = COALESCE(NULLIF(office_district, ''), 'street'),
                decision_interval_hours = CASE
                    WHEN decision_interval_hours IS NULL OR decision_interval_hours <= 0 THEN 6
                    ELSE decision_interval_hours
                END,
                model_char_id = COALESCE(NULLIF(model_char_id, ''), 'auto')
            WHERE id = 1
        `).run(DEFAULT_AGENCY.agency_name, DEFAULT_AGENCY.agent_name, DEFAULT_AGENCY.business_scope);
    }

    repairSeedData();
    try {
        db.prepare(`
            UPDATE social_housing_bindings
            SET rent_weekly = COALESCE(NULLIF(rent_weekly, 0), (
                    SELECT weekly_rent FROM social_housing_homes WHERE social_housing_homes.id = social_housing_bindings.housing_id
                )),
                rent_due_at = CASE
                    WHEN COALESCE(rent_due_at, 0) <= 0 AND housing_id != '' THEN ?
                    ELSE rent_due_at
                END
            WHERE housing_id != ''
        `).run(Date.now() + 7 * 24 * 60 * 60 * 1000);
    } catch (e) { }

    function getClasses() {
        return db.prepare('SELECT * FROM social_housing_classes ORDER BY sort_order ASC, name ASC').all().map((row) => ({
            ...row,
            common_locations: parseLocations(row.common_locations_json)
        }));
    }

    function getHousingTiers() {
        return db.prepare('SELECT * FROM social_housing_homes ORDER BY sort_order ASC, weekly_rent ASC').all().map((row) => ({
            ...row,
            weekly_rent: Number(row.weekly_rent || 0),
            deposit: Number(row.deposit || 0),
            sale_price: Number(row.sale_price || 0)
        }));
    }

    function upsertClass(payload) {
        const id = slugify(payload.id || payload.name, 'class');
        db.prepare(`
            INSERT OR REPLACE INTO social_housing_classes
            (id, name, emoji, description, work_bias, consumption_bias, prestige_bias, social_barrier, common_locations_json, is_enabled, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            String(payload.name || '').trim(),
            String(payload.emoji || '🧩').trim() || '🧩',
            String(payload.description || '').trim(),
            Number(payload.work_bias || 0),
            Number(payload.consumption_bias || 0),
            Number(payload.prestige_bias || 0),
            Number(payload.social_barrier || 0),
            JSON.stringify(parseLocations(payload.common_locations)),
            Number(payload.is_enabled ?? 1) === 1 ? 1 : 0,
            Number(payload.sort_order || 0)
        );
        return id;
    }

    function upsertHousing(payload) {
        const id = slugify(payload.id || payload.name, 'housing');
        db.prepare(`
            INSERT OR REPLACE INTO social_housing_homes
            (id, name, emoji, description, weekly_rent, deposit, sale_price, comfort, prestige, privacy, is_enabled, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            String(payload.name || '').trim(),
            String(payload.emoji || '🏠').trim() || '🏠',
            String(payload.description || '').trim(),
            Number(payload.weekly_rent || 0),
            Number(payload.deposit || 0),
            Number(payload.sale_price || 0),
            Number(payload.comfort || 0),
            Number(payload.prestige || 0),
            Number(payload.privacy || 0),
            Number(payload.is_enabled ?? 1) === 1 ? 1 : 0,
            Number(payload.sort_order || 0)
        );
        return id;
    }

    function deleteClass(id) {
        db.prepare('DELETE FROM social_housing_classes WHERE id = ?').run(id);
        db.prepare("UPDATE social_housing_bindings SET social_class_id = '' WHERE social_class_id = ?").run(id);
    }

    function deleteHousing(id) {
        db.prepare('DELETE FROM social_housing_homes WHERE id = ?').run(id);
        db.prepare("UPDATE social_housing_bindings SET housing_id = '' WHERE housing_id = ?").run(id);
    }

    function getHousingById(id) {
        if (!id) return null;
        const row = db.prepare('SELECT * FROM social_housing_homes WHERE id = ?').get(String(id));
        if (!row) return null;
        return {
            ...row,
            weekly_rent: Number(row.weekly_rent || 0),
            deposit: Number(row.deposit || 0),
            sale_price: Number(row.sale_price || 0)
        };
    }

    function normalizeRentDueAt(payload = {}, current = null, home = null) {
        const explicit = Number(payload.rent_due_at || 0);
        if (explicit > 0) return explicit;
        const existingDueAt = Number(current?.rent_due_at || 0);
        const housingChanged = String(payload.housing_id || '') !== String(current?.housing_id || '');
        if (existingDueAt > 0 && !housingChanged) return existingDueAt;
        const dueDays = Math.max(1, Math.min(30, Number(payload.rent_due_day || current?.rent_due_day || 7)));
        return Date.now() + dueDays * 24 * 60 * 60 * 1000;
    }

    function saveBinding(characterId, payload) {
        const current = db.prepare('SELECT * FROM social_housing_bindings WHERE character_id = ?').get(characterId) || null;
        const nextHousingId = String(payload.housing_id || '').trim();
        const home = getHousingById(nextHousingId);
        const rentWeekly = Number(payload.rent_weekly || 0) || Number(home?.weekly_rent || 0);
        const depositPaid = Number(payload.deposit_paid ?? current?.deposit_paid ?? 0) || 0;
        const nextDueAt = normalizeRentDueAt(payload, current, home);
        const housingChanged = String(nextHousingId || '') !== String(current?.housing_id || '');
        db.prepare(`
            INSERT INTO social_housing_bindings
            (character_id, social_class_id, housing_id, housing_status, rent_weekly, rent_due_day, rent_due_at, rent_last_paid_at, deposit_paid, missed_rent_count, note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(character_id) DO UPDATE SET
                social_class_id=excluded.social_class_id,
                housing_id=excluded.housing_id,
                housing_status=excluded.housing_status,
                rent_weekly=excluded.rent_weekly,
                rent_due_day=excluded.rent_due_day,
                rent_due_at=excluded.rent_due_at,
                rent_last_paid_at=excluded.rent_last_paid_at,
                deposit_paid=excluded.deposit_paid,
                missed_rent_count=excluded.missed_rent_count,
                note=excluded.note,
                updated_at=excluded.updated_at
        `).run(
            characterId,
            String(payload.social_class_id || '').trim(),
            nextHousingId,
            String(payload.housing_status || (housingChanged ? 'stable' : current?.housing_status) || 'stable').trim() || 'stable',
            rentWeekly,
            Number(payload.rent_due_day || 7),
            nextDueAt,
            Number(payload.rent_last_paid_at ?? current?.rent_last_paid_at ?? 0) || 0,
            depositPaid,
            Number(payload.missed_rent_count ?? (housingChanged ? 0 : current?.missed_rent_count) ?? 0) || 0,
            String(payload.note || '').trim(),
            Date.now()
        );
    }

    function getBindings() {
        return db.prepare('SELECT * FROM social_housing_bindings').all();
    }

    function getBinding(characterId) {
        const row = db.prepare('SELECT * FROM social_housing_bindings WHERE character_id = ?').get(characterId);
        return row || null;
    }

    function getCharactersWithBindings(getCharacters) {
        const characters = getCharacters();
        const bindings = new Map(getBindings().map((row) => [String(row.character_id), row]));
        const classMap = new Map(getClasses().map((row) => [String(row.id), row]));
        const housingMap = new Map(getHousingTiers().map((row) => [String(row.id), row]));
        return characters.map((char) => {
            const binding = bindings.get(String(char.id)) || null;
            const socialClass = binding?.social_class_id ? classMap.get(String(binding.social_class_id)) || null : null;
            const housing = binding?.housing_id ? housingMap.get(String(binding.housing_id)) || null : null;
            return {
                id: char.id,
                name: char.name,
                avatar: char.avatar,
                wallet: Number(char.wallet || 0),
                location: String(char.location || ''),
                city_status: String(char.city_status || ''),
                api_endpoint: String(char.api_endpoint || ''),
                api_key: String(char.api_key || ''),
                model_name: String(char.model_name || ''),
                binding: binding ? {
                    ...binding,
                    rent_weekly: Number(binding.rent_weekly || 0),
                    rent_due_day: Number(binding.rent_due_day || 7),
                    rent_due_at: Number(binding.rent_due_at || 0),
                    rent_last_paid_at: Number(binding.rent_last_paid_at || 0),
                    deposit_paid: Number(binding.deposit_paid || 0),
                    missed_rent_count: Number(binding.missed_rent_count || 0),
                    social_class: socialClass,
                    housing
                } : null
            };
        });
    }

    function getAgencyConfig() {
        const row = db.prepare('SELECT * FROM social_housing_agency WHERE id = 1').get() || {};
        return {
            enabled: Number(row.enabled ?? 1),
            agency_name: String(row.agency_name || DEFAULT_AGENCY.agency_name),
            agent_name: String(row.agent_name || DEFAULT_AGENCY.agent_name),
            office_district: String(row.office_district || 'street'),
            business_scope: String(row.business_scope || DEFAULT_AGENCY.business_scope),
            persona_prompt: String(row.persona_prompt || ''),
            llm_endpoint: String(row.llm_endpoint || ''),
            llm_key: String(row.llm_key || ''),
            llm_model: String(row.llm_model || ''),
            ad_enabled: Number(row.ad_enabled ?? 1),
            ad_min_interval_minutes: Number(row.ad_min_interval_minutes || 360),
            ad_max_interval_minutes: Number(row.ad_max_interval_minutes || 360),
            decision_interval_hours: Math.max(1, Number(row.decision_interval_hours || 6)),
            model_char_id: String(row.model_char_id || 'auto'),
            last_ad_at: Number(row.last_ad_at || 0),
            next_ad_at: Number(row.next_ad_at || 0),
            last_error: String(row.last_error || ''),
            last_error_at: Number(row.last_error_at || 0),
            updated_at: Number(row.updated_at || 0)
        };
    }

    function saveAgencyConfig(payload = {}) {
        const current = getAgencyConfig();
        const next = {
            ...current,
            ...payload
        };
        db.prepare(`
            INSERT INTO social_housing_agency
            (id, enabled, agency_name, agent_name, office_district, business_scope, persona_prompt, llm_endpoint, llm_key, llm_model, ad_enabled, ad_min_interval_minutes, ad_max_interval_minutes, last_ad_at, next_ad_at, updated_at, decision_interval_hours, model_char_id, last_error, last_error_at)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                enabled=excluded.enabled,
                agency_name=excluded.agency_name,
                agent_name=excluded.agent_name,
                office_district=excluded.office_district,
                business_scope=excluded.business_scope,
                persona_prompt=excluded.persona_prompt,
                llm_endpoint=excluded.llm_endpoint,
                llm_key=excluded.llm_key,
                llm_model=excluded.llm_model,
                ad_enabled=excluded.ad_enabled,
                ad_min_interval_minutes=excluded.ad_min_interval_minutes,
                ad_max_interval_minutes=excluded.ad_max_interval_minutes,
                last_ad_at=excluded.last_ad_at,
                next_ad_at=excluded.next_ad_at,
                decision_interval_hours=excluded.decision_interval_hours,
                model_char_id=excluded.model_char_id,
                last_error=excluded.last_error,
                last_error_at=excluded.last_error_at,
                updated_at=excluded.updated_at
        `).run(
            Number(next.enabled ?? 1) === 1 ? 1 : 0,
            String(next.agency_name || DEFAULT_AGENCY.agency_name).trim() || DEFAULT_AGENCY.agency_name,
            String(next.agent_name || DEFAULT_AGENCY.agent_name).trim() || DEFAULT_AGENCY.agent_name,
            String(next.office_district || 'street').trim() || 'street',
            String(next.business_scope || DEFAULT_AGENCY.business_scope).trim() || DEFAULT_AGENCY.business_scope,
            String(next.persona_prompt || '').trim(),
            String(next.llm_endpoint || '').trim(),
            String(next.llm_key || '').trim(),
            String(next.llm_model || '').trim(),
            Number(next.ad_enabled ?? 1) === 1 ? 1 : 0,
            Math.max(10, Number(next.ad_min_interval_minutes || 360)),
            Math.max(10, Number(next.ad_max_interval_minutes || 360)),
            Number(next.last_ad_at || 0),
            Number(next.next_ad_at || 0),
            Date.now(),
            Math.max(1, Number(next.decision_interval_hours || 6)),
            String(next.model_char_id || 'auto').trim() || 'auto',
            String(next.last_error || '').trim(),
            Number(next.last_error_at || 0)
        );
        return getAgencyConfig();
    }

    function addAgencyAd({ title = '', content = '', trigger_type = 'manual', office_district = 'street' }) {
        const createdAt = Date.now();
        db.prepare(`
            INSERT INTO social_housing_ads (title, content, trigger_type, office_district, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(
            String(title || '').trim(),
            String(content || '').trim(),
            String(trigger_type || 'manual').trim(),
            String(office_district || 'street').trim(),
            createdAt
        );
        return createdAt;
    }

    function getAgencyAds(limit = 20) {
        return db.prepare('SELECT * FROM social_housing_ads ORDER BY created_at DESC LIMIT ?').all(limit);
    }

    function getAgencyAdById(id) {
        return db.prepare('SELECT * FROM social_housing_ads WHERE id = ?').get(Number(id)) || null;
    }

    function deleteAgencyAd(id) {
        db.prepare('DELETE FROM social_housing_ads WHERE id = ?').run(Number(id));
    }

    function getHousingContextForCharacter(characterId) {
        const binding = getBinding(characterId);
        if (!binding) return null;
        const home = binding.housing_id ? getHousingById(binding.housing_id) : null;
        const socialClass = binding.social_class_id
            ? db.prepare('SELECT * FROM social_housing_classes WHERE id = ?').get(binding.social_class_id)
            : null;
        return {
            binding: {
                ...binding,
                rent_weekly: Number(binding.rent_weekly || 0),
                rent_due_day: Number(binding.rent_due_day || 7),
                rent_due_at: Number(binding.rent_due_at || 0),
                rent_last_paid_at: Number(binding.rent_last_paid_at || 0),
                deposit_paid: Number(binding.deposit_paid || 0),
                missed_rent_count: Number(binding.missed_rent_count || 0)
            },
            housing: home,
            social_class: socialClass
        };
    }

    function markRentPaid(characterId, paidAt = Date.now()) {
        const binding = getBinding(characterId);
        if (!binding) return null;
        const dueDays = Math.max(1, Math.min(30, Number(binding.rent_due_day || 7)));
        db.prepare(`
            UPDATE social_housing_bindings
            SET housing_status = 'stable',
                rent_last_paid_at = ?,
                rent_due_at = ?,
                missed_rent_count = 0,
                updated_at = ?
            WHERE character_id = ?
        `).run(paidAt, paidAt + dueDays * 24 * 60 * 60 * 1000, Date.now(), characterId);
        return getBinding(characterId);
    }

    function markRentOverdue(characterId, retryAt = Date.now() + 24 * 60 * 60 * 1000) {
        const binding = getBinding(characterId);
        if (!binding) return null;
        db.prepare(`
            UPDATE social_housing_bindings
            SET housing_status = 'overdue',
                rent_due_at = ?,
                missed_rent_count = missed_rent_count + 1,
                updated_at = ?
            WHERE character_id = ?
        `).run(retryAt, Date.now(), characterId);
        return getBinding(characterId);
    }

    function getDueRentBindings(now = Date.now()) {
        return db.prepare(`
            SELECT b.*, h.name AS housing_name, h.emoji AS housing_emoji, h.weekly_rent AS home_weekly_rent
            FROM social_housing_bindings b
            LEFT JOIN social_housing_homes h ON h.id = b.housing_id
            WHERE b.housing_id != ''
              AND COALESCE(b.rent_weekly, h.weekly_rent, 0) > 0
              AND COALESCE(b.rent_due_at, 0) > 0
              AND b.rent_due_at <= ?
        `).all(now);
    }

    return {
        getClasses,
        getHousingTiers,
        getHousingById,
        upsertClass,
        upsertHousing,
        deleteClass,
        deleteHousing,
        saveBinding,
        getBinding,
        getCharactersWithBindings,
        getHousingContextForCharacter,
        markRentPaid,
        markRentOverdue,
        getDueRentBindings,
        getAgencyConfig,
        saveAgencyConfig,
        addAgencyAd,
        getAgencyAds,
        getAgencyAdById,
        deleteAgencyAd
    };
};
