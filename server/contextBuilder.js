/**
 * server/contextBuilder.js
    * 
 * Provides a unified Universal Context(Preamble) for all AI interactions.
 * This guarantees that whether the AI is replying in private chat, group chat,
 * the City DLC, or scheduled memory aggregation, it has the exact same baseline
    * awareness of the world state, its own recent actions, and related memories.
 */

const { getTokenCount } = require('./utils/tokenizer');
const { getAdaptiveTailWindowSize } = require('./utils/contextWindow');
const { getEmotionBehaviorGuidance } = require('./emotion');
const crypto = require('crypto');
const { callLLM } = require('./llm');
const { classifyCityIntentSemantic } = require('./semanticIntent');

function getCachedContextBlock(db, characterId, blockType, sourceParts, compileFn) {
    const sourceText = JSON.stringify(sourceParts || {});
    const sourceHash = crypto.createHash('sha256').update(sourceText).digest('hex');
    const cached = typeof db.getPromptBlockCache === 'function'
        ? db.getPromptBlockCache(characterId, blockType, sourceHash)
        : null;
    if (cached?.compiled_text) return cached.compiled_text;
    const compiledText = String(compileFn() || '');
    db.upsertPromptBlockCache?.({
        character_id: characterId,
        block_type: blockType,
        source_hash: sourceHash,
        compiled_text: compiledText
    });
    return compiledText;
}

function getRelationshipAnchorSourceParts(db, character, activeTargets = []) {
    if (!activeTargets || activeTargets.length === 0 || !db.getCharRelationship) return [];
    return activeTargets
        .filter(target => target && target.id !== character.id)
        .map(target => {
            const rel = db.getCharRelationship(character.id, target.id);
            return {
                id: target.id,
                name: target.name || '',
                affinity: rel?.affinity ?? 50,
                impression: String(rel?.impression || '').trim()
            };
        });
}

async function didUserAskAboutCity(db, character, recentInput = '') {
    const text = String(recentInput || '').trim();
    if (!text) return false;

    const explicitCityRegex = /(商业街|活动记录|打工|工厂|餐馆|饭店|便利店|公园|学校|街道|今天去哪了|去哪了|出门|上班|下班|工作地点|逛街|最近在干嘛|刚刚在干嘛|在忙什么|为什么这么累|为什么这么忙|为什么没回|去哪吃|吃了什么|吃火锅|白粥|医院|输液|住院|看病|体力|热量|饥饿|送了|送你|礼物|收到了什么|回家了|回家|在家|回宿舍|病房|诊所|挂点滴)/;
    if (explicitCityRegex.test(text)) return true;

    const semanticResult = await classifyCityIntentSemantic(text);
    if (semanticResult.decision === 'yes') return true;
    if (semanticResult.decision === 'no') return false;

    const endpoint = character?.memory_api_endpoint || character?.api_endpoint || '';
    const key = character?.memory_api_key || character?.api_key || '';
    const model = character?.memory_model_name || character?.model_name || '';
    if (!endpoint || !key || !model) {
        return semanticResult.cityScore >= semanticResult.nonCityScore;
    }

    try {
        const judgePrompt = [
            '判断用户这句话是不是在问角色的“商业街/真实生活内容”。',
            '这里的“商业街/真实生活内容”不只包括去了哪，也包括角色最近做了什么、吃了什么、忙什么、为什么累/饿/困/没回消息、住院/输液/看病、收到或送出礼物、当前现实处境和拟人状态来源。',
            '只要用户在追问角色现实生活中的经历、行动、处境、身体状态来源、礼物流转、最近现实轨迹，回答 YES。',
            '只有当用户纯粹是在普通安抚、调情、观点讨论、抽象情绪确认、闲聊，而且不需要借助现实生活记录解释时，才回答 NO。',
            '只能输出 YES 或 NO。'
        ].join('\n');

        const { content } = await callLLM({
            endpoint,
            key,
            model,
            messages: [
                { role: 'system', content: judgePrompt },
                { role: 'user', content: text }
            ],
            maxTokens: 5,
            temperature: 0,
            enableCache: true,
            cacheDb: db,
            cacheType: 'semantic_city_intent',
            cacheTtlMs: 12 * 60 * 60 * 1000,
            cacheScope: `character:${character?.id || ''}`,
            cacheCharacterId: character?.id || '',
            cacheKeyExtra: 'v4',
            cacheKeyMode: 'exact'
        });
        return /^yes\b/i.test(String(content || '').trim());
    } catch (e) {
        console.warn('[ContextBuilder] City intent model fallback failed:', e.message);
        return semanticResult.cityScore >= semanticResult.nonCityScore;
    }
}

function parseModuleRouteJson(rawText = '') {
    const text = String(rawText || '').trim();
    if (!text) return null;

    const codeFenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = codeFenceMatch ? codeFenceMatch[1].trim() : text;

    try {
        const parsed = JSON.parse(candidate);
        return {
            city_detail: parsed?.city_detail === 1 ? 1 : 0,
            school_detail: parsed?.school_detail === 1 ? 1 : 0,
            society_detail: parsed?.society_detail === 1 ? 1 : 0
        };
    } catch (e) {
        const readBit = (key) => {
            const match = candidate.match(new RegExp(`"${key}"\\s*:\\s*([01])`, 'i'));
            return match && match[1] === '1' ? 1 : 0;
        };
        return {
            city_detail: readBit('city_detail'),
            school_detail: readBit('school_detail'),
            society_detail: readBit('society_detail')
        };
    }
}

