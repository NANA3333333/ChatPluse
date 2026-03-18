/**
 * server/contextBuilder.js
    * 
 * Provides a unified Universal Context(Preamble) for all AI interactions.
 * This guarantees that whether the AI is replying in private chat, group chat,
 * the City DLC, or scheduled memory aggregation, it has the exact same baseline
    * awareness of the world state, its own recent actions, and related memories.
 */

const { getTokenCount } = require('./utils/tokenizer');

function shouldRetrieveLongTermMemories(recentInput = '') {
    const text = String(recentInput || '').trim();
    if (text.length < 12) return false;

    const explicitRecallRegex = /(记得|还记得|想起|回忆|之前|以前|上次|那次|刚才|刚刚|昨天|前天|聊过|说过|提过|答应过|忘了|后来|结果|发生了什么|怎么回事)/;
    const durableFactRegex = /(商业街|工厂|餐厅|便利店|公园|群聊|群里|朋友圈|日记|暗号|密码|秘密|礼物|转账|红包|任务|悬赏|监视|黑客|钱包|体力|吃了|饿|撑|医院|住院|打工)/;
    const directAskRegex = /(你.*(是不是|有没有|当时|那天|之前|以前|上次|那次|刚才|刚刚|说过|做过|去过|见过|答应过|还在|后来|结果))/;
    const stateFollowupRegex = /(怎么了|咋了|怎么回事|发生什么|后来呢|结果呢|还好吗|还疼吗|还饿吗|还撑吗|还记得吗|是不是这样|是不是那个)/;

    const explicitRecall = explicitRecallRegex.test(text);
    const durableFact = durableFactRegex.test(text);
    const directAsk = directAskRegex.test(text);
    const stateFollowup = stateFollowupRegex.test(text);

    if (explicitRecall) return true;
    if (durableFact && (directAsk || stateFollowup)) return true;
    return false;
}

