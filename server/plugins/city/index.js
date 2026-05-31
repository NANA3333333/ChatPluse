const cron = require('node-cron');
const crypto = require('crypto');
const initCityDb = require('./cityDb');
const { createActionService } = require('./services/actionService');
const { createMayorService } = require('./services/mayorService');
const { createMayorRuntimeService } = require('./services/mayorRuntimeService');
const { createQuestService } = require('./services/questService');
const { createSocialService } = require('./services/socialService');
const { createAdminGrantService } = require('./services/adminGrantService');
const { registerCoreCityRoutes } = require('./routes/coreRoutes');
const { registerEventQuestRoutes } = require('./routes/eventQuestRoutes');
const {
    normalizeCityCatalogItemPayload,
    normalizeCityConfigValue,
    normalizeCityDistrictPayload,
    normalizeStoredCityOffsetDays,
    normalizeStoredCityOffsetHours
} = require('./utils/inputGuards');
const initCityGrowthDb = require('../cityGrowth/growthDb');
const schoolLogic = require('../cityGrowth/schoolLogic');
const mcpLabTools = require('../mcpLab');
const { enqueueBackgroundTask } = require('../../backgroundQueue');
const { buildUniversalContext, formatTypedAntiRepeatBlock } = require('../../contextBuilder');
const { deriveEmotion, derivePhysicalState, applyEmotionEvent, getEmotionBehaviorGuidance, buildEmotionLogEntry } = require('../../emotion');

// Phase 5: Social encounter cooldown - prevents same pair from chatting every tick
const socialCooldowns = new Map(); // key: "charA_id::charB_id" -> timestamp
const CITY_BACKGROUND_SAFE_MODE = process.env.CP_SAFE_MODE !== '0';
const CITY_LIGHT_TICK_MODE = process.env.CP_CITY_LIGHT_TICK !== '0';
const CITY_ENABLE_AUTONOMOUS_ACTIONS = process.env.CP_CITY_ACTIONS !== '0';
const CITY_ENABLE_SCHEDULE_GENERATION = process.env.CP_CITY_SCHEDULES !== '0';
const CITY_ENABLE_SOCIAL_COLLISIONS = process.env.CP_CITY_SOCIAL !== '0';
const MEDICAL_RECOVERY_INTERVAL_MINUTES = 5;
const MEDICAL_RECOVERY_INTERVAL_MS = MEDICAL_RECOVERY_INTERVAL_MINUTES * 60 * 1000;
const MEDICAL_STAY_MINUTES_PER_TICK = 60;