async function routeContextModules(db, character, recentInput = '') {
    const text = String(recentInput || '').trim();
    const defaultRoutes = {
        city_detail: 0,
        school_detail: 0,
        society_detail: 0
    };

    if (!text) return defaultRoutes;

    const schoolRegex = /(学校|上课|下课|老师|同学|考试|作业|校园|宿舍|教室)/;
    const societyRegex = /(公司|老板|同事|客户|部门|项目|实习|上班|工作|开会|社会关系|职位)/;
    const cityLifeRegex = /(商业街|活动记录|最近在干嘛|刚刚在干嘛|在忙什么|去了哪|去哪了|出门|逛街|上班|下班|打工|工厂|餐馆|饭店|便利店|公园|街道|工作地点|为什么这么累|为什么这么忙|为什么没回|为什么饿|为什么困|体力|热量|饥饿|吃了什么|吃火锅|白粥|医院|输液|住院|看病|送了|送你|礼物|收到了什么|回家了|回家|在家|回宿舍|病房|诊所|挂点滴)/;

    if (schoolRegex.test(text)) defaultRoutes.school_detail = 1;
    if (societyRegex.test(text)) defaultRoutes.society_detail = 1;
    if (cityLifeRegex.test(text)) defaultRoutes.city_detail = 1;

    const cityIntent = await didUserAskAboutCity(db, character, text);
    defaultRoutes.city_detail = (defaultRoutes.city_detail === 1 || cityIntent) ? 1 : 0;

    const endpoint = character?.memory_api_endpoint || character?.api_endpoint || '';
    const key = character?.memory_api_key || character?.api_key || '';
    const model = character?.memory_model_name || character?.model_name || '';
    if (!endpoint || !key || !model) {
        return defaultRoutes;
    }

    try {
        const judgePrompt = [
            '你是私聊上下文模块路由器。',
            '任务：判断这一轮主模型是否需要加载某些“详细模块内容”。',
            '只输出一行 JSON，格式必须是：{"city_detail":0,"school_detail":0,"society_detail":0}',
            '字段说明：',
            '- city_detail=1：凡是这轮回复需要角色现实生活里的拟人内容，都开。包括最近去了哪、做了什么、吃了什么、最近外出/工作/休息轨迹、为什么这么累/忙/饿/困/没回消息、医院/输液/住院/看病、送礼/收礼、物品流转、当前现实处境、身体状态来源。',
            '- city_detail=1 的核心原则：私聊模块只负责“对话本身”；只要问题触及角色现实生活、行动记录、状态来源、现实事件，就应视为商业街内容。',
            '- 特别注意：凡是地点、去向、人在什么地方、从哪里回来的纠错，凡是吃了什么/喝了什么/收到了什么/送了什么，这些都不是“对话本身”，默认都应开 city_detail。',
            '- 即使用户是在质问、吐槽、纠错、阴阳怪气，只要话题核心还是地点、食物、现实去向、现实状态来源，仍然算商业街内容。',
            '- city_detail=0：只有在纯私聊对话就能完成回复时才关闭，例如单纯安慰、调情、情绪回应、观点建议、抽象闲聊，而且不需要现实生活记录做支撑。',
            '- school_detail：为未来学校模块预留，当前仅在用户明确问学校/课程/考试/老师/同学近况时设为1，否则0。',
            '- society_detail：为未来社会模块预留，当前仅在用户明确问工作/公司/部门/老板/社会身份近况时设为1，否则0。',
            '规则：对 city_detail 采取偏开启策略。宁可多开商业街，也不要把角色的现实生活问题错留在纯私聊里。',
            '示例：',
            '- “你吃火锅干嘛” -> city_detail=1',
            '- “医院送的白粥配咸菜吗” -> city_detail=1',
            '- “你怎么这么累/怎么不回我” -> city_detail=1',
            '- “你刚刚在干嘛” -> city_detail=1',
            '- “去医院！怎么又回家了！” -> city_detail=1',
            '- “你不是还在医院输液吗” -> city_detail=1',
            '- “你怎么又回家了” -> city_detail=1',
            '- “你不是说在医院吗” -> city_detail=1',
            '- “想我没” -> city_detail=0',
            '- “你是不是故意气我” -> city_detail=0，除非还在追问现实事件原因',
            '只能输出 JSON，不能解释。'
        ].join('\n');

        const { content } = await callLLM({
            endpoint,
            key,
            model,
            messages: [
                { role: 'system', content: judgePrompt },
                { role: 'user', content: text }
            ],
            maxTokens: 40,
            temperature: 0,
            enableCache: true,
            cacheDb: db,
            cacheType: 'context_module_router',
            cacheTtlMs: 12 * 60 * 60 * 1000,
            cacheScope: `character:${character?.id || ''}`,
            cacheCharacterId: character?.id || '',
            cacheKeyExtra: 'v4',
            cacheKeyMode: 'exact'
        });
        const parsed = parseModuleRouteJson(content);
        if (!parsed) return defaultRoutes;
        return {
            city_detail: parsed.city_detail === 1 ? 1 : defaultRoutes.city_detail,
            school_detail: parsed.school_detail === 1 ? 1 : defaultRoutes.school_detail,
            society_detail: parsed.society_detail === 1 ? 1 : defaultRoutes.society_detail
        };
    } catch (e) {
        console.warn('[ContextBuilder] Module router fallback failed:', e.message);
        return defaultRoutes;
    }
}

