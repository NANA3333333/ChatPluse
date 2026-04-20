function createMayorRuntimeService(deps = {}) {
    const {
        callLLM,
        recordCityLlmDebug,
        resolveMayorAiCharacter,
        parseMayorJsonReply,
        applyMayorDecisions,
        publishQuestAnnouncement,
        recordMayorAnnouncement
    } = deps;

    const mayorRunLocks = new Set();

    function buildMayorContext(db) {
        const items = db.city.getItems();
        const districts = db.city.getEnabledDistricts();
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

    function markMayorRun(db, timestamp = Date.now()) {
        try {
            db.city.setConfig('mayor_last_run_at', String(timestamp));
        } catch (e) {
            console.warn('[Mayor AI] Failed to persist last run time:', e.message);
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

            db.city.expireEvents();

            const aiChar = resolveMayorAiCharacter(db);
            if (!aiChar || !aiChar.api_endpoint || !aiChar.api_key) {
                console.log('[Mayor AI] 没有可用的 API 配置，跳过。');
                const result = { success: false, reason: 'no_api_config', canRetry: true };
                markMayorRun(db, finishedAt);
                return result;
            }
            console.log(`[Mayor AI] 使用 ${aiChar.name} 的模型 (${aiChar.model_name})`);

            const fullPrompt = `${mayorPrompt}\n\n${buildMayorContext(db)}`;

            console.log('[Mayor AI] 🏛️ 市长正在做决策...');
            const messages = [{ role: 'user', content: fullPrompt }];
            recordCityLlmDebug(db, aiChar, 'input', 'city_mayor_decision', messages, { model: aiChar.model_name });
            const reply = await callLLM({
                endpoint: aiChar.api_endpoint,
                key: aiChar.api_key,
                model: aiChar.model_name,
                messages,
                maxTokens: 3000,
                temperature: 0.9
            });
            recordCityLlmDebug(db, aiChar, 'output', 'city_mayor_decision', reply, { model: aiChar.model_name });

            let decision;
            try {
                decision = parseMayorJsonReply(reply, '市长 AI 返回内容不是合法 JSON。');
            } catch (_err) {
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

            const result = await applyMayorDecisions(db, decision, aiChar);
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

    function applyFallbackMayorDecisions(db) {
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
            { title: '写今日运势', emoji: '🔮', desc: '给城里的每位居民写一句今日运势', gold: 35, diff: 'easy' }
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

    return {
        buildMayorContext,
        markMayorRun,
        shouldAutoRunMayor,
        maybeRunMayorAI,
        runMayorAI,
        applyFallbackMayorDecisions
    };
}

module.exports = { createMayorRuntimeService };
