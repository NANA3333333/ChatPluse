const cron = require('node-cron');
const crypto = require('crypto');
const initCityDb = require('./cityDb');
const initCityGrowthDb = require('../cityGrowth/growthDb');
const schoolLogic = require('../cityGrowth/schoolLogic');
const { enqueueBackgroundTask } = require('../../backgroundQueue');
const { buildUniversalContext } = require('../../contextBuilder');
const { deriveEmotion, applyEmotionEvent, getEmotionBehaviorGuidance, buildEmotionLogEntry } = require('../../emotion');

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

    async function triggerAdminGrantChat(userId, char, grantKind, details = {}) {
        if (!char?.id) return null;
        const db = ensureCityDb(getUserDb(userId));
        const engine = getEngine(userId);
        const wsClients = getWsClients(userId);
        if (!engine || typeof engine.triggerImmediateUserReply !== 'function') {
            throw new Error('私聊引擎不可用');
        }

        const amount = Number(details.amount || 0);
        const itemName = String(details.itemName || '').trim();
        const itemEmoji = String(details.itemEmoji || '').trim();
        const quantity = Number(details.quantity || 1) || 1;
        const userName = String(db.getUserProfile()?.name || '用户').trim() || '用户';
        const noticeContent = grantKind === 'gold'
            ? `${userName}刚给了你 ${amount} 金币。`
            : grantKind === 'calories'
                ? `${userName}刚给你补了 ${amount} 点体力/热量。`
                : `${userName}刚给了你 ${itemEmoji}${itemName} x${quantity}。`;

        const { id: msgId, timestamp: msgTs } = db.addMessage(char.id, 'system', noticeContent);
        const newMessage = {
            id: msgId,
            character_id: char.id,
            role: 'system',
            content: noticeContent,
            timestamp: msgTs,
            read: 0
        };
        engine?.broadcastNewMessage?.(wsClients, newMessage);
        engine?.broadcastEvent?.(wsClients, { type: 'refresh_contacts' });
        await engine.triggerImmediateUserReply(char.id, wsClients, { propagateError: true });
        return newMessage;
    }

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

        await engine.triggerImmediateUserReply(char.id, wsClients, {
            propagateError: true,
            extraSystemDirective: directive
        });
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

    function ensureCityGrowthDb(db) {
        if (!db.cityGrowth) {
            const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : db;
            db.cityGrowth = initCityGrowthDb(rawDb);
        }
        return db.cityGrowth;
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
                const cleaned = String(reply || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
                const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
                if (jsonMatch) decision = JSON.parse(jsonMatch[0]);
            } catch (err) {
                console.warn(`[City] 用户建议行动判断失败 ${char.name}: ${err.message}`);
            }
        }

        if (!decision?.accept || !decision?.district_id) return { triggered: false, reason: decision?.reason || 'rejected' };

        const district = districts.find(d => d.id === decision.district_id) || candidates.find(d => d.id === decision.district_id);
        if (!district) return { triggered: false, reason: 'district_not_found' };

        const activeEvents = db.city.getActiveEvents();
        const currentCals = char.calories ?? 2000;
        const narrations = {
            log: String(decision.log || '').trim() || buildCollapsedCityLog(char, '建议行动文案生成失败', { district }),
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

    function parseLooseJsonObject(reply) {
        const cleaned = String(reply || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        let jsonStr = jsonMatch[0];
        try {
            return JSON.parse(jsonStr);
        } catch (err) {
            jsonStr = jsonStr
                .replace(/,\s*([\]}])/g, '$1')
                .replace(/\/\/.*$/gm, '')
                .replace(/(?<!\\)\n/g, '\\n');
            try {
                return JSON.parse(jsonStr);
            } catch (innerErr) {
                return null;
            }
        }
    }

    function buildReplyIntentNarrationsFallback(char, district, replyText, db) {
        return {
            log: buildCollapsedCityLog(char, '私聊行动文案生成失败', { district }),
            chat: '',
            moment: '',
            diary: ''
        };
    }

    async function buildGamblingOutcomeNarrations(char, district, db, outcome = {}, styleHint = null) {
        const fallbackLog = buildCollapsedCityLog(char, outcome.didWin ? '赌场赢钱文案生成失败' : '赌场输钱文案生成失败', { district });
        const fallback = { log: fallbackLog, chat: '', moment: '', diary: '' };

        if (!(char.api_endpoint && char.api_key && char.model_name)) return fallback;

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

        try {
            const messages = [
                { role: 'system', content: '你是角色自己的现实行动记录器。你只返回合法 JSON 对象，不要输出任何额外解释、markdown、前言或后记。' },
                { role: 'user', content: prompt }
            ];
            recordCityLlmDebug(db, char, 'input', 'city_gambling_outcome_narration', messages, {
                model: char.model_name,
                districtId: district.id,
                didWin: !!outcome.didWin
            });
            const reply = await callLLM({
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
            recordCityLlmDebug(db, char, 'output', 'city_gambling_outcome_narration', reply, {
                model: char.model_name,
                districtId: district.id,
                didWin: !!outcome.didWin
            });
            const parsed = parseLooseJsonObject(reply);
            if (parsed && typeof parsed === 'object') {
                return {
                    log: String(parsed.log || '').trim() || fallback.log,
                    chat: String(parsed.chat || '').trim(),
                    moment: String(parsed.moment || '').trim(),
                    diary: String(parsed.diary || '').trim()
                };
            }
        } catch (err) {
            console.warn(`[City] 赌场结果文案生成失败 ${char.name}: ${err.message}`);
        }

        return fallback;
    }

    async function buildReplyIntentNarrations(char, district, replyText, db) {
        const previousDistrict = char.location ? db.city.getDistrict(char.location) : null;
        const previousDistrictLabel = previousDistrict ? `${previousDistrict.emoji}${previousDistrict.name}` : '当前位置';
        const targetDistrictLabel = `${district.emoji}${district.name}`;

        if (!(char.api_endpoint && char.api_key && char.model_name)) {
            return buildReplyIntentNarrationsFallback(char, district, replyText, db);
        }

        const prompt = `你正在生成一次正常的商业街活动结果。

角色：${char.name}
角色当前地点：${previousDistrictLabel}
目标地点：${targetDistrictLabel}
目标地点类型：${district.type || 'generic'}

[触发信号]
- 这次商业街活动已经确认开启。
- 目标地点已经锁定为 ${targetDistrictLabel}。
- 信号只负责“确认开启 + 指定去哪”，不是让你续写私聊对白。

要求：
1. 把这次输出当成一次普通商业街活动记录来写，不要围着私聊原话打转。
2. 重点参考：当前地点、目标地点、角色当前状态，以及商业街活动本身的连续性。
3. log 要像自然发生的商业街活动记录，不要写成固定模板。
4. chat / moment / diary 默认可留空；只有这次行动里真的自然出现时才填写。
5. 不要写系统、后台、模板、日志、触发器。
6. 如果目标地点属于吃饭/购物场景，不要提前编造“具体买了/吃了哪件商品”；商品结算会在后续真实发生。

严格返回 JSON 对象：
{
  "log": "自然的商业街活动记录",
  "chat": "",
  "moment": "",
  "diary": ""
}`;

        try {
            const messages = [
                { role: 'system', content: '你是角色自己的现实行动记录器。你只返回合法 JSON 对象，不要输出任何额外解释、markdown、前言或后记。' },
                { role: 'user', content: prompt }
            ];
            recordCityLlmDebug(db, char, 'input', 'city_reply_intent_narration', messages, {
                model: char.model_name,
                from: previousDistrict?.id || '',
                to: district.id || ''
            });
            const reply = await callLLM({
                endpoint: char.api_endpoint,
                key: char.api_key,
                model: char.model_name,
                messages,
                maxTokens: 3000,
                temperature: 0.35,
                debugAttempt: buildCityAttemptRecorder(db, char, 'city_reply_intent_narration', {
                    from: previousDistrict?.id || '',
                    to: district.id || ''
                })
            });
            recordCityLlmDebug(db, char, 'output', 'city_reply_intent_narration', reply, {
                model: char.model_name,
                from: previousDistrict?.id || '',
                to: district.id || ''
            });
            const parsed = parseLooseJsonObject(reply);
            if (parsed && typeof parsed === 'object') {
                return {
                    log: String(parsed.log || '').trim(),
                    chat: String(parsed.chat || '').trim(),
                    moment: String(parsed.moment || '').trim(),
                    diary: String(parsed.diary || '').trim()
                };
            }
        } catch (err) {
            console.warn(`[City] 私聊触发商业街叙述生成失败 ${char.name}: ${err.message}`);
        }

        return buildReplyIntentNarrationsFallback(char, district, replyText, db);
    }

    async function buildPrivateReplyCitySelfPrompt(char, district, replyText, db) {
        const normalizedReply = String(replyText || '').replace(/\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();
        const fallbackPrompt = `立刻前往 ${district.emoji}${district.name}，按刚才私聊里自己定下的主意行动。动作要贴合当下情绪和身体状态，不要像系统任务。`;

        if (!(char.api_endpoint && char.api_key && char.model_name)) {
            return { prompt: fallbackPrompt, reason: 'no_api_config' };
        }

        const prompt = `你是 ${char.name}。你刚在私聊里自己决定要去商业街活动，现在请你给“马上到商业街行动的自己”写一段简短行动规范。

目标地点：${district.emoji}${district.name} (${district.id})
刚才私聊中的原话：
${normalizedReply || '（空）'}

要求：
1. 只写 1-2 句简短 prompt，像角色写给自己的行动提醒。
2. 重点说明：这次去 ${district.name} 想干什么、会带着什么情绪/态度去、有没有要避免的事。
3. 不要写 JSON，不要写解释，不要写“我是 AI / 系统 / 后台 / 触发器”。
4. 不要重复整段私聊原话，要提炼成简短执行规范。
5. 语气必须像角色自己对自己下的一个小决心。`;

        try {
            const messages = [
                { role: 'system', content: '你只返回角色写给自己的简短行动 prompt，不要输出任何额外解释。' },
                { role: 'user', content: prompt }
            ];
            recordCityLlmDebug(db, char, 'input', 'city_private_self_prompt', messages, { model: char.model_name, districtId: district.id });
            const reply = await callLLM({
                endpoint: char.api_endpoint,
                key: char.api_key,
                model: char.model_name,
                messages,
                maxTokens: 3000,
                temperature: 0.5,
                debugAttempt: buildCityAttemptRecorder(db, char, 'city_private_self_prompt', {
                    districtId: district.id
                })
            });
            recordCityLlmDebug(db, char, 'output', 'city_private_self_prompt', reply, { model: char.model_name, districtId: district.id });
            const cleaned = String(reply || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').replace(/\s+/g, ' ').trim();
            return { prompt: cleaned || fallbackPrompt, reason: cleaned ? 'llm' : 'fallback_empty' };
        } catch (err) {
            console.warn(`[City] 私聊商业街自提示生成失败 ${char.name}: ${err.message}`);
            return { prompt: fallbackPrompt, reason: 'fallback_error' };
        }
    }

    function tryParseCityActionReply(reply = '') {
        const cleaned = String(reply || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        let jsonStr = jsonMatch[0];
        const candidates = [
            jsonStr,
            jsonStr
                .replace(/,\s*([\]}])/g, '$1')
                .replace(/\/\/.*$/gm, '')
                .replace(/(?<!\\)\n/g, '\\n')
                .replace(/\\n\s*}/g, '\n}')
                .replace(/\\n\s*]/g, '\n]')
                .replace(/{\s*\\n/g, '{\n')
        ];

        for (const candidate of candidates) {
            try {
                return JSON.parse(candidate);
            } catch (err) {
                continue;
            }
        }
        return null;
    }

    async function runPrivateReplyDirectedCityAction(userId, char, district, replyText, db, config) {
        const activeEvents = db.city.getActiveEvents();
        const currentCals = char.calories ?? 2000;
        const districts = db.city.getEnabledDistricts();
        const inventory = db.city.getInventory(char.id);
        const availableDistrictItems = getAvailableDistrictItems(db, district.id);
        const districtItemsPrompt = availableDistrictItems.length > 0
            ? `\n[当前目标地点可用商品]\n${district.name} 现在真实可用的商品只有：${formatDistrictItemsForPrompt(availableDistrictItems)}\n- 如果你在 log / diary / moment / chat 里提到具体吃了、买了、拿了什么，只能从上面这些商品里选。\n- 可以不写具体商品；但如果写了，就绝对不要编造清单外的食物或商品。`
            : '';
        const engineContextWrapper = { getUserDb: context.getUserDb, getMemory: context.getMemory };
        const universalResult = await buildUniversalContext(engineContextWrapper, char, '', false);
        const questContext = buildQuestPromptContext(db.city.getActiveQuests(), db.city.getCharacterActiveQuestClaim?.(char.id));
        const basePrompt = buildSurvivalPrompt(districts, { ...char, calories: currentCals }, inventory, activeEvents, universalResult, district, questContext);

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
- 如果当前状态里已经带着明显情绪，就让商业街行动自然延续，但不要夸张到失真。${districtItemsPrompt}`;

        if (!(char.api_endpoint && char.api_key && char.model_name)) {
            const fallbackNarrations = await buildReplyIntentNarrations(char, district, replyText, db);
            await applyDecision(district, char, db, userId, currentCals, config, activeEvents, fallbackNarrations, { preserveDirectedDistrict: true });
            return { triggered: true, districtId: district.id, mode: 'fallback_no_api' };
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
                await applyDecision(district, char, db, userId, currentCals, config, activeEvents, richNarrations, { preserveDirectedDistrict: true });
                return { triggered: true, districtId: district.id, mode: 'directed_city_action' };
            }
        } catch (err) {
            console.warn(`[City] 私聊定向商业街行动失败 ${char.name}: ${err.message}`);
        }

        const fallbackNarrations = await buildReplyIntentNarrations(char, district, replyText, db);
        await applyDecision(district, char, db, userId, currentCals, config, activeEvents, fallbackNarrations, { preserveDirectedDistrict: true });
        return { triggered: true, districtId: district.id, mode: 'directed_fallback' };
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

    async function regenerateActionNarrations(char, district, db, baseNarrations = {}, options = {}) {
        if (!(char?.api_endpoint && char?.api_key && char?.model_name)) {
            return baseNarrations;
        }

        const currentLocation = char.location ? db.city.getDistrict(char.location) : null;
        const currentLocationLabel = currentLocation ? `${currentLocation.emoji}${currentLocation.name}` : (char.location || '当前位置');
        const districtLabel = `${district.emoji || ''}${district.name || district.id || '未知地点'}`;
        const state = normalizeSurvivalState(char);
        const calories = Number(options.currentCals ?? char.calories ?? 2000);
        const recentAntiRepeat = buildRecentNarrationAntiRepeatBlock(db, char, district);
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
精力：${state.energy} 睡眠债：${state.sleep_debt} 心情：${state.mood} 压力：${state.stress} 饱腹：${state.satiety} 胃负担：${state.stomach_load}${itemLine}${recentAntiRepeat}

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

        try {
            const messages = [
                { role: 'system', content: '你是角色自己的现实行动记录器。只返回合法 JSON 对象，不要输出任何额外解释、markdown、前言或后记。' },
                { role: 'user', content: prompt }
            ];
            recordCityLlmDebug(db, char, 'input', 'city_action_regenerate_narration', messages, {
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
                temperature: 0.9,
                debugAttempt: buildCityAttemptRecorder(db, char, 'city_action_regenerate_narration', {
                    districtId: district.id,
                    location: char.location || ''
                })
            });
            recordCityLlmDebug(db, char, 'output', 'city_action_regenerate_narration', reply, {
                model: char.model_name,
                districtId: district.id,
                location: char.location || ''
            });
            const parsed = tryParseCityActionReply(reply);
            if (parsed && typeof parsed === 'object') {
                return {
                    ...baseNarrations,
                    ...parsed,
                    log: String(parsed.log || '').trim() || String(baseNarrations?.log || '').trim()
                };
            }
        } catch (err) {
            console.warn(`[City] 行动文案重写失败 ${char?.name || ''}: ${err.message}`);
        }

        return baseNarrations;
    }

    async function buildQuestResolutionNarrations(char, quest, district, db, outcome = 'success') {
        const fallbackLog = buildCollapsedCityLog(char, outcome === 'success' ? '任务完成文案生成失败' : '任务失败文案生成失败', { district });
        const fallbackSystemLog = buildCollapsedCityLog(char, outcome === 'success' ? '任务系统播报生成失败' : '任务失效播报生成失败', { district });
        const fallbackAnnouncement = buildCollapsedCityLog(char, outcome === 'success' ? '任务完成公告生成失败' : '任务失效公告生成失败', { district });

        if (!(char?.api_endpoint && char?.api_key && char?.model_name)) {
            return {
                log: fallbackLog,
                systemLog: fallbackSystemLog,
                announcement: fallbackAnnouncement
            };
        }

        const districtLabel = district ? `${district.emoji || ''}${district.name || district.id || ''}` : (quest?.target_district || '商业街');
        const prompt = `你要为一次商业街公告任务的最终结算，生成结果文案。

角色：${char.name}
任务：${quest?.emoji || '📜'} ${quest?.title || '悬赏任务'}
地点：${districtLabel}
任务内容：${quest?.description || ''}
结果：${outcome === 'success' ? '该角色抢先完成并成功交付' : '该角色去交付时发现任务已经被别人抢先完成，自己扑空了'}

要求：
- log：写成该角色自己的商业街经历，像刚发生过这件事。
- systemLog：写成系统公开活动记录，简洁一点，但不要写成死板模板。
- announcement：写成公告区里会出现的一条结果通告。
- 三段都不要写后台、JSON、触发器、结算器。
- 如果是失败结果，要体现“晚了一步、没拿到钱”；如果是成功结果，要体现“完成交付、拿到赏金”。
- 不要使用“白忙了一场”“白跑一趟”“顺利交掉了”这种现成套话。

严格返回 JSON：
{
  "log": "角色自己的任务结果文案",
  "systemLog": "系统活动记录",
  "announcement": "公告区通告"
}`;

        try {
            const messages = [
                { role: 'system', content: '你是商业街任务结果记录器。只返回合法 JSON 对象，不要输出额外解释或 markdown。' },
                { role: 'user', content: prompt }
            ];
            recordCityLlmDebug(db, char, 'input', 'city_quest_resolution_narration', messages, {
                model: char.model_name,
                districtId: district?.id || '',
                questId: quest?.id || 0,
                outcome
            });
            const reply = await callLLM({
                endpoint: char.api_endpoint,
                key: char.api_key,
                model: char.model_name,
                messages,
                maxTokens: 3000,
                temperature: 0.85,
                debugAttempt: buildCityAttemptRecorder(db, char, 'city_quest_resolution_narration', {
                    districtId: district?.id || '',
                    questId: quest?.id || 0,
                    outcome
                })
            });
            recordCityLlmDebug(db, char, 'output', 'city_quest_resolution_narration', reply, {
                model: char.model_name,
                districtId: district?.id || '',
                questId: quest?.id || 0,
                outcome
            });
            const match = String(reply || '').match(/\{[\s\S]*\}/);
            const parsed = match ? JSON.parse(match[0]) : null;
            return {
                log: String(parsed?.log || '').trim() || fallbackLog,
                systemLog: String(parsed?.systemLog || '').trim() || fallbackSystemLog,
                announcement: String(parsed?.announcement || '').trim() || fallbackAnnouncement
            };
        } catch (err) {
            console.warn(`[City] 任务结果文案生成失败 ${char?.name || ''}: ${err.message}`);
            return {
                log: fallbackLog,
                systemLog: fallbackSystemLog,
                announcement: fallbackAnnouncement
            };
        }
    }

    function buildBusyPenaltyLog(char, kind, amount, districtName) {
        return buildCollapsedCityLog(char, kind === 'work' ? '忙碌惩罚文案生成失败' : '休息惩罚文案生成失败', {
            locationLabel: districtName || '当前地点'
        });
    }

    async function buildBusyPenaltyNarration(char, kind, amount, districtName, db) {
        const fallback = buildBusyPenaltyLog(char, kind, amount, districtName);
        if (!(char?.api_endpoint && char?.api_key && char?.model_name) || !amount) {
            return fallback;
        }

        const kindLabel = kind === 'work' ? '工作' : '补觉/休息';
        const effectLine = kind === 'work'
            ? `这次因为分神，实际少赚了 ${amount} 金币。`
            : `这次因为被打断，额外增加了 ${amount} 点睡眠债。`;
        const prompt = `你是 ${char.name}。你刚刚在商业街的${kindLabel}状态里被私聊打扰，导致现实后果出现。

地点：${districtName || '当前地点'}
后果：${effectLine}

要求：
1. 只写 1-2 句商业街活动记录文案。
2. 要写出“本来在忙/在睡，被聊天打扰后出了现实代价”的感觉。
3. 语气要贴合角色，不要写系统、后台、数值结算说明。
4. 文案里要能让人感觉到一点紧迫感、烦躁、无奈或被拖住的现实感。
5. 不要脱离场景乱发挥。`;

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
            return cleaned || fallback;
        } catch (err) {
            console.warn(`[City] 忙碌惩罚文案生成失败 ${char?.name || ''}: ${err.message}`);
            return fallback;
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

    function buildQuestPromptContext(activeQuests = [], activeQuestClaim = null) {
        const openTasks = Array.isArray(activeQuests) ? activeQuests.slice(0, 6).map((quest) => {
            const claimText = quest.claim_count > 0 ? `已接单 ${quest.claim_count} 人` : '暂时无人接单';
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
            personalTask = `\n[你当前手上的公告任务]\n- 任务：${activeQuestClaim.emoji || '📜'} ${activeQuestClaim.title}\n- 目标地点：${activeQuestClaim.target_district || 'street'}\n- 当前阶段：${activeQuestClaim.status}\n- 进度：${activeQuestClaim.progress_count || 0}\n- 说明：${stageMap[activeQuestClaim.status] || '按任务自然推进。'}\n- 任务要求：${activeQuestClaim.description || ''}`;
        }

        return {
            openTasks,
            personalTask
        };
    }

    function normalizeQuestIntent(richNarrations = null) {
        const raw = richNarrations?.quest_intent;
        if (!raw || typeof raw !== 'object') return null;
        const questId = Number(raw.quest_id || raw.id || 0);
        const stage = String(raw.stage || '').trim().toLowerCase();
        if (!questId || !stage) return null;
        return { questId, stage };
    }

    function buildSurvivalPrompt(districts, char, inventory, activeEvents, universalContext, targetDistrict, questContext = null) {
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
        const antiRepeatBlock = buildRecentNarrationAntiRepeatBlock(ensureCityDb(context.getUserDb(char.user_id || 'default')), char, targetDistrict || { type: '', id: '' });

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
        hardConstraintText += `\n- 情绪影响：${emotionGuidance.cityAction}`;
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
三维 Int/Sta/Cha: ${char.stat_int ?? 50}/${char.stat_sta ?? 50}/${char.stat_cha ?? 50}
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
- 如果你已经在做任务，继续正常生成商业街行动；若是在推进任务，可带 stage="progress"。
- 如果你准备交付任务、领取赏金，就额外带上 quest_intent：{"quest_id":任务ID,"stage":"report"}。
- 不要把 quest_intent 当系统说明写进 log，log 仍然必须像普通商业街活动。${questOpenBlock}${personalQuestBlock}
- 任务推进必须贴合任务内容：采购/配送要写拿货、送达；清理/维修要写动手处理；调查类要写打听、寻找、发现；巡逻/护送要写陪同、盯守、来回查看。
- 去错地点、只是在附近闲逛、或者文案和任务不匹配，都不会推进任务进度。
[行动约束]${hardConstraintText}

[输出要求]
- 只选一个 action
- log 自然写出这次行动里真正发生的事，要有画面/动作/心理，但不要写成固定模板
- 若想联系玩家再填 chat
- 若值得公开展示再填 moment
- 若有没说出口的心声再填 diary
- 想花钱但钱不够时，也要把失败尝试真实写进 log
- 不要重复 preamble 里刚做过的地点/动作
- 不要使用高复用套话，不要把“从家离开、肚子里空空的、先把自己安顿好”这类句式当默认开头${antiRepeatBlock ? antiRepeatBlock : ''}

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
        const candidates = [];
        const pushCandidate = (value) => {
            const text = String(value || '').trim();
            if (!text || candidates.includes(text)) return;
            candidates.push(text);
        };

        const firstBracket = cleaned.indexOf('[');
        const lastBracket = cleaned.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket > firstBracket) {
            pushCandidate(cleaned.slice(firstBracket, lastBracket + 1));
        }

        if (firstBracket !== -1) {
            const lastBrace = cleaned.lastIndexOf('}');
            if (lastBrace > firstBracket) {
                pushCandidate(`${cleaned.slice(firstBracket, lastBrace + 1)}]`);
            }
        }

        pushCandidate(cleaned);

        for (const candidate of candidates) {
            try {
                const parsed = JSON.parse(candidate);
                if (Array.isArray(parsed)) return parsed;
            } catch (e) {
                try {
                    const repaired = candidate
                        .replace(/,\s*([\]}])/g, '$1')
                        .replace(/[\r\n]+/g, ' ');
                    const parsed = JSON.parse(repaired);
                    if (Array.isArray(parsed)) return parsed;
                } catch (_) { /* ignore */ }
            }
        }
        return null;
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

    app.get('/api/city/announcements', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const requestedLimit = Number.parseInt(req.query.limit, 10);
            const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 50;
            res.json({ success: true, announcements: req.db.city.getCityAnnouncements(limit) });
        }
        catch (e) { res.status(500).json({ error: e.message }); }
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
                    stat_int: c.stat_int ?? 50, stat_sta: c.stat_sta ?? 50, stat_cha: c.stat_cha ?? 50,
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
                        const metabolismRate = parseInt(config.metabolism_rate) || 20;

                    // Adjust metabolism drain to be per-minute based (originally 20 per 15-min tick)
                    // If old tick means 20 cals/15min, then 1 min = 20/15 = 1.33 cals per real-time minute.
                        const minuteMetabolism = Math.max(1, Math.round(metabolismRate / 15));

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

        // No API -> rule-based fallback
        const activeEvents = db.city.getActiveEvents();
        if (!char.api_endpoint || !char.api_key || !char.model_name) {
            await applyDecision(selectRandomDistrict(districts, char), char, db, userId, currentCals, config, activeEvents);
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

        const activeQuestClaim = db.city.getCharacterActiveQuestClaim?.(char.id);
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
        const engineContextWrapper = { getUserDb: context.getUserDb, getMemory: context.getMemory };
        const universalResult = await buildUniversalContext(engineContextWrapper, char, '', false);
        const questContext = buildQuestPromptContext(db.city.getActiveQuests(), db.city.getCharacterActiveQuestClaim?.(char.id));
        const prompt = buildSurvivalPrompt(districts, { ...char, calories: currentCals }, inventory, activeEvents, universalResult, targetDistrict, questContext);
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
                        log: logText || buildCollapsedCityLog(char, '行动文案字段缺失', {
                            locationLabel: String(codeMatch || '').toUpperCase()
                        }),
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

                    richNarrations = {
                        log: safeReply || buildCollapsedCityLog(char, '行动响应解析失败', {
                            locationLabel: String(codeMatch || '').toUpperCase()
                        }),
                        chat: '',
                        moment: '',
                        diary: ''
                    };
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
                    const currentDistrict = char.location ? db.city.getDistrict(char.location) : null;
                    const eatLog = String(richNarrations?.log || '').trim() || buildCollapsedCityLog(char, '背包进食文案生成失败', {
                        district: currentDistrict || { id: char.location || 'unknown', name: char.location || '当前位置', emoji: '' }
                    });
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
            await applyDecision(district, char, db, userId, currentCals, config, activeEvents, richNarrations, { preserveDirectedDistrict: true });
        } catch (e) {
            console.error(`[City] ${char.name} LLM 失败: ${e.message}`);
            const randomDist = selectRandomDistrict(districts, char);
            const errLog = {
                log: `⚠️ [系统提示] ${char.name} 的大模型无响应（API连接失败）。已强制随机游荡至：${randomDist.emoji}${randomDist.name}。`
            };
            await applyDecision(randomDist, char, db, userId, currentCals, config, activeEvents, errLog);
        }
    }

    function selectRandomDistrict(districts, char) {
        const cals = char.calories ?? 2000, wallet = char.wallet ?? 200;
        const state = normalizeSurvivalState(char);
        const emotionState = deriveEmotion(char).state;
        // Check if char has food in inventory first
        if (cals < 500 && wallet >= 15) return districts.find(d => d.type === 'food') || districts[0];
        if (state.energy < 20) {
            return districts.find(d => d.type === 'rest')
                || districts.find(d => d.type === 'food')
                || districts[0];
        }
        if (cals < 300 || state.energy < 35 || state.sleep_debt > 75) return districts.find(d => d.type === 'rest') || districts[0];
        if (state.health < 35) return districts.find(d => d.type === 'medical') || districts[0];
        if (emotionState === 'unwell') return districts.find(d => d.type === 'medical') || districts.find(d => d.type === 'rest') || districts[0];
        if (emotionState === 'sleepy') return districts.find(d => d.type === 'rest') || districts[0];
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
        return [
            richNarrations?.log,
            richNarrations?.chat,
            richNarrations?.moment,
            richNarrations?.diary
        ].map((value) => String(value || '').trim()).filter(Boolean).join('\n');
    }

    function computeQuestProgressIncrement(quest, district, richNarrations = null) {
        const questType = String(quest?.quest_type || 'errand').toLowerCase();
        const text = getQuestNarrationText(richNarrations);
        const atTarget = district.id === (quest?.target_district || '');
        if (!atTarget) return 0;

        const hasKeywords = (...patterns) => patterns.some((pattern) => pattern.test(text));
        switch (questType) {
            case 'delivery':
                return hasKeywords(/买到|拿到|提着|送去|交给|搬上|跑去|领到/) ? 1 : 0;
            case 'service':
                return hasKeywords(/清理|打扫|修|抢修|疏通|搬运|救援|维护|整理/) ? 1 : 0;
            case 'investigation':
                return hasKeywords(/查看|调查|打听|问到|发现|找到|搜到|线索/) ? 1 : 0;
            case 'patrol':
                return hasKeywords(/巡逻|守着|盯着|护送|陪着|值守/) ? 1 : 0;
            default:
                return hasKeywords(/处理|搞定|忙完|跑了|做完|拿到|送到|交给/) ? 1 : 0;
        }
    }

    async function handleQuestLifecycleAfterAction(db, char, district, richNarrations = null) {
        let bonusMoney = 0;
        let bonusCalories = 0;
        const textHaystack = getQuestNarrationText(richNarrations);
        const intent = normalizeQuestIntent(richNarrations);

        if (intent?.stage === 'claim' && intent.questId) {
            const quest = db.city.getQuestById?.(intent.questId);
            if (quest && !quest.is_completed) {
                const claimResult = db.city.claimQuest?.(intent.questId, char.id);
                if (claimResult?.success) {
                    db.city.logAction('system', 'QUEST', `📌 ${char.name} 看完公告后接下了「${quest.title}」`, 0, 0, district.id);
                    db.city.addCityAnnouncement?.('system', '任务状态', `${char.name} 接下了「${quest.title}」，正赶往 ${district.emoji}${district.name}。`, district.id);
                }
            }
        }

        const activeClaim = db.city.getCharacterActiveQuestClaim?.(char.id);
        if (!activeClaim) return { bonusMoney, bonusCalories };
        const quest = db.city.getQuestById?.(activeClaim.quest_id);
        if (!quest) return { bonusMoney, bonusCalories };

        const reportRequested = intent?.stage === 'report' || /汇报|交付|递交|交差|报告任务|送去交单|去交单/.test(textHaystack);
        if (reportRequested && ['ready_to_report', 'reporting', 'in_progress', 'accepted'].includes(String(activeClaim.status || ''))) {
            db.city.updateQuestClaimStage?.(activeClaim.quest_id, char.id, 'reporting', 0, '准备汇报交付');
            const result = db.city.resolveQuestCompletion?.(activeClaim.quest_id, char.id);
            if (result?.success && result.won) {
                bonusMoney += Number(result.reward_gold || 0);
                bonusCalories += Number(result.reward_cal || 0);
                if (quest.source_announcement_id) db.city.deleteCityAnnouncement?.(quest.source_announcement_id);
                const resolution = await buildQuestResolutionNarrations(char, quest, district, db, 'success');
                db.city.logAction(char.id, 'QUEST', resolution.log, 0, 0, district.id);
                db.city.logAction('system', 'QUEST', resolution.systemLog, 0, 0, district.id);
                db.city.addCityAnnouncement?.('system', '任务完成', resolution.announcement, district.id);
            } else if (result?.success && !result.won) {
                const resolution = await buildQuestResolutionNarrations(char, quest, district, db, 'failed');
                db.city.logAction(char.id, 'QUEST', resolution.log, 0, 0, district.id);
                db.city.logAction('system', 'QUEST', resolution.systemLog, 0, 0, district.id);
                db.city.addCityAnnouncement?.('system', '任务失效', resolution.announcement, district.id);
            }
            return { bonusMoney, bonusCalories };
        }

        if (district.id === activeClaim.target_district && ['accepted', 'in_progress'].includes(String(activeClaim.status || ''))) {
            const progressIncrement = computeQuestProgressIncrement(quest, district, richNarrations);
            if (progressIncrement <= 0) return { bonusMoney, bonusCalories };
            const nextClaim = db.city.advanceQuestProgress?.(activeClaim.quest_id, char.id, progressIncrement);
            if (nextClaim?.status === 'ready_to_report') {
                db.city.logAction('system', 'QUEST', `📝 ${char.name} 基本处理完了「${quest.title}」，下一步可以去汇报交付。`, 0, 0, district.id);
            } else if (nextClaim?.status === 'in_progress') {
                db.city.logAction('system', 'QUEST', `🔧 ${char.name} 正在 ${district.emoji}${district.name} 处理「${quest.title}」`, 0, 0, district.id);
            }
        }

        return { bonusMoney, bonusCalories };
    }

    async function applyDecision(district, char, db, userId, currentCals, config, activeEvents, richNarrations = null, options = {}) {
        const currentState = normalizeSurvivalState(char);
        const preserveDirectedDistrict = !!options.preserveDirectedDistrict;
        if (!preserveDirectedDistrict) {
            if (
                currentState.energy < 20 &&
                ['work', 'education', 'gambling', 'leisure', 'wander'].includes(district.type)
            ) {
                district = districtsFallbackForExhaustion(char, db) || district;
            } else if (
                currentState.energy < 35 &&
                ['work', 'education', 'gambling'].includes(district.type)
            ) {
                district = districtsFallbackForExhaustion(char, db) || district;
            }
        }

        const inflation = parseFloat(config.inflation) || 1.0;
        const workBonus = parseFloat(config.work_bonus) || 1.0;
        let dCal = -(district.cal_cost || 0) + (district.cal_reward || 0);
        let dMoney = -(district.money_cost || 0) * inflation + (district.money_reward || 0) * workBonus;
        let stateEffects = getDistrictStateEffects(district, richNarrations);
        const growthDb = ensureCityGrowthDb(db);
        const schoolProfile = schoolLogic.getCharacterSchoolProfile(growthDb, char.id);
        stateEffects = schoolLogic.applySchoolPerksToState(district, stateEffects, schoolProfile, currentState);

        if (district.type === 'work' && dMoney > 0 && schoolProfile.vocational > 0) {
            const vocationalBonus = schoolProfile.vocational >= 70
                ? 0.22
                : schoolProfile.vocational >= 40
                    ? 0.12
                    : schoolProfile.vocational >= 20
                        ? 0.06
                        : 0;
            if (vocationalBonus > 0) {
                dMoney = Math.round(dMoney * (1 + vocationalBonus));
                stateEffects = {
                    ...stateEffects,
                    stress: stateEffects.stress - (schoolProfile.vocational >= 70 ? 3 : 1),
                    mood: stateEffects.mood + (schoolProfile.vocational >= 70 ? 2 : 1)
                };
            }
        }

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
        const getLogText = (defaultString, options = {}) => {
            if (options.forceDefault) return defaultString;
            if (!richNarrations) return defaultString;
            const candidates = [
                richNarrations.log,
                richNarrations.diary,
                richNarrations.moment,
                richNarrations.chat
            ].map(v => String(v || '').trim()).filter(Boolean);

            for (const candidate of candidates) {
                return candidate;
            }
            return defaultString;
        };

        if (district.type === 'gambling') {
            const winRate = parseFloat(config.gambling_win_rate) || 0.35;
            const payout = parseFloat(config.gambling_payout) || 3.0;
            const didWin = Math.random() < winRate;
            if (didWin) {
                dMoney = district.money_cost * payout;
                stateEffects = { ...stateEffects, mood: stateEffects.mood + 10, stress: stateEffects.stress - 6 };
                const gamblingNarrations = await buildGamblingOutcomeNarrations(char, district, db, {
                    didWin: true,
                    moneyDelta: dMoney,
                    calDelta: dCal
                }, richNarrations);
                const winLog = String(gamblingNarrations.log || `${char.name} 在 ${district.emoji}${district.name} 赢了一大笔钱 😎`).trim();
                db.city.logAction(char.id, district.id.toUpperCase(), winLog, dCal, dMoney, district.id);
                richNarrations = gamblingNarrations;
                broadcastCityToChat(userId, char, winLog, 'GAMBLING_WIN', richNarrations);
            } else {
                dMoney = -(district.money_cost || 0) * inflation;
                stateEffects = { ...stateEffects, mood: stateEffects.mood - 8, stress: stateEffects.stress + 8 };
                const gamblingNarrations = await buildGamblingOutcomeNarrations(char, district, db, {
                    didWin: false,
                    moneyDelta: dMoney,
                    calDelta: dCal
                }, richNarrations);
                const loseLog = String(gamblingNarrations.log || `${char.name} 在 ${district.emoji}${district.name} 输光了 😵`).trim();
                db.city.logAction(char.id, district.id.toUpperCase(), loseLog, dCal, dMoney, district.id);
                richNarrations = gamblingNarrations;
                broadcastCityToChat(userId, char, loseLog, 'GAMBLING_LOSE', richNarrations);
            }
        } else if (district.type === 'food' || district.type === 'shopping') {
            // New: instead of directly restoring calories, buy items first
            const realCost = (district.money_cost || 0) * inflation;
            if (realCost > 0 && (char.wallet || 0) < realCost) {
                const brokeLog = getLogText(buildCollapsedCityLog(char, '金币不足，文案折叠', { district }));
                db.city.logAction(char.id, 'BROKE', brokeLog, 0, 0, district.id);
                return;
            }
            let shopItems = db.city.getItemsAtDistrict(district.id);
            // new: filter out out-of-stock items
            shopItems = shopItems.filter(i => i.stock === -1 || i.stock > 0);

            if (shopItems.length > 0) {
                const settledNarratedItem = pickSettledShopItemFromNarrations(shopItems, richNarrations);
                const item = settledNarratedItem || shopItems[Math.floor(Math.random() * shopItems.length)];
                const itemCost = item.buy_price * inflation;
                if ((char.wallet || 0) >= itemCost) {
                    if (!richNarrations || isWeakCityNarration(richNarrations?.log, char, district)) {
                        richNarrations = await regenerateActionNarrations(char, district, db, richNarrations || {}, {
                            item,
                            currentCals
                        });
                    }
                    db.city.decreaseItemStock(item.id, 1);

                    if (district.id === 'restaurant') {
                        dMoney = -itemCost;
                        dCal = -(district.cal_cost || 0) + (item.cal_restore || 0);
                        const satietyBoost = clamp(Math.round((item.cal_restore || 0) / 18), 10, 30);
                        const loadBoost = clamp(Math.round((item.cal_restore || 0) / 24), 8, 24);
                        stateEffects = {
                            ...stateEffects,
                            energy: stateEffects.energy + 6,
                            stress: stateEffects.stress - 2,
                            mood: stateEffects.mood + 2,
                            satiety: (stateEffects.satiety || 0) + satietyBoost,
                            stomach_load: (stateEffects.stomach_load || 0) + loadBoost,
                            sleep_debt: (stateEffects.sleep_debt || 0) + Math.round(loadBoost * 0.6)
                        };
                        const eatLog = getLogText(buildCollapsedCityLog(char, '进食文案生成失败', { district }), { allowWeak: true });
                        db.city.logAction(char.id, 'EAT', eatLog, dCal, dMoney, district.id);
                        broadcastCityEvent(userId, char.id, 'EAT', eatLog);
                        broadcastCityToChat(userId, char, eatLog, 'EAT', richNarrations);
                    } else {
                        db.city.addToInventory(char.id, item.id, 1);
                        dMoney = -itemCost;
                        dCal = -(district.cal_cost || 0); // walking there costs calories
                        const buyLog = getLogText(buildCollapsedCityLog(char, '购物文案生成失败', { district }), { allowWeak: true });
                        db.city.logAction(char.id, 'BUY', buyLog, dCal, dMoney, district.id);
                        broadcastCityEvent(userId, char.id, 'BUY', buyLog);
                        broadcastCityToChat(userId, char, buyLog, 'BUY', richNarrations);
                    }

                    const newCals = Math.min(4000, Math.max(0, currentCals + dCal));
                    const newWallet = Math.max(0, (char.wallet || 0) + dMoney);
                    const nextState = applyStateEffectsToCharacter(char, stateEffects);
                    const shoppingPatch = {
                        calories: newCals,
                        city_status: newCals < 500 ? 'hungry' : 'idle',
                        location: district.id,
                        wallet: newWallet,
                        ...nextState
                    };
                    db.updateCharacter(char.id, shoppingPatch);
                    logEmotionTransitionToState(
                        db,
                        char,
                        { ...char, ...shoppingPatch },
                        `city_action_${district.type}`,
                        `角色在商业街 ${district.name} 完成了一次${district.type === 'food' ? '进食' : '消费'}行为，状态与主情绪随之变化。`
                    );

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
                const brokeLog = getLogText(buildCollapsedCityLog(char, '金币不足，文案折叠', { district }));
                db.city.logAction(char.id, 'BROKE', brokeLog, 0, 0, district.id);
                return;
            }
            const normalLog = getLogText(buildCollapsedCityLog(char, '行动文案生成失败', { district }));
            db.city.logAction(char.id, district.id.toUpperCase(), normalLog, dCal, dMoney, district.id);
            if (richNarrations) broadcastCityToChat(userId, char, normalLog, district.id.toUpperCase(), richNarrations);
        } else if (district.type === 'medical') {
            if (district.money_cost > 0 && (char.wallet || 0) < district.money_cost * inflation) {
                const brokeLog = getLogText(buildCollapsedCityLog(char, '金币不足，文案折叠', { district }));
                db.city.logAction(char.id, 'BROKE', brokeLog, 0, 0, district.id);
                return;
            }
            if (currentCals >= 800) {
                // Character is healthy but went to hospital! Enforce punishment according to rules.
                // The LLM was explicitly instructed in the prompt to write about being scolded.
                dCal = -(district.cal_cost || 0); // No bonus reward, still pay travel cost
                const punishLog = getLogText(buildCollapsedCityLog(char, '医疗行动文案折叠', { district }));
                db.city.logAction(char.id, district.id.toUpperCase(), punishLog, dCal, dMoney, district.id);
                if (richNarrations) broadcastCityToChat(userId, char, punishLog, district.id.toUpperCase(), richNarrations);
            } else {
                // Actually sick/starving: admit to hospital and recover every 5 minutes during the stay.
                dCal = -(district.cal_cost || 0);
                stateEffects = { energy: 0, sleep_debt: 0, stress: 0, social_need: 0, health: 0, mood: 0, satiety: 0, stomach_load: 0 };
                const normalLog = getLogText(buildCollapsedCityLog(char, '医疗行动文案生成失败', { district }), { forceDefault: true });
                db.city.logAction(char.id, district.id.toUpperCase(), normalLog, dCal, dMoney, district.id);
                if (richNarrations) broadcastCityToChat(userId, char, normalLog, district.id.toUpperCase(), richNarrations);
            }
        } else {
            if (district.money_cost > 0 && (char.wallet || 0) < district.money_cost * inflation) {
                const brokeLog = getLogText(buildCollapsedCityLog(char, '金币不足，文案折叠', { district }));
                db.city.logAction(char.id, 'BROKE', brokeLog, 0, 0, district.id);
                return;
            }
            let normalLog = getLogText(buildCollapsedCityLog(char, '行动文案生成失败', { district }));
            let hackerIntelPayload = '';
            if (district.type === 'education') {
                const studyResult = schoolLogic.getSchoolActionEffects(growthDb, char, district, currentState);
                if (studyResult) {
                    growthDb.addCharacterCourseMastery(char.id, studyResult.course.id, studyResult.gain);
                    stateEffects = {
                        ...stateEffects,
                        mood: stateEffects.mood + 2,
                        stress: stateEffects.stress - 1
                    };
                    const schoolProgressText = `课程=${studyResult.course.emoji}${studyResult.course.name} | 熟练度=+${studyResult.gain} | 当前=${studyResult.afterMastery}/100`;
                    const schoolUnlockText = String(schoolLogic.describeSchoolUnlock(studyResult.course.id, studyResult.unlockedTier) || '').trim();
                    if (isCollapsedCityLog(normalLog)) {
                        normalLog = [normalLog, schoolProgressText, schoolUnlockText].filter(Boolean).join(' | ');
                    } else {
                        normalLog = `${normalLog} 这次主要上了 ${studyResult.course.emoji}${studyResult.course.name}，熟练度 +${studyResult.gain}，现在是 ${studyResult.afterMastery}/100。${schoolUnlockText}`.trim();
                    }
                }
            }
            if (isHackerDistrict(district)) {
                hackerIntelPayload = buildHackerIntelAppendix(db, char);
                normalLog = `${normalLog}\n\n[黑客据点情报]\n${hackerIntelPayload}`.trim();
            }
            db.city.logAction(char.id, district.id.toUpperCase(), normalLog, dCal, dMoney, district.id);
            if (richNarrations) broadcastCityToChat(userId, char, normalLog, district.id.toUpperCase(), richNarrations);
            if (hackerIntelPayload) {
                triggerHackerIntelReply(userId, char, hackerIntelPayload).catch(err => {
                    console.error(`[City->Chat] 黑客据点私聊回报失败: ${err.message}`);
                });
            }
        }

        const questOutcome = await handleQuestLifecycleAfterAction(db, char, district, richNarrations);
        const totalCalDelta = dCal + Number(questOutcome.bonusCalories || 0);
        const totalMoneyDelta = dMoney + Number(questOutcome.bonusMoney || 0);
        const newCals = Math.min(4000, Math.max(0, currentCals + totalCalDelta));
        const newWallet = Math.max(0, (char.wallet || 0) + totalMoneyDelta);
        const nextState = applyStateEffectsToCharacter(char, stateEffects);
        const newCityStatus = district.type === 'medical' && currentCals < 800
            ? 'medical'
            : district.duration_ticks > 1
                ? (district.type === 'work' ? 'working' : district.type === 'rest' ? 'sleeping' : 'eating')
                : (newCals < 500 ? 'hungry' : 'idle');

        const medicalStayMinutes = district.type === 'medical' && newCityStatus === 'medical'
            ? getMedicalStayMinutes(district)
            : 0;

        const actionPatch = {
            calories: newCals,
            city_status: newCityStatus,
            location: district.id,
            wallet: newWallet,
            city_status_started_at: newCityStatus === 'medical' ? cityNowMs : 0,
            city_status_until_at: newCityStatus === 'medical' ? cityNowMs + medicalStayMinutes * 60 * 1000 : 0,
            city_medical_last_recovery_at: newCityStatus === 'medical' ? cityNowMs : 0,
            work_distraction: newCityStatus === 'working' ? 0 : (char.work_distraction ?? 0),
            sleep_disruption: newCityStatus === 'sleeping' ? 0 : (char.sleep_disruption ?? 0),
            ...nextState
        };
        db.updateCharacter(char.id, actionPatch);
        logEmotionTransitionToState(
            db,
            char,
            { ...char, ...actionPatch },
            `city_action_${district.type}`,
            `角色在商业街执行了 ${district.name} 行动，生理状态与主情绪发生变化。`
        );
        broadcastCityEvent(userId, char.id, district.id.toUpperCase(), `${char.name} -> ${district.emoji} ${district.name}`);

        const wsClients = getWsClients(userId);
        const engine = getEngine(userId);
        if (engine && typeof engine.broadcastWalletSync === 'function') {
            engine.broadcastWalletSync(wsClients, char.id);
        }
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
        const questCompetitionContext = buildQuestCompetitionContext(db, occupants, district);

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
${logsContext ? '\n' + logsContext : ''}${questCompetitionContext ? '\n' + questCompetitionContext : ''}`;

            if (simulationLogs.length > 0) {
                prompt += `\n\n【刚才在你面前已经发生的事情】\n${simulationLogs.join('\n')}\n`;
            } else {
                prompt += `\n\n你是第一个开口或行动的人。`;
            }

            prompt += `\n\n请根据你的性格、历史印象和当前状态，写下你此刻会说的一句话或做的一个动作。字数控制在 50 字左右，必须是第三人称视角的动作描述或对白。只直接返回行为描述，不要输出多余格式或 JSON。`;

            try {
                const messages = [
                    { role: 'system', content: '你是一个商业街社交遭遇模拟器。请用第三人称描述角色说的话或做的动作，控制在 50 字左右。只输出行为描述文本，不要输出 JSON 或其他格式。' },
                    { role: 'user', content: prompt }
                ];
                recordCityLlmDebug(db, speaker, 'input', 'city_social_encounter', messages, { model: speaker.model_name, location: speaker.location || '' });
                const reply = await callLLM({
                    endpoint: speaker.api_endpoint, key: speaker.api_key, model: speaker.model_name,
                    messages, maxTokens: 3000, temperature: 0.85
                });
                recordCityLlmDebug(db, speaker, 'output', 'city_social_encounter', reply, { model: speaker.model_name, location: speaker.location || '' });
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
        if (questCompetitionContext) {
            systemPrompt += `\n${questCompetitionContext}\n`;
            systemPrompt += `- 这次总结里要能看出他们是因为同一单公告任务撞上的。\n`;
            systemPrompt += `- 如果互动里存在互相试探、抢先、让步、嘴硬或暗暗较劲，请把这种竞争气氛结算进 summary_log、diary 或 impression。\n`;
        }
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
            const messages = [{ role: 'user', content: systemPrompt }];
            recordCityLlmDebug(db, systemApiChar, 'input', 'city_social_resolution', messages, { model: systemApiChar.model_name });
            const reply = await callLLM({
                endpoint: systemApiChar.api_endpoint, key: systemApiChar.api_key, model: systemApiChar.model_name,
                messages, maxTokens: 4000, temperature: 0.7
            });
            recordCityLlmDebug(db, systemApiChar, 'output', 'city_social_resolution', reply, { model: systemApiChar.model_name });
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
                summary_log: buildCollapsedCityLog(occupants[0], '社交遭遇文案生成失败', { district }),
                characters: {}
            };
            for (const c of occupants) {
                systemResult.characters[c.id] = {
                    chat: '',
                    moment: '',
                    diary: '',
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

            const socialEmotionPatch = applyEmotionEvent(c, 'city_social_event');
            if (socialEmotionPatch) {
                db.updateCharacter(c.id, socialEmotionPatch);
                logEmotionTransition(
                    db,
                    c,
                    socialEmotionPatch,
                    'city_social_event',
                    `角色在商业街 ${locId} 与他人发生社交互动后，情绪状态发生变化。`
                );
            }

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
            if (plan) {
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
    const mayorRunLocks = new Set();

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

    function markMayorRun(db, timestamp = Date.now()) {
        try {
            db.city.setConfig('mayor_last_run_at', String(timestamp));
        } catch (e) {
            console.warn('[Mayor AI] Failed to persist last run time:', e.message);
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

    function shouldAutoRunMayor(db, now = Date.now()) {
        const config = db.city.getConfig();
        const mayorEnabled = config.mayor_enabled === '1' || config.mayor_enabled === 'true';
        if (!mayorEnabled) return false;
        const intervalHours = Math.max(1, parseInt(config.mayor_interval_hours, 10) || 6);
        const lastRunAt = parseInt(config.mayor_last_run_at, 10) || 0;
        return !lastRunAt || (now - lastRunAt) >= intervalHours * 60 * 60 * 1000;
    }

    async function maybeRunMayorAI(db, runKey, { force = false } = {}) {
        const lockKey = String(runKey || 'default');
        if (mayorRunLocks.has(lockKey)) {
            return { success: false, skipped: true, reason: 'already_running' };
        }
        if (!force && !shouldAutoRunMayor(db)) {
            return { success: false, skipped: true, reason: 'not_due' };
        }
        mayorRunLocks.add(lockKey);
        try {
            return await runMayorAI(db);
        } finally {
            mayorRunLocks.delete(lockKey);
        }
    }

    async function runMayorAI(db) {
        const finishedAt = Date.now();
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
                const result = { success: false, reason: 'no_api_config', canRetry: true };
                markMayorRun(db, finishedAt);
                return result;
            }
            console.log(`[Mayor AI] 使用 ${aiChar.name} 的模型 (${aiChar.model_name})`);

            const context = buildMayorContext(db);
            const fullPrompt = mayorPrompt + '\n\n' + context;

            console.log('[Mayor AI] 🏛️ 市长正在做决策...');
            const messages = [{ role: 'user', content: fullPrompt }];
            recordCityLlmDebug(db, aiChar, 'input', 'city_mayor_decision', messages, { model: aiChar.model_name });
            const reply = await callLLM({
                endpoint: aiChar.api_endpoint, key: aiChar.api_key, model: aiChar.model_name,
                messages,
                maxTokens: 3000, temperature: 0.9
            });
            recordCityLlmDebug(db, aiChar, 'output', 'city_mayor_decision', reply, { model: aiChar.model_name });

            // Extract JSON from reply
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.log('[Mayor AI] ⚠️ 回复不含 JSON，停止本轮，不使用规则兜底。');
                const result = {
                    success: false,
                    reason: 'malformed_output',
                    error: '市长 AI 返回内容不是合法 JSON。',
                    canRetry: true
                };
                markMayorRun(db, finishedAt);
                return result;
            }

            const decision = JSON.parse(jsonMatch[0]);
            const result = applyMayorDecisions(db, decision);
            markMayorRun(db, finishedAt);
            return result;
        } catch (e) {
            console.error('[Mayor AI] 决策失败:', e.message);
            const result = {
                success: false,
                reason: 'mayor_api_failed',
                error: e.message,
                canRetry: true
            };
            markMayorRun(db, finishedAt);
            return result;
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
                    const questId = db.city.createQuest({
                        title: q.title, emoji: q.emoji || '📐', description: q.description || '',
                        reward_gold: q.reward_gold ?? 50, reward_cal: q.reward_cal ?? 0,
                        difficulty: q.difficulty || 'normal'
                    });
                    publishQuestAnnouncement(db, questId, q);
                    db.city.logAction('system', 'QUEST', `📐 新悬赏任务: ${q.title} (${q.difficulty || 'normal'}) - 奖励 ${q.reward_gold ?? 50} 金币`, 0, 0);
                    results.quests++;
                }
            }
        }

        // Announcement
        if (decision.announcement) {
            db.city.logAction('system', 'ANNOUNCE', `📙 城市广播: ${decision.announcement}`, 0, 0);
            recordMayorAnnouncement(db, '市长广播', decision.announcement);
            results.announcement = decision.announcement;
        } else {
            const summaryParts = [];
            if (results.price_changes > 0) summaryParts.push(`今日调整了 ${results.price_changes} 项物价`);
            if (results.events > 0) summaryParts.push(`新增了 ${results.events} 项城市事件`);
            if (results.quests > 0) summaryParts.push(`发布了 ${results.quests} 项悬赏任务`);
            if (summaryParts.length > 0) {
                const summary = `市政简报：${summaryParts.join('，')}。请市民留意公告栏与街头变化。`;
                db.city.logAction('system', 'ANNOUNCE', `📙 城市广播: ${summary}`, 0, 0);
                recordMayorAnnouncement(db, '市政简报', summary);
                results.announcement = summary;
            }
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
            const questId = db.city.createQuest({ title: q.title, emoji: q.emoji, description: q.desc, reward_gold: q.gold, difficulty: q.diff });
            publishQuestAnnouncement(db, questId, { title: q.title, emoji: q.emoji, description: q.desc, reward_gold: q.gold, difficulty: q.diff });
            db.city.logAction('system', 'QUEST', `📐 新悬赏: ${q.title} - 奖励 ${q.gold} 金币`, 0, 0);
        } catch (e) { console.error('[Mayor fallback] Quest error:', e.message); }

        const fallbackAnnouncement = `城市广播：今日天气为${w.title}，布告栏新增任务“${q.title}”。请市民按需安排行程。`;
        try {
            db.city.logAction('system', 'ANNOUNCE', `📙 ${fallbackAnnouncement}`, 0, 0);
            recordMayorAnnouncement(db, '市长广播', fallbackAnnouncement);
        } catch (e) {
            console.error('[Mayor fallback] Announcement error:', e.message);
        }

        console.log('[Mayor AI] 使用规则生成: ' + w.title + ' + ' + q.title);
        return { success: true, results: { price_changes: 0, events: 1, quests: 1, announcement: fallbackAnnouncement }, fallback: true };
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
            const questId = req.db.city.createQuest(req.body);
            publishQuestAnnouncement(req.db, questId, req.body);
            res.json({ success: true, questId });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/city/quests/:id/claim', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const questId = req.params.id;
            const charId = String(req.body?.characterId || '').trim();
            if (!charId) return res.status(400).json({ error: '缺少 characterId' });
            const quest = req.db.city.getAllQuests(1000).find((item) => String(item.id) === String(questId));
            if (!quest) return res.status(404).json({ error: '任务不存在' });
            const char = req.db.getCharacter(charId);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            if (quest.is_completed) return res.status(400).json({ error: '任务已完成' });
            const claimResult = req.db.city.claimQuest(questId, charId);
            if (!claimResult?.success) return res.status(400).json({ error: '任务领取失败' });
            req.db.city.logAction('system', 'QUEST', `📌 ${char.name} 领取了悬赏任务「${quest.title}」`, 0, 0);
            if (typeof req.db.city.addCityAnnouncement === 'function') {
                req.db.city.addCityAnnouncement('system', '任务状态', `${char.name} 已领取悬赏任务「${quest.title}」`, 'street');
            }
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/city/quests/:id/complete', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const questId = req.params.id;
            const charId = String(req.body?.characterId || '').trim();
            if (!charId) return res.status(400).json({ error: '缺少 characterId' });
            const quest = req.db.city.getAllQuests(1000).find((item) => String(item.id) === String(questId));
            if (!quest) return res.status(404).json({ error: '任务不存在' });
            const claimant = req.db.getCharacter(charId);
            if (!claimant) return res.status(404).json({ error: '角色不存在' });
            const completion = req.db.city.resolveQuestCompletion(questId, charId);
            if (!completion?.success) return res.status(400).json({ error: '任务完成失败' });

            if (completion.won) {
                const wallet = Number(claimant.wallet || 0) + Number(completion.reward_gold || 0);
                const calories = Number(claimant.calories || 0) + Number(completion.reward_cal || 0);
                req.db.updateCharacter(claimant.id, { wallet, calories });
                const resolution = await buildQuestResolutionNarrations(claimant, quest, req.db.city.getDistrict(quest.target_district) || { id: quest.target_district || 'street', name: quest.target_district || 'street', emoji: '' }, req.db, 'success');
                req.db.city.logAction(claimant.id, 'QUEST', resolution.log, 0, 0, quest.target_district || 'street');
                req.db.city.logAction('system', 'QUEST', resolution.systemLog, 0, 0, quest.target_district || 'street');
                if (quest.source_announcement_id) req.db.city.deleteCityAnnouncement?.(quest.source_announcement_id);
                req.db.city.addCityAnnouncement?.('system', '任务完成', resolution.announcement, 'street');
                res.json({ success: true, won: true });
                return;
            }

            const resolution = await buildQuestResolutionNarrations(claimant, quest, req.db.city.getDistrict(quest.target_district) || { id: quest.target_district || 'street', name: quest.target_district || 'street', emoji: '' }, req.db, 'failed');
            req.db.city.logAction(claimant.id, 'QUEST', resolution.log, 0, 0, quest.target_district || 'street');
            req.db.city.logAction('system', 'QUEST', resolution.systemLog, 0, 0, quest.target_district || 'street');
            req.db.city.addCityAnnouncement?.('system', '任务失效', resolution.announcement, 'street');
            res.json({ success: true, won: false, reason: completion.reason || 'already_completed' });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/city/quests/:id', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const quest = req.db.city.getQuestById?.(req.params.id);
            if (quest?.source_announcement_id) req.db.city.deleteCityAnnouncement?.(quest.source_announcement_id);
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
                        const { id: msgId, timestamp: msgTs } = db.addMessage(char.id, 'character', chatContent);
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
                const messages = [{ role: 'user', content: prompt }];
                recordCityLlmDebug(db, char, 'input', 'city_timeskip_backfill', messages, { model: char.model_name });
                const reply = await callLLM({
                    endpoint: char.api_endpoint, key: char.api_key, model: char.model_name,
                    messages, maxTokens: 3000, temperature: 0.95
                });
                recordCityLlmDebug(db, char, 'output', 'city_timeskip_backfill', reply, { model: char.model_name });

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

            // Failure folding
            if (fallbackToOrdinary) {
                result = {
                    summary: buildCollapsedCityLog(char, '时间跳过总结生成失败', { locationLabel: `${skippedHoursDelta}小时` }),
                    tasks_completed: [],
                    tasks_missed: missedTasks.map(t => Number(t.hour)),
                    chat: "",
                    moment: "",
                    diary: ""
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

    context.hooks.cityActionSuggestionCallback = maybeTriggerSuggestedCityAction;
    context.hooks.cityBusyChatImpactPatch = buildBusyChatImpactPatch;
    context.hooks.cityReplyStateSyncCallback = maybeSyncReplyDeclaredState;
    context.hooks.cityReplyIntentCallback = maybeExecuteReplyCityIntent;
    context.hooks.cityReplyActionCallback = maybeExecuteReplyCityAction;

    console.log('[City DLC] 商业街与生存系统路由已注册');
};
