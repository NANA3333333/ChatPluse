const {
    MAX_CITY_CALORIES_GRANT,
    normalizeCityEventPayload,
    normalizeCityQuestPayload,
    normalizeCityRowId
} = require('../utils/inputGuards');

function registerEventQuestRoutes(app, deps) {
    const {
        authMiddleware,
        ensureCityDb,
        scoreQuestDifficultyWithMayor,
        publishQuestAnnouncement,
        scoreQuestProgressWithMayor,
        buildQuestResolutionNarrations,
        broadcastCityEvent,
        getEngine,
        getWsClients
    } = deps;

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
            if (!req.body?.title) return res.status(400).json({ error: '缺少 title' });
            const payload = normalizeCityEventPayload(req.body || {});
            if (!payload) return res.status(400).json({ error: '城市事件数值无效' });
            req.db.city.createEvent(payload);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/city/events/:id', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const eventId = normalizeCityRowId(req.params.id);
            if (!eventId) return res.status(400).json({ error: '无效的事件 ID' });
            const deleted = req.db.city.deleteEvent(eventId);
            if (!deleted) return res.status(404).json({ error: '事件不存在' });
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
        (async () => {
            ensureCityDb(req.db);
            if (!req.body?.title) return res.status(400).json({ error: '缺少 title' });
            const baseQuest = normalizeCityQuestPayload(req.body || {});
            if (!baseQuest) return res.status(400).json({ error: '任务奖励或目标数值无效' });
            const scoredQuest = await scoreQuestDifficultyWithMayor(req.db, baseQuest);
            if (!scoredQuest?.success) {
                return res.status(500).json({
                    error: scoredQuest?.error || scoredQuest?.reason || '市长难度评分失败，请重试。',
                    canRetry: true
                });
            }
            const questPayload = normalizeCityQuestPayload({
                ...baseQuest,
                completion_target: scoredQuest.targetScore,
                difficulty_reason: scoredQuest.reason
            });
            if (!questPayload) return res.status(400).json({ error: '任务奖励或目标数值无效' });
            const questId = req.db.city.createQuest(questPayload);
            publishQuestAnnouncement(req.db, questId, questPayload);
            res.json({ success: true, questId });
        })().catch((e) => res.status(500).json({ error: e.message }));
    });

    app.post('/api/city/logs/:id/retry-quest-score', authMiddleware, (req, res) => {
        (async () => {
            ensureCityDb(req.db);
            const logId = normalizeCityRowId(req.params.id);
            if (!logId) return res.status(400).json({ error: '缺少有效日志 ID' });
            const review = req.db.city.getQuestProgressReviewByLogId?.(logId);
            if (!review) return res.status(404).json({ error: '这条行动还没有任务评分记录' });
            if (String(review.status || '') !== 'error') {
                return res.status(400).json({ error: '只有评分失败的行动才需要重试' });
            }
            const rawDb = req.db.city.db;
            const log = rawDb.prepare('SELECT * FROM city_logs WHERE id = ?').get(logId);
            if (!log) return res.status(404).json({ error: '行动日志不存在' });
            const char = req.db.getCharacter(review.character_id);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            const quest = req.db.city.getQuestById?.(review.quest_id);
            if (!quest) return res.status(404).json({ error: '任务不存在' });
            const claim = review.claim_id
                ? rawDb.prepare('SELECT * FROM city_quest_claims WHERE id = ?').get(review.claim_id)
                : rawDb.prepare('SELECT * FROM city_quest_claims WHERE quest_id = ? AND character_id = ?').get(review.quest_id, review.character_id);
            if (!claim) return res.status(404).json({ error: '任务领取记录不存在' });
            const district = req.db.city.getDistrict(log.location)
                || req.db.city.getEnabledDistricts().find((item) => String(item.id || '').toLowerCase() === String(log.location || '').toLowerCase())
                || { id: String(log.location || 'street'), name: String(log.location || '街区'), emoji: '📍' };
            const scoreResult = await scoreQuestProgressWithMayor(
                req.db,
                char,
                quest,
                claim,
                district,
                { log: log.content },
                { actionLogId: logId, actionContent: log.content }
            );
            if (!scoreResult?.success) {
                return res.status(500).json({
                    error: scoreResult?.review?.error_message || '市长评分重试失败',
                    review: scoreResult?.review || null,
                    canRetry: true
                });
            }
            res.json({ success: true, review: scoreResult.review });
        })().catch((e) => res.status(500).json({ error: e.message, canRetry: true }));
    });

    app.post('/api/city/quests/:id/claim', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const questId = normalizeCityRowId(req.params.id);
            if (!questId) return res.status(400).json({ error: '无效的任务 ID' });
            const charId = String(req.body?.characterId || '').trim();
            if (!charId) return res.status(400).json({ error: '缺少 characterId' });
            const quest = req.db.city.getQuestById?.(questId);
            if (!quest) return res.status(404).json({ error: '任务不存在' });
            const char = req.db.getCharacter(charId);
            if (!char) return res.status(404).json({ error: '角色不存在' });
            if (quest.is_completed) return res.status(400).json({ error: '任务已完成' });
            const claimResult = req.db.city.claimQuest(questId, charId);
            if (!claimResult?.success) {
                const reasonMap = {
                    quest_unavailable: '任务已失效或已完成，不能再领取'
                };
                return res.status(400).json({ error: reasonMap[claimResult?.reason] || '任务领取失败' });
            }
            req.db.city.logAction('system', 'QUEST', `📌 ${char.name} 领取了悬赏任务「${quest.title}」`, 0, 0);
            if (typeof req.db.city.addCityAnnouncement === 'function') {
                req.db.city.addCityAnnouncement('system', '任务状态', `${char.name} 已领取悬赏任务「${quest.title}」`, 'street');
            }
            broadcastCityEvent(req.user.id, char.id, 'QUEST_CLAIMED', `📌 ${char.name} 领取了「${quest.title}」`);

            const targetDistrict = req.db.city.getDistrict(quest.target_district)
                || req.db.city.getDistrict('street')
                || req.db.city.getEnabledDistricts().find((item) => String(item.id || '').toLowerCase() === String(quest.target_district || '').toLowerCase())
                || req.db.city.getEnabledDistricts()[0]
                || null;

            let actionResult = null;
            let actionError = '';
            const engine = req.engine || getEngine(req.user.id);
            const wsClients = getWsClients(req.user.id);
            if (engine && typeof engine.triggerImmediateUserReply === 'function') {
                const districtLabel = targetDistrict
                    ? `${targetDistrict.emoji || ''}${targetDistrict.name || targetDistrict.id || quest.target_district || '商业街'}`
                    : (quest.target_district || '商业街');
                const rewardText = `${Number(quest.reward_gold || 0)}金币${Number(quest.reward_cal || 0) > 0 ? ` + ${Number(quest.reward_cal || 0)}体力` : ''}`;
                const directiveLines = [
                    '[系统任务派发提醒]',
                    '这是一条系统事件，不是 Nana 在聊天框里发来的普通用户消息。',
                    `用户刚刚手动把一个公告任务分派给你，任务已经登记到你名下。`,
                    `任务：${quest.emoji || '📜'} ${quest.title}`,
                    `地点：${districtLabel}`,
                    quest.description ? `任务内容：${quest.description}` : '',
                    `奖励：${rewardText}`,
                    '本轮只回应这个任务派发事件；不要继续、复述或改写你前面已经说过的私聊内容。',
                    '请你先像正常私聊一样，给用户发一条自然回应，表示你已经知道这件事。',
                    '如果你决定立刻去做，就像平时私聊触发商业街那样，在回复里自然附带 [CITY_ACTION: {...}] 或 [CITY_INTENT: ...]，让系统继续走你领取公告后的正常链路。',
                    '不要把标签、系统提示、流程说明直接说给用户听。'
                ].filter(Boolean);
                actionResult = { queued: true };
                engine.triggerImmediateUserReply(char.id, wsClients, {
                        extraSystemDirective: directiveLines.join('\n'),
                        extraDirectiveRole: 'system',
                        eventUserDirective: `Nana 通过任务面板指派你去做「${quest.title}」。请把这当成 Nana 刚刚给你的新请求来回应：只回答你是否知道/是否接下这个任务；不要续写、复述或改写你上一轮已经说过的私聊内容。`,
                        triggerSource: 'city_manual_quest_assignment',
                        triggerRoute: 'POST /api/city/quests/:questId/claim',
                        triggerNote: `quest_${quest.id}_manual_assignment`
                }).catch((err) => {
                    const message = err?.message || 'manual_assignment_reply_failed';
                    console.warn(`[City/QuestClaim] manual assignment reply failed for ${char.name}: ${message}`);
                    try {
                        req.db.city.logAction(
                            'system',
                            'QUEST',
                            `⚠️ ${char.name} 已领取「${quest.title}」，但任务私聊派发失败：${message}`,
                            0,
                            0,
                            targetDistrict?.id || quest.target_district || 'street'
                        );
                    } catch (logErr) {
                        console.warn(`[City/QuestClaim] failed to log manual assignment error: ${logErr.message}`);
                    }
                    });
            }

            res.json({
                success: true,
                actionTriggered: !!actionResult?.triggered,
                actionResult,
                actionError
            });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.post('/api/city/quests/:id/complete', authMiddleware, async (req, res) => {
        try {
            ensureCityDb(req.db);
            const questId = normalizeCityRowId(req.params.id);
            if (!questId) return res.status(400).json({ error: '无效的任务 ID' });
            const charId = String(req.body?.characterId || '').trim();
            if (!charId) return res.status(400).json({ error: '缺少 characterId' });
            const quest = req.db.city.getQuestById?.(questId);
            if (!quest) return res.status(404).json({ error: '任务不存在' });
            const claimant = req.db.getCharacter(charId);
            if (!claimant) return res.status(404).json({ error: '角色不存在' });
            const questDistrict = req.db.city.getDistrict(quest.target_district) || { id: quest.target_district || 'street', name: quest.target_district || 'street', emoji: '' };
            const expectedOutcome = quest.is_completed || String(quest.status || '') === 'completed' ? 'failed' : 'success';
            const resolution = await buildQuestResolutionNarrations(claimant, quest, questDistrict, req.db, expectedOutcome);
            const completion = req.db.city.resolveQuestCompletion(questId, charId);
            if (!completion?.success) return res.status(400).json({ error: '任务完成失败' });

            if (completion.won) {
                const rewardGold = Number(completion.reward_gold || 0);
                const rewardCal = Number(completion.reward_cal || 0);
                const wallet = +(Number(claimant.wallet || 0) + rewardGold).toFixed(2);
                const calories = Math.min(MAX_CITY_CALORIES_GRANT, Math.max(0, Number(claimant.calories || 0) + rewardCal));
                req.db.updateCharacter(claimant.id, { wallet, calories });
                req.db.city.logAction(claimant.id, 'QUEST', resolution.log, 0, 0, quest.target_district || 'street');
                req.db.city.logAction('system', 'QUEST', resolution.systemLog, 0, 0, quest.target_district || 'street');
                if (quest.source_announcement_id) req.db.city.deleteCityAnnouncement?.(quest.source_announcement_id);
                req.db.city.addCityAnnouncement?.('system', '任务完成', resolution.announcement, 'street');
                res.json({ success: true, won: true });
                return;
            }

            req.db.city.logAction(claimant.id, 'QUEST', resolution.log, 0, 0, quest.target_district || 'street');
            req.db.city.logAction('system', 'QUEST', resolution.systemLog, 0, 0, quest.target_district || 'street');
            req.db.city.addCityAnnouncement?.('system', '任务失效', resolution.announcement, 'street');
            res.json({ success: true, won: false, reason: completion.reason || 'already_completed' });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.delete('/api/city/quests/:id', authMiddleware, (req, res) => {
        try {
            ensureCityDb(req.db);
            const questId = normalizeCityRowId(req.params.id);
            if (!questId) return res.status(400).json({ error: '无效的任务 ID' });
            const quest = req.db.city.getQuestById?.(questId);
            if (!quest) return res.status(404).json({ error: '任务不存在' });
            if (quest?.source_announcement_id) req.db.city.deleteCityAnnouncement?.(quest.source_announcement_id);
            const deleted = req.db.city.deleteQuest(questId);
            if (!deleted) return res.status(404).json({ error: '任务不存在' });
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: e.message }); }
    });
}

module.exports = { registerEventQuestRoutes };