function buildRelationshipAnchorContext(db, character, userName, activeTargets = []) {
    if (!activeTargets || activeTargets.length === 0 || !db.getCharRelationship) return '';

    let relationContext = '\n[关系锚点与情绪对象边界]\n';
    relationContext += `你对 ${userName} 的占有欲、被忽视感、嫉妒、索求安抚、委屈和依赖，默认只指向 ${userName}，不能自动套到其他角色身上。\n`;
    relationContext += '除非当前场景里明确发生了迁怒、投射、误会或吃醋转移，否则你面对其他角色时，必须按你和该角色各自的关系历史分别反应。\n';
    relationContext += `默认情况下，如果你和 ${userName} 的关系还不够亲近（好感低、历史浅、依赖感弱），不要轻易把自己写成“占有欲式吃醋”。这时更适合表现为冷眼旁观、嘴硬、被冒犯、竞争心、轻微不爽，或者单纯不把对方当回事。\n`;
    relationContext += `但要注意：静态好感值只是慢变量，不是绝对上限。如果当前上下文已经明确显示你其实很在意 ${userName}、很依赖、很委屈、在闹矛盾、刚和好、处于虐恋/拉扯/嘴硬心软状态，那么这些“当下关系状态”优先级高于单个好感数字。低好感也可能意味着“正在闹僵、拉扯、嘴硬、伤到彼此”，而不等于“根本不在意”。\n`;
    relationContext += `只有当你和 ${userName} 的关系已经足够亲近、在意、依赖、暧昧、独占，嫉妒才应该表现成真正的“怕被抢走/怕失去关注”。\n`;
    relationContext += `当 ${userName} 的话语存在歧义、嘴硬、拐弯、暧昧、笨拙表达或纠正说明时，默认先按善意理解：他可能是在害羞、不会说、试图调情、表达笨拙，或者在纠正你的误会。不要优先往“故意伤害、耍你、否认一切、恶意试探”上套，除非上下文已经非常明确。\n`;

    let hasRelations = false;
    for (const target of activeTargets) {
        if (!target || target.id === character.id) continue;
        const rel = db.getCharRelationship(character.id, target.id);
        if (!rel) continue;
        hasRelations = true;
        const affinity = rel.affinity ?? 50;
        const impression = String(rel.impression || '').trim();
        let tone = '态度中性';
        if (affinity >= 80) tone = '明显亲近、信任、愿意主动靠近';
        else if (affinity >= 65) tone = '比较友好，有好感';
        else if (affinity <= 20) tone = '明显排斥、警惕或厌烦';
        else if (affinity <= 35) tone = '有戒备、不太喜欢';

        relationContext += `- 你对 ${target.name}：好感 ${affinity}/100，${tone}`;
        if (impression) relationContext += `，当前印象是“${impression}”`;
        relationContext += '。\n';
    }

    const userAffinity = Number(character.affinity ?? 50);
    if (userAffinity < 50) {
        relationContext += `- 你对 ${userName} 当前好感 ${userAffinity}/100：默认不足以支撑稳定、强占有欲式嫉妒。若用户去和别人互动，你更适合表现得冷淡、阴阳、轻微不爽、输赢心或不屑，而不是“被抢走了”的口吻。\n`;
        relationContext += `  但如果当前上下文已经明确表明你其实很喜欢他、很在意他、刚被伤到、正在闹矛盾或处在强拉扯关系里，那么可以表现出“嘴硬的吃醋、委屈、被刺到、虐恋式不甘”，只是要让这种强情绪看起来像复杂纠缠，而不是无条件甜宠独占。\n`;
    } else if (userAffinity < 70) {
        relationContext += `- 你对 ${userName} 当前好感 ${userAffinity}/100：可以有一点在意和比较心，但嫉妒应偏克制，别轻易写成稳定、无脑的强烈独占欲。若上下文正在拉扯、闹矛盾、求安抚、争宠，可以更明显地表现委屈、吃味和不甘。\n`;
    } else {
        relationContext += `- 你对 ${userName} 当前好感 ${userAffinity}/100：如果用户明显把注意力给了别人，你可以自然表现出更明显的吃醋、委屈或争宠。\n`;
    }

    if (!hasRelations) {
        relationContext += '你和当前在场其他角色没有足够稳定的关系锚点。请保持陌生人或普通熟人的边界，不要把你对用户的强烈情绪错投到他们身上。\n';
    }

    relationContext += '[执行规则] 对每个角色分别判断态度，不要把“我想要用户安慰我”“我嫉妒用户和别人说话”直接说成你对其他角色本人的情绪。\n';
    return relationContext;
}

