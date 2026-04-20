function createMayorService(deps = {}) {
    const {
        callLLM,
        recordCityLlmDebug,
        publishQuestAnnouncement,
        recordMayorAnnouncement
    } = deps;

    function resolveMayorAiCharacter(db) {
        const config = db.city.getConfig();
        const chars = db.getCharacters();
        let aiChar = null;
        if (config.mayor_model_char_id === '__custom__') {
            aiChar = {
                id: 'city-mayor-custom',
                name: '自定义 API',
                api_endpoint: config.mayor_custom_endpoint,
                api_key: config.mayor_custom_key,
                model_name: config.mayor_custom_model,
                llm_debug_capture: 0
            };
        } else if (config.mayor_model_char_id) {
            aiChar = chars.find(c => String(c.id) === String(config.mayor_model_char_id) && c.api_endpoint && c.api_key);
        }
        if (!aiChar || !aiChar.api_endpoint || !aiChar.api_key) {
            aiChar = chars.find(c => c.api_endpoint && c.api_key && c.model_name) || null;
        }
        return aiChar;
    }

    function parseMayorJsonReply(replyText, errorLabel = '市长 AI 返回内容不是合法 JSON。') {
        const text = String(replyText || '').trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error(errorLabel);
        }
        return JSON.parse(jsonMatch[0]);
    }

    function getQuestDifficultyFallbackTarget(questLike = {}) {
        const explicit = Number(questLike.completion_target || 0);
        if (explicit > 0) return Math.max(1, Math.min(10, explicit));
        const difficulty = String(questLike.difficulty || 'normal').toLowerCase();
        if (difficulty === 'easy') return 4;
        if (difficulty === 'hard') return 8;
        return 6;
    }

    async function scoreQuestDifficultyWithMayor(db, questDraft = {}, aiChar = null) {
        const fallbackTarget = getQuestDifficultyFallbackTarget(questDraft);
        const resolvedAiChar = aiChar || resolveMayorAiCharacter(db);
        if (!resolvedAiChar?.api_endpoint || !resolvedAiChar?.api_key || !resolvedAiChar?.model_name) {
            return {
                success: false,
                fallback: true,
                targetScore: fallbackTarget,
                reason: '未找到可用的市长模型，已按任务难度做默认映射。'
            };
        }
        const prompt = [
            '你是城市任务难度裁判。',
            '你只负责判断这条公告任务整体需要累计多少推进分才能算完成。',
            '请只输出 JSON，不要输出任何解释。',
            '',
            '[任务信息]',
            `标题：${String(questDraft.title || '').trim()}`,
            `描述：${String(questDraft.description || '').trim()}`,
            `任务类型：${String(questDraft.quest_type || '').trim() || 'errand'}`,
            `目标地点：${String(questDraft.target_district || '').trim() || 'street'}`,
            `文本难度：${String(questDraft.difficulty || '').trim() || 'normal'}`,
            '',
            '输出格式：',
            '{"target_score": 1-10之间的整数, "reason": "一句简短中文说明"}'
        ].join('\n');
        const messages = [{ role: 'user', content: prompt }];
        recordCityLlmDebug(db, resolvedAiChar, 'input', 'city_quest_difficulty_score', messages, { model: resolvedAiChar.model_name });
        try {
            const reply = await callLLM({
                endpoint: resolvedAiChar.api_endpoint,
                key: resolvedAiChar.api_key,
                model: resolvedAiChar.model_name,
                messages,
                maxTokens: 3000,
                temperature: 0.2
            });
            recordCityLlmDebug(db, resolvedAiChar, 'output', 'city_quest_difficulty_score', reply, { model: resolvedAiChar.model_name });
            const parsed = parseMayorJsonReply(reply, '市长 AI 难度评分返回内容不是合法 JSON。');
            const targetScore = Math.max(1, Math.min(10, parseInt(parsed?.target_score, 10) || fallbackTarget));
            return {
                success: true,
                targetScore,
                reason: String(parsed?.reason || '').trim() || '市长 AI 已根据任务复杂度给出目标进度。'
            };
        } catch (err) {
            console.warn('[Mayor AI] Quest difficulty score failed:', err.message);
            return {
                success: false,
                fallback: true,
                targetScore: fallbackTarget,
                reason: `市长 AI 难度评分失败，已按默认难度映射。(${String(err?.message || 'unknown_error').slice(0, 120)})`
            };
        }
    }

    async function scoreQuestProgressWithMayor(db, char, quest, claim, district, richNarrations = null, options = {}) {
        const actionLogId = Number(options.actionLogId || 0);
        if (!actionLogId) {
            return { success: false, skipped: true, reason: 'missing_log_id' };
        }
        const existingReview = db.city.getQuestProgressReviewByLogId?.(actionLogId);
        if (existingReview && String(existingReview.status || '') === 'success') {
            return {
                success: true,
                review: existingReview,
                progressDelta: 0,
                nextClaim: claim,
                targetScore: Number(existingReview.target_score || quest?.completion_target || 0),
                isCompleted: Number(existingReview.is_completed || 0) === 1,
                skipped: true,
                reason: 'already_scored'
            };
        }
        const targetScore = Math.max(1, Number(quest?.completion_target || getQuestDifficultyFallbackTarget(quest)));
        const currentProgress = Math.max(0, Number(claim?.progress_count || 0));
        const actionText = String(options.actionContent || [
            richNarrations?.log,
            richNarrations?.chat,
            richNarrations?.moment,
            richNarrations?.diary
        ].map((value) => String(value || '').trim()).filter(Boolean).join('\n') || '').trim();
        if (!actionText) {
            const review = db.city.upsertQuestProgressReview?.({
                quest_id: quest.id,
                claim_id: claim.id,
                log_id: actionLogId,
                character_id: char.id,
                status: 'error',
                progress_delta: 0,
                progress_after: currentProgress,
                target_score: targetScore,
                is_completed: 0,
                error_message: '任务评分失败：当前行动文本为空，请重试市长评分。'
            });
            return { success: false, review, error: 'empty_action_text', canRetry: true };
        }
        const resolvedAiChar = resolveMayorAiCharacter(db);
        if (!resolvedAiChar?.api_endpoint || !resolvedAiChar?.api_key || !resolvedAiChar?.model_name) {
            const review = db.city.upsertQuestProgressReview?.({
                quest_id: quest.id,
                claim_id: claim.id,
                log_id: actionLogId,
                character_id: char.id,
                status: 'error',
                progress_delta: 0,
                progress_after: currentProgress,
                target_score: targetScore,
                is_completed: 0,
                error_message: '任务评分失败：没有可用的市长模型，请稍后重试评分。'
            });
            return { success: false, review, error: 'mayor_model_unavailable', canRetry: true };
        }

        const prompt = [
            '你是城市公告任务的推进裁判。',
            '你只负责判断“这一次角色行动”对当前任务推进了多少分。',
            '请把角色本次行动当成已经发生的事实，不要重写行动，也不要替角色继续行动。',
            '如果本次行动与任务相关但只推进了一部分，就给 1-3 分。',
            '如果本次行动几乎没有帮助，就给 0 分。',
            '只有当累计进度已经足够时，才把 is_completed 设为 true。',
            '请只输出 JSON，不要输出任何解释。',
            '',
            '[任务信息]',
            `角色：${char.name}`,
            `任务标题：${String(quest?.title || '').trim()}`,
            `任务描述：${String(quest?.description || '').trim()}`,
            `任务类型：${String(quest?.quest_type || '').trim() || 'errand'}`,
            `目标地点：${String(quest?.target_district || '').trim() || 'street'}`,
            `当前累计进度：${currentProgress}`,
            `完成所需总进度：${targetScore}`,
            `当前阶段：${String(claim?.status || 'accepted')}`,
            `本次行动地点：${String(district?.id || '').trim() || 'unknown'}`,
            '',
            '[本次行动文本]',
            actionText,
            '',
            '输出格式：',
            '{"progress_delta": 0-3之间的整数, "is_valid_progress": true, "is_completed": false, "short_label": "6字内短标签", "comment": "一句中文评价"}'
        ].join('\n');
        const messages = [{ role: 'user', content: prompt }];
        recordCityLlmDebug(db, resolvedAiChar, 'input', 'city_quest_progress_score', messages, {
            model: resolvedAiChar.model_name,
            quest_id: quest.id,
            action_log_id: actionLogId
        });
        try {
            const reply = await callLLM({
                endpoint: resolvedAiChar.api_endpoint,
                key: resolvedAiChar.api_key,
                model: resolvedAiChar.model_name,
                messages,
                maxTokens: 3000,
                temperature: 0.2
            });
            recordCityLlmDebug(db, resolvedAiChar, 'output', 'city_quest_progress_score', reply, {
                model: resolvedAiChar.model_name,
                quest_id: quest.id,
                action_log_id: actionLogId
            });
            const parsed = parseMayorJsonReply(reply, '市长 AI 任务评分返回内容不是合法 JSON。');
            const isValidProgress = parsed?.is_valid_progress !== false;
            let progressDelta = Math.max(0, Math.min(3, parseInt(parsed?.progress_delta, 10) || 0));
            if (!isValidProgress) progressDelta = 0;
            let nextProgress = currentProgress + progressDelta;
            const completedBySignal = parsed?.is_completed === true;
            if (completedBySignal && nextProgress < targetScore) {
                nextProgress = targetScore;
                progressDelta = Math.max(progressDelta, targetScore - currentProgress);
            }
            const isCompleted = completedBySignal || nextProgress >= targetScore;
            const finalClaim = progressDelta > 0
                ? db.city.advanceQuestProgress?.(quest.id, char.id, progressDelta)
                : { ...claim };
            const review = db.city.upsertQuestProgressReview?.({
                quest_id: quest.id,
                claim_id: claim.id,
                log_id: actionLogId,
                character_id: char.id,
                status: 'success',
                progress_delta: progressDelta,
                progress_after: Math.max(0, Number(finalClaim?.progress_count ?? nextProgress ?? currentProgress)),
                target_score: targetScore,
                is_completed: isCompleted ? 1 : 0,
                comment: String(parsed?.comment || '').trim() || (progressDelta > 0 ? '本次行动对任务推进有帮助。' : '本次行动与任务推进关联较弱。'),
                short_label: String(parsed?.short_label || '').trim() || (progressDelta > 0 ? `+${progressDelta}进度` : '未推进'),
                error_message: '',
                raw_response: String(reply || '').trim()
            });
            return {
                success: true,
                review,
                progressDelta,
                nextClaim: finalClaim || claim,
                targetScore,
                isCompleted
            };
        } catch (err) {
            recordCityLlmDebug(db, resolvedAiChar, 'event', 'city_quest_progress_score', `Quest scoring failed: ${String(err?.message || err || 'unknown_error')}`, {
                model: resolvedAiChar.model_name,
                quest_id: quest.id,
                action_log_id: actionLogId,
                error: true
            });
            const review = db.city.upsertQuestProgressReview?.({
                quest_id: quest.id,
                claim_id: claim.id,
                log_id: actionLogId,
                character_id: char.id,
                status: 'error',
                progress_delta: 0,
                progress_after: currentProgress,
                target_score: targetScore,
                is_completed: 0,
                comment: '',
                short_label: '',
                error_message: `任务评分失败：${String(err?.message || 'unknown_error').slice(0, 180)}`,
                raw_response: ''
            });
            return {
                success: false,
                review,
                canRetry: true,
                error: String(err?.message || 'unknown_error')
            };
        }
    }

    async function applyMayorDecisions(db, decision, aiChar = null) {
        const results = { price_changes: 0, events: 0, quests: 0, announcement: '' };

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

        if (Array.isArray(decision.events)) {
            for (const ev of decision.events) {
                if (ev.title) {
                    db.city.createEvent({
                        type: ev.type || 'random',
                        title: ev.title,
                        emoji: ev.emoji || '📙',
                        description: ev.description || '',
                        effect: ev.effect || {},
                        target_district: ev.effect?.district || '',
                        duration_hours: ev.duration_hours || 12
                    });
                    db.city.logAction('system', 'EVENT', `${ev.emoji || '📙'} 城市事件: ${ev.title} - ${ev.description || ''}`, 0, 0);
                    results.events++;
                }
            }
        }

        if (Array.isArray(decision.quests)) {
            for (const q of decision.quests) {
                if (q.title) {
                    const scoredQuest = await scoreQuestDifficultyWithMayor(db, {
                        title: q.title,
                        description: q.description || q.desc || '',
                        difficulty: q.difficulty || q.diff || 'normal',
                        quest_type: q.quest_type || '',
                        target_district: q.target_district || ''
                    }, aiChar);
                    const questId = db.city.createQuest({
                        title: q.title,
                        emoji: q.emoji || '📐',
                        description: q.description || '',
                        reward_gold: q.reward_gold ?? 50,
                        reward_cal: q.reward_cal ?? 0,
                        difficulty: q.difficulty || 'normal',
                        completion_target: scoredQuest.targetScore,
                        difficulty_reason: scoredQuest.reason
                    });
                    publishQuestAnnouncement(db, questId, q);
                    db.city.logAction('system', 'QUEST', `📐 新悬赏任务: ${q.title} (${q.difficulty || 'normal'}) - 目标进度 ${scoredQuest.targetScore} - 奖励 ${q.reward_gold ?? 50} 金币`, 0, 0);
                    results.quests++;
                }
            }
        }

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

    return {
        resolveMayorAiCharacter,
        parseMayorJsonReply,
        getQuestDifficultyFallbackTarget,
        scoreQuestDifficultyWithMayor,
        scoreQuestProgressWithMayor,
        applyMayorDecisions
    };
}

module.exports = { createMayorService };
