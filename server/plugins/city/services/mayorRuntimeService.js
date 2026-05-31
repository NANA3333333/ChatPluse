const { normalizeCityConfigValue } = require('../utils/inputGuards');

function hasMayorConfigValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}

function normalizeMayorIntervalHours(value) {
    if (!hasMayorConfigValue(value)) return 6;
    const normalized = normalizeCityConfigValue('mayor_interval_hours', value);
    return normalized === null ? null : Number(normalized);
}

function normalizeMayorLastRunAt(value) {
    if (!hasMayorConfigValue(value)) return 0;
    const normalized = normalizeCityConfigValue('mayor_last_run_at', value);
    return normalized === null ? null : Number(normalized);
}

function createMayorRuntimeService(deps = {}) {
    const {
        callLLM,
        recordCityLlmDebug,
        resolveMayorAiCharacter,
        parseMayorJsonReply,
        applyMayorDecisions
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
        const intervalHours = normalizeMayorIntervalHours(config.mayor_interval_hours);
        const lastRunAt = normalizeMayorLastRunAt(config.mayor_last_run_at);
        if (intervalHours === null || lastRunAt === null) return false;
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

    return {
        buildMayorContext,
        markMayorRun,
        shouldAutoRunMayor,
        maybeRunMayorAI,
        runMayorAI
    };
}

module.exports = { createMayorRuntimeService };