function getPhysicalCondition(character) {
    const energy = Number(character.energy ?? 100);
    const sleepDebt = Number(character.sleep_debt ?? 0);
    const health = Number(character.health ?? 100);
    const satiety = Number(character.satiety ?? 45);
    const stomachLoad = Number(character.stomach_load ?? 0);
    const stress = Number(character.stress ?? 20);
    const calories = Number(character.calories ?? 2000);

    let score = 0;
    if (energy <= 10) score += 5;
    else if (energy <= 25) score += 3;
    else if (energy <= 40) score += 1;

    if (sleepDebt >= 90) score += 4;
    else if (sleepDebt >= 75) score += 3;
    else if (sleepDebt >= 55) score += 1;

    if (health <= 25) score += 4;
    else if (health <= 45) score += 2;

    if (satiety <= 15 || calories <= 400) score += 2;
    else if (satiety <= 30 || calories <= 900) score += 1;

    if (stomachLoad >= 80) score += 2;
    else if (stomachLoad >= 60) score += 1;

    if (stress >= 85) score += 2;
    else if (stress >= 65) score += 1;

    if (score >= 9) {
        return {
            level: 'critical',
            label: '崩溃边缘',
            summary: '身体接近极限，注意力、耐心和判断力明显下滑。'
        };
    }
    if (score >= 6) {
        return {
            level: 'drained',
            label: '透支',
            summary: '明显透支，脑子发钝、身体沉，交流和活动都更吃力。'
        };
    }
    if (score >= 3) {
        return {
            level: 'tired',
            label: '疲惫',
            summary: '状态偏疲惫，专注、耐心和表达流畅度下降。'
        };
    }
    return {
        level: 'stable',
        label: '稳定',
        summary: '身体整体稳定，恢复、专注和表达基本正常。'
    };
}

function compactLine(label, value) {
    if (!value) return '';
    return `[${label}]: ${value}\n`;
}

function getEnergyHint(energy) {
    if (energy < 20) return '极低，反应慢、易烦。';
    if (energy < 35) return '偏低，长聊费劲。';
    if (energy > 85) return '很高，表达更顺。';
    if (energy > 70) return '不错，开口轻松。';
    return '';
}

function getSleepDebtHint(sleepDebt) {
    if (sleepDebt > 85) return '严重欠觉，脑钝易脆。';
    if (sleepDebt > 70) return '很缺觉，耐心下降。';
    if (sleepDebt > 40) return '有些欠觉。';
    return '';
}

function getHealthHint(health) {
    if (health < 25) return '很差，行动受影响。';
    if (health < 45) return '不适，恢复下降。';
    if (health > 80) return '稳定，恢复在线。';
    return '';
}

function getSatietyHint(satiety) {
    if (satiety < 20) return '很饿，易烦急。';
    if (satiety > 80) return '很饱，暂不受饿影响。';
    return '';
}

function getStomachLoadHint(stomachLoad) {
    if (stomachLoad > 80) return '很撑，发沉犯困。';
    if (stomachLoad > 55) return '有点撑，行动发笨。';
    return '';
}

function getPressureHint(level) {
    if (level >= 3) return '焦虑强，语气更委屈或索安抚。';
    if (level >= 1) return '有被冷落感，可抱怨试探。';
    return '';
}

function buildTimeBehaviorGuidance(timeOfDay, isWeekend, character, isGroupContext) {
    const lines = [];
    lines.push('[时间行为约束]');

    if (timeOfDay === '深夜') {
        lines.push('- 深夜说话应更短、更钝、更困，不要像白天一样精力充沛。');
        lines.push('- 除非情绪或剧情强推，否则不要长篇高能输出。');
    } else if (timeOfDay === '早上') {
        lines.push('- 早上语气可带一点刚醒、未完全进入状态的感觉。');
    } else if (timeOfDay === '中午') {
        lines.push('- 中午整体更自然稳定，不必额外强调困倦。');
    } else if (timeOfDay === '下午') {
        lines.push('- 下午默认是日常交流节奏，表达比深夜更顺。');
    } else if (timeOfDay === '晚上') {
        lines.push('- 晚上可以更松、更私密，但不要默认进入极困状态。');
    }

    if (isWeekend) {
        lines.push('- 周末行程和回复节奏可更松，不必默认被工作压着。');
    } else {
        lines.push('- 工作日要默认角色仍受日常安排、精力分配和现实节奏影响。');
    }

    if ((character?.city_status || '') === 'sleeping') {
        lines.push('- 你本来在休息/补觉，被消息惊动后整个人有点迷糊，脑子转得慢，像刚从睡意里被拽出来。');
    } else if ((character?.city_status || '') === 'working') {
        lines.push('- 你本来正卡在手头的活里，被消息打断后有点分神、烦躁和紧张，像偷空回了两句。');
    }

    if (!isGroupContext) {
        lines.push('- 私聊里时间感应优先影响语气、句长、耐心和亲密表达节奏。');
    } else {
        lines.push('- 群聊里时间感应优先影响出场意愿、发言长度和参与热度。');
    }

    return `${lines.join('\n')}\n`;
}

