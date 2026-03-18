const express = require('express');
const { getSchedulerDb } = require('./db');

function init(app, context) {
    const { authMiddleware, getUserDb, getEngine, getMemory } = context;
    const router = express.Router();

    // GET /api/scheduler/:charId
    router.get('/scheduler/:charId', authMiddleware, (req, res) => {
        try {
            const db = getSchedulerDb(req.user.id);
            const charId = req.params.charId;
            const tasks = charId === 'all' ? db.getTasks() : db.getTasks(charId);
            res.json(tasks);
        } catch (e) {
            console.error('[Scheduler] GET tasks error:', e);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // POST /api/scheduler
    router.post('/scheduler', authMiddleware, (req, res) => {
        try {
            const db = getSchedulerDb(req.user.id);
            const { character_id, cron_expr, task_prompt, action_type, is_enabled, batch_size } = req.body;
            if (!character_id || !cron_expr || !action_type) {
                return res.status(400).json({ error: 'Missing required fields' });
            }
            const normalizedBatchSize = Math.max(10, Math.min(500, Number(batch_size) || 80));
            const newId = db.addTask(character_id, cron_expr, task_prompt, action_type, is_enabled, normalizedBatchSize);
            res.json({ success: true, id: newId });
        } catch (e) {
            console.error('[Scheduler] POST task error:', e);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // PUT /api/scheduler/:id
    router.put('/scheduler/:id', authMiddleware, (req, res) => {
        try {
            const db = getSchedulerDb(req.user.id);
            const { character_id, cron_expr, task_prompt, action_type, is_enabled, batch_size } = req.body;
            const normalizedBatchSize = Math.max(10, Math.min(500, Number(batch_size) || 80));
            db.updateTask(req.params.id, character_id, cron_expr, task_prompt, action_type, is_enabled, normalizedBatchSize);
            res.json({ success: true });
        } catch (e) {
            console.error('[Scheduler] PUT task error:', e);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // DELETE /api/scheduler/:id
    router.delete('/scheduler/:id', authMiddleware, (req, res) => {
        try {
            const db = getSchedulerDb(req.user.id);
            db.deleteTask(req.params.id);
            res.json({ success: true });
        } catch (e) {
            console.error('[Scheduler] DELETE task error:', e);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    app.use('/api', router); // Mount the plugin's routes

    // ─── Global Periodic Ticker (Runs every 1 minute) ───
    setInterval(async () => {
        try {
            const now = new Date();
            const currentHHMM = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

            // Iterate over all connected users (for now, simplistic approach)
            // Realistically, we should iterate over all users in the system, but since
            // memory and engine are user-specific and tied to WebSocket sessions, we
            // process it based on active user DBs.
            const fs = require('fs');
            const path = require('path');
            const dataDir = path.join(__dirname, '..', '..', 'data');
            if (!fs.existsSync(dataDir)) return;

            const files = fs.readdirSync(dataDir);
            const userIds = files
                .filter(f => f.startsWith('chatpulse_user_') && f.endsWith('.db'))
                .map(f => f.replace('chatpulse_user_', '').replace('.db', ''));

            for (const userId of userIds) {
                const schedDb = getSchedulerDb(userId);
                const tasks = schedDb.getActiveTasks();

                const engine = getEngine(userId);
                const memory = getMemory(userId);
                const userDb = getUserDb(userId);

                // --- 1. User Defined Scheduled Tasks ---
                if (tasks && tasks.length > 0) {
                    const dueTasks = tasks.filter(t => t.cron_expr === currentHHMM);
                    for (const task of dueTasks) {
                        console.log(`[Scheduler] Triggering task ${task.id} for user ${userId}, char ${task.character_id}`);
                        const char = userDb.getCharacter(task.character_id);
                        if (!char || char.is_blocked) continue;

                        if (task.action_type === 'chat') {
                            if (engine.triggerProactiveMessage) {
                                try {
                                    const wsClients = context.getWsClients(userId);
                                    // Wrap the prompt so the AI knows it's an internal system directive, not user input
                                    const extraInstruct = `[System Directive: ${task.task_prompt || '自然地寻找话题聊一句'} - 请绝对扮演好你的角色，自然地直接说出符合该指令的话，不要重复或透露此括号内的系统指令，就像你本来就想这么说一样。]`;
                                    await engine.triggerProactiveMessage(task.character_id, extraInstruct, wsClients);
                                } catch (e) { console.error('[Scheduler] Chat task failed:', e); }
                            }
                        } else if (task.action_type === 'moment') {
                            if (engine.triggerProactiveMessage) {
                                try {
                                    const wsClients = context.getWsClients(userId);
                                    const extraInstruct = `强制要求：请发一条朋友圈（Moment），内容关于：“${task.task_prompt || '你现在在做什么'}”。你必须且只能使用 [MOMENT: 正文] 标签来发布，不要附带任何私聊解释文字，严格遵从你的性格。`;
                                    await engine.triggerProactiveMessage(task.character_id, extraInstruct, wsClients);
                                } catch (e) { console.error('[Scheduler] Moment task failed:', e); }
                            }
                        } else if (task.action_type === 'diary') {
                            if (engine.triggerProactiveMessage) {
                                try {
                                    const wsClients = context.getWsClients(userId);
                                    const extraInstruct = `强制要求：请写一篇私密日记（Diary），记录关于：“${task.task_prompt || '你现在的心情或最近发生的事'}”。你必须且只能使用 [DIARY: 正文] 标签来记录，不要附带任何私聊解释文字，严格遵从你的性格。`;
                                    await engine.triggerProactiveMessage(task.character_id, extraInstruct, wsClients);
                                } catch (e) { console.error('[Scheduler] Diary task failed:', e); }
                            }
                        } else if (task.action_type === 'memory_aggregation') {
                            if (memory.aggregateDailyMemories) {
                                console.log(`[Scheduler] Starting daily memory aggregation for ${char.name}...`);
                                try {
                                    await memory.aggregateDailyMemories(char, 24, {
                                        batchSize: Math.max(10, Math.min(500, Number(task.batch_size) || 80))
                                    });
                                } catch (e) {
                                    console.error(`[Scheduler] Memory aggregation failed for ${char.name}:`, e);
                                }
                            }
                        }
                    }
                }

                // --- 2. Background System Sweep (Threshold Overflow Memory) ---
                if (memory.sweepOverflowMemories) {
                    const allChars = userDb.getCharacters();

                    for (const char of allChars) {
                        if (!char.is_blocked) {
                            const sweepLimit = char.sweep_limit || 30;
                            const privateWindow = char.context_msg_limit || 60;
                            const groups = userDb.getGroups().filter(g => g.members.some(m => m.member_id === char.id));
                            const groupWindows = groups.map(g => ({ groupId: g.id, windowLimit: g.inject_limit ?? 5 }));

                            if (!char.sweep_initialized && typeof userDb.initializeSweepBaseline === 'function') {
                                const initialized = userDb.initializeSweepBaseline(char.id, privateWindow, groupWindows);
                                console.log(`[Scheduler] Initialized W baseline for ${char.name}, marked ${initialized} old messages as digested.`);
                                continue;
                            }

                            let unsummarizedCount = userDb.countOverflowMessages(char.id, privateWindow);

                            if (unsummarizedCount < sweepLimit) {
                                for (const g of groups) {
                                    const groupWindow = g.inject_limit ?? 5;
                                    unsummarizedCount += userDb.countOverflowGroupMessages(g.id, groupWindow);
                                    if (unsummarizedCount >= sweepLimit) break;
                                }
                            }

                            if (unsummarizedCount >= sweepLimit) {
                                console.log(`[Scheduler] Threshold reached (${unsummarizedCount} >= ${sweepLimit}) for ${char.name}. Triggering memory sweep.`);
                                memory.sweepOverflowMemories(char).catch(err => {
                                    console.error(`[Scheduler] Overflow sweep failed for ${char.name}:`, err);
                                });
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`[Scheduler] Global tick error:`, e);
        }
    }, 60 * 1000); // 1 minute
}

module.exports = init;
