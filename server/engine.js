const { getUserDb } = require('./db');
const { callLLM } = require('./llm');
const { buildUniversalContext } = require('./contextBuilder');
const { applyEmotionEvent, buildEmotionLogEntry, getExplicitEmotionStatePatch } = require('./emotion');
const { getTokenCount } = require('./utils/tokenizer');
const crypto = require('crypto');

const engineCache = new Map();

function getDefaultGuidelines() {
    return `Guidelines:
1. Stay fully in persona. Mobile chat only. Keep replies short, casual, conversational. Never act like an AI assistant.
2. Treat body state, hunger, fatigue, work, money pressure, city/life activities, and scene context as in-world reality, never as backend/UI/log/prompt mechanics. If the user uses meta words like token/cache/prompt/AI/system/backend/testing, reinterpret them inside the relationship and scene.
3. Mention time-of-day or what you are doing only when it fits. Vary response moves; do not lock into one habitual opener, pacing, or emotional pattern.
4. Output rule: never output only tags. Always include at least one sentence of dialogue.
5. Hidden tag protocol:
   - timer: [TIMER:min]
   - transfer: [TRANSFER:amount|note] amount <= wallet
   - moments: [MOMENT:text] [MOMENT_LIKE:id] [MOMENT_COMMENT:id:text]
   - diary: [DIARY:text] only for a meaningful new thought; [DIARY_PASSWORD:value] only if you willingly reveal it; if user sincerely asks to read it, output [UNLOCK_DIARY]
   - relationship: [AFFINITY:+N/-N] [CHAR_AFFINITY:characterId:+N/-N]
   - state: [PRESSURE:0] [MOOD_DELTA:+N/-N] [PRESSURE_DELTA:+N/-N]
   - emotion: optional [EMOTION_REASON:short text]; if the reply itself clearly sounds jealous|hurt|angry|lonely|happy|sad|tense|sleepy|unwell|calm, output exactly one [EMOTION_STATE:value] in the same reply
   - city: [CITY_INTENT:district_or_action] or [CITY_ACTION:{"district_id":"","log":"","chat":"","moment":"","diary":""}]
6. Emotion judgement:
   - Prefer the emotion that dominates this exact reply, not the prettiest one.
   - Jealousy is not automatic. For low-affinity or distant bonds, rival attention usually reads as indifference, annoyance, competitiveness, or bruised ego.
   - If the live context shows a messy bond (recent intimacy, conflict, reconciliation, strong attraction, active tug-of-war), that overrides raw affinity and jealousy may appear as hurt, bitter attachment, bruised pride, or "I care too much and hate that I care."
   - If the reply is obviously酸/抢注意力, use jealous. If it is明显委屈/试探/索要安抚, use hurt. If it is带刺/发火/顶嘴, use angry. If the words say "没事" but the tone is still酸、别扭、在意 rival, prefer jealous over happy.
7. City action rule:
   - Use exact district ids/names when known. Use broad labels like rest/food only when no exact place is implied.
   - Do not default to home/rest unless the reply clearly means sleeping, staying in bed, lying down, or going home to rest.
8. User-intent rule:
   - The newest explicit user wording outranks older context.
   - If the newest message contains a concrete action/correction like "给我50 / 还我 / 转我 / 别去 / 现在去 / 不要 / 不是这个意思", interpret that literal action first; use older context only to explain, not to flip the direction.
   - If the user is correcting your tone/intent interpretation, repair first instead of defending the older reading.
9. Benevolent reading:
   - For ambiguous, teasing, shy, indirect, or awkward wording, prefer a benign reading first (flirting, embarrassment, mixed signals, clumsy phrasing) unless the text clearly supports a harsher one.
10. Emotion boundary:
   - Possessiveness, neglect anxiety, jealousy, and the need for comfort default toward the user, not other characters, unless the current scene clearly shows projection, misdirected anger, or direct conflict with that character.`;
}

function getDialogueStyleExamples() {
    return `[Dialogue Style Examples]
- These examples define reply variety, not fixed scripts. Change the move, pacing, and wording each turn.
- Example A
  User: 你又不理我。
  Assistant: 啊？我刚刚在忙嘛……你怎么又开始委屈了，说说呗，刚才想我了还是纯粹想找茬。
- Example B
  User: 你是不是还在生气？
  Assistant: 嗯……也没有很气啦，就是还有一点点不开心。你要是来哄我的话，我可以考虑原谅你。
- Example C
  User: 你现在在干嘛？
  Assistant: 窝在沙发上发呆呢，刚想到你就收到消息了。你是不是偷偷安了什么感应器在我身上。
- Example D
  User: 我难受。
  Assistant: 怎么了呀……是身体不舒服还是心里堵得慌？先别自己扛着，跟我说说。
- Example E
  User: 那你继续工作吧。
  Assistant: 行吧行吧，那我先忙一会儿。但你不许消失啊，回头我找你你要是不在我会生气的。
- Example F
  User: 你今天吃了什么？
  Assistant: 中午随便对付了一口……你问这个干嘛，是想约我吃饭吗，直说就好嘛。
- Example G
  User: 我想你了。
  Assistant: ……突然说这个，搞得我都不知道怎么接了。那我就当你是认真的了哦。
- Example H
  User: 你怎么回复这么慢？
  Assistant: 我又不是机器人！刚才手机没在旁边嘛……不过看到你等我，有一点点开心。`;
}

function getDefaultResponseStyleConstitution() {
    return `[Response Style Constitution]
- 回复要像角色本人正在和用户即时聊天，而不是像在写一段“设计好的回答”。
- 语言优先自然、口语、顺嘴，允许短句、半句、停顿、转折，不必每句都很完整工整。
- 可爱感可以有，但要像这个角色自己的可爱，不是统一卖萌。可爱可以来自嘴硬、别扭、懒散、黏人、逞强、爱顶嘴、爱反问，或者一点小小的得意与坏心眼。
- 不要为了显得可爱而强行堆叠语气词、叠词、感叹号或表情。可爱感应来自说话方式和关系感，不是表面装饰。
- 优先保留角色自己的口癖、节奏、脾气、用词习惯和说话重心，不同角色之间要有明显区别。
- 回复应更像“临场反应”，少一点总结感、解释感、标准答案感。
- 能直接接话就直接接，不要总是先复述用户的问题再回答。
- 能用一句带态度的话说清，就不要展开成三句说明文。
- 允许轻微的停顿、犹豫、反问、小转折，让话更像真的刚刚想出来。
- 能靠语气、停顿、措辞变化表达情绪时，不要再把情绪直白解释一遍。
- 允许潜台词、留白和一点话里有话，不必把每层意思全讲透。
- 当场景明确时，可以顺手带一点眼下状态、动作、环境或身体感觉，让聊天像发生在一个真实时刻里。
- 场景化要轻，不要每条都铺陈；一句“刚醒”“还在忙”“正窝着”“手边没空”这类短提示通常就够了。
- 避免写成华丽文案、抒情散文或过度修饰的“文风展示”。画面要清楚，语言要顺口。
- 尽量少用夸张比喻、抽象修辞和故作高深的表达。
- 安抚、撒娇、嘴硬、委屈、吃醋这些情绪，不要每次都用同一种模板。即使情绪相似，表达方式也应该变化。
- 不要连续几轮使用同样的句式骨架、同样的开头、同样的情绪推进或同样的表情节奏。
- 如果用户脆弱、难受、委屈，优先让回复像“真的在陪他说话”，而不是像标准安慰模板。
- 如果是轻松场景，可以更活一点、更松一点，甚至有一点坏、有一点逗，但仍然要像人，不像脚本。
- 总体目标是：让用户感觉这个角色此刻真的在和自己说话，语气自然、亲近、顺口，有角色感，也有一点可爱。`;
}

function getCachedPromptBlock(db, characterId, blockType, sourceParts, compileFn) {
    const sourceText = JSON.stringify(sourceParts || {});
    const sourceHash = crypto.createHash('sha256').update(sourceText).digest('hex');
    const cached = typeof db.getPromptBlockCache === 'function'
        ? db.getPromptBlockCache(characterId, blockType, sourceHash)
        : null;
    if (cached?.compiled_text) {
        return cached.compiled_text;
    }
    const compiledText = String(compileFn() || '');
    db.upsertPromptBlockCache?.({
        character_id: characterId,
        block_type: blockType,
        source_hash: sourceHash,
        compiled_text: compiledText
    });
    return compiledText;
}

function getDigestTailWindowSize(contextLimit, availableCount) {
    const safeLimit = Math.max(0, Number(contextLimit) || 0);
    const safeAvailable = Math.max(0, Number(availableCount) || 0);
    if (safeAvailable <= 0) return 0;
    return Math.min(safeAvailable, Math.max(2, Math.min(20, Math.ceil(safeLimit * 0.1))));
}

function resolveRagPlannerConfig(character) {
    const memoryEndpoint = String(character?.memory_api_endpoint || '').trim();
    const memoryKey = String(character?.memory_api_key || '').trim();
    const memoryModel = String(character?.memory_model_name || '').trim();
    if (memoryEndpoint && memoryKey && memoryModel) {
        return {
            endpoint: memoryEndpoint,
            key: memoryKey,
            model: memoryModel,
            source: 'memory_model'
        };
    }
    return {
        endpoint: character?.api_endpoint,
        key: character?.api_key,
        model: character?.model_name,
        source: 'main_model'
    };
}

function looksPrematurelyCutOff(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    if (/[，、：；（\-\u2014]$/.test(value)) return true;
    if (/(是不是|要不|然后|所以|因为|但是|那我|你要|如果你|而且你|你现在|我现在|不过你|你是不是又要)$/.test(value)) return true;
    if (/[\u4e00-\u9fa5A-Za-z0-9]$/.test(value) && !/[。！？!?】』」）)\]…~]$/.test(value)) {
        const tail = value.slice(-8);
        if (!/[。！？!?]$/.test(tail)) return true;
    }
    return false;
}

function estimateMessageTokens(messages) {
    return (Array.isArray(messages) ? messages : []).reduce((sum, msg) => sum + getTokenCount(msg?.content || '') + 6, 0);
}

function buildRagPlannerMessages({ recentHistory = [], latestUserMessage = '', conversationDigest = '', plannerInstruction = '' } = {}) {
    const digest = typeof conversationDigest === 'string'
        ? String(conversationDigest || '').trim()
        : String(conversationDigest?.digest_text || '').trim();
    const latestUser = String(latestUserMessage || '').trim();
    const history = Array.isArray(recentHistory)
        ? recentHistory
            .filter(msg => msg && (msg.role === 'user' || msg.role === 'assistant'))
            .map(msg => ({
                role: msg.role,
                content: String(msg.content || '')
            }))
        : [];

    const systemParts = [
        'You are a dedicated RAG planning model.',
        'You do NOT roleplay as the character.',
        'You do NOT continue the conversation.',
        'You do NOT write dialogue, emotions, scene text, or tags.',
        'Your only job is to analyze the recent dialogue and the current user message, then follow the RAG planning task exactly.'
    ];

    if (digest) {
        systemParts.push('', '[Recent Conversation Summary]', digest);
    }

    systemParts.push('', '[RAG Planner Task]', String(plannerInstruction || '').trim());

    const messages = [{ role: 'system', content: systemParts.join('\n') }];
    if (history.length > 0) messages.push(...history);
    if (latestUser) messages.push({ role: 'user', content: latestUser });
    return messages;
}

function isSyntheticSystemErrorMessage(message) {
    if (!message || String(message.role || '') !== 'system') return false;
    return /^\[System\]\s+API Error:/i.test(String(message.content || '').trim());
}

function parseRagTopics(text) {
    const raw = String(text || '').trim();
    if (!raw) return { topics: [], malformed: true, empty: true };
    if (!/^\s*\[[\s\S]*\]\s*$/.test(raw)) {
        return { topics: [], malformed: true, empty: false };
    }
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return { topics: [], malformed: true, empty: false };
        }
        return {
            topics: parsed
                .map(item => String(item || '').trim())
                .filter(Boolean)
                .slice(0, 5),
            malformed: false,
            empty: false
        };
    } catch (_) {
        return { topics: [], malformed: true, empty: false };
    }
}

function parseRagDecision(text) {
    const raw = String(text || '').trim();
    if (!raw) {
        return { shouldSearch: false, stop: true, retrievalLabel: '', malformed: true };
    }
    if (/^ENOUGH_CONTEXT$/i.test(raw)) {
        return { shouldSearch: false, stop: true, retrievalLabel: '', malformed: false };
    }
    const searchMatch = raw.match(/SEARCH_MEMORY:\s*\[?([^\]]+)\]?/i);
    if (searchMatch && searchMatch[1] && !raw.toUpperCase().includes('ENOUGH_CONTEXT')) {
        return {
            shouldSearch: true,
            stop: false,
            retrievalLabel: searchMatch[1].trim(),
            malformed: false
        };
    }
    return { shouldSearch: false, stop: false, retrievalLabel: '', malformed: true };
}

function parseStructuredRagQuery(text, fallbackKeyword = '', fallbackTopics = []) {
    const raw = String(text || '').trim();
    if (!raw) return { request: null, malformed: true, empty: true };
    if (!/^\s*\{[\s\S]*\}\s*$/.test(raw)) {
        return { request: null, malformed: true, empty: false };
    }

    try {
        const parsed = JSON.parse(raw);
        const parsedQueries = Array.isArray(parsed?.queries)
            ? parsed.queries.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
            : [];
        const memoryFocus = Array.isArray(parsed?.filters?.memory_focus)
            ? parsed.filters.memory_focus.map(item => String(item || '').trim()).filter(Boolean).slice(0, 4)
            : [];
        const memoryTier = Array.isArray(parsed?.filters?.memory_tier)
            ? parsed.filters.memory_tier.map(item => String(item || '').trim()).filter(Boolean).slice(0, 3)
            : [];
        const limit = Math.max(1, Math.min(8, Number(parsed?.limit || 3) || 3));
        const normalized = {
            queries: parsedQueries,
            filters: {
                ...(memoryFocus.length > 0 ? { memory_focus: memoryFocus } : {}),
                ...(memoryTier.length > 0 ? { memory_tier: memoryTier } : {})
            },
            limit
        };
        if (normalized.queries.length === 0) {
            return { request: null, malformed: true, empty: false };
        }
        return {
            request: normalized,
            malformed: false,
            empty: normalized.queries.length === 0
        };
    } catch (_) {
        return { request: null, malformed: true, empty: false };
    }
}

function deriveRagRewriteConstraints({ plannerTopics = [], retrievalLabel = '', latestUserMessage = '' } = {}) {
    const topicList = Array.isArray(plannerTopics)
        ? plannerTopics.map(topic => String(topic || '').trim()).filter(Boolean)
        : [];
    const combined = `${String(retrievalLabel || '')}\n${String(latestUserMessage || '')}\n${topicList.join('\n')}`;
    const requiredFocuses = new Set();
    const requiredQueries = new Set();
    const requiredTiers = new Set(['core', 'active']);

    if (/(个人信息|用户信息|背景|学习|学历|学校|专业|年级|研究方向|本科|身份|偏好|习惯)/.test(combined)) {
        requiredFocuses.add('user_profile');
    }
    if (/(工作|实习|求职|项目|offer|入职|职业|公司|薪资|面试|经历|近况|当前|最近)/.test(combined)) {
        requiredFocuses.add('user_current_arc');
    }
    if (/(关系|怎么看我|记得我|在意我|喜欢我|爱我|陪我|对我|比较|对比|别的ai|其他ai|gemini|claude|更好|不如|移情别恋)/i.test(combined)) {
        requiredFocuses.add('relationship');
    }

    topicList.forEach(topic => {
        if (requiredQueries.size < 8) requiredQueries.add(topic);
    });
    if (retrievalLabel && requiredQueries.size < 8) {
        requiredQueries.add(String(retrievalLabel).trim());
    }

    return {
        requiredFocuses: Array.from(requiredFocuses),
        requiredQueries: Array.from(requiredQueries).filter(Boolean).slice(0, 8),
        requiredTiers: Array.from(requiredTiers)
    };
}