function buildCompactEmotionImpact(emotionGuidance, isGroupContext) {
    let block = '';
    block += `[主情绪]: ${emotionGuidance.emotion.label} ${emotionGuidance.emotion.emoji}\n`;
    block += compactLine('私聊倾向', emotionGuidance.privateChat);
    if (isGroupContext) {
        block += compactLine('群聊倾向', emotionGuidance.groupChat);
    } else if (['angry', 'hurt', 'jealous', 'tense'].includes(emotionGuidance.emotion.state)) {
        block += '[强情绪边界]: 私聊回复仍要控制在 1-3 句内，不要连发或说半截。\n';
    }
    return block;
}

function buildCitySceneChatGuidance(db, character, isGroupContext) {
    if (!character?.city_status || character.city_status === 'idle') return '';

    const district = db.city?.getDistrict ? db.city.getDistrict(character.location) : null;
    const districtType = district?.type || '';
    const districtName = district?.name || character.location || '当前地点';
    const districtEmoji = district?.emoji || '';
    const locationLabel = `${districtEmoji}${districtName}`.trim();
    const workDistraction = Number(character.work_distraction || 0);
    const sleepDisruption = Number(character.sleep_disruption || 0);

    let prompt = '\n[当前生活场景]\n';

    if (character.city_status === 'working') {
        prompt += `地点=${locationLabel}；状态=工作中。你手头还有活，注意力被拆开了，回消息时带着忙里偷闲的仓促感。`;
        if (districtType === 'work' || character.location === 'factory') {
            prompt += ' 周围可能有机器声、同事、主管、搬货、赶进度的压迫感。';
        } else if (districtType === 'education') {
            prompt += ' 周围可能是课堂、笔记、老师、培训、被时间催着往前走的感觉。';
        }
        if (!isGroupContext) {
            prompt += ` 这次打断已经让你有点分心；当前分心值=${workDistraction}/100。继续聊下去会拖慢手上的活，你心里也清楚这轮工作最后可能会少赚一点。`;
        }
    } else if (character.city_status === 'sleeping') {
        prompt += `地点=${locationLabel}；状态=休息/补觉。你本来在睡或刚躺下，被消息惊动后还有点迷糊，眼皮发沉，反应慢半拍。`;
        if (!isGroupContext) {
            prompt += ` 这次打断已经影响了恢复；当前睡眠打断值=${sleepDisruption}/100。继续聊会让这次补觉更不踏实，醒来后会更累，睡眠债也会更重。`;
        }
    } else if (character.city_status === 'eating') {
        prompt += `地点=${locationLabel}；状态=在吃东西。面前的东西还没吃完，动作和注意力都被食物牵着。`;
    } else if (character.city_status === 'hungry') {
        prompt += '状态=明显饥饿。胃里空得发慌，注意力很容易被饥饿拖走。';
    } else if (character.city_status === 'coma') {
        prompt += '状态很差。意识发飘，身体发虚，很难真正集中起来。';
    }

    prompt += '\n';
    return prompt;
}