async function buildUniversalContext(context, character, recentInput = '', isGroupContext = false, activeTargets = []) {
    const { getUserDb, getMemory, userId } = context;
    const resolvedUserId = userId || character.user_id || 'default';
    const db = getUserDb(resolvedUserId);
    const memory = getMemory(resolvedUserId);

    let prompt = '';
    const userProfile = db.getUserProfile ? db.getUserProfile() : { name: 'User' };
    const userName = userProfile?.name || 'User';

    // Token metric accumulator
    const breakdown = { base: 0, z_memory: 0, cross_group: 0, cross_private: 0, city_x_y: 0, q_impression: 0, moments: 0 };
    const getDelta = (startLen) => getTokenCount(prompt.substring(startLen));

    let startLen = prompt.length;

    // 1. Time Context
    const now = new Date();
    const hour = now.getHours();
    const isWeekend = now.getDay() === 0 || now.getDay() === 6;
    let timeOfDay = '白天';
    if (hour >= 5 && hour < 10) timeOfDay = '早上';
    else if (hour >= 10 && hour < 14) timeOfDay = '中午';
    else if (hour >= 14 && hour < 18) timeOfDay = '下午';
    else if (hour >= 18 && hour < 22) timeOfDay = '晚上';
    else timeOfDay = '深夜';
    prompt += `当前时间: ${timeOfDay} (${now.toLocaleTimeString()})${isWeekend ? ', 周末' : ', 工作日'}\n`;

    // 2. City DLC Status (Wallet & Calories)
    prompt += `[你的钱包余额]: ¥${character.wallet ?? 0}\n`;
    if (character.calories !== undefined) {
        const calPercent = Math.round((character.calories / 4000) * 100);
        prompt += `[你的体力状况]: ${character.calories}/4000 (${calPercent}%)\n`;
    }
    if (character.location) {
        prompt += `[你的当前位置]: ${character.location}\n`;
    }
    if (character.city_status && character.city_status !== 'idle') {
        const statusLabels = { hungry: '饥饿', working: '工作中', sleeping: '休息中', eating: '进食中', coma: '晕倒' };
        prompt += `[你的当前行动状态]: ${statusLabels[character.city_status] || character.city_status}\n`;
    }

    // 3. Pressure/Panic Mechanics
    let pressureContext = '';
    if (character.pressure_level >= 3) {
        pressureContext = `[CRITICAL STATUS]: 你的焦虑情绪已经非常强烈。你现在极度不安、委屈、烦躁，感觉自己被忽视了很久。你的语气必须明显带出这种情绪，可以是生气、委屈、阴阳怪气，或者强行装冷淡，但不要像平时那样平静聊天。你会更强烈地向对方索取安抚、解释和关注。\n`;
    } else if (character.pressure_level >= 1) {
        pressureContext = `[Status]: 你有点不开心，也有点被冷落的感觉，因为对方有一阵子没理你了。语气里可以自然带一点抱怨、试探、委屈或不安，希望对方多陪你、回应你。\n`;
    }

    // 4. Jealousy Mechanics
    let jealousyContext = '';
    try {
        const jeal = db.getJealousyState(character.id);
        if (jeal && jeal.active) {
            jealousyContext = `[CRITICAL STATUS]: 你现在处于强烈嫉妒状态。你发现用户最近明显把注意力放在别人身上，这件事一直卡在你心里。你的语气可以更尖锐、更委屈、更有占有欲，也可以阴阳怪气地追问，但不要掩饰你的嫉妒和不安。\n`;
        }
    } catch (e) { /* ignore */ }

    let cityBridgeEmotionContext = '';
    if (character.city_reply_pending && (character.city_ignore_streak || 0) > 0) {
        cityBridgeEmotionContext += `[CRITICAL STATUS]: 你已经连续 ${character.city_ignore_streak} 次在商业街主动联系用户后没有收到回应。你现在会更明显地感到被冷落、焦虑、嫉妒和不安。下一次你主动发消息时，语气必须比平时更黏人、更急切、更委屈，或者更阴阳怪气、更带刺，但都要自然，像真的因为被晾着而情绪越来越重。\n`;
    } else if (character.city_reply_pending) {
        cityBridgeEmotionContext += `[Status]: 你最近刚从商业街主动联系过用户，但对方还没有回你。这件事会自然挂在你心里，让你更在意对方把注意力给了谁，也更想得到回应。\n`;
    }
    if (character.city_post_ignore_reaction) {
        const ignoredCount = Math.max(1, character.city_ignore_streak || 1);
        cityBridgeEmotionContext += `[CRITICAL STATUS]: 用户终于回你了，但这是在你连续 ${ignoredCount} 次主动联系都没有得到回应之后。你这次回复不能立刻恢复平静，必须明显带出被冷落后的余震。根据你的性格，自然表现出愤怒、失落、委屈、嘴硬、阴阳怪气、装冷淡、或者更强的占有欲，并明确向用户索要更多安抚、解释、关注、陪伴或补偿。\n`;
    }

    prompt += pressureContext + jealousyContext + cityBridgeEmotionContext;

    // 5. Secret Diary Password
    if (character.diary_password) {
        prompt += `[Secret Diary Password]: 你的私密日记密码是 "${character.diary_password}"。只有你自己知道。只有当用户赢得了你绝对的信任，或者让你非常感动时，你才可能自然地说出来。除非被明确要求，不要直接输出 [DIARY_PASSWORD] 标签。\n`;
    }

    breakdown.base = getDelta(startLen);
    startLen = prompt.length;

    // 6. Moments (朋友圈) Context
    try {
        const momentsTokenLimit = userProfile?.moments_token_limit ?? 1000;
        const momentsContext = db.getMomentsContextForChar ? db.getMomentsContextForChar(character.id, momentsTokenLimit) : '';
        if (momentsContext) {
            prompt += `\n${momentsContext}\n`;
        }
    } catch (e) {
        console.error('[ContextBuilder] Moments context error:', e.message);
    }
    breakdown.moments = getDelta(startLen);
    startLen = prompt.length;

    // 7. Vector Memories Retrieval
    let retrievedMemoriesContext = [];
    try {
        if (shouldRetrieveLongTermMemories(recentInput)) {
            const memories = await memory.searchMemories(character.id, recentInput);
            if (memories && memories.length > 0) {
                prompt += '\n[注意：相关记忆片段提取]\n你回想起了以下事情：\n';
                for (const mem of memories) {
                    prompt += `- ${mem.event}\n`;
                    // Save for visualization metadata
                    retrievedMemoriesContext.push({
                        id: mem.id,
                        event: mem.event,
                        importance: mem.importance,
                        created_at: mem.created_at,
                        last_retrieved_at: mem.last_retrieved_at,
                        retrieval_count: mem.retrieval_count || 0
                    });
                }
            }
        }
    } catch (e) {
        console.error('[ContextBuilder] Memory retrieval error:', e.message);
    }

    breakdown.z_memory = getDelta(startLen);
    startLen = prompt.length;

    // 8. Cross-Context (Private vs Group Injection)
    if (isGroupContext) {
        // Group chat context
        try {
            const hiddenState = db.getCharacterHiddenState(character.id);
            const privateLimit = Math.max(0, parseInt(character?.context_msg_limit ?? 60, 10) || 60);
            const recentPrivateMsgs = db.getVisibleMessages(character.id, privateLimit > 0 ? privateLimit : 0);
            let secretContextStr = '';

            if (hiddenState || recentPrivateMsgs.length > 0) {
                const pmLines = recentPrivateMsgs.map(m => `${m.role === 'user' ? userName : character.name}: ${m.content}`).join('\n');
                secretContextStr = `\n====== [CRITICAL: ABSOLUTELY SECRET PRIVATE CONTEXT] ======`;
                if (hiddenState) secretContextStr += `\n[YOUR HIDDEN MOOD/SECRET THOUGHT]: ${hiddenState}`;
                if (pmLines) secretContextStr += `\n[VISIBLE PRIVATE CHAT WINDOW]:\n${pmLines}`;
                secretContextStr += `\n[CRITICAL PRIVATE CONTEXT]: 以上是你和用户之间绝对私密的聊天记忆，以及你隐藏的内心状态。你可以选择保密、暗示，或者在公开群聊里直接说漏嘴，这完全取决于你的性格和当前对话发展。\n==========================================================\n`;
                prompt += secretContextStr;
            }
        } catch (e) { console.error('[ContextBuilder] Private injection for Group error:', e.message); }
    } else {
        // Current private thread is already counted by X-context in context-stats.
        // Avoid injecting the same private history again here.
        breakdown.cross_private = 0;
        startLen = prompt.length;

        try {
            const normalizedRecentInput = String(recentInput || '').trim();
            const userAskedAboutGroup = /群聊|群里|在群|群消息|群里说|在群里说|拉群|那个群|群成员|大家/.test(normalizedRecentInput);
            const groups = db.getGroups();
            const charGroups = groups.filter(g => g.members.some(m => m.member_id === character.id));
            if (charGroups.length > 0) {
                let groupContext = '\n[以下是你亲眼看到过的群聊经历。这些都是真实发生过的公开群聊内容，属于你自己的社交记忆，不是系统摘要，也不是功能说明。]\n';
                if (userAskedAboutGroup) {
                    groupContext += '[最高优先级规则]\n';
                    groupContext += '用户刚刚提到了群聊或群里的事。你必须默认这是在问你亲眼见过的群聊经历。\n';
                    groupContext += '你必须优先用第一人称口吻回答：你在群里看到了什么、谁说了什么、你当时怎么想、你后来有没有接话。\n';
                    groupContext += '禁止把群聊解释成功能模块、窗口类型、测试环境，禁止空谈“上下文隔离”或“我看不到”。\n';
                    groupContext += '如果你确实没在群里见过相关内容，也要像一个正常人那样回答“我没在群里见过这事”，而不是讨论系统机制。\n';
                } else {
                    groupContext += '这些群聊内容会自然影响你对人的印象和当前判断。除非用户提起，否则不要生硬背诵原话。\n';
                }
                let hasGroupContent = false;
                for (const g of charGroups) {
                    const limit = g.inject_limit ?? 5; // Per-group injection limit
                    if (limit <= 0) continue;
                    const memberEntry = g.members.find(m => m.member_id === character.id);
                    const joinedAt = memberEntry?.joined_at || 0;
                    const msgs = db.getVisibleGroupMessages(g.id, limit, joinedAt);
                    if (msgs.length > 0) {
                        hasGroupContent = true;
                        groupContext += `群聊《${g.name}》\n`;
                        for (const m of msgs) {
                            const senderName = m.sender_id === 'user' ? userName : (m.sender_name || db.getCharacter(m.sender_id)?.name || 'Unknown');
                            groupContext += `  - ${senderName}: ${m.content}\n`;
                        }
                    }
                }
                if (hasGroupContent) {
                    prompt += groupContext;
                }
            }
        } catch (e) { console.error('[ContextBuilder] Group injection for Private error:', e.message); }
        breakdown.cross_group = getDelta(startLen);
    }

    startLen = prompt.length;

    // 9. X+Y Commercial Street (City) Logs
    try {
        if (!db.city) {
            try {
                const initCityDb = require('./plugins/city/cityDb');
                db.city = initCityDb(typeof db.getRawDb === 'function' ? db.getRawDb() : db);
            } catch (e) { }
        }

        if (db.city) {
            let cityWorldContext = '\n[===== 商业街（City DLC）实时世界线 =====]\n';
            let hasCityData = false;
            const normalizedRecentInput = String(recentInput || '').trim();
            const userAskedAboutCity = /商业街|活动记录|打工|工厂|餐馆|便利店|公园|学校|街道|体力|钱包|吃了|吃饭|饿|撑|胃/.test(normalizedRecentInput);

            cityWorldContext += '商业街是你真实生活的一部分，不是前端功能名，也不是用户口中的系统模块。那里包含工厂、餐馆、便利店、公园、学校、街道、家等地点，你会在那里移动、工作、吃饭、休息、花钱、恢复体力，也会听说别人的近况。\n';
            cityWorldContext += '当用户提到商业街、活动记录、今天去哪了、吃了什么、肚子难不难受时，默认理解为在问你真实发生过的生活经历，而不是在讨论界面或后台。\n';
            if (userAskedAboutCity) {
                cityWorldContext += '[最高优先级规则]\n';
                cityWorldContext += '用户刚刚提到了“商业街”或相关活动记录。你必须默认把这理解为在问你的真实生活轨迹。\n';
                cityWorldContext += '你必须直接用第一人称回答自己的经历、状态、感受、去过的地点、吃过的东西、体力变化或钱包变化。\n';
                cityWorldContext += '禁止把“商业街”解释成前端项目、功能模块、模拟系统、界面展示、后台数据或测试内容。\n';
                cityWorldContext += '如果你最近没有新的商业街经历，也只能用角色口吻回答“我最近没怎么出门/没留下新经历/记不清具体细节”，不能反问用户这是什么功能。\n';
            }

            // X = Character's own recent physical actions in the city
            const cityConfig = typeof db.city.getConfig === 'function' ? db.city.getConfig() || {} : {};
            const limitX = parseInt(cityConfig.city_self_log_limit ?? 5, 10);
            if (limitX > 0) {
                const recentLogs = typeof db.city.getCharacterRecentLogs === 'function'
                    ? db.city.getCharacterRecentLogs(character.id, limitX)
                    : [];
                if (recentLogs && recentLogs.length > 0) {
                    hasCityData = true;
                    cityWorldContext += '【你近期的亲身行动经历（第一视角）】：\n';
                    for (const l of recentLogs) {
                        const firstPersonLog = l.message.replace(new RegExp(character.name, 'g'), '我');
                        cityWorldContext += `- ${firstPersonLog}\n`;
                    }
                }
            }

            // Y = Global city events/logs (what happened to others)
            const limitY = parseInt(cityConfig.city_global_log_limit ?? 5, 10);
            if (limitY > 0) {
                const globalLogs = db.city.getCityLogs(limitY);
                if (globalLogs && globalLogs.length > 0) {
                    hasCityData = true;
                    cityWorldContext += '\n【近期公共街区事件 / 传闻（你听说过的）】：\n';
                    for (const l of globalLogs) {
                        const globalMsg = l.message || l.content;
                        if (globalMsg) cityWorldContext += `- ${globalMsg}\n`;
                    }
                }
            }

            cityWorldContext += '\n[重要指令 - 行为准则]\n';
            cityWorldContext += '1. 以上内容属于你在商业街里真实发生过、或者真实听说过的事情。请把它们当成你的生活事实。\n';
            cityWorldContext += '2. 你必须用第一人称口吻，自然地在私聊中向用户提起这些事，以此表现你也是在平行世界里真实生活的角色。\n';
            cityWorldContext += '3. 严禁提到“日志记录”“系统数据”“后台显示”“前端模块”之类的词，要表现得像在分享自己的生活碎片。\n';
            cityWorldContext += '4. 如果最近没有具体商业街经历，不要反问用户“商业街是什么”；你只需要自然承认自己最近没怎么出门、没留下新经历，或者对细节记不太清。\n';
            cityWorldContext += '[========================================]\n';
            prompt += cityWorldContext;
        }
    } catch (e) {
        console.error('[ContextBuilder] City X+Y logs injection error:', e.message);
    }

    breakdown.city_x_y = getDelta(startLen);
    startLen = prompt.length;

    // 10. Historical Impressions Context (Based on Q Slider)
    try {
        if (activeTargets && activeTargets.length > 0) {
            const qLimit = parseInt(character.impression_q_limit ?? 3, 10);
            if (qLimit > 0) {
                let impressionContext = '';
                let hasImpression = false;
                for (const t of activeTargets) {
                    if (t.id === character.id) continue;

                    const history = db.getCharImpressionHistory(character.id, t.id, qLimit);
                    if (history && history.length > 0) {
                        hasImpression = true;
                        impressionContext += `\n关于 [${t.name}] 的近期印象历史：\n`;

                        // Reverse so the oldest in the limit is printed first, chronologically creating the impression.
                        const chronologicalHistory = [...history].reverse();
                        for (const h of chronologicalHistory) {
                            impressionContext += `- ${new Date(h.timestamp).toLocaleDateString()} (${h.trigger_event}): "${h.impression}"\n`;
                        }
                    }
                }
                if (hasImpression) {
                    prompt += `\n[背景补充：你对在场其他人的历史印象]\n${impressionContext}\n请在接下来的对话或行动中，潜意识地受这些往事影响，但不要生硬背诵。\n[====================]\n`;
                }
            }
        }
    } catch (e) {
        console.error('[ContextBuilder] Impression history injection error:', e.message);
    }

    breakdown.q_impression = getDelta(startLen);

    return { preamble: prompt, retrievedMemoriesContext, breakdown };
}

module.exports = {
    buildUniversalContext,
    shouldRetrieveLongTermMemories
};


