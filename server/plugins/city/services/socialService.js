function createSocialService(deps = {}) {
    const {
        buildUniversalContext,
        callLLM,
        recordCityLlmDebug,
        buildQuestCompetitionContext,
        buildCollapsedCityLog,
        logEmotionTransition,
        applyEmotionEvent,
        broadcastCityEvent,
        broadcastCityToChat,
        getEngineContextWrapper
    } = deps;

    const socialCooldowns = new Map();

    async function checkSocialCollisions(characters, db, userId, districts, config, minuteKey) {
        const freshChars = characters.map(c => db.getCharacter(c.id) || c)
            .filter(c => c.location && c.location !== 'home' && c.city_status !== 'coma' && c.sys_city_social !== 0);

        const locationGroups = {};
        for (const c of freshChars) {
            const loc = c.location;
            if (!locationGroups[loc]) locationGroups[loc] = [];
            locationGroups[loc].push(c);
        }

        const yLimit = parseInt(config.city_social_log_limit || '3', 10);

        for (const [locId, group] of Object.entries(locationGroups)) {
            if (group.length < 2) continue;

            const shuffled = group.sort(() => Math.random() - 0.5);
            const occupants = shuffled.slice(0, 4);
            const ids = occupants.map(o => o.id).sort();
            const encounterKey = ids.join('::');

            const lastTime = socialCooldowns.get(encounterKey) || 0;
            const cooldownMs = 3 * 15 * 60 * 1000;
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

        const systemApiChar = occupants.find(c => c.api_endpoint && c.api_key && c.model_name);
        if (!systemApiChar) {
            console.log('[City/Social] ⚠️ 遭遇中没有任何角色配置 API，无法生成互动。');
            return;
        }

        let simulationLogs = [];
        const engineContextWrapper = getEngineContextWrapper();
        const questCompetitionContext = buildQuestCompetitionContext(db, occupants, district);

        for (let i = 0; i < occupants.length; i++) {
            const speaker = occupants[i];

            if (!speaker.api_endpoint || !speaker.api_key || !speaker.model_name) {
                simulationLogs.push(`[${speaker.name} 保持沉默，只是在旁边看着]`);
                continue;
            }

            const activeTargets = occupants.filter(c => c.id !== speaker.id);
            const uniCtx = await buildUniversalContext(engineContextWrapper, speaker, '', false, activeTargets);
            const persona = (speaker.persona || speaker.system_prompt || '普通人').substring(0, 150);

            let logsContext = '';
            for (const t of activeTargets) {
                const rel = db.getCharRelationship(speaker.id, t.id);
                if (rel) {
                    const logs = db.city.getOtherCharacterLocationTodayLogs(t.id, district.id, Math.min(yLimit, 2));
                    if (logs && logs.length > 0) {
                        logsContext += `\n[系统提示: ${t.name} 最近曾在这里做过]\n${logs.map(l => `- ${l.message}`).join('\n')}`;
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
                    endpoint: speaker.api_endpoint,
                    key: speaker.api_key,
                    model: speaker.model_name,
                    messages,
                    maxTokens: 3000,
                    temperature: 0.85
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

        const userProfile = typeof db.getUserProfile === 'function' ? db.getUserProfile() : null;
        const userName = userProfile?.name || 'User';

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
                endpoint: systemApiChar.api_endpoint,
                key: systemApiChar.api_key,
                model: systemApiChar.model_name,
                messages,
                maxTokens: 4000,
                temperature: 0.7
            });
            recordCityLlmDebug(db, systemApiChar, 'output', 'city_social_resolution', reply, { model: systemApiChar.model_name });
            const match = reply.match(/\{[\s\S]*\}/);
            if (match) {
                clean = match[0];
                try {
                    systemResult = JSON.parse(clean);
                } catch (_pe) {
                    clean = clean.replace(/,\s*([\]}])/g, '$1')
                        .replace(/\/\/.*$/gm, '')
                        .replace(/(?<!\\)\n/g, '\\n')
                        .replace(/\\n\s*}/, '\n}')
                        .replace(/{\s*\\n/, '{\n');
                    systemResult = JSON.parse(clean);
                }
            } else {
                console.error('[City/Social] System Final Parser 失败: 没有找到大括号匹配项. RAW:', reply.substring(0, 200));
            }
        } catch (e) {
            console.error('[City/Social] System Final Parser 失败:', e.message);
            console.error('[City/Social] 尝试解析的文本:\n', clean ? clean.substring(0, 1500) : '未提取到 JSON');
        }

        if (!systemResult || !systemResult.characters) {
            console.warn('[City/Social] 采用规则系统 fallback 结算遭遇');
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

        const summaryMsg = systemResult.summary_log || `${occupants.map(c => c.name).join('、')} 的遭遇结束了。`;
        const fullLog = `🤝 ${summaryMsg}\n\n📝 [现场侧录]\n${simulationLogs.join('\n')}`;
        db.city.logAction(occupants[0].id, district.id.toUpperCase(), fullLog, 0, 0, district.id);

        for (const c of occupants) {
            const data = systemResult.characters[c.id] || systemResult.characters[c.name];
            if (!data) continue;

            const safeDeltas = data.affinity_deltas || {};
            const safeImpressions = data.impressions || {};
            let netAffinityStr = '';

            for (const other of occupants) {
                if (c.id === other.id) continue;

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
                    `角色在商业街 ${district.id} 与他人发生社交互动后，情绪状态发生变化。`
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

    return {
        checkSocialCollisions,
        runSocialEncounter
    };
}

module.exports = { createSocialService };