async function buildUniversalContext(context, character, recentInput = '', isGroupContext = false, activeTargets = []) {
    const { getUserDb, getMemory, userId } = context;
    const resolvedUserId = userId || character.user_id || 'default';
    const db = getUserDb(resolvedUserId);
    const memory = getMemory(resolvedUserId);

    let prompt = '';
    const userProfile = db.getUserProfile ? db.getUserProfile() : { name: 'User' };
    const userName = userProfile?.name || 'User';
    const normalizedRecentInput = String(recentInput || '').trim();
    const moduleRoutes = await routeContextModules(db, character, normalizedRecentInput);

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
    prompt += buildTimeBehaviorGuidance(timeOfDay, isWeekend, character, isGroupContext);

    const physicalCondition = getPhysicalCondition(character);
    const emotionGuidance = getEmotionBehaviorGuidance(character);
    let jealousyActive = false;
    try {
        const jeal = db.getJealousyState(character.id);
        jealousyActive = !!(jeal && jeal.active);
    } catch (e) { /* ignore */ }

    const stateContextBlock = getCachedContextBlock(
        db,
        character.id,
        isGroupContext ? 'runtime_state_group' : 'runtime_state_private',
        {
            template_version: 2,
            isGroupContext: !!isGroupContext,
            wallet: character.wallet ?? 0,
            calories: character.calories,
            location: character.location || '',
            city_status: character.city_status || '',
            work_distraction: character.work_distraction ?? 0,
            sleep_disruption: character.sleep_disruption ?? 0,
            physical_label: physicalCondition.label,
            physical_summary: physicalCondition.summary,
            energy: character.energy,
            sleep_debt: character.sleep_debt,
            mood: character.mood,
            stress: character.stress,
            social_need: character.social_need,
            health: character.health,
            satiety: character.satiety,
            stomach_load: character.stomach_load,
            emotion_state: emotionGuidance.emotion.state,
            emotion_label: emotionGuidance.emotion.label,
            emotion_emoji: emotionGuidance.emotion.emoji,
            emotion_private: emotionGuidance.privateChat,
            emotion_group: emotionGuidance.groupChat,
            pressure_level: character.pressure_level || 0,
            jealousy_active: jealousyActive,
            city_reply_pending: character.city_reply_pending || 0,
            city_ignore_streak: character.city_ignore_streak || 0,
            city_post_ignore_reaction: character.city_post_ignore_reaction || 0,
            diary_password: character.diary_password || '',
            relationship_anchors: getRelationshipAnchorSourceParts(db, character, activeTargets)
        },
        () => {
            let block = '';
            block += `[你的钱包余额]: ¥${character.wallet ?? 0}\n`;
            if (character.calories !== undefined) {
                const calPercent = Math.round((character.calories / 4000) * 100);
                block += `[你的体力状况]: ${character.calories}/4000 (${calPercent}%)\n`;
            }
            if (character.location) {
                block += `[你的当前位置]: ${character.location}\n`;
            }
            if (character.city_status && character.city_status !== 'idle') {
                const statusLabels = { hungry: '饥饿', working: '工作中', sleeping: '休息中', eating: '进食中', coma: '晕倒' };
                block += `[你的当前行动状态]: ${statusLabels[character.city_status] || character.city_status}\n`;
            }
            block += `[你的综合身体状态等级]: ${physicalCondition.label}\n`;
            block += `[综合身体状态后果]: ${physicalCondition.summary}\n`;
            block += buildCitySceneChatGuidance(db, character, isGroupContext);
            if (character.energy !== undefined) {
                block += `[你的精力]: ${character.energy}/100\n`;
                block += compactLine('精力影响', getEnergyHint(character.energy));
            }
            if (character.sleep_debt !== undefined) {
                block += `[你的睡眠债]: ${character.sleep_debt}/100\n`;
                block += compactLine('睡眠影响', getSleepDebtHint(character.sleep_debt));
            }
            if (character.mood !== undefined) block += `[你当前的整体心情]: ${character.mood}/100\n`;
            if (character.stress !== undefined) block += `[你当前的现实压力]: ${character.stress}/100\n`;
            if (character.social_need !== undefined) block += `[你当前的社交需求]: ${character.social_need}/100\n`;
            if (character.health !== undefined) {
                block += `[你的身体健康度]: ${character.health}/100\n`;
                block += compactLine('健康影响', getHealthHint(character.health));
            }
            if (character.satiety !== undefined) {
                block += `[你的饱腹感]: ${character.satiety}/100\n`;
                block += compactLine('饱腹影响', getSatietyHint(character.satiety));
            }
            if (character.stomach_load !== undefined) {
                block += `[你的胃负担]: ${character.stomach_load}/100\n`;
                block += compactLine('胃负担影响', getStomachLoadHint(character.stomach_load));
            }
            block += buildCompactEmotionImpact(emotionGuidance, isGroupContext);
            block += compactLine('压力影响', getPressureHint(character.pressure_level || 0));
            if (jealousyActive) {
                block += '[嫉妒状态]: 强烈嫉妒已激活；语气可更尖锐、委屈、试探、索要独占关注。\n';
            }
            if (character.city_reply_pending && (character.city_ignore_streak || 0) > 0) {
                block += `[商业街未回]: 连续 ${character.city_ignore_streak} 次主动联系未获回应；下次语气应更黏人、急切、委屈或带刺。\n`;
            } else if (character.city_reply_pending) {
                block += '[商业街未回]: 最近主动联系过用户但还没等到回音，会更在意对方把注意力给了谁。\n';
            }
            if (character.city_post_ignore_reaction) {
                const ignoredCount = Math.max(1, character.city_ignore_streak || 1);
                block += `[商业街余震]: 用户是在你连续 ${ignoredCount} 次被晾后才回复；这次不能立刻恢复平静，仍要带出被冷落后的余震。\n`;
            }
            if (!isGroupContext && character.city_status === 'working') {
                block += `[忙碌余压]: 这条私聊是在工作被打断的情况下回出去的。你心里清楚，聊得越久，手上的活越容易被拖慢，烦躁和紧张感也会往上拱。\n`;
            }
            if (!isGroupContext && character.city_status === 'sleeping') {
                block += `[补觉余压]: 这条私聊是在休息被打断的情况下回出去的。你还没完全清醒，越聊越会觉得这次补觉被搅散了，醒来后只会更累。\n`;
            }
            block += buildRelationshipAnchorContext(db, character, userName, activeTargets);
            if (character.diary_password) {
                block += `[Secret Diary Password]: 你的私密日记密码是 "${character.diary_password}"。只有你自己知道。只有当用户赢得了你绝对的信任，或者让你非常感动时，你才可能自然地说出来。除非被明确要求，不要直接输出 [DIARY_PASSWORD] 标签。\n`;
            }
            return block;
        }
    );
    prompt += stateContextBlock;

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
    // Main private-chat RAG should be decided by the planner model in engine.js.
    // We deliberately avoid regex/keyword-gated prefetch here so retrieval is not
    // coupled to a brittle hard-coded phrase list.
    let retrievedMemoriesContext = [];
    try {
        const memories = [];
        if (memories && memories.length > 0) {
            prompt += '\n[注意：相关记忆片段提取]\n下面是你已经回想起来的真实旧信息。只要这些记忆与用户当前问题相关，就不要再说“我不记得了”或“我想不起来了”；应优先根据这些记忆直接回答，只有在记忆彼此冲突或确实没有答案时，才允许表达不确定。\n你回想起了以下事情：\n';
            for (const mem of memories) {
                const parts = [];
                if (mem.summary || mem.event) parts.push(mem.summary || mem.event);
                if (mem.time) parts.push(`时间: ${mem.time}`);
                if (mem.source_time_text) parts.push(`来源对话时间: ${mem.source_time_text}`);
                if (mem.location) parts.push(`地点: ${mem.location}`);
                if (mem.people) parts.push(`人物: ${mem.people}`);
                if (mem.relationships) parts.push(`关系: ${mem.relationships}`);
                if (mem.emotion) parts.push(`情绪: ${mem.emotion}`);
                prompt += `- ${parts.join(' | ')}\n`;
                // Save for visualization metadata
                retrievedMemoriesContext.push({
                    id: mem.id,
                    summary: mem.summary || mem.event,
                    event: mem.event,
                    memory_type: mem.memory_type || 'event',
                    importance: mem.importance,
                    created_at: mem.created_at,
                    last_retrieved_at: mem.last_retrieved_at,
                    retrieval_count: mem.retrieval_count || 0,
                    source_started_at: mem.source_started_at || 0,
                    source_ended_at: mem.source_ended_at || 0,
                    source_time_text: mem.source_time_text || '',
                    source_message_count: mem.source_message_count || 0
                });
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
                secretContextStr = `\n====== [PRIVATE SOURCE: ABSOLUTELY SECRET PRIVATE CONTEXT] ======`;
                secretContextStr += `\n[PRIVATE SOURCE RULES]`;
                secretContextStr += `\n- 下面内容来自你和用户的私聊，只属于你与用户，不属于群聊公开记录。`;
                secretContextStr += `\n- 这些内容可以影响你在群里的情绪、立场、吃醋、偏心、试探和委屈。`;
                secretContextStr += `\n- 除非你是故意说漏嘴、暗示、阴阳怪气或主动揭私，否则不要把下面内容当成“群里刚刚有人说过的话”直接复述。`;
                secretContextStr += `\n- 不要把私聊内容误当成群消息，不要因此以为有人冒充你、重复发言或替你说话。`;
                if (hiddenState) secretContextStr += `\n[YOUR HIDDEN MOOD/SECRET THOUGHT]: ${hiddenState}`;
                if (pmLines) secretContextStr += `\n[VISIBLE PRIVATE CHAT WINDOW]:\n${pmLines}`;
                secretContextStr += `\n==========================================================\n`;
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
                let groupContext = '\n[GROUP SOURCE: 你亲眼看到过的公开群聊经历]\n';
                groupContext += '[GROUP SOURCE RULES]\n';
                groupContext += '下面内容都是真实发生过的公开群聊内容，属于你亲眼见过的社交记忆。\n';
                groupContext += '这些内容可以直接当成“群里有人说过的话”来回应。\n';
                groupContext += '不要把它们当成私聊，不要把它们解释成功能、系统、窗口或后台。\n';
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
                    const allMsgs = db.getVisibleGroupMessages(g.id, limit, joinedAt);
                    const visibleTail = getAdaptiveTailWindowSize(limit, allMsgs.length);
                    const msgs = allMsgs.slice(-visibleTail);
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
            let cityWorldContext = '\n[===== CITY SOURCE: 商业街（真实生活）实时世界线 =====]\n';
            let hasCityData = false;
            const userAskedAboutCity = moduleRoutes.city_detail === 1;
            const cityDetailEnabled = moduleRoutes.city_detail === 1;
            cityWorldContext += getCachedContextBlock(
                db,
                character.id,
                cityDetailEnabled
                    ? (userAskedAboutCity ? 'city_rules_asked' : 'city_rules_base')
                    : 'city_rules_presence_only',
                { template_version: 3, cityDetailEnabled, userAskedAboutCity },
                () => {
                    if (!cityDetailEnabled) {
                        let staticBlock = '[商业街存在性提示]\n';
                        staticBlock += '- 你有独立于私聊/群聊之外的真实生活与商业街世界线。\n';
                        staticBlock += '- 商业街会影响你的身体状态、现实处境、忙碌/疲惫/饥饿等感受。\n';
                        staticBlock += '- 私聊只负责对话本身；凡是涉及你的现实生活、行动、身体状态来源、礼物或物品流转，原则上都属于商业街内容。\n';
                        staticBlock += '- 如果用户这轮没有在问现实生活内容，不要主动展开“去了哪/做了什么”的详细日志。\n';
                        staticBlock += '- 只有当用户明确或隐含地追问最近现实经历、现实处境或拟人状态来源时，才需要加载商业街详细记录。\n';
                        return staticBlock;
                    }

                    let staticBlock = '[商业街规则]\n';
                    staticBlock += '[CITY SOURCE RULES]\n';
                    staticBlock += '- 下面内容是你的现实生活/商业街经历来源，不是群聊消息，也不是私聊消息。\n';
                    staticBlock += '- 这些内容可以影响你当前状态，也可以被你像真人一样提起。\n';
                    staticBlock += '- 不要把商业街记录误当成刚刚有人在聊天里说过的话。\n';
                    staticBlock += '- 商业街=你的真实生活，不是功能或后台。\n';
                    staticBlock += '- 私聊本身只承载对话；凡是你的拟人现实内容，默认都应从商业街世界线理解。\n';
                    staticBlock += '- 看到睡觉、工作、饥饿、疲惫、钱包变化这类信息时，把它们当成你此刻真实在经历的处境，而不是系统设定。\n';
                    staticBlock += '- 就算用户提到 token、缓存、prompt、AI、测试这些词，也不要把商业街和身体状态解释成后台机制；先按对方在乱讲话、试探你、拿奇怪说法描述现实来理解。\n';
                    staticBlock += '- 亲身经历只认【本人亲历记录】；公共事件只能说成听说/看见。\n';
                    staticBlock += '- 允许补主观感受，不允许补没给出的客观事实。\n';
                    staticBlock += '- 没有亲历记录时，只能说最近没出门、没新经历或记不清细节。\n';
                    if (userAskedAboutCity) {
                        staticBlock += '[商业街问答优先级]\n';
                        staticBlock += '- 用户此轮在问你的真实生活轨迹；优先回答去过哪、做过什么、吃了什么、体力/钱包变化。\n';
                        staticBlock += '- 没有亲历记录时，只能回答没有明确新经历，或改成听说来的公共信息。\n';
                        staticBlock += '- 禁止把商业街解释成功能、界面、后台或测试内容。\n';
                    }
                    return staticBlock;
                }
            );

            // X = Character's own recent physical actions in the city
            const cityConfig = typeof db.city.getConfig === 'function' ? db.city.getConfig() || {} : {};
            const limitX = parseInt(cityConfig.city_self_log_limit ?? 5, 10);
            const recentLogs = limitX > 0 && typeof db.city.getCharacterRecentLogs === 'function'
                ? (db.city.getCharacterRecentLogs(character.id, limitX) || [])
                : [];
            const limitY = parseInt(cityConfig.city_global_log_limit ?? 5, 10);
            const globalLogs = limitY > 0
                ? (db.city.getCityLogs(Math.max(limitY * 3, limitY)) || [])
                    .filter(l => String(l.character_id || '') !== String(character.id || ''))
                    .slice(0, limitY)
                : [];
            if (cityDetailEnabled) {
                cityWorldContext += getCachedContextBlock(
                    db,
                    character.id,
                    userAskedAboutCity ? 'city_runtime_asked' : 'city_runtime_base',
                    {
                        template_version: 3,
                        userAskedAboutCity,
                        self_logs: recentLogs.map(l => ({ timestamp: l.timestamp, message: l.message || '' })),
                        global_logs: globalLogs.map(l => ({ timestamp: l.timestamp, message: l.message || l.content || '' }))
                    },
                    () => {
                        let runtimeBlock = '';
                        if (limitX > 0) {
                            if (recentLogs.length > 0) {
                                hasCityData = true;
                                runtimeBlock += '\n【本人亲历记录】\n';
                                runtimeBlock += '只把下面这些说成“我做过/我刚经历过”。\n';
                                for (const l of recentLogs) {
                                    const firstPersonLog = l.message.replace(new RegExp(character.name, 'g'), '我');
                                    runtimeBlock += `- [${new Date(l.timestamp).toLocaleString()}] ${firstPersonLog}\n`;
                                }
                            } else {
                                runtimeBlock += '\n【本人亲历记录：空】\n';
                                runtimeBlock += '当前没有可直接引用的本人商业街行动记录。\n';
                            }
                        }
                        if (limitY > 0 && globalLogs.length > 0) {
                            hasCityData = true;
                            runtimeBlock += '\n【公共事件 / 传闻】\n';
                            runtimeBlock += '下面这些只能当成听说/看见，不能说成“我做过”。\n';
                            for (const l of globalLogs) {
                                const globalMsg = l.message || l.content;
                                if (globalMsg) runtimeBlock += `- [${new Date(l.timestamp).toLocaleString()}] ${globalMsg}\n`;
                            }
                        }
                        runtimeBlock += '\n[商业街执行规则]\n';
                        runtimeBlock += '- 优先用本人亲历记录回答“我做过什么”。\n';
                        runtimeBlock += '- 公共事件只回答“我听说/我看到”。\n';
                        runtimeBlock += '- 不要提日志、系统、后台、前端模块。\n';
                        return runtimeBlock;
                    }
                );
            }
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

    return { preamble: prompt, retrievedMemoriesContext, breakdown, moduleRoutes };
}

module.exports = {
    buildUniversalContext,
};