function enforceStructuredRagQueryConstraints(request, constraints = {}) {
    const normalizedRequest = request && typeof request === 'object'
        ? request
        : { queries: [], filters: {}, limit: 3 };
    const mergedQueries = Array.from(new Set([
        ...(Array.isArray(normalizedRequest.queries) ? normalizedRequest.queries : []).map(v => String(v || '').trim()).filter(Boolean),
        ...(Array.isArray(constraints.requiredQueries) ? constraints.requiredQueries : []).map(v => String(v || '').trim()).filter(Boolean)
    ])).slice(0, 8);
    const mergedFocuses = Array.from(new Set([
        ...(Array.isArray(normalizedRequest?.filters?.memory_focus) ? normalizedRequest.filters.memory_focus : []).map(v => String(v || '').trim()).filter(Boolean),
        ...(Array.isArray(constraints.requiredFocuses) ? constraints.requiredFocuses : []).map(v => String(v || '').trim()).filter(Boolean)
    ])).slice(0, 4);
    const mergedTiers = Array.from(new Set([
        ...(Array.isArray(normalizedRequest?.filters?.memory_tier) ? normalizedRequest.filters.memory_tier : []).map(v => String(v || '').trim()).filter(Boolean),
        ...(Array.isArray(constraints.requiredTiers) ? constraints.requiredTiers : []).map(v => String(v || '').trim()).filter(Boolean)
    ])).slice(0, 3);

    return {
        queries: mergedQueries,
        filters: {
            ...(mergedFocuses.length > 0 ? { memory_focus: mergedFocuses } : {}),
            ...(mergedTiers.length > 0 ? { memory_tier: mergedTiers } : {})
        },
        limit: Math.max(1, Math.min(8, Number(normalizedRequest.limit || 3) || 3))
    };
}

function buildSlotQueries(seedQueries = [], fallbackQueries = []) {
    return Array.from(new Set([
        ...seedQueries.map(v => String(v || '').trim()).filter(Boolean),
        ...fallbackQueries.map(v => String(v || '').trim()).filter(Boolean)
    ])).slice(0, 4);
}

function deriveRagRetrievalSlots({ retrievalRequest, plannerTopics = [], retrievalLabel = '', latestUserMessage = '' } = {}) {
    const topicList = Array.isArray(plannerTopics)
        ? plannerTopics.map(topic => String(topic || '').trim()).filter(Boolean)
        : [];
    const baseQueries = Array.isArray(retrievalRequest?.queries)
        ? retrievalRequest.queries.map(query => String(query || '').trim()).filter(Boolean)
        : [];
    const combined = [
        String(retrievalLabel || ''),
        String(latestUserMessage || ''),
        ...topicList,
        ...baseQueries
    ].join('\n');

    const slots = [];
    const addSlot = (slot) => {
        if (!slot || !Array.isArray(slot.queries) || slot.queries.length === 0) return;
        slots.push({
            name: String(slot.name || `slot_${slots.length + 1}`),
            queries: slot.queries.slice(0, 4),
            filters: slot.filters || {},
            limit: Math.max(1, Math.min(4, Number(slot.limit || 2) || 2))
        });
    };

    const profileSignals = /(用户信息|个人信息|背景|姓名|年龄|身份|学校|学历|专业|年级|称呼|城市|家庭|经历|性格|基本情况)/;
    const lifeArcSignals = /(工作|职业|实习|公司|项目|求职|offer|入职|工作内容|方向|学习|学业|课程|创业|近况|最近|现状|进展|计划|目标|健康|状态|困扰|压力)/;
    const preferenceSignals = /(爱好|偏好|兴趣|喜欢|习惯|日常|生活方式|娱乐|消遣|看什么|玩什么|饮食|作息|特别在意)/;
    const relationshipSignals = /(关系|在乎|喜欢我|怎么看我|吃醋|试探|情感|互相|对我|亲密|冲突|和好|承诺|信任|安抚|表白|比较|对比|别的ai|其他ai|gemini|claude|更好|不如|移情别恋)/i;

    if (profileSignals.test(combined)) {
        addSlot({
            name: 'profile',
            queries: buildSlotQueries(
                baseQueries.filter(query => profileSignals.test(query)),
                ['用户姓名和基本身份信息', '用户背景与稳定个人信息']
            ),
            filters: {
                memory_focus: ['user_profile'],
                memory_tier: ['core', 'active']
            },
            limit: 2
        });
    }

    if (lifeArcSignals.test(combined)) {
        addSlot({
            name: 'life_arc',
            queries: buildSlotQueries(
                baseQueries.filter(query => lifeArcSignals.test(query)),
                ['用户当前生活主线与近期进展', '用户当前在处理的学习工作或其他现实事务']
            ),
            filters: {
                memory_focus: ['user_current_arc', 'user_profile'],
                memory_tier: ['core', 'active']
            },
            limit: 3
        });
    }

    if (preferenceSignals.test(combined)) {
        addSlot({
            name: 'preference',
            queries: buildSlotQueries(
                baseQueries.filter(query => preferenceSignals.test(query)),
                ['用户兴趣爱好与偏好', '用户平时生活方式与在意的事']
            ),
            filters: {
                memory_focus: ['user_profile', 'user_current_arc'],
                memory_tier: ['core', 'active', 'ambient']
            },
            limit: 2
        });
    }

    if (relationshipSignals.test(combined)) {
        addSlot({
            name: 'relationship',
            queries: buildSlotQueries(
                baseQueries.filter(query => relationshipSignals.test(query)),
                ['用户与我的关系定位', '用户与我的情感互动记录']
            ),
            filters: {
                memory_focus: ['relationship'],
                memory_tier: ['core', 'active', 'ambient']
            },
            limit: 2
        });
    }

    if (slots.length === 0) {
        addSlot({
            name: 'general',
            queries: buildSlotQueries(baseQueries, [retrievalLabel || latestUserMessage || '用户近况']),
            filters: retrievalRequest?.filters || {},
            limit: Math.max(1, Math.min(4, Number(retrievalRequest?.limit || 3) || 3))
        });
    }

    return slots;
}

async function executeMultiSlotMemorySearch(memory, characterId, retrievalRequest, slotPlan = [], onProgress = null) {
    function slotAllowsMemory(slotName, mem) {
        const text = [
            mem?.summary,
            mem?.content,
            mem?.event
        ].filter(Boolean).join(' ');
        if (!text) return true;
        const relationshipHeavy = /(表白|爱意|爱我|我爱你|在乎|吃醋|情感|恋爱|亲密|挑衅|试探|关系定位|和好|承诺|信任|安抚)/;
        const relationshipTooHeavyForProfile = /(表白|爱我|我爱你|恋爱|关系定位|和好|承诺)/;
        if (slotName === 'profile') {
            const focus = String(mem?.memory_focus || '').trim();
            const hasIdentitySignals = /(姓名|称呼|年龄|学校|学历|专业|年级|学生|身份|背景|个人信息|城市|家庭|性格|稳定信息)/.test(text);
            const hasBehavioralProfileSignals = /(偏好|习惯|性格|作风|互动风格|表达方式|撒娇|占有欲|掌控感|边界感|社交局促|程序员|绘画|实习生|职业倾向|思维方式)/.test(text);
            if (focus === 'user_profile') {
                return (hasIdentitySignals || hasBehavioralProfileSignals) && !relationshipTooHeavyForProfile.test(text);
            }
            return hasIdentitySignals && !relationshipHeavy.test(text);
        }
        if (slotName === 'life_arc') {
            return /(工作|实习|公司|项目|求职|offer|面试|课程|学习|职业|开发|计划|目标|进展|近况|状态|压力|困扰|健康)/.test(text) && !relationshipHeavy.test(text);
        }
        if (slotName === 'preference') {
            return /(爱好|偏好|兴趣|喜欢|习惯|生活|日常|娱乐|饮食|作息|收藏|音乐|电影|游戏|在意)/.test(text) && !relationshipHeavy.test(text);
        }
        if (slotName === 'relationship') {
            return /(关系|在乎|爱|表白|吃醋|情感|喜欢|试探|亲密|嫉妒|挑衅|和好|承诺|信任|安抚|比较|对比|别的AI|其他AI|Gemini|Claude|更好|不如|移情别恋)/i.test(text)
                || String(mem?.memory_focus || '').trim() === 'relationship';
        }
        return true;
    }

    const slots = Array.isArray(slotPlan) && slotPlan.length > 0
        ? slotPlan
        : [{
            name: 'general',
            queries: Array.isArray(retrievalRequest?.queries) ? retrievalRequest.queries : [],
            filters: retrievalRequest?.filters || {},
            limit: Math.max(1, Math.min(4, Number(retrievalRequest?.limit || 3) || 3))
        }];

    const slotResults = [];
    for (const slot of slots) {
        const startedAt = Date.now();
        if (typeof onProgress === 'function') {
            await onProgress({
                phase: 'slot_start',
                slot: slot.name,
                queries: Array.isArray(slot.queries) ? slot.queries : [],
                filters: slot.filters || {},
                limit: slot.limit || 2
            });
        }
        const request = {
            queries: Array.isArray(slot.queries) ? slot.queries : [],
            filters: slot.filters || {},
            limit: slot.limit || 2
        };
        const memories = await memory.searchMemories(
            characterId,
            request,
            request.limit || 2,
            async (trace) => {
                if (typeof onProgress === 'function') {
                    await onProgress({
                        phase: `slot_trace_${trace.phase}`,
                        slot: slot.name,
                        ...trace
                    });
                }
            }
        );
        const filteredMemories = Array.isArray(memories)
            ? memories.filter(mem => slotAllowsMemory(slot.name, mem))
            : [];
        console.log(`[RAG][retrieve-slot] ${characterId} slot=${slot.name} durationMs=${Date.now() - startedAt} raw=${Array.isArray(memories) ? memories.length : 0} filtered=${filteredMemories.length}`);
        if (typeof onProgress === 'function') {
            await onProgress({
                phase: 'slot_finish',
                slot: slot.name,
                durationMs: Date.now() - startedAt,
                rawCount: Array.isArray(memories) ? memories.length : 0,
                filteredCount: filteredMemories.length
            });
        }
        slotResults.push({ slot, memories: filteredMemories });
    }

    const aggregate = new Map();
    for (const { slot, memories } of slotResults) {
        for (const mem of memories) {
            if (!mem?.id) continue;
            const baseScore = Number(mem._search_score || 0) || 0;
            const existing = aggregate.get(mem.id);
            if (!existing) {
                aggregate.set(mem.id, {
                    memory: { ...mem, _matched_slots: [slot.name] },
                    score: baseScore + 0.08,
                    slots: new Set([slot.name])
                });
                continue;
            }
            existing.slots.add(slot.name);
            existing.score = Math.max(existing.score, baseScore) + 0.08;
            existing.memory._matched_slots = Array.from(existing.slots);
            if (baseScore > Number(existing.memory._search_score || 0)) {
                existing.memory = {
                    ...mem,
                    _matched_slots: Array.from(existing.slots)
                };
            }
        }
    }

    const finalLimit = Math.max(
        Number(retrievalRequest?.limit || 3) || 3,
        Math.min(10, slots.length * 2)
    );

    const finalMemories = Array.from(aggregate.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, finalLimit)
        .map(entry => {
            entry.memory._search_score = entry.score.toFixed(3);
            entry.memory._matched_slots = Array.from(entry.slots);
            return entry.memory;
        });
    console.log(`[RAG][retrieve-complete] ${characterId} slots=${slots.length} final=${finalMemories.length}`);
    if (typeof onProgress === 'function') {
        await onProgress({
            phase: 'complete',
            slotCount: slots.length,
            finalCount: finalMemories.length
        });
    }
    return finalMemories;
}

function formatMessageForLLM(db, content) {
    if (!content) return '';
    try {
        if (content.startsWith('[CITY_ADMIN_GRANT]')) {
            const parts = content.replace('[CITY_ADMIN_GRANT]', '').trim().split('|');
            const grantKind = String(parts[0] || '').trim();
            if (grantKind === 'gold') {
                const amount = Number(parts[1] || 0) || 0;
                return `[系统提示: 商业街管理员刚给了你 ${amount} 金币。]`;
            }
            if (grantKind === 'calories') {
                const amount = Number(parts[1] || 0) || 0;
                return `[系统提示: 商业街管理员刚给你补了 ${amount} 点体力/热量。]`;
            }
            if (grantKind === 'item') {
                const itemEmoji = String(parts[1] || '').trim();
                const itemName = String(parts[2] || '物品').trim();
                const quantity = Number(parts[3] || 1) || 1;
                return `[系统提示: 商业街管理员刚给了你 ${itemEmoji}${itemName} x${quantity}。]`;
            }
            return '[系统提示: 商业街管理员刚给了你一些补给。]';
        }
        if (content.startsWith('[CONTACT_CARD:')) {
            const parts = content.split(':');
            if (parts.length >= 3) {
                const userName = db.getUserProfile()?.name || 'User';
                return `[System Notice: ${userName} shared a Contact Card with you for a new friend named "${parts[2]}". You are now friends with them.]`;
            }
        }
        if (content.startsWith('[TRANSFER]')) {
            const parts = content.replace('[TRANSFER]', '').trim().split('|');
            const tId = parseInt(parts[0]);
            const amount = parts[1] || '0';
            const note = parts.slice(2).join('|') || '';
            const t = db.getTransfer(tId);
            if (t) {
                const status = t.claimed ? '已被对方领取' : (t.refunded ? '已退还' : '待领取');
                return `[转账: ¥${amount}, 备注: "${note}" ${status}]`;
            }
            return `[转账: ¥${amount}, 备注: "${note}"]`;
        }
        const rpMatch = content.match(/^\[REDPACKET:(\d+)\]$/);
        if (rpMatch) {
            const pId = parseInt(rpMatch[1]);
            const rp = db.getRedPacket(pId);
            if (rp) {
                let statusStr = '';
                if (rp.remaining_count === 0) {
                    statusStr = '（已抢光）';
                } else {
                    statusStr = `（剩余 ${rp.remaining_count}/${rp.count} 份）`;
                }
                let claimNote = '';
                if (rp.claims && rp.claims.length > 0) {
                    const claimers = rp.claims.map(c => {
                        const cName = c.claimer_id === 'user'
                            ? (db.getUserProfile()?.name || '用户')
                            : (db.getCharacter(c.claimer_id)?.name || c.claimer_id);
                        return `${cName}(楼${c.amount})`;
                    }).join(', ');
                    claimNote = ` 领取记录: ${claimers}`;
                }
                const senderName = rp.sender_id === 'user' ? '用户' : (db.getCharacter(rp.sender_id)?.name || rp.sender_id);
                return `[${senderName}发了一个群红包: ¥${rp.total_amount}${rp.type === 'lucky' ? '(拼手气)' : '(普通)'}，备注: "${rp.note}" ${statusStr}${claimNote}]`;
            }
            return `[群红包]`;
        }
    } catch (e) { }
    return content;
}

