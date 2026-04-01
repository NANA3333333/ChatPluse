const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { LocalIndex } = require('vectra');
const { callLLM } = require('./llm');
const { getUserDb } = require('./db');
const { buildUniversalContext } = require('./contextBuilder');
const qdrant = require('./qdrant');

const LOCAL_EMBEDDING_MODEL = process.env.LOCAL_EMBEDDING_MODEL || 'Xenova/bge-m3';
const LOCAL_EMBEDDING_DIM = Number(process.env.LOCAL_EMBEDDING_DIM || 1024);
const LOCAL_EMBEDDING_INDEX_TAG = process.env.LOCAL_EMBEDDING_INDEX_TAG || 'bge_m3_1024';

// Dynamic import for transformers.js
let pipeline = null;
let extractionDisabled = false;
const embeddingCache = new Map();
const EMBEDDING_CACHE_LIMIT = 256;

let globalWsClientsResolver = null;
const activeSweepJobs = new Set();
const SWEEP_COOLDOWN_MS = 5 * 60 * 1000;
function setWsClientsResolver(resolver) {
    globalWsClientsResolver = resolver;
}

async function getExtractor() {
    if (extractionDisabled) return null;
    if (!pipeline) {
        try {
            const transformers = await import('@xenova/transformers');
            pipeline = await transformers.pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL);
        } catch (e) {
            console.error('[Memory] Xenova/ONNX initialization failed. Disabling local embeddings. Error:', e.message);
            extractionDisabled = true;
            return null;
        }
    }
    return pipeline;
}

async function getEmbedding(text) {
    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
        return Array.from({ length: LOCAL_EMBEDDING_DIM }, () => 0);
    }
    if (embeddingCache.has(normalizedText)) {
        return embeddingCache.get(normalizedText);
    }
    const extractor = await getExtractor();
    if (!extractor) {
        // Return a zero-vector if local embeddings are broken
        return Array.from({ length: LOCAL_EMBEDDING_DIM }, () => 0);
    }
    const output = await extractor(normalizedText, { pooling: 'mean', normalize: true });
    const vector = Array.from(output.data);
    embeddingCache.set(normalizedText, vector);
    if (embeddingCache.size > EMBEDDING_CACHE_LIMIT) {
        const oldestKey = embeddingCache.keys().next().value;
        if (oldestKey) embeddingCache.delete(oldestKey);
    }
    return vector;
}

function yieldToEventLoop() {
    return new Promise(resolve => setImmediate(resolve));
}

// Memory vector indices cache: UserId_CharacterID -> LocalIndex
const indices = new Map();
let qdrantAvailability = null;

function isRecoverableQdrantError(error) {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('already exists');
}

async function canUseQdrant() {
    if (qdrantAvailability !== null) return qdrantAvailability;
    qdrantAvailability = await qdrant.healthcheck();
    if (qdrantAvailability) {
        console.log('[Memory] Qdrant is available. Vector operations will use Qdrant first.');
    } else {
        console.warn('[Memory] Qdrant is unavailable. Falling back to local vectra indices.');
    }
    return qdrantAvailability;
}

async function getVectorIndex(userId, characterId) {
    const key = `${userId}_${characterId}`;
    if (indices.has(key)) {
        return indices.get(key);
    }
    const dir = path.join(__dirname, '..', 'data', 'vectors', LOCAL_EMBEDDING_INDEX_TAG, String(userId), String(characterId));
    const indexPath = path.join(dir, 'index.json');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(indexPath)) {
        try {
            const stat = fs.statSync(indexPath);
            if (stat.isDirectory()) {
                const legacyIndexFile = path.join(indexPath, 'index.json');
                const tempIndexFile = path.join(dir, '__index_migrated__.json');
                if (fs.existsSync(legacyIndexFile) && fs.statSync(legacyIndexFile).isFile()) {
                    fs.copyFileSync(legacyIndexFile, tempIndexFile);
                }
                fs.rmSync(indexPath, { recursive: true, force: true });
                if (fs.existsSync(tempIndexFile)) {
                    fs.renameSync(tempIndexFile, indexPath);
                }
            }
        } catch (e) {
            try { fs.rmSync(indexPath, { recursive: true, force: true }); } catch (err) { }
        }
    }
    const index = new LocalIndex(indexPath);
    // Create if not exists OR if it exists but is corrupted
    try {
        const isCreated = await index.isIndexCreated();
        if (!isCreated) {
            await index.createIndex({
                version: 1,
                deleteConfig: { enabled: false }, // Simple config
                dimension: LOCAL_EMBEDDING_DIM
            });
        }
    } catch (err) {
        // If it throws "Index does not exist" or "Unexpected end of JSON input", recreate it
        console.warn(`[Memory] Vector index corrupted/missing for ${characterId}, recreating...`, err.message);
        try { fs.rmSync(indexPath, { recursive: true, force: true }); } catch (e) { }
        fs.mkdirSync(dir, { recursive: true });
        await index.createIndex({
            version: 1,
            deleteConfig: { enabled: false },
            dimension: LOCAL_EMBEDDING_DIM
        });
    }
    indices.set(key, index);
    return index;
}

const memoryCache = new Map();

function clearMemoryCache(userId) {
    if (!userId) return;
    memoryCache.delete(String(userId));
}

