function createQuestService(deps = {}) {
    const {
        callLLM,
        recordCityLlmDebug,
        buildCityAttemptRecorder,
        buildCollapsedCityLog,
        scoreQuestProgressWithMayor
    } = deps;

    function getQuestNarrationText(richNarrations = null) {
        return [
            richNarrations?.log,
            richNarrations?.chat,
            richNarrations?.moment,
            richNarrations?.diary
        ].map((value) => String(value || '').trim()).filter(Boolean).join('\n');
    }

    function normalizeQuestIntent(richNarrations = null) {
        const raw = richNarrations?.quest_intent;
        if (!raw || typeof raw !== 'object') return null;
        const questId = Number(raw.quest_id || raw.id || 0);
        const stage = String(raw.stage || '').trim().toLowerCase();
        if (!questId || !stage) return null;
        return { questId, stage };
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

    async function handleQuestLifecycleAfterAction(db, char, district, richNarrations = null, options = {}) {
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
        const canReport = ['ready_to_report', 'reporting'].includes(String(activeClaim.status || ''))
            || Number(activeClaim.progress_count || 0) >= Math.max(1, Number(activeClaim.completion_target || quest?.completion_target || 1));
        if (reportRequested && canReport) {
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

        if (['accepted', 'in_progress'].includes(String(activeClaim.status || ''))) {
            const scoreResult = await scoreQuestProgressWithMayor(db, char, quest, activeClaim, district, richNarrations, options);
            const review = scoreResult?.review || null;
            if (!scoreResult?.success) return { bonusMoney, bonusCalories, questReview: review };
            const nextClaim = scoreResult?.nextClaim || activeClaim;
            if (nextClaim?.status === 'ready_to_report' || review?.is_completed) {
                db.city.logAction('system', 'QUEST', `📝 ${char.name} 已经凑够「${quest.title}」的任务进度，下一步可以去汇报交付。`, 0, 0, district.id);
            } else if (Number(review?.progress_delta || 0) > 0) {
                const progressAfter = Number(review?.progress_after || nextClaim?.progress_count || 0);
                const targetScore = Number(review?.target_score || quest?.completion_target || 0);
                const shortLabel = String(review?.short_label || '').trim();
                db.city.logAction(
                    'system',
                    'QUEST',
                    `🔧 ${char.name} 的本次任务推进 +${Number(review.progress_delta || 0)}${shortLabel ? `（${shortLabel}）` : ''}，当前 ${progressAfter}/${targetScore}`,
                    0,
                    0,
                    district.id
                );
            }
            return { bonusMoney, bonusCalories, questReview: review };
        }

        return { bonusMoney, bonusCalories };
    }

    return {
        normalizeQuestIntent,
        getQuestNarrationText,
        buildQuestResolutionNarrations,
        handleQuestLifecycleAfterAction
    };
}

module.exports = { createQuestService };