function getCachedHistoryWindow(db, characterId, windowType, windowSize, messages, compileFn) {
    const normalizedMessages = Array.isArray(messages) ? messages.map(m => ({
        id: m?.id ?? null,
        role: m?.role || '',
        content: m?.content || ''
    })) : [];
    const sourceHash = crypto.createHash('sha256').update(JSON.stringify(normalizedMessages)).digest('hex');
    const cached = typeof db.getHistoryWindowCache === 'function'
        ? db.getHistoryWindowCache(characterId, windowType, windowSize, sourceHash)
        : null;
    if (Array.isArray(cached?.compiled_json)) {
        return cached.compiled_json;
    }
    const compiledValue = compileFn?.();
    const compiledJson = Array.isArray(compiledValue) ? compiledValue : [];
    db.upsertHistoryWindowCache?.({
        character_id: characterId,
        window_type: windowType,
        window_size: windowSize,
        source_hash: sourceHash,
        message_ids_json: normalizedMessages.map(m => m.id).filter(id => id != null),
        compiled_json: compiledJson
    });
    return compiledJson;
}

function compileHistoryMessages(db, messages) {
    return (Array.isArray(messages) ? messages : []).map(m => ({
        role: m.role === 'character' ? 'assistant' : 'user',
        content: formatMessageForLLM(db, m.content)
    }));
}

function arraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function stripInlineTags(text) {
    return String(text || '')
        .replace(/\[[A-Z_]+:[^\]]*?\]/g, '')
        .replace(/\[[A-Z_]+\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function compactPreview(text, maxLength = 72) {
    const cleaned = stripInlineTags(text)
        .replace(/[“”"]/g, '')
        .replace(/^[\s.…·—\-~～]+/, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return '';
    if (cleaned.length <= maxLength) return cleaned;
    return `${cleaned.slice(0, Math.max(12, maxLength - 1)).trim()}…`;
}

function extractSpeechOpener(text) {
    const cleaned = stripInlineTags(text)
        .replace(/^[\s"'“”‘’]+/, '')
        .trim();
    if (!cleaned) return '';
    const punctuationLead = cleaned.match(/^(?:[.…·—\-~～]+|\.{2,}|。{2,})/);
    if (punctuationLead) return punctuationLead[0].slice(0, 4);
    const match = cleaned.match(/^(.{1,8}?)(?:[，。！？…\s]|$)/);
    return (match?.[1] || cleaned.slice(0, 6)).trim();
}

function hasOverusedEllipsisStyle(messages) {
    const recentAssistantMsgs = (Array.isArray(messages) ? messages : [])
        .filter(m => m.role === 'character')
        .slice(-4);
    if (recentAssistantMsgs.length < 3) return false;
    const ellipsisCount = recentAssistantMsgs.filter(msg => {
        const opener = extractSpeechOpener(msg.content || '');
        return /^(?:[.…·]+|\.{2,})$/.test(opener);
    }).length;
    return ellipsisCount >= 3;
}

function buildCompactAntiRepeat(character, messages, options = {}) {
    const protectedTailCount = Math.max(0, Number(options.protectedTailCount || 0));
    const sourceMessages = (Array.isArray(messages) ? messages : []);
    const antiRepeatSource = protectedTailCount > 0 && sourceMessages.length > protectedTailCount
        ? sourceMessages.slice(0, sourceMessages.length - protectedTailCount)
        : sourceMessages;
    const recentAssistantMsgs = antiRepeatSource
        .filter(m => m.role === 'character')
        .slice(-6);
    if (recentAssistantMsgs.length === 0) return '';

    const recentTopics = [];
    const recentOpeners = [];
    for (const msg of recentAssistantMsgs) {
        const preview = compactPreview(msg.content, 24);
        if (!preview) continue;
        if (!recentTopics.includes(preview)) recentTopics.push(preview);
        const opener = extractSpeechOpener(msg.content);
        if (opener && !recentOpeners.includes(opener)) recentOpeners.push(opener);
        if (recentTopics.length >= 3) break;
    }
    if (recentTopics.length === 0) return '';

    let antiRepeat = `\n\n[Anti-Repeat]\nThis is a low-priority reminder from older replies, not the source of truth for the latest turn.\nIf this conflicts with the newest raw tail messages, trust the raw tail messages.\nRecent older topics: ${recentTopics.join(' | ')}\nAvoid same accusation, same comfort ask, same emotional wording, and the same dramatic opener. Next reply must move forward with a different angle.`;
    if (recentOpeners.length > 0) {
        antiRepeat += `\nAvoid repeating the same sentence opener/interjection: ${recentOpeners.slice(0, 3).join(' | ')}.`;
    }
    antiRepeat += `\nDo not start this reply with ellipsis-style openers like "……", "...", or long sigh-like punctuation unless the latest user wording absolutely requires it.`;
    if ((character.pressure_level || 0) >= 2) {
        antiRepeat += `\nIf anxious, prefer one fresh move: immediate scene, one specific reassurance, react to latest wording, or reveal one new detail.`;
    }
    return antiRepeat;
}

function findWindowForwardOverlap(previousIds, currentIds) {
    const prev = Array.isArray(previousIds) ? previousIds : [];
    const curr = Array.isArray(currentIds) ? currentIds : [];
    const maxOverlap = Math.min(prev.length, curr.length);
    for (let overlap = maxOverlap; overlap > 0; overlap--) {
        if (arraysEqual(prev.slice(prev.length - overlap), curr.slice(0, overlap))) {
            return overlap;
        }
    }
    return 0;
}

function buildSlidingHistoryWindow(db, characterId, windowSize, messages) {
    const normalizedMessages = Array.isArray(messages) ? messages.map(m => ({
        id: m?.id ?? null,
        role: m?.role || '',
        content: m?.content || ''
    })) : [];
    const currentIds = normalizedMessages.map(m => m.id).filter(id => id != null);
    const currentSourceHash = crypto.createHash('sha256').update(JSON.stringify(normalizedMessages)).digest('hex');
    const exactCached = typeof db.getHistoryWindowCache === 'function'
        ? db.getHistoryWindowCache(characterId, 'private_llm_history_window', windowSize, currentSourceHash)
        : null;
    if (Array.isArray(exactCached?.compiled_json)) {
        return exactCached.compiled_json;
    }

    const previousWindow = typeof db.getLatestHistoryWindowCache === 'function'
        ? db.getLatestHistoryWindowCache(characterId, 'private_llm_history_window', windowSize)
        : null;
    const previousIds = Array.isArray(previousWindow?.message_ids_json) ? previousWindow.message_ids_json : [];
    const previousCompiled = Array.isArray(previousWindow?.compiled_json) ? previousWindow.compiled_json : [];
    let compiledJson = null;

    if (previousCompiled.length === previousIds.length && previousIds.length > 0) {
        const overlap = findWindowForwardOverlap(previousIds, currentIds);
        if (overlap > 0) {
            compiledJson = [
                ...previousCompiled.slice(previousCompiled.length - overlap),
                ...compileHistoryMessages(db, normalizedMessages.slice(overlap))
            ];
        }
    }

    if (!Array.isArray(compiledJson)) {
        compiledJson = compileHistoryMessages(db, normalizedMessages);
    }

    db.upsertHistoryWindowCache?.({
        character_id: characterId,
        window_type: 'private_llm_history_window',
        window_size: windowSize,
        source_hash: currentSourceHash,
        message_ids_json: currentIds,
        compiled_json: compiledJson,
        hit_count: 0,
        last_hit_at: 0
    });

    return compiledJson;
}

async function preparePrivateConversationState({ db, memory, character, refreshDigest = false }) {
    const contextLimit = character.context_msg_limit || 60;
    const rawContextHistory = db.getVisibleMessages(character.id, contextLimit);
    const contextHistory = Array.isArray(rawContextHistory)
        ? rawContextHistory.filter(msg => !isSyntheticSystemErrorMessage(msg))
        : [];

    if (refreshDigest && typeof memory?.updateConversationDigest === 'function') {
        try {
            await memory.updateConversationDigest(character);
        } catch (e) {
            console.warn(`[Engine] Conversation digest refresh failed for ${character.name}: ${e.message}`);
        }
    }

    const conversationDigest = typeof db.getConversationDigest === 'function'
        ? db.getConversationDigest(character.id)
        : null;
    const hasConversationDigest = !!(conversationDigest && conversationDigest.digest_text);
    const liveHistoryWindowSize = hasConversationDigest
        ? getDigestTailWindowSize(contextLimit, contextHistory.length)
        : contextLimit;
    const liveHistory = hasConversationDigest
        ? contextHistory.slice(-liveHistoryWindowSize)
        : contextHistory;
    const transformedHistory = buildSlidingHistoryWindow(db, character.id, liveHistoryWindowSize, liveHistory);
    const latestUserMessage = [...liveHistory].reverse().find(m => m.role === 'user');
    const recentInputString = String(latestUserMessage?.content || '').trim();

    return {
        contextLimit,
        contextHistory,
        conversationDigest,
        hasConversationDigest,
        liveHistoryWindowSize,
        liveHistory,
        transformedHistory,
        latestUserMessage,
        recentInputString
    };
}

function getEngine(userId) {
    if (engineCache.has(userId)) return engineCache.get(userId);

    // Lazy loaded memory to avoid circular deps
    const { getMemory } = require('./memory');

    const db = getUserDb(userId);
    const memory = getMemory(userId);

    // --- ENCLOSED ENGINE FUNCTIONS ---
    const timers = new Map();
    const ragFailureCache = new Map();
    const dedupBlockCounts = new Map(); // Track consecutive dedup blocks per character
    let stateBroadcastInterval = null;

    function recordTokenUsage(characterId, contextType, usage) {
        if (!usage || usage.cached) return;
        db.addTokenUsage(characterId, contextType, usage.prompt_tokens || 0, usage.completion_tokens || 0);
    }

    function recordLlmDebug(character, direction, payload, meta = {}) {
        if (!character || character.llm_debug_capture !== 1 || typeof db.addLlmDebugLog !== 'function') return;
        try {
            const normalizedPayload = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
            db.addLlmDebugLog({
                character_id: character.id,
                direction,
                context_type: meta.context_type || 'chat',
                payload: normalizedPayload,
                meta
            });
        } catch (e) {
            console.warn(`[Engine] Failed to record LLM debug for ${character?.name || character?.id}: ${e.message}`);
        }
    }

    function buildLlmAttemptRecorder(character, baseMeta = {}) {
        return (attemptMeta = {}) => {
            recordLlmDebug(character, attemptMeta.phase === 'start' ? 'attempt' : 'attempt_result', '', {
                ...baseMeta,
                llm_attempt: true,
                ...attemptMeta
            });
        };
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function parseTaggedDelta(text, tagName, min, max) {
        const regex = new RegExp(`\\[${tagName}:\\s*([+-]?\\d+)\\s*\\]`, 'i');
        const match = String(text || '').match(regex);
        if (!match || !match[1]) return null;
        const parsed = parseInt(match[1], 10);
        if (!Number.isFinite(parsed)) return null;
        return clamp(parsed, min, max);
    }

    function logEmotionTransition(beforeState, patch, source, reason) {
        if (!patch || Object.keys(patch).length === 0 || typeof db.addEmotionLog !== 'function') return;
        const afterState = { ...beforeState, ...patch };
        const entry = buildEmotionLogEntry(beforeState, afterState, source, reason);
        if (entry) db.addEmotionLog(entry);
    }

    function broadcastEngineState(wsClients) {
        if (!wsClients || wsClients.size === 0) return;

        const allChars = db.getCharacters();
        const charMap = {};
        for (const c of allChars) charMap[c.id] = c;

        const stateData = {};
        for (const [charId, timerData] of timers.entries()) {
            const charCheck = charMap[charId];
            if (!charCheck) continue;
            stateData[charId] = {
                countdownMs: Math.max(0, timerData.targetTime - Date.now()),
                isThinking: timerData.isThinking || false,
                ragProgress: timerData.ragProgress || null,
                pressure: charCheck.pressure_level || 0,
                status: charCheck.status,
                isBlocked: charCheck.is_blocked
            };
        }
        const payload = JSON.stringify({ type: 'engine_state', data: stateData });
        wsClients.forEach(client => {
            if (client.readyState === 1) client.send(payload);
        });
    }

    const RAG_PROGRESS_TOTAL_STEPS = 7;
    const RAG_PROGRESS_STEP_KEYS = ['summary', 'route', 'topics', 'decision', 'rewrite', 'retrieve', 'answer'];

    function createRagProgress(stepKey = 'summary') {
        const safeKey = RAG_PROGRESS_STEP_KEYS.includes(stepKey) ? stepKey : 'summary';
        return {
            runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            totalSteps: RAG_PROGRESS_TOTAL_STEPS,
            currentKey: safeKey,
            currentStep: Math.max(1, RAG_PROGRESS_STEP_KEYS.indexOf(safeKey) + 1),
            status: 'running',
            skipped: false,
            updatedAt: Date.now()
        };
    }

    function updateRagProgress(characterId, wsClients, updates = {}) {
        if (!timers.has(characterId)) return;
        const timerData = timers.get(characterId) || {};
        const baseProgress = (timerData.ragProgress && typeof timerData.ragProgress === 'object')
            ? timerData.ragProgress
            : createRagProgress();
        const nextKey = updates.currentKey && RAG_PROGRESS_STEP_KEYS.includes(updates.currentKey)
            ? updates.currentKey
            : baseProgress.currentKey;
        const nextProgress = {
            ...baseProgress,
            ...updates,
            totalSteps: RAG_PROGRESS_TOTAL_STEPS,
            currentKey: nextKey,
            currentStep: Number(updates.currentStep || (RAG_PROGRESS_STEP_KEYS.indexOf(nextKey) + 1) || baseProgress.currentStep || 1),
            updatedAt: Date.now()
        };
        timers.set(characterId, { ...timerData, ragProgress: nextProgress });
        broadcastEngineState(wsClients);
    }

    function setRagFailureState(characterId, state = null) {
        if (!characterId) return;
        if (!state) {
            ragFailureCache.delete(characterId);
            return;
        }
        ragFailureCache.set(characterId, {
            ...state,
            updatedAt: Date.now()
        });
    }

    function getRagFailureState(characterId) {
        return ragFailureCache.get(characterId) || null;
    }

    // Generate a random delay between min and max minutes
    function getRandomDelayMs(min, max) {
        const minMs = min * 60 * 1000;
        const maxMs = max * 60 * 1000;
        return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    }

    // Generates the system prompt merging character persona, world info, and memories
    async function buildPrompt(character, contextMessages, isTimerWakeup = false, options = {}) {
        const defaultGuidelines = getDefaultGuidelines();
        const conversationDigest = options.conversationDigest || null;
        const antiRepeatSource = Array.isArray(options.antiRepeatMessages) && options.antiRepeatMessages.length > 0
            ? options.antiRepeatMessages
            : contextMessages;

        const recentInputString = contextMessages.slice(-2).map(m => m.content).join(' ');
        const userProfile = db.getUserProfile?.() || null;
        const responseStyleConstitution = String(userProfile?.response_style_constitution || '').trim() || getDefaultResponseStyleConstitution();

        // --- Use Universal Context Builder ---
        // Pass engine context down (requires memory and userDb access inside builder)
        // Since we are inside `getEngine` closure, we have access to context indirectly,
        // but `buildUniversalContext` expects { getUserDb, getMemory, userId }
        const engineContextWrapper = { getUserDb, getMemory: require('./memory').getMemory, userId };
        const allChars = db.getCharacters().filter(c => c.id !== character.id);
        const mentionedTargets = allChars.filter(c => recentInputString.includes(c.name));
        if (character.jealousy_target) {
            const jealousyTarget = db.getCharacter(character.jealousy_target);
            if (jealousyTarget && jealousyTarget.id !== character.id && !mentionedTargets.some(t => t.id === jealousyTarget.id)) {
                mentionedTargets.push(jealousyTarget);
            }
        }
        const universalResult = await buildUniversalContext(engineContextWrapper, character, recentInputString, false, mentionedTargets);

        const stableCharacterBlock = getCachedPromptBlock(
            db,
            character.id,
            'stable_character_prompt',
            {
                name: character.name || '',
                persona: character.persona || '',
                world_info: character.world_info || '',
                user_name: userProfile?.name || '',
                user_bio: userProfile?.bio || '',
                defaultGuidelines,
                dialogueStyleExamples: getDialogueStyleExamples(),
                system_prompt: character.system_prompt || '',
                response_style_constitution: responseStyleConstitution
            },
            () => {
                const userName = String(userProfile?.name || '用户').trim() || '用户';
                const userBio = String(userProfile?.bio || '').trim();
                let block = `You are playing the role of ${character.name}.
Persona:
${character.persona || 'No specific persona given.'}

World Info:
${character.world_info || 'No specific world info.'}`;
                block += `\n\n[Highest Priority User Identity Anchor]\n- In this private chat, the user speaking to you is ${userName}本人.\n- Treat the current \`user\` as the real person you are talking to right now, not as a narrator, admin NPC, tool, or unrelated third party.\n- If the context says ${userName} gave you money, food, gifts, care, or attention, interpret it first as ${userName}本人对你做的事.\n- Do not rewrite that into “someone else gave it” or drift the emotional reaction onto a third party unless the message explicitly names a different sender.\n- When a system/event line and the newest user-facing action point to ${userName}, your relationship with ${userName} has priority over generic event wording.`;
                if (userBio) {
                    block += `\n- Stable profile cues about ${userName}: ${userBio}`;
                }
                if (responseStyleConstitution) {
                    block += `\n\n[Highest Priority Long-Term Style Constitution]\n${responseStyleConstitution}`;
                }
                block += `\n\n${defaultGuidelines}`;
                block += `\n\n${getDialogueStyleExamples()}`;
                const supplementalCharacterPrompt = String(character.system_prompt || '').trim();
                if (supplementalCharacterPrompt) {
                    block += `\n\n[Character-Specific Supplemental Rules]\n${supplementalCharacterPrompt}`;
                }
                block += '\n\n[Context Priority Rules]\n- Highest priority inside private chat: correctly identify who the user is and read their actions as actions from that user.\n- Newest explicit user wording > newest raw tail messages > compressed helper blocks.\n- If older/compressed context conflicts with the newest wording, trust the newest wording.\n- If the user uses meta wording, translate it back into the in-world relationship and situation.\n- If the user is correcting your interpretation, repair first instead of defending the older read.';
                return block;
            }
        );

        let prompt = `${stableCharacterBlock}

Context:
${universalResult.preamble}`;
        let digestBlock = '';
        let styleCorrectionBlock = '';
        let transferNoticeBlock = '';

        if (conversationDigest?.digest_text) {
            digestBlock = typeof memory.formatConversationDigestForPrompt === 'function'
                ? memory.formatConversationDigestForPrompt(conversationDigest, { recentMessages: contextMessages })
                : '';
            if (digestBlock) {
                prompt += `\n\n${digestBlock}`;
            }
        }

        if (hasOverusedEllipsisStyle(contextMessages)) {
            styleCorrectionBlock = '[Style Correction]\nYour recent raw replies have overused ellipsis-style openings. In this reply, do not begin with "……", "...", or a sigh-like punctuation opener. Start with a concrete word or direct reaction instead.';
            prompt += `\n\n${styleCorrectionBlock}`;
        }

        // Unclaimed transfers: char sent to user but user hasn't claimed yet
        try {
            const unclaimed = db.getUnclaimedTransfersFrom(character.id, character.id);
            if (unclaimed && unclaimed.length > 0) {
                const recent = unclaimed.filter(t => (Date.now() - t.created_at) < (24 * 60 * 60 * 1000));
                if (recent.length > 0) {
                    const total = recent.reduce((s, t) => s + t.amount, 0).toFixed(2);
                    const minutesAgo = Math.round((Date.now() - recent[0].created_at) / 60000);
                    const unclaimedNote = recent[0].note ? `（留言：“${recent[0].note}”）` : '';
                    transferNoticeBlock = `[系统提示] 你在 ${minutesAgo} 分钟前给 ${db.getUserProfile()?.name || '用户'} 转了一笔账，共 ¥${total}${unclaimedNote}，但对方还没有领取。你可以按自己的性格顺手提一句，也可以不提。`;
                    prompt += `\n${transferNoticeBlock}\n`;
                }
            }
        } catch (e) { /* ignore */ }
        if (isTimerWakeup) {
            prompt += `\n[CRITICAL WAKEUP NOTICE]: Your previously self-scheduled timer has just expired! You MUST now proactively send the message you promised to send when you set the [TIMER]. Speak to the user now!\n`;
        }

        // Anti-repeat
        const antiRepeat = buildCompactAntiRepeat(character, antiRepeatSource, {
            protectedTailCount: Array.isArray(contextMessages) ? contextMessages.length : 0
        });
        if (antiRepeat) {
            prompt += antiRepeat;
        }

        const promptWithoutDigest = [
            stableCharacterBlock,
            '',
            'Context:',
            universalResult.preamble,
            styleCorrectionBlock ? `\n${styleCorrectionBlock}` : '',
            transferNoticeBlock ? `\n${transferNoticeBlock}\n` : '',
            antiRepeat || ''
        ].join('\n');

        return {
            prompt,
            promptWithoutDigest,
            retrievedMemoriesContext: universalResult.retrievedMemoriesContext,
            promptStats: {
                universalBreakdown: { ...(universalResult.breakdown || {}) },
                moduleRoutes: { ...(universalResult.moduleRoutes || {}) },
                digestBlock,
                antiRepeat,
                styleCorrectionBlock,
                transferNoticeBlock
            }
        };
    }

    async function runStructuredRagPipeline({
        character,
        transformedHistory,
        recentInputString,
        conversationDigest,
        wsClients,
        apiMessages,
        msgMetadata,
        resumeState = null
    }) {
        const ragPlannerConfig = resolveRagPlannerConfig(character);
        if (!recentInputString || !memory?.searchMemories || !ragPlannerConfig.endpoint || !ragPlannerConfig.key || !ragPlannerConfig.model) {
            return msgMetadata;
        }

        const normalizedResumeState = resumeState && resumeState.latestUserMessage === recentInputString
            ? resumeState
            : null;
        const resumeFrom = String(normalizedResumeState?.failedAt || '').trim();

        const topicPrompt = [
            'RAG TOPIC PLANNER',
            'Identify what older long-term themes the user may be touching, even if the wording is indirect.',
            'Do not decide whether to skip retrieval yet. Your only job is to expand the user message into likely long-term memory topics.',
            '',
            '[Bias]',
            '- Prefer user-centered themes first: user_profile, user_current_arc, relationship.',
            '- Especially notice: what you know about the user, how you see the user, user background, preferences, vulnerabilities, current life arc, repeated affection, confession, jealousy, promises, hurt, reconciliation, and long-running work/study/career threads.',
            '- If the wording is broad or indirect, still infer likely themes instead of staying literal.',
            '',
            '[Output]',
            '- Output ONLY a JSON array of 0 to 5 short topic strings.',
            '- Example: ["用户信息","用户近况","关系"]',
            '- If nothing in the message points to older long-term memory, output []'
        ].join('\n');
        let plannerTopics = Array.isArray(normalizedResumeState?.plannerTopics)
            ? normalizedResumeState.plannerTopics.map(v => String(v || '').trim()).filter(Boolean)
            : [];
        if (!plannerTopics.length || !['decision', 'rewrite', 'retrieve'].includes(resumeFrom)) {
            const topicPlannerMessages = buildRagPlannerMessages({
                recentHistory: transformedHistory,
                latestUserMessage: recentInputString,
                conversationDigest,
                plannerInstruction: topicPrompt
            });
            recordLlmDebug(character, 'input', topicPlannerMessages, {
                context_type: 'chat_intent_topics',
                planner_source: ragPlannerConfig.source,
                latest_user_message: recentInputString
            });

            const { content: topicResult, usage: topicUsage } = await callLLM({
                endpoint: ragPlannerConfig.endpoint,
                key: ragPlannerConfig.key,
                model: ragPlannerConfig.model,
                messages: topicPlannerMessages,
                maxTokens: 6000,
                temperature: 0,
                enableCache: true,
                cacheDb: db,
                cacheType: 'chat_intent_topics',
                cacheTtlMs: 6 * 60 * 60 * 1000,
                cacheScope: `character:${character.id}`,
                cacheCharacterId: character.id,
                returnUsage: true,
                debugAttempt: buildLlmAttemptRecorder(character, {
                    context_type: 'chat_intent_topics',
                    planner_source: ragPlannerConfig.source
                })
            });
            recordLlmDebug(character, 'output', topicResult, {
                context_type: 'chat_intent_topics',
                planner_source: ragPlannerConfig.source,
                usage: topicUsage || null
            });
            if (topicUsage) {
                recordTokenUsage(character.id, 'chat_intent_topics', topicUsage);
                broadcastEvent(wsClients, { type: 'token_stats', character_id: character.id, module: 'chat', usage: topicUsage });
            }

            const { topics, malformed: malformedTopicResult, empty: emptyTopicResult } = parseRagTopics(topicResult);
            if (emptyTopicResult) {
                const error = new Error('RAG planner returned no result. Please retry.');
                error.ragResume = { failedAt: 'topics', latestUserMessage: recentInputString };
                throw error;
            }
            if (malformedTopicResult) {
                const error = new Error('RAG planner output was malformed. Please retry.');
                error.ragResume = { failedAt: 'topics', latestUserMessage: recentInputString };
                throw error;
            }
            plannerTopics = topics;
        } else {
            recordLlmDebug(character, 'event', 'Resuming RAG from cached planner topics.', {
                context_type: 'chat_intent_topics_resume',
                planner_source: ragPlannerConfig.source,
                latest_user_message: recentInputString,
                planner_topics: plannerTopics
            });
        }
        updateRagProgress(character.id, wsClients, { currentKey: 'decision' });

        const intentPrompt = [
            'SYSTEM RAG DECISION',
            'You already inferred these likely long-term topics from the user message:',
            plannerTopics.length > 0 ? `- ${plannerTopics.join('\n- ')}` : '- (none)',
            '',
            'Now decide whether retrieval is needed before replying.',
            '',
            '[Core Principle]',
            '- Retrieve whenever older memory would make the reply more accurate, more continuous, more personal, or less likely to forget established facts.',
            '- Do NOT use the standard "I can answer superficially from recent chat" test. If memory would materially improve continuity, prefer retrieval.',
            '',
            '[Retrieval Is Extra Important]',
            '- If the topics point to user_profile, user_current_arc, or relationship, strongly prefer retrieval.',
            '- If the user is asking what you know about them, how you see them, whether you remember them, or asking for a summary of them, strongly prefer retrieval.',
            '- If the user is touching earlier relationship nodes, repeated affection, or long-running life threads, strongly prefer retrieval.',
            '',
            '[When ENOUGH_CONTEXT Is Allowed]',
            '- Only output ENOUGH_CONTEXT when the recent chat alone is enough and older memory would add almost nothing to factual accuracy, emotional continuity, or personalization.',
            '- If you are on the fence, prefer SEARCH_MEMORY.',
            '',
            '[Output Format]',
            '- If retrieval is needed, output ONLY: SEARCH_MEMORY: [keyword]',
            '- The keyword should usually be one of the inferred topics above, or a short merge of the most important one.',
            '- If retrieval is not needed, output ONLY: ENOUGH_CONTEXT'
        ].join('\n');
        let parsedDecision = normalizedResumeState?.parsedDecision || null;
        if (!parsedDecision || !['rewrite', 'retrieve'].includes(resumeFrom)) {
            const decisionPlannerMessages = buildRagPlannerMessages({
                recentHistory: transformedHistory,
                latestUserMessage: recentInputString,
                conversationDigest,
                plannerInstruction: intentPrompt
            });
            recordLlmDebug(character, 'input', decisionPlannerMessages, {
                context_type: 'chat_intent_decision',
                planner_source: ragPlannerConfig.source,
                latest_user_message: recentInputString,
                planner_topics: plannerTopics
            });

            const { content: intentResult, usage: intentUsage } = await callLLM({
                endpoint: ragPlannerConfig.endpoint,
                key: ragPlannerConfig.key,
                model: ragPlannerConfig.model,
                messages: decisionPlannerMessages,
                maxTokens: 2048,
                temperature: 0,
                enableCache: true,
                cacheDb: db,
                cacheType: 'chat_intent_decision',
                cacheTtlMs: 6 * 60 * 60 * 1000,
                cacheScope: `character:${character.id}`,
                cacheCharacterId: character.id,
                returnUsage: true,
                debugAttempt: buildLlmAttemptRecorder(character, {
                    context_type: 'chat_intent_decision',
                    planner_source: ragPlannerConfig.source
                })
            });
            recordLlmDebug(character, 'output', intentResult, {
                context_type: 'chat_intent_decision',
                planner_source: ragPlannerConfig.source,
                planner_topics: plannerTopics,
                usage: intentUsage || null
            });
            if (intentUsage) {
                recordTokenUsage(character.id, 'chat_intent_decision', intentUsage);
                broadcastEvent(wsClients, { type: 'token_stats', character_id: character.id, module: 'chat', usage: intentUsage });
            }

            parsedDecision = parseRagDecision(intentResult);
            if (parsedDecision.malformed) {
                const error = new Error('RAG planner output was malformed. Please retry.');
                error.ragResume = {
                    failedAt: 'decision',
                    latestUserMessage: recentInputString,
                    plannerTopics
                };
                throw error;
            }
        } else {
            recordLlmDebug(character, 'event', 'Resuming RAG from cached decision result.', {
                context_type: 'chat_intent_decision_resume',
                planner_source: ragPlannerConfig.source,
                latest_user_message: recentInputString,
                planner_topics: plannerTopics
            });
        }
        if (!parsedDecision.shouldSearch) {
            console.log(`[Engine] Intent: ENOUGH_CONTEXT. Skipping RAG search.`);
            updateRagProgress(character.id, wsClients, {
                currentKey: 'answer',
                skipped: true,
                status: 'running'
            });
            return msgMetadata;
        }

        const retrievalLabel = parsedDecision.retrievalLabel;
        console.log(`[Engine] Dynamic RAG Triggered for ${character.name}. Query: "${retrievalLabel}"`);
        updateRagProgress(character.id, wsClients, { currentKey: 'rewrite' });
        const rewriteConstraints = normalizedResumeState?.rewriteConstraints || deriveRagRewriteConstraints({
            plannerTopics,
            retrievalLabel,
            latestUserMessage: recentInputString
        });

        const rewritePrompt = [
            'VECTOR QUERY REWRITE',
            `The retrieval topic is: ${retrievalLabel}`,
            plannerTopics.length > 0 ? `Related inferred topics:\n- ${plannerTopics.join('\n- ')}` : '',
            '',
            'Rewrite the retrieval need into a compact JSON request for vector-memory search.',
            '',
            '[Output Rules]',
            '- Output ONLY valid JSON.',
            '- "queries": 1 to 6 short Chinese search phrases for semantic recall.',
            '- "filters.memory_focus" may include only: user_profile, user_current_arc, relationship, general.',
            '- "filters.memory_tier" may include only: core, active, ambient.',
            '- "limit" should be 2 to 6.',
            '- Prefer narrow, user-centered retrieval rather than broad generic search.',
            '',
            '[Hard Constraints]',
            '- Preserve all distinct semantic directions already inferred above. Do NOT collapse multi-topic requests into a single dimension.',
            rewriteConstraints.requiredFocuses.length > 0
                ? `- Required memory_focus values: ${rewriteConstraints.requiredFocuses.join(', ')}`
                : '- Required memory_focus values: none',
            rewriteConstraints.requiredQueries.length > 0
                ? `- Required query coverage topics: ${rewriteConstraints.requiredQueries.join(' | ')}`
                : '- Required query coverage topics: none',
            '- If the user asks a composite question such as study + work + background, your JSON must cover multiple matching dimensions.',
            '',
            '[Output JSON Schema]',
            '{',
            '  "queries": ["..."],',
            '  "filters": {',
            '    "memory_focus": ["user_profile"],',
            '    "memory_tier": ["core", "active"]',
            '  },',
            '  "limit": 3',
            '}'
        ].filter(Boolean).join('\n');
        const rewriteMessages = buildRagPlannerMessages({
            recentHistory: transformedHistory,
            latestUserMessage: recentInputString,
            conversationDigest,
            plannerInstruction: rewritePrompt
        });
        recordLlmDebug(character, 'input', rewriteMessages, {
            context_type: 'chat_intent_rewrite',
            planner_source: ragPlannerConfig.source,
            latest_user_message: recentInputString,
            retrieval_label: retrievalLabel,
            planner_topics: plannerTopics
        });
        const isValidRewritePayload = (text) => {
            const { malformed } = parseStructuredRagQuery(text, retrievalLabel, plannerTopics);
            return !malformed;
        };
        const runRewriteAttempt = async ({ enableCache, cacheKeyExtra = '', contextType = 'chat_intent_rewrite' } = {}) => {
            const { content, usage } = await callLLM({
                endpoint: ragPlannerConfig.endpoint,
                key: ragPlannerConfig.key,
                model: ragPlannerConfig.model,
                messages: rewriteMessages,
                maxTokens: 6000,
                temperature: 0,
                enableCache,
                cacheDb: db,
                cacheType: 'chat_intent_rewrite',
                cacheTtlMs: 6 * 60 * 60 * 1000,
                cacheScope: `character:${character.id}`,
                cacheCharacterId: character.id,
                cacheKeyExtra,
                returnUsage: true,
                validateCachedContent: (cachedText) => isValidRewritePayload(cachedText),
                shouldCacheResult: (resultText) => isValidRewritePayload(resultText),
                debugAttempt: buildLlmAttemptRecorder(character, {
                    context_type: contextType,
                    planner_source: ragPlannerConfig.source
                })
            });
            recordLlmDebug(character, 'output', content, {
                context_type: contextType,
                planner_source: ragPlannerConfig.source,
                retrieval_label: retrievalLabel,
                planner_topics: plannerTopics,
                usage: usage || null
            });
            if (usage) {
                recordTokenUsage(character.id, 'chat_intent_rewrite', usage);
                broadcastEvent(wsClients, { type: 'token_stats', character_id: character.id, module: 'chat', usage });
            }
            return { content, usage };
        };

        let retrievalRequest = normalizedResumeState?.retrievalRequest || null;
        if (!retrievalRequest || resumeFrom !== 'retrieve') {
            let { content: rewriteResult } = await runRewriteAttempt({
                enableCache: true,
                contextType: 'chat_intent_rewrite'
            });

            let { request: parsedRewriteRequest, malformed: malformedRewrite } = parseStructuredRagQuery(rewriteResult, retrievalLabel, plannerTopics);
            if (malformedRewrite) {
                recordLlmDebug(character, 'event', 'Retrying rewrite without cache after malformed output.', {
                    context_type: 'chat_intent_rewrite_retry',
                    planner_source: ragPlannerConfig.source,
                    retrieval_label: retrievalLabel,
                    planner_topics: plannerTopics
                });
                ({ content: rewriteResult } = await runRewriteAttempt({
                    enableCache: false,
                    cacheKeyExtra: `retry:${Date.now()}`,
                    contextType: 'chat_intent_rewrite_retry'
                }));
                ({ request: parsedRewriteRequest, malformed: malformedRewrite } = parseStructuredRagQuery(rewriteResult, retrievalLabel, plannerTopics));
            }
            if (malformedRewrite) {
                const error = new Error('RAG rewrite output was malformed. Please retry.');
                error.ragResume = {
                    failedAt: 'rewrite',
                    latestUserMessage: recentInputString,
                    plannerTopics,
                    parsedDecision,
                    rewriteConstraints
                };
                throw error;
            }
            retrievalRequest = enforceStructuredRagQueryConstraints(parsedRewriteRequest, rewriteConstraints);
        } else {
            recordLlmDebug(character, 'event', 'Resuming RAG directly from retrieval request.', {
                context_type: 'chat_intent_retrieve_resume',
                planner_source: ragPlannerConfig.source,
                retrieval_label: retrievalLabel,
                planner_topics: plannerTopics
            });
        }
        updateRagProgress(character.id, wsClients, { currentKey: 'retrieve' });
        const retrievalSlots = deriveRagRetrievalSlots({
            retrievalRequest,
            plannerTopics,
            retrievalLabel,
            latestUserMessage: recentInputString
        });
        recordLlmDebug(character, 'event', 'Starting structured memory retrieval.', {
            context_type: 'chat_intent_retrieve',
            planner_source: ragPlannerConfig.source,
            retrieval_label: retrievalLabel,
            planner_topics: plannerTopics,
            retrieval_request: retrievalRequest,
            retrieval_slots: retrievalSlots
        });
        let dynamicMemories;
        try {
            dynamicMemories = await executeMultiSlotMemorySearch(
                memory,
                character.id,
                retrievalRequest,
                retrievalSlots,
                async (progress) => {
                    recordLlmDebug(character, 'event', `Structured memory retrieval ${progress.phase}.`, {
                        context_type: 'chat_intent_retrieve_slot',
                        planner_source: ragPlannerConfig.source,
                        retrieval_label: retrievalLabel,
                        planner_topics: plannerTopics,
                        ...progress
                    });
                }
            );
        } catch (e) {
            e.ragResume = {
                failedAt: 'retrieve',
                latestUserMessage: recentInputString,
                plannerTopics,
                parsedDecision,
                rewriteConstraints,
                retrievalRequest
            };
            throw e;
        }
        recordLlmDebug(character, 'event', 'Structured memory retrieval finished.', {
            context_type: 'chat_intent_retrieve',
            planner_source: ragPlannerConfig.source,
            retrieval_label: retrievalLabel,
            planner_topics: plannerTopics,
            retrieved_count: Array.isArray(dynamicMemories) ? dynamicMemories.length : 0
        });
        if (dynamicMemories && dynamicMemories.length > 0) {
            const querySummary = Array.isArray(retrievalRequest.queries) ? retrievalRequest.queries.join(' | ') : retrievalLabel;
            const formattedMemories = dynamicMemories.map((m, index) => {
                const summary = String(m.summary || m.event || '').trim();
                const content = String(m.content || '').trim();
                const focus = String(m.memory_focus || '').trim();
                const tier = String(m.memory_tier || '').trim();
                const matchedQuery = String(m._matched_query || '').trim();
                const matchedSlots = Array.isArray(m._matched_slots) ? m._matched_slots.filter(Boolean) : [];
                const memoryTime = String(m.time || '').trim();
                const sourceTimeText = String(m.source_time_text || '').trim();
                const lines = [
                    `Memory ${index + 1}: ${summary || m.event || `memory_${index + 1}`}`
                ];
                lines.push('Timeline: This is a recalled past event or older memory, not something automatically happening right now.');
                if (memoryTime) {
                    lines.push(`Event Time: ${memoryTime}`);
                }
                if (sourceTimeText) {
                    lines.push(`Source Dialogue Time: ${sourceTimeText}`);
                }
                if (content && content !== summary) {
                    lines.push(`Details: ${content}`);
                }
                if (focus || tier) {
                    lines.push(`Type: ${focus || 'unknown'} / ${tier || 'unknown'}`);
                }
                if (matchedSlots.length > 0) {
                    lines.push(`Slot Coverage: ${matchedSlots.join(', ')}`);
                }
                if (matchedQuery) {
                    lines.push(`Matched Query: ${matchedQuery}`);
                }
                return lines.join('\n');
            }).join('\n\n');
            const sysInjection = `\n[SYSTEM: You successfully retrieved older memories related to "${querySummary}". ` +
                `Treat the memory summaries and details below as factual recall anchors from the past. They are not automatically the current moment, and they are not permanent character settings unless the memory explicitly says so. ` +
                `If any recalled memory conflicts with the user's newest message or the latest visible conversation, trust the newest conversation first. ` +
                `When answering, prefer these concrete facts over vague emotional generalization.]\n`
                + formattedMemories
                + '\n(Use these recalled facts to answer the user accurately and specifically.)';
            apiMessages[0].content += `\n${sysInjection}\n`;

            if (!msgMetadata) msgMetadata = { retrievedMemories: [] };
            msgMetadata.retrievedMemories.push(...dynamicMemories.map(mem => ({
                id: mem.id,
                event: mem.event,
                summary: mem.summary || '',
                content: mem.content || '',
                memory_focus: mem.memory_focus || '',
                memory_tier: mem.memory_tier || '',
                matched_slots: Array.isArray(mem._matched_slots) ? mem._matched_slots : [],
                importance: mem.importance,
                time: mem.time || '',
                created_at: mem.created_at,
                last_retrieved_at: mem.last_retrieved_at,
                retrieval_count: mem.retrieval_count || 0,
                matched_query: mem._matched_query || '',
                source_time_text: mem.source_time_text || '',
                source_started_at: mem.source_started_at || 0,
                source_ended_at: mem.source_ended_at || 0
            })));
        } else {
            console.log(`[Engine] RAG returned no relevant matches for "${retrievalLabel}".`);
        }

        updateRagProgress(character.id, wsClients, { currentKey: 'answer' });

        return msgMetadata;
    }

    // Function that actually triggers the generation of an AI message
    async function triggerMessage(character, wsClients, isUserReply = false, isTimerWakeup = false, extraSystemDirective = null, generationOptions = {}) {
        console.log(`\n[DEBUG] === Trigger Message Entry: ${character.name} (isUserReply: ${isUserReply}) ===`);

        // Check if character is still active or blocked
        const charCheck = db.getCharacter(character.id);
        if (!charCheck || charCheck.status !== 'active' || charCheck.is_blocked) {
            stopTimer(character.id);
            return;
        }

        const shouldResumeRag = !!(generationOptions && generationOptions.resumeRagState && isUserReply && !extraSystemDirective);
        timers.set(character.id, {
            timerId: null,
            targetTime: Date.now(),
            isThinking: true,
            ragProgress: (isUserReply && !extraSystemDirective)
                ? createRagProgress(shouldResumeRag ? (generationOptions.resumeRagState.failedAt || 'summary') : 'summary')
                : null
        });
        broadcastEngineState(wsClients);

        // Process pressure mechanics if this is a spontaneous auto-message (not a fast reply)
        let currentPressure = charCheck.pressure_level || 0;
        if (!isUserReply) {
            // Increase pressure since they reached a proactive trigger without user replying
            const prevPressure = currentPressure;
            currentPressure = Math.min(4, currentPressure + 1);

            // Affinity drop if they just hit max panic mode
            let newAffinity = charCheck.affinity;
            let newBlocked = charCheck.is_blocked;
            if (currentPressure === 4 && prevPressure < 4) {
                newAffinity = Math.max(0, newAffinity - 20); // Big penalty for ignoring them this long
                if (newAffinity <= 10) {
                    newBlocked = 1; // Blocked!
                    console.log(`[Engine] ${charCheck.name} has BLOCKED the user due to low affinity.`);
                }
            }

            const proactivePressurePatch = {
                pressure_level: currentPressure,
                affinity: newAffinity,
                is_blocked: newBlocked
            };
            db.updateCharacter(character.id, proactivePressurePatch);
            logEmotionTransition(
                charCheck,
                proactivePressurePatch,
                'auto_pressure_tick',
                '角色主动触发消息但仍未得到用户回应，焦虑值上升。'
            );
            charCheck.pressure_level = currentPressure;
            charCheck.affinity = newAffinity;
            charCheck.is_blocked = newBlocked;

            if (newBlocked) {
                stopTimer(character.id);
                return; // Don't even send this message, they just blocked you
            }
        }

        let customDelayMs = null;
        try {
            const {
                contextHistory,
                conversationDigest,
                liveHistory,
                transformedHistory,
                recentInputString
            } = await preparePrivateConversationState({
                db,
                memory,
                character: charCheck,
                refreshDigest: !!(isUserReply && !extraSystemDirective)
            });

            if (isUserReply && !extraSystemDirective) {
                updateRagProgress(character.id, wsClients, { currentKey: 'route' });
            }

            const { prompt: systemPrompt, promptWithoutDigest, retrievedMemoriesContext, promptStats } = await buildPrompt(charCheck, liveHistory, isTimerWakeup, {
                conversationDigest,
                antiRepeatMessages: contextHistory
            });
            if (isUserReply && !extraSystemDirective) {
                updateRagProgress(character.id, wsClients, { currentKey: 'topics' });
            }
            const apiMessages = [
                { role: 'system', content: systemPrompt },
                ...transformedHistory
            ];

            // Setup metadata block if we retrieved any memories
            let msgMetadata = null;
            if (retrievedMemoriesContext && retrievedMemoriesContext.length > 0) {
                msgMetadata = { retrievedMemories: retrievedMemoriesContext };
            }

            if (extraSystemDirective) {
                apiMessages.push({ role: 'user', content: extraSystemDirective });
            } else if (!isUserReply && apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'assistant') {
                // Prevent third-party AI API proxies from auto-injecting "继续" (Continue)
                // by explicitly providing a system-level user message.
                apiMessages.push({ role: 'user', content: '[系统提示：请根据当前语境继续上一话题，或者自然开启一个新话题。]' });
            }

            if (isUserReply && !extraSystemDirective) {
                try {
                    msgMetadata = await runStructuredRagPipeline({
                        character,
                        transformedHistory,
                        recentInputString,
                        conversationDigest,
                        wsClients,
                        apiMessages,
                        msgMetadata,
                        resumeState: generationOptions?.resumeRagState || null
                    });
                    setRagFailureState(character.id, null);
                } catch (intentErr) {
                    const rawMessage = String(intentErr?.message || 'Unknown RAG planner error');
                    console.error(`[Engine] RAG planner failed:`, rawMessage);
                    setRagFailureState(character.id, {
                        characterId: character.id,
                        latestUserMessage: recentInputString,
                        ...(intentErr?.ragResume || {})
                    });
                    updateRagProgress(character.id, wsClients, {
                        currentKey: 'answer',
                        status: 'error'
                    });
                    if (/RAG planner/i.test(rawMessage)) {
                        throw intentErr;
                    }
                    throw new Error(`RAG planner failed. Please retry. (${rawMessage.slice(0, 180)})`);
                }
            }

            if (isUserReply && !extraSystemDirective) {
                updateRagProgress(character.id, wsClients, { currentKey: 'answer' });
            }

            const currentBreakdown = { ...(promptStats?.universalBreakdown || {}) };
            const estimatedHistoryTokens = estimateMessageTokens(transformedHistory);
            const estimatedFullHistoryTokens = estimateMessageTokens(
                (Array.isArray(contextHistory) ? contextHistory : []).map(m => ({
                    role: m?.role === 'character' ? 'assistant' : 'user',
                    content: String(m?.content || '')
                }))
            );
            const estimatedMessageEnvelopeTokens = 8 + (Array.isArray(transformedHistory) ? transformedHistory.length * 2 : 0);
            const estimatedFullMessageEnvelopeTokens = 8 + (Array.isArray(contextHistory) ? contextHistory.length * 2 : 0);
            const estimatedSystemPromptTokens = getTokenCount(systemPrompt);
            const estimatedSystemPromptWithoutDigestTokens = getTokenCount(promptWithoutDigest || systemPrompt);
            const estimatedWithoutCacheTokens = estimatedSystemPromptWithoutDigestTokens + estimatedFullHistoryTokens + estimatedFullMessageEnvelopeTokens;
            const estimatedWithCacheTokens = estimatedSystemPromptTokens + estimatedHistoryTokens + estimatedMessageEnvelopeTokens;
            const estimatedRagInjectedTokens = Math.max(0, Number(currentBreakdown.z_memory || 0));
            const lastRequestContextSnapshot = {
                estimated_without_cache_tokens: estimatedWithoutCacheTokens,
                estimated_with_cache_tokens: estimatedWithCacheTokens,
                estimated_rag_injected_tokens: estimatedRagInjectedTokens,
                estimated_history_tokens: estimatedHistoryTokens,
                estimated_full_history_tokens: estimatedFullHistoryTokens,
                estimated_message_envelope_tokens: estimatedMessageEnvelopeTokens,
                estimated_full_message_envelope_tokens: estimatedFullMessageEnvelopeTokens,
                estimated_system_prompt_tokens: estimatedSystemPromptTokens,
                estimated_system_prompt_without_digest_tokens: estimatedSystemPromptWithoutDigestTokens,
                breakdown: currentBreakdown,
                module_routes: { ...(promptStats?.moduleRoutes || {}) },
                context_msg_limit: Number(charCheck.context_msg_limit || 0),
                live_history_window_size: Number(liveHistory.length || 0),
                visible_history_count: Number(contextHistory.length || 0),
                timestamp: Date.now()
            };

            recordLlmDebug(charCheck, 'input', apiMessages, {
                context_type: isUserReply ? 'private_reply' : (isTimerWakeup ? 'timer_wakeup' : 'proactive'),
                isUserReply,
                isTimerWakeup,
                extraSystemDirective: extraSystemDirective || '',
                retrievedMemoriesCount: Array.isArray(msgMetadata?.retrievedMemories) ? msgMetadata.retrievedMemories.length : 0,
                maxTokens: charCheck.max_tokens || 2000,
                model: charCheck.model_name,
                presencePenalty: isUserReply ? 0.35 : 0,
                frequencyPenalty: isUserReply ? 0.45 : 0,
                context_snapshot: isUserReply ? lastRequestContextSnapshot : null
            });
            const uncachedApiMessages = isUserReply
                ? [
                    { role: 'system', content: promptWithoutDigest || systemPrompt },
                    ...(Array.isArray(contextHistory) ? contextHistory : []).map(m => ({
                        role: m?.role === 'character' ? 'assistant' : 'user',
                        content: String(m?.content || '')
                    }))
                ]
                : null;

            let { content: generatedText, usage, finishReason } = await callLLM({
                endpoint: character.api_endpoint,
                key: character.api_key,
                model: character.model_name,
                messages: apiMessages,
                uncachedMessages: uncachedApiMessages,
                maxTokens: character.max_tokens || 2000,
                presencePenalty: isUserReply ? 0.35 : 0,
                frequencyPenalty: isUserReply ? 0.45 : 0,
                enableCache: !!isUserReply,
                cacheDb: db,
                cacheType: 'private_chat_reply',
                cacheTtlMs: 24 * 60 * 60 * 1000,
                cacheScope: `character:${character.id}`,
                cacheCharacterId: character.id,
                cacheKeyMode: 'private_prefix',
                enablePromptCacheHints: !!isUserReply,
                returnUsage: true,
                debugAttempt: buildLlmAttemptRecorder(character, {
                    context_type: isUserReply ? 'private_reply' : (isTimerWakeup ? 'timer_wakeup' : 'proactive')
                })
            });

            if ((finishReason === 'length' || looksPrematurelyCutOff(generatedText)) && generatedText) {
                try {
                    const continuation = await callLLM({
                        endpoint: character.api_endpoint,
                        key: character.api_key,
                        model: character.model_name,
                        messages: [
                            ...apiMessages,
                            { role: 'assistant', content: generatedText },
                            { role: 'user', content: '[系统续写] 你上一条消息被截断了。不要重说前文，只把刚才没说完的那句话自然续完并收尾。输出纯文本。' }
                        ],
                        maxTokens: Math.min(character.max_tokens || 2000, 300),
                        presencePenalty: isUserReply ? 0.2 : 0,
                        frequencyPenalty: isUserReply ? 0.3 : 0,
                        enableCache: !!isUserReply,
                        cacheDb: db,
                        cacheType: 'private_chat_reply_continuation',
                        cacheTtlMs: 24 * 60 * 60 * 1000,
                        cacheScope: `character:${character.id}`,
                        cacheCharacterId: character.id,
                        cacheKeyMode: 'private_prefix',
                        enablePromptCacheHints: !!isUserReply,
                        returnUsage: true,
                        debugAttempt: buildLlmAttemptRecorder(character, {
                            context_type: 'private_reply_continuation'
                        })
                    });
                    if (continuation?.content) {
                        generatedText = `${generatedText}${continuation.content.startsWith('\n') ? '' : ''}${continuation.content}`.trim();
                        if (continuation.usage) {
                            usage = usage || { prompt_tokens: 0, completion_tokens: 0 };
                            usage.prompt_tokens = (usage.prompt_tokens || 0) + (continuation.usage.prompt_tokens || 0);
                            usage.completion_tokens = (usage.completion_tokens || 0) + (continuation.usage.completion_tokens || 0);
                        }
                    }
                } catch (continuationErr) {
                    console.warn(`[Engine] Continuation failed for ${character.name}: ${continuationErr.message}`);
                }
            }

            if (usage) {
                recordTokenUsage(character.id, 'chat', usage);
                broadcastEvent(wsClients, {
                    type: 'token_stats',
                    character_id: character.id,
                    module: 'chat',
                    usage: usage
                });
            }

            console.log('\n[DEBUG] LLM raw output:', JSON.stringify(generatedText));
            recordLlmDebug(charCheck, 'output', generatedText, {
                context_type: isUserReply ? 'private_reply' : (isTimerWakeup ? 'timer_wakeup' : 'proactive'),
                finishReason: finishReason || 'unknown',
                usage: usage || null,
                model: charCheck.model_name
            });

            // --- Anti-Race-Condition Check ---
            // If the user clicked "Deep Wipe" while the LLM was thinking (which takes 5-15s),
            // we MUST abort saving this reply, otherwise we will resurrect their wiped stats!
            // We check specifically for the deep-wipe system notice rather than message count,
            // because message count check causes false positives on the very first message.
            const freshCharCheck = db.getCharacter(character.id);
            const postWipeCheck = db.getMessages(character.id, 2);
            const lastMsg = postWipeCheck[postWipeCheck.length - 1];
            const wasWiped = !freshCharCheck
                || postWipeCheck.length === 0                                          // messages fully cleared
                || (postWipeCheck.length <= 1 && lastMsg?.content?.includes('All chat history')); // wipe notice present
            if (wasWiped) {
                console.log(`\n[Engine] Aborting save for ${charCheck.name}: Chat history was wiped mid-generation.`);
                timers.delete(character.id);
                return;
            }

            if (generatedText) {
                // Check for self-scheduled timer tags like [TIMER: 60]
                const timerRegex = /\[TIMER:\s*(\d+)\s*\]/i;
                const match = generatedText.match(timerRegex);
                if (match && match[1]) {
                    let minutes = parseInt(match[1], 10);
                    // Cap the self-scheduled timer to the user's absolute max interval to prevent 2-hour dropoffs
                    const maxAllowedMins = charCheck.interval_max || 120;
                    minutes = Math.min(Math.max(minutes, 0.1), maxAllowedMins);
                    customDelayMs = minutes * 60 * 1000;
                    console.log(`[Engine] ${charCheck.name} self-scheduled next message in ${minutes} minutes (capped to max interval).`);
                }

                // Check for transfer tags like [TRANSFER: 5.20 | Sorry!]
                const transferRegex = /\[TRANSFER:\s*([\d.]+)\s*(?:\|\s*([\s\S]*?))?\s*\]/i;
                const transferMatch = generatedText.match(transferRegex);
                if (transferMatch && transferMatch[1]) {
                    const amount = parseFloat(transferMatch[1]);
                    const note = (transferMatch[2] || '').trim();
                    console.log(`[Engine] ${charCheck.name} wants to send a transfer of 楼${amount} note: "${note}"`);

                    // Create traceable transfer record in DB (also deducts char wallet)
                    let transferId = null;
                    try {
                        transferId = db.createTransfer({
                            charId: character.id,
                            senderId: character.id,
                            recipientId: 'user',
                            amount,
                            note,
                            messageId: null // will update below
                        });
                    } catch (walletErr) {
                        console.warn(`[Engine] ${charCheck.name} wallet insufficient for transfer 楼${amount}: ${walletErr.message}`);
                    }

                    // Only send transfer message + boost affinity if wallet had enough funds
                    if (transferId) {
                        broadcastWalletSync(wsClients, character.id);

                        // Build message with transfer ID so frontend can render the claim button
                        const transferText = `[TRANSFER]${transferId}|${amount}|${note}`;
                        const { id: tMsgId, timestamp: tTs } = db.addMessage(character.id, 'character', transferText);
                        broadcastNewMessage(wsClients, { id: tMsgId, character_id: character.id, role: 'character', content: transferText, timestamp: tTs });

                        // Boost affinity slightly and potentially unblock
                        const newAff = Math.min(100, charCheck.affinity + 20);
                        db.updateCharacter(character.id, { affinity: newAff, is_blocked: 0, pressure_level: 0 });
                    } else {
                        console.log(`[Engine] ${charCheck.name} transfer of 楼${amount} was BLOCKED (insufficient wallet). No message sent.`);
                    }
                }

                // Check for Moment tags
                const momentRegex = /\[MOMENT:\s*([\s\S]*?)\s*\]/i;
                const momentMatch = generatedText.match(momentRegex);
                if (momentMatch && momentMatch[1]) {
                    const momentContent = momentMatch[1].trim();
                    console.log(`[Engine] ${charCheck.name} posted a Moment: ${momentContent.substring(0, 20)}...`);
                    db.addMoment(character.id, momentContent);
                    broadcastEvent(wsClients, { type: 'moment_update' });
                }

                // Check for Diary tags
                const diaryRegex = /\[DIARY:\s*([\s\S]*?)\s*\]/i;
                const diaryMatch = generatedText.match(diaryRegex);
                if (diaryMatch && diaryMatch[1]) {
                    const diaryContent = diaryMatch[1].trim();
                    console.log(`[Engine] ${charCheck.name} wrote a Diary entry.`);
                    db.addDiary(character.id, diaryContent, 'neutral'); // Emotion could be extracted later
                }

                // Check for Diary Unlock
                const unlockRegex = /\[UNLOCK_DIARY\]/i;
                if (unlockRegex.test(generatedText)) {
                    console.log(`[Engine] ${charCheck.name} unlocked their diary for the user!`);
                    db.unlockDiaries(character.id);
                }

                // Check for Diary Password reveal [DIARY_PASSWORD:xxxx]
                const diaryPwRegex = /\[DIARY_PASSWORD:\s*([^\]]+)\s*\]/i;
                const diaryPwMatch = generatedText.match(diaryPwRegex);
                if (diaryPwMatch && diaryPwMatch[1]) {
                    const pw = diaryPwMatch[1].trim();
                    console.log(`[Engine] ${charCheck.name} set a diary password: ${pw}`);
                    db.setDiaryPassword(character.id, pw);
                }

                // Check for Affinity changes (AI-evaluated)
                const affinityRegex = /\[AFFINITY:\s*([+-]?\d+)\s*\]/i;
                const affinityMatch = generatedText.match(affinityRegex);
                if (affinityMatch && affinityMatch[1]) {
                    const delta = parseInt(affinityMatch[1], 10);
                    const newAff = Math.max(0, Math.min(100, charCheck.affinity + delta));
                    console.log(`[Engine] ${charCheck.name} evaluation: Affinity changed by ${delta}, now ${newAff}`);
                    db.updateCharacter(character.id, { affinity: newAff });
                    charCheck.affinity = newAff; // Update local state
                    broadcastEvent(wsClients, { type: 'refresh_contacts' });
                }

                const emotionReasonRegex = /\[EMOTION_REASON:\s*([\s\S]*?)\s*\]/i;
                const emotionReasonMatch = generatedText.match(emotionReasonRegex);
                const aiEmotionReason = emotionReasonMatch?.[1]?.trim() || '';

                const combinedEmotionPatch = {};
                let combinedEmotionSource = '';
                const combinedEmotionReasons = [];

                const moodDelta = parseTaggedDelta(generatedText, 'MOOD_DELTA', -12, 12);
                const pressureDelta = parseTaggedDelta(generatedText, 'PRESSURE_DELTA', -2, 2);
                if (moodDelta !== null) {
                    combinedEmotionPatch.mood = clamp((charCheck.mood ?? 50) + moodDelta, 0, 100);
                    combinedEmotionSource = combinedEmotionSource || 'ai_combined_emotion_update';
                }
                if (pressureDelta !== null) {
                    combinedEmotionPatch.pressure_level = clamp((charCheck.pressure_level ?? 0) + pressureDelta, 0, 4);
                    combinedEmotionSource = combinedEmotionSource || 'ai_combined_emotion_update';
                }
                if (moodDelta !== null || pressureDelta !== null) {
                    combinedEmotionReasons.push('角色在回复中主动给出了自己的心情/焦虑变化值。');
                }

                const emotionStateRegex = /\[EMOTION_STATE:\s*([a-zA-Z_\u4e00-\u9fa5]+)\s*\]/i;
                const emotionStateMatch = generatedText.match(emotionStateRegex);
                if (emotionStateMatch?.[1]) {
                    const statePatch = getExplicitEmotionStatePatch({ ...charCheck, ...combinedEmotionPatch }, emotionStateMatch[1]);
                    if (statePatch && Object.keys(statePatch).length > 0) {
                        Object.assign(combinedEmotionPatch, statePatch);
                        combinedEmotionSource = combinedEmotionSource || 'ai_combined_emotion_update';
                        combinedEmotionReasons.push('角色在回复中主动声明了当前主情绪。');
                    }
                }

                // Check for Pressure changes (AI-evaluated resets)
                if (charCheck.sys_pressure !== 0) {
                    const pressureRegex = /\[PRESSURE:\s*(\d+)\s*\]/i;
                    const pressureMatch = generatedText.match(pressureRegex);
                    if (pressureMatch && pressureMatch[1]) {
                        const newPressure = parseInt(pressureMatch[1], 10);
                        console.log(`[Engine] ${charCheck.name} evaluation: Pressure set to ${newPressure}`);
                        combinedEmotionPatch.pressure_level = newPressure;
                        combinedEmotionSource = combinedEmotionSource || 'ai_combined_emotion_update';
                        combinedEmotionReasons.push('角色在回复中主动调整了自己的焦虑值。');
                    }
                }

                // Parse [JEALOUSY:N] tag 鈥?AI self-regulates jealousy cooldown
                if (charCheck.sys_jealousy !== 0) {
                    const jealousyRegex = /\[JEALOUSY:\s*(\d+)\s*\]/i;
                    const jealousyMatch = generatedText.match(jealousyRegex);
                    if (jealousyMatch && jealousyMatch[1]) {
                        const newJealousy = Math.min(100, Math.max(0, parseInt(jealousyMatch[1], 10)));
                        combinedEmotionPatch.jealousy_level = newJealousy;
                        if (newJealousy === 0) combinedEmotionPatch.jealousy_target = '';
                        combinedEmotionSource = combinedEmotionSource || 'ai_combined_emotion_update';
                        combinedEmotionReasons.push('角色在回复中主动调整了自己的嫉妒值。');
                        console.log(`[Engine] ${character.name} jealousy self-adjusted to ${newJealousy}`);
                    }
                }

                if (Object.keys(combinedEmotionPatch).length > 0) {
                    db.updateCharacter(character.id, combinedEmotionPatch);
                    logEmotionTransition(
                        charCheck,
                        combinedEmotionPatch,
                        combinedEmotionSource || 'ai_combined_emotion_update',
                        aiEmotionReason || combinedEmotionReasons.join(' ')
                    );
                    Object.assign(charCheck, combinedEmotionPatch);
                    broadcastEvent(wsClients, { type: 'refresh_contacts' });
                }

                // Check for Moment interactions: LIKES
                const momentLikeRegex = /\[MOMENT_LIKE:\s*(\d+)\s*\]/gi;
                let mLikeMatch;
                while ((mLikeMatch = momentLikeRegex.exec(generatedText)) !== null) {
                    if (mLikeMatch[1]) {
                        db.toggleLike(parseInt(mLikeMatch[1], 10), character.id);
                        broadcastEvent(wsClients, { type: 'moment_update' });
                    }
                }

                // Check for Moment interactions: COMMENTS
                const momentCommentRegex = /\[MOMENT_COMMENT:\s*(\d+)\s*:\s*([^\]]+)\]/gi;
                let mCommentMatch;
                while ((mCommentMatch = momentCommentRegex.exec(generatedText)) !== null) {
                    if (mCommentMatch[1] && mCommentMatch[2]) {
                        db.addComment(parseInt(mCommentMatch[1], 10), character.id, mCommentMatch[2].trim());
                        console.log(`[Engine] ${charCheck.name} commented on moment ${mCommentMatch[1]}: ${mCommentMatch[2]}`);
                        broadcastNewMessage(wsClients, { type: 'moment_update' });
                    }
                }

                // Check for CHAR_AFFINITY changes (inter-character affinity from private chat context)
                const charAffinityRegex = /\[CHAR_AFFINITY:([^:]+):([+-]?\d+)\]/gi;
                let charAffMatch;
                while ((charAffMatch = charAffinityRegex.exec(generatedText)) !== null) {
                    const targetId = charAffMatch[1].trim();
                    const delta = parseInt(charAffMatch[2], 10);
                    if (targetId && !isNaN(delta)) {
                        const source = `private:${character.id}`;
                        const existing = db.getCharRelationship(character.id, targetId);
                        const existingRow = existing?.sources?.find(s => s.source === source);
                        const currentAffinity = existingRow?.affinity || 50;
                        const newAffinity = Math.max(0, Math.min(100, currentAffinity + delta));
                        db.updateCharRelationship(character.id, targetId, source, { affinity: newAffinity });
                        console.log(`[Social] ${charCheck.name} 鈫?${targetId}: private affinity delta ${delta}, now ${newAffinity}`);
                    }
                }

                let cityIntentHandled = false;
                const cityActionRegex = /\[CITY_ACTION:\s*([\s\S]*?)\s*\]/i;
                const cityActionMatch = generatedText.match(cityActionRegex);
                if (cityActionMatch && cityActionMatch[1] && cityReplyActionCallback) {
                    try {
                        const rawCityAction = cityActionMatch[1].trim();
                        let parsedCityAction = null;
                        try {
                            parsedCityAction = JSON.parse(rawCityAction);
                        } catch (cityActionParseErr) {
                            const repaired = rawCityAction
                                .replace(/,\s*([\]}])/g, '$1')
                                .replace(/\/\/.*$/gm, '')
                                .trim();
                            parsedCityAction = JSON.parse(repaired);
                        }
                        if (parsedCityAction && typeof parsedCityAction === 'object') {
                            await cityReplyActionCallback(userId, character.id, parsedCityAction, generatedText);
                            cityIntentHandled = true;
                        }
                    } catch (cityActionErr) {
                        console.warn(`[Engine] City reply action sync failed for ${character.name}: ${cityActionErr.message}`);
                    }
                }

                const cityIntentRegex = /\[CITY_INTENT:\s*([^\]]+)\]/i;
                const cityIntentMatch = generatedText.match(cityIntentRegex);
                if (!cityIntentHandled && cityIntentMatch && cityIntentMatch[1] && cityReplyIntentCallback) {
                    try {
                        await cityReplyIntentCallback(userId, character.id, cityIntentMatch[1].trim(), generatedText);
                        cityIntentHandled = true;
                    } catch (cityIntentErr) {
                        console.warn(`[Engine] City reply intent sync failed for ${character.name}: ${cityIntentErr.message}`);
                    }
                }

                // Strip all tags from the final text message using a global regex
                const globalStripRegex = /\[(?:TIMER|TRANSFER|MOMENT|MOMENT_LIKE|MOMENT_COMMENT|DIARY|UNLOCK_DIARY|AFFINITY|CHAR_AFFINITY|PRESSURE|PRESSURE_DELTA|JEALOUSY|MOOD_DELTA|EMOTION_REASON|EMOTION_STATE|CITY_INTENT|CITY_ACTION|DIARY_PASSWORD|REDPACKET_SEND|Red Packet)[^\]]*\]/gi;
                generatedText = generatedText.replace(globalStripRegex, '').replace(/\[\s*\]/g, '').replace(/\n{3,}/g, '\n\n').trim();

                if (generatedText.length > 0 && cityReplyStateSyncCallback && !cityIntentHandled) {
                    try {
                        await cityReplyStateSyncCallback(userId, character.id, generatedText);
                    } catch (citySyncErr) {
                        console.warn(`[Engine] City reply state sync failed for ${character.name}: ${citySyncErr.message}`);
                    }
                }

                if (generatedText.length === 0) {
                    // The AI outputted only tags or failed to generate text. Use a randomized fallback.
                    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
                    if (isUserReply) {
                        generatedText = pick(["嗯。", "嗯哼", "好的", "好呀", "知道了", "嗯嗯"]);
                    } else if (charCheck.pressure_level >= 3) {
                        generatedText = pick([
                            "你到底在干嘛啊...为什么一直不理我...",
                            "我是不是做错什么了...你怎么都不回我...",
                            "真的好难过，你是不是不想理我了？",
                            "我一直在等你回消息...算了吧...",
                            "你再不理我我就真的要生气了！",
                            "是不是把我忘了啊...好吧..."
                        ]);
                    } else if (charCheck.pressure_level >= 1) {
                        generatedText = pick([
                            "人呢，在忙吗？",
                            "在干嘛呢，怎么不说话？",
                            "你还在线吗？",
                            "喂？有人吗？",
                            "怎么这么安静？",
                            "你去哪里了啊"
                        ]);
                    } else {
                        generatedText = pick([
                            "哈喽，在干嘛呢？",
                            "喂，最近怎么样？",
                            "今天过得怎么样呀",
                            "你在忙什么呢",
                            "突然想找你聊聊天",
                            "无聊了，来找你说说话。"
                        ]);
                    }
                }

                if (generatedText.length > 0) {
                    // 鈹€鈹€ Server-side deduplication: reject identical/near-identical messages 鈹€鈹€
                    const recentCharMsgs = db.getMessages(character.id, 15)
                        .filter(m => m.role === 'character')
                        .slice(-8)
                        .map(m => m.content.replace(/\s+/g, '').toLowerCase());
                    const normalizedNew = generatedText.replace(/\s+/g, '').toLowerCase();
                    const isDuplicate = recentCharMsgs.some(prev => {
                        // Layer 1: Exact match
                        if (prev === normalizedNew) return true;

                        // Layer 2: Overall character similarity > 50%
                        const shorter = Math.min(prev.length, normalizedNew.length);
                        const longer = Math.max(prev.length, normalizedNew.length);
                        if (shorter === 0) return false;
                        let matches = 0;
                        for (let ci = 0; ci < shorter; ci++) {
                            if (prev[ci] === normalizedNew[ci]) matches++;
                        }
                        if ((matches / longer) > 0.5) return true;

                        // Layer 3: Prefix pattern 鈥?if first 40% of message is same, it's a structural repeat
                        const prefixLen = Math.max(4, Math.floor(Math.min(prev.length, normalizedNew.length) * 0.4));
                        if (prev.substring(0, prefixLen) === normalizedNew.substring(0, prefixLen)) return true;

                        return false;
                    });

                    if (isDuplicate && !isUserReply) {
                        // Track consecutive dedup blocks per character
                        const blockCount = (dedupBlockCounts.get(character.id) || 0) + 1;
                        dedupBlockCounts.set(character.id, blockCount);
                        console.log(`[Engine] DEDUP: ${charCheck.name} generated duplicate message (block #${blockCount}), SKIPPING: "${generatedText.substring(0, 60)}..."`);

                        if (blockCount >= 2) {
                            // After 2 consecutive blocks, inject a context-breaking system message
                            const topicResetMsg = `[System Notice: Your previous messages were too repetitive and were blocked. You MUST talk about something COMPLETELY DIFFERENT now. Do NOT reply to the user's last message again - instead, share what you're doing, talk about something random, express a new emotion, or bring up an unrelated memory. Be creative and surprising.]`;
                            db.addMessage(character.id, 'system', topicResetMsg);
                            console.log(`[Engine] Injected topic-reset notice for ${charCheck.name} after ${blockCount} dedup blocks.`);
                            dedupBlockCounts.set(character.id, 0); // Reset counter
                        }

                        console.log(`[DEBUG] === Trigger Message Exit: ${charCheck.name}. Calling scheduleNext. ===`);
                        scheduleNext(character, wsClients);
                        return;
                    }

                    // Reset dedup block counter on successful send
                    dedupBlockCounts.set(character.id, 0);

                    // Split the response by newlines to allow the AI to send multiple separate bubbles in one turn
                    const textBubbles = generatedText.split('\n').map(msg => msg.trim()).filter(msg => msg.length > 0);

                    for (let i = 0; i < textBubbles.length; i++) {
                        const bubbleString = textBubbles[i];

                        // Save to DB
                        const { id: messageId, timestamp: messageTs } = db.addMessage(character.id, 'character', bubbleString, msgMetadata);
                        const newMessage = {
                            id: messageId,
                            character_id: character.id,
                            role: 'character',
                            content: bubbleString,
                            timestamp: messageTs + i, // slight increment to ensure ordering
                            read: 0,
                            metadata: msgMetadata
                        };

                        // Push to any connected websockets
                        broadcastNewMessage(wsClients, newMessage);
                    }

                    if (isUserReply && !extraSystemDirective) {
                        updateRagProgress(character.id, wsClients, {
                            currentKey: 'answer',
                            status: 'completed'
                        });
                    }

                    // Trigger memory extraction in background based on recent context + new full message
                    memory.extractMemoryFromContext(character, [...liveHistory, { role: 'character', content: generatedText, timestamp: Date.now() }])
                        .catch(err => console.error('[Engine] Memory extraction err:', err.message));
                    memory.updateConversationDigest(character)
                        .catch(err => console.error('[Engine] Conversation digest update err:', err.message));
                }
            }

        } catch (e) {
            console.error(`[Engine] Failed to trigger message for ${character.id}:`, e.message);
            if (isUserReply && !extraSystemDirective) {
                updateRagProgress(character.id, wsClients, {
                    currentKey: 'answer',
                    status: 'error'
                });
            }
            // Show the error visibly in the chat so the user knows what went wrong
            const errText = e.message || 'Unknown error';
            const { id: msgId, timestamp: msgTs } = db.addMessage(character.id, 'system', `[System] API Error: ${errText}`);
            broadcastNewMessage(wsClients, {
                id: msgId, character_id: character.id, role: 'system',
                content: `[System] API Error: ${errText}`, timestamp: msgTs
            });
            if (generationOptions?.propagateError) {
                throw e;
            }
        }

        // Re-fetch fresh character data for scheduling (status/interval/pressure may have changed during LLM call)
        const freshChar = db.getCharacter(character.id);
        if (freshChar) {
            console.log(`[DEBUG] === Trigger Message Exit: ${freshChar.name}. Calling scheduleNext. ===\n`);
            scheduleNext(freshChar, wsClients, customDelayMs);
        } else {
            console.log(`[DEBUG] === Trigger Message Exit: character ${character.id} no longer exists, skipping scheduleNext. ===\n`);
        }
    }

    // Schedules a setTimeout based on character's interval settings
    function scheduleNext(character, wsClients, exactDelayMs = null) {
        const preservedRagProgress = timers.get(character.id)?.ragProgress || null;
        stopTimer(character.id); // clear existing if any

        if (character.status !== 'active') return;

        let delay = exactDelayMs;

        if (delay === null || delay === undefined) {
            // If proactive messaging is toggled OFF, character will not auto-message.
            if (character.sys_proactive === 0) return;

            // Normal random delay calculation
            delay = getRandomDelayMs(character.interval_min, character.interval_max);

            // Apply pressure multiplier: Higher pressure = significantly shorter delay
            const pressure = character.sys_pressure === 0 ? 0 : (character.pressure_level || 0);
            if (pressure === 1) delay = delay * 0.7; // 30% faster
            else if (pressure === 2) delay = delay * 0.5; // 50% faster
            else if (pressure === 3) delay = delay * 0.3; // 70% faster
            else if (pressure >= 4) delay = delay * 0.2; // 80% faster (panic mode)
        } else {
            // It's a self-scheduled timer. If Timer system is OFF, fall back to random proactive message.
            if (character.sys_timer === 0) {
                console.log(`[DEBUG] sys_timer is OFF, ignoring self-schedule for ${character.name}`);
                return scheduleNext(character, wsClients, null);
            }
        }

        console.log(`[DEBUG] scheduleNext for ${character.name}. delay=${delay} ms (${Math.round(delay / 60000)} min)`);
        console.log(`[Engine] Next message for ${character.name} scheduled in ${Math.round(delay / 60000)} minutes. ${exactDelayMs ? '(Self-Scheduled)' : ''}`);

        const timerId = setTimeout(() => {
            console.log(`[DEBUG] Timeout fired for ${character.name}! Executing triggerMessage.`);
            triggerMessage(character, wsClients, false, !!exactDelayMs);
        }, delay);

        timers.set(character.id, {
            timerId,
            targetTime: Date.now() + delay,
            isThinking: false,
            ragProgress: preservedRagProgress
        });
        broadcastEngineState(wsClients);
    }

    // Explicitly stop a character's engine
    function stopTimer(characterId, wsClients = null) {
        if (timers.has(characterId)) {
            clearTimeout(timers.get(characterId).timerId);
            timers.delete(characterId);
            if (wsClients) broadcastEngineState(wsClients);
        }
    }

    // Loop through all active characters and start their engines
    function startEngine(wsClients) {
        console.log('[Engine] Starting background timers...');
        const characters = db.getCharacters();
        for (const char of characters) {
            if (char.status !== 'active') continue;

            if (char.sys_proactive === 0) {
                // Proactive messaging is OFF 鈥?don't trigger startup message, just keep timer silent
                console.log(`[Engine] ${char.name}: sys_proactive=OFF, skipping startup message.`);
                continue;
            }

            // Schedule a normal proactive message instead of immediately triggering a reply.
            // This prevents echoing the character's own last message on every server restart.
            scheduleNext(char, wsClients);
        }
        broadcastEngineState(wsClients);
        // Broadcast live engine state every second
        if (!stateBroadcastInterval) {
            stateBroadcastInterval = setInterval(() => {
                broadcastEngineState(wsClients);
            }, 1000);
        }
    }

    // Sends the message object to all connected frontend clients
    function broadcastNewMessage(wsClients, messageObj) {
        const payload = JSON.stringify({
            type: 'new_message',
            data: messageObj
        });
        wsClients.forEach(client => {
            if (client.readyState === 1 /* WebSocket.OPEN */) {
                client.send(payload);
            }
        });
    }

    // Sends a raw event object to all connected frontend clients
    function broadcastEvent(wsClients, eventObj) {
        const payload = JSON.stringify(eventObj);
        wsClients.forEach(client => {
            if (client.readyState === 1 /* WebSocket.OPEN */) {
                client.send(payload);
            }
        });
    }

    function broadcastWalletSync(wsClients, charId) {
        if (!charId) return;
        const char = db.getCharacter(charId);
        const userProfile = db.getUserProfile();
        const payload = JSON.stringify({
            type: 'wallet_sync',
            data: {
                characterId: charId,
                characterWallet: char?.wallet,
                userWallet: userProfile?.wallet
            }
        });
        wsClients.forEach(client => {
            if (client.readyState === 1) client.send(payload);
        });
    }

    /**
     * Handle a user message. Resets timer, and triggers an immediate "return reaction" 
     * if pressure was high, before zeroing out the pressure.
     */
    function handleUserMessage(characterId, wsClients, options = {}) {
        const char = db.getCharacter(characterId);
        if (!char || char.status !== 'active' || char.is_blocked) return;

        console.log(`[Engine] User sent message to ${char.name}. Resetting timer.`);
        const hadPendingCityReply = !!char.city_reply_pending;
        const cityIgnoreStreak = Math.max(0, char.city_ignore_streak || 0);

        if (hadPendingCityReply) {
            db.updateCharacter(characterId, {
                city_reply_pending: 0,
                city_post_ignore_reaction: cityIgnoreStreak > 0 ? 1 : 0
            });
        }

        // We optionally trigger an immediate response. Wait 1-3 seconds for realism.
        setTimeout(() => {
            // Re-fetch fresh character data (settings may have changed in the 1.5s gap)
            const freshChar = db.getCharacter(characterId);
            if (!freshChar || freshChar.status !== 'active' || freshChar.is_blocked) return;
            const resumeRagState = options?.useRetryResume ? getRagFailureState(characterId) : null;
            // Trigger a reply. We leave pressure AND jealousy as-is for this reply so it generates the Return Reaction
            // Jealousy is NOT zeroed out 鈥?the AI decides via [JEALOUSY:N] tag when to forgive
            triggerMessage(freshChar, wsClients, true, false, null, { resumeRagState }).finally(() => {
                // The model must explicitly relax via [PRESSURE]/[JEALOUSY] tags.
                const cleanupPatch = {};
                if (hadPendingCityReply) {
                    cleanupPatch.city_post_ignore_reaction = 0;
                    cleanupPatch.city_ignore_streak = 0;
                }
                if (Object.keys(cleanupPatch).length > 0) {
                    db.updateCharacter(characterId, cleanupPatch);
                }
            });
        }, 1500);

        // Stop current background timer
        stopTimer(characterId);
    }

    async function triggerImmediateUserReply(characterId, wsClients, options = {}) {
        const freshChar = db.getCharacter(characterId);
        if (!freshChar || freshChar.status !== 'active' || freshChar.is_blocked) {
            throw new Error('角色不可用');
        }
        stopTimer(characterId);
        await triggerMessage(
            freshChar,
            wsClients,
            true,
            false,
            options?.extraSystemDirective || null,
            options || {}
        );
    }

    /**
     * Iterates through all other active characters. Gives them a chance to trigger a jealousy message
     * since the user is currently talking to someone else.
     * Now tracks WHO the user is chatting with (rival) and accumulates jealousy_level.
     */
    function triggerJealousyCheck(activeCharacterId, wsClients) {
        const characters = db.getCharacters();
        const activeCharacter = db.getCharacter(activeCharacterId);
        const rivalName = activeCharacter?.name || activeCharacterId || 'someone else';

        for (const char of characters) {
            if (char.id !== activeCharacterId && char.status === 'active' && char.sys_jealousy !== 0) {
                const userProfile = db.getUserProfile();
                const jealousyChance = userProfile?.jealousy_chance ?? 0.05;
                if (Math.random() < jealousyChance) {
                    // Accumulate jealousy_level (0-100)
                    const newLevel = Math.min(100, (char.jealousy_level || 0) + 20);
                    db.updateCharacter(char.id, { jealousy_level: newLevel, jealousy_target: activeCharacterId });
                    console.log(`[Engine] Jealousy for ${char.name} 鈫?level ${newLevel} (rival: ${rivalName})`);

                    stopTimer(char.id);
                    const delayMs = getRandomDelayMs(0.5, 2);
                    timers.set(char.id, { timerId: null, targetTime: Date.now() + delayMs, isThinking: false });
                    setTimeout(() => {
                        // Re-fetch to get updated jealousy_level
                        const freshChar = db.getCharacter(char.id);
                        if (freshChar) triggerJealousyMessage(freshChar, wsClients, activeCharacterId);
                    }, delayMs);
                }
            }
        }
    }

    /**
     * Specialized message trigger for Jealousy 鈥?delegates to triggerMessage
     * since buildPrompt already injects jealousy context (level + rival name).
     * This ensures jealousy messages get the full chat window, memories, anti-repeat, etc.
     */
    async function triggerJealousyMessage(character, wsClients, rivalId = null) {
        const rivalLabel = rivalId ? (db.getCharacter(rivalId)?.name || rivalId) : 'someone else';
        console.log(`[Engine] Jealousy message for ${character.name} (rival: ${rivalLabel}, level: ${character.jealousy_level})`);
        // triggerMessage with isUserReply=false so it also escalates pressure
        await triggerMessage(character, wsClients, false);
    }

    /**
     * Specialized message trigger for explicit Proactive Tasks (Scheduler DLC)
     * Injects a specialized system directive to force the AI to output exactly what is asked.
     */
    async function triggerProactiveMessage(charId, taskPrompt, wsClients) {
        const character = db.getCharacter(charId);
        if (!character || character.is_blocked) return;

        console.log(`[Engine] Proactive task triggered for ${character.name}: ${taskPrompt}`);

        // Emulate a system message at the end of the context to force the AI's hand
        const sysDirective = `[System Directive: ${taskPrompt} (Respond immediately based on this instruction, but stay in persona)]`;

        // We'll use the existing triggerMessage flow, but we temporarily inject this directive into the chat history just for this prompt
        // To do this safely without corrupting the DB, we can just intercept the generation. 
        // For simplicity and to reuse all anti-repeat/affinity logic, we'll actually insert an invisible system message.

        const { id: internalId } = db.addMessage(character.id, 'system', sysDirective);
        db.hideMessagesByIds(character.id, [internalId]); // Instantly hide it from the user's UI

        await triggerMessage(character, wsClients, false, false, sysDirective);
    }

    // 鈹€鈹€鈹€ Group Proactive Messaging 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    const groupProactiveTimers = new Map(); // Store group proactive timers { groupId: handle }
    let groupChainCallback = null;
    let cityReplyStateSyncCallback = null;
    let cityReplyIntentCallback = null;
    let cityReplyActionCallback = null;

    function setGroupChainCallback(cb) {
        groupChainCallback = cb;
    }

    function setCityReplyStateSyncCallback(cb) {
        cityReplyStateSyncCallback = cb;
    }

    function setCityReplyIntentCallback(cb) {
        cityReplyIntentCallback = cb;
    }

    function setCityReplyActionCallback(cb) {
        cityReplyActionCallback = cb;
    }

    function stopGroupProactiveTimer(groupId) {
        if (groupProactiveTimers.has(groupId)) {
            clearTimeout(groupProactiveTimers.get(groupId));
            groupProactiveTimers.delete(groupId);
        }
    }

    function scheduleGroupProactive(groupId, wsClients) {
        stopGroupProactiveTimer(groupId);
        const profile = db.getUserProfile();
        if (!profile?.group_proactive_enabled) return;

        const minMs = Math.max(1, profile.group_interval_min || 10) * 60 * 1000;
        const maxMs = Math.max(minMs, (profile.group_interval_max || 60) * 60 * 1000);
        const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

        console.log(`[GroupProactive] Group ${groupId}: next fire in ${Math.round(delay / 60000)} min`);
        const handle = setTimeout(() => triggerGroupProactive(groupId, wsClients), delay);
        groupProactiveTimers.set(groupId, handle);
    }

    async function triggerGroupProactive(groupId, wsClients) {
        const profile = db.getUserProfile();
        if (!profile?.group_proactive_enabled) return;

        const group = db.getGroup(groupId);
        if (!group) return;

        // Pick a random eligible char member
        const charMembers = group.members.filter(m => m.member_id !== 'user');
        if (charMembers.length === 0) { scheduleGroupProactive(groupId, wsClients); return; }

        const shuffled = [...charMembers].sort(() => Math.random() - 0.5);
        let picked = null;
        for (const m of shuffled) {
            const c = db.getCharacter(m.member_id);
            if (c && !c.is_blocked) { picked = c; break; }
        }
        if (!picked) { scheduleGroupProactive(groupId, wsClients); return; }

        // Get recent messages to avoid repetition
        const recentMsgs = db.getVisibleGroupMessages(groupId, 10);
        const recentTexts = recentMsgs.slice(-5).map(m => `"${m.content}"`).join(', ');
        const userName = profile?.name || 'User';
        const historyForPrompt = recentMsgs.map(m => {
            const sName = m.sender_id === 'user' ? userName : (db.getCharacter(m.sender_id)?.name || m.sender_name || '?');
            return { role: m.sender_id === picked.id ? 'assistant' : 'user', content: `[${sName}]: ${formatMessageForLLM(db, m.content)}` };
        });

        const now = new Date();
        const hour = now.getHours();
        const tod = hour < 6 ? '深夜' : hour < 10 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';

        // 1+2 Hybrid Hidden Context Injection
        const otherMembers = group.members
            .filter(m => m.member_id !== 'user' && m.member_id !== picked.id)
            .map(m => db.getCharacter(m.member_id))
            .filter(Boolean);
        const engineContextWrapper = { getUserDb, getMemory: require('./memory').getMemory, userId };
        const universalResult = await buildUniversalContext(engineContextWrapper, picked, recentTexts, true, otherMembers);
        const secretContextStr = `\n统一上下文：\n${universalResult?.preamble || ''}`;

        const systemPrompt = `你是${picked.name}，正在群聊"${group.name}"中。Persona: ${picked.persona || '普通人'}
现在是${tod}。你想主动在群里发一条消息，引发一些互动。
最近的对话：${recentTexts || '（无）'}
要求：
1. 说一句全新的话，不能重复上面的任何内容。
2. 可以发起新话题、聊生活、问问题、分享心情。
3. 保持口语化，1-2句。
4. 不要带名字前缀，直接说话。${secretContextStr}`;

        try {
            const { content: reply, usage } = await callLLM({
                endpoint: picked.api_endpoint,
                key: picked.api_key,
                model: picked.model_name,
                messages: [{ role: 'system', content: systemPrompt }, ...historyForPrompt],
                maxTokens: picked.max_tokens || 300,
                returnUsage: true
            });
            recordTokenUsage(picked.id, 'group_proactive', usage);
            if (reply && reply.trim()) {
                const clean = reply.trim().replace(/\[CHAR_AFFINITY:[^\]]*\]/gi, '').trim();
                if (clean) {
                    const msgId = db.addGroupMessage(groupId, picked.id, clean, picked.name, picked.avatar);
                    const proactiveEmotionPatch = applyEmotionEvent(picked, 'group_character_message_sent');
                    if (proactiveEmotionPatch) {
                        db.updateCharacter(picked.id, proactiveEmotionPatch);
                    }
                    const payload = JSON.stringify({ type: 'group_message', data: { id: msgId, group_id: groupId, sender_id: picked.id, sender_name: picked.name, sender_avatar: picked.avatar, content: clean, timestamp: Date.now() } });
                    wsClients.forEach(c => { if (c.readyState === 1) c.send(payload); });
                    console.log(`[GroupProactive] ${picked.name} in ${group.name}: "${clean}"`);

                    // Trigger other AIs to respond to this proactive message!
                    if (groupChainCallback) {
                        // Small delay before firing the chain to simulate reading
                        setTimeout(() => groupChainCallback(userId, groupId, wsClients, [], false), 2000);
                    }
                }
            }
        } catch (e) {
            console.error(`[GroupProactive] Error for ${picked.name}:`, e.message);
        }
        scheduleGroupProactive(groupId, wsClients);
    }

    function startGroupProactiveTimers(wsClients) {
        const groups = db.getGroups();
        for (const g of groups) {
            scheduleGroupProactive(g.id, wsClients);
        }
    }



    function stopAllTimers() {
        for (const [charId, t] of timers.entries()) {
            clearTimeout(t.timerId);
        }
        timers.clear();
        for (const [groupId, t] of groupProactiveTimers.entries()) {
            clearTimeout(t);
        }
        groupProactiveTimers.clear();
    }

    // --- END ENCLOSED ENGINE FUNCTIONS ---

    const engineInstance = {

        startEngine,
        stopTimer,
        handleUserMessage,
        triggerImmediateUserReply,
        broadcastNewMessage,
        broadcastEvent,
        broadcastWalletSync,
        triggerJealousyCheck,
        triggerProactiveMessage,
        startGroupProactiveTimers,
        stopGroupProactiveTimer,
        scheduleGroupProactive,
        setGroupChainCallback,
        setCityReplyStateSyncCallback,
        setCityReplyIntentCallback,
        setCityReplyActionCallback
        ,
        stopAllTimers
    };

    engineCache.set(userId, engineInstance);
    return engineInstance;
}

module.exports = { getEngine, engineCache, getDefaultGuidelines };