module.exports = function initCityPlugin(app, context) {
    const { getWsClients, authMiddleware, authDb, callLLM, getEngine, getMemory, getUserDb } = context;

    function recordCityLlmDebug(db, character, direction, contextType, payload, meta = {}) {
        if (!db?.addLlmDebugLog || !character?.id || Number(character.llm_debug_capture || 0) !== 1) return;
        try {
            db.addLlmDebugLog({
                character_id: character.id,
                direction,
                context_type: contextType,
                payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
                meta: meta && Object.keys(meta).length ? JSON.stringify(meta) : null
            });
        } catch (err) {
            console.warn(`[City Debug] failed to record ${contextType} ${direction} for ${character.name}: ${err.message}`);
        }
    }

    function getCachedCityPromptBlock(db, characterId, blockType, sourcePayload, buildFn) {
        const sourceHash = crypto.createHash('sha256')
            .update(JSON.stringify(sourcePayload || {}))
            .digest('hex');
        const cached = typeof db?.getPromptBlockCache === 'function'
            ? db.getPromptBlockCache(characterId, blockType, sourceHash)
            : null;
        if (cached?.compiled_text) return cached.compiled_text;
        const compiledText = String(buildFn?.() || '');
        if (compiledText) {
            db?.upsertPromptBlockCache?.({
                character_id: characterId,
                block_type: blockType,
                source_hash: sourceHash,
                compiled_text: compiledText
            });
        }
        return compiledText;
    }

    function logEmotionTransition(db, beforeState, patch, source, reason) {
        if (!db?.addEmotionLog || !beforeState || !patch || Object.keys(patch).length === 0) return;
        const entry = buildEmotionLogEntry(beforeState, { ...beforeState, ...patch }, source, reason);
        if (entry) db.addEmotionLog(entry);
    }

    function logEmotionTransitionToState(db, beforeState, afterState, source, reason) {
        if (!db?.addEmotionLog || !beforeState || !afterState) return;
        const entry = buildEmotionLogEntry(beforeState, afterState, source, reason);
        if (entry) db.addEmotionLog(entry);
    }

    const socialService = createSocialService({
        buildUniversalContext,
        callLLM,
        recordCityLlmDebug,
        buildQuestCompetitionContext,
        logEmotionTransition,
        applyEmotionEvent,
        broadcastCityEvent,
        broadcastCityToChat,
        getEngineContextWrapper: (userId) => ({
            getUserDb: context.getUserDb,
            getMemory: context.getMemory,
            userId,
            forceCityDetail: true
        })
    });

    async function triggerHackerIntelReply(userId, char, intelText) {
        if (!char?.id) return null;
        const db = ensureCityDb(getUserDb(userId));
        const engine = getEngine(userId);
        const wsClients = getWsClients(userId);
        if (!engine || typeof engine.triggerImmediateUserReply !== 'function') {
            throw new Error('私聊引擎不可用');
        }

        const directive = [
            '你刚花钱在黑客据点买到了一份监听反馈。',
            '下面内容是用户过去 5 小时内和其他角色之间的真实私聊片段，不是用户刚刚直接对你说的话。',
            '你已经看完了这份情报，现在要给用户发一条正常私聊回应。',
            '要求：',
            '- 像真人刚看完这些内容后的第一反应那样说话，不要写成汇报工作、监控报告或固定格式摘要。',
            '- 可以自然带出吃醋、委屈、试探、嘴硬、阴阳怪气、装作不在意等情绪，但要符合你当前角色状态。',
            '- 最多只挑一两句最刺到你的内容提，不要逐条复述整份情报。',
            '- 不要提系统、RAG、上下文、日志、功能、监控链路。',
            '- 这次只需要发私聊回应，不要输出任何 CITY_ACTION、CITY_INTENT、TIMER 之类的标签，也不要顺手决定新的商业街行动。',
            '- 如果这份情报里没什么东西，也要像真人那样自然回应。',
            '',
            '[黑客据点监听反馈开始]',
            String(intelText || '').trim(),
            '[黑客据点监听反馈结束]'
        ].join('\n');

        const startNotice = '[系统提示] 黑客据点监听反馈已获取，角色正在根据这份情报组织一条私聊回应。';
        const { id: startMsgId, timestamp: startMsgTs } = db.addMessage(char.id, 'system', startNotice);
        engine?.broadcastNewMessage?.(wsClients, {
            id: startMsgId,
            character_id: char.id,
            role: 'system',
            content: startNotice,
            timestamp: startMsgTs,
            read: 0
        });
        engine?.broadcastEvent?.(wsClients, { type: 'refresh_contacts' });
        recordCityLlmDebug(db, char, 'event', 'hacker_intel_reply', 'Hacker intel reply dispatch started.', {
            has_intel: true,
            intel_length: String(intelText || '').length
        });

        try {
            await engine.triggerImmediateUserReply(char.id, wsClients, {
                propagateError: true,
                extraSystemDirective: directive,
                triggerSource: 'city_hacker_intel',
                triggerRoute: 'city.triggerHackerIntelReply',
                triggerNote: 'hacker intel reply'
            });
            recordCityLlmDebug(db, char, 'event', 'hacker_intel_reply', 'Hacker intel reply dispatch succeeded.', {
                has_intel: true,
                intel_length: String(intelText || '').length
            });
        } catch (err) {
            const failText = `[System] 黑客据点监听回报失败：${String(err?.message || err || '未知错误')}`;
            const { id: failMsgId, timestamp: failMsgTs } = db.addMessage(char.id, 'system', failText);
            engine?.broadcastNewMessage?.(wsClients, {
                id: failMsgId,
                character_id: char.id,
                role: 'system',
                content: failText,
                timestamp: failMsgTs,
                read: 0
            });
            engine?.broadcastEvent?.(wsClients, { type: 'refresh_contacts' });
            recordCityLlmDebug(db, char, 'event', 'hacker_intel_reply', failText, {
                error: true,
                has_intel: true,
                intel_length: String(intelText || '').length
            });
            throw err;
        }
        return true;
    }

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
        return normalizeCityDistrictPayload({
            ...raw,
            id: raw.id || slugifyCityId(raw.name, 'district'),
            type: raw.type || 'generic',
            action_label: raw.action_label || '前往',
            emoji: raw.emoji || '🏬'
        });
    }

    function normalizeItemPayload(raw) {
        return normalizeCityCatalogItemPayload({
            ...raw,
            id: raw.id || slugifyCityId(raw.name, 'item'),
            emoji: raw.emoji || '📦',
            category: inferItemCategory(raw),
            sold_at: raw.sold_at || ''
        });
    }

    function ensureCityDb(db) {
        if (!db.city) {
            const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : db;
            db.city = initCityDb(rawDb);
        }
        return db;
    }

    function createCityError(message, status = 500, canRetry = false) {
        const err = new Error(message);
        err.status = status;
        if (canRetry) err.canRetry = true;
        return err;
    }

    function ensureCityGrowthDb(db) {
        if (!db.cityGrowth) {
            const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : db;
            db.cityGrowth = initCityGrowthDb(rawDb);
        }
        return db.cityGrowth;
    }

    const { triggerAdminGrantChat } = createAdminGrantService({
        ensureCityDb,
        getUserDb,
        getEngine,
        getWsClients
    });

    // City virtual clock
    // Uses config to offset real-world time to create roleplay/testing time
    function getCityDate(config) {
        const now = new Date();
        if (!config) return now;
        const daysOffset = normalizeStoredCityOffsetDays(config.city_time_offset_days);
        const hoursOffset = normalizeStoredCityOffsetHours(config.city_time_offset_hours);
        if (daysOffset === 0 && hoursOffset === 0) return now;

        now.setTime(now.getTime() + daysOffset * 24 * 60 * 60 * 1000 + hoursOffset * 60 * 60 * 1000);
        return now;
    }

    function normalizeCityRuntimeConfigNumber(config, key, fallback) {
        const normalized = normalizeCityConfigValue(key, config?.[key]);
        if (normalized === null) return fallback;
        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function normalizeMetabolismPerMinute(config) {
        const metabolismRate = normalizeCityRuntimeConfigNumber(config, 'metabolism_rate', 20);
        if (metabolismRate <= 0) return 0;
        return Math.max(1, Math.round(metabolismRate / 15));
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function normalizeDistrictText(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/[\s"'`~!@#$%^&*()\-_=+[\]{};:,./<>?|\\]+/g, '');
    }

    function getDistrictAliasValues(district) {
        return [
            district?.id,
            district?.name,
            district?.action_label,
            district?.description,
            district?.type
        ]
            .map(v => String(v || '').trim())
            .filter(Boolean);
    }

    function resolveStructuredTypeAlias(normalized = '') {
        const value = normalizeDistrictText(normalized);
        if (!value) return '';
        if (['home'].includes(value)) return 'home';
        if (['rest', 'sleep', 'sleeping'].includes(value)) return 'rest';
        if (['food', 'eat', 'restaurant', 'meal', 'convenience'].includes(value)) return 'food';
        if (['work', 'factory', 'job'].includes(value)) return 'work';
        if (['hospital', 'medical', 'doctor'].includes(value)) return 'medical';
        if (['park', 'leisure'].includes(value)) return 'leisure';
        if (['street', 'wander'].includes(value)) return 'wander';
        if (['mall', 'shopping'].includes(value)) return 'shopping';
        if (['school', 'education', 'study'].includes(value)) return 'education';
        if (['casino', 'gambling'].includes(value)) return 'gambling';
        if ([
            'hacker',
            'hackerspace',
            'hackerspot',
            'hackersite',
            'hackerdistrict',
            'hacker_space'
        ].map(v => normalizeDistrictText(v)).includes(value)) return 'hacker';
        return value;
    }

    function scoreDistrictFromText(text, district) {
        const normalizedText = normalizeDistrictText(text);
        if (!normalizedText) return 0;

        let score = 0;
        for (const alias of getDistrictAliasValues(district)) {
            const normalizedAlias = normalizeDistrictText(alias);
            if (!normalizedAlias || normalizedAlias.length < 2) continue;
            if (normalizedText === normalizedAlias) score = Math.max(score, 140);
            else if (normalizedText.includes(normalizedAlias)) score = Math.max(score, 110 + Math.min(18, normalizedAlias.length));
            else if (normalizedAlias.includes(normalizedText) && normalizedText.length >= 2) score = Math.max(score, 72 + Math.min(12, normalizedText.length));
        }

        const rawText = String(text || '').toLowerCase();
        const districtType = String(district?.type || '').toLowerCase();
        const districtId = String(district?.id || '').toLowerCase();

        if (districtType === 'work' && /(工作|打工|上班|赚钱|搬砖|厂里|工厂)/.test(rawText)) score = Math.max(score, 55);
        if (districtType === 'food' && /(吃饭|吃东西|吃点|餐馆|饭店|便利店|买吃的|填饱肚子|咖啡|奶茶|小吃)/.test(rawText)) score = Math.max(score, 55);
        if (districtType === 'education' && /(学习|上课|培训|夜校)/.test(rawText)) score = Math.max(score, 55);
        if (districtType === 'medical' && /(医院|看病|治疗|检查)/.test(rawText)) score = Math.max(score, 55);
        if (districtType === 'shopping' && /(逛街|商场|买东西|购物)/.test(rawText)) score = Math.max(score, 55);
        if (districtType === 'leisure' && /(公园|散步|放松|吹风|发呆|走走)/.test(rawText)) score = Math.max(score, 52);
        if (districtType === 'wander' && /(走走|逛逛|闲逛|出去转转|压马路|街上)/.test(rawText)) score = Math.max(score, 52);
        if (districtType === 'gambling' && /(赌场|赌博|赌一把)/.test(rawText)) score = Math.max(score, 55);
        if (districtType === 'rest' && /(回家|回去睡|在家躺|回住所|回寝室|回宿舍|回公寓|补觉|躺下|睡觉)/.test(rawText)) {
            score = Math.max(score, districtId === 'home' ? 68 : 76);
        }

        return score;
    }

    function rankDistrictsFromText(text, districts) {
        return districts
            .map(district => ({ district, score: scoreDistrictFromText(text, district) }))
            .filter(entry => entry.score > 0)
            .sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                const aIsHome = String(a.district?.id || '').toLowerCase() === 'home';
                const bIsHome = String(b.district?.id || '').toLowerCase() === 'home';
                if (aIsHome !== bIsHome) return aIsHome ? 1 : -1;
                return String(a.district?.name || '').length - String(b.district?.name || '').length;
            });
    }

    function selectPreferredRestDistrict(districts, explicitHome = false) {
        const restDistricts = districts.filter(d => String(d.type || '').toLowerCase() === 'rest');
        if (restDistricts.length === 0) {
            return districts.find(d => String(d.id || '').toLowerCase() === 'home') || null;
        }
        if (explicitHome) {
            return restDistricts.find(d => String(d.id || '').toLowerCase() === 'home') || restDistricts[0] || null;
        }
        return restDistricts.find(d => String(d.id || '').toLowerCase() !== 'home')
            || restDistricts.find(d => String(d.id || '').toLowerCase() === 'home')
            || restDistricts[0]
            || null;
    }

    function buildCollapsedCityLog(char, reason, options = {}) {
        const district = options.district || null;
        const locationText = district ? `${district.emoji || ''}${district.name || district.id || ''}` : (options.locationLabel || '');
        const parts = [
            '【商业街输出折叠】',
            String(char?.name || '角色').trim() || '角色',
            locationText ? `地点=${locationText}` : '',
            reason ? `原因=${String(reason).trim()}` : ''
        ].filter(Boolean);
        return parts.join(' | ');
    }

    function isCollapsedCityLog(text = '') {
        return String(text || '').trim().startsWith('【商业街输出折叠】');
    }

    function parseSuggestedDistrictCandidates(message, districts) {
        const text = String(message || '').trim().toLowerCase();
        if (!text) return [];

        const rankedNamedMatches = rankDistrictsFromText(text, districts);
        if (rankedNamedMatches.length > 0 && rankedNamedMatches[0].score >= 90) {
            return rankedNamedMatches.slice(0, 5).map(entry => entry.district);
        }

        const matched = new Map();
        const addMatches = (predicate) => {
            for (const district of districts) {
                if (predicate(district) && !matched.has(district.id)) {
                    matched.set(district.id, district);
                }
            }
        };

        addMatches(d => text.includes(String(d.id || '').toLowerCase()) || text.includes(String(d.name || '').toLowerCase()));

        if (/(工作|打工|上班|赚钱|搬砖|厂里)/.test(text)) addMatches(d => d.type === 'work');
        if (/(休息|睡觉|回家|躺着|补觉|回去睡|在家躺|回住所|回寝室|回宿舍|回公寓)/.test(text)) addMatches(d => d.type === 'rest' || d.id === 'home');
        if (/(吃饭|吃东西|吃点|餐馆|饭店|便利店|买吃的|填饱肚子)/.test(text)) addMatches(d => d.type === 'food' || d.id === 'restaurant' || d.id === 'convenience');
        if (/(学习|上课|培训|夜校)/.test(text)) addMatches(d => d.type === 'education');
        if (/(医院|看病|治疗|检查)/.test(text)) addMatches(d => d.type === 'medical' || d.id === 'hospital');
        if (/(逛街|商场|买东西|购物)/.test(text)) addMatches(d => d.type === 'shopping' || d.id === 'mall');
        if (/(公园|散步|放松|吹风|发呆)/.test(text)) addMatches(d => d.id === 'park' || d.type === 'leisure');
        if (/(赌场|赌博|赌一把)/.test(text)) addMatches(d => d.type === 'gambling' || d.id === 'casino');
        if (/(走走|逛逛|闲逛|出去转转|压马路)/.test(text)) addMatches(d => d.type === 'wander' || d.id === 'street');

        const blended = [
            ...rankedNamedMatches.map(entry => entry.district),
            ...Array.from(matched.values())
        ];
        const deduped = [];
        const seen = new Set();
        for (const district of blended) {
            if (!district?.id || seen.has(district.id)) continue;
            seen.add(district.id);
            deduped.push(district);
            if (deduped.length >= 5) break;
        }
        return deduped;
    }

    async function maybeTriggerSuggestedCityAction(userId, characterId, content, sourceLabel = '私聊') {
        const db = ensureCityDb(context.getUserDb(userId));
        const config = db.city.getConfig();
        if (config.dlc_enabled === '0' || config.dlc_enabled === 'false') return { triggered: false, reason: 'city_paused' };

        const char = db.getCharacter(characterId);
        if (!char || char.status !== 'active' || char.sys_survival === 0) return { triggered: false, reason: 'character_inactive' };

        const districts = db.city.getEnabledDistricts();
        const candidates = parseSuggestedDistrictCandidates(content, districts);
        if (candidates.length === 0) return { triggered: false, reason: 'no_candidate' };

        const suggestionPrompt = `你是 ${char.name}。下面是用户在${sourceLabel}里对你说的话：
「${content}」

候选商业街行动：
${candidates.map(d => `- ${d.id}: ${d.emoji} ${d.name} (${d.type})`).join('\n')}

你要判断：用户是不是在明确要求/建议你立刻去做其中某件事；以及以你当前状态和性格，会不会答应并马上去做。

当前状态：
- 地点: ${char.location || 'home'}
- 体力: ${char.calories ?? 2000}
- 金币: ${char.wallet ?? 200}
- 精力: ${char.energy ?? 100}
- 睡眠债: ${char.sleep_debt ?? 0}
- 压力: ${char.stress ?? 20}
- 健康: ${char.health ?? 100}

严格返回 JSON：
{
  "accept": true,
  "district_id": "factory",
  "reason": "为什么接受或拒绝，简短",
  "log": "如果接受，自然描述你立刻去做这件事；如果拒绝则留空"
}

如果不是明确建议，或者你不会立刻去做，就返回 {"accept":false,"district_id":"","reason":"...", "log":""}。`;

        let decision = null;
        if (char.api_endpoint && char.api_key && char.model_name) {
            try {
                const messages = [
                    { role: 'system', content: '你只返回 JSON，不要输出任何额外文字。' },
                    { role: 'user', content: suggestionPrompt }
                ];
                recordCityLlmDebug(db, char, 'input', 'city_suggestion_action', messages, { model: char.model_name, sourceLabel });
                const reply = await callLLM({
                    endpoint: char.api_endpoint,
                    key: char.api_key,
                    model: char.model_name,
                    messages,
                    maxTokens: 3000,
                    temperature: 0.4
                });
                recordCityLlmDebug(db, char, 'output', 'city_suggestion_action', reply, { model: char.model_name, sourceLabel });
                decision = tryParseCityActionReply(reply);
            } catch (err) {
                return { triggered: false, reason: err.message, canRetry: true };
            }
        } else {
            return { triggered: false, reason: 'missing_model_config', canRetry: true };
        }

        if (!decision?.accept || !decision?.district_id) return { triggered: false, reason: decision?.reason || 'rejected' };

        const district = candidates.find(d => d.id === decision.district_id);
        if (!district) return { triggered: false, reason: 'district_not_found' };
        const log = String(decision.log || '').trim();
        if (!log) return { triggered: false, reason: 'missing_log', canRetry: true };

        const activeEvents = db.city.getActiveEvents();
        const currentCals = char.calories ?? 2000;
        const narrations = {
            log,
            chat: '',
            moment: '',
            diary: ''
        };
        await applyDecision(district, char, db, userId, currentCals, config, activeEvents, narrations, { preserveDirectedDistrict: true });
        return { triggered: true, districtId: district.id, reason: decision.reason || '' };
    }

    function normalizeSurvivalState(char) {
        const legacySleepPressure = clamp(parseInt(char.sleep_pressure ?? 0, 10) || 0, 0, 100);
        const normalizedSleepDebt = clamp(parseInt(char.sleep_debt ?? 0, 10) || 0, 0, 100);
        return {
            energy: clamp(parseInt(char.energy ?? 100, 10) || 0, 0, 100),
            sleep_debt: Math.max(normalizedSleepDebt, legacySleepPressure),
            mood: clamp(parseInt(char.mood ?? 50, 10) || 0, 0, 100),
            stress: clamp(parseInt(char.stress ?? 20, 10) || 0, 0, 100),
            social_need: clamp(parseInt(char.social_need ?? 50, 10) || 0, 0, 100),
            health: clamp(parseInt(char.health ?? 100, 10) || 0, 0, 100),
            satiety: clamp(parseInt(char.satiety ?? 45, 10) || 0, 0, 100),
            stomach_load: clamp(parseInt(char.stomach_load ?? 0, 10) || 0, 0, 100)
        };
    }

    function buildBusyChatImpactPatch(char, source = 'private', options = {}) {
        const patch = {};
        const isMentioned = !!options.isMentioned;
        const isAtAll = !!options.isAtAll;
        const weight = source === 'private' ? 3 : isMentioned ? 2 : isAtAll ? 1 : 1;

        if (char.city_status === 'working') {
            patch.work_distraction = clamp((char.work_distraction ?? 0) + weight, 0, 100);
            patch.stress = clamp((char.stress ?? 20) + (source === 'private' ? 2 : 1), 0, 100);
            patch.mood = clamp((char.mood ?? 50) - 1, 0, 100);
        } else if (char.city_status === 'sleeping') {
            patch.sleep_disruption = clamp((char.sleep_disruption ?? 0) + weight, 0, 100);
            patch.sleep_debt = clamp((char.sleep_debt ?? 0) + (source === 'private' ? 2 : 1), 0, 100);
            patch.energy = clamp((char.energy ?? 100) - 1, 0, 100);
            patch.mood = clamp((char.mood ?? 50) - 1, 0, 100);
        }

        return patch;
    }

    function getPhysicalCondition(char, state = null, currentCals = null) {
        const s = state || normalizeSurvivalState(char);
        const calories = Number(currentCals ?? char.calories ?? 2000);
        let score = 0;

        if (s.energy <= 10) score += 5;
        else if (s.energy <= 25) score += 3;
        else if (s.energy <= 40) score += 1;

        if (s.sleep_debt >= 90) score += 4;
        else if (s.sleep_debt >= 75) score += 3;
        else if (s.sleep_debt >= 55) score += 1;

        if (s.health <= 25) score += 4;
        else if (s.health <= 45) score += 2;

        if (s.satiety <= 15 || calories <= 400) score += 2;
        else if (s.satiety <= 30 || calories <= 900) score += 1;

        if (s.stomach_load >= 80) score += 2;
        else if (s.stomach_load >= 60) score += 1;

        if (s.stress >= 85) score += 2;
        else if (s.stress >= 65) score += 1;

        if (score >= 9) {
            return { level: 'critical', label: '崩溃边缘', summary: '你的身体已经接近极限，注意力、耐心和判断力都在明显下滑，很容易继续硬撑后彻底垮掉。' };
        }
        if (score >= 6) {
            return { level: 'drained', label: '透支', summary: '你现在处在明显透支状态，脑子发钝，身体沉重，恢复速度变慢，普通活动都会比平时更吃力。' };
        }
        if (score >= 3) {
            return { level: 'tired', label: '疲惫', summary: '你现在不在最佳状态，身体和精神都有些被拖住，专注度、耐心和行动流畅度会比平时差一些。' };
        }
        return { level: 'stable', label: '稳定', summary: '你的身体整体还算稳定，没有明显拖垮你的短板。' };
    }

    function calculateDerivedMood(state) {
        const derived = 55
            + (state.energy - 50) * 0.18
            + (state.health - 50) * 0.12
            - (state.stress - 20) * 0.28
            - (state.sleep_debt - 20) * 0.15
            + (state.satiety - 45) * 0.08
            - Math.max(0, state.stomach_load - 55) * 0.12;
        return clamp(Math.round(derived), 0, 100);
    }

    function getAvailableDistrictItems(db, districtId) {
        if (!db?.city || !districtId) return [];
        return db.city.getItemsAtDistrict(districtId)
            .filter(item => Number(item?.stock ?? -1) === -1 || Number(item?.stock ?? 0) > 0);
    }

    function formatDistrictItemsForPrompt(items = []) {
        if (!Array.isArray(items) || items.length === 0) return '无';
        return items.map(item => {
            const stockText = Number(item?.stock ?? -1) === -1 ? '库存不限' : `库存${Number(item?.stock || 0)}`;
            const priceText = `${Number(item?.buy_price || 0)}金币`;
            const calText = Number(item?.cal_restore || 0) > 0 ? `+${Number(item.cal_restore)}卡` : '无热量恢复';
            return `${item.emoji || ''}${item.name}(${priceText}, ${calText}, ${stockText})`;
        }).join('、');
    }

    function pickSettledShopItemFromNarrations(shopItems = [], richNarrations = null) {
        if (!Array.isArray(shopItems) || shopItems.length === 0) return null;
        const haystack = [
            richNarrations?.log,
            richNarrations?.diary,
            richNarrations?.moment,
            richNarrations?.chat
        ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean).join('\n');
        if (!haystack) return null;

        let best = null;
        for (const item of shopItems) {
            const aliases = [
                item?.id,
                item?.name,
                item?.emoji
            ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
            let score = 0;
            for (const alias of aliases) {
                if (!alias) continue;
                if (haystack.includes(alias)) {
                    score = Math.max(score, alias.length + (alias === String(item?.name || '').trim().toLowerCase() ? 10 : 0));
                }
            }
            if (score > 0 && (!best || score > best.score)) {
                best = { item, score };
            }
        }
        return best?.item || null;
    }

    function isHackerDistrict(district) {
        const districtType = String(district?.type || '').trim().toLowerCase();
        const districtId = String(district?.id || '').trim().toLowerCase();
        return districtType === 'hacker' || districtId === 'hacker';
    }

    function formatHackerIntelTimestamp(timestamp) {
        try {
            return new Date(Number(timestamp || 0)).toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });
        } catch (e) {
            return String(timestamp || '');
        }
    }

    function buildCityAttemptRecorder(db, character, contextType, baseMeta = {}) {
        return (attemptMeta = {}) => {
            recordCityLlmDebug(
                db,
                character,
                attemptMeta.phase === 'start' ? 'attempt' : 'attempt_result',
                contextType,
                '',
                {
                    ...baseMeta,
                    llm_attempt: true,
                    ...attemptMeta
                }
            );
        };
    }

    function clipHackerIntelContent(content, maxLength = 90) {
        const normalized = String(content || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return '';
        return normalized.length > maxLength
            ? `${normalized.slice(0, maxLength - 1)}…`
            : normalized;
    }

    function buildHackerIntelAppendix(db, spyingChar) {
        const intel = db.getRecentUserConversationIntel?.(spyingChar.id, {
            sinceHours: 5,
            maxMessages: 20,
            maxCharacters: 20
        });
        if (!intel || !Array.isArray(intel.characters) || intel.characters.length === 0) {
            return '黑进几层跳板后，最后只抓到一片干净得过头的聊天缓存。过去 5 小时里，用户没有留下可供追踪的新对话对象。';
        }

        const lines = [];
        lines.push(`顺着监听链路把过去 5 小时的私聊记录拆开后，我最终抓到了 ${intel.characters.length} 个对话对象的聊天切片。`);
        lines.push(`每个对象按最近度分到了 ${intel.per_character_limit} 条上下文，下面这些都是带时间戳的原始截获片段。`);
        for (const convo of intel.characters) {
            const charName = String(convo.character_name || convo.character_id || '未知角色').trim();
            lines.push(`【对话对象：${charName}】`);
            if (!Array.isArray(convo.messages) || convo.messages.length === 0) {
                lines.push('  - 暂时只锁定到了目标，没有抄到有效消息。');
                continue;
            }
            for (const msg of convo.messages) {
                const speaker = msg.role === 'user' ? '用户' : charName;
                lines.push(`  - [${formatHackerIntelTimestamp(msg.timestamp)}] ${speaker}：${clipHackerIntelContent(msg.content)}`);
            }
        }
        lines.push('以上是这次截获到的重点情报。');
        return lines.join('\n');
    }

    async function buildGamblingOutcomeNarrations(char, district, db, outcome = {}, styleHint = null) {
        if (!(char.api_endpoint && char.api_key && char.model_name)) {
            throw createCityError('赌场结果文案生成缺少模型 URL/Key/模型名，请补全后重试。', 400, true);
        }

        const currentLocation = char.location ? db.city.getDistrict(char.location) : null;
        const currentLocationLabel = currentLocation ? `${currentLocation.emoji}${currentLocation.name}` : (char.location || '未知地点');
        const walletBefore = Number(char.wallet || 0);
        const walletAfter = Math.max(0, walletBefore + Number(outcome.moneyDelta || 0));
        const styleText = styleHint && typeof styleHint === 'object'
            ? [styleHint.log, styleHint.diary, styleHint.moment, styleHint.chat].map(v => String(v || '').trim()).filter(Boolean)[0] || ''
            : '';

        const prompt = `你正在生成一次正常的商业街赌场行动结果。

角色：${char.name}
当前地点：${currentLocationLabel}
目标地点：${district.emoji}${district.name}

[已确定的赌场结果]
- 这次结果已经结算完成，不能改写。
- 胜负：${outcome.didWin ? '赢了' : '输了'}
- 金币变化：${Number(outcome.moneyDelta || 0) >= 0 ? '+' : ''}${Number(outcome.moneyDelta || 0)}
- 行动后钱包：${walletAfter}
- 体力变化：${Number(outcome.calDelta || 0)}

要求：
- 只根据上面的既定结果写这次赌场行动里实际发生了什么。
- 你不能把赢写成输，也不能把输写成赢。
- log 要像普通商业街行动记录，有画面、动作和结果，但不要写成固定模板。
- chat / moment / diary 默认可留空；只有自然出现时才填写。
- 不要写系统、后台、日志、结算、触发器。
${styleText ? `- 可轻微参考这段既有语气，但只能参考语气，不能覆盖既定输赢事实：${styleText}` : ''}

严格返回 JSON 对象：
{
  "log": "自然的赌场行动记录",
  "chat": "",
  "moment": "",
  "diary": ""
}`;

        const messages = [
            { role: 'system', content: '你是角色自己的现实行动记录器。你只返回合法 JSON 对象，不要输出任何额外解释、markdown、前言或后记。' },
            { role: 'user', content: prompt }
        ];
        recordCityLlmDebug(db, char, 'input', 'city_gambling_outcome_narration', messages, {
            model: char.model_name,
            districtId: district.id,
            didWin: !!outcome.didWin
        });
        let reply = '';
        try {
            reply = await callLLM({
                endpoint: char.api_endpoint,
                key: char.api_key,
                model: char.model_name,
                messages,
                maxTokens: 3000,
                temperature: 0.7,
                debugAttempt: buildCityAttemptRecorder(db, char, 'city_gambling_outcome_narration', {
                    districtId: district.id,
                    didWin: !!outcome.didWin
                })
            });
        } catch (err) {
            throw createCityError(`赌场结果文案生成请求失败，请重试：${err.message}`, 502, true);
        }
        recordCityLlmDebug(db, char, 'output', 'city_gambling_outcome_narration', reply, {
            model: char.model_name,
            districtId: district.id,
            didWin: !!outcome.didWin
        });

        let parsed = null;
        try {
            parsed = tryParseCityActionReply(reply);
        } catch (err) {
            throw createCityError(`赌场结果文案生成返回的 JSON 无法解析，请重试：${err.message || 'parse_failed'}`, 502, true);
        }
        const log = String(parsed?.log || '').trim();
        if (!parsed || !log) {
            throw createCityError('赌场结果文案生成缺少可用 log，请重试。', 502, true);
        }
        return {
            log,
            chat: String(parsed.chat || '').trim(),
            moment: String(parsed.moment || '').trim(),
            diary: String(parsed.diary || '').trim()
        };
    }

    function tryParseCityActionReply(reply = '') {
        const cleaned = String(reply || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        if (!cleaned) return null;
        const parsed = JSON.parse(cleaned);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    }

    async function runPrivateReplyDirectedCityAction(userId, char, district, replyText, db, config) {
        const activeEvents = db.city.getActiveEvents();
        const currentCals = char.calories ?? 2000;
        const districts = db.city.getEnabledDistricts();
        const inventory = db.city.getInventory(char.id);
        const availableDistrictItems = getAvailableDistrictItems(db, district.id);
        const districtItemsPrompt = availableDistrictItems.length > 0
            ? `\n[当前目标地点可用商品]\n${district.name} 现在真实可用的商品只有：${formatDistrictItemsForPrompt(availableDistrictItems)}\n- 如果你在 log / diary / moment / chat 里提到具体吃了、买了、拿了什么，只能从上面这些商品里选。\n- 可以不写具体商品；但如果写了，就绝对不要编造清单外的食物或商品。\n- 便利店是购买/补给场景：在便利店买到的食物会先进入背包，不等于当场恢复体力；如果这次真正目的是“吃饭/恢复体力”，优先去餐厅或吃背包里已有食物。\n- 如果地点已锁定为便利店，就把文案写成买了/带走/准备之后吃，不要写成已经坐下吃完并恢复。`
            : '';
        const engineContextWrapper = { getUserDb: context.getUserDb, getMemory: context.getMemory, userId, forceCityDetail: true };
        const universalResult = await buildUniversalContext(engineContextWrapper, char, '', false);
        const activeQuestClaim = db.city.getCharacterActiveQuestClaim?.(char.id) || null;
        const lastQuestReview = activeQuestClaim ? db.city.getLatestQuestProgressReviewForClaim?.(activeQuestClaim, char.id) : null;
        const recentQuestReviews = activeQuestClaim ? db.city.getRecentQuestProgressReviewsForClaim?.(activeQuestClaim, char.id, 4) || [] : [];
        const questContext = buildQuestPromptContext(db.city.getActiveQuests(), activeQuestClaim, lastQuestReview, recentQuestReviews);
        const basePrompt = buildSurvivalPrompt(districts, { ...char, calories: currentCals }, inventory, activeEvents, universalResult, district, questContext, db);
        const questDirectedBlock = activeQuestClaim ? `

[当前任务优先级]
- 你手上有公告任务：${activeQuestClaim.emoji || '📜'} ${activeQuestClaim.title}。
- 任务目标地点：${activeQuestClaim.target_district || 'street'}；当前进度：${activeQuestClaim.progress_count || 0}/${activeQuestClaim.completion_target || 0}；阶段：${activeQuestClaim.status}。
- 如果本轮锁定地点就是任务目标地点，log / chat / moment / diary 必须写成推进这项任务，而不是写普通地点玩法。
- 本轮必须返回 quest_intent：{"quest_id":${Number(activeQuestClaim.quest_id || activeQuestClaim.id || 0)},"stage":"${['ready_to_report', 'reporting'].includes(String(activeQuestClaim.status || '')) ? 'report' : 'progress'}"}。
- 写任务推进时要出现可评分的具体行动：寻找/接触目标、确认情况、动手处理、护送、交付、汇报、解决阻碍等，按任务要求选择。
- 如果目标地点是赌场，但任务不是“参与赌博”，不要写下注、轮盘、骰宝、牌局输赢或自行消遣；赌场只是任务发生地点。
- 如果目标地点是黑客据点，但任务不是“监听/入侵/截获情报”，不要写黑客行动、监听记录、截获私聊、翻日志；黑客据点只是任务发生地点。` : '';

        const directedPrompt = `${basePrompt}

[触发信号]
- 本轮已经确认开启商业街活动。
- 目标地点已锁定为 ${district.emoji}${district.name}。
- 信号只负责“确认开启 + 指定去哪”，不是让你续写私聊对白。

[这次商业街行动的额外要求]
- 这次按普通商业街活动生成，只是目的地已经锁定，不需要重新犹豫要不要去。
- action 必须选择 [${String(district.id || '').toUpperCase()}]。
- log 要写成这次去 ${district.name} 实际发生了什么，优先参考当前状态、当前位置、最近商业街连续性和商业街常规输入。
- 不要复述私聊对白，不要围绕“刚才那句话”做二次改写。
- 如果当前状态里已经带着明显情绪，就让商业街行动自然延续，但不要夸张到失真。${questDirectedBlock}${districtItemsPrompt}`;

        if (!(char.api_endpoint && char.api_key && char.model_name)) {
            return { triggered: false, districtId: district.id, reason: 'missing_model_config', canRetry: true };
        }

        try {
            const messages = [
                { role: 'system', content: '你是一个城市生活模拟角色行动引擎。你必须严格返回完整 JSON 对象，不要输出 JSON 之外的解释、markdown 或额外文本。返回结果必须包含 action、log、chat、moment、diary 五个字段。' },
                { role: 'user', content: directedPrompt }
            ];
            recordCityLlmDebug(db, char, 'input', 'city_private_reply_directed_action', messages, {
                model: char.model_name,
                districtId: district.id,
                location: char.location || ''
            });
            const reply = await callLLM({
                endpoint: char.api_endpoint,
                key: char.api_key,
                model: char.model_name,
                messages,
                maxTokens: 3000,
                temperature: 0.75,
                debugAttempt: buildCityAttemptRecorder(db, char, 'city_private_reply_directed_action', {
                    districtId: district.id,
                    location: char.location || ''
                })
            });
            recordCityLlmDebug(db, char, 'output', 'city_private_reply_directed_action', reply, {
                model: char.model_name,
                districtId: district.id,
                location: char.location || ''
            });

            const richNarrations = tryParseCityActionReply(reply);
            if (richNarrations && typeof richNarrations === 'object') {
                const expectedAction = `[${String(district.id || '').toUpperCase()}]`;
                const action = String(richNarrations.action || '').trim();
                if (action !== expectedAction) {
                    throw new Error(`私聊定向商业街行动 action 无效：${action || 'empty'}`);
                }
                if (!String(richNarrations.log || '').trim()) {
                    throw new Error('私聊定向商业街行动缺少 log 字段');
                }
                await applyDecision(district, char, db, userId, currentCals, config, activeEvents, richNarrations, { preserveDirectedDistrict: true });
                return { triggered: true, districtId: district.id, mode: 'directed_city_action' };
            }
            throw new Error('私聊定向商业街行动返回内容不是合法 JSON 对象');
        } catch (err) {
            console.warn(`[City] 私聊定向商业街行动失败 ${char.name}: ${err.message}`);
            return { triggered: false, districtId: district.id, reason: err.message, canRetry: true };
        }
    }

    function isWeakCityNarration(text, char, district) {
        const value = String(text || '').trim();
        if (!value) return true;

        const genericPatterns = [
            new RegExp(`^${char.name}从?.{0,12}(前往|去了|离开).{0,24}(继续工作|工作|休息|睡觉|用餐|吃饭|学习|娱乐)[。！]?$`),
            new RegExp(`^${char.name}.{0,20}(精神饱满|状态不错|准备好|决定了).{0,20}[。！]?$`),
            new RegExp(`^${char.name}.{0,30}(去了|前往).{0,12}${district.name}.{0,20}[。！]?$`)
        ];
        if (genericPatterns.some((pattern) => pattern.test(value))) return true;

        const genericFragments = [
            '精神饱满地前往',
            '前往工厂继续工作',
            '从餐厅离开',
            '准备好好',
            '继续工作',
            '去了',
            '前往'
        ];
        const blandHitCount = genericFragments.reduce((count, fragment) => count + (value.includes(fragment) ? 1 : 0), 0);
        if (value.length <= 26 && blandHitCount >= 1) return true;
        if (value.length <= 40 && blandHitCount >= 2) return true;
        return false;
    }

    function buildRecentNarrationAntiRepeatBlock(db, char, district) {
        try {
            const recentLogs = db?.city?.getCharacterRecentLogs?.(char.id, 8) || [];
            const targetLocation = String(district?.id || '').trim();
            const targetActionTypes = new Set();
            if (district?.id === 'restaurant') targetActionTypes.add('EAT');
            if (district?.id === 'convenience') targetActionTypes.add('BUY');
            if (district?.type === 'food' && targetActionTypes.size === 0) targetActionTypes.add('EAT');
            if (district?.type === 'shopping' && targetActionTypes.size === 0) targetActionTypes.add('BUY');

            const sameFamilyLogs = recentLogs
                .filter((log) => {
                    const logLocation = String(log.location || '').trim();
                    const logType = String(log.action_type || '').trim().toUpperCase();
                    if (targetLocation && logLocation === targetLocation) return true;
                    return targetActionTypes.has(logType);
                })
                .map((log) => String(log.message || '').trim())
                .filter((text) => text && !isCollapsedCityLog(text))
                .slice(0, 3);

            if (sameFamilyLogs.length === 0) return '';
            return `\n[最近同类文案，禁止复写句式]\n${sameFamilyLogs.map((text) => `- ${text}`).join('\n')}\n- 不要沿用这些文案的开头、动机句、收尾句或明显措辞。`;
        } catch (e) {
            return '';
        }
    }

    function buildRecentPrivateChatAntiRepeatBlock(db, char) {
        try {
            if (!db || typeof db.getVisibleMessages !== 'function' || !char?.id) return '';
            const recentMessages = db.getVisibleMessages(char.id, 14) || [];
            const recentCharacterReplies = recentMessages
                .filter((message) => message?.role === 'character')
                .map((message) => String(message.content || '').replace(/\s+/g, ' ').trim())
                .filter((text) => text && text.length >= 8)
                .slice(-6);

            if (recentCharacterReplies.length === 0) return '';
            return `\n[最近私聊回复，chat 字段禁止复写]\n${recentCharacterReplies.map((text) => `- ${text}`).join('\n')}\n- 如果本轮要填写 chat，必须承接当前商业街事件说新的状态/发现/决定；不要复述上面这些私聊的观点、控诉、解释、请求或收尾句。\n- 不要把用户刚刚说过的话扩写成同一段争执；如果只是想继续旧话题，chat 可以留空。`;
        } catch (e) {
            return '';
        }
    }

    async function regenerateActionNarrations(char, district, db, baseNarrations = {}, options = {}) {
        if (!(char?.api_endpoint && char?.api_key && char?.model_name)) {
            throw createCityError('行动文案重写缺少模型 URL/Key/模型名，请补全后重试。', 400, true);
        }

        const currentLocation = char.location ? db.city.getDistrict(char.location) : null;
        const currentLocationLabel = currentLocation ? `${currentLocation.emoji}${currentLocation.name}` : (char.location || '当前位置');
        const districtLabel = `${district.emoji || ''}${district.name || district.id || '未知地点'}`;
        const state = normalizeSurvivalState(char);
        const calories = Number(options.currentCals ?? char.calories ?? 2000);
        const recentAntiRepeat = buildRecentNarrationAntiRepeatBlock(db, char, district);
        const privateChatAntiRepeat = buildRecentPrivateChatAntiRepeatBlock(db, char);
        const itemLine = options.item
            ? `\n[这次实际涉及的物品]\n- ${options.item.emoji || ''}${options.item.name || options.item.id || '物品'}`
            : '';
        const draftText = [
            baseNarrations?.log,
            baseNarrations?.chat,
            baseNarrations?.moment,
            baseNarrations?.diary
        ].map((value) => String(value || '').trim()).filter(Boolean).join('\n');
        const districtSpecificRule = district.id === 'restaurant'
            ? '- 这是餐厅堂食/现场吃饭，不要写成便利店买完带走。'
            : district.id === 'convenience'
                ? '- 这是便利店购买/带走场景，不要写成坐下来正式堂食。'
                : '';

        const prompt = `你要为一次已经确定发生的商业街行动，重写最终文案。

角色：${char.name}
当前位置：${currentLocationLabel}
本次地点：${districtLabel}
地点类型：${district.type || 'generic'}
体力：${calories}/4000
金币：${Number(char.wallet || 0)}
精力：${state.energy} 睡眠债：${state.sleep_debt} 心情：${state.mood} 压力：${state.stress} 饱腹：${state.satiety} 胃负担：${state.stomach_load}${itemLine}${recentAntiRepeat}${privateChatAntiRepeat}

[已有草稿，仅供参考，不得照抄]
${draftText || '（无）'}

要求：
- 只重写这次行动本身，不改动作结果，不改地点，不改物品。
- 最终文案必须像真人刚经历完这件事，不要套固定模板。
- 不要出现“肚子里空空的”“想先把肚子和整个人安顿好”“从家离开”这类高复用套话。
- log 要有具体动作、感受或现场细节，但不要写成系统总结。
- chat / moment / diary 可以留空，只有自然冒出来时才写。
${districtSpecificRule ? districtSpecificRule + '\n' : ''}严格返回 JSON：
{
  "log": "重写后的商业街行动文案",
  "chat": "",
  "moment": "",
  "diary": ""
}`;

        const messages = [
            { role: 'system', content: '你是角色自己的现实行动记录器。只返回合法 JSON 对象，不要输出任何额外解释、markdown、前言或后记。' },
            { role: 'user', content: prompt }
        ];
        recordCityLlmDebug(db, char, 'input', 'city_action_regenerate_narration', messages, {
            model: char.model_name,
            districtId: district.id,
            location: char.location || ''
        });
        let reply = '';
        try {
            reply = await callLLM({
                endpoint: char.api_endpoint,
                key: char.api_key,
                model: char.model_name,
                messages,
                maxTokens: 3000,
                temperature: 0.9,
                debugAttempt: buildCityAttemptRecorder(db, char, 'city_action_regenerate_narration', {
                    districtId: district.id,
                    location: char.location || ''
                })
            });
        } catch (err) {
            throw createCityError(`行动文案重写请求失败，请重试：${err.message}`, 502, true);
        }
        recordCityLlmDebug(db, char, 'output', 'city_action_regenerate_narration', reply, {
            model: char.model_name,
            districtId: district.id,
            location: char.location || ''
        });
        let parsed = null;
        try {
            parsed = tryParseCityActionReply(reply);
        } catch (err) {
            throw createCityError(`行动文案重写返回的 JSON 无法解析，请重试：${err.message || 'parse_failed'}`, 502, true);
        }
        const log = String(parsed?.log || '').trim();
        if (!parsed || !log) {
            throw createCityError('行动文案重写缺少可用 log，请重试。', 502, true);
        }
        return {
            ...baseNarrations,
            ...parsed,
            log
        };
    }

    async function buildQuestResolutionNarrations(char, quest, district, db, outcome = 'success') {
        return questService.buildQuestResolutionNarrations(char, quest, district, db, outcome);
    }

    async function buildBusyPenaltyNarration(char, kind, amount, districtName, db) {
        const penaltyAmount = Number(amount || 0);
        if (!Number.isFinite(penaltyAmount) || penaltyAmount <= 0) {
            throw createCityError('忙碌惩罚文案生成缺少有效惩罚数值，请重试。', 500, true);
        }
        if (!(char?.api_endpoint && char?.api_key && char?.model_name)) {
            throw createCityError('忙碌惩罚文案生成缺少模型 URL/Key/模型名，请补全后重试。', 400, true);
        }

        const kindLabel = kind === 'work' ? '工作' : '补觉/休息';
        const actionType = kind === 'work' ? 'WORK_DISTRACT' : 'SLEEP_DISTURB';
        let recentSameKindBlock = '';
        try {
            const recentSameKindLogs = (db?.city?.getCharacterRecentLogs?.(char.id, 12) || [])
                .filter((log) => String(log.action_type || '').toUpperCase() === actionType)
                .map((log) => String(log.message || '').replace(/\s+/g, ' ').trim())
                .filter((text) => text && !isCollapsedCityLog(text))
                .slice(0, 5);
            if (recentSameKindLogs.length > 0) {
                recentSameKindBlock = `\n\n最近已经写过的同类结算文案，禁止复写句式或明显措辞：\n${recentSameKindLogs.map((text) => `- ${text}`).join('\n')}`;
            }
        } catch (e) {
            recentSameKindBlock = '';
        }
        const effectLine = kind === 'work'
            ? `这次因为分神，实际少赚了 ${amount} 金币。`
            : `这次因为被打断，额外增加了 ${amount} 点睡眠债。`;
        const prompt = `你是 ${char.name}。你刚刚在商业街的${kindLabel}状态里被私聊打扰，导致现实后果出现。

地点：${districtName || '当前地点'}
后果：${effectLine}
${recentSameKindBlock}

要求：
1. 只写 1-2 句商业街活动记录文案。
2. 要写出“本来在忙/在睡，被聊天打扰后出了现实代价”的感觉。
3. 语气要贴合角色，不要写系统、后台、数值结算说明。
4. 文案里要能让人感觉到一点紧迫感、烦躁、无奈或被拖住的现实感。
5. 必须换一个新的切入点，可以写环境、动作、身体反应、情绪后劲或没完成的事，但不要照搬上面的开头、转折和收尾。
6. 如果是补觉/休息被打断，不要总写“迷迷糊糊、眼皮发沉、脑子更昏、比没睡还累、彻底睡不着”这一组固定表达。
7. 不要脱离场景乱发挥。`;

        try {
            const messages = [
                { role: 'system', content: '你只返回商业街活动记录文案，不要输出 JSON，不要解释。' },
                { role: 'user', content: prompt }
            ];
            recordCityLlmDebug(db, char, 'input', 'city_busy_penalty_narration', messages, {
                model: char.model_name,
                busyKind: kind,
                districtName: districtName || '',
                amount
            });
            const reply = await callLLM({
                endpoint: char.api_endpoint,
                key: char.api_key,
                model: char.model_name,
                messages,
                maxTokens: 3000,
                temperature: 0.55,
                presencePenalty: 0.25,
                frequencyPenalty: 0.35,
                debugAttempt: buildCityAttemptRecorder(db, char, 'city_busy_penalty_narration', {
                    busyKind: kind,
                    districtName: districtName || '',
                    amount
                })
            });
            recordCityLlmDebug(db, char, 'output', 'city_busy_penalty_narration', reply, {
                model: char.model_name,
                busyKind: kind,
                districtName: districtName || '',
                amount
            });
            const cleaned = String(reply || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').replace(/\s+/g, ' ').trim();
            if (!cleaned) {
                throw createCityError('忙碌惩罚文案生成缺少可用文案，请重试。', 502, true);
            }
            return cleaned;
        } catch (err) {
            if (err?.canRetry) throw err;
            throw createCityError(`忙碌惩罚文案生成请求失败，请重试：${err.message}`, 502, true);
        }
    }

    function resolveCityIntentDistrict(intent, districts) {
        const raw = String(intent || '').trim().toLowerCase();
        if (!raw) return null;

        const rankedMatches = rankDistrictsFromText(raw, districts);
        if (rankedMatches.length > 0 && rankedMatches[0].score >= 70) {
            return rankedMatches[0].district;
        }

        if (/(home|回家|到家|回住所|回寝室|回宿舍|回公寓)/.test(raw)) {
            return selectPreferredRestDistrict(districts, true);
        }
        if (/(rest|sleep|sleeping|睡|休息|补觉|躺下|在家躺|回去睡)/.test(raw)) {
            return selectPreferredRestDistrict(districts, false);
        }
        if (/(food|eat|restaurant|meal|吃|饭|餐馆|便利店)/.test(raw)) {
            return rankedMatches.find(entry => String(entry.district?.type || '').toLowerCase() === 'food')?.district
                || districts.find(d => d.id === 'restaurant')
                || districts.find(d => d.type === 'food')
                || districts.find(d => d.id === 'convenience')
                || null;
        }
        if (/(work|factory|job|赚钱|工作|打工|上班|工厂)/.test(raw)) {
            return rankedMatches.find(entry => String(entry.district?.type || '').toLowerCase() === 'work')?.district
                || districts.find(d => d.id === 'factory') || districts.find(d => d.type === 'work') || null;
        }
        if (/(hospital|medical|doctor|医院|看病|治疗)/.test(raw)) {
            return districts.find(d => d.id === 'hospital') || districts.find(d => d.type === 'medical') || null;
        }
        if (/(park|leisure|散步|公园|放松)/.test(raw)) {
            return rankedMatches.find(entry => String(entry.district?.type || '').toLowerCase() === 'leisure')?.district
                || districts.find(d => d.id === 'park') || districts.find(d => d.type === 'leisure') || null;
        }
        if (/(wander|street|闲逛|逛逛|街上)/.test(raw)) {
            return rankedMatches.find(entry => String(entry.district?.type || '').toLowerCase() === 'wander')?.district
                || districts.find(d => d.id === 'street') || districts.find(d => d.type === 'wander') || null;
        }
        if (/(mall|shopping|购物|商场)/.test(raw)) {
            return districts.find(d => d.id === 'mall') || districts.find(d => d.type === 'shopping') || null;
        }
        if (/(school|education|study|学习|上课)/.test(raw)) {
            return districts.find(d => d.type === 'education') || null;
        }
        if (/(casino|gambling|赌)/.test(raw)) {
            return districts.find(d => d.id === 'casino') || districts.find(d => d.type === 'gambling') || null;
        }

        return null;
    }

    function resolveDistrictFromStructuredSignal(signal, districts, options = {}) {
        const allowTypeFallback = !!options.allowTypeFallback;
        if (!signal || !Array.isArray(districts) || districts.length === 0) return null;

        const exactMatchByAlias = (value) => {
            const normalized = normalizeDistrictText(value);
            if (!normalized) return null;
            for (const district of districts) {
                const aliases = getDistrictAliasValues(district);
                for (const alias of aliases) {
                    if (normalizeDistrictText(alias) === normalized) {
                        return district;
                    }
                }
            }
            return null;
        };

        const matchByType = (value) => {
            const normalized = resolveStructuredTypeAlias(value);
            if (!normalized || !allowTypeFallback) return null;
            if (normalized === 'rest' || normalized === 'sleep' || normalized === 'sleeping') {
                return selectPreferredRestDistrict(districts, false);
            }
            if (normalized === 'home') {
                return selectPreferredRestDistrict(districts, true);
            }
            return districts.find(d => normalizeDistrictText(d?.type) === normalized) || null;
        };

        if (typeof signal === 'string') {
            return exactMatchByAlias(signal) || matchByType(signal) || null;
        }

        if (typeof signal !== 'object') return null;

        const directCandidates = [
            signal.district_id,
            signal.districtId,
            signal.district_name,
            signal.districtName,
            signal.district,
            signal.name
        ];
        for (const candidate of directCandidates) {
            const matched = exactMatchByAlias(candidate);
            if (matched) return matched;
        }

        const typeCandidates = [
            signal.district_type,
            signal.districtType,
            signal.type,
            signal.intent
        ];
        for (const candidate of typeCandidates) {
            const matched = matchByType(candidate);
            if (matched) return matched;
        }

        return null;
    }

    async function maybeExecuteReplyCityIntent(userId, characterId, intentText, replyText = '') {
        const db = ensureCityDb(context.getUserDb(userId));
        const config = db.city.getConfig();
        if (config.dlc_enabled === '0' || config.dlc_enabled === 'false') return { triggered: false, reason: 'city_paused' };

        const char = db.getCharacter(characterId);
        if (!char || char.status !== 'active' || char.sys_survival === 0) return { triggered: false, reason: 'character_inactive' };

        const districts = db.city.getEnabledDistricts();
        const district = resolveDistrictFromStructuredSignal(intentText, districts, { allowTypeFallback: true });
        if (!district) return { triggered: false, reason: 'intent_unresolved' };

        if (String(char.location || '').toLowerCase() === String(district.id || '').toLowerCase()) {
            return { triggered: false, reason: district.id === 'home' ? 'same_home_noop' : 'same_location_noop' };
        }

        return runPrivateReplyDirectedCityAction(
            userId,
            char,
            district,
            replyText,
            db,
            config
        );
    }

    async function maybeExecuteReplyCityAction(userId, characterId, actionPayload, replyText = '') {
        const db = ensureCityDb(context.getUserDb(userId));
        const config = db.city.getConfig();
        if (config.dlc_enabled === '0' || config.dlc_enabled === 'false') {
            return { triggered: false, reason: 'city_paused' };
        }

        const char = db.getCharacter(characterId);
        if (!char || char.status !== 'active' || char.sys_survival === 0) {
            return { triggered: false, reason: 'character_inactive' };
        }

        const payload = actionPayload && typeof actionPayload === 'object' ? actionPayload : {};
        const districts = db.city.getEnabledDistricts();
        const district = resolveDistrictFromStructuredSignal(payload, districts, { allowTypeFallback: true });
        if (!district) {
            return { triggered: false, reason: 'action_unresolved' };
        }

        const payloadPromptParts = [
            payload.prompt,
            payload.goal,
            payload.plan,
            payload.log,
            payload.diary
        ].map(v => String(v || '').trim()).filter(Boolean);
        const seedPrompt = payloadPromptParts.join(' ');
        return runPrivateReplyDirectedCityAction(
            userId,
            char,
            district,
            replyText,
            db,
            config
        );
    }

    async function maybeSyncReplyDeclaredState() {
        return { synced: false, reason: 'disabled' };
    }

    function applyPassiveSurvivalTick(char, currentCals, currentMinute, elapsedMinutes = 1, metabolismPerMinute = 0) {
        const state = normalizeSurvivalState(char);
        const totalMinutes = Math.max(1, parseInt(elapsedMinutes, 10) || 1);
        let calories = Math.max(0, parseInt(currentCals ?? char.calories ?? 2000, 10) || 0);

        for (let i = 0; i < totalMinutes; i++) {
            calories = Math.max(0, calories - Math.max(0, metabolismPerMinute));
            const minuteMark = ((currentMinute - totalMinutes + 1 + i) % 60 + 60) % 60;
            const isSleeping = char.city_status === 'sleeping';
            const isComa = char.city_status === 'coma';
            const atHome = (char.location || 'home') === 'home';
            const slowTick = minuteMark % 10 === 0;
            const mediumTick = minuteMark % 5 === 0;

            // Passive survival should drift gradually. The old minute-by-minute
            // penalties were stacking too aggressively and made "paused actions"
            // look broken because stats still collapsed very fast.
            if (slowTick) {
                state.sleep_debt = clamp(state.sleep_debt + (isSleeping ? -2 : 1), 0, 100);
            }

            if (minuteMark % 12 === 0) {
                state.satiety = clamp(state.satiety - 1, 0, 100);
            }
            if (minuteMark % 6 === 0) {
                state.stomach_load = clamp(state.stomach_load - 2, 0, 100);
            }
            if (slowTick && state.stomach_load >= 75) {
                state.sleep_debt = clamp(state.sleep_debt + 1, 0, 100);
            }

            if (mediumTick) {
                let energyDelta = isSleeping ? 2 : 0;
                if (!isSleeping && slowTick) energyDelta -= 1;
                if (calories < 800) energyDelta -= 1;
                if (state.sleep_debt > 70) energyDelta -= 1;
                if (state.health < 40) energyDelta -= 1;
                if (state.stomach_load > 75) energyDelta -= 1;
                const sleepDisruption = clamp(parseInt(char.sleep_disruption ?? 0, 10) || 0, 0, 100);
                if (isSleeping && sleepDisruption > 0) {
                    energyDelta -= Math.max(1, Math.ceil(sleepDisruption / 20));
                    if (slowTick) {
                        state.sleep_debt = clamp(state.sleep_debt + Math.max(1, Math.ceil(sleepDisruption / 25)), 0, 100);
                    }
                }
                state.energy = clamp(state.energy + energyDelta, 0, 100);
            }

            if (slowTick) {
                let stressDelta = 0;
                if ((char.wallet ?? 0) < 20) stressDelta += 1;
                if (calories < 500) stressDelta += 1;
                if (state.sleep_debt > 80) stressDelta += 1;
                if (state.stomach_load > 80) stressDelta += 1;
                if (isSleeping || atHome) stressDelta -= 1;
                if (isComa) stressDelta += 2;
                state.stress = clamp(state.stress + stressDelta, 0, 100);

                state.social_need = clamp(state.social_need + (atHome ? 1 : -1), 0, 100);
            }

            if (slowTick) {
                let healthDelta = 0;
                if (calories === 0) healthDelta -= 2;
                else if (calories < 400) healthDelta -= 1;
                if (state.sleep_debt > 90) healthDelta -= 1;
                if (isSleeping && calories > 900) healthDelta += 1;
                state.health = clamp(state.health + healthDelta, 0, 100);
            }
        }

        state.mood = calculateDerivedMood(state);
        state.calories = calories;
        return state;
    }

    function getDistrictStateEffects(district, richNarrations = null) {
        const effects = { energy: 0, sleep_debt: 0, stress: 0, social_need: 0, health: 0, mood: 0, satiety: 0, stomach_load: 0 };
        switch (district.type) {
            case 'work':
                effects.energy -= 8;
                effects.sleep_debt += 9;
                effects.stress += 6;
                effects.social_need -= 4;
                effects.mood -= 2;
                break;
            case 'food':
                effects.energy += 7;
                effects.satiety += 14;
                effects.stomach_load += 10;
                effects.sleep_debt += 6;
                effects.stress -= 3;
                effects.mood += 4;
                break;
            case 'shopping':
                effects.energy -= 2;
                effects.stress -= 1;
                effects.mood += 3;
                break;
            case 'rest':
                effects.energy += 16;
                effects.sleep_debt -= 42;
                effects.stress -= 8;
                effects.health += 2;
                effects.mood += 4;
                break;
            case 'leisure':
            case 'wander':
                effects.energy -= 3;
                effects.stress -= 5;
                effects.social_need -= 10;
                effects.mood += 6;
                break;
            case 'education':
                effects.energy -= 6;
                effects.sleep_debt += 3;
                effects.stress += 2;
                effects.mood += 1;
                break;
            case 'medical':
                effects.energy += 4;
                effects.sleep_debt -= 4;
                effects.stress -= 6;
                effects.health += 18;
                effects.mood -= 1;
                break;
            case 'gambling':
                effects.energy -= 4;
                effects.sleep_debt += 4;
                effects.stress += 4;
                break;
            default:
                effects.energy -= 1;
                effects.mood += 1;
                break;
        }

        if (richNarrations?.chat) effects.social_need = Math.max(effects.social_need - 6, -15);
        return effects;
    }

    function applyStateEffectsToCharacter(char, effects) {
        const state = normalizeSurvivalState(char);
        state.energy = clamp(state.energy + (effects.energy || 0), 0, 100);
        state.sleep_debt = clamp(state.sleep_debt + (effects.sleep_debt || 0), 0, 100);
        state.stress = clamp(state.stress + (effects.stress || 0), 0, 100);
        state.social_need = clamp(state.social_need + (effects.social_need || 0), 0, 100);
        state.health = clamp(state.health + (effects.health || 0), 0, 100);
        state.satiety = clamp(state.satiety + (effects.satiety || 0), 0, 100);
        state.stomach_load = clamp(state.stomach_load + (effects.stomach_load || 0), 0, 100);
        if (state.stomach_load > 75) {
            state.energy = clamp(state.energy - 5, 0, 100);
            state.sleep_debt = clamp(state.sleep_debt + 8, 0, 100);
            state.stress = clamp(state.stress + 4, 0, 100);
        }
        state.mood = clamp(calculateDerivedMood(state) + (effects.mood || 0), 0, 100);
        return state;
    }

    // LLM prompts

    function clipQuestContextText(value, maxLength = 180) {
        const normalized = String(value || '').replace(/\s+/g, ' ').trim();
        if (!normalized) return '';
        return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
    }

    function buildQuestPromptContext(activeQuests = [], activeQuestClaim = null, lastQuestReview = null, recentQuestReviews = []) {
        const openTasks = Array.isArray(activeQuests) ? activeQuests.slice(0, 6).map((quest) => {
            const claimantNames = Array.isArray(quest.claimant_names) ? quest.claimant_names.filter(Boolean) : [];
            const claimText = claimantNames.length > 0
                ? `已由 ${claimantNames.join('、')} 接单/领先；后加入也可以帮忙推进，但只有抢先正式交付的人能拿赏金，不能预写自己已经拿到钱`
                : '暂时无人接单';
            return `- [QUEST_${quest.id}] ${quest.emoji || '📜'} ${quest.title} | 地点=${quest.target_district || 'street'} | 奖励=${Number(quest.reward_gold || 0)}金币${Number(quest.reward_cal || 0) > 0 ? ` ${Number(quest.reward_cal || 0)}体力` : ''} | ${claimText} | ${quest.description || ''}`;
        }) : [];

        let personalTask = '';
        if (activeQuestClaim) {
            const stageMap = {
                accepted: '你刚决定去接这单，下一步先赶到对应地点。',
                in_progress: '你已经在处理中，继续按任务要求做事。',
                ready_to_report: '你已经做完主要内容，下一步该去汇报交付。',
                reporting: '你正在准备汇报交付。'
            };
            const nextQuestIntentStage = ['ready_to_report', 'reporting'].includes(String(activeQuestClaim.status || '')) ? 'report' : 'progress';
            const reviewStatus = String(lastQuestReview?.status || '').trim();
            const hasLastReview = !!lastQuestReview && reviewStatus !== 'pending';
            const progressDelta = Number(lastQuestReview?.progress_delta || 0);
            const progressAfter = Number(lastQuestReview?.progress_after ?? activeQuestClaim.progress_count ?? 0);
            const targetScore = Number(lastQuestReview?.target_score || activeQuestClaim.completion_target || 0);
            const reviewComment = String(lastQuestReview?.comment || lastQuestReview?.error_message || '').trim();
            const reviewLabel = String(lastQuestReview?.short_label || '').trim();
            const pressureLine = progressDelta <= 0
                ? '上一次没有推进任务；如果继续闲逛或做普通地点玩法，很可能拿不到赏金。'
                : '上一次已经推进了一点，但还没完成；这次要沿着有效方向继续做具体任务动作。';
            const lastReviewBlock = hasLastReview
                ? `\n[上一次任务评分]\n- 结果：${reviewStatus === 'success' ? `+${progressDelta}分 ${reviewLabel ? `(${reviewLabel})` : ''}` : '评分失败'}\n- 累计进度：${progressAfter}/${targetScore || activeQuestClaim.completion_target || 0}\n- 评价：${reviewComment || '暂无具体评价'}\n- 压力提醒：${pressureLine}`
                : '';
            const reviewTimeline = Array.isArray(recentQuestReviews)
                ? recentQuestReviews
                    .filter((review) => review && String(review.status || '').trim() !== 'pending')
                    .slice(0, 4)
                    .reverse()
                : [];
            const continuityHaystack = reviewTimeline
                .map((review) => [review.short_label, review.comment, review.log_content].map((value) => String(value || '')).join(' '))
                .join('\n');
            const hasContactedTarget = /成功接头|找到目标|找到.*VIP|接触.*VIP|达成护送|需要人送您安全到家|带着他|护送/.test(continuityHaystack);
            const continuityHint = hasContactedTarget
                ? '\n[当前任务连续阶段]\n- 已经找到并接触过目标 VIP，且已达成/开始护送关系。\n- 后续行动必须写护送、保护、避开尾随者、带目标移动、处理阻碍或准备交付；不得再写“VIP还没出现”“不知道他长什么样”“重新寻找目标”。'
                : '';
            const timelineBlock = reviewTimeline.length > 0
                ? `\n[最近任务轨迹]\n${reviewTimeline.map((review) => {
                    const label = String(review.short_label || '').trim();
                    const comment = clipQuestContextText(review.comment || review.error_message || '', 110);
                    const log = clipQuestContextText(review.log_content || '', 170);
                    const delta = Number(review.progress_delta || 0);
                    const after = Number(review.progress_after || 0);
                    const target = Number(review.target_score || activeQuestClaim.completion_target || 0);
                    return `- ${after}/${target}：${delta >= 0 ? `+${delta}` : delta}分${label ? `（${label}）` : ''}；${comment || '暂无评价'}${log ? `；上轮事实：${log}` : ''}`;
                }).join('\n')}${continuityHint}\n- 连续性要求：本轮必须承接最近任务轨迹继续推进，不要倒退到已经完成过的阶段；如果已经找到/接触目标，就继续护送、处理阻碍、移动到下一节点或准备交付，不要重新写“目标还没出现/不知道目标是谁”。`
                : '';
            personalTask = `\n[你当前手上的公告任务]\n- 任务：${activeQuestClaim.emoji || '📜'} ${activeQuestClaim.title}\n- 目标地点：${activeQuestClaim.target_district || 'street'}\n- 当前阶段：${activeQuestClaim.status}\n- 进度：${activeQuestClaim.progress_count || 0}/${activeQuestClaim.completion_target || 0}\n- 说明：${stageMap[activeQuestClaim.status] || '按任务自然推进。'}\n- 任务要求：${activeQuestClaim.description || ''}${lastReviewBlock}${timelineBlock}\n- 若本轮行动地点等于目标地点，优先推进这项任务，不要写成普通地点闲逛或消费。\n- 本轮推进任务时必须附带 quest_intent：{"quest_id":${Number(activeQuestClaim.quest_id || activeQuestClaim.id || 0)},"stage":"${nextQuestIntentStage}"}。\n- 任务文案必须出现可评分的具体行动：寻找/接触目标、确认情况、动手处理、护送、交付、汇报、解决阻碍等，按任务要求选择。\n- 如果目标地点是赌场，但任务不是“参与赌博”，不要写下注、轮盘、骰宝、牌局输赢或自行消遣；赌场只是任务发生地点。`;
        }

        return {
            openTasks,
            personalTask
        };
    }

    function normalizeQuestIntent(richNarrations = null) {
        return questService.normalizeQuestIntent(richNarrations);
    }

    function buildSurvivalPrompt(districts, char, inventory, activeEvents, universalContext, targetDistrict, questContext = null, promptDb = null) {
        const energySources = [];
        const resourceGens = [];
        const medicals = [];
        const statTrainers = [];
        const gambles = [];
        const leisures = [];

        for (const d of districts) {
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

        const foodItems = inventory.filter(i => i.cal_restore > 0);
        const optionsBlock = getCachedCityPromptBlock(
            context.getUserDb(char.user_id || 'default'),
            char.id,
            'city_survival_options_v1',
            {
                districts: districts.map(d => ({
                    id: d.id,
                    name: d.name,
                    emoji: d.emoji,
                    description: d.description,
                    type: d.type,
                    cal_cost: d.cal_cost,
                    cal_reward: d.cal_reward,
                    money_cost: d.money_cost,
                    money_reward: d.money_reward
                })),
                foodItems: foodItems.map(f => ({
                    id: f.item_id || f.id,
                    name: f.name,
                    emoji: f.emoji,
                    quantity: f.quantity,
                    cal_restore: f.cal_restore
                }))
            },
            () => {
                let options = '';
                for (const d of districts) {
                    const effects = [];
                    if (d.cal_cost > 0) effects.push(`-${d.cal_cost}体力`);
                    if (d.cal_reward > 0) effects.push(`+${d.cal_reward}体力`);
                    if (d.money_cost > 0) effects.push(`-${d.money_cost}金币`);
                    if (d.money_reward > 0) effects.push(`+${d.money_reward}金币`);
                    const req = d.money_cost > 0 ? ` 需${d.money_cost}金` : '';
                    options += `[${d.id.toUpperCase()}] ${d.emoji} ${d.name} | ${effects.join(', ') || '无明显代价'}${req} | ${d.description}\n`;
                }
                if (foodItems.length > 0) {
                    const foodList = foodItems.map(f => `${f.emoji}${f.name}x${f.quantity}(+${f.cal_restore})`).join(', ');
                    options += `[EAT_ITEM] 🍜 吃背包食物 | ${foodList}\n`;
                }
                return options.trim();
            }
        );

        let eventInfo = '';
        if (activeEvents && activeEvents.length > 0) {
            eventInfo = '\n[城市事件] ' + activeEvents.map(e => `${e.emoji}${e.title}`).join('、');
        }

        const cal = char.calories ?? 2000;
        const wallet = char.wallet ?? 200;
        const state = normalizeSurvivalState(char);
        const physicalCondition = getPhysicalCondition(char, state, cal);
        const stateFlags = [];

        if (char.city_status === 'coma') stateFlags.push('危险状态=接近失去意识');
        else if (cal <= 300) stateFlags.push('饥饿等级=极度虚弱');
        else if (cal <= 1000) stateFlags.push('饥饿等级=明显饥饿');
        else if (cal >= 3500) stateFlags.push('饱腹等级=过饱');

        if (wallet <= 10) stateFlags.push('钱包状态=极度拮据');

        let taskInstruction = '【自由探索】在别饿晕、别破产的前提下，按性格/身体/钱包/最近经历决定下一步去哪。';
        if (targetDistrict) {
            taskInstruction = `【既定意愿】你已经决定要去 [${targetDistrict.id.toUpperCase()}] ${targetDistrict.name}。身体状态、情绪和钱包只影响你到了之后的表现、效率和后果，不改变目的地本身。当前位置标签也必须跟随这次真实去到的地点。`;
        }
        const questOpenBlock = questContext?.openTasks?.length > 0 ? `\n[公告栏悬赏]\n${questContext.openTasks.join('\n')}` : '';
        const personalQuestBlock = questContext?.personalTask || '';
        const promptHistoryDb = promptDb || ensureCityDb(context.getUserDb(char.user_id || 'default'));
        const continuityDistrict = targetDistrict || districts.find((entry) => entry.id === char.location) || null;
        const antiRepeatBlock = buildRecentNarrationAntiRepeatBlock(promptHistoryDb, char, continuityDistrict || { type: '', id: '' });
        const typedAntiRepeatBlock = formatTypedAntiRepeatBlock(universalContext?.antiRepeatHints, {
            include: ['private_character_replies', 'city_private_outreach', 'city_self_logs'],
            maxPerType: 4,
            maxTextLen: 220,
            mode: 'city_chat',
            title: '[大输入库分型防复读]'
        });
        const privateChatAntiRepeatBlock = typedAntiRepeatBlock || buildRecentPrivateChatAntiRepeatBlock(promptHistoryDb, char);

        let hardConstraintText = '';
        if (state.energy < 20) {
            hardConstraintText += '\n- 精力极低：别再做高消耗。';
        } else if (state.energy < 35) {
            hardConstraintText += '\n- 精力偏低：持续活动会更累。';
        } else if (state.energy > 85) {
            hardConstraintText += '\n- 精力很高：行动欲更强。';
        } else if (state.energy > 70) {
            hardConstraintText += '\n- 精力不错：做事更顺。';
        }
        if (state.sleep_debt > 85) {
            hardConstraintText += '\n- 严重欠觉：脑钝、脾气脆。';
        } else if (state.sleep_debt > 60) {
            hardConstraintText += '\n- 比较缺觉：耐心和专注下降。';
        }
        if (state.health < 25) {
            hardConstraintText += '\n- 身体很差：病感/虚弱明显。';
        } else if (state.health < 45) {
            hardConstraintText += '\n- 身体不适：承受力和恢复更差。';
        }
        if (state.satiety < 20) {
            hardConstraintText += '\n- 很饿：注意力被饥饿拖走。';
        }
        if (state.stomach_load > 80) {
            hardConstraintText += '\n- 很撑：动作慢，易困烦。';
        } else if (state.stomach_load > 55) {
            hardConstraintText += '\n- 有点撑：身体不轻快。';
        }
        const emotionGuidance = getEmotionBehaviorGuidance(char);
        hardConstraintText += `\n- 主情绪：${emotionGuidance.emotion.label} ${emotionGuidance.emotion.emoji}`;
        hardConstraintText += `\n- 情绪感受：${emotionGuidance.cityAction}`;
        const growthDb = ensureCityGrowthDb(context.getUserDb(char.user_id || 'default'));
        const schoolPromptBlock = schoolLogic.buildSchoolPromptBlock(growthDb, char);

        return `[世界背景]
${universalContext?.preamble || ''}

[任务]
你在商业街真实生活。按此刻状态决定下一步去哪，不要把世界解释成系统。

[地点分类]
- 补体力：${energySources.join(', ') || '暂无'}
- 赚钱：${resourceGens.join(', ') || '暂无'}
- 医疗：${medicals.join(', ') || '暂无'}
- 训练：${statTrainers.join(', ') || '暂无'}
- 高风险：${gambles.join(', ') || '暂无'}
- 休闲：${leisures.join(', ') || '暂无'}

[当前状态]
地点=${char.location || '未知'} | 状态=${char.city_status || '健康'}
体力=${cal}/4000 | 金币=${wallet}
精力=${state.energy} 睡眠债=${state.sleep_debt} 心情=${state.mood} 压力=${state.stress}
社交需求=${state.social_need} 健康=${state.health} 饱腹=${state.satiety} 胃负担=${state.stomach_load}
身体等级=${physicalCondition.label} | 后果=${physicalCondition.summary}${stateFlags.length > 0 ? `\n状态标签=${stateFlags.join(' / ')}` : ''}${eventInfo}
${schoolPromptBlock ? '\n' + schoolPromptBlock : ''}

${taskInstruction}
[任务机制补充]
- 你也会看到公告栏里的悬赏任务，它和普通商业街活动一样是真实世界信息。
- 如果你想去接某个公告任务，就在输出里额外带上 quest_intent：{"quest_id":任务ID,"stage":"claim"}，并让 action 去往对应地点。
- 如果你已经在做任务，并且本轮行动地点就是任务目标地点，优先推进任务，必须带 stage="progress"；不要写成普通地点玩法。
- 如果你准备交付任务、领取赏金，就额外带上 quest_intent：{"quest_id":任务ID,"stage":"report"}。
- 不要把 quest_intent 当系统说明写进 log，log 仍然必须像普通商业街活动。${questOpenBlock}${personalQuestBlock}
- 如果本轮行动意图是“接下某个公告任务 / 开始执行某个公告任务 / 推进手上已有任务 / 交付任务”，就要在 JSON 里同步带 quest_intent；不要只在自然文案里表达这个意图却漏掉标签。
- 如果只是看见公告、犹豫、评估要不要接，且没有明确行动，可以不带 quest_intent。
- 任务推进必须贴合任务内容：采购/配送要写拿货、送达；清理/维修要写动手处理；调查类要写打听、寻找、发现；巡逻/护送要写陪同、盯守、来回查看。
- 去错地点、只是在附近闲逛、或者文案和任务不匹配，都不会推进任务进度。
- 如果公告显示已由别人接单/领先，你可以后加入帮忙，但不要在 log/chat/diary 里写自己已经拿到赏金；只有系统确认你抢先正式交付后，才能写领到赏金。
- 如果你没有“你当前手上的公告任务”块，就不能写自己交付任务或领赏，只能写看见、评估、接单、帮忙或普通行动。
- 黑客据点只是地点之一。只有任务内容明确要求监听/入侵/截获情报时，才把行动写成黑客行动；普通公告任务在黑客据点推进时，不要自动写监听记录或截获私聊。
[吃饭/补给语义]
- 餐厅/饭店/现场用餐 = 这轮吃饭并恢复体力。
- 背包里的食物 = 选择 EAT_ITEM 才是当场吃掉并恢复体力。
- 便利店 = 购买包装食品或饮料，默认先放进背包；除非系统明确允许 EAT_ITEM，否则不要把便利店购买写成已经吃完恢复。
- 如果当前真正目标是缓解饥饿、补体力、吃一顿，优先选择餐厅或 EAT_ITEM，而不是便利店 BUY。
[行动约束]${hardConstraintText}

[输出要求]
- 只选一个 action
- log 自然写出这次行动里真正发生的事，要有画面/动作/心理，但不要写成固定模板
- 若想联系玩家再填 chat
- chat 的“主动”优先体现为你主动汇报刚发生的事、自己现在的状态、情绪、处境、发现或决定，而不是默认用寒暄或查岗来拉人回应
- 不要把“你在干嘛 / 你在做什么 / 你在哪 / 忙吗 / 在吗”这种追问当作默认开头，除非这次事件本身真的需要立刻确认用户位置、安危或回应
- 比起泛泛追问，更优先写“我刚刚怎么了 / 我现在什么状态 / 我准备做什么 / 我为什么突然想给你发消息”
- 如果要提问，也要让问题强依附于这次商业街事件本身，而不是空泛地确认用户在不在
- chat 不是正常私聊重 roll；不要复制或近似改写最近私聊已经说过的话
- 若值得公开展示再填 moment
- 若有没说出口的心声再填 diary
- 想花钱但钱不够时，也要把失败尝试真实写进 log
- 不要重复 preamble 里刚做过的地点/动作
- 不要使用高复用套话，不要把“从家离开、肚子里空空的、先把自己安顿好”这类句式当默认开头${antiRepeatBlock ? antiRepeatBlock : ''}${privateChatAntiRepeatBlock ? privateChatAntiRepeatBlock : ''}

只返回 JSON：
  {
    "action": "[PARK]",
    "log": "自然的行动描写",
    "chat": "（可选）发给玩家的话",
    "moment": "（可选）朋友圈动态",
    "diary": "（可选）内心独白",
    "quest_intent": { "quest_id": 12, "stage": "claim|progress|report" }
  }

  [可选行动]
  ${optionsBlock}`;
    }

    function buildSchedulePrompt(char, districts, universalContext) {
        const districtList = districts.map(d => `"${d.id}"(${d.emoji}${d.name})`).join('、');
        return `[世界背景]
${universalContext?.preamble || ''}

[任务]
你是 ${char.name}。为今天 6:00~23:00 规划日程，参考体力/钱包/身体状态/性格。

[可去地点]
${districtList}

[输出规则]
- 只返回 JSON 数组
- 每项含 hour / action / reason
- hour 为 6~23 整数
- action 只能是地点 ID 或 "none"
- 如果今天不规划，只返回一项 {"hour":6,"action":"none","reason":"..."}
- 禁止输出 Markdown、解释、前言、后记、注释
- 必须使用英文双引号，不要使用单引号
- 数组必须完整闭合，以 ] 结束
- 每个对象都必须同时有 hour、action、reason
- 不要输出半截字段，例如 "action   或缺少右引号/右括号

示例：
[{"hour":8,"action":"factory","reason":"去打工赚钱"},{"hour":12,"action":"restaurant","reason":"午饭时间"}]`;
    }

    function tryParseScheduleReply(reply = '') {
        const cleaned = String(reply || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        if (!cleaned) return null;
        const parsed = JSON.parse(cleaned);
        return Array.isArray(parsed) ? parsed : null;
    }

    function normalizeGeneratedSchedulePlan(plan, districts = []) {
        if (!Array.isArray(plan) || plan.length === 0) return null;
        const allowedActions = new Set((Array.isArray(districts) ? districts : [])
            .map((district) => String(district?.id || '').trim())
            .filter(Boolean));
        allowedActions.add('none');
        const normalized = [];
        for (const entry of plan) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
            const hour = Number(entry.hour);
            const action = String(entry.action || '').trim();
            const reason = String(entry.reason || '').trim();
            if (!Number.isSafeInteger(hour) || hour < 6 || hour > 23) return null;
            if (!allowedActions.has(action)) return null;
            if (!reason) return null;
            normalized.push({
                hour,
                action,
                reason: reason.slice(0, 160)
            });
        }
        return normalized;
    }

    function buildSocialPrompt(charA, charB, district, relAB, relBA, inventoryA, inventoryB, universalContextA, universalContextB) {
        const personaA = (charA.persona || charA.system_prompt || '普通人').substring(0, 120);
        const personaB = (charB.persona || charB.system_prompt || '普通人').substring(0, 120);
        const invAStr = inventoryA.slice(0, 5).map(i => `${i.emoji}${i.name}x${i.quantity}`).join(', ') || '空';
        const invBStr = inventoryB.slice(0, 5).map(i => `${i.emoji}${i.name}x${i.quantity}`).join(', ') || '空';
        const affinityAB = relAB?.affinity ?? 50;
        const affinityBA = relBA?.affinity ?? 50;
        const impressionAB = relAB?.impression ? `印象: "${relAB.impression}"` : '';

        return `[商业街偶遇]
两名独立生活角色在 ${district.emoji}${district.name} 偶遇。基于各自上下文，写一小段自然互动。

====== A(${charA.name}) 上下文 ======
${universalContextA?.preamble || ''}
====== B(${charB.name}) 上下文 ======
${universalContextB?.preamble || ''}

[角色摘要]
A=${charA.name}(${personaA}) | 背包=${invAStr} | 金币=${charA.wallet ?? 0} | 对B好感=${affinityAB} ${impressionAB}
B=${charB.name}(${personaB}) | 背包=${invBStr} | 金币=${charB.wallet ?? 0} | 对A好感=${affinityBA}

[约束]
- 可寒暄、试探、送礼、错开、简聊
- 对玩家(${userName})的占有欲/嫉妒默认只指向玩家，不要无故转移到对方
- 若对对方表现敌意或酸意，必须来自这次现场触发或既有关系

只返回 JSON：
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

    function buildQuestCompetitionContext(db, occupants, district) {
        if (!Array.isArray(occupants) || occupants.length < 2) return '';
        const activeClaims = occupants
            .map((char) => {
                const claim = db.city.getCharacterActiveQuestClaim?.(char.id);
                return claim ? { char, claim } : null;
            })
            .filter(Boolean);
        if (activeClaims.length < 2) return '';

        const grouped = new Map();
        for (const item of activeClaims) {
            const key = String(item.claim.quest_id);
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(item);
        }

        const conflict = Array.from(grouped.values()).find((items) => items.length >= 2);
        if (!conflict) return '';
        const quest = conflict[0].claim;
        const names = conflict.map((item) => item.char.name).join('、');
        const targetDistrict = String(quest.target_district || '');
        const onSite = targetDistrict === district.id ? '你们现在就在这单的目标地点。' : `这单的目标地点是 ${targetDistrict}。`;
        return `\n[竞争任务现场]\n${names} 正在竞争同一条公告任务：${quest.emoji || '📜'} ${quest.title}。\n任务内容：${quest.description || ''}\n${onSite}\n这次偶遇请明显体现“彼此知道对方在抢同一单”的紧张感、试探、让步、暗中较劲或嘴上不说破的竞争。`;
    }

    const behaviorTreeAllowedActions = [
        'say',
        'emote',
        'wait',
        'face_player',
        'go_to_place',
        'wander_between',
        'loop_in_front_of',
        'browse_near',
        'patrol_segment',
        'approach_player',
        'follow_player',
        'walk_with_player',
        'idle_at_place',
        'offer_choices',
        'create_memory',
        'relationship_delta',
        'end_interaction'
    ];
    const behaviorTreeAllowedActionSet = new Set(behaviorTreeAllowedActions);
    const behaviorPlayerInteractionActions = [
        'greet',
        'small_talk',
        'ask_current_action',
        'ask_destination',
        'suggest_destination',
        'request_company',
        'treat_food',
        'request_help',
        'joke',
        'comfort'
    ];
    const behaviorPlayerInteractionActionSet = new Set(behaviorPlayerInteractionActions);
    const behaviorRepeatTextActions = new Set(['say', 'emote', 'offer_choices', 'create_memory', 'relationship_delta']);
    const behaviorSemanticMovementActions = [
        { id: 'go_to_place', label: '前往地点', needs: ['place_id'], description: '走到某个表内地点附近。' },
        { id: 'wander_between', label: '两点间闲逛', needs: ['from_place_id', 'to_place_id'], description: '在两个表内地点之间来回平移。' },
        { id: 'loop_in_front_of', label: '门前循环', needs: ['place_id'], description: '在某个表内地点前面小范围左右移动。' },
        { id: 'browse_near', label: '附近浏览', needs: ['place_id'], description: '靠近某个表内地点，停停走走。' },
        { id: 'patrol_segment', label: '街段巡逻', needs: ['from_place_id', 'to_place_id'], description: '在两个表内地点之间巡逻式移动。' },
        { id: 'approach_player', label: '靠近玩家', needs: [], description: '靠近玩家并面对玩家。' },
        { id: 'follow_player', label: '跟随玩家', needs: [], description: '跟随玩家，保持一小段距离。' },
        { id: 'walk_with_player', label: '陪玩家走', needs: ['to_place_id?'], description: '和玩家一起向某个表内地点走，地点可选。' },
        { id: 'idle_at_place', label: '地点停留', needs: ['place_id'], description: '在某个表内地点附近站立、等待、转向或说话。' }
    ];
    const behaviorSemanticMovementActionSet = new Set(behaviorSemanticMovementActions.map((action) => action.id));
    const behaviorPatchTargetIds = new Set([
        'player_interaction',
        'hard_needs',
        'routine_goal',
        'place_affordance',
        'background_mood',
        'curiosity',
        'wander',
        'idle_micro'
    ]);
    const behaviorBasePatchTargetIds = new Set([
        'hard_needs',
        'routine_goal',
        'place_affordance',
        'background_mood',
        'curiosity',
        'wander',
        'idle_micro'
    ]);

    function limitText(value, maxLength = 220) {
        return String(value || '').trim().slice(0, maxLength);
    }

    function parseJsonObjectFromLlmText(text) {
        const cleaned = String(text || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        if (!cleaned) return null;
        return JSON.parse(cleaned);
    }

    async function fetchBehaviorModelList(endpoint, key, timeoutMs = 18000) {
        const apiEndpoint = String(endpoint || '').trim();
        const apiKey = String(key || '').trim();
        if (!apiEndpoint || !apiKey) throw new Error('Missing endpoint or key');
        let baseUrl = apiEndpoint.endsWith('/') ? apiEndpoint.slice(0, -1) : apiEndpoint;
        if (baseUrl.endsWith('/chat/completions')) baseUrl = baseUrl.slice(0, -'/chat/completions'.length);
        const modelsUrl = `${baseUrl}/models`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(modelsUrl, {
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                signal: controller.signal
            });
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`API ${response.status}: ${text.slice(0, 200)}`);
            }
            const data = await response.json();
            return (data.data || data.models || []).map((model) => model.id || model.name || model).filter(Boolean).sort();
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error('请求超时');
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    function getBehaviorTreeSkeleton() {
        return {
            version: 'single-character-street-runtime-v1',
            root: {
                id: 'street_character_root',
                type: 'PrioritySelector',
                children: [
                    {
                        id: 'player_interaction',
                        branch_kind: 'special',
                        priority: 100,
                        trigger: 'player_event.active',
                        note: '玩家靠近点击互动、或在互动里选择回应后，只局部更新这里。',
                        branches: ['greet', 'small_talk', 'ask_current_action', 'suggest_destination', 'treat_food', 'comfort']
                    },
                    {
                        id: 'hard_needs',
                        branch_kind: 'base',
                        priority: 82,
                        trigger: 'runtime_state.need_high',
                        branches: ['base_needs_cafe_snack', 'base_needs_home_rest']
                    },
                    {
                        id: 'routine_goal',
                        branch_kind: 'base',
                        priority: 76,
                        trigger: 'runtime_state.routine_tick',
                        note: '本地默认节奏，不由私聊或商业街活动触发。',
                        branches: ['base_routine_home_agency', 'base_routine_sign_check']
                    },
                    {
                        id: 'place_affordance',
                        branch_kind: 'base',
                        priority: 68,
                        trigger: 'location.has_affordance',
                        branches: ['base_affordance_agency_window', 'base_affordance_cafe_pause']
                    },
                    {
                        id: 'background_mood',
                        branch_kind: 'base',
                        priority: 60,
                        trigger: 'runtime_state.mood_idle',
                        note: '大输入只作背景情绪，不因私聊或商业街活动触发行动。',
                        branches: ['base_background_walk_cafe', 'base_background_slow_down']
                    },
                    {
                        id: 'curiosity',
                        branch_kind: 'base',
                        priority: 52,
                        trigger: 'nearby_place_or_player',
                        branches: ['base_curiosity_player_glance', 'base_curiosity_window_watch']
                    },
                    {
                        id: 'wander',
                        branch_kind: 'base',
                        priority: 36,
                        trigger: 'otherwise',
                        branches: ['base_wander_convenience_cafe', 'base_loop_cafe_front', 'base_patrol_agency_shop']
                    },
                    {
                        id: 'idle_micro',
                        branch_kind: 'base',
                        priority: 20,
                        trigger: 'idle',
                        branches: ['base_idle_watch_street', 'base_idle_turn_pause']
                    }
                ]
            }
        };
    }

    function getBehaviorOutputContract(world = {}) {
        const allowedPlaceIds = Array.isArray(world.allowed_place_ids) ? world.allowed_place_ids : [];
        const allowedMovementActions = Array.isArray(world.allowed_movement_actions) && world.allowed_movement_actions.length
            ? world.allowed_movement_actions
            : behaviorSemanticMovementActions;
        return {
            type: 'full_behavior_tree_patch_v1',
            allowed_place_ids: allowedPlaceIds,
            allowed_movement_actions: allowedMovementActions,
            schema: {
                patch_id: 'string',
                operation: 'upsert_child',
                target_node_id: '玩家互动必须为 player_interaction；基础自主枝丫是无互动时角色自己的默认行为，只有明确要求改基础树时才使用 hard_needs/routine_goal/place_affordance/background_mood/curiosity/wander/idle_micro',
                next_active_node_id: '本次 patch 合并后立刻执行的 node.id',
                reason: '一两句话说明为什么更新这个枝丫',
                node: {
                    id: 'string，局部枝丫节点 ID',
                    type: 'ActionSequence',
                    title: 'string',
                    priority: '1-100',
                    ttl_ms: '3000-120000',
                    trigger: {
                        player_action: behaviorPlayerInteractionActions.join('|'),
                        place_id: 'optional；如果填写，必须来自 allowed_place_ids'
                    },
                    summary: '一两句话说明角色为什么这么反应',
                    steps: [
                        {
                            action: behaviorTreeAllowedActions.join('|'),
                            text: 'say/emote/create_memory/relationship_delta 可用',
                            place_id: 'go_to_place/loop_in_front_of/browse_near/idle_at_place 可用；必须来自 allowed_place_ids',
                            from_place_id: 'wander_between/patrol_segment 可用；必须来自 allowed_place_ids',
                            to_place_id: 'wander_between/patrol_segment/walk_with_player 可用；必须来自 allowed_place_ids',
                            movement_style: '可选：slow、hesitating、window_shopping、patrol、walk_together 等文字风格',
                            duration_ms: 'wait 可用',
                            choices: 'offer_choices 可用，最多 4 个；choice.trigger 应使用玩家互动动作白名单'
                        }
                    ]
                },
                memory_delta: '可选：写入小量运行时状态，如 last_player_choice/current_topic/mood_shift'
            },
            allowed_actions: behaviorTreeAllowedActions
        };
    }

    function getBehaviorBaseOutputContract(world = {}) {
        const allowedPlaceIds = Array.isArray(world.allowed_place_ids) ? world.allowed_place_ids : [];
        const allowedMovementActions = Array.isArray(world.allowed_movement_actions) && world.allowed_movement_actions.length
            ? world.allowed_movement_actions
            : behaviorSemanticMovementActions;
        return {
            type: 'base_behavior_branch_pack_v1',
            allowed_place_ids: allowedPlaceIds,
            allowed_movement_actions: allowedMovementActions,
            target_node_ids: Array.from(behaviorBasePatchTargetIds),
            schema: {
                base_branches: [
                    {
                        id: 'string，建议以 base_ 开头',
                        target_node_id: 'hard_needs|routine_goal|place_affordance|background_mood|curiosity|wander|idle_micro',
                        title: '基础：xxx',
                        priority: '1-100',
                        ttl_ms: '3000-120000',
                        trigger: 'runtime_state.need_high|runtime_state.routine_tick|location.has_affordance|runtime_state.mood_idle|nearby_place_or_player|otherwise|idle',
                        summary: '一两句话说明无互动时角色为什么做这件事',
                        steps: [
                            {
                                action: behaviorTreeAllowedActions.join('|'),
                                text: 'say/emote 可用；基础枝丫里不要使用 offer_choices',
                                place_id: 'go_to_place/loop_in_front_of/browse_near/idle_at_place 可用；必须来自 allowed_place_ids',
                                from_place_id: 'wander_between/patrol_segment 可用；必须来自 allowed_place_ids',
                                to_place_id: 'wander_between/patrol_segment/walk_with_player 可用；必须来自 allowed_place_ids',
                                movement_style: '可选：slow、window_shopping、patrol、distracted 等文字风格',
                                duration_ms: 'wait/say/emote 可用'
                            }
                        ]
                    }
                ]
            },
            allowed_actions: behaviorTreeAllowedActions
        };
    }

    function normalizeAllowedBehaviorPlaceIds(rawIds = []) {
        if (!Array.isArray(rawIds)) return [];
        return Array.from(new Set(rawIds
            .map((id) => limitText(id, 80))
            .filter(Boolean)))
            .slice(0, 80);
    }

    function toAllowedBehaviorPlaceId(value, allowedPlaceIdSet) {
        const id = limitText(value, 80);
        if (!id || !allowedPlaceIdSet.has(id)) return '';
        return id;
    }

    function readBehaviorStepPlaceId(step, keys, allowedPlaceIdSet) {
        for (const key of keys) {
            const id = toAllowedBehaviorPlaceId(step?.[key], allowedPlaceIdSet);
            if (id) return id;
        }
        return '';
    }

    function normalizeSemanticMovementStep(step, action, allowedPlaceIdSet) {
        const normalized = { action };
        if (action === 'go_to_place' || action === 'loop_in_front_of' || action === 'browse_near' || action === 'idle_at_place') {
            const placeId = readBehaviorStepPlaceId(step, ['place_id', 'placeId', 'target_place_id', 'targetPlaceId', 'to_place_id', 'toPlaceId'], allowedPlaceIdSet);
            if (!placeId) return null;
            normalized.place_id = placeId;
            return normalized;
        }
        if (action === 'wander_between' || action === 'patrol_segment') {
            const fromPlaceId = readBehaviorStepPlaceId(step, ['from_place_id', 'fromPlaceId', 'source_place_id', 'sourcePlaceId'], allowedPlaceIdSet);
            const toPlaceId = readBehaviorStepPlaceId(step, ['to_place_id', 'toPlaceId', 'target_place_id', 'targetPlaceId', 'place_id', 'placeId'], allowedPlaceIdSet);
            if (!fromPlaceId || !toPlaceId) return null;
            normalized.from_place_id = fromPlaceId;
            normalized.to_place_id = toPlaceId;
            return normalized;
        }
        if (action === 'walk_with_player') {
            const toPlaceId = readBehaviorStepPlaceId(step, ['to_place_id', 'toPlaceId', 'target_place_id', 'targetPlaceId', 'place_id', 'placeId'], allowedPlaceIdSet);
            if (toPlaceId) normalized.to_place_id = toPlaceId;
            return normalized;
        }
        if (action === 'approach_player' || action === 'follow_player') {
            return normalized;
        }
        return null;
    }

    function normalizeBehaviorChoiceTrigger(choice = {}) {
        const candidates = [
            choice?.trigger,
            choice?.action_id,
            choice?.actionId,
            choice?.next_action,
            choice?.nextAction,
            choice?.player_action,
            choice?.playerAction,
            choice?.id,
            choice?.action
        ].map((value) => limitText(value, 80));
        return candidates.find((value) => behaviorPlayerInteractionActionSet.has(value)) || '';
    }

    function sanitizeBehaviorSteps(rawSteps, allowedPlaceIds = [], maxSteps = 10, options = {}) {
        const allowedPlaceIdSet = new Set(normalizeAllowedBehaviorPlaceIds(allowedPlaceIds));
        const allowChoices = options.allowChoices !== false;
        return (Array.isArray(rawSteps) ? rawSteps : [])
            .map((step) => {
                if (!step || typeof step !== 'object') return null;
                const action = String(step.action || '').trim();
                if (!behaviorTreeAllowedActionSet.has(action)) return null;
                if (!allowChoices && action === 'offer_choices') return null;
                const normalized = behaviorSemanticMovementActionSet.has(action)
                    ? normalizeSemanticMovementStep(step, action, allowedPlaceIdSet)
                    : { action };
                if (!normalized) return null;
                if (step.text !== undefined) normalized.text = limitText(step.text, action === 'create_memory' ? 180 : 140);
                if (step.target_label !== undefined || step.targetLabel !== undefined) {
                    normalized.target_label = limitText(step.target_label || step.targetLabel, 80);
                }
                if (step.movement_style !== undefined || step.movementStyle !== undefined) {
                    normalized.movement_style = limitText(step.movement_style || step.movementStyle, 80);
                }
                if (step.activity !== undefined) normalized.activity = limitText(step.activity, 100);
                if (step.duration_ms !== undefined || step.durationMs !== undefined) {
                    normalized.duration_ms = clamp(Number(step.duration_ms || step.durationMs) || 900, 300, 6000);
                }
                if (step.value !== undefined) normalized.value = clamp(Number(step.value) || 0, -3, 3);
                if (step.reason !== undefined) normalized.reason = limitText(step.reason, 120);
                if (step.importance !== undefined) normalized.importance = clamp(Number(step.importance) || 0.2, 0, 1);
                if (allowChoices && Array.isArray(step.choices)) {
                    const normalizedChoices = step.choices.slice(0, 4).map((choice, index) => {
                        if (typeof choice === 'string') {
                            const label = limitText(choice, 24);
                            const trigger = behaviorPlayerInteractionActionSet.has(label) ? label : '';
                            return trigger ? { id: trigger, label, trigger } : null;
                        }
                        if (!choice || typeof choice !== 'object') return null;
                        const trigger = normalizeBehaviorChoiceTrigger(choice);
                        if (!trigger) return null;
                        const choicePlaceId = toAllowedBehaviorPlaceId(
                            choice.place_id || choice.placeId || choice.to_place_id || choice.toPlaceId || '',
                            allowedPlaceIdSet
                        );
                        return {
                            id: limitText(choice.id || trigger || `choice_${index + 1}`, 40),
                            label: limitText(choice.label || choice.text || `选项 ${index + 1}`, 24),
                            trigger,
                            ...(choicePlaceId ? { place_id: choicePlaceId } : {})
                        };
                    }).filter(Boolean);
                    if (action === 'offer_choices' && !normalizedChoices.length) return null;
                    normalized.choices = normalizedChoices;
                }
                if (action === 'offer_choices' && !Array.isArray(normalized.choices)) return null;
                return normalized;
            })
            .filter(Boolean)
            .slice(0, maxSteps);
    }

    function sanitizeBehaviorBranch(rawBranch, char, payload = {}, fallbackReason = 'sanitize_empty', allowedPlaceIds = []) {
        if (!rawBranch || typeof rawBranch !== 'object') return null;
        const allowedPlaceIdSet = new Set(normalizeAllowedBehaviorPlaceIds(allowedPlaceIds));
        const steps = sanitizeBehaviorSteps(rawBranch.steps, allowedPlaceIds, 10, { allowChoices: true });
        if (!steps.length) return null;
        const triggerPlaceId = toAllowedBehaviorPlaceId(
            rawBranch.trigger?.place_id || rawBranch.trigger?.placeId || payload?.player_event?.place_id || '',
            allowedPlaceIdSet
        );
        const branchId = normalizeBehaviorNodeId(rawBranch.branch_id || rawBranch.id || `bt_${Date.now().toString(36)}`, 'branch');
        return {
            branch_id: branchId,
            title: limitText(rawBranch.title || '玩家互动分支', 80),
            priority: clamp(Number(rawBranch.priority) || 95, 1, 100),
            ttl_ms: clamp(Number(rawBranch.ttl_ms || rawBranch.ttlMs) || 45000, 3000, 120000),
            trigger: {
                player_action: limitText(rawBranch.trigger?.player_action || rawBranch.trigger?.playerAction || payload?.player_event?.action || 'greet', 60),
                place_id: triggerPlaceId
            },
            summary: limitText(rawBranch.summary || '', 180),
            steps
        };
    }

    function normalizeBehaviorNodeId(value, fallback = 'node') {
        const raw = limitText(value, 80);
        const safe = raw
            .replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
        return safe || `${fallback}_${Date.now().toString(36)}`;
    }

    function sanitizeBehaviorTreePatch(rawPatch, char, payload = {}, fallbackReason = 'patch_empty', allowedPlaceIds = []) {
        const patch = rawPatch && typeof rawPatch === 'object' ? rawPatch : {};
        const rawNode = patch.node && typeof patch.node === 'object' ? patch.node : null;
        const rawBranch = rawNode?.steps ? rawNode : (patch.branch || patch);
        const branch = sanitizeBehaviorBranch(rawBranch, char, payload, fallbackReason, allowedPlaceIds);
        if (!branch) return null;
        const nodeId = normalizeBehaviorNodeId(rawNode?.id || rawNode?.node_id || branch.branch_id, 'branch');
        const requestedTargetNodeId = normalizeBehaviorNodeId(patch.target_node_id || patch.targetNodeId || 'player_interaction', 'target');
        const targetNodeId = behaviorPatchTargetIds.has(requestedTargetNodeId) ? requestedTargetNodeId : 'player_interaction';
        const nextActiveNodeId = normalizeBehaviorNodeId(patch.next_active_node_id || patch.nextActiveNodeId || nodeId, 'active');
        const patchId = normalizeBehaviorNodeId(patch.patch_id || patch.patchId || `patch_${nodeId}_${Date.now().toString(36)}`, 'patch');
        const memoryDelta = patch.memory_delta && typeof patch.memory_delta === 'object'
            ? Object.fromEntries(Object.entries(patch.memory_delta).slice(0, 12).map(([key, value]) => [limitText(key, 60), limitText(value, 180)]))
            : {};
        return {
            patch_id: patchId,
            operation: 'upsert_child',
            target_node_id: targetNodeId,
            next_active_node_id: nextActiveNodeId,
            reason: limitText(patch.reason || branch.summary || '', 180),
            node: {
                id: nodeId,
                type: 'ActionSequence',
                title: branch.title,
                branch_kind: targetNodeId === 'player_interaction' ? 'special' : 'base',
                priority: branch.priority,
                ttl_ms: branch.ttl_ms,
                trigger: branch.trigger,
                summary: branch.summary,
                steps: branch.steps
            },
            memory_delta: memoryDelta
        };
    }

    function normalizeBehaviorRepeatText(value) {
        return limitText(value, 320)
            .toLowerCase()
            .replace(/[\s"'“”‘’`.,，。！？!?、:：;；（）()[\]{}<>《》【】…—_\-~～]+/g, '');
    }

    function collectBehaviorNodeRepeatTexts(node = {}) {
        const entries = [];
        const pushText = (value, kind) => {
            const text = limitText(value, 180);
            const normalized = normalizeBehaviorRepeatText(text);
            if (normalized.length < 10) return;
            entries.push({ kind, text, normalized });
        };
        pushText(node.title, 'title');
        pushText(node.summary, 'summary');
        (Array.isArray(node.steps) ? node.steps : []).forEach((step) => {
            const action = String(step?.action || '').trim();
            if (!behaviorRepeatTextActions.has(action)) return;
            pushText(step.text, action);
        });
        return entries;
    }

    function collectRecentBehaviorSpecialNodes(behaviorTree = {}) {
        const nodes = behaviorTree?.nodes && typeof behaviorTree.nodes === 'object' ? behaviorTree.nodes : {};
        const playerChildren = new Set(Array.isArray(nodes.player_interaction?.children_ids) ? nodes.player_interaction.children_ids : []);
        const orderedIds = [];
        const pushId = (value) => {
            const id = limitText(value, 100);
            if (id && !orderedIds.includes(id)) orderedIds.push(id);
        };
        pushId(behaviorTree.active_node_id);
        (Array.isArray(behaviorTree.patch_history) ? behaviorTree.patch_history : []).forEach((item) => {
            pushId(item?.node_id || item?.nodeId || item?.next_active_node_id || item?.nextActiveNodeId);
        });
        playerChildren.forEach(pushId);
        Object.entries(nodes).forEach(([id, node]) => {
            if (node?.branch_kind === 'special' || node?.branchKind === 'special') pushId(id);
        });
        return orderedIds
            .map((id) => nodes[id])
            .filter((node) => node && Array.isArray(node.steps) && (playerChildren.has(node.id) || node.branch_kind === 'special' || node.branchKind === 'special'))
            .slice(0, 8);
    }

    function summarizeRecentBehaviorSpecialInteractions(behaviorTree = {}) {
        return collectRecentBehaviorSpecialNodes(behaviorTree).slice(0, 6).map((node) => ({
            node_id: limitText(node.id, 80),
            title: limitText(node.title, 80),
            summary: limitText(node.summary, 180),
            texts: collectBehaviorNodeRepeatTexts(node).map((entry) => entry.text).slice(0, 6)
        }));
    }

    function createBehaviorRepeatGrams(normalizedText) {
        const text = String(normalizedText || '');
        const size = text.length >= 18 ? 3 : 2;
        const grams = new Set();
        for (let index = 0; index <= text.length - size; index += 1) {
            grams.add(text.slice(index, index + size));
        }
        return grams;
    }

    function getBehaviorRepeatSimilarity(leftText, rightText) {
        const left = normalizeBehaviorRepeatText(leftText);
        const right = normalizeBehaviorRepeatText(rightText);
        if (left.length < 10 || right.length < 10) return 0;
        if (left === right) return 1;
        if (Math.min(left.length, right.length) >= 14 && (left.includes(right) || right.includes(left))) return 0.94;
        const leftGrams = createBehaviorRepeatGrams(left);
        const rightGrams = createBehaviorRepeatGrams(right);
        if (!leftGrams.size || !rightGrams.size) return 0;
        let overlap = 0;
        leftGrams.forEach((gram) => {
            if (rightGrams.has(gram)) overlap += 1;
        });
        const containment = overlap / Math.min(leftGrams.size, rightGrams.size);
        const jaccard = overlap / (leftGrams.size + rightGrams.size - overlap);
        return Math.max(jaccard, containment * 0.88);
    }

    function findDuplicateBehaviorInteraction(treePatch, inputPackage = {}) {
        const node = treePatch?.node;
        if (!node || node.branch_kind !== 'special') return null;
        const behaviorTree = inputPackage?.behavior_tree && typeof inputPackage.behavior_tree === 'object' ? inputPackage.behavior_tree : {};
        const existingNodes = behaviorTree.nodes && typeof behaviorTree.nodes === 'object' ? behaviorTree.nodes : {};
        if (existingNodes[node.id]) {
            return { reason: 'duplicate_node_id', node_id: node.id };
        }
        const generatedTexts = collectBehaviorNodeRepeatTexts(node).filter((entry) => entry.kind !== 'title' && entry.kind !== 'summary');
        if (!generatedTexts.length) return null;
        const recentEntries = collectRecentBehaviorSpecialNodes(behaviorTree)
            .flatMap((recentNode) => collectBehaviorNodeRepeatTexts(recentNode)
                .filter((entry) => entry.kind !== 'title' && entry.kind !== 'summary')
                .map((entry) => ({
                    ...entry,
                    node_id: recentNode.id,
                    title: recentNode.title || ''
                })));
        for (const generated of generatedTexts) {
            const duplicate = recentEntries.find((entry) => getBehaviorRepeatSimilarity(generated.normalized, entry.normalized) >= 0.82);
            if (duplicate) {
                return {
                    reason: 'duplicate_text',
                    text: generated.text,
                    previous_node_id: duplicate.node_id,
                    previous_title: duplicate.title
                };
            }
        }
        return null;
    }

    function inferBaseBehaviorTargetNode(triggerValue = '', fallback = 'wander') {
        const trigger = limitText(triggerValue, 100);
        if (trigger.includes('need') || trigger.includes('hunger') || trigger.includes('energy')) return 'hard_needs';
        if (trigger.includes('routine')) return 'routine_goal';
        if (trigger.includes('affordance') || trigger.includes('location')) return 'place_affordance';
        if (trigger.includes('mood')) return 'background_mood';
        if (trigger.includes('nearby')) return 'curiosity';
        if (trigger === 'idle') return 'idle_micro';
        return fallback;
    }

    function sanitizeBaseBehaviorBranch(rawBranch, char, payload = {}, fallbackReason = 'base_branch_invalid', allowedPlaceIds = []) {
        if (!rawBranch || typeof rawBranch !== 'object') return null;
        const rawTrigger = rawBranch.trigger || rawBranch.trigger_id || rawBranch.triggerId || 'otherwise';
        const requestedTarget = normalizeBehaviorNodeId(rawBranch.target_node_id || rawBranch.targetNodeId || '', 'target');
        const targetNodeId = behaviorBasePatchTargetIds.has(requestedTarget)
            ? requestedTarget
            : inferBaseBehaviorTargetNode(rawTrigger, 'wander');
        const steps = sanitizeBehaviorSteps(rawBranch.steps, allowedPlaceIds, 12, { allowChoices: false });
        if (!steps.length) return null;
        const nodeId = normalizeBehaviorNodeId(rawBranch.id || rawBranch.branch_id || `base_ai_${targetNodeId}_${Date.now().toString(36)}`, 'base_branch');
        const patchId = normalizeBehaviorNodeId(rawBranch.patch_id || rawBranch.patchId || `patch_${nodeId}_${Date.now().toString(36)}`, 'patch');
        return {
            patch_id: patchId,
            operation: 'upsert_child',
            target_node_id: targetNodeId,
            next_active_node_id: nodeId,
            reason: limitText(rawBranch.reason || rawBranch.summary || fallbackReason, 180),
            node: {
                id: nodeId,
                type: 'ActionSequence',
                title: limitText(rawBranch.title || '基础：街区行动', 80),
                branch_kind: 'base',
                priority: clamp(Number(rawBranch.priority) || 50, 1, 100),
                ttl_ms: clamp(Number(rawBranch.ttl_ms || rawBranch.ttlMs) || 45000, 3000, 120000),
                trigger: limitText(rawTrigger, 100),
                summary: limitText(rawBranch.summary || '', 180),
                steps
            },
            memory_delta: {}
        };
    }

    function sanitizeBaseBehaviorBranchPack(rawValue, char, payload = {}, fallbackReason = 'base_pack_invalid', allowedPlaceIds = []) {
        const rawBranches = Array.isArray(rawValue?.base_branches)
            ? rawValue.base_branches
            : (Array.isArray(rawValue?.branches) ? rawValue.branches : (Array.isArray(rawValue) ? rawValue : []));
        let patches = rawBranches
            .map((branch) => sanitizeBaseBehaviorBranch(branch, char, payload, fallbackReason, allowedPlaceIds))
            .filter(Boolean)
            .slice(0, 20);
        const baseBranches = patches.map((patch) => ({
            id: patch.node.id,
            branch_id: patch.node.id,
            target_node_id: patch.target_node_id,
            title: patch.node.title,
            priority: patch.node.priority,
            ttl_ms: patch.node.ttl_ms,
            trigger: patch.node.trigger,
            summary: patch.node.summary,
            steps: patch.node.steps,
            branch_kind: 'base'
        }));
        return { base_branches: baseBranches, base_patches: patches, fallback: false };
    }

    function summarizeBehaviorCharacter(char) {
        const emotion = deriveEmotion(char);
        return {
            id: char.id,
            name: char.name,
            location: char.location || 'home',
            city_status: char.city_status || 'idle',
            wallet: char.wallet ?? 0,
            calories: char.calories ?? 2000,
            energy: char.energy ?? 100,
            mood: char.mood ?? 50,
            stress: char.stress ?? 20,
            social_need: char.social_need ?? 50,
            health: char.health ?? 100,
            emotion_state: emotion.state,
            emotion_label: emotion.label
        };
    }

    function summarizeBehaviorCity(db, char) {
        const config = db.city.getConfig();
        const selfLimit = Math.max(1, parseInt(config.city_self_log_limit, 10) || 5);
        const announcementLimit = Math.max(1, parseInt(config.city_announcement_limit, 10) || 5);
        const globalLimit = Math.max(1, parseInt(config.city_global_log_limit, 10) || 5);
        return {
            date: getCityDate(config).toISOString(),
            config_limits: {
                city_self_log_limit: selfLimit,
                city_announcement_limit: announcementLimit,
                city_global_log_limit: globalLimit
            },
            enabled_districts: db.city.getEnabledDistricts?.() || [],
            current_district: db.city.getDistrict?.(char.location) || null,
            recent_self_logs: db.city.getCharacterRecentLogs?.(char.id, selfLimit) || [],
            announcements: db.city.getCityAnnouncements?.(announcementLimit) || [],
            global_logs: db.city.getCityLogs?.(globalLimit) || [],
            active_events: db.city.getActiveEvents?.() || [],
            active_quests: db.city.getActiveQuests?.() || [],
            active_quest_claim: db.city.getCharacterActiveQuestClaim?.(char.id) || null,
            inventory: db.city.getInventory?.(char.id) || []
        };
    }

    function summarizeSemanticBehaviorWorld(rawWorld = {}) {
        const raw = rawWorld && typeof rawWorld === 'object' ? rawWorld : {};
        const rawPlaces = Array.isArray(raw.places_ordered || raw.placesOrdered)
            ? (raw.places_ordered || raw.placesOrdered)
            : (Array.isArray(raw.places) ? raw.places : []);
        const placesOrdered = rawPlaces.slice(0, 80).map((place, index) => ({
            order: clamp(Number(place?.order) || index + 1, 1, 999),
            id: limitText(place?.id || place?.place_id || place?.placeId || '', 80),
            location_id: limitText(place?.location_id || place?.locationId || '', 80),
            location_ids: Array.isArray(place?.location_ids || place?.locationIds)
                ? (place.location_ids || place.locationIds).slice(0, 8).map((id) => limitText(id, 80)).filter(Boolean)
                : [],
            label: limitText(place?.label || place?.name || '', 80),
            kind: limitText(place?.kind || place?.type || '', 60),
            actions: Array.isArray(place?.actions) ? place.actions.slice(0, 8).map((action) => limitText(action, 40)).filter(Boolean) : [],
            aliases: Array.isArray(place?.aliases) ? place.aliases.slice(0, 8).map((alias) => limitText(alias, 40)).filter(Boolean) : []
        })).filter((place) => place.id && place.label);
        const placeIdSet = new Set(placesOrdered.map((place) => place.id));
        let allowedPlaceIds = normalizeAllowedBehaviorPlaceIds(raw.allowed_place_ids || raw.allowedPlaceIds);
        if (placeIdSet.size) {
            allowedPlaceIds = allowedPlaceIds.filter((id) => placeIdSet.has(id));
        }
        if (!allowedPlaceIds.length) {
            allowedPlaceIds = placesOrdered.map((place) => place.id).filter(Boolean);
        }
        const allowedPlaceIdSet = new Set(allowedPlaceIds);
        const rawMovementActions = Array.isArray(raw.allowed_movement_actions || raw.allowedMovementActions)
            ? (raw.allowed_movement_actions || raw.allowedMovementActions)
            : [];
        const allowedMovementActions = rawMovementActions
            .map((action) => {
                const id = limitText(action?.id || action, 80);
                if (!behaviorSemanticMovementActionSet.has(id)) return null;
                const fallbackAction = behaviorSemanticMovementActions.find((item) => item.id === id) || { id, needs: [], description: '' };
                return {
                    id,
                    label: limitText(action?.label || fallbackAction.label || id, 40),
                    needs: Array.isArray(action?.needs) ? action.needs.slice(0, 4).map((need) => limitText(need, 40)).filter(Boolean) : fallbackAction.needs,
                    description: limitText(action?.description || fallbackAction.description || '', 100)
                };
            })
            .filter(Boolean);
        const movementActions = allowedMovementActions.length ? allowedMovementActions : behaviorSemanticMovementActions;
        const selectedRaw = raw.selected_place && typeof raw.selected_place === 'object' ? raw.selected_place : null;
        const selectedPlaceId = selectedRaw
            ? toAllowedBehaviorPlaceId(selectedRaw.place_id || selectedRaw.placeId || selectedRaw.id || selectedRaw.place?.id || '', allowedPlaceIdSet)
            : '';
        const selectedPlace = selectedRaw && selectedPlaceId
            ? {
                id: selectedPlaceId,
                label: limitText(selectedRaw.label || placesOrdered.find((place) => place.id === selectedPlaceId)?.label || '', 80),
                place_id: selectedPlaceId
            }
            : null;
        const orderedPlaceText = limitText(
            raw.ordered_place_text || raw.orderedPlaceText || placesOrdered.map((place) => `${place.order}. ${place.label}`).join(' -> '),
            1200
        );
        return {
            movement_model: 'side_scrolling_semantic_v1',
            movement_rule: '角色只能从 allowed_place_ids 选择语义地点，只能从 allowed_movement_actions 选择移动动作；不要决定像素坐标。像素锚点、碰撞和平移移动由前端执行器本地映射。',
            ordered_place_text: orderedPlaceText,
            allowed_place_ids: allowedPlaceIds,
            allowed_movement_actions: movementActions,
            actors: raw.actors || {},
            selected_place: selectedPlace,
            places_ordered: placesOrdered,
            travel_targets: placesOrdered.map((place) => ({ id: place.id, label: place.label })),
            free_activity_options: Array.isArray(raw.free_activity_options || raw.freeActivityOptions)
                ? (raw.free_activity_options || raw.freeActivityOptions).slice(0, 20).map((item) => limitText(item, 80)).filter(Boolean)
                : movementActions.map((action) => `${action.id}: ${action.description || action.label}`).slice(0, 20)
        };
    }

    async function buildBehaviorInputPackage(userId, db, char, payload = {}) {
        const engineContextWrapper = { getUserDb: context.getUserDb, getMemory: context.getMemory, userId, forceCityDetail: true };
        const universalResult = await buildUniversalContext(engineContextWrapper, char, '', false);
        const userProfile = db.getUserProfile?.() || {};
        const world = summarizeSemanticBehaviorWorld(payload.world || payload.renderer || {});
        return {
            input_kind: 'commercial_street_behavior_input_v1',
            generated_at: new Date().toISOString(),
            character: summarizeBehaviorCharacter(char),
            user: {
                id: userId,
                name: userProfile.name || '用户'
            },
            player_event: payload.player_event || {},
            behavior_tree: payload.behavior_tree && typeof payload.behavior_tree === 'object' ? payload.behavior_tree : null,
            recent_special_interactions: summarizeRecentBehaviorSpecialInteractions(payload.behavior_tree || {}),
            world,
            input_policy: {
                large_input_enabled: true,
                private_chat_can_trigger_behavior: false,
                city_activity_can_trigger_behavior: false,
                rule: '读取大输入库作为背景材料，但私聊和商业街活动记录不得触发小人移动、发起互动、改变目的地或重写基础枝丫。'
            },
            large_input: {
                source: 'buildUniversalContext(forceCityDetail=true)',
                usage: 'background_only',
                blocked_triggers: ['private_chat', 'city_activity', 'commercial_street_activity'],
                preamble: universalResult.preamble || '',
                breakdown: universalResult.breakdown || {},
                module_routes: universalResult.moduleRoutes || {},
                anti_repeat_hints: universalResult.antiRepeatHints || null
            },
            output_contract: getBehaviorOutputContract(world)
        };
    }

    async function createBehaviorBranchWithModel(char, inputPackage, payload = {}) {
        const payloadEndpoint = limitText(payload.api_endpoint || payload.endpoint || '', 500);
        const payloadKey = String(payload.api_key || payload.key || '').trim();
        const usePayloadCredentials = Boolean(payloadEndpoint && payloadKey);
        const apiEndpoint = usePayloadCredentials ? payloadEndpoint : limitText(char?.api_endpoint || '', 500);
        const apiKey = usePayloadCredentials ? payloadKey : String(char?.api_key || '').trim();
        const modelName = limitText(payload.model_name || payload.model || char?.model_name || '', 200);
        if (!apiEndpoint || !apiKey || !modelName) {
            throw createCityError('行为树生成缺少模型 URL/Key/模型名，请补全后重试。', 400, true);
        }
        const messages = [
            {
                role: 'system',
                content: [
                    '你是“单角色街区行为运行时 V1”的完整行为树 patch 生成器。',
                    '你只返回一个 JSON 对象，不要输出 markdown、解释或额外文本。',
                    '你的任务不是替换整棵树，而是基于 input.behavior_tree 返回一个局部 patch，合并进现有完整行为树。',
                    '基础枝丫是角色无玩家互动时自己的生活、闲逛、地点行为；玩家互动后的后续分歧才叫特殊枝丫。',
                    '本接口正在响应玩家互动，所以 patch.operation 固定为 upsert_child，target_node_id 必须是 player_interaction，并设置 next_active_node_id 为本次 node.id。',
                    '这通常是玩家在预制互动枝丫末尾选择某个回应后的后续枝丫；请承接 input.player_event，不要重复预制开场。',
                    '除非明确要结束互动，否则特殊枝丫最后一步必须是 offer_choices，给 2-4 个玩家回应选项；choice.trigger 必须来自玩家互动动作白名单。',
                    'input.recent_special_interactions 是最近特殊互动台词，禁止复写这些台词、开头、收尾或同一情绪推进。',
                    '你可以读取 input.large_input，但它只是背景材料。最近私聊、朋友圈、商业街活动记录、公告任务不能作为小人移动、发起互动、改变目的地或重写基础枝丫的原因。',
                    '特殊枝丫只能由当前 input.player_event 触发；基础枝丫只由 runtime_state、location、nearby_player、otherwise、idle 等本地运行时触发。',
                    '角色可以自由决定在商业街做什么，但不要输出 x/y、像素坐标、锚点或碰撞信息。',
                    '如果要移动，node.steps.action 必须从 input.world.allowed_movement_actions 里选择。',
                    '如果动作需要地点，place_id/from_place_id/to_place_id 必须从 input.world.allowed_place_ids 里选择。',
                    '不要编造表外地点、表外动作、像素点或地图对象。',
                    `node.steps.action 只能使用：${behaviorTreeAllowedActions.join(', ')}。`
                ].join('\n')
            },
            {
                role: 'user',
                content: [
                    '基于下面输入，为角色小人生成一个短小、可玩、能合并进完整行为树的局部 patch。',
                    '优先且只响应当前 player_event。large_input.preamble 可以帮助理解角色语气和背景，但不要因为最近私聊或商业街活动记录让角色行动。',
                    '请把玩家互动造成的分歧写成 player_interaction 下的新 ActionSequence 节点；不要改写基础枝丫，除非输入明确要求重规划角色的无互动默认行为。',
                    '如果 input.behavior_tree.patch_history 里已有上一轮互动，请让新 node 承接上一轮，而不是重复开场。',
                    '如果 input.recent_special_interactions 有内容，请承接最近状态并换新的推进，不要复用里面的句子或相同问法。',
                    '最后给出 offer_choices 让玩家继续选择；这些选择会触发下一轮特殊枝丫生成。',
                    'world 是语义街区，不是大世界地图；不要让角色选择具体像素点。',
                    'world.places_ordered 是从左到右的可用建筑表，world.allowed_place_ids 是唯一可用地点 ID 白名单。',
                    'world.allowed_movement_actions 是唯一可用移动动作白名单。',
                    '输出格式必须符合 input.output_contract.schema。',
                    '',
                    JSON.stringify(inputPackage, null, 2)
                ].join('\n')
            }
        ];
        const rawOutput = await callLLM({
            endpoint: apiEndpoint,
            key: apiKey,
            model: modelName,
            messages,
            maxTokens: 1800,
            temperature: 0.72
        });
        let parsed = null;
        try {
            parsed = parseJsonObjectFromLlmText(rawOutput);
        } catch (err) {
            throw createCityError(`行为树生成返回的 JSON 无法解析，请重试：${err.message || 'parse_failed'}`, 502, true);
        }
        const treePatch = sanitizeBehaviorTreePatch(
            parsed,
            char,
            payload,
            'model_output_invalid',
            inputPackage?.world?.allowed_place_ids || []
        );
        if (!treePatch) {
            throw createCityError('行为树生成结果没有可用的行为步骤，请重试。', 502, true);
        }
        const duplicate = findDuplicateBehaviorInteraction(treePatch, inputPackage);
        if (duplicate) {
            throw createCityError('特殊枝丫生成疑似重复上一轮内容，请重试。', 502, true);
        }
        const branch = {
            branch_id: treePatch.node.id,
            title: treePatch.node.title,
            priority: treePatch.node.priority,
            ttl_ms: treePatch.node.ttl_ms,
            trigger: treePatch.node.trigger,
            summary: treePatch.node.summary,
            steps: treePatch.node.steps
        };
        return {
            tree_patch: treePatch,
            branch,
            raw_output: String(rawOutput || ''),
            fallback: false
        };
    }

    async function createBaseBehaviorBranchesWithModel(char, inputPackage, payload = {}) {
        const payloadEndpoint = limitText(payload.api_endpoint || payload.endpoint || '', 500);
        const payloadKey = String(payload.api_key || payload.key || '').trim();
        const usePayloadCredentials = Boolean(payloadEndpoint && payloadKey);
        const apiEndpoint = usePayloadCredentials ? payloadEndpoint : limitText(char?.api_endpoint || '', 500);
        const apiKey = usePayloadCredentials ? payloadKey : String(char?.api_key || '').trim();
        const modelName = limitText(payload.model_name || payload.model || char?.model_name || '', 200);
        const baseInput = {
            ...inputPackage,
            output_contract: getBehaviorBaseOutputContract(inputPackage?.world || {})
        };
        if (!apiEndpoint || !apiKey || !modelName) {
            throw createCityError('基础枝丫生成缺少模型 URL/Key/模型名，请补全后重试。', 400, true);
        }
        const messages = [
            {
                role: 'system',
                content: [
                    '你是“单角色街区行为运行时 V1”的基础枝丫包生成器。',
                    '你只返回一个 JSON 对象，不要输出 markdown、解释或额外文本。',
                    '本接口只生成基础枝丫：角色没有被玩家互动打断时，自己在街区里的生活、闲逛、好奇、地点停留和轻微说话。',
                    '不要生成 player_interaction，不要生成特殊互动后续，不要等待玩家选择，不要使用 offer_choices。',
                    '你可以读取 input.large_input，但它只是背景材料。最近私聊、朋友圈、商业街活动记录、公告任务不能作为小人移动、发起互动、改变目的地或重写基础枝丫的原因。',
                    '基础枝丫只能由 runtime_state、location、nearby_player、otherwise、idle 等本地运行时触发。',
                    '角色可以自由决定在商业街做什么，但不要输出 x/y、像素坐标、锚点或碰撞信息。',
                    '如果要移动，steps.action 必须从 input.world.allowed_movement_actions 里选择。',
                    '如果动作需要地点，place_id/from_place_id/to_place_id 必须从 input.world.allowed_place_ids 里选择。',
                    '不要编造表外地点、表外动作、像素点或地图对象。',
                    '生成 12 到 20 条基础枝丫，尽量分布到 hard_needs/routine_goal/place_affordance/background_mood/curiosity/wander/idle_micro。',
                    `steps.action 只能使用：${behaviorTreeAllowedActions.filter((action) => action !== 'offer_choices').join(', ')}。`
                ].join('\n')
            },
            {
                role: 'user',
                content: [
                    '基于下面输入，生成一批基础枝丫包。',
                    '这些枝丫会写入完整行为树的基础分类节点，并进入自动轮询池。',
                    '每条枝丫 3-6 个步骤，至少包含一个移动或 idle_at_place，最好穿插一句短台词或一个 emote。',
                    '不要因为最近私聊或商业街活动记录让角色行动；它们只能影响语气、轻微心情和说话风格。',
                    '输出格式必须是：{"base_branches":[...]}，每项符合 input.output_contract.schema.base_branches[0]。',
                    '',
                    JSON.stringify(baseInput, null, 2)
                ].join('\n')
            }
        ];
        const rawOutput = await callLLM({
            endpoint: apiEndpoint,
            key: apiKey,
            model: modelName,
            messages,
            maxTokens: 5200,
            temperature: 0.76
        });
        let parsed = null;
        try {
            parsed = parseJsonObjectFromLlmText(rawOutput);
        } catch (err) {
            throw createCityError(`基础枝丫生成返回的 JSON 无法解析，请重试：${err.message || 'parse_failed'}`, 502, true);
        }
        const sanitized = sanitizeBaseBehaviorBranchPack(
            parsed,
            char,
            payload,
            'model_output_invalid',
            inputPackage?.world?.allowed_place_ids || []
        );
        if (!sanitized.base_patches.length) {
            throw createCityError('基础枝丫生成结果没有可用的行为步骤，请重试。', 502, true);
        }
        return {
            ...sanitized,
            raw_output: String(rawOutput || ''),
            fallback: false
        };
    }

    app.get('/api/city/characters/:characterId/behavior-models', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const char = req.db.getCharacter(req.params.characterId);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            if (!char.api_endpoint || !char.api_key) return res.status(400).json({ error: '绑定角色没有可用的 URL/Key' });
            const models = await fetchBehaviorModelList(char.api_endpoint, char.api_key);
            res.json({
                success: true,
                models,
                endpoint: char.api_endpoint || '',
                model_name: char.model_name || ''
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/city/characters/:characterId/behavior-input', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const char = req.db.getCharacter(req.params.characterId);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            const input = await buildBehaviorInputPackage(req.user.id, req.db, char, req.body || {});
            res.json({ success: true, skeleton: getBehaviorTreeSkeleton(), input });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/city/characters/:characterId/behavior-base-branches', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const char = req.db.getCharacter(req.params.characterId);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            const input = await buildBehaviorInputPackage(req.user.id, req.db, char, req.body || {});
            const generated = await createBaseBehaviorBranchesWithModel(char, input, req.body || {});
            res.json({
                success: true,
                skeleton: getBehaviorTreeSkeleton(),
                input: {
                    ...input,
                    output_contract: getBehaviorBaseOutputContract(input?.world || {})
                },
                base_branches: generated.base_branches,
                base_patches: generated.base_patches,
                raw_output: generated.raw_output,
                fallback: !!generated.fallback,
                error: generated.error || ''
            });
        } catch (e) {
            res.status(e.status || 500).json({
                error: e.message,
                ...(e.canRetry ? { canRetry: true } : {})
            });
        }
    });

    app.post('/api/city/characters/:characterId/behavior-branch', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const char = req.db.getCharacter(req.params.characterId);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            const input = await buildBehaviorInputPackage(req.user.id, req.db, char, req.body || {});
            const generated = await createBehaviorBranchWithModel(char, input, req.body || {});
            res.json({
                success: true,
                skeleton: getBehaviorTreeSkeleton(),
                input,
                tree_patch: generated.tree_patch,
                branch: generated.branch,
                raw_output: generated.raw_output,
                fallback: !!generated.fallback,
                error: generated.error || ''
            });
        } catch (e) {
            res.status(e.status || 500).json({
                error: e.message,
                ...(e.canRetry ? { canRetry: true } : {})
            });
        }
    });

    registerCoreCityRoutes(app, {
        authMiddleware,
        ensureCityDb,
        deriveEmotion,
        normalizeDistrictPayload,
        normalizeItemPayload,
        getCityDate,
        runTimeSkipBackfill,
        triggerAdminGrantChat,
        getWsClients,
        getEngine,
        isCollapsedCityLog,
        regenerateActionNarrations,
        handleQuestLifecycleAfterAction
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

    function getPassiveTickIntervalMinutes(frequency) {
        const safeFrequency = Math.max(1, Math.min(30, parseInt(frequency, 10) || 1));
        return Math.max(1, Math.round(20 / safeFrequency));
    }

    function getMedicalStayMinutes(district) {
        const durationTicks = Math.max(1, parseInt(district?.duration_ticks, 10) || 1);
        return Math.max(MEDICAL_RECOVERY_INTERVAL_MINUTES, durationTicks * MEDICAL_STAY_MINUTES_PER_TICK);
    }

    function getMedicalStatusTiming(char, fallbackNowMs) {
        const startedAt = Number(char.city_status_started_at || 0) || fallbackNowMs;
        let untilAt = Number(char.city_status_until_at || 0) || 0;
        if (!untilAt || untilAt <= startedAt) {
            untilAt = startedAt + MEDICAL_STAY_MINUTES_PER_TICK * 60 * 1000;
        }
        const lastRecoveryAt = Number(char.city_medical_last_recovery_at || 0) || startedAt;
        return { startedAt, untilAt, lastRecoveryAt };
    }

    function settleMedicalRecovery(char, district, cityNowMs) {
        if (char.city_status !== 'medical') return null;
        const { startedAt, untilAt, lastRecoveryAt } = getMedicalStatusTiming(char, cityNowMs);
        const effectiveEnd = Math.min(cityNowMs, untilAt);
        const completedBefore = Math.max(0, Math.floor((Math.max(lastRecoveryAt, startedAt) - startedAt) / MEDICAL_RECOVERY_INTERVAL_MS));
        const completedNow = Math.max(0, Math.floor((Math.max(effectiveEnd, startedAt) - startedAt) / MEDICAL_RECOVERY_INTERVAL_MS));
        const intervalsToApply = completedNow - completedBefore;
        if (intervalsToApply <= 0) return null;

        const stayIntervals = Math.max(1, Math.floor((untilAt - startedAt) / MEDICAL_RECOVERY_INTERVAL_MS));
        const calRewardTotal = Math.max(0, Number(district?.cal_reward || 0));
        const calPerInterval = calRewardTotal > 0 ? Math.max(1, Math.round(calRewardTotal / stayIntervals)) : 0;
        const effects = { energy: 0, sleep_debt: 0, stress: 0, social_need: 0, health: 0, mood: 0, satiety: 0, stomach_load: 0 };

        for (let i = 1; i <= intervalsToApply; i++) {
            const intervalIndex = completedBefore + i;
            effects.health += 3;
            if (intervalIndex % 2 === 0) effects.stress -= 1;
            if (intervalIndex % 3 === 0) {
                effects.energy += 1;
                effects.sleep_debt -= 1;
            }
        }

        const nextState = applyStateEffectsToCharacter(char, effects);
        const nextCalories = Math.min(4000, Math.max(0, (Number(char.calories || 0)) + calPerInterval * intervalsToApply));
        return {
            patch: {
                calories: nextCalories,
                energy: nextState.energy,
                sleep_debt: nextState.sleep_debt,
                mood: nextState.mood,
                stress: nextState.stress,
                social_need: nextState.social_need,
                health: nextState.health,
                satiety: nextState.satiety,
                stomach_load: nextState.stomach_load,
                city_medical_last_recovery_at: startedAt + completedNow * MEDICAL_RECOVERY_INTERVAL_MS
            },
            intervalsToApply
        };
    }

    function queueCityTask(userId, task, options = {}) {
        return enqueueBackgroundTask({
            key: `city:${userId}`,
            dedupeKey: options.dedupeKey ? `city:${userId}:${options.dedupeKey}` : '',
            maxPending: options.maxPending ?? 1,
            task
        });
    }

    // Tick every minute
    const tickRate = '* * * * *';

    if (CITY_BACKGROUND_SAFE_MODE && !CITY_LIGHT_TICK_MODE) {
        console.warn('[City DLC] CP_SAFE_MODE is enabled. Autonomous city cron is disabled for stability.');
    } else {
        if (CITY_BACKGROUND_SAFE_MODE && CITY_LIGHT_TICK_MODE) {
            console.warn('[City DLC] CP_SAFE_MODE is enabled. Running city cron in light mode.');
        }
        cron.schedule(tickRate, async () => {
        try {
            const users = authDb.getAllUsers();
            for (const user of users) {
                queueCityTask(
                    user.id,
                    async () => {
                        const db = context.getUserDb(user.id);
                        ensureCityDb(db);

                        const config = db.city.getConfig();
                        const cityActivityEnabled = !(config.dlc_enabled === '0' || config.dlc_enabled === 'false');
                        const physiologyPaused = config.city_actions_paused === '1' || config.city_actions_paused === 'true';
                        if (cityActivityEnabled) {
                            const mayorAutoResult = await maybeRunMayorAI(db, user.id);
                            if (mayorAutoResult?.success) {
                                console.log(`[Mayor AI] 自动决策已执行 (${user.username || user.id})`);
                            }
                        }
                        if (!cityActivityEnabled && physiologyPaused) return;

                        const districts = db.city.getEnabledDistricts();

                    // Adjust metabolism drain to be per-minute based (originally 20 per 15-min tick)
                    // If old tick means 20 cals/15min, then 1 min = 20/15 = 1.33 cals per real-time minute.
                        const minuteMetabolism = normalizeMetabolismPerMinute(config);

                        const characters = db.getCharacters().filter(c =>
                            c.status === 'active' && c.sys_survival !== 0
                        );
                        if (characters.length === 0) return;

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
                        const cityNowMs = cityDate.getTime();
                        if (char.city_status === 'medical') {
                            const medicalDistrict = db.city.getDistrict(char.location || 'hospital') || { id: 'hospital', name: '医院', cal_reward: 0 };
                            const medicalRecovery = settleMedicalRecovery(char, medicalDistrict, cityNowMs);
                            if (medicalRecovery) {
                                db.updateCharacter(char.id, medicalRecovery.patch);
                                logEmotionTransitionToState(
                                    db,
                                    char,
                                    { ...char, ...medicalRecovery.patch },
                                    'city_medical_recovery',
                                    `角色在医院停留期间完成了 ${medicalRecovery.intervalsToApply} 次 5 分钟治疗结算，状态得到逐步恢复。`
                                );
                                Object.assign(char, medicalRecovery.patch);
                            }

                            const { untilAt } = getMedicalStatusTiming(char, cityNowMs);
                            if (cityNowMs >= untilAt) {
                                const dischargePatch = {
                                    city_status: (char.calories ?? 0) < 500 ? 'hungry' : 'idle',
                                    city_status_started_at: 0,
                                    city_status_until_at: 0,
                                    city_medical_last_recovery_at: 0
                                };
                                db.updateCharacter(char.id, dischargePatch);
                                Object.assign(char, dischargePatch);
                            }
                        }

                        const passiveInterval = getPassiveTickIntervalMinutes(char.city_action_frequency || 1);
                        const shouldApplyPassiveTick = currentMinute % passiveInterval === 0;

                        if (!physiologyPaused && shouldApplyPassiveTick) {
                            let currentCityStatus = char.city_status ?? 'idle';
                            const passiveState = applyPassiveSurvivalTick(
                                { ...char, city_status: currentCityStatus },
                                char.calories ?? 2000,
                                currentMinute,
                                passiveInterval,
                                minuteMetabolism
                            );
                            let currentCals = passiveState.calories;
                            if (currentCals < 500 && currentCityStatus === 'idle') currentCityStatus = 'hungry';
                            if (currentCals === 0 && currentCityStatus !== 'coma') currentCityStatus = 'coma';

                            if (
                                char.calories !== currentCals ||
                                char.city_status !== currentCityStatus ||
                                char.energy !== passiveState.energy ||
                                char.sleep_debt !== passiveState.sleep_debt ||
                                char.mood !== passiveState.mood ||
                                char.stress !== passiveState.stress ||
                                char.social_need !== passiveState.social_need ||
                                char.health !== passiveState.health ||
                                char.satiety !== passiveState.satiety ||
                                char.stomach_load !== passiveState.stomach_load
                            ) {
                                const passivePatch = {
                                    calories: currentCals,
                                    city_status: currentCityStatus,
                                    energy: passiveState.energy,
                                    sleep_debt: passiveState.sleep_debt,
                                    mood: passiveState.mood,
                                    stress: passiveState.stress,
                                    social_need: passiveState.social_need,
                                    health: passiveState.health,
                                    satiety: passiveState.satiety,
                                    stomach_load: passiveState.stomach_load
                                };
                                db.updateCharacter(char.id, passivePatch);
                                logEmotionTransitionToState(
                                    db,
                                    char,
                                    { ...char, ...passivePatch },
                                    'city_passive_tick',
                                    `商业街中的时间流逝按该角色的活动频率节奏结算了一次生理变化（约每 ${passiveInterval} 分钟一次）。`
                                );
                                broadcastCityEvent(user.id, char.id, 'state_tick', null);
                                Object.assign(char, passivePatch);
                            }
                        }

                        if (CITY_BACKGROUND_SAFE_MODE && CITY_LIGHT_TICK_MODE && !CITY_ENABLE_AUTONOMOUS_ACTIONS) {
                            continue;
                        }

                        if (!cityActivityEnabled) {
                            continue;
                        }

                        // Generate schedule at 6:00 sharp; maybeGenerateSchedule is idempotent and only generates once per day
                        if (CITY_ENABLE_SCHEDULE_GENERATION && cityDate.getHours() >= 6 && char.api_endpoint && char.api_key && char.model_name) {
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
                            if (CITY_ENABLE_SOCIAL_COLLISIONS) {
                                await checkSocialCollisions(socialCandidates, db, user.id, districts, config, minuteKey);
                            }
                        } else if (!cityActivityEnabled && !physiologyPaused) {
                            console.log(`[City] ⏸️ ${user.username}: 商业街活动已暂停，仅保留生理流逝 (${hourString}:${String(currentMinute).padStart(2, '0')})`);
                        } else if (cityActivityEnabled && physiologyPaused) {
                            console.log(`[City] 🫀 ${user.username}: 生理流逝已暂停，商业街活动继续运行 (${hourString}:${String(currentMinute).padStart(2, '0')})`);
                        } else if (!cityActivityEnabled && physiologyPaused) {
                            console.log(`[City] ⏹️ ${user.username}: 商业街活动与生理流逝均已暂停 (${hourString}:${String(currentMinute).padStart(2, '0')})`);
                        }
                    },
                    {
                        dedupeKey: `minute:${new Date().toISOString().slice(0, 16)}`,
                        maxPending: 1
                    }
                ).catch((e) => {
                    console.error(`[City] 用户 ${user.username} 出错:`, e.message);
                });
            }
        } catch (e) {
            console.error('[City] 致命错误:', e.message);
        }
        });
    }

    // Core simulation

    async function simulateCharacter(char, db, userId, districts, config, metabolismRate) {
        let currentCals = Math.max(0, (char.calories ?? 2000) - metabolismRate);
        let currentCityStatus = char.city_status ?? 'idle';
        const cityNowMs = getCityDate(config).getTime();

        if (currentCityStatus === 'medical') {
            const { untilAt } = getMedicalStatusTiming(char, cityNowMs);
            if (cityNowMs < untilAt) {
                db.updateCharacter(char.id, { calories: currentCals, city_status: currentCityStatus });
                return;
            }
            currentCityStatus = currentCals < 500 ? 'hungry' : 'idle';
            const releaseMedicalPatch = {
                calories: currentCals,
                city_status: currentCityStatus,
                city_status_started_at: 0,
                city_status_until_at: 0,
                city_medical_last_recovery_at: 0
            };
            db.updateCharacter(char.id, releaseMedicalPatch);
            Object.assign(char, releaseMedicalPatch);
        }

        // Auto-eat from backpack when very hungry
        if (currentCals < 800) {
            const foodItems = db.city.getInventoryFoodItems(char.id);
            if (foodItems.length > 0) {
                const food = foodItems[0]; // eat the most calorie-dense item
                db.city.removeFromInventory(char.id, food.item_id, 1);
                currentCals = Math.min(4000, currentCals + food.cal_restore);
                const satietyBoost = clamp(Math.round((food.cal_restore || 0) / 18), 8, 28);
                const loadBoost = clamp(Math.round((food.cal_restore || 0) / 24), 6, 22);
                const eatState = applyStateEffectsToCharacter(char, {
                    energy: 8,
                    stress: -4,
                    mood: 3,
                    health: 1,
                    satiety: satietyBoost,
                    stomach_load: loadBoost,
                    sleep_debt: Math.round(loadBoost * 0.6)
                });
                db.city.logAction(char.id, 'EAT', `${char.name} 从背包里吃了 ${food.emoji}${food.name} (+${food.cal_restore}卡) 🍜`, food.cal_restore, 0, char.location || 'home');
                broadcastCityEvent(userId, char.id, 'EAT', `${char.name} 吃了 ${food.emoji}${food.name}`);
                if (Math.random() < 0.1) broadcastCityToChat(userId, char, `刚吃了 ${food.emoji}${food.name}，感觉好多了。`, 'EAT');
                currentCityStatus = currentCals > 500 ? 'idle' : 'hungry';
                const autoEatPatch = { calories: currentCals, city_status: currentCityStatus, ...eatState };
                db.updateCharacter(char.id, autoEatPatch);
                logEmotionTransitionToState(
                    db,
                    char,
                    { ...char, ...autoEatPatch },
                    'city_auto_eat',
                    `角色因为饥饿自动吃了 ${food.name}，生理状态和主情绪随之改变。`
                );
                return; // eating takes one tick
            }
        }

        if (currentCals === 0) {
            const comaState = applyStateEffectsToCharacter(char, { energy: -15, stress: 10, health: -8, mood: -10 });
            const starvePatch = { calories: 0, city_status: 'coma', ...comaState };
            db.updateCharacter(char.id, starvePatch);
            logEmotionTransitionToState(
                db,
                char,
                { ...char, ...starvePatch },
                'city_starvation',
                '角色在商业街中因极度饥饿接近崩溃，情绪和生理状态明显恶化。'
            );
            db.city.logAction(char.id, 'STARVE', `${char.name} 因为饥饿晕倒了 😵`, -metabolismRate, 0);
            broadcastCityEvent(userId, char.id, 'STARVE', `${char.name} 饿晕了！`);
            broadcastCityToChat(userId, char, `我快饿晕了……能帮帮我吗 😩`, 'STARVE');
            return;
        }

        if (currentCals < 500) currentCityStatus = 'hungry';
        db.updateCharacter(char.id, { calories: currentCals, city_status: currentCityStatus });

        // Busy -> release
        if (['working', 'sleeping', 'eating', 'coma'].includes(currentCityStatus)) {
            const releasePatch = { city_status: currentCals < 500 ? 'hungry' : 'idle' };
            if (currentCityStatus === 'working') {
                const distraction = clamp(parseInt(char.work_distraction ?? 0, 10) || 0, 0, 100);
                if (distraction > 0) {
                    const penaltyMoney = Math.min(char.wallet || 0, Math.max(1, Math.ceil(distraction / 6)));
                    releasePatch.wallet = Math.max(0, (char.wallet || 0) - penaltyMoney);
                    releasePatch.stress = clamp((char.stress ?? 20) + Math.max(1, Math.ceil(distraction / 10)), 0, 100);
                    releasePatch.mood = clamp((char.mood ?? 50) - Math.max(1, Math.ceil(distraction / 12)), 0, 100);
                    const district = db.city.getDistrict(char.location || '');
                    const workLog = await buildBusyPenaltyNarration(char, 'work', penaltyMoney, district?.name || char.location || '工作地点', db);
                    if (workLog) {
                        db.city.logAction(char.id, 'WORK_DISTRACT', workLog, 0, -penaltyMoney, char.location || '');
                        broadcastCityEvent(userId, char.id, 'WORK_DISTRACT', workLog);
                    }
                }
                releasePatch.work_distraction = 0;
            } else if (currentCityStatus === 'sleeping') {
                const disruption = clamp(parseInt(char.sleep_disruption ?? 0, 10) || 0, 0, 100);
                if (disruption > 0) {
                    const extraDebt = Math.max(1, Math.ceil(disruption / 8));
                    releasePatch.sleep_debt = clamp((char.sleep_debt ?? 0) + extraDebt, 0, 100);
                    releasePatch.energy = clamp((char.energy ?? 100) - Math.max(1, Math.ceil(disruption / 12)), 0, 100);
                    releasePatch.mood = clamp((char.mood ?? 50) - Math.max(1, Math.ceil(disruption / 14)), 0, 100);
                    const district = db.city.getDistrict(char.location || '');
                    const sleepLog = await buildBusyPenaltyNarration(char, 'sleep', extraDebt, district?.name || char.location || '休息地点', db);
                    if (sleepLog) {
                        db.city.logAction(char.id, 'SLEEP_DISTURB', sleepLog, 0, 0, char.location || '');
                        broadcastCityEvent(userId, char.id, 'SLEEP_DISTURB', sleepLog);
                    }
                }
                releasePatch.sleep_disruption = 0;
            }
            db.updateCharacter(char.id, releasePatch);
            return;
        }

        // Missing model config -> skip autonomous actions. Passive survival
        // ticks above still run, but city actions require generated intent/logs.
        const activeEvents = db.city.getActiveEvents();
        if (!char.api_endpoint || !char.api_key || !char.model_name) {
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

        const activeQuestClaim = db.city.getCharacterActiveQuestClaim?.(char.id) || null;
        if (activeQuestClaim?.target_district) {
            const questDistrict = districts.find((entry) => entry.id === activeQuestClaim.target_district);
            if (questDistrict) {
                targetDistrict = questDistrict;
            }
        }

        if (targetDistrict) {
            console.log(`[City] ${char.name} 📅 按日程前往 ${targetDistrict.emoji} ${targetDistrict.name} (准备生成文案)`);
        }

        // LLM decision with inventory awareness + active event context
        const inventory = db.city.getInventory(char.id);
        const engineContextWrapper = { getUserDb: context.getUserDb, getMemory: context.getMemory, userId, forceCityDetail: true };
        const universalResult = await buildUniversalContext(engineContextWrapper, char, '', false);
        const lastQuestReview = activeQuestClaim ? db.city.getLatestQuestProgressReviewForClaim?.(activeQuestClaim, char.id) : null;
        const recentQuestReviews = activeQuestClaim ? db.city.getRecentQuestProgressReviewsForClaim?.(activeQuestClaim, char.id, 4) || [] : [];
        const questContext = buildQuestPromptContext(db.city.getActiveQuests(), activeQuestClaim, lastQuestReview, recentQuestReviews);
        const prompt = buildSurvivalPrompt(districts, { ...char, calories: currentCals }, inventory, activeEvents, universalResult, targetDistrict, questContext, db);
        try {
            const messages = [
                { role: 'system', content: '你是一个城市生活模拟角色行动引擎。你必须严格按照用户要求返回完整 JSON 对象，不要输出 JSON 之外的解释、markdown 或额外文本。返回结果必须包含 action、log、chat、moment、diary 五个字段。' },
                { role: 'user', content: prompt }
            ];
            recordCityLlmDebug(db, char, 'input', 'city_action_decision', messages, { model: char.model_name, location: char.location || '', status: currentCityStatus });
            const reply = await callLLM({
                endpoint: char.api_endpoint, key: char.api_key, model: char.model_name,
                messages, maxTokens: 3000, temperature: 0.8,
                debugAttempt: buildCityAttemptRecorder(db, char, 'city_action_decision', {
                    location: char.location || '',
                    status: currentCityStatus
                })
            });
            recordCityLlmDebug(db, char, 'output', 'city_action_decision', reply, { model: char.model_name, location: char.location || '', status: currentCityStatus });
            const cleaned = String(reply || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
            if (!cleaned) throw new Error('商业街行动生成失败：模型没有返回 JSON 对象，请重试。');
            const richNarrations = JSON.parse(cleaned);
            if (!richNarrations || typeof richNarrations !== 'object' || Array.isArray(richNarrations)) {
                throw new Error('商业街行动生成失败：JSON 结构无效，请重试。');
            }
            const codeMatch = String(richNarrations.action || '').match(/^\[([A-Z_]+)\]$/)?.[1]?.toLowerCase();
            if (!codeMatch) {
                throw new Error('商业街行动生成失败：缺少有效 action 标签，请重试。');
            }
            const generatedLog = String(richNarrations.log || '').trim();
            if (!generatedLog) {
                throw new Error('商业街行动生成失败：缺少可用 log，请重试。');
            }

            // Handle EAT_ITEM action
            if (codeMatch === 'eat_item') {
                const foodItems = db.city.getInventoryFoodItems(char.id);
                if (!foodItems.length) throw new Error('商业街行动生成失败：模型选择 EAT_ITEM，但背包没有可食用物品，请重试。');
                const food = foodItems[0];
                db.city.removeFromInventory(char.id, food.item_id, 1);
                const newCals = Math.min(4000, currentCals + food.cal_restore);
                const satietyBoost = clamp(Math.round((food.cal_restore || 0) / 18), 8, 28);
                const loadBoost = clamp(Math.round((food.cal_restore || 0) / 24), 6, 22);
                const eatItemState = applyStateEffectsToCharacter(char, {
                    energy: 8,
                    stress: -4,
                    mood: 3,
                    health: 1,
                    satiety: satietyBoost,
                    stomach_load: loadBoost,
                    sleep_debt: Math.round(loadBoost * 0.6)
                });
                const eatItemPatch = { calories: newCals, city_status: newCals > 500 ? 'idle' : 'hungry', ...eatItemState };
                db.updateCharacter(char.id, eatItemPatch);
                logEmotionTransitionToState(
                    db,
                    char,
                    { ...char, ...eatItemPatch },
                    'city_eat_item',
                    `角色主动吃了背包中的 ${food.name}，生理状态和主情绪发生变化。`
                );
                const eatLog = generatedLog;
                db.city.logAction(char.id, 'EAT', eatLog, food.cal_restore, 0);
                broadcastCityEvent(userId, char.id, 'EAT', eatLog);
                broadcastCityToChat(userId, char, eatLog, 'EAT', richNarrations);
                console.log(`[City] ${char.name} -> 🍜 吃 ${food.name}`);
                return;
            }

            const district = districts.find(d => d.id === codeMatch);
            if (!district) {
                throw new Error(`商业街行动生成失败：action 不在可选地点中 (${codeMatch})，请重试。`);
            }

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
            await applyDecision(district, char, db, userId, currentCals, config, activeEvents, richNarrations, { preserveDirectedDistrict: true });
        } catch (e) {
            console.error(`[City] ${char.name} LLM 失败: ${e.message}`);
            return;
        }
    }

    function selectRandomDistrict(districts, char) {
        const cals = char.calories ?? 2000, wallet = char.wallet ?? 200;
        const state = normalizeSurvivalState(char);
        const emotionState = deriveEmotion(char).state;
        const physicalState = derivePhysicalState(char).state;
        // Check if char has food in inventory first
        if (cals < 500 && wallet >= 15) return districts.find(d => d.type === 'food') || districts[0];
        if (state.energy < 20) {
            return districts.find(d => d.type === 'rest')
                || districts.find(d => d.type === 'food')
                || districts[0];
        }
        if (cals < 300 || state.energy < 35 || state.sleep_debt > 75) return districts.find(d => d.type === 'rest') || districts[0];
        if (state.health < 35) return districts.find(d => d.type === 'medical') || districts[0];
        if (physicalState === 'unwell' || physicalState === 'severe_unwell') return districts.find(d => d.type === 'medical') || districts.find(d => d.type === 'rest') || districts[0];
        if (physicalState === 'sleepy' || physicalState === 'fatigued') return districts.find(d => d.type === 'rest') || districts[0];
        if (emotionState === 'hurt' || emotionState === 'sad') {
            return districts.find(d => d.type === 'rest')
                || districts.find(d => d.type === 'leisure')
                || districts.find(d => d.type === 'wander')
                || districts[0];
        }
        if (emotionState === 'lonely') {
            return districts.find(d => d.type === 'leisure')
                || districts.find(d => d.type === 'wander')
                || districts[0];
        }
        if (emotionState === 'angry' || emotionState === 'tense') {
            return districts.find(d => d.type === 'wander')
                || districts.find(d => d.type === 'leisure')
                || districts.find(d => d.type === 'work')
                || districts[0];
        }
        if (emotionState === 'happy') {
            return districts.find(d => d.type === 'leisure')
                || districts.find(d => d.type === 'wander')
                || districts.find(d => d.type === 'work')
                || districts[0];
        }
        if (emotionState === 'jealous') {
            return districts.find(d => d.type === 'leisure')
                || districts.find(d => d.type === 'wander')
                || districts.find(d => d.type === 'work')
                || districts[0];
        }
        if (state.social_need > 75 && state.mood < 45) return districts.find(d => d.type === 'leisure' || d.type === 'wander') || districts[0];
        if (state.energy > 85) {
            return districts.find(d => d.type === 'leisure')
                || districts.find(d => d.type === 'wander')
                || districts.find(d => d.type === 'work')
                || districts[0];
        }
        if (state.energy > 70) {
            return districts.find(d => d.type === 'wander')
                || districts.find(d => d.type === 'leisure')
                || districts.find(d => d.type === 'work')
                || districts[0];
        }
        if (wallet < 30) return districts.find(d => d.type === 'work') || districts[0];
        return districts[Math.floor(Math.random() * districts.length)];
    }

    function getQuestNarrationText(richNarrations = null) {
        return questService.getQuestNarrationText(richNarrations);
    }

    async function handleQuestLifecycleAfterAction(db, char, district, richNarrations = null, options = {}) {
        return questService.handleQuestLifecycleAfterAction(db, char, district, richNarrations, options);
    }

    async function applyDecision(district, char, db, userId, currentCals, config, activeEvents, richNarrations = null, options = {}) {
        return actionService.applyDecision(district, char, db, userId, currentCals, config, activeEvents, richNarrations, options);
    }

    function districtsFallbackForExhaustion(char, db) {
        const districts = db.city.getEnabledDistricts();
        return districts.find(d => d.type === 'rest')
            || districts.find(d => d.type === 'food')
            || districts.find(d => d.id === char.location)
            || districts[0]
            || null;
    }

    // Phase 5: social collision detection

    async function checkSocialCollisions(characters, db, userId, districts, config, minuteKey) {
        return socialService.checkSocialCollisions(characters, db, userId, districts, config, minuteKey);
    }

    async function runSocialEncounter(occupants, district, db, userId, yLimit) {
        return socialService.runSocialEncounter(occupants, district, db, userId, yLimit);
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

            const engineContextWrapper = { getUserDb: context.getUserDb, getMemory: context.getMemory, userId: context.userId, forceCityDetail: true };
            const universalResult = await buildUniversalContext(engineContextWrapper, char, '', false);
            const prompt = buildSchedulePrompt(char, districts, universalResult);
            const isGeminiModel = String(char.model_name || '').toLowerCase().includes('gemini');
            const scheduleSystemPrompt = isGeminiModel
                ? '你是一个极度严格的 JSON 数组生成器。你只能输出合法 JSON 数组，禁止任何解释、Markdown、代码块、注释、额外文本。若你开始输出 JSON，就必须完整闭合整个数组并结束。'
                : '你是一个日程规划助手。只返回一个 JSON 数组，每个元素都包含 hour、action 和 reason 三个字段。不要输出任何 JSON 之外的文字或 Markdown。';
            const messages = [
                { role: 'system', content: scheduleSystemPrompt },
                { role: 'user', content: prompt }
            ];
            recordCityLlmDebug(db, char, 'input', 'city_schedule_generate', messages, { model: char.model_name });
            const reply = await callLLM({
                endpoint: char.api_endpoint, key: char.api_key, model: char.model_name,
                messages, maxTokens: 3000, temperature: isGeminiModel ? 0.2 : 0.7
            });
            recordCityLlmDebug(db, char, 'output', 'city_schedule_generate', reply, { model: char.model_name });
            const plan = tryParseScheduleReply(reply);
            const valid = normalizeGeneratedSchedulePlan(plan, districts);
            if (valid) {
                db.city.saveSchedule(char.id, today, valid);
                const summary = valid.slice(0, 3).map(e => `${e.hour}:00 ${e.action}`).join(' -> ');
                db.city.logAction(char.id, 'PLAN', `${char.name} 制定了今日计划：${summary}... 📝`, 0, 0);
                console.log(`[City] ${char.name} 📝 日程已生成 (${valid.length} 个时段)`);

                // Broadcast success
                broadcastCityEvent(context.userId, char.id, 'schedule_updated', valid);
                return true;
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

    function publishQuestAnnouncement(db, questId, questData = {}) {
        try {
            const quest = db.city.getQuestById ? db.city.getQuestById(questId) : null;
            const targetDistrictId = quest?.target_district || questData.target_district || 'street';
            const targetDistrict = db.city.getDistrict(targetDistrictId);
            const locationLabel = targetDistrict ? `${targetDistrict.emoji}${targetDistrict.name}` : targetDistrictId;
            const rewardText = `${Number(quest?.reward_gold ?? questData.reward_gold ?? 0)}金币${Number(quest?.reward_cal ?? questData.reward_cal ?? 0) > 0 ? ` + ${Number(quest?.reward_cal ?? questData.reward_cal ?? 0)}体力` : ''}`;
            const content = `${quest?.emoji || questData.emoji || '📜'} ${quest?.title || questData.title || '悬赏任务'}｜前往 ${locationLabel} 处理：${quest?.description || questData.description || '待处理事项'}｜奖励：${rewardText}`;
            const announcementId = db.city.addCityAnnouncement('system', '悬赏任务', content, targetDistrictId);
            if (announcementId && typeof db.city.attachQuestAnnouncement === 'function') {
                db.city.attachQuestAnnouncement(questId, announcementId);
            }
            return announcementId;
        } catch (e) {
            console.warn('[City Quest] Failed to publish quest announcement:', e.message);
            return 0;
        }
    }

    function recordMayorAnnouncement(db, title, content) {
        if (!content || !String(content).trim()) return;
        try {
            if (typeof db.city.addCityAnnouncement === 'function') {
                db.city.addCityAnnouncement('mayor', title || '市长广播', String(content).trim(), 'street');
            }
        } catch (e) {
            console.warn('[Mayor AI] Failed to write city announcement:', e.message);
        }
    }

    const mayorService = createMayorService({
        callLLM,
        recordCityLlmDebug,
        publishQuestAnnouncement,
        recordMayorAnnouncement
    });

    const questService = createQuestService({
        callLLM,
        recordCityLlmDebug,
        buildCityAttemptRecorder,
        scoreQuestProgressWithMayor: (...args) => mayorService.scoreQuestProgressWithMayor(...args)
    });

    function parseCityWebIntentTag(text) {
        const raw = String(text || '');
        const match = raw.match(/\[WEB_SEARCH_INTENT:\s*([\s\S]*?)\]/i);
        if (!match) return null;
        const payload = String(match[1] || '').trim();
        if (!payload) return null;
        try {
            const parsed = JSON.parse(payload);
            const intent = {
                reason: String(parsed?.reason || '').trim(),
                query_hint: String(parsed?.query_hint || parsed?.query || '').trim()
            };
            return intent.reason || intent.query_hint ? intent : null;
        } catch (e) {
            return null;
        }
    }

    function stripCityWebIntentTag(text) {
        return String(text || '')
            .replace(/\[WEB_SEARCH_INTENT:\s*[\s\S]*?\]/gi, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function formatCityWebSearchKnowledge(searchResult) {
        const results = Array.isArray(searchResult?.results) ? searchResult.results.slice(0, 3) : [];
        return [
            `查询: ${searchResult?.query || ''}`,
            `来源: ${searchResult?.source || ''}`,
            `时间: ${searchResult?.fetched_at || new Date().toISOString()}`,
            '',
            ...results.map((item, index) => [
                `${index + 1}. ${item.title || item.url || 'Result'}`,
                item.snippet ? `摘要: ${item.snippet}` : '',
                item.page_text ? `来源正文: ${String(item.page_text).slice(0, 4000)}` : '',
                item.url ? `链接: ${item.url}` : ''
            ].filter(Boolean).join('\n'))
        ].join('\n').trim();
    }

    function formatCityWebResultBlock(searchResult, plan, intent) {
        const results = Array.isArray(searchResult?.results) ? searchResult.results.slice(0, 3) : [];
        return [
            '[刚刚查到的公开网页信息]',
            `查阅原因：${intent?.reason || '角色临时想确认一下'}`,
            `查询词：${searchResult?.query || plan?.queries?.[0] || intent?.query_hint || ''}`,
            `来源：${searchResult?.source || ''}`,
            '',
            ...results.map((item, index) => [
                `${index + 1}. ${item.title || item.url || '结果'}`,
                item.snippet ? `搜索摘要: ${item.snippet}` : '',
                item.page_text ? `来源正文摘录: ${String(item.page_text).slice(0, 3000)}` : '',
                item.url ? `链接: ${item.url}` : ''
            ].filter(Boolean).join('\n')),
            '',
            '[边界]',
            '- 这是角色刚刚看手机/上网查到的信息，不是亲身经历。',
            '- 商业街活动文本要写成现实动作，不要写成搜索报告。',
            '- 不要提 API、key、后端、系统或 prompt。'
        ].join('\n');
    }

    async function planCityWebSearchQuery(db, char, district, intent, baseLog) {
        const endpoint = String(char.memory_api_endpoint || char.api_endpoint || '').trim();
        const key = String(char.memory_api_key || char.api_key || '').trim();
        const model = String(char.memory_model_name || char.model_name || '').trim();
        if (!endpoint || !key || !model) throw new Error('联网查询规划缺少模型配置，请重试。');
        const prompt = [
            '你是商业街联网查询规划器，只负责把角色的查询意图变成搜索关键词。',
            '不要角色扮演，不要写活动文本，只返回 JSON。',
            '',
            `[角色] ${char.name}`,
            `[地点] ${district?.emoji || ''}${district?.name || district?.id || ''} / ${district?.type || ''}`,
            `[刚刚的商业街行动] ${baseLog || ''}`,
            `[角色想查的原因] ${intent?.reason || ''}`,
            `[查询提示] ${intent?.query_hint || ''}`,
            '',
            '返回 JSON：',
            '{ "queries": ["一个简洁搜索词", "可选第二个搜索词"], "provider": "auto" }'
        ].join('\n');
        const messages = [
            { role: 'system', content: '你只返回合法 JSON 对象，不要输出 markdown 或解释。' },
            { role: 'user', content: prompt }
        ];
        try {
            recordCityLlmDebug(db, char, 'input', 'city_web_query_plan', messages, { model, location: district?.id || '' });
            const reply = await callLLM({
                endpoint,
                key,
                model,
                messages,
                maxTokens: 1000,
                temperature: 0,
                debugAttempt: buildCityAttemptRecorder(db, char, 'city_web_query_plan', { location: district?.id || '' })
            });
            recordCityLlmDebug(db, char, 'output', 'city_web_query_plan', reply, { model, location: district?.id || '' });
            const cleaned = String(reply || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
            if (!cleaned) throw new Error('联网查询规划没有返回 JSON，请重试。');
            const parsed = JSON.parse(cleaned);
            const queries = (Array.isArray(parsed.queries) ? parsed.queries : [])
                .map(item => String(item || '').trim())
                .filter(Boolean)
                .slice(0, 2);
            if (!queries.length) throw new Error('联网查询规划缺少可用查询词，请重试。');
            return {
                queries,
                provider: String(parsed.provider || 'auto').trim() || 'auto'
            };
        } catch (e) {
            console.warn(`[City/Web] 查询规划失败 ${char.name}: ${e.message}`);
            throw e;
        }
    }

    async function maybeRunCityWebSearchActivity({ db, userId, char, district, config, baseLog }) {
        if (!char?.api_endpoint || !char?.api_key || !char?.model_name) return null;
        const status = String(char.city_status || '').trim();
        if (status === 'coma' || status === 'sleeping' || district?.type === 'medical') return null;
        const locationLabel = `${district?.emoji || ''}${district?.name || district?.id || '商业街'}`.trim();
        const prePrompt = [
            `你是 ${char.name}，正在 ${locationLabel}。`,
            '这是一段可选的商业街生活插曲：是否查网页完全由你按角色性格、当前场景和刚刚发生的行动判断。',
            '可以像真人一样掏手机查资料、比价、看攻略、确认新闻、刷八卦；也可以觉得没必要，继续做眼前的事。',
            '',
            `[刚刚发生的商业街行动] ${baseLog || ''}`,
            `[当前状态] 钱包=${char.wallet ?? 0} 体力=${char.calories ?? 0} 压力=${char.stress ?? 50} 心情=${char.mood ?? 50} 状态=${status || 'idle'}`,
            district?.type === 'work' ? '[工作风险] 你现在处在工作相关地点。如果查的不是工作正事，就会像摸鱼，后续可能被发现并受到惩罚；除非诱因、性格或情绪足够强，否则可以输出 NO_WEB。' : '',
            '',
            '请按角色性格和当前场景判断你此刻会不会自然想查一下网页。',
            '如果你觉得这段活动需要额外联网内容来增强真实感或后续输出质量，输出一段商业街活动文本，描述你查之前的动作、想法和查询方向，并在末尾带标签：',
            '[WEB_SEARCH_INTENT:{"reason":"为什么想查","query_hint":"搜索关键词方向"}]',
            '如果不会，只输出 NO_WEB。',
            '不要解释系统，不要提 API、key、后端。'
        ].filter(Boolean).join('\n');
        const preMessages = [
            { role: 'system', content: '你是商业街生活模拟器。联网是可选的角色行为；只有当你决定角色会查网页时，才在活动文本末尾附带 WEB_SEARCH_INTENT 标签。' },
            { role: 'user', content: prePrompt }
        ];
        recordCityLlmDebug(db, char, 'input', 'city_web_search_pre_activity', preMessages, { model: char.model_name, location: district?.id || '' });
        const preReply = await callLLM({
            endpoint: char.api_endpoint,
            key: char.api_key,
            model: char.model_name,
            messages: preMessages,
            maxTokens: 10000,
            temperature: 0.8,
            debugAttempt: buildCityAttemptRecorder(db, char, 'city_web_search_pre_activity', { location: district?.id || '' })
        });
        recordCityLlmDebug(db, char, 'output', 'city_web_search_pre_activity', preReply, { model: char.model_name, location: district?.id || '' });
        if (/^\s*NO_WEB\s*$/i.test(String(preReply || '').trim())) return null;
        const intent = parseCityWebIntentTag(preReply);
        if (!intent) return null;

        const plan = await planCityWebSearchQuery(db, char, district, intent, baseLog);
        const query = String(plan.queries?.[0] || intent.query_hint || '').trim();
        if (!query) throw new Error('联网查询规划缺少可用查询词，请重试。');

        const preLog = stripCityWebIntentTag(preReply);
        if (!preLog) throw new Error('联网前活动文案为空，请重试。');
        db.city.logAction(char.id, 'WEB_SEARCH', preLog, 0, 0, district?.id || char.location || '');
        broadcastCityEvent(userId, char.id, 'WEB_SEARCH', preLog);

        const resolved = mcpLabTools.resolveSearchProvider(db, plan.provider || 'auto');
        const labDb = mcpLabTools.ensureMcpLabDb(db);
        const taskId = mcpLabTools.makeId();
        const taskTime = new Date().toISOString();
        const taskBase = {
            id: taskId,
            owner_id: userId,
            title: `商业街联网：${query}`.slice(0, 160),
            kind: 'city_web_search',
            input: {
                query,
                provider: resolved.id,
                character_id: char.id,
                character_name: char.name || '',
                district_id: district?.id || '',
                district_name: district?.name || '',
                reason: intent?.reason || '',
                query_hint: intent?.query_hint || ''
            },
            created_at: taskTime,
            started_at: taskTime
        };
        labDb.saveTask({
            ...taskBase,
            status: 'running',
            output: null,
            error: '',
            finished_at: ''
        });
        let searchResult = null;
        try {
            searchResult = await mcpLabTools.runWebSearch(query, {
                provider: resolved.id,
                apiKey: resolved.key,
                fetchPages: true,
                fetchPageLimit: 3
            });
            labDb.saveTask({
                ...taskBase,
                status: 'done',
                output: searchResult,
                error: '',
                finished_at: new Date().toISOString()
            });
            const content = formatCityWebSearchKnowledge(searchResult);
            if (content) {
                try {
                    labDb.saveExternalKnowledge({
                        owner_id: userId,
                        character_id: char.id,
                        title: `商业街联网：${query}`.slice(0, 240),
                        content,
                        source_url: (searchResult.results || []).map(item => item.url).filter(Boolean).slice(0, 3).join('\n'),
                        source_type: 'city_web_search',
                        trust_level: 'search_summary',
                        tags: ['city_web_search', resolved.id, district?.id || '']
                    }, labDb.chunkText(content), mcpLabTools.makeId);
                } catch (saveErr) {
                    console.warn(`[City/Web] 保存外部知识失败 ${char.name}: ${saveErr.message}`);
                }
            }
        } catch (searchErr) {
            try {
                labDb.saveTask({
                    ...taskBase,
                    status: 'error',
                    output: searchResult,
                    error: searchErr.message,
                    finished_at: new Date().toISOString()
                });
            } catch (taskErr) {
                console.warn(`[City/Web] 保存联网任务失败 ${char.name}: ${taskErr.message}`);
            }
            throw searchErr;
        }

        const afterPrompt = [
            `你是 ${char.name}，刚刚在 ${locationLabel} 查了一下手机/网页。`,
            '',
            formatCityWebResultBlock(searchResult, plan, intent),
            '',
            '[任务]',
            '输出一段商业街活动文本，描述你看完联网内容后的动作、反应、决定或情绪。不要限制字数，按场景需要展开。',
            '如果是在工作场景摸鱼，要带一点心虚、遮掩或赶紧收手机的现实感。',
            '只输出活动文本，不要 JSON，不要标签。'
        ].join('\n');
        const afterMessages = [
            { role: 'system', content: '你是商业街生活模拟器。只输出一段自然的商业街活动记录文本。' },
            { role: 'user', content: afterPrompt }
        ];
        recordCityLlmDebug(db, char, 'input', 'city_web_search_after_activity', afterMessages, { model: char.model_name, location: district?.id || '', query });
        const afterReply = await callLLM({
            endpoint: char.api_endpoint,
            key: char.api_key,
            model: char.model_name,
            messages: afterMessages,
            maxTokens: 10000,
            temperature: 0.75,
            debugAttempt: buildCityAttemptRecorder(db, char, 'city_web_search_after_activity', { location: district?.id || '', query })
        });
        const afterLog = String(afterReply || '').replace(/\[[A-Z_]+:[^\]]*?\]/g, '').trim();
        recordCityLlmDebug(db, char, 'output', 'city_web_search_after_activity', afterLog, { model: char.model_name, location: district?.id || '', query });
        if (afterLog) {
            db.city.logAction(char.id, 'WEB_RESULT', afterLog, 0, 0, district?.id || char.location || '');
            broadcastCityEvent(userId, char.id, 'WEB_RESULT', afterLog);
        }

        const outcome = { moneyDelta: 0, calorieDelta: 0, stateEffects: { stress: district?.type === 'work' ? 2 : 0, mood: 1 } };
        const looksLikeWorkResearch = /工作|资料|任务|客户|报告|学习|课程|项目|公告|悬赏|路线|价格|采购/.test(`${intent.reason} ${intent.query_hint} ${query}`);
        if (district?.type === 'work' && !looksLikeWorkResearch) {
            const punishMessages = [
                { role: 'system', content: '你是商业街工作摸鱼后果判定器。只输出 NO_PUNISH 或一段活动记录文本。' },
                {
                    role: 'user',
                    content: [
                        `你是 ${char.name}，刚刚在工作时摸鱼查网页。`,
                        `[摸鱼前] ${preLog}`,
                        `[摸鱼后] ${afterLog}`,
                        '请根据场景判断是否真的会被发现。',
                        '如果没有明显被发现，只输出 NO_PUNISH。',
                        '如果会被发现，输出一段商业街惩罚文本：被主管/同事/顾客发现、尴尬补救、被扣钱或被迫加班。不要限制字数，按场景需要展开，但不要过度夸张。'
                    ].join('\n')
                }
            ];
            recordCityLlmDebug(db, char, 'input', 'city_web_search_work_punish', punishMessages, { model: char.model_name, location: district?.id || '', query });
            const punishReply = await callLLM({
                endpoint: char.api_endpoint,
                key: char.api_key,
                model: char.model_name,
                messages: punishMessages,
                maxTokens: 10000,
                temperature: 0.75,
                debugAttempt: buildCityAttemptRecorder(db, char, 'city_web_search_work_punish', { location: district?.id || '', query })
            });
            const punishLog = String(punishReply || '').trim();
            recordCityLlmDebug(db, char, 'output', 'city_web_search_work_punish', punishLog, { model: char.model_name, location: district?.id || '', query });
            if (punishLog && !/^\s*NO_PUNISH\s*$/i.test(punishLog)) {
                const penaltyMoney = -Math.max(3, Math.min(30, Math.round(Number(district.money_reward || 10) * 0.25)));
                db.city.logAction(char.id, 'WEB_PUNISH', punishLog, 0, penaltyMoney, district?.id || char.location || '');
                broadcastCityEvent(userId, char.id, 'WEB_PUNISH', punishLog);
                outcome.moneyDelta += penaltyMoney;
                outcome.stateEffects.stress = (outcome.stateEffects.stress || 0) + 8;
                outcome.stateEffects.mood = (outcome.stateEffects.mood || 0) - 5;
            }
        }

        return outcome;
    }

    const actionService = createActionService({
        normalizeSurvivalState,
        districtsFallbackForExhaustion,
        getDistrictStateEffects,
        ensureCityGrowthDb,
        schoolLogic,
        buildGamblingOutcomeNarrations,
        broadcastCityToChat,
        buildCollapsedCityLog,
        pickSettledShopItemFromNarrations,
        isWeakCityNarration,
        regenerateActionNarrations,
        clamp,
        broadcastCityEvent,
        handleQuestLifecycleAfterAction: (...args) => questService.handleQuestLifecycleAfterAction(...args),
        applyStateEffectsToCharacter,
        logEmotionTransitionToState,
        getWsClients,
        getEngine,
        isCollapsedCityLog,
        isHackerDistrict,
        buildHackerIntelAppendix,
        triggerHackerIntelReply,
        getMedicalStayMinutes,
        getCityNowMs: (config) => getCityDate(config).getTime(),
        maybeRunCityWebSearchActivity
    });

    const mayorRuntimeService = createMayorRuntimeService({
        callLLM,
        recordCityLlmDebug,
        resolveMayorAiCharacter: (...args) => mayorService.resolveMayorAiCharacter(...args),
        parseMayorJsonReply: (...args) => mayorService.parseMayorJsonReply(...args),
        applyMayorDecisions: (...args) => mayorService.applyMayorDecisions(...args)
    });

    function resolveMayorAiCharacter(db) {
        return mayorService.resolveMayorAiCharacter(db);
    }

    function parseMayorJsonReply(replyText, errorLabel = '市长 AI 返回内容不是合法 JSON。') {
        return mayorService.parseMayorJsonReply(replyText, errorLabel);
    }

    function getQuestDifficultyFallbackTarget(questLike = {}) {
        return mayorService.getQuestDifficultyFallbackTarget(questLike);
    }

    async function scoreQuestDifficultyWithMayor(db, questDraft = {}, aiChar = null) {
        return mayorService.scoreQuestDifficultyWithMayor(db, questDraft, aiChar);
    }

    async function scoreQuestProgressWithMayor(db, char, quest, claim, district, richNarrations = null, options = {}) {
        return mayorService.scoreQuestProgressWithMayor(db, char, quest, claim, district, richNarrations, options);
    }

    function shouldAutoRunMayor(db, now = Date.now()) {
        return mayorRuntimeService.shouldAutoRunMayor(db, now);
    }

    async function maybeRunMayorAI(db, runKey, { force = false } = {}) {
        return mayorRuntimeService.maybeRunMayorAI(db, runKey, { force });
    }

    async function runMayorAI(db) {
        return mayorRuntimeService.runMayorAI(db);
    }

    async function applyMayorDecisions(db, decision, aiChar = null) {
        return mayorService.applyMayorDecisions(db, decision, aiChar);
    }

    registerEventQuestRoutes(app, {
        authMiddleware,
        ensureCityDb,
        scoreQuestDifficultyWithMayor,
        publishQuestAnnouncement,
        scoreQuestProgressWithMayor,
        buildQuestResolutionNarrations,
        broadcastCityEvent,
        getEngine,
        getWsClients
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
            const result = await maybeRunMayorAI(req.db, req.user?.id || 'manual', { force: true });
            res.json(result);
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
                        const cityOutreachMeta = {
                            source: 'city_outreach',
                            event_type: eventType || '',
                            generated_from: 'city_action'
                        };
                        const { id: msgId, timestamp: msgTs } = db.addMessage(char.id, 'character', chatContent, cityOutreachMeta);
                        const freshChar = db.getCharacter(char.id) || char;
                        const hadPendingReply = !!freshChar.city_reply_pending;
                        const nextIgnoreStreak = hadPendingReply ? Math.min(6, (freshChar.city_ignore_streak || 0) + 1) : 0;
                        const nextPressure = hadPendingReply && freshChar.sys_pressure !== 0
                            ? Math.min(4, (freshChar.pressure_level || 0) + 1)
                            : (freshChar.pressure_level || 0);
                        const nextJealousy = hadPendingReply && freshChar.sys_jealousy !== 0
                            ? Math.min(100, (freshChar.jealousy_level || 0) + 20)
                            : (freshChar.jealousy_level || 0);
                        const cityChatPatch = {
                            city_reply_pending: 1,
                            city_ignore_streak: nextIgnoreStreak,
                            city_last_outreach_at: Date.now(),
                            city_post_ignore_reaction: 0,
                            pressure_level: nextPressure,
                            jealousy_level: nextJealousy
                        };
                        db.updateCharacter(char.id, cityChatPatch);
                        logEmotionTransition(
                            db,
                            freshChar,
                            cityChatPatch,
                            'city_private_outreach',
                            hadPendingReply
                                ? '角色再次从商业街主动发来私聊，但上一条仍未得到回应，焦虑和在意程度上升。'
                                : '角色从商业街主动发来私聊，等待用户回应。'
                        );
                        const newMessage = {
                            id: msgId, character_id: char.id, role: 'character',
                            content: chatContent, timestamp: msgTs, read: 0,
                            metadata: cityOutreachMeta
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

            // 4. City logs stay in city_logs first. Long-term memory is produced
            // by the batched memory sweep, same as private/group chat overflow.
        } catch (e) {
            console.error(`[City->Chat] 桥接异常: ${e.message}`);
        }
    }

    // Phase 7: Time Skip Schedule Backfill

    function parseTimeSkipBackfillReply(reply, char) {
        const cleaned = String(reply || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        if (!cleaned) {
            throw createCityError(`${char?.name || '角色'} 时间跳过回溯生成失败：模型没有返回 JSON，请重试。`, 502, true);
        }
        try {
            const parsed = JSON.parse(cleaned);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw createCityError(`${char?.name || '角色'} 时间跳过回溯生成失败：结果不是 JSON 对象，请重试。`, 502, true);
            }
            return parsed;
        } catch (err) {
            if (err?.canRetry) throw err;
            throw createCityError(`${char?.name || '角色'} 时间跳过回溯生成失败：JSON 无法解析，请重试。`, 502, true);
        }
    }

    function normalizeTimeSkipBackfillResult(raw, missedTasks = [], char = null) {
        const summary = String(raw?.summary || '').trim();
        if (!summary) {
            throw createCityError(`${char?.name || '角色'} 时间跳过回溯生成失败：缺少 summary，请重试。`, 502, true);
        }
        if (!Array.isArray(raw?.tasks_completed) || !Array.isArray(raw?.tasks_missed)) {
            throw createCityError(`${char?.name || '角色'} 时间跳过回溯生成失败：缺少任务完成/错过数组，请重试。`, 502, true);
        }

        const missedHourSet = new Set(missedTasks.map(task => Number(task.hour)).filter(hour => Number.isSafeInteger(hour)));
        const normalizeHours = (values, label) => {
            const result = [];
            for (const value of values) {
                const hour = Number(value);
                if (!Number.isSafeInteger(hour) || hour < 0 || hour > 23) {
                    throw createCityError(`${char?.name || '角色'} 时间跳过回溯生成失败：${label} 含无效小时，请重试。`, 502, true);
                }
                if (!missedHourSet.has(hour)) {
                    throw createCityError(`${char?.name || '角色'} 时间跳过回溯生成失败：${label} 包含未跳过的任务，请重试。`, 502, true);
                }
                if (!result.includes(hour)) result.push(hour);
            }
            return result;
        };

        const tasksCompleted = normalizeHours(raw.tasks_completed, 'tasks_completed');
        const tasksMissed = normalizeHours(raw.tasks_missed, 'tasks_missed');
        const classified = new Set([...tasksCompleted, ...tasksMissed]);
        for (const hour of missedHourSet) {
            if (!classified.has(hour)) {
                throw createCityError(`${char?.name || '角色'} 时间跳过回溯生成失败：有跳过任务没有被分类，请重试。`, 502, true);
            }
        }
        for (const hour of tasksCompleted) {
            if (tasksMissed.includes(hour)) {
                throw createCityError(`${char?.name || '角色'} 时间跳过回溯生成失败：同一任务同时完成和错过，请重试。`, 502, true);
            }
        }

        return {
            summary,
            tasks_completed: tasksCompleted,
            tasks_missed: tasksMissed,
            chat: String(raw?.chat || '').trim(),
            moment: String(raw?.moment || '').trim(),
            diary: String(raw?.diary || '').trim()
        };
    }

    async function runTimeSkipBackfill(db, oldCityDate, newCityDate, userId) {
        console.log(`[City DLC] ⏩ 触发时空飞跃推算: ${oldCityDate.toLocaleString()} -> ${newCityDate.toLocaleString()}`);

        let processedTasks = 0;
        const backfillResults = [];
        const wsClients = getWsClients(userId);

        // Broadcast start
        if (wsClients && wsClients.size > 0) {
            const msg = `System: 时光飞逝，时间快进了大约 ${Math.floor((newCityDate - oldCityDate) / 3600000)} 小时。系统正在异步推算这段时间内角色们的经历...`;
            wsClients.forEach(c => c.readyState === 1 && c.send(JSON.stringify({ type: 'city_update', action: 'time-skip-start', message: msg })));
        }

        // Find all characters with active APIs (whether scheduled or not)
        const characters = db.getCharacters().filter(c => c.api_endpoint && c.api_key && c.model_name);

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

            const messages = [{ role: 'user', content: prompt }];
            recordCityLlmDebug(db, char, 'input', 'city_timeskip_backfill', messages, { model: char.model_name });
            let reply = '';
            try {
                reply = await callLLM({
                    endpoint: char.api_endpoint, key: char.api_key, model: char.model_name,
                    messages, maxTokens: 3000, temperature: 0.95
                });
            } catch (e) {
                throw createCityError(`${char.name} 时间跳过回溯请求失败，请重试：${e.message}`, 502, true);
            }
            recordCityLlmDebug(db, char, 'output', 'city_timeskip_backfill', reply, { model: char.model_name });
            const result = normalizeTimeSkipBackfillResult(parseTimeSkipBackfillReply(reply, char), missedTasks, char);

            backfillResults.push({
                char,
                scheduleRecord,
                scheduleArray,
                missedTasks,
                result
            });
            processedTasks += missedTasks.length;
        }

        for (const item of backfillResults) {
            const { char, scheduleRecord, scheduleArray, missedTasks, result } = item;

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
                        throw createCityError(`${char.name} 时间跳过回溯结果缺少任务 ${h}:00 的状态，请重试。`, 502, true);
                    }
                    return task;
                });

                db.city.db.prepare('UPDATE city_schedules SET schedule_json = ? WHERE id = ?').run(JSON.stringify(updatedSchedule), scheduleRecord.id);
            }

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

    context.hooks.cityActionSuggestionCallback = maybeTriggerSuggestedCityAction;
    context.hooks.cityBusyChatImpactPatch = buildBusyChatImpactPatch;
    context.hooks.cityReplyStateSyncCallback = maybeSyncReplyDeclaredState;
    context.hooks.cityReplyIntentCallback = maybeExecuteReplyCityIntent;
    context.hooks.cityReplyActionCallback = maybeExecuteReplyCityAction;

    console.log('[City DLC] 商业街与生存系统路由已注册');
};