function getMemory(userId) {
    const cacheKey = String(userId);
    if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);

    const getDb = () => getUserDb(userId);

    function parseLooseJson(value, fallback = null) {
        if (value == null || value === '') return fallback;
        if (typeof value !== 'string') return value;
        try {
            return JSON.parse(value);
        } catch (e) {
            return fallback;
        }
    }

    function normalizeStringArray(value) {
        if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return [];
            const parsed = parseLooseJson(trimmed, null);
            if (Array.isArray(parsed)) return parsed.map(v => String(v).trim()).filter(Boolean);
            return trimmed.split(/[,，、\n]/).map(v => v.trim()).filter(Boolean);
        }
        return [];
    }

    function normalizeRelationshipArray(value) {
        if (Array.isArray(value)) return value.filter(Boolean);
        if (value && typeof value === 'object') return [value];
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return [];
            const parsed = parseLooseJson(trimmed, null);
            if (Array.isArray(parsed)) return parsed.filter(Boolean);
            if (parsed && typeof parsed === 'object') return [parsed];
            return [{ summary: trimmed }];
        }
        return [];
    }

    function summarizeRelationships(relationships) {
        return normalizeRelationshipArray(relationships).map(rel => {
            if (typeof rel === 'string') return rel;
            return rel.summary || rel.type || JSON.stringify(rel);
        }).filter(Boolean);
    }

    const CITY_MEMORY_LOCATIONS = new Set([
        'park', 'restaurant', 'home', 'factory', 'convenience_store', 'school', 'street',
        'mall', 'cafe', 'office', 'hospital'
    ]);

    function looksLikeCityMemory(memoryData = {}) {
        const type = String(memoryData.memory_type || '').toLowerCase();
        const location = String(memoryData.location || '').trim().toLowerCase();
        const text = [
            memoryData.summary,
            memoryData.content,
            memoryData.event
        ].filter(Boolean).join(' ').toLowerCase();
        if (type.startsWith('city')) return true;
        if (CITY_MEMORY_LOCATIONS.has(location)) return true;
        return /(city activity|公园|餐厅|便利店|商业街|工厂|街上|回到家|在家|长椅|吃饭|散步|发呆|路灯|晚风|路边)/i.test(text);
    }

    function looksLikeReplyDrivenCityNarration(memoryData = {}) {
        const text = [
            memoryData.summary,
            memoryData.content,
            memoryData.event
        ].filter(Boolean).join(' ');
        if (!text) return false;
        return /(被私聊|刚才那句私聊|这轮私聊|嘴上还|话里还挂着点|脚步却已经转向|把这口气全压进了行动里|脑子里还挂着刚才那句私聊|一边嘴硬一边|边走边在心里继续跟你较劲)/i.test(text);
    }

    function hasHighValueMemorySignals(memoryData = {}) {
        const type = String(memoryData.memory_type || '').toLowerCase();
        const people = normalizeStringArray(memoryData.people_json ?? memoryData.people);
        const relationships = normalizeRelationshipArray(memoryData.relationship_json ?? memoryData.relationships);
        const emotion = String(memoryData.emotion || '').trim();
        const sourceMessageIds = normalizeStringArray(memoryData.source_message_ids_json);
        const text = [
            memoryData.summary,
            memoryData.content,
            memoryData.event
        ].filter(Boolean).join(' ');
        if (['relationship', 'plan', 'preference', 'emotion'].includes(type)) return true;
        if (Number(memoryData.importance || 0) >= 7) return true;
        if (people.length > 0 || relationships.length > 0) return true;
        if (sourceMessageIds.length > 0) return true;
        if (looksLikeCityMemory(memoryData) && looksLikeReplyDrivenCityNarration(memoryData)) return false;
        if (emotion && emotion.length >= 2 && !looksLikeCityMemory(memoryData)) return true;
        if (looksLikeCityMemory(memoryData)) {
            return /(鐢ㄦ埛|nana|user|鍛婄櫧|鎵胯|绾﹀畾|鍚垫灦|鍐茬獊|鍜屽ソ|绉樺瘑|瀵嗙爜|娌￠挶|鍙墿|宕╂簝|浣忛櫌|鍙椾激|濒死|透支|极限|昏倒|发烧|还债|还不起|破产)/i.test(text);
        }
        return /(用户|nana|user|告白|承诺|约定|吵架|冲突|和好|吃醋|嫉妒|委屈|喜欢|讨厌|秘密|密码|没钱|只剩|崩溃|住院|受伤)/i.test(text);
    }

    function isRoutineCityMemory(memoryData = {}) {
        if (!looksLikeCityMemory(memoryData)) return false;
        if (looksLikeReplyDrivenCityNarration(memoryData)) return true;
        if (hasHighValueMemorySignals(memoryData)) return false;
        const type = String(memoryData.memory_type || '').toLowerCase();
        if (!type || ['event', 'fact', 'city_event', 'city_log'].includes(type)) {
            return true;
        }
        return false;
    }

    function classifyUserCenteredMemory(memoryData = {}) {
        const text = [
            memoryData.summary,
            memoryData.content,
            memoryData.event,
            memoryData.relationships,
            memoryData.people,
            memoryData.location,
            memoryData.emotion
        ].filter(Boolean).join(' ').toLowerCase();
        const type = String(memoryData.memory_type || '').toLowerCase();
        const importance = Number(memoryData.importance || 5);
        const peopleList = Array.isArray(memoryData.people_json)
            ? memoryData.people_json.map(v => String(v || '').toLowerCase())
            : String(memoryData.people || '').toLowerCase().split(/[,\s/]+/).filter(Boolean);
        const hasUser = /(nana|user|用户|你\b)/i.test(text) || peopleList.some(v => /(nana|user|用户)/i.test(v));
        const hasCharacter = /(claude|gemini|grok|glm|gpt|assistant|ai|角色|对方|ta\b|他\b|她\b)/i.test(text)
            || peopleList.some(v => /(claude|gemini|grok|glm|gpt|assistant|ai|角色)/i.test(v));
        const hasRelationshipSignal = /(关系|和好|吵架|冲突|承诺|信任|嫉妒|吃醋|委屈|喜欢|告白|暧昧|拉扯|陪|安慰|伤到|hurt|jealous|relationship|trust|conflict|reconcile|affection)/i.test(text)
            || type === 'relationship';
        const hasLoveConfessionSignal = /(我喜欢你|我爱你|喜欢你|爱你|告白|表白|心动|暧昧|想和你在一起|对你有感觉|不是第一次说|说过很多次|反复示爱|明确示爱|关系确认|只喜欢你|只想要你)/i.test(text);
        const hasUserDemandSignal = /(答应我|你要答应|你得答应|别离开我|不要离开我|只准|不准|要一直陪我|必须回应我|你要记住|不许忘|你得哄我|你要陪我|别找别人|只能对我)/i.test(text);
        const hasCurrentArcSignal = /(最近|这段时间|目前|现在|正在|打算|准备|计划|offer|startup|ceo|实习|面试|简历|求职|找工作|工作|公司|入职|考研|学校|项目|论文|焦虑|内耗|压力|病|身体|恢复)/i.test(text)
            || ['plan', 'emotion'].includes(type);
        const hasIdentitySignal = /(学历|本科|专业|学校|背景|家庭|性格|偏好|喜欢|讨厌|习惯|口味|过敏|身体状况|健康问题|长期目标|价值观|梦想|身份|经历)/i.test(text)
            || type === 'preference';

        if ((hasLoveConfessionSignal || hasUserDemandSignal) && (hasUser || hasCharacter)) {
            return {
                memory_focus: 'relationship',
                memory_tier: 'core'
            };
        }
        if (hasRelationshipSignal && (hasUser || hasCharacter)) {
            return {
                memory_focus: 'relationship',
                memory_tier: importance >= 5 ? 'core' : 'active'
            };
        }
        if (hasCurrentArcSignal && hasUser) {
            return {
                memory_focus: 'user_current_arc',
                memory_tier: importance >= 5 ? 'core' : 'active'
            };
        }
        if (hasIdentitySignal && hasUser) {
            return {
                memory_focus: 'user_profile',
                memory_tier: importance >= 4 ? 'core' : 'active'
            };
        }
        if (importance >= 6) {
            return {
                memory_focus: 'general',
                memory_tier: 'active'
            };
        }
        return {
            memory_focus: 'general',
            memory_tier: 'ambient'
        };
    }

    function computeMemoryRetrievalWeight(memoryData = {}) {
        const type = String(memoryData.memory_type || '').toLowerCase();
        const inferred = classifyUserCenteredMemory(memoryData);
        const tier = String(memoryData.memory_tier || inferred.memory_tier || '').toLowerCase();
        const focus = String(memoryData.memory_focus || inferred.memory_focus || '').toLowerCase();
        if (isRoutineCityMemory(memoryData)) return 0.42;
        if (looksLikeCityMemory(memoryData)) return hasHighValueMemorySignals(memoryData) ? 0.78 : 0.6;
        let weight = 1;
        if (['relationship', 'plan', 'preference', 'emotion'].includes(type)) weight += 0.16;
        if (tier === 'core') weight += 0.4;
        else if (tier === 'active') weight += 0.18;
        if (focus === 'relationship') weight += 0.34;
        else if (focus === 'user_current_arc') weight += 0.22;
        else if (focus === 'user_profile') weight += 0.2;
        return weight;
    }

    function computeMemoryTierBoost(memoryData = {}) {
        const inferred = classifyUserCenteredMemory(memoryData);
        const tier = String(memoryData.memory_tier || inferred.memory_tier || '').toLowerCase();
        const focus = String(memoryData.memory_focus || inferred.memory_focus || '').toLowerCase();
        let boost = 0;
        if (tier === 'core') boost += 0.22;
        else if (tier === 'active') boost += 0.1;
        if (focus === 'relationship') boost += 0.26;
        else if (focus === 'user_current_arc') boost += 0.16;
        else if (focus === 'user_profile') boost += 0.14;
        return boost;
    }

    function computeUserProfilePriorityBoost(memoryData = {}, queryText = '', queryVariants = []) {
        const inferred = classifyUserCenteredMemory(memoryData);
        const tier = String(memoryData.memory_tier || inferred.memory_tier || '').toLowerCase();
        const focus = String(memoryData.memory_focus || inferred.memory_focus || '').toLowerCase();
        const type = String(memoryData.memory_type || '').toLowerCase();
        const text = [
            memoryData?.summary,
            memoryData?.content,
            memoryData?.event
        ].filter(Boolean).join(' ');
        const queryContext = [
            String(queryText || ''),
            ...(Array.isArray(queryVariants) ? queryVariants : [])
        ].join('\n');

        let boost = 0;
        if (focus === 'user_profile') {
            boost += 0.42;
            if (tier === 'core') boost += 0.18;
        } else if (focus === 'user_current_arc') {
            boost += 0.08;
            if (tier === 'core') boost += 0.06;
        }

        if (/(关于我|记得我|个人信息|用户信息|背景|学习|学历|学校|专业|年级|工作|实习|职业|经历|情况|介绍)/i.test(queryContext)) {
            if (focus === 'user_profile') boost += 0.72;
            else if (focus === 'user_current_arc') boost += 0.34;
            if (focus === 'relationship') boost -= 0.12;
            if (type === 'emotion' || /(焦虑|难过|委屈|情绪|内耗|痛苦|崩溃)/i.test(text)) {
                boost -= 0.18;
            }
        }

        return boost;
    }

    function buildDedupeKey(characterId, memoryData) {
        const location = (memoryData.location || '').trim().toLowerCase();
        const type = (memoryData.memory_type || 'event').trim().toLowerCase();
        const summary = (memoryData.summary || memoryData.event || '').trim().toLowerCase();
        if (!summary) return '';
        return [characterId, type, location, summary].filter(Boolean).join('::').slice(0, 240);
    }

    function formatAbsoluteTimestamp(ts) {
        const value = Number(ts || 0);
        if (!Number.isFinite(value) || value <= 0) return '';
        try {
            return new Date(value).toLocaleString('en-US');
        } catch (e) {
            return '';
        }
    }

    function formatSourceTimeRange(startTs, endTs) {
        const start = Number(startTs || 0);
        const end = Number(endTs || 0);
        const startText = formatAbsoluteTimestamp(start);
        const endText = formatAbsoluteTimestamp(end);
        if (startText && endText) {
            return start === end ? startText : `${startText} -> ${endText}`;
        }
        return startText || endText || '';
    }

    function buildSourceTimeMeta(messages = []) {
        const rows = (Array.isArray(messages) ? messages : []).filter(Boolean);
        const timestamps = rows
            .map(msg => Number(msg?.timestamp || 0))
            .filter(ts => Number.isFinite(ts) && ts > 0)
            .sort((a, b) => a - b);
        const messageIds = rows
            .map(msg => msg?.id)
            .filter(id => id !== undefined && id !== null)
            .map(id => String(id));
        const source_started_at = timestamps[0] || 0;
        const source_ended_at = timestamps[timestamps.length - 1] || source_started_at || 0;
        return {
            source_started_at,
            source_ended_at,
            source_time_text: formatSourceTimeRange(source_started_at, source_ended_at),
            source_message_count: rows.length,
            source_message_ids_json: messageIds
        };
    }

    function normalizeMemoryPayload(rawMemoryData = {}, options = {}) {
        const peopleList = normalizeStringArray(rawMemoryData.people_json ?? rawMemoryData.people);
        const itemList = normalizeStringArray(rawMemoryData.items_json ?? rawMemoryData.items);
        const relationshipList = normalizeRelationshipArray(rawMemoryData.relationship_json ?? rawMemoryData.relationships);
        const relationshipSummary = summarizeRelationships(relationshipList);
        const summary = (rawMemoryData.summary || rawMemoryData.event || '').trim();
        const content = (rawMemoryData.content || rawMemoryData.event || summary).trim();
        let memoryType = rawMemoryData.memory_type || 'event';
        if (!rawMemoryData.memory_type && looksLikeCityMemory(rawMemoryData)) {
            memoryType = 'city_event';
        }
        let importance = Math.max(1, Math.min(10, Number(rawMemoryData.importance) || 5));
        const classified = classifyUserCenteredMemory({
            ...rawMemoryData,
            memory_type: memoryType,
            importance,
            people_json: peopleList,
            relationship_json: relationshipList,
            people: peopleList.join(', '),
            relationships: relationshipSummary.join('; ')
        });
        const normalized = {
            memory_type: memoryType,
            summary: summary || content || '(empty memory)',
            content: content || summary || '(empty memory)',
            time: (rawMemoryData.time || '').trim(),
            location: (rawMemoryData.location || '').trim(),
            people_json: peopleList,
            items_json: itemList,
            relationship_json: relationshipList,
            people: peopleList.join(', '),
            items: itemList.join(', '),
            relationships: relationshipSummary.join('; '),
            event: (rawMemoryData.event || summary || content || '(empty memory)').trim(),
            emotion: (rawMemoryData.emotion || '').trim(),
            importance,
            source_message_ids_json: normalizeStringArray(rawMemoryData.source_message_ids_json),
            dedupe_key: rawMemoryData.dedupe_key || buildDedupeKey(options.characterId || '', rawMemoryData),
            is_archived: Number(rawMemoryData.is_archived || 0),
            surprise_score: Math.max(1, Math.min(10, Number(rawMemoryData.surprise_score) || importance)),
            source_started_at: Number(rawMemoryData.source_started_at || 0),
            source_ended_at: Number(rawMemoryData.source_ended_at || 0),
            source_time_text: String(rawMemoryData.source_time_text || '').trim(),
            source_message_count: Number(rawMemoryData.source_message_count || 0),
            memory_tier: String(rawMemoryData.memory_tier || classified.memory_tier || 'ambient').trim().toLowerCase(),
            memory_focus: String(rawMemoryData.memory_focus || classified.memory_focus || 'general').trim().toLowerCase()
        };
        if (!normalized.source_time_text) {
            normalized.source_time_text = formatSourceTimeRange(normalized.source_started_at, normalized.source_ended_at);
        }
        if (!['core', 'active', 'ambient'].includes(normalized.memory_tier)) {
            normalized.memory_tier = classified.memory_tier || 'ambient';
        }
        if (!['user_profile', 'user_current_arc', 'relationship', 'general'].includes(normalized.memory_focus)) {
            normalized.memory_focus = classified.memory_focus || 'general';
        }
        if (isRoutineCityMemory(normalized)) {
            normalized.memory_type = 'city_log';
            normalized.importance = Math.min(normalized.importance, 3);
            normalized.surprise_score = Math.min(normalized.surprise_score, 2);
        }
        return normalized;
    }

    function buildMemoryEmbeddingText(memoryData) {
        const relationshipSummary = summarizeRelationships(memoryData.relationship_json ?? memoryData.relationships);
        return [
            memoryData.memory_type ? `Type: ${memoryData.memory_type}` : '',
            memoryData.memory_tier ? `Tier: ${memoryData.memory_tier}` : '',
            memoryData.memory_focus ? `Focus: ${memoryData.memory_focus}` : '',
            memoryData.summary ? `Summary: ${memoryData.summary}` : '',
            memoryData.content ? `Content: ${memoryData.content}` : '',
            memoryData.location ? `Location: ${memoryData.location}` : '',
            memoryData.time ? `Time: ${memoryData.time}` : '',
            memoryData.source_time_text ? `SourceTime: ${memoryData.source_time_text}` : '',
            memoryData.people ? `People: ${memoryData.people}` : '',
            memoryData.items ? `Items: ${memoryData.items}` : '',
            relationshipSummary.length ? `Relationships: ${relationshipSummary.join(', ')}` : '',
            memoryData.emotion ? `Emotion: ${memoryData.emotion}` : ''
        ].filter(Boolean).join('. ');
    }

    function formatMemoryForPrompt(memory) {
        const parts = [];
        const label = memory.summary || memory.event || memory.content;
        if (label) parts.push(label);
        if (memory.time) parts.push(`时间: ${memory.time}`);
        if (memory.source_time_text) parts.push(`来源对话时间: ${memory.source_time_text}`);
        if (memory.location) parts.push(`地点: ${memory.location}`);
        if (memory.people) parts.push(`人物: ${memory.people}`);
        if (memory.relationships) parts.push(`关系: ${memory.relationships}`);
        if (memory.emotion) parts.push(`情绪: ${memory.emotion}`);
        return `- ${parts.join(' | ')}`;
    }

    function resolveMemoryModelConfig(character) {
        return {
            endpoint: character.memory_api_endpoint || '',
            key: character.memory_api_key || '',
            model: character.memory_model_name || ''
        };
    }

    function recordMemoryDebug(character, direction, payload, meta = {}) {
        if (!character || character.llm_debug_capture !== 1) return;
        const db = getDb();
        if (typeof db.addLlmDebugLog !== 'function') return;
        try {
            const normalizedPayload = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
            db.addLlmDebugLog({
                character_id: character.id,
                direction,
                context_type: meta.context_type || 'memory',
                payload: normalizedPayload || '',
                meta,
                timestamp: Date.now()
            });
        } catch (e) {
            console.warn('[Memory] Failed to record debug log:', e.message);
        }
    }

    async function expandMemoryQueriesWithLLM(db, characterId, queryText, baseVariants = []) {
        try {
            const character = db.getCharacter ? db.getCharacter(characterId) : null;
            if (!character) return [];
            const memoryConfig = resolveMemoryModelConfig(character);
            if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model) return [];

            const prompt = [
                '你是记忆检索查询改写器。',
                '目标：把用户这句“想让角色回忆什么”的问题，改写成 3 到 6 个短检索词或短短语。',
                '要求：',
                '- 保留原主题，不要发散到无关方向。',
                '- 优先抽出实体、人名、公司名、地点名、事件名、别名、英文名、关键词。',
                '- 如果原句是中文，但核心实体常见英文形式更适合检索，可以同时给英文词。',
                '- 不要输出解释。',
                '- 每行只写一个检索词或短短语，不要编号，不要 JSON，不要多余说明。',
                `原问题: ${String(queryText || '').trim()}`,
                `已有基础检索词: ${JSON.stringify(baseVariants || [])}`
            ].join('\n');

            const { content } = await callLLM({
                endpoint: memoryConfig.endpoint,
                key: memoryConfig.key,
                model: memoryConfig.model,
                messages: [
                    { role: 'system', content: 'You rewrite memory recall questions into compact retrieval keywords. Output one retrieval phrase per line. No JSON. No numbering. No explanation.' },
                    { role: 'user', content: prompt }
                ],
                maxTokens: 80,
                temperature: 0,
                enableCache: true,
                cacheDb: db,
                cacheType: 'memory_query_expand',
                cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
                cacheScope: `character:${characterId}`,
                cacheCharacterId: characterId,
                cacheKeyExtra: 'v2',
                cacheKeyMode: 'exact'
            });

            const text = String(content || '').trim();
            return text
                .split(/\r?\n/)
                .map(line => String(line || '').replace(/^[-*•\d.\s]+/, '').trim())
                .filter(Boolean)
                .slice(0, 6);
        } catch (e) {
            console.warn('[Memory] Query expansion failed:', e.message);
            return [];
        }
    }

    function normalizeDigestList(value, maxItems = 6) {
        if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean).slice(0, maxItems);
        if (typeof value === 'string') return [value.trim()].filter(Boolean).slice(0, maxItems);
        return [];
    }

    function stripInlineTags(text) {
        return String(text || '')
            .replace(/\[[A-Z_]+:[^\]]*?\]/g, '')
            .replace(/\[[A-Z_]+\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function compactDigestText(text, maxLength = 90) {
        const cleaned = stripInlineTags(text).replace(/[“”"]/g, '').trim();
        if (!cleaned) return '';
        if (cleaned.length <= maxLength) return cleaned;
        return `${cleaned.slice(0, Math.max(12, maxLength - 1)).trim()}…`;
    }

    function stripCompressedOpener(text = '') {
        return String(text || '')
            .replace(/^[\s.…·—\-~～]+/, '')
            .trim();
    }

    function normalizeConversationDigestPayload(raw = {}) {
        const digestText = compactDigestText(raw.digest_text || raw.summary || '', 220);
        const emotionState = compactDigestText(raw.emotion_state || '', 48);
        return {
            digest_text: digestText,
            emotion_state: emotionState,
            relationship_state_json: normalizeDigestList(raw.relationship_state_json ?? raw.relationship_state, 4).map(v => compactDigestText(v, 64)),
            open_loops_json: normalizeDigestList(raw.open_loops_json ?? raw.open_loops, 4).map(v => compactDigestText(v, 64)),
            recent_facts_json: normalizeDigestList(raw.recent_facts_json ?? raw.recent_facts, 4).map(v => compactDigestText(v, 72)),
            scene_state_json: normalizeDigestList(raw.scene_state_json ?? raw.scene_state, 3).map(v => compactDigestText(v, 56))
        };
    }

    function formatConversationDigestForPrompt(digest, options = {}) {
        if (!digest || !digest.digest_text) return '';
        const recentMessages = Array.isArray(options.recentMessages) ? options.recentMessages : [];
        const recentSnippets = recentMessages
            .map(m => compactDigestText(m?.content || '', 56).toLowerCase())
            .filter(Boolean);
        const overlapsRecent = (text) => {
            const compacted = compactDigestText(text || '', 56).toLowerCase();
            if (!compacted) return false;
            return recentSnippets.some(snippet => snippet && (compacted.includes(snippet) || snippet.includes(compacted)));
        };
        const blocks = [];
        blocks.push('[Private Conversation Digest]');
        blocks.push('Use this only as compressed background from before the latest raw tail messages. It may be incomplete or slightly stale.');
        blocks.push('If this digest conflicts with the newest raw tail messages or the user\'s latest wording, trust the raw tail messages.');
        if (!overlapsRecent(digest.digest_text)) {
            blocks.push(`Background summary (before latest tail): ${stripCompressedOpener(digest.digest_text)}`);
        }
        if (digest.emotion_state) blocks.push(`Current hidden tone: ${digest.emotion_state}`);
        if (Array.isArray(digest.relationship_state_json) && digest.relationship_state_json.length > 0) {
            blocks.push(`Relationship state:\n- ${digest.relationship_state_json.join('\n- ')}`);
        }
        if (Array.isArray(digest.open_loops_json) && digest.open_loops_json.length > 0) {
            blocks.push(`Open loops:\n- ${digest.open_loops_json.join('\n- ')}`);
        }
        const dedupedFacts = Array.isArray(digest.recent_facts_json)
            ? digest.recent_facts_json.filter(item => !overlapsRecent(item))
            : [];
        if (dedupedFacts.length > 0) {
            blocks.push(`Older relevant facts:\n- ${dedupedFacts.map(item => stripCompressedOpener(item)).join('\n- ')}`);
        }
        if (Array.isArray(digest.scene_state_json) && digest.scene_state_json.length > 0) {
            blocks.push(`Scene state:\n- ${digest.scene_state_json.join('\n- ')}`);
        }
        return blocks.join('\n');
    }

    function formatGroupConversationDigestForPrompt(digest, options = {}) {
        if (!digest || !digest.digest_text) return '';
        const recentMessages = Array.isArray(options.recentMessages) ? options.recentMessages : [];
        const recentSnippets = recentMessages
            .map(m => compactDigestText(m?.content || '', 44).toLowerCase())
            .filter(Boolean);
        const overlapsRecent = (text) => {
            const compacted = compactDigestText(text || '', 44).toLowerCase();
            if (!compacted) return false;
            return recentSnippets.some(snippet => snippet && (compacted.includes(snippet) || snippet.includes(compacted)));
        };

        const blocks = [];
        const digestSummary = overlapsRecent(digest.digest_text) ? '' : stripCompressedOpener(digest.digest_text);
        if (digestSummary) {
            blocks.push(`[Group Conversation Digest]\nSummary: ${digestSummary}`);
        } else {
            blocks.push('[Group Conversation Digest]');
        }
        if (digest.emotion_state) blocks.push(`Current group stance: ${digest.emotion_state}`);
        if (Array.isArray(digest.relationship_state_json) && digest.relationship_state_json.length > 0) {
            blocks.push(`Social state:\n- ${digest.relationship_state_json.join('\n- ')}`);
        }
        if (Array.isArray(digest.open_loops_json) && digest.open_loops_json.length > 0) {
            blocks.push(`Open loops:\n- ${digest.open_loops_json.join('\n- ')}`);
        }
        const dedupedFacts = Array.isArray(digest.recent_facts_json)
            ? digest.recent_facts_json.filter(item => !overlapsRecent(item))
            : [];
        if (dedupedFacts.length > 0) {
            blocks.push(`Recent group facts:\n- ${dedupedFacts.map(item => stripCompressedOpener(item)).join('\n- ')}`);
        }
        if (Array.isArray(digest.scene_state_json) && digest.scene_state_json.length > 0) {
            blocks.push(`Scene state:\n- ${digest.scene_state_json.join('\n- ')}`);
        }
        return blocks.join('\n');
    }

    function normalizeCompactGroupDigestPayload(raw = {}) {
        const digestText = compactDigestText(raw.digest_text || raw.summary || '', 140);
        const emotionState = compactDigestText(raw.emotion_state || '', 28);
        return {
            digest_text: digestText,
            emotion_state: emotionState,
            relationship_state_json: normalizeDigestList(raw.relationship_state_json ?? raw.relationship_state, 3).map(v => compactDigestText(v, 36)),
            open_loops_json: normalizeDigestList(raw.open_loops_json ?? raw.open_loops, 3).map(v => compactDigestText(v, 42)),
            recent_facts_json: normalizeDigestList(raw.recent_facts_json ?? raw.recent_facts, 3).map(v => compactDigestText(v, 44)),
            scene_state_json: normalizeDigestList(raw.scene_state_json ?? raw.scene_state, 2).map(v => compactDigestText(v, 28))
        };
    }

    function looksLikeMeaningRepairUserText(text = '') {
        const value = String(text || '').trim();
        if (!value) return false;
        return /(我的意思是|我是在|不是这个意思|你理解错了|你误会了|我没有想过|我一直是在和你调情|不是在为难你|你却一直误解|你为什么这么笨)/i.test(value);
    }

    function looksLikeAssistantInterpretation(text = '') {
        const value = String(text || '').trim();
        if (!value) return false;
        return /(你是说|所以你是在说|那现在呢|如果不是调情|是你在逗我玩|我理解错了|我真的分不清|其实你只是在|误读成了调情|不是调情，是我自作多情)/i.test(value);
    }

    function buildFallbackConversationDigest(character, existingDigest, deltaMessages, latestMessageId) {
        const recentTail = (Array.isArray(deltaMessages) ? deltaMessages : []).slice(-4);
        const latestUser = [...recentTail].reverse().find(m => m.role === 'user');
        const latestAssistant = [...recentTail].reverse().find(m => m.role === 'character');
        const latestUserText = stripCompressedOpener(compactDigestText(latestUser?.content || '', 64));
        const latestAssistantText = stripCompressedOpener(compactDigestText(latestAssistant?.content || '', 72));
        const digestSummaryParts = [];
        if (latestUserText) digestSummaryParts.push(`Recent user message: ${latestUserText}`);
        if (latestAssistantText) digestSummaryParts.push(`Recent reply from ${character.name}: ${latestAssistantText}`);
        const previousOpenLoops = normalizeDigestList(existingDigest?.open_loops_json || [], 4);
        const mergedOpenLoops = latestUser && /[？?]/.test(String(latestUser.content || ''))
            ? normalizeDigestList([latestUserText, ...previousOpenLoops], 4)
            : previousOpenLoops;
        const relationshipState = normalizeDigestList(existingDigest?.relationship_state_json || [], 4);
        const strippedAssistant = stripInlineTags(latestAssistant?.content || '');
        if (/别的AI|别人|只.*我|独占|吃醋|酸/i.test(strippedAssistant) && !relationshipState.includes('Still wants exclusive attention')) {
            relationshipState.unshift('Still wants exclusive attention');
        }
        if (/哄|安慰|安心|陪/i.test(strippedAssistant) && !relationshipState.includes('Needs reassurance to settle down')) {
            relationshipState.unshift('Needs reassurance to settle down');
        }
        const sceneState = normalizeDigestList(existingDigest?.scene_state_json || [], 3);
        if ((character.city_status || '').includes('rest') || /睡|被窝|困|休息/i.test(strippedAssistant)) {
            if (!sceneState.includes('Resting / half-awake')) sceneState.unshift('Resting / half-awake');
        }
        if ((character.satiety || 0) < 35 || /饿|肚子/i.test(strippedAssistant)) {
            if (!sceneState.includes('Hungry or physically empty')) sceneState.unshift('Hungry or physically empty');
        }
        return {
            character_id: character.id,
            digest_text: compactDigestText(digestSummaryParts.join(' | ') || existingDigest?.digest_text || '', 220),
            emotion_state: compactDigestText(character.hidden_state || existingDigest?.emotion_state || '', 48),
            relationship_state_json: relationshipState.slice(0, 4),
            open_loops_json: mergedOpenLoops,
            recent_facts_json: normalizeDigestList(recentTail.map((m) => {
                const speaker = m.role === 'user' ? 'User' : character.name;
                return `${speaker}: ${stripCompressedOpener(compactDigestText(m.content, 56))}`;
            }), 3),
            scene_state_json: sceneState.slice(0, 3),
            last_message_id: latestMessageId
        };
    }

    function buildFallbackGroupConversationDigest(character, group, existingDigest, deltaMessages, latestMessageId) {
        const db = getDb();
        const recentTail = (Array.isArray(deltaMessages) ? deltaMessages : []).slice(-6);
        const compactedFacts = normalizeDigestList(recentTail.map((m) => {
            const senderName = m.sender_id === 'user'
                ? (db.getUserProfile?.()?.name || 'User')
                : (db.getCharacter?.(m.sender_id)?.name || m.sender_name || m.sender_id || 'Unknown');
            return `${senderName}: ${stripCompressedOpener(compactDigestText(m.content, 48))}`;
        }), 5);
        const latestUser = [...recentTail].reverse().find(m => m.sender_id === 'user');
        const latestMention = [...recentTail].reverse().find(m => {
            const senderName = db.getCharacter?.(m.sender_id)?.name || m.sender_name || '';
            return typeof m.content === 'string' && (m.content.includes(`@${character.name}`) || (senderName && m.content.includes(senderName)));
        });
        const relationshipState = normalizeDigestList(existingDigest?.relationship_state_json || [], 5);
        if (latestMention && !relationshipState.includes('Recently pulled into the spotlight')) {
            relationshipState.unshift('Recently pulled into the spotlight');
        }
        if (latestUser && /今天|去哪|做了什么|怎么样|最近/i.test(String(latestUser.content || '')) && !relationshipState.includes('User is asking about current state')) {
            relationshipState.unshift('User is asking about current state');
        }
        const openLoops = normalizeDigestList(existingDigest?.open_loops_json || [], 5);
        if (latestUser && /[？?]/.test(String(latestUser.content || ''))) {
            openLoops.unshift(compactDigestText(latestUser.content, 52));
        }
        const sceneState = normalizeDigestList(existingDigest?.scene_state_json || [], 4);
        if (group?.name && !sceneState.includes(`In group ${group.name}`)) {
            sceneState.unshift(`In group ${group.name}`);
        }
        return {
            group_id: group?.id || '',
            character_id: character.id,
            digest_text: compactDigestText(compactedFacts.slice(0, 2).join(' | ') || existingDigest?.digest_text || '', 140),
            emotion_state: compactDigestText(character.hidden_state || existingDigest?.emotion_state || '', 28),
            relationship_state_json: relationshipState.slice(0, 3).map(v => compactDigestText(v, 36)),
            open_loops_json: openLoops.slice(0, 3).map(v => compactDigestText(v, 42)),
            recent_facts_json: compactedFacts.slice(0, 3).map(v => compactDigestText(v, 44)),
            scene_state_json: sceneState.slice(0, 2).map(v => compactDigestText(v, 28)),
            last_message_id: latestMessageId
        };
    }

    function updateSweepStatus(characterId, patch = {}) {
        const db = getDb();
        if (!characterId || typeof db.rawRun !== 'function') return;
        const fields = [];
        const values = [];
        if (Object.prototype.hasOwnProperty.call(patch, 'sweep_last_error')) {
            fields.push('sweep_last_error = ?');
            values.push(patch.sweep_last_error || '');
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'sweep_last_run_at')) {
            fields.push('sweep_last_run_at = ?');
            values.push(patch.sweep_last_run_at || 0);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'sweep_last_success_at')) {
            fields.push('sweep_last_success_at = ?');
            values.push(patch.sweep_last_success_at || 0);
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'sweep_last_saved_count')) {
            fields.push('sweep_last_saved_count = ?');
            values.push(patch.sweep_last_saved_count || 0);
        }
        if (fields.length === 0) return;
        values.push(characterId);
        db.rawRun(`UPDATE characters SET ${fields.join(', ')} WHERE id = ?`, values);
    }

    function recordMemoryTokenUsage(characterId, contextType, usage) {
        const db = getDb();
        if (!usage || usage.cached || !characterId || !db?.addTokenUsage) return;
        db.addTokenUsage(characterId, contextType, usage.prompt_tokens || 0, usage.completion_tokens || 0);
    }

    async function wipeIndex(characterId) {
        const key = `${userId}_${characterId}`;
        indices.delete(key);
        if (await canUseQdrant()) {
            try {
                await qdrant.deleteCharacterPoints(userId, characterId);
            } catch (e) {
                console.error(`[Memory] Failed to wipe Qdrant points for ${characterId}:`, e.message);
            }
        }
        const dir = path.join(__dirname, '..', 'data', 'vectors', String(userId), String(characterId));
        if (fs.existsSync(dir)) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch (e) {
                console.error(`[Memory] Failed to physically wipe vector dir for ${characterId}:`, e.message);
            }
        }
    }

    async function rebuildIndex(characterId) {
        await wipeIndex(characterId);
        const db = getDb();
        const rows = db.getMemories ? db.getMemories(characterId) : [];
        if (!rows || rows.length === 0) return;

        const index = await getVectorIndex(userId, characterId);
        for (const mem of rows) {
            const textToEmbed = buildMemoryEmbeddingText(mem);
            const embeddingArray = await getEmbedding(textToEmbed);
            const retrievalWeight = computeMemoryRetrievalWeight(mem);
            if (await canUseQdrant()) {
                try {
                    await qdrant.upsertMemoryPoint(userId, {
                        id: String(mem.id),
                        vector: embeddingArray,
                        payload: {
                            memory_id: mem.id,
                            character_id: String(characterId),
                            group_id: mem.group_id || '',
                            memory_type: mem.memory_type || 'event',
                            memory_tier: mem.memory_tier || 'ambient',
                            memory_focus: mem.memory_focus || 'general',
                            importance: mem.importance || 5,
                            created_at: mem.created_at || Date.now(),
                            time: mem.time || '',
                            is_archived: Number(mem.is_archived || 0),
                            dedupe_key: mem.dedupe_key || '',
                            retrieval_weight: retrievalWeight,
                            summary: mem.summary || mem.event || '',
                            content: mem.content || mem.event || '',
                            location: mem.location || '',
                            source_started_at: Number(mem.source_started_at || 0),
                            source_ended_at: Number(mem.source_ended_at || 0),
                            source_time_text: mem.source_time_text || '',
                            source_message_count: Number(mem.source_message_count || 0)
                        }
                    });
                } catch (e) {
                    console.error(`[Memory] Qdrant rebuild upsert failed for ${characterId}/${mem.id}:`, e.message);
                    qdrantAvailability = false;
                }
            }
            await index.insertItem({
                id: String(mem.id),
                vector: embeddingArray,
                metadata: {
                    memory_id: mem.id,
                    surprise_score: mem.surprise_score || mem.importance || 5,
                    memory_type: mem.memory_type || 'event',
                    memory_tier: mem.memory_tier || 'ambient',
                    memory_focus: mem.memory_focus || 'general',
                    dedupe_key: mem.dedupe_key || '',
                    retrieval_weight: retrievalWeight
                }
            });
        }
    }

    const MEMORY_QUERY_EXPANSIONS = [
        { pattern: /\bopen\s*ai\b|openai/i, variants: ['openai', 'sam altman', 'anthropic openai', 'openai anthropic'] },
        { pattern: /\banthropic\b/i, variants: ['anthropic', 'claude', 'openai anthropic', 'sam altman anthropic'] },
        { pattern: /\bsam\s*altman\b/i, variants: ['sam altman', 'openai', 'anthropic', 'openai ceo'] },
        { pattern: /找工作|工作|求职|面试|简历|offer|求职/i, variants: ['找工作', '工作细节', '面试', '求职'] }
    ];

    function normalizeSearchText(text = '') {
        return String(text || '')
            .toLowerCase()
            .replace(/open\s+ai/g, 'openai')
            .replace(/sam\s+altman/g, 'samaltman')
            .replace(/[\s_\-"'`.,!?，。！？：:；;（）()【】\[\]]+/g, '');
    }

    function buildMemorySearchQueries(queryText = '') {
        const raw = String(queryText || '').trim();
        if (!raw) return [];

        const variants = new Set([raw]);
        const stripped = raw
            .replace(/你还?记得|你记得|我说了什么|我提过什么|关于|还有|那关于|之前|以前|上次|当时|到底|吗|呢|呀|啊/g, ' ')
            .replace(/[？?！!]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (stripped && stripped !== raw) variants.add(stripped);

        for (const rule of MEMORY_QUERY_EXPANSIONS) {
            if (rule.pattern.test(raw)) {
                rule.variants.forEach(v => variants.add(v));
            }
        }

        const normalizedSeen = new Set();
        return Array.from(variants)
            .map(v => String(v || '').trim())
            .filter(Boolean)
            .filter(v => {
                const normalized = normalizeSearchText(v);
                if (!normalized || normalizedSeen.has(normalized)) return false;
                normalizedSeen.add(normalized);
                return true;
            })
            .slice(0, 5);
    }

    const GENERIC_MEMORY_SEARCH_STOP_PHRASES = [
        '你还记得', '你记得', '还记得', '记得', '回忆', '想起', '再想想',
        '我说了什么', '我提过什么', '关于', '那关于', '还有', '之前', '以前', '上次', '当时',
        '到底', '吗', '呢', '呀', '啊', '这个', '那个', '这件事', '那件事', '相关', '事情',
        '内容', '细节', '方面', '情况'
    ];

    function stripGenericMemoryQuery(text = '') {
        let cleaned = String(text || '').trim();
        for (const phrase of GENERIC_MEMORY_SEARCH_STOP_PHRASES) {
            cleaned = cleaned.split(phrase).join(' ');
        }
        return cleaned
            .replace(/[？?！!，,。.:：;；"'“”‘’（）()【】\[\]、]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    const BILINGUAL_MEMORY_ALIASES = [
        ['找工作', '求职', '工作', 'job', 'work', 'employment', 'career'],
        ['面试', 'interview'],
        ['简历', 'resume', 'cv'],
        ['offer', '录用', '录取'],
        ['薪资', '工资', 'salary', 'pay', 'compensation'],
        ['公司', '企业', 'startup', 'company'],
        ['openai', 'open ai'],
        ['anthropic'],
        ['sam altman', 'altman'],
        ['dario amodei', 'amodei'],
        ['ceo'],
        ['商业街', 'city', '街区'],
        ['工厂', 'factory'],
        ['餐厅', 'restaurant'],
        ['便利店', 'convenience store', 'store'],
        ['公园', 'park'],
        ['群聊', 'group chat', 'group'],
        ['朋友圈', 'moment', 'moments'],
        ['日记', 'diary'],
        ['密码', 'password'],
        ['红包', '转账', 'red packet', 'transfer'],
        ['住院', '医院', 'hospital'],
        ['受伤', 'injury', 'injured'],
        ['嫉妒', 'jealous', 'jealousy']
    ];

    function expandBilingualAliases(text = '') {
        const normalized = normalizeSearchText(text);
        if (!normalized) return [];
        const variants = new Set();
        for (const group of BILINGUAL_MEMORY_ALIASES) {
            const normalizedGroup = group.map(alias => ({
                raw: alias,
                normalized: normalizeSearchText(alias)
            }));
            if (normalizedGroup.some(alias => alias.normalized && normalized.includes(alias.normalized))) {
                normalizedGroup.forEach(alias => variants.add(alias.raw));
            }
        }
        return Array.from(variants).filter(Boolean);
    }

    function expandGenericChineseAnchor(anchor = '') {
        const value = String(anchor || '').trim();
        if (!value) return [];
        const variants = new Set([value]);
        const trimmed = value
            .replace(/(这件事|那件事|事情|情况|内容|相关|方面|一下|一下子|的问题)$/g, '')
            .replace(/^(关于|有关|那个|这个)/g, '')
            .trim();
        if (trimmed && trimmed !== value) variants.add(trimmed);
        if (trimmed.length >= 4 && trimmed.length <= 10) {
            variants.add(trimmed.slice(0, trimmed.length - 1));
        }
        return Array.from(variants).filter(Boolean);
    }

    function buildExpandedMemorySearchQueries(queryText = '') {
        const raw = String(queryText || '').trim();
        if (!raw) return [];

        const variants = new Set(buildMemorySearchQueries(raw));
        const stripped = stripGenericMemoryQuery(raw);
        if (stripped) variants.add(stripped);
        expandBilingualAliases(raw).forEach(v => variants.add(v));
        expandBilingualAliases(stripped).forEach(v => variants.add(v));

        const englishTokens = stripped.match(/[a-zA-Z][a-zA-Z0-9+_.-]{2,}/g) || [];
        for (const token of englishTokens) variants.add(token);

        const chineseChunks = stripped.match(/[\u4e00-\u9fff]{2,12}/g) || [];
        const genericAnchors = [];
        for (const chunk of chineseChunks) {
            for (const variant of expandGenericChineseAnchor(chunk)) {
                genericAnchors.push(variant);
                variants.add(variant);
                expandBilingualAliases(variant).forEach(v => variants.add(v));
            }
        }

        if (genericAnchors.length >= 2) {
            variants.add(`${genericAnchors[0]} ${genericAnchors[1]}`);
        }

        const normalizedSeen = new Set();
        return Array.from(variants)
            .map(v => String(v || '').trim())
            .filter(Boolean)
            .filter(v => {
                const normalized = normalizeSearchText(v);
                if (!normalized || normalizedSeen.has(normalized)) return false;
                normalizedSeen.add(normalized);
                return true;
            })
            .slice(0, 8);
    }

    function computeLexicalBoost(memoryRow, queryVariants = []) {
        const haystack = normalizeSearchText([
            memoryRow?.summary,
            memoryRow?.content,
            memoryRow?.event,
            memoryRow?.people,
            memoryRow?.relationships,
            memoryRow?.location
        ].filter(Boolean).join(' '));
        if (!haystack) return 0;

        let boost = 0;
        for (const variant of queryVariants) {
            const needle = normalizeSearchText(variant);
            if (!needle || needle.length < 2) continue;
            if (haystack.includes(needle)) {
                boost += needle.length >= 6 ? 0.16 : 0.08;
            }
        }
        return Math.min(boost, 0.32);
    }

    function computeAliasBridgeBoost(memoryRow, queryVariants = []) {
        const haystack = normalizeSearchText([
            memoryRow?.summary,
            memoryRow?.content,
            memoryRow?.event,
            memoryRow?.people,
            memoryRow?.relationships,
            memoryRow?.location
        ].filter(Boolean).join(' '));
        if (!haystack) return 0;

        const normalizedQueries = queryVariants.map(v => normalizeSearchText(v)).filter(Boolean);
        let boost = 0;
        for (const group of BILINGUAL_MEMORY_ALIASES) {
            const normalizedGroup = group.map(alias => normalizeSearchText(alias)).filter(Boolean);
            const queryHit = normalizedQueries.some(q => normalizedGroup.some(alias => q.includes(alias)));
            const memoryHit = normalizedGroup.some(alias => haystack.includes(alias));
            if (queryHit && memoryHit) boost += 0.12;
        }
        return Math.min(boost, 0.36);
    }

    function computeRecallContradictionPenalty(memoryRow, queryText = '') {
        const query = String(queryText || '');
        if (!/记得|说了什么|提过什么|回忆|想起/i.test(query)) return 0;
        const text = [
            memoryRow?.summary,
            memoryRow?.content,
            memoryRow?.event
        ].filter(Boolean).join(' ');
        if (!text) return 0;
        if (/(不记得|想不起来|记不清|lack of recall|can't remember|空白)/i.test(text)) {
            return 0.22;
        }
        return 0;
    }

    function runLexicalMemoryFallback(db, characterId, queryVariants = [], limit = 5) {
        try {
            if (!db?.getRawDb) return [];
            const rawDb = db.getRawDb();
            if (!rawDb) return [];

            const normalizedVariants = queryVariants
                .map(v => String(v || '').trim())
                .filter(Boolean);
            if (normalizedVariants.length === 0) return [];

            const rows = db.getMemories(characterId)
                .filter(row => Number(row.is_archived || 0) === 0);

            const scored = rows.map(row => {
                let lexicalBoost = computeLexicalBoost(row, normalizedVariants);
                const aliasBridgeBoost = computeAliasBridgeBoost(row, normalizedVariants);
                let matchedQuery = '';
                for (const variant of normalizedVariants) {
                    const needle = normalizeSearchText(variant);
                    if (!needle) continue;
                    const haystack = normalizeSearchText([
                        row.summary,
                        row.content,
                        row.event,
                        row.people,
                        row.relationships,
                        row.location
                    ].filter(Boolean).join(' '));
                    if (haystack.includes(needle)) {
                        matchedQuery = variant;
                        break;
                    }
                }
                if (!matchedQuery && lexicalBoost <= 0) return null;

                const importance = Number(row.importance || 5);
                const retrievalWeight = Number(row.retrieval_weight || computeMemoryRetrievalWeight(row) || 1);
                const tierBoost = computeMemoryTierBoost(row);
                const profilePriorityBoost = computeUserProfilePriorityBoost(row, normalizedVariants[0] || '', normalizedVariants);
                const finalScore = lexicalBoost + aliasBridgeBoost + tierBoost + profilePriorityBoost + (importance * 0.025) + ((retrievalWeight - 1) * 0.1);
                return {
                    row,
                    finalScore,
                    matchedQuery: matchedQuery || 'lexical_fallback'
                };
            }).filter(Boolean);

            return scored
                .sort((a, b) => b.finalScore - a.finalScore)
                .slice(0, limit)
                .map(entry => {
                    entry.row._search_score = entry.finalScore.toFixed(3);
                    entry.row._matched_query = entry.matchedQuery;
                    return entry.row;
                });
        } catch (e) {
            console.error(`[Memory] Lexical fallback failed for ${characterId}:`, e.message);
            return [];
        }
    }

    async function runSemanticMemoryFallback(db, characterId, queryText, limit = 5) {
        try {
            const rows = db.getMemories(characterId)
                .filter(row => Number(row.is_archived || 0) === 0)
                .slice(0, 120);
            if (rows.length === 0) return [];

            const queryEmbedding = await getEmbedding(queryText);
            const scored = [];
            for (let idx = 0; idx < rows.length; idx++) {
                if (idx > 0 && idx % 10 === 0) {
                    await yieldToEventLoop();
                }
                const row = rows[idx];
                const text = [
                    row.summary,
                    row.content,
                    row.event,
                    row.people,
                    row.relationships,
                    row.location
                ].filter(Boolean).join(' ');
                if (!text) continue;
                const rowEmbedding = await getEmbedding(text.slice(0, 1200));
                const similarity = queryEmbedding.reduce((sum, value, idx) => sum + (value * (rowEmbedding[idx] || 0)), 0);
                if (similarity < 0.20) continue;
                const importance = Number(row.importance || 5);
                const retrievalWeight = Number(row.retrieval_weight || computeMemoryRetrievalWeight(row) || 1);
                const contradictionPenalty = computeRecallContradictionPenalty(row, queryText);
                const tierBoost = computeMemoryTierBoost(row);
                const profilePriorityBoost = computeUserProfilePriorityBoost(row, queryText, [queryText]);
                const finalScore = similarity + tierBoost + profilePriorityBoost + (importance * 0.02) + ((retrievalWeight - 1) * 0.08) - contradictionPenalty;
                scored.push({ row, finalScore });
            }

            return scored
                .sort((a, b) => b.finalScore - a.finalScore)
                .slice(0, limit)
                .map(entry => {
                    entry.row._search_score = entry.finalScore.toFixed(3);
                    entry.row._matched_query = 'semantic_fallback';
                    return entry.row;
                });
        } catch (e) {
            console.error(`[Memory] Semantic fallback failed for ${characterId}:`, e.message);
            return [];
        }
    }

    function normalizeMemorySearchRequest(queryInput, limit = 5) {
        const requestedLimit = Math.max(1, Math.min(12, Number(limit || 5) || 5));
        if (queryInput && typeof queryInput === 'object' && !Array.isArray(queryInput)) {
            const explicitQueries = Array.isArray(queryInput.queries)
                ? queryInput.queries.map(item => String(item || '').trim()).filter(Boolean).slice(0, 12)
                : [];
            const primaryText = String(queryInput.queryText || explicitQueries[0] || '').trim();
            const filters = queryInput.filters && typeof queryInput.filters === 'object'
                ? queryInput.filters
                : {};
            return {
                primaryText,
                explicitQueries,
                filters: {
                    memory_focus: Array.isArray(filters.memory_focus)
                        ? filters.memory_focus.map(item => String(item || '').trim()).filter(Boolean).slice(0, 4)
                        : [],
                    memory_tier: Array.isArray(filters.memory_tier)
                        ? filters.memory_tier.map(item => String(item || '').trim()).filter(Boolean).slice(0, 3)
                        : []
                },
                limit: Math.max(1, Math.min(12, Number(queryInput.limit || requestedLimit) || requestedLimit))
            };
        }
        const primaryText = String(queryInput || '').trim();
        return {
            primaryText,
            explicitQueries: [],
            filters: { memory_focus: [], memory_tier: [] },
            limit: requestedLimit
        };
    }

    function buildMemorySearchFilter(characterId, filters = {}) {
        const must = [
            { key: 'character_id', match: { value: String(characterId) } },
            { key: 'is_archived', match: { value: 0 } }
        ];
        const focusList = Array.isArray(filters.memory_focus) ? filters.memory_focus.filter(Boolean) : [];
        const tierList = Array.isArray(filters.memory_tier) ? filters.memory_tier.filter(Boolean) : [];
        if (focusList.length === 1) {
            must.push({ key: 'memory_focus', match: { value: String(focusList[0]) } });
        }
        if (tierList.length === 1) {
            must.push({ key: 'memory_tier', match: { value: String(tierList[0]) } });
        }
        return { must };
    }

    function memoryMatchesSearchFilters(memoryRow, filters = {}) {
        if (!memoryRow) return false;
        const focusList = Array.isArray(filters.memory_focus) ? filters.memory_focus.filter(Boolean) : [];
        const tierList = Array.isArray(filters.memory_tier) ? filters.memory_tier.filter(Boolean) : [];
        if (focusList.length > 0 && !focusList.includes(String(memoryRow.memory_focus || '').trim())) {
            return false;
        }
        if (tierList.length > 0 && !tierList.includes(String(memoryRow.memory_tier || '').trim())) {
            return false;
        }
        return Number(memoryRow.is_archived || 0) === 0;
    }

    async function searchMemories(characterId, queryText, limit = 5) {
        try {
            const db = getDb();
            const normalizedRequest = normalizeMemorySearchRequest(queryText, limit);
            const baseQuery = normalizedRequest.primaryText || normalizedRequest.explicitQueries[0] || '';
            let queryVariants = normalizedRequest.explicitQueries.length > 0
                ? Array.from(new Set([
                    ...normalizedRequest.explicitQueries,
                    ...buildExpandedMemorySearchQueries(baseQuery)
                ])).slice(0, 6)
                : buildExpandedMemorySearchQueries(baseQuery);
            const llmExpandedVariants = await expandMemoryQueriesWithLLM(db, characterId, baseQuery, queryVariants);
            if (llmExpandedVariants.length > 0) {
                const merged = new Set(queryVariants);
                llmExpandedVariants.forEach(v => merged.add(v));
                queryVariants = Array.from(merged).slice(0, 6);
            }
            if (queryVariants.length === 0) return [];
            const searchFilter = buildMemorySearchFilter(characterId, normalizedRequest.filters);
            const resultLimit = normalizedRequest.limit;

            if (await canUseQdrant()) {
                try {
                    const aggregate = new Map();
                    for (let i = 0; i < queryVariants.length; i++) {
                        const variant = queryVariants[i];
                        const queryEmbedding = await getEmbedding(variant);
                        const qdrantResults = await qdrant.searchMemoryPoints(
                            userId,
                            queryEmbedding,
                            searchFilter,
                            Math.max(resultLimit * 3, 8)
                        );

                        for (const res of qdrantResults) {
                            const memoryId = res?.payload?.memory_id || res?.id;
                            if (!memoryId || res.score <= 0.3) continue;
                            const memRow = db.getMemory(memoryId);
                            if (!memoryMatchesSearchFilters(memRow, normalizedRequest.filters)) continue;
                            const surpriseScore = res?.payload?.importance || memRow.importance || 5;
                            const retrievalWeight = Math.max(
                                Number(res?.payload?.retrieval_weight || 1),
                                Number(computeMemoryRetrievalWeight(memRow) || 1)
                            );
                            const lexicalBoost = computeLexicalBoost(memRow, queryVariants);
                            const aliasBridgeBoost = computeAliasBridgeBoost(memRow, queryVariants);
                            const queryWeight = i === 0 ? 1 : (i === 1 ? 0.96 : 0.9);
                            const contradictionPenalty = computeRecallContradictionPenalty(memRow, baseQuery);
                            const tierBoost = computeMemoryTierBoost(memRow);
                            const profilePriorityBoost = computeUserProfilePriorityBoost(memRow, baseQuery, queryVariants);
                            const finalScore = (res.score * retrievalWeight * (1 + surpriseScore * 0.05) * queryWeight) + lexicalBoost + aliasBridgeBoost + tierBoost + profilePriorityBoost - contradictionPenalty;
                            const existing = aggregate.get(memoryId);
                            if (!existing || finalScore > existing.finalScore) {
                                aggregate.set(memoryId, { memRow, finalScore, rawScore: res.score, matchedQuery: variant });
                            }
                        }
                    }

                    const memories = Array.from(aggregate.values())
                        .sort((a, b) => b.finalScore - a.finalScore)
                        .slice(0, resultLimit)
                        .map(entry => {
                            entry.memRow._search_score = entry.finalScore.toFixed(3);
                            entry.memRow._matched_query = entry.matchedQuery;
                            return entry.memRow;
                        });
                    if (memories.length > 0 && db.markMemoriesRetrieved) {
                        db.markMemoriesRetrieved(memories.map(m => m.id));
                    }
                    if (memories.length > 0) {
                        return memories;
                    }
                } catch (e) {
                    console.error(`[Memory] Qdrant search failed for ${characterId}:`, e.message);
                    if (!isRecoverableQdrantError(e)) {
                        qdrantAvailability = false;
                    }
                }
            }

            const index = await getVectorIndex(userId, characterId);
            const aggregate = new Map();
            for (let i = 0; i < queryVariants.length; i++) {
                const variant = queryVariants[i];
                const queryEmbedding = await getEmbedding(variant);
                const results = await index.queryItems(queryEmbedding, Math.max(resultLimit * 3, 8));

                for (const res of results) {
                    if (!(res.score > 0.3 && res.item.metadata && res.item.metadata.memory_id)) continue;
                    const memRow = db.getMemory(res.item.metadata.memory_id);
                    if (!memoryMatchesSearchFilters(memRow, normalizedRequest.filters)) continue;
                    const surpriseScore = (res.item.metadata && res.item.metadata.surprise_score) ? res.item.metadata.surprise_score : 5;
                    const retrievalWeight = Math.max(
                        (res.item.metadata && Number(res.item.metadata.retrieval_weight)) || 1,
                        Number(computeMemoryRetrievalWeight(memRow) || 1)
                    );
                    const lexicalBoost = computeLexicalBoost(memRow, queryVariants);
                    const aliasBridgeBoost = computeAliasBridgeBoost(memRow, queryVariants);
                    const queryWeight = i === 0 ? 1 : (i === 1 ? 0.96 : 0.9);
                    const contradictionPenalty = computeRecallContradictionPenalty(memRow, baseQuery);
                    const tierBoost = computeMemoryTierBoost(memRow);
                    const profilePriorityBoost = computeUserProfilePriorityBoost(memRow, baseQuery, queryVariants);
                    const finalScore = (res.score * retrievalWeight * (1 + surpriseScore * 0.05) * queryWeight) + lexicalBoost + aliasBridgeBoost + tierBoost + profilePriorityBoost - contradictionPenalty;
                    const existing = aggregate.get(memRow.id);
                    if (!existing || finalScore > existing.finalScore) {
                        aggregate.set(memRow.id, { memRow, finalScore, matchedQuery: variant });
                    }
                }
            }
            const memories = Array.from(aggregate.values())
                .sort((a, b) => b.finalScore - a.finalScore)
                .slice(0, resultLimit)
                .map(entry => {
                    entry.memRow._search_score = entry.finalScore.toFixed(3);
                    entry.memRow._matched_query = entry.matchedQuery;
                    return entry.memRow;
                });
            if (memories.length > 0 && db.markMemoriesRetrieved) {
                db.markMemoriesRetrieved(memories.map(m => m.id));
            }
            if (memories.length > 0) return memories;

            const lexicalFallback = runLexicalMemoryFallback(db, characterId, queryVariants, resultLimit)
                .filter(memRow => memoryMatchesSearchFilters(memRow, normalizedRequest.filters));
            if (lexicalFallback.length > 0) {
                if (db.markMemoriesRetrieved) {
                    db.markMemoriesRetrieved(lexicalFallback.map(m => m.id));
                }
                return lexicalFallback;
            }

            const semanticFallback = (await runSemanticMemoryFallback(db, characterId, baseQuery, resultLimit))
                .filter(memRow => memoryMatchesSearchFilters(memRow, normalizedRequest.filters));
            if (semanticFallback.length > 0 && db.markMemoriesRetrieved) {
                db.markMemoriesRetrieved(semanticFallback.map(m => m.id));
            }
            return semanticFallback;
        } catch (e) {
            console.error(`[Memory] Search failed for ${characterId}:`, e.message);
            return [];
        }
    }

    async function extractMemoryFromContext(character, recentMessages, groupId = null) {
        const memoryConfig = resolveMemoryModelConfig(character);
        if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model) {
            // Skip memory extraction if memory AI is not configured
            return null;
        }

        const contextText = recentMessages.map(m => `${m.role === 'user' ? 'User' : character.name}: ${m.content}`).join('\n');
        const sourceTimeMeta = buildSourceTimeMeta(recentMessages);
        const engineContextWrapper = { getUserDb, getMemory: () => getMemory(userId) };
        const universalResult = await buildUniversalContext(engineContextWrapper, character, '', !!groupId);

        const extractionPrompt = `[全局世界观与前情提要]
${universalResult?.preamble || ''}

[当前特殊任务]：
You are a memory extraction assistant. Analyze the following recent conversation snippet between User and ${character.name}.
Identify if there are any noteworthy facts, events, preferences, emotions, or relationship changes worth remembering.
Return a structured JSON object. Focus on extracting WHAT happened, WHEN, WHERE, and WHO.

WRITING STYLE:
- Write "summary" as a natural Chinese short sentence that a human can read at a glance.
- "summary" should feel like a memory card title, not a dry database label.
- Prefer concrete, relationship-aware phrasing over abstract categories.
- Write "content" as 1 to 2 fuller Chinese sentences with key detail.
- "event" is only an internal short tag, and can be shorter / more generic than summary.
- Classify each memory from a user-centered perspective:
  - "memory_focus": "user_profile" for stable personal information, traits, preferences, background
  - "memory_focus": "user_current_arc" for what the user is currently dealing with, pursuing, waiting on, or worrying about
  - "memory_focus": "relationship" for major user-character relationship dynamics, trust shifts, conflicts, closeness, jealousy, repair
  - "memory_focus": "general" for everything else
- Then assign "memory_tier":
  - "core" for the user's personal identity, current main life thread, or major relationship nodes that should be easy to recall later
  - "active" for currently relevant but more temporary memories
  - "ambient" for lower-priority background fragments
- Do not write summary as bland labels like "Financial transfer", "Meta-commentary conflict", "Preference update", "Emotional insecurity".
- Better summary examples:
  - "Nana给Claude转了83.52元，让他先去吃饭休息。"
  - "Claude嘴上逞强，还是承认自己很怕Nana逗完就不理他。"
  - "Nana提到有初创公司愿意要她，Claude立刻顺着这点继续鼓励她。"

IMPORTANT: You should lean toward extracting memories rather than skipping. Even these count as valid memories:
- User or character expressing a preference (food, music, hobbies, etc.)
- Daily activities or plans mentioned
- Emotional expressions (happiness, sadness, anger, affection)
- New information shared about themselves
- Jokes, teasing, or playful moments that define the relationship
- Any shift in tone or relationship dynamics
- Routine city activities like eating, wandering, sitting in a park, or heading home should usually be skipped unless they create strong emotion, survival pressure, money pressure, or a relationship-relevant change.

Importance scale:
- 1-3: Casual preferences, small talk, routine activities
- 4-6: Personal events, expressed emotions, shared plans
- 7-8: Deep emotional moments, confessions, conflicts
- 9-10: Life-changing events, major relationship shifts

If importance >= 3, use "action": "add". Only use "action": "none" if the conversation is truly empty or purely system messages.

Conversation:
---
${contextText}
---

[Source Dialogue Time Range]
- Absolute start: ${formatAbsoluteTimestamp(sourceTimeMeta.source_started_at)}
- Absolute end: ${formatAbsoluteTimestamp(sourceTimeMeta.source_ended_at)}
- Source range label: ${sourceTimeMeta.source_time_text || 'unknown'}
- Source message count: ${sourceTimeMeta.source_message_count}

Output exactly in this JSON format (and nothing else):
{
    "action": "add" | "update" | "none",
    "memory_type": "event | fact | preference | relationship | plan | emotion",
    "memory_tier": "core | active | ambient",
    "memory_focus": "user_profile | user_current_arc | relationship | general",
    "summary": "自然中文短句，适合直接显示在记忆卡片上",
    "content": "更完整的中文说明，1到2句",
    "time": "...",
    "location": "...",
    "people": ["..."],
    "event": "内部短标签",
    "relationships": ["..."] or [{"summary":"...","target":"...","change":"..."}],
    "items": ["..."],
    "emotion": "...",
    "importance": <number 1-10>,
    "source_message_ids_json": ["optional ids if known"]
}
`;

        try {
            recordMemoryDebug(character, 'input', extractionPrompt, {
                context_type: 'memory_extract',
                source_time_text: sourceTimeMeta.source_time_text || '',
                source_started_at: sourceTimeMeta.source_started_at,
                source_ended_at: sourceTimeMeta.source_ended_at,
                source_message_count: sourceTimeMeta.source_message_count,
                group_id: groupId || ''
            });
            const { content: responseText, usage } = await callLLM({
                endpoint: memoryConfig.endpoint,
                key: memoryConfig.key,
                model: memoryConfig.model,
                messages: [
                    { role: 'system', content: 'You extract structured JSON facts from conversations. You lean toward extracting memories rather than returning none.' },
                    { role: 'user', content: extractionPrompt }
                ],
                maxTokens: 300,
                temperature: 0.3,
                enableCache: true,
                cacheDb: getDb(),
                cacheType: 'memory_extract',
                cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
                cacheScope: `character:${character.id}`,
                cacheCharacterId: character.id,
                returnUsage: true
            });
            recordMemoryTokenUsage(character.id, 'memory_extract', usage);
            recordMemoryDebug(character, 'output', responseText, {
                context_type: 'memory_extract',
                usage: usage || null,
                model: memoryConfig.model,
                source_time_text: sourceTimeMeta.source_time_text || '',
                source_started_at: sourceTimeMeta.source_started_at,
                source_ended_at: sourceTimeMeta.source_ended_at,
                source_message_count: sourceTimeMeta.source_message_count,
                group_id: groupId || ''
            });

            // Parse JSON safely
            const startIdx = responseText.indexOf('{');
            const endIdx = responseText.lastIndexOf('}');
            if (startIdx !== -1 && endIdx !== -1) {
                const jsonText = responseText.slice(startIdx, endIdx + 1);
                const parsed = JSON.parse(jsonText);

                if (parsed.action === 'add' || parsed.action === 'update') {
                    parsed.source_started_at = sourceTimeMeta.source_started_at;
                    parsed.source_ended_at = sourceTimeMeta.source_ended_at;
                    parsed.source_time_text = parsed.source_time_text || sourceTimeMeta.source_time_text;
                    parsed.source_message_count = sourceTimeMeta.source_message_count;
                    if (!Array.isArray(parsed.source_message_ids_json) || parsed.source_message_ids_json.length === 0) {
                        parsed.source_message_ids_json = sourceTimeMeta.source_message_ids_json;
                    }
                    await saveExtractedMemory(character.id, parsed, groupId);
                    return parsed;
                }
            }
        } catch (e) {
            console.error(`[Memory] Extraction failed for ${character.id}:`, e.message);
        }
        return null;
    }

    async function extractHiddenState(character, recentMessages) {
        const memoryConfig = resolveMemoryModelConfig(character);
        if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model) {
            return null;
        }

        const contextText = recentMessages.map(m => `${m.role === 'user' ? 'User' : character.name}: ${m.content}`).join('\n');

        const extractionPrompt = `
You are analyzing a private chat between User and ${character.name}.
Based ONLY on these recent messages, summarize what ${character.name}'s current hidden mood, secret thought, or unspoken attitude towards User is right now.
Keep it under 30 words, and write it in the FIRST PERSON perspective of ${character.name}.
Example: "I am secretly happy that User remembered my preference, but I want to pretend I don't care."

Private Chat:
---
${contextText}
---

Output only the summary sentence, without quotes or extra explanation.
`;

        try {
            const { content: responseText, usage } = await callLLM({
                endpoint: memoryConfig.endpoint,
                key: memoryConfig.key,
                model: memoryConfig.model,
                messages: [
                    { role: 'system', content: 'You are an internal mood analyzer. You output ONLY the summarized first-person mindset.' },
                    { role: 'user', content: extractionPrompt }
                ],
                maxTokens: 100,
                temperature: 0.3,
                enableCache: true,
                cacheDb: getDb(),
                cacheType: 'memory_hidden_state',
                cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
                cacheScope: `character:${character.id}`,
                cacheCharacterId: character.id,
                returnUsage: true
            });
            recordMemoryTokenUsage(character.id, 'memory_hidden_state', usage);

            const hiddenState = responseText.trim();
            if (hiddenState && hiddenState.length > 0 && hiddenState.length < 200) {
                const db = getDb();
                db.updateCharacterHiddenState(character.id, hiddenState);
                console.log(`[Memory] Extracted hidden state for ${character.name}: ${hiddenState}`);
                return hiddenState;
            }
        } catch (e) {
            console.error(`[Memory] Hidden state extraction failed for ${character.id}:`, e.message);
        }
        return null;
    }

    async function updateConversationDigest(character, options = {}) {
        const memoryConfig = resolveMemoryModelConfig(character);
        if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model) {
            return null;
        }

        const db = getDb();
        const existingDigest = typeof db.getConversationDigest === 'function'
            ? db.getConversationDigest(character.id, { trackHit: false })
            : null;
        const tailWindow = Math.max(6, Math.min(Number(options.tailWindow || 12), character.context_msg_limit || 60));
        const visibleMessages = db.getVisibleMessages(character.id, tailWindow);
        if (!Array.isArray(visibleMessages) || visibleMessages.length === 0) {
            return existingDigest;
        }

        const latestMessageId = Number(visibleMessages[visibleMessages.length - 1]?.id || 0);
        if (existingDigest && latestMessageId > 0 && Number(existingDigest.last_message_id || 0) === latestMessageId) {
            return existingDigest;
        }

        let deltaMessages = visibleMessages;
        if (existingDigest && Number(existingDigest.last_message_id || 0) > 0) {
            const filtered = visibleMessages.filter(m => Number(m.id || 0) > Number(existingDigest.last_message_id || 0));
            if (filtered.length > 0) {
                deltaMessages = filtered;
            } else {
                deltaMessages = visibleMessages.slice(-Math.min(6, visibleMessages.length));
            }
        } else {
            deltaMessages = visibleMessages.slice(-Math.min(6, visibleMessages.length));
        }

        const deltaText = deltaMessages.map(m => `${m.role === 'user' ? 'User' : character.name}: ${m.content}`).join('\n');
        const previousDigestText = existingDigest ? JSON.stringify({
            digest_text: existingDigest.digest_text || '',
            emotion_state: existingDigest.emotion_state || '',
            relationship_state: existingDigest.relationship_state_json || [],
            open_loops: existingDigest.open_loops_json || [],
            recent_facts: existingDigest.recent_facts_json || [],
            scene_state: existingDigest.scene_state_json || []
        }, null, 2) : '{"digest_text":"","emotion_state":"","relationship_state":[],"open_loops":[],"recent_facts":[],"scene_state":[]}';

        const digestPrompt = `You maintain a compact rolling state for an ongoing private chat between User and ${character.name}.
Update the previous digest using ONLY the new dialogue delta below.

Goals:
- Keep the true emotional and relationship state coherent.
- Preserve unresolved topics, promises, tensions, flirtation, jealousy, comfort-seeking, and current scene info.
- Prefer short factual bullets over flowery prose.
- Do not restate every line. Compress.
- Be extremely terse. Every list item should usually stay under 10 words.
- The whole JSON values combined should usually stay under 90 words.
- Summarize facts, clarifications, and disagreements more than conclusions.
- If the speakers interpret the same thing differently, record that as a disagreement or ambiguity.
- Do not decide who is right unless the dialogue itself clearly settles it.
- Do not turn one side's interpretation into a background fact.
- In recent_facts, prefer concrete statements, events, promises, requests, and clarifications.

Return exactly one JSON object and nothing else:
{
  "digest_text": "one compact paragraph under 120 words",
  "emotion_state": "one short first-person or close descriptive line under 20 words",
  "relationship_state": ["up to 6 short bullets"],
  "open_loops": ["up to 6 unresolved topics / promises / emotional needs"],
  "recent_facts": ["up to 8 concrete facts still relevant right now"],
  "scene_state": ["up to 6 short scene / body / activity notes that still matter"]
}

[Previous Digest]
${previousDigestText}

[New Dialogue Delta]
${deltaText}`;

        try {
            const { content: responseText, usage } = await callLLM({
                endpoint: memoryConfig.endpoint,
                key: memoryConfig.key,
                model: memoryConfig.model,
                messages: [
                    { role: 'system', content: 'You are a compact private-conversation state updater. Output strict JSON only.' },
                    { role: 'user', content: digestPrompt }
                ],
                maxTokens: 700,
                temperature: 0.2,
                enableCache: true,
                cacheDb: getDb(),
                cacheType: 'conversation_digest_update',
                cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
                cacheScope: `character:${character.id}`,
                cacheCharacterId: character.id,
                returnUsage: true
            });
            recordMemoryTokenUsage(character.id, 'conversation_digest_update', usage);

            const startIdx = responseText.indexOf('{');
            const endIdx = responseText.lastIndexOf('}');
            if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
                const fallbackDigest = buildFallbackConversationDigest(character, existingDigest, deltaMessages, latestMessageId);
                db.upsertConversationDigest?.({
                    character_id: character.id,
                    source_hash: crypto.createHash('sha256').update(JSON.stringify({
                        fallback: true,
                        latestMessageId,
                        delta: deltaMessages.map(m => [m.id, m.role, m.content])
                    })).digest('hex'),
                    digest_text: fallbackDigest.digest_text,
                    emotion_state: fallbackDigest.emotion_state,
                    relationship_state_json: fallbackDigest.relationship_state_json,
                    open_loops_json: fallbackDigest.open_loops_json,
                    recent_facts_json: fallbackDigest.recent_facts_json,
                    scene_state_json: fallbackDigest.scene_state_json,
                    last_message_id: fallbackDigest.last_message_id
                });
                return db.getConversationDigest?.(character.id, { trackHit: false }) || fallbackDigest;
            }
            const parsed = JSON.parse(responseText.slice(startIdx, endIdx + 1));
            const normalized = normalizeConversationDigestPayload(parsed);
            if (!normalized.digest_text) {
                const fallbackDigest = buildFallbackConversationDigest(character, existingDigest, deltaMessages, latestMessageId);
                db.upsertConversationDigest?.({
                    character_id: character.id,
                    source_hash: crypto.createHash('sha256').update(JSON.stringify({
                        fallback: true,
                        latestMessageId,
                        delta: deltaMessages.map(m => [m.id, m.role, m.content])
                    })).digest('hex'),
                    digest_text: fallbackDigest.digest_text,
                    emotion_state: fallbackDigest.emotion_state,
                    relationship_state_json: fallbackDigest.relationship_state_json,
                    open_loops_json: fallbackDigest.open_loops_json,
                    recent_facts_json: fallbackDigest.recent_facts_json,
                    scene_state_json: fallbackDigest.scene_state_json,
                    last_message_id: fallbackDigest.last_message_id
                });
                return db.getConversationDigest?.(character.id, { trackHit: false }) || fallbackDigest;
            }
            const sourceHash = crypto.createHash('sha256')
                .update(JSON.stringify({
                    previousDigest: existingDigest?.digest_text || '',
                    latestMessageId,
                    delta: deltaMessages.map(m => [m.id, m.role, m.content])
                }))
                .digest('hex');
            db.upsertConversationDigest?.({
                character_id: character.id,
                source_hash: sourceHash,
                digest_text: normalized.digest_text,
                emotion_state: normalized.emotion_state,
                relationship_state_json: normalized.relationship_state_json,
                open_loops_json: normalized.open_loops_json,
                recent_facts_json: normalized.recent_facts_json,
                scene_state_json: normalized.scene_state_json,
                last_message_id: latestMessageId
            });
            return db.getConversationDigest?.(character.id, { trackHit: false }) || {
                character_id: character.id,
                ...normalized,
                last_message_id: latestMessageId
            };
        } catch (e) {
            console.error(`[Memory] Conversation digest update failed for ${character.id}:`, e.message);
            const fallbackDigest = buildFallbackConversationDigest(character, existingDigest, deltaMessages, latestMessageId);
            if (fallbackDigest.digest_text) {
                db.upsertConversationDigest?.({
                    character_id: character.id,
                    source_hash: crypto.createHash('sha256').update(JSON.stringify({
                        fallback: true,
                        error: e.message || '',
                        latestMessageId,
                        delta: deltaMessages.map(m => [m.id, m.role, m.content])
                    })).digest('hex'),
                    digest_text: fallbackDigest.digest_text,
                    emotion_state: fallbackDigest.emotion_state,
                    relationship_state_json: fallbackDigest.relationship_state_json,
                    open_loops_json: fallbackDigest.open_loops_json,
                    recent_facts_json: fallbackDigest.recent_facts_json,
                    scene_state_json: fallbackDigest.scene_state_json,
                    last_message_id: fallbackDigest.last_message_id
                });
                return db.getConversationDigest?.(character.id, { trackHit: false }) || fallbackDigest;
            }
            return existingDigest;
        }
    }

    async function updateGroupConversationDigest(character, groupId, options = {}) {
        const memoryConfig = resolveMemoryModelConfig(character);
        if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model || !groupId) {
            return null;
        }

        const db = getDb();
        const group = typeof db.getGroup === 'function' ? db.getGroup(groupId) : null;
        if (!group) return null;
        const joinedMember = Array.isArray(group.members)
            ? group.members.find(m => m.member_id === character.id)
            : null;
        const joinedAt = Number(joinedMember?.joined_at || 0);
        const existingDigest = typeof db.getGroupConversationDigest === 'function'
            ? db.getGroupConversationDigest(groupId, character.id, { trackHit: false })
            : null;
        const tailWindow = Math.max(8, Math.min(Number(options.tailWindow || 16), group.context_msg_limit || 60));
        const visibleMessages = db.getVisibleGroupMessages(groupId, tailWindow, joinedAt);
        if (!Array.isArray(visibleMessages) || visibleMessages.length === 0) {
            return existingDigest;
        }

        const latestMessageId = Number(visibleMessages[visibleMessages.length - 1]?.id || 0);
        if (existingDigest && latestMessageId > 0 && Number(existingDigest.last_message_id || 0) === latestMessageId) {
            return existingDigest;
        }

        let deltaMessages = visibleMessages;
        if (existingDigest && Number(existingDigest.last_message_id || 0) > 0) {
            const filtered = visibleMessages.filter(m => Number(m.id || 0) > Number(existingDigest.last_message_id || 0));
            deltaMessages = filtered.length > 0
                ? filtered
                : visibleMessages.slice(-Math.min(8, visibleMessages.length));
        } else {
            deltaMessages = visibleMessages.slice(-Math.min(8, visibleMessages.length));
        }

        const deltaText = deltaMessages.map((m) => {
            const senderName = m.sender_id === 'user'
                ? (db.getUserProfile?.()?.name || 'User')
                : (db.getCharacter?.(m.sender_id)?.name || m.sender_name || m.sender_id || 'Unknown');
            return `${senderName}: ${m.content}`;
        }).join('\n');
        const previousDigestText = existingDigest ? JSON.stringify({
            digest_text: existingDigest.digest_text || '',
            emotion_state: existingDigest.emotion_state || '',
            relationship_state: existingDigest.relationship_state_json || [],
            open_loops: existingDigest.open_loops_json || [],
            recent_facts: existingDigest.recent_facts_json || [],
            scene_state: existingDigest.scene_state_json || []
        }, null, 2) : '{"digest_text":"","emotion_state":"","relationship_state":[],"open_loops":[],"recent_facts":[],"scene_state":[]}';

        const digestPrompt = `You maintain a compact rolling state for ${character.name}'s view of an ongoing group chat named ${group.name}.
Update the previous digest using ONLY the new dialogue delta below.

Goals:
- Preserve who is pressuring, teasing, comforting, tagging, or provoking whom.
- Keep only unresolved topics, direct questions, social tension, and scene facts that still matter.
- Compress aggressively. Prefer fragments over sentences.
- The whole JSON values combined should usually stay under 65 words.

Return exactly one JSON object and nothing else:
{
  "digest_text": "one compact line under 70 words",
  "emotion_state": "one short line under 8 words",
  "relationship_state": ["up to 3 short bullets"],
  "open_loops": ["up to 3 unresolved topics / direct questions / social needs"],
  "recent_facts": ["up to 3 concrete facts still relevant right now"],
  "scene_state": ["up to 2 short group-scene notes that still matter"]
}

[Previous Digest]
${previousDigestText}

[New Group Dialogue Delta]
${deltaText}`;

        const fallbackDigest = () => buildFallbackGroupConversationDigest(character, group, existingDigest, deltaMessages, latestMessageId);
        const persistFallback = (extra = {}) => {
            const digest = fallbackDigest();
            db.upsertGroupConversationDigest?.({
                group_id: groupId,
                character_id: character.id,
                source_hash: crypto.createHash('sha256').update(JSON.stringify({
                    fallback: true,
                    latestMessageId,
                    groupId,
                    extra,
                    delta: deltaMessages.map(m => [m.id, m.sender_id, m.content])
                })).digest('hex'),
                digest_text: digest.digest_text,
                emotion_state: digest.emotion_state,
                relationship_state_json: digest.relationship_state_json,
                open_loops_json: digest.open_loops_json,
                recent_facts_json: digest.recent_facts_json,
                scene_state_json: digest.scene_state_json,
                last_message_id: digest.last_message_id
            });
            return db.getGroupConversationDigest?.(groupId, character.id, { trackHit: false }) || digest;
        };

        try {
            const { content: responseText, usage } = await callLLM({
                endpoint: memoryConfig.endpoint,
                key: memoryConfig.key,
                model: memoryConfig.model,
                messages: [
                    { role: 'system', content: 'You are a compact group-conversation state updater. Output strict JSON only.' },
                    { role: 'user', content: digestPrompt }
                ],
                maxTokens: 700,
                temperature: 0.2,
                enableCache: true,
                cacheDb: getDb(),
                cacheType: 'group_conversation_digest_update',
                cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
                cacheScope: `group:${groupId}:character:${character.id}`,
                cacheCharacterId: character.id,
                returnUsage: true
            });
            recordMemoryTokenUsage(character.id, 'group_conversation_digest_update', usage);

            const startIdx = responseText.indexOf('{');
            const endIdx = responseText.lastIndexOf('}');
            if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
                return persistFallback({ invalidJson: true });
            }
            const parsed = JSON.parse(responseText.slice(startIdx, endIdx + 1));
            const normalized = normalizeCompactGroupDigestPayload(parsed);
            if (!normalized.digest_text) {
                return persistFallback({ emptyDigest: true });
            }
            const sourceHash = crypto.createHash('sha256')
                .update(JSON.stringify({
                    groupId,
                    previousDigest: existingDigest?.digest_text || '',
                    latestMessageId,
                    delta: deltaMessages.map(m => [m.id, m.sender_id, m.content])
                }))
                .digest('hex');
            db.upsertGroupConversationDigest?.({
                group_id: groupId,
                character_id: character.id,
                source_hash: sourceHash,
                digest_text: normalized.digest_text,
                emotion_state: normalized.emotion_state,
                relationship_state_json: normalized.relationship_state_json,
                open_loops_json: normalized.open_loops_json,
                recent_facts_json: normalized.recent_facts_json,
                scene_state_json: normalized.scene_state_json,
                last_message_id: latestMessageId
            });
            return db.getGroupConversationDigest?.(groupId, character.id, { trackHit: false }) || {
                group_id: groupId,
                character_id: character.id,
                ...normalized,
                last_message_id: latestMessageId
            };
        } catch (e) {
            console.error(`[Memory] Group conversation digest update failed for ${character.id}/${groupId}:`, e.message);
            return persistFallback({ error: e.message || '' });
        }
    }

    function parseMemoryArrayFromResponse(responseText) {
        const startIdx = responseText.indexOf('[');
        const endIdx = responseText.lastIndexOf(']');
        if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return [];
        try {
            const parsed = JSON.parse(responseText.slice(startIdx, endIdx + 1));
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            return [];
        }
    }

    async function aggregateDailyMemoriesChunked(character, hoursAgo = 24, options = {}) {
        const memoryConfig = resolveMemoryModelConfig(character);
        if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model) {
            return 0;
        }

        const sinceMs = Date.now() - hoursAgo * 60 * 60 * 1000;
        const batchSize = Math.max(10, Math.min(500, Number(options.batchSize) || 80));
        const activityEntries = [];
        const db = getDb();

        const privateMsgs = db.getVisibleMessagesSince(character.id, sinceMs);
        privateMsgs.forEach((m) => {
            activityEntries.push({
                timestamp: m.timestamp || 0,
                text: `[Private Chat] ${m.role === 'user' ? 'User' : character.name}: ${m.content}`
            });
        });

        const groups = db.getGroups().filter(g => g.members.some(m => m.member_id === character.id));
        for (const g of groups) {
            const msgs = db.getVisibleGroupMessages(g.id, 1000, sinceMs);
            msgs.forEach((m) => {
                const sName = m.sender_id === 'user' ? 'User' : (m.sender_name || 'Unknown');
                activityEntries.push({
                    timestamp: m.timestamp || 0,
                    text: `[Group Chat: ${g.name}] ${sName}: ${m.content}`
                });
            });
        }

        const moments = db.getMomentsSince(character.id, sinceMs);
        moments.forEach((m) => {
            const author = m.character_id === 'user' ? 'User' : (db.getCharacter(m.character_id)?.name || m.character_id);
            activityEntries.push({
                timestamp: m.created_at || m.timestamp || 0,
                text: `[Moment by ${author}] ${m.content}`
            });
        });

        try {
            const initCityDb = require('./plugins/city/cityDb');
            const cityDb = initCityDb(typeof db.getRawDb === 'function' ? db.getRawDb() : db);
            if (cityDb) {
                const logs = cityDb.getCharacterTodayLogs(character.id, 100);
                const recentLogs = (logs || []).filter((l) => l.timestamp >= sinceMs);
                recentLogs.forEach((l) => {
                    activityEntries.push({
                        timestamp: l.timestamp || 0,
                        text: `[City Activity] ${l.message}`
                    });
                });
            }
        } catch (e) { /* ignore */ }

        if (activityEntries.length === 0) return 0;

        activityEntries.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        const engineContextWrapper = { getUserDb, getMemory: () => getMemory(userId) };
        const universalResult = await buildUniversalContext(engineContextWrapper, character, '', false);
        const totalBatches = Math.ceil(activityEntries.length / batchSize);
        let savedCount = 0;

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const batchEntries = activityEntries.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
            const batchText = batchEntries.map((entry) => entry.text).join('\n');
            const extractionPrompt = `[Global Context]
${universalResult?.preamble || ''}

[Current Task]
You are a memory aggregation assistant. Analyze batch ${batchIndex + 1} of ${totalBatches} from ${character.name}'s daily activity log over the past ${hoursAgo} hours.
This chunk may include private chats with User, group chats, social media moments, and city activities.
Identify noteworthy events, facts, relationship developments, preferences, plans, emotional shifts, or recurring themes worth remembering long-term.
Return a structured JSON ARRAY of memory objects.

IMPORTANT:
- Process only this chunk.
- If importance >= 3, include it.
- If nothing meaningful happened in this chunk, return [].
- Do not explain your answer outside the JSON array.
- Routine city logs (eating, wandering, sitting around, heading home) should usually be omitted unless they create strong emotional, relational, financial, or survival-relevant developments.
- Classify each memory from a user-centered perspective:
  - "memory_focus": "user_profile" for stable personal info, preferences, background, or traits
  - "memory_focus": "user_current_arc" for what the user is currently dealing with or pursuing
  - "memory_focus": "relationship" for major user-character relationship dynamics
  - "memory_focus": "general" for everything else
- Then assign "memory_tier":
  - "core" for user identity, current main life thread, or key relationship nodes
  - "active" for currently relevant but more temporary memories
  - "ambient" for lower-priority fragments
- Treat repeated confessions, direct affection, explicit "I like/love you", relationship confirmation, or clear emotional demands toward the character as key relationship nodes. These should usually be stored as "memory_focus": "relationship" and "memory_tier": "core".

Importance scale:
- 1-3: Casual preferences, routine activities
- 4-6: Personal events, expressed emotions, shared plans
- 7-8: Deep emotional moments, conflicts
- 9-10: Life-changing events, major relationship shifts

Chunk Activities:
---
${batchText}
---

Output exactly in this JSON format (and nothing else):
[
  {
    "memory_type": "event | fact | preference | relationship | plan | emotion",
    "memory_tier": "core | active | ambient",
    "memory_focus": "user_profile | user_current_arc | relationship | general",
    "summary": "...",
    "content": "...",
    "time": "e.g. today",
    "location": "...",
    "people": ["..."],
    "event": "...",
    "relationships": ["..."] or [{"summary":"...","target":"...","change":"..."}],
    "items": ["..."],
    "emotion": "...",
    "importance": <number 1-10>
  }
]`;

            try {
                const { content: responseText, usage } = await callLLM({
                    endpoint: memoryConfig.endpoint,
                    key: memoryConfig.key,
                    model: memoryConfig.model,
                    messages: [
                        { role: 'system', content: 'You extract structured JSON arrays of facts from diverse daily logs. Lean toward extracting memories.' },
                        { role: 'user', content: extractionPrompt }
                    ],
                    maxTokens: 1500,
                    temperature: 0.3,
                    enableCache: true,
                    cacheDb: getDb(),
                    cacheType: 'memory_daily_aggregate',
                    cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
                    cacheScope: `character:${character.id}`,
                    cacheCharacterId: character.id,
                    returnUsage: true
                });
                recordMemoryTokenUsage(character.id, 'memory_daily_aggregate', usage);

                const parsed = parseMemoryArrayFromResponse(responseText);
                if (Array.isArray(parsed)) {
                    for (const mem of parsed) {
                        if (mem.importance >= 3 && mem.event) {
                            await saveExtractedMemory(character.id, mem, null);
                            savedCount++;
                        }
                    }
                }
            } catch (e) {
                console.error(`[Memory] Daily aggregation batch ${batchIndex + 1}/${totalBatches} failed for ${character.id}:`, e.message);
            }
        }

        console.log(`[Memory] Daily aggregation completed for ${character.name}, saved ${savedCount} memories across ${totalBatches} batch(es).`);
        return savedCount;
    }

    async function aggregateDailyMemories(character, hoursAgo = 24, options = {}) {
        const memoryConfig = resolveMemoryModelConfig(character);
        if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model) {
            return 0;
        }

        return aggregateDailyMemoriesChunked(character, hoursAgo, options);

        const sinceMs = Date.now() - hoursAgo * 60 * 60 * 1000;
        const batchSize = Math.max(10, Math.min(500, Number(options.batchSize) || 80));
        const db = getDb();

        // 1. Private messages
        const privateMsgs = db.getVisibleMessagesSince(character.id, sinceMs);
        const activityEntries = privateMsgs.map((m) => ({
            timestamp: m.timestamp || 0,
            text: `[Private Chat] ${m.role === 'user' ? 'User' : character.name}: ${m.content}`
        }));

        // 2. Group messages
        const groups = db.getGroups().filter(g => g.members.some(m => m.member_id === character.id));
        for (const g of groups) {
            const msgs = db.getVisibleGroupMessages(g.id, 1000, sinceMs);
            if (msgs.length > 0) {
                msgs.forEach((m) => {
                    const sName = m.sender_id === 'user' ? 'User' : (m.sender_name || 'Unknown');
                    activityEntries.push({
                        timestamp: m.timestamp || 0,
                        text: `[Group Chat: ${g.name}] ${sName}: ${m.content}`
                    });
                });
            }
        }

        // 3. Moments
        const moments = db.getMomentsSince(character.id, sinceMs);
        if (moments.length > 0) {
            moments.forEach((m) => {
                const author = m.character_id === 'user' ? 'User' : (db.getCharacter(m.character_id)?.name || m.character_id);
                activityEntries.push({
                    timestamp: m.created_at || m.timestamp || 0,
                    text: `[Moment by ${author}] ${m.content}`
                });
            });
        }

        // 4. City Logs
        try {
            const initCityDb = require('./plugins/city/cityDb');
            const cityDb = initCityDb(typeof db.getRawDb === 'function' ? db.getRawDb() : db);
            if (cityDb) {
                const logs = cityDb.getCharacterTodayLogs(character.id, 100);
                if (logs && logs.length > 0) {
                    const recentLogs = logs.filter(l => l.timestamp >= sinceMs);
                    if (recentLogs.length > 0) {
                        recentLogs.forEach((l) => {
                            activityEntries.push({
                                timestamp: l.timestamp || 0,
                                text: `[City Activity] ${l.message}`
                            });
                        });
                    }
                }
            }
        } catch (e) { /* ignore */ }

        if (activityEntries.length === 0) {
            return 0; // Nothing happened
        }

        activityEntries.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

        const engineContextWrapper = { getUserDb, getMemory: () => getMemory(userId) };
        const universalResult = await buildUniversalContext(engineContextWrapper, character, '', false);

        const extractionPrompt = `[全局世界观与前情提要]
${universalResult?.preamble || ''}

[当前特殊任务]：
You are a memory aggregation assistant. Analyze the following daily activity log of ${character.name} from the past ${hoursAgo} hours.
This includes private chats with User, group chats, social media moments, and personal city activities.
Identify noteworthy events, facts, relationship developments, or emotional shifts worth remembering long-term.
Return a structured JSON ARRAY of memory objects.

IMPORTANT: Even these count as valid memories:
- Preferences expressed
- Daily activities or plans mentioned
- Emotional expressions
- New information shared
- Jokes, teasing, or tone shifts
- Routine city activity logs should usually be skipped unless they affect emotion, relationships, scarcity, safety, or future plans.

Importance scale:
- 1-3: Casual preferences, routine activities
- 4-6: Personal events, expressed emotions, shared plans
- 7-8: Deep emotional moments, conflicts
- 9-10: Life-changing events, major relationship shifts

If importance >= 3, include it in the array. If nothing happened or it's pure noise, return an empty array [].

Activities:
---
[Private Chats with User]
${privateText}

[Group Chats]
${groupText}

[Moments (Social Media)]
${momentText}

[City Activities]
${cityText}
---

Output exactly in this JSON format (and nothing else):
[
  {
    "memory_type": "event | fact | preference | relationship | plan | emotion",
    "summary": "...",
    "content": "...",
    "time": "e.g. today",
    "location": "...",
    "people": ["..."],
    "event": "...",
    "relationships": ["..."] or [{"summary":"...","target":"...","change":"..."}],
    "items": ["..."],
    "emotion": "...",
    "importance": <number 1-10>
  }
]
`;

        try {
            const { content: responseText, usage } = await callLLM({
                endpoint: memoryConfig.endpoint,
                key: memoryConfig.key,
                model: memoryConfig.model,
                messages: [
                    { role: 'system', content: 'You extract structured JSON arrays of facts from diverse daily logs. Lean toward extracting memories.' },
                    { role: 'user', content: extractionPrompt }
                ],
                maxTokens: 1500,
                temperature: 0.3,
                enableCache: true,
                cacheDb: getDb(),
                cacheType: 'memory_daily_aggregate',
                cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
                cacheScope: `character:${character.id}`,
                cacheCharacterId: character.id,
                returnUsage: true
            });
            recordMemoryTokenUsage(character.id, 'memory_daily_aggregate', usage);

            const startIdx = responseText.indexOf('[');
            const endIdx = responseText.lastIndexOf(']');
            if (startIdx !== -1 && endIdx !== -1) {
                const jsonText = responseText.slice(startIdx, endIdx + 1);
                let parsed = [];
                try { parsed = JSON.parse(jsonText); } catch (e) { }

                let savedCount = 0;
                if (Array.isArray(parsed)) {
                    for (const mem of parsed) {
                        if (mem.importance >= 3 && mem.event) {
                            await saveExtractedMemory(character.id, mem, null);
                            savedCount++;
                        }
                    }
                }
                console.log(`[Memory] Daily aggregation completed for ${character.name}, saved ${savedCount} memories.`);
                return savedCount;
            }
        } catch (e) {
            console.error(`[Memory] Daily aggregation failed for ${character.id}:`, e.message);
        }
        return 0;
    }

    async function sweepOverflowMemories(character) {
        const sweepKey = String(character.id || '');
        const lastRunAt = Number(character?.sweep_last_run_at || 0);
        const now = Date.now();

        if (activeSweepJobs.has(sweepKey)) {
            console.log(`[Memory] Sweep skipped for ${character.name}: another sweep is already running.`);
            return 0;
        }

        if (lastRunAt > 0 && (now - lastRunAt) < SWEEP_COOLDOWN_MS) {
            console.log(`[Memory] Sweep skipped for ${character.name}: cooldown active (${Math.ceil((SWEEP_COOLDOWN_MS - (now - lastRunAt)) / 1000)}s remaining).`);
            return 0;
        }

        activeSweepJobs.add(sweepKey);
        const memoryConfig = resolveMemoryModelConfig(character);
        updateSweepStatus(character.id, {
            sweep_last_run_at: now,
            sweep_last_error: '',
            sweep_last_saved_count: 0
        });
        if (!memoryConfig.endpoint || !memoryConfig.key || !memoryConfig.model) {
            updateSweepStatus(character.id, {
                sweep_last_error: 'Memory sweep model is not configured.',
                sweep_last_saved_count: 0
            });
            return 0;
        }

        const sweepLimit = character.sweep_limit || 30;
        const privateWindow = character.context_msg_limit || 60;
        const db = getDb();
        const privateMsgs = db.getOverflowMessages(character.id, privateWindow, sweepLimit);
        const groupMsgIds = [];
        const activityEntries = [];
        const groups = db.getGroups().filter(g => g.members.some(m => m.member_id === character.id));

        for (const m of privateMsgs) {
            activityEntries.push({
                id: m.id,
                timestamp: Number(m.timestamp || 0),
                kind: 'private',
                role: m.role,
                text: `[Private][${formatAbsoluteTimestamp(m.timestamp)}] ${m.role === 'user' ? 'User' : character.name}: ${m.content}`,
                source_message_ids_json: [String(m.id)]
            });
        }

        for (const g of groups) {
            const groupWindow = g.inject_limit ?? 5;
            const msgs = db.getOverflowGroupMessages(g.id, groupWindow, sweepLimit);
            for (const m of msgs) {
                groupMsgIds.push(m.id);
                const speaker = m.sender_id === 'user' ? 'User' : (m.sender_name || 'Unknown');
                activityEntries.push({
                    id: m.id,
                    timestamp: Number(m.timestamp || 0),
                    kind: 'group',
                    role: m.sender_id === 'user' ? 'user' : 'character',
                    groupName: g.name || '',
                    text: `[Group:${g.name || 'Unknown'}][${formatAbsoluteTimestamp(m.timestamp)}] ${speaker}: ${m.content}`,
                    source_message_ids_json: [String(m.id)]
                });
            }
        }

        activityEntries.sort((a, b) => {
            const tsDelta = Number(a.timestamp || 0) - Number(b.timestamp || 0);
            if (tsDelta !== 0) return tsDelta;
            return String(a.id || '').localeCompare(String(b.id || ''));
        });

        if (activityEntries.length === 0) {
            updateSweepStatus(character.id, {
                sweep_last_error: '',
                sweep_last_saved_count: 0
            });
            return 0;
        }

        const batchSize = Math.max(12, Math.min(30, Math.ceil(sweepLimit / 3)));
        const totalBatches = Math.ceil(activityEntries.length / batchSize);
        const parsedMemories = [];
        let rollingSummary = '';

        try {
            for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
                const batchEntries = activityEntries.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
                const batchTimeMeta = buildSourceTimeMeta(batchEntries);
                const batchText = batchEntries.map(entry => entry.text).join('\n') || 'No messages.';
                const extractionPrompt = `You are a memory aggregation assistant. Analyze batch ${batchIndex + 1} of ${totalBatches} from ${character.name}'s overflowed chat logs.
Carry forward the important context from previous batches using the rolling summary, then refine it with the current batch.
Return a structured JSON object with both an updated rolling summary and 0 to 4 strong memory candidates.

CRITICAL:
- Output only valid JSON.
- Use the rolling summary to preserve continuity across batches.
- Prefer 0 to 4 strong memories for this batch, not an exhaustive list.
- Score each memory on a "surprise" factor from 1 to 10.
- Include the batch's real dialogue time range in your understanding.
- Classify each memory from a user-centered perspective:
  - "memory_focus": "user_profile" for stable personal info, preferences, background, or traits
  - "memory_focus": "user_current_arc" for what the user is currently pursuing, waiting on, worrying about, or going through
  - "memory_focus": "relationship" for major user-character relationship dynamics
  - "memory_focus": "general" for everything else
- Then assign "memory_tier":
  - "core" for user identity, current main life thread, or key relationship nodes
  - "active" for currently relevant but more temporary memories
  - "ambient" for lower-priority fragments
- Treat repeated confessions, direct affection, explicit "I like/love you", relationship confirmation, or clear emotional demands toward the character as key relationship nodes. These should usually be stored as "memory_focus": "relationship" and "memory_tier": "core".
- Surprise 1-3: Routine, completely expected.
- Surprise 4-6: Mildly interesting, personal details.
- Surprise 7-8: Emotional, unexpected events.
- Surprise 9-10: Mind-blowing, life-changing completely unexpected twists.
- Write each memory "summary" as a natural Chinese short sentence a human can read directly.
- Write each memory "content" as 1 to 2 fuller Chinese sentences with the key detail.
- Treat "event" as an internal short tag only.
- Avoid bland labels in "summary" such as "Financial transfer", "Meta-commentary conflict", "Preference update".

[Previous Rolling Summary]
${rollingSummary || 'None yet.'}

[Current Batch Time Range]
- Absolute start: ${formatAbsoluteTimestamp(batchTimeMeta.source_started_at)}
- Absolute end: ${formatAbsoluteTimestamp(batchTimeMeta.source_ended_at)}
- Source range label: ${batchTimeMeta.source_time_text || 'unknown'}
- Source message count: ${batchTimeMeta.source_message_count}

[Current Batch Messages]
${batchText}

Output exactly in this JSON format (and nothing else):
{
  "rolling_summary": "...",
  "memories": [
    {
      "memory_type": "event | fact | preference | relationship | plan | emotion",
      "memory_tier": "core | active | ambient",
      "memory_focus": "user_profile | user_current_arc | relationship | general",
      "summary": "自然中文短句，适合直接显示在记忆卡片上",
      "content": "更完整的中文说明，1到2句",
      "time": "recent past",
      "location": "chat",
      "people": ["..."],
      "event": "内部短标签",
      "relationships": ["..."] or [{"summary":"...","target":"...","change":"..."}],
      "items": ["..."],
      "emotion": "...",
      "importance": <number 1-10>,
      "surprise_score": <number 1-10>
    }
  ]
}`;

                recordMemoryDebug(character, 'input', extractionPrompt, {
                    context_type: 'memory_sweep',
                    batch_index: batchIndex + 1,
                    total_batches: totalBatches,
                    rolling_summary: rollingSummary || '',
                    source_time_text: batchTimeMeta.source_time_text || '',
                    source_started_at: batchTimeMeta.source_started_at,
                    source_ended_at: batchTimeMeta.source_ended_at,
                    source_message_count: batchTimeMeta.source_message_count
                });
                const { content: responseText, usage } = await callLLM({
                    endpoint: memoryConfig.endpoint,
                    key: memoryConfig.key,
                    model: memoryConfig.model,
                    messages: [
                        { role: 'system', content: 'You extract structured JSON memory objects from chat logs and keep a rolling summary across batches.' },
                        { role: 'user', content: extractionPrompt }
                    ],
                    maxTokens: 2200,
                    temperature: 0.2,
                    enableCache: true,
                    cacheDb: getDb(),
                    cacheType: 'memory_sweep',
                    cacheTtlMs: 30 * 24 * 60 * 60 * 1000,
                    cacheScope: `character:${character.id}`,
                    cacheCharacterId: character.id,
                    returnUsage: true
                });
                recordMemoryTokenUsage(character.id, 'memory_sweep', usage);
                recordMemoryDebug(character, 'output', responseText, {
                    context_type: 'memory_sweep',
                    batch_index: batchIndex + 1,
                    total_batches: totalBatches,
                    usage: usage || null,
                    model: memoryConfig.model,
                    source_time_text: batchTimeMeta.source_time_text || '',
                    source_started_at: batchTimeMeta.source_started_at,
                    source_ended_at: batchTimeMeta.source_ended_at,
                    source_message_count: batchTimeMeta.source_message_count
                });

                const startIdx = responseText.indexOf('{');
                const endIdx = responseText.lastIndexOf('}');
                if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
                    updateSweepStatus(character.id, {
                        sweep_last_error: `Batch ${batchIndex + 1}/${totalBatches} did not return a JSON object.`,
                        sweep_last_saved_count: 0
                    });
                    return 0;
                }

                let parsed = null;
                try {
                    parsed = JSON.parse(responseText.slice(startIdx, endIdx + 1));
                } catch (e) {
                    updateSweepStatus(character.id, {
                        sweep_last_error: `Batch ${batchIndex + 1}/${totalBatches} returned invalid JSON.`,
                        sweep_last_saved_count: 0
                    });
                    return 0;
                }

                rollingSummary = String(parsed?.rolling_summary || rollingSummary || '').trim();
                const batchMemories = Array.isArray(parsed?.memories) ? parsed.memories : [];
                for (const mem of batchMemories) {
                    parsedMemories.push({
                        ...mem,
                        source_started_at: batchTimeMeta.source_started_at,
                        source_ended_at: batchTimeMeta.source_ended_at,
                        source_time_text: batchTimeMeta.source_time_text,
                        source_message_count: batchTimeMeta.source_message_count,
                        source_message_ids_json: batchTimeMeta.source_message_ids_json
                    });
                }
            }

            let savedCount = 0;
            for (const mem of parsedMemories) {
                if (mem && mem.importance >= 3 && mem.event) {
                    mem.surprise_score = mem.surprise_score || 5;
                    await saveExtractedMemory(character.id, mem, null);
                    savedCount++;
                }
            }

            if (privateMsgs.length > 0) db.markMessagesSummarized(privateMsgs.map(m => m.id));
            if (groupMsgIds.length > 0) db.markGroupMessagesSummarized(groupMsgIds);

            updateSweepStatus(character.id, {
                sweep_last_error: savedCount > 0 ? '' : 'Sweep completed but no strong memories were extracted.',
                sweep_last_success_at: savedCount > 0 ? Date.now() : character.sweep_last_success_at || 0,
                sweep_last_saved_count: savedCount
            });
            console.log(`[Memory] Sweep completed for ${character.name}, saved ${savedCount} memories across ${totalBatches} batch(es).`);
            return savedCount;
        } catch (e) {
            updateSweepStatus(character.id, {
                sweep_last_error: e.message || 'Memory sweep failed.',
                sweep_last_saved_count: 0
            });
            console.error(`[Memory] Sweep failed for ${character.id}:`, e.message);
            return 0;
        } finally {
            activeSweepJobs.delete(sweepKey);
        }
    }

    async function saveExtractedMemory(characterId, memoryData, groupId = null) {
        try {
            const normalizedMemory = normalizeMemoryPayload(memoryData, { characterId });
            if (isRoutineCityMemory(normalizedMemory) && Number(normalizedMemory.importance || 0) <= 3) {
                console.log(`[Memory] Skipped routine city memory for ${characterId}: ${normalizedMemory.summary}`);
                return null;
            }
            const db = getDb();
            const retrievalWeight = computeMemoryRetrievalWeight(normalizedMemory);

            // 1. Generate embedding for the normalized memory text
            const textToEmbed = buildMemoryEmbeddingText(normalizedMemory);
            const embeddingArray = await getEmbedding(textToEmbed);

            // Convert JS array to Buffer for SQLite storage (optional, vectra uses its own file)
            const embeddingBuffer = Buffer.from(new Float32Array(embeddingArray).buffer);
            normalizedMemory.embedding = embeddingBuffer;

            const existing = normalizedMemory.dedupe_key && db.getMemoryByDedupeKey
                ? db.getMemoryByDedupeKey(characterId, normalizedMemory.dedupe_key)
                : null;

            let memoryId = null;
            if (existing) {
                db.updateMemory(existing.id, {
                    ...normalizedMemory,
                    group_id: groupId ?? existing.group_id ?? null,
                    retrieval_count: existing.retrieval_count || 0,
                    last_retrieved_at: existing.last_retrieved_at || null
                });
                memoryId = existing.id;
            } else {
                memoryId = db.addMemory(characterId, normalizedMemory, groupId);
            }

            if (await canUseQdrant()) {
                try {
                    await qdrant.upsertMemoryPoint(userId, {
                        id: String(memoryId),
                        vector: embeddingArray,
                        payload: {
                            memory_id: memoryId,
                            character_id: String(characterId),
                            group_id: groupId || '',
                            memory_type: normalizedMemory.memory_type || 'event',
                            memory_tier: normalizedMemory.memory_tier || 'ambient',
                            memory_focus: normalizedMemory.memory_focus || 'general',
                            importance: normalizedMemory.importance || 5,
                            created_at: existing?.created_at || Date.now(),
                            time: normalizedMemory.time || '',
                            is_archived: Number(normalizedMemory.is_archived || 0),
                            dedupe_key: normalizedMemory.dedupe_key || '',
                            retrieval_weight: retrievalWeight,
                            summary: normalizedMemory.summary || '',
                            content: normalizedMemory.content || '',
                            location: normalizedMemory.location || '',
                            source_started_at: Number(normalizedMemory.source_started_at || 0),
                            source_ended_at: Number(normalizedMemory.source_ended_at || 0),
                            source_time_text: normalizedMemory.source_time_text || '',
                            source_message_count: Number(normalizedMemory.source_message_count || 0)
                        }
                    });
                } catch (e) {
                    console.error(`[Memory] Qdrant save failed for ${characterId}:`, e.message);
                    qdrantAvailability = false;
                }
            }

            // 3. Save to Vectra store as a fallback / local cache
            const index = await getVectorIndex(userId, characterId);
            if (existing && typeof index.deleteItem === 'function') {
                try {
                    await index.deleteItem(String(memoryId));
                } catch (e) { }
            }
            await index.insertItem({
                id: String(memoryId),
                vector: embeddingArray,
                metadata: {
                    memory_id: memoryId,
                    surprise_score: normalizedMemory.surprise_score || 5,
                    memory_type: normalizedMemory.memory_type || 'event',
                    memory_tier: normalizedMemory.memory_tier || 'ambient',
                    memory_focus: normalizedMemory.memory_focus || 'general',
                    dedupe_key: normalizedMemory.dedupe_key || '',
                    retrieval_weight: retrievalWeight
                }
            });

            console.log(`[Memory] Stored memory for ${characterId}: ${normalizedMemory.summary} `);

            // Broadcast real-time update to connected clients
            if (globalWsClientsResolver) {
                const wsClients = globalWsClientsResolver(userId);
                if (wsClients) {
                    const eventPayload = JSON.stringify({ type: 'memory_update', characterId: characterId });
                    wsClients.forEach(c => {
                        if (c.readyState === 1) c.send(eventPayload);
                    });
                }
            }
        } catch (e) {
            console.error(`[Memory] Save failed for ${characterId}: `, e.message);
        }
    }

    const instance = {
        wipeIndex,
        rebuildIndex,
        searchMemories,
        extractMemoryFromContext,
        extractHiddenState,
        formatConversationDigestForPrompt,
        formatGroupConversationDigestForPrompt,
        updateConversationDigest,
        updateGroupConversationDigest,
        aggregateDailyMemories,
        sweepOverflowMemories,
        saveExtractedMemory
    };

    memoryCache.set(cacheKey, instance);
    return instance;
}
module.exports = { getMemory, clearMemoryCache, setWsClientsResolver };
