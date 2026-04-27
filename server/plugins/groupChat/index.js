const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildUniversalContext } = require('../../contextBuilder');
const { getAdaptiveTailWindowSize } = require('../../utils/contextWindow');
const { applyEmotionEvent, getEmotionBehaviorGuidance, buildEmotionLogEntry } = require('../../emotion');
const { getTokenCount } = require('../../utils/tokenizer');

function initGroupChatPlugin(app, context) {
    const {
        wss, getWsClients, authDb, authMiddleware,
        getUserDb, getEngine, getMemory, callLLM
    } = context;

    function recordGroupTokenUsage(db, characterId, contextType, usage) {
        if (!usage || !characterId || !db?.addTokenUsage) return;
        db.addTokenUsage(characterId, contextType, usage.prompt_tokens || 0, usage.completion_tokens || 0);
    }

    function getCachedGroupPromptBlock(db, characterId, blockType, sourcePayload, buildFn) {
        const sourceHash = crypto.createHash('sha256')
            .update(JSON.stringify(sourcePayload || {}))
            .digest('hex');
        const cached = typeof db?.getPromptBlockCache === 'function'
            ? db.getPromptBlockCache(characterId, blockType, sourceHash)
            : null;
        if (cached?.compiled_text) return cached.compiled_text;
        const compiledText = String(buildFn?.() || '');
        if (compiledText) {
            db?.upsertPromptBlockCache?.({
                character_id: characterId,
                block_type: blockType,
                source_hash: sourceHash,
                compiled_text: compiledText
            });
        }
        return compiledText;
    }

    function compactGroupPreview(text, maxLength = 24) {
        const cleaned = String(text || '')
            .replace(/\[[A-Z_]+:[^\]]*?\]/g, '')
            .replace(/\[[A-Z_]+\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!cleaned) return '';
        if (cleaned.length <= maxLength) return cleaned;
        return `${cleaned.slice(0, Math.max(12, maxLength - 1)).trim()}…`;
    }

    function buildCompactGroupAntiRepeat(character, messages) {
        const recentAssistantMsgs = (Array.isArray(messages) ? messages : [])
            .filter(m => m.sender_id === character.id)
            .slice(-5);
        if (recentAssistantMsgs.length === 0) return '';
        const recentTopics = [];
        for (const msg of recentAssistantMsgs) {
            const preview = compactGroupPreview(msg.content, 20);
            if (!preview) continue;
            if (!recentTopics.includes(preview)) recentTopics.push(preview);
            if (recentTopics.length >= 2) break;
        }
        if (recentTopics.length === 0) return '';
        return `\n[Anti-Repeat]\nRecent topics: ${recentTopics.join(' | ')}\nAvoid same jab, same defense, or same emotional line.`;
    }

    function recordGroupLlmDebug(db, character, direction, payload, meta = {}) {
        if (!character || character.llm_debug_capture !== 1 || typeof db?.addLlmDebugLog !== 'function') return;
        try {
            db.addLlmDebugLog({
                character_id: character.id,
                direction,
                context_type: meta.context_type || 'group_chat',
                payload: typeof payload === 'string' ? payload : JSON.stringify(payload || []),
                meta: {
                    ...meta,
                    context_type: meta.context_type || 'group_chat'
                },
                timestamp: Date.now()
            });
        } catch (e) {
            console.warn(`[GroupChat] Failed to record LLM debug for ${character?.name || character?.id}: ${e.message}`);
        }
    }

    function buildGroupAttemptRecorder(db, character, baseMeta = {}) {
        return (attemptMeta = {}) => {
            recordGroupLlmDebug(db, character, attemptMeta.phase === 'start' ? 'attempt' : 'attempt_result', '', {
                ...baseMeta,
                llm_attempt: true,
                ...attemptMeta
            });
        };
    }

    function logEmotionTransition(db, beforeState, patch, source, reason) {
        if (!db?.addEmotionLog || !beforeState || !patch || Object.keys(patch).length === 0) return;
        const entry = buildEmotionLogEntry(beforeState, { ...beforeState, ...patch }, source, reason);
        if (entry) db.addEmotionLog(entry);
    }

    // We will extract DB from req.db like original index.js did

    // 14.1 List all groups
    app.get('/api/groups', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            res.json(db.getGroups());
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 14.2 Create a group
    app.post('/api/groups', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const { name, member_ids } = req.body;
            if (!name || !member_ids || member_ids.length === 0) {
                return res.status(400).json({ error: 'name and member_ids are required' });
            }
            const id = 'group_' + Date.now();
            // Generate a group avatar mosaic from members
            const firstMember = db.getCharacter(member_ids[0]);
            const avatar = firstMember?.avatar || 'https://api.dicebear.com/7.x/shapes/svg?seed=' + id;
            db.createGroup(id, name, member_ids, avatar);
            res.json({ success: true, group: db.getGroup(id) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 14.2.5 Update group settings (inject_limit, name, etc.)
    app.put('/api/groups/:id', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const group = db.getGroup(req.params.id);
            if (!group) return res.status(404).json({ error: 'Group not found' });
            const { inject_limit, name, context_msg_limit } = req.body;
            // Use raw SQL update since db wrapper doesn't have updateGroup
            const updates = [];
            const values = [];
            if (inject_limit !== undefined) { updates.push('inject_limit = ?'); values.push(Math.max(0, parseInt(inject_limit) || 0)); }
            if (name !== undefined && name.trim()) { updates.push('name = ?'); values.push(name.trim()); }
            if (context_msg_limit !== undefined) { updates.push('context_msg_limit = ?'); values.push(Math.max(1, parseInt(context_msg_limit) || 60)); }
            if (updates.length > 0) {
                values.push(req.params.id);
                db.rawRun(`UPDATE group_chats SET ${updates.join(', ')} WHERE id = ?`, values);
                if (context_msg_limit !== undefined && typeof db.clearGroupConversationDigest === 'function') {
                    db.clearGroupConversationDigest(req.params.id);
                }
            }
            res.json({ success: true, group: db.getGroup(req.params.id) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 14.3 Get group messages
    app.get('/api/groups/:id/messages', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const limit = parseInt(req.query.limit) || 100;
            res.json(db.getGroupMessages(req.params.id, limit));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });


    // 14.6 Add member to group (with system announcement + AI reactions)
    app.post('/api/groups/:id/members', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const { member_id } = req.body;
            if (!member_id) return res.status(400).json({ error: 'member_id is required' });
            db.addGroupMember(req.params.id, member_id);

            // Insert system announcement message
            const char = db.getCharacter(member_id);
            const charName = char?.name || member_id;
            const sysContent = '[System] ' + charName + ' 加入了群聊';
            const sysMsgId = db.addGroupMessage(req.params.id, 'system', sysContent, 'System', '');
            const sysMsg = { id: sysMsgId, group_id: req.params.id, sender_id: 'system', content: sysContent, timestamp: Date.now(), sender_name: 'System', sender_avatar: '' };

            // Broadcast system message via WebSocket
            const wsPayload = JSON.stringify({ type: 'group_message', data: sysMsg });
            wsClients.forEach(c => { if (c.readyState === 1) c.send(wsPayload); });

            const updatedGroup = db.getGroup(req.params.id);
            res.json({ success: true, group: updatedGroup });

            // Trigger AI chain so all members (including new one) react to the joining
            setTimeout(() => {
                triggerGroupAIChain(req.user.id, req.params.id, wsClients, [member_id], true);
            }, 1500);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 14.7 Kick member from group (with system announcement + AI reactions)
    app.delete('/api/groups/:id/members/:memberId', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            // Get char name before removing
            const char = db.getCharacter(req.params.memberId);
            const charName = char?.name || req.params.memberId;

            db.removeGroupMember(req.params.id, req.params.memberId);

            // Insert system announcement message
            const sysContent = '[System] ' + charName + ' 被移出了群聊';
            const sysMsgId = db.addGroupMessage(req.params.id, 'system', sysContent, 'System', '');
            const sysMsg = { id: sysMsgId, group_id: req.params.id, sender_id: 'system', content: sysContent, timestamp: Date.now(), sender_name: 'System', sender_avatar: '' };

            // Broadcast system message via WebSocket
            const wsPayload = JSON.stringify({ type: 'group_message', data: sysMsg });
            wsClients.forEach(c => { if (c.readyState === 1) c.send(wsPayload); });

            const updatedGroup = db.getGroup(req.params.id);
            res.json({ success: true, group: updatedGroup });

            // Trigger AI chain so remaining members react to the departure
            setTimeout(() => {
                triggerGroupAIChain(req.user.id, req.params.id, wsClients, [], false, false);
            }, 1500);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 14.8 Dissolve (delete) group
    app.delete('/api/groups/:id', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            db.deleteGroup(req.params.id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 14.9 Clear group messages
    app.delete('/api/groups/:id/messages', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            db.clearGroupMessages(req.params.id);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 14.9b Batch-delete specific group messages
    app.post('/api/groups/:id/messages/batch-delete', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const { messageIds } = req.body;
            if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
                return res.status(400).json({ error: 'messageIds array required' });
            }
            const deleted = db.deleteGroupMessages(messageIds);
            res.json({ success: true, deleted });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 鈹€鈹€鈹€ Group Chat Debounce System 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    // When user sends multiple messages quickly, we wait until they stop, then fire ONE AI reply chain.
    const groupDebounceTimers = {}; // { groupId: timeoutHandle }
    const groupReplyLock = {};
    const groupInterrupt = {};     // { groupId: true } 鈥?prevent overlapping chains
    const pausedGroups = new Set(); // groups where AI replies are paused by user
    const noChainGroups = new Set(); // groups where AI鈫扐I secondary @-mention chains are blocked
    const groupPendingMentions = {}; // { groupId: { ids: Set, isAtAll: bool } } 鈥?accumulates mentions across debounce resets

    // 14.10 Set AI pause for a group
    app.post('/api/groups/:id/ai-pause', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        const id = req.params.id;
        // Allow explicitly setting state from request body, otherwise fallback to toggle
        const wantsPause = req.body && req.body.paused !== undefined ? req.body.paused : !pausedGroups.has(id);

        if (!wantsPause) {
            pausedGroups.delete(id);
            // Restart proactive timer if it was running
            engine.scheduleGroupProactive(id, wsClients);
            res.json({ paused: false });
        } else {
            pausedGroups.add(id);
            engine.stopGroupProactiveTimer(id);
            // Clear any pending debounce/chaining locks instantly
            if (groupDebounceTimers[id]) { clearTimeout(groupDebounceTimers[id]); delete groupDebounceTimers[id]; }
            delete groupReplyLock[id];
            res.json({ paused: true });
        }
    });

    app.get('/api/groups/:id/ai-pause', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        res.json({ paused: pausedGroups.has(req.params.id) });
    });

    // 14.11 Toggle AI鈫扐I secondary @-mention chain for a group
    app.post('/api/groups/:id/no-chain', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        const id = req.params.id;
        if (noChainGroups.has(id)) {
            noChainGroups.delete(id);
            res.json({ noChain: false });
        } else {
            noChainGroups.add(id);
            res.json({ noChain: true });
        }
    });

    app.get('/api/groups/:id/no-chain', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        res.json({ noChain: noChainGroups.has(req.params.id) });
    });

    function triggerGroupAIChain(userId, groupId, wsClients, mentionedIds = [], isAtAll = false, isSecondaryChain = false, carriedRedPacketFeedback = []) {
        const db = getUserDb(userId);
        const engine = getEngine(userId);
        const memory = getMemory(userId);

        if (pausedGroups.has(groupId)) return; // AI replies paused by user
        if (groupReplyLock[groupId]) {
            // Already running! Put mentions back so they fire in the NEXT chain.
            if (mentionedIds.length > 0 || isAtAll) {
                if (!groupPendingMentions[groupId]) groupPendingMentions[groupId] = { ids: new Set(), isAtAll: false };
                mentionedIds.forEach(id => groupPendingMentions[groupId].ids.add(id));
                if (isAtAll) groupPendingMentions[groupId].isAtAll = true;

                // Re-trigger debounce so they aren't lost indefinitely
                if (!groupDebounceTimers[groupId]) {
                    groupDebounceTimers[groupId] = setTimeout(() => {
                        delete groupDebounceTimers[groupId];
                        const pending = groupPendingMentions[groupId] || { ids: new Set(), isAtAll: false };
                        delete groupPendingMentions[groupId];
                        triggerGroupAIChain(userId, groupId, wsClients, Array.from(pending.ids), pending.isAtAll, false);
                    }, 4000);
                }
            }
            return;
        }
        groupReplyLock[groupId] = true;

        const group = db.getGroup(groupId);
        if (!group) { delete groupReplyLock[groupId]; return; }

        const charMembers = group.members.filter(m => m.member_id !== 'user');
        // Fisher-Yates shuffle
        const shuffled = [...charMembers];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            // Ensure explicitly mentioned chars are moved to the front so they reply first
        }
        // Re-order: mentioned chars first, rest after
        const mentionedFirst = [
            ...shuffled.filter(m => mentionedIds.includes(m.member_id) || isAtAll),
            ...shuffled.filter(m => !mentionedIds.includes(m.member_id) && !isAtAll)
        ];

        (async () => {
            const pendingSecondaryChains = []; // collect @mention triggers to fire AFTER lock release
            const pendingRedPacketFeedback = [...carriedRedPacketFeedback]; // collect { packetId, senderId } for post-chain sender reaction
            let interruptedByRedPacket = false;
            let remainingMembers = [];

            try {
                for (let i = 0; i < mentionedFirst.length; i++) {
                    const member = mentionedFirst[i];
                    const char = db.getCharacter(member.member_id);
                    if (!char || char.is_blocked) continue;
                    const isMentioned = mentionedIds.includes(char.id) || isAtAll;

                    // Bystander / Unmentioned message filtering
                    if (!isMentioned) {
                        if (isSecondaryChain) {
                            // If this is an AI-to-AI interaction (secondary chain), ONLY the mentioned char can talk.
                            // Unmentioned AIs MUST NOT speak, to prevent infinite loops (char@char should only trigger that char).
                            continue;
                        }

                        const skipProfile = db.getUserProfile();
                        let skipRate = skipProfile?.group_skip_rate;
                        if (skipRate === undefined) skipRate = 0.50;
                        if (skipRate > 1) skipRate = skipRate / 100;

                        if (Math.random() < skipRate) continue;
                    }

                    // Broadcast "typing" indicator
                    const typingPayload = JSON.stringify({ type: 'group_typing', data: { group_id: groupId, sender_id: char.id, name: char.name } });
                    wsClients.forEach(c => { if (c.readyState === 1) c.send(typingPayload); });

                    // Random delay 2-5 seconds before this character speaks
                    const delay = Math.floor(2000 + Math.random() * 3000);
                    await new Promise(resolve => setTimeout(resolve, delay));

                    try {
                        // Re-fetch messages RIGHT NOW so this char sees all prior replies
                        const userProfile = db.getUserProfile();
                        const groupMsgLimit = group.context_msg_limit || 60; // Use saved limit or default 60
                        // Filter: new members can only see messages from after they joined
                        const memberEntry = group.members.find(m => m.member_id === char.id);
                        const joinedAt = memberEntry?.joined_at || 0;
                        const allRecentGroupMsgs = db.getVisibleGroupMessages(groupId, groupMsgLimit, joinedAt);
                        const liveGroupWindowSize = getAdaptiveTailWindowSize(groupMsgLimit, allRecentGroupMsgs.length);
                        const recentGroupMsgs = allRecentGroupMsgs.slice(-liveGroupWindowSize);
                        const userName = userProfile?.name || 'User';

                        const formatMessageForLLM = (db, content) => {
                            if (!content) return '';
                            try {
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
                                        const status = t.claimed ? '（已被对方领取）' : (t.refunded ? '（已退还）' : '（待领取）');
                                        return `[杞处: 楼${amount}, 澶囨敞: "${note}" ${status}]`;
                                    }
                                    return `[杞处: 楼${amount}, 澶囨敞: "${note}"]`;
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
                                            statusStr = '（剩余 ' + rp.remaining_count + '/' + rp.count + ' 份）';
                                        }
                                        let claimNote = '';
                                        if (rp.claims && rp.claims.length > 0) {
                                            const claimers = rp.claims.map(c => {
                                                const cName = c.claimer_id === 'user' ? (db.getUserProfile()?.name || '鐢ㄦ埛') : (db.getCharacter(c.claimer_id)?.name || c.claimer_id);
                                                return `${cName}(楼${c.amount})`;
                                            }).join(', ');
                                            claimNote = ` 棰嗗彇璁板綍: ${claimers}`;
                                        }
                                        const senderName = rp.sender_id === 'user' ? '鐢ㄦ埛' : (db.getCharacter(rp.sender_id)?.name || rp.sender_id);
                                        return `[${senderName}鍙戜簡涓€涓兢绾㈠寘: 楼${rp.total_amount}${rp.type === 'lucky' ? '(鎷兼墜姘?' : '(鏅€?'}, 澶囨敞: "${rp.note}" ${statusStr}${claimNote}]`;
                                    }
                                    return `[缇ょ孩鍖匽`;
                                }
                            } catch (e) { }
                            return content;
                        };

                        const history = recentGroupMsgs.map(m => {
                            const senderName = m.sender_id === 'user' ? userName : (db.getCharacter(m.sender_id)?.name || m.sender_name || 'Unknown');
                            return { role: m.sender_id === char.id ? 'assistant' : 'user', content: `[${senderName}]: ${formatMessageForLLM(db, m.content)} ` };
                        });

                        const recentInput = history.slice(-2).map(m => m.content).join(' ');
                        const groupConversationDigest = typeof db.getGroupConversationDigest === 'function'
                            ? db.getGroupConversationDigest(groupId, char.id)
                            : null;
                        const digestBlock = typeof memory.formatGroupConversationDigestForPrompt === 'function'
                            ? memory.formatGroupConversationDigestForPrompt(groupConversationDigest, { recentMessages: recentGroupMsgs })
                            : '';

                        // Build relationship-aware member descriptions
                        const otherMembers = group.members.filter(m => m.member_id !== char.id);

                        // Extract char objects for Universal Context (Impression History injection)
                        const activeTargets = otherMembers
                            .filter(m => m.member_id !== 'user')
                            .map(m => db.getCharacter(m.member_id))
                            .filter(c => c && !c.is_blocked);

                        // --- Use Universal Context Builder ---
                        const engineContextWrapper = { getUserDb, getMemory: context.getMemory };
                        const universalResult = await buildUniversalContext(engineContextWrapper, char, recentInput, true, activeTargets);

                        const knownMembers = [];
                        const unknownMembers = [];

                        for (const m of otherMembers) {
                            if (m.member_id === 'user') {
                                const userRel = db.getCharRelationship(char.id, 'user');
                                knownMembers.push(`- ${userName} (id: user, 濂芥劅搴? ${userRel?.affinity ?? char.affinity ?? 50})`);
                                continue;
                            }
                            const otherChar = db.getCharacter(m.member_id);
                            if (!otherChar) continue;
                            const rel = db.getCharRelationship(char.id, otherChar.id);
                            if (rel && rel.isAcquainted) {
                                knownMembers.push(`- ${otherChar.name} (id: ${otherChar.id}, 濂芥劅搴? ${rel.affinity}, 鍗拌薄: "${rel.impression}")`);
                            } else {
                                unknownMembers.push(`- ${otherChar.name} (id: ${otherChar.id}, 浣犱笉璁よ瘑杩欎釜浜猴紝鍙煡閬撳悕瀛?`);
                            }
                        }

                        let relationSection = '';
                        if (knownMembers.length > 0) {
                            relationSection += `\n浣犺璇嗙殑浜猴細\n${knownMembers.join('\n')} `;
                        }
                        if (unknownMembers.length > 0) {
                            relationSection += `\n浣犱笉璁よ瘑鐨勪汉锛歕n${unknownMembers.join('\n')} `;
                        }

                        // List char's own recent messages to prevent repetition
                        const noRepeatNote = buildCompactGroupAntiRepeat(char, recentGroupMsgs);
                        const mentionNote = isMentioned
                            ? `\n[MENTION]: Someone just @mentioned you directly! You MUST reply to this message 鈥?don't ignore it.`
                            : '';

                        const emotionGuidance = getEmotionBehaviorGuidance(char);
                        const mentionableNames = charMembers
                            .map(m => db.getCharacter(m.member_id)?.name)
                            .filter(Boolean)
                            .map(name => '@' + name)
                            .join(' / ');
                        const stableGroupPrompt = getCachedGroupPromptBlock(
                            db,
                            char.id,
                            'group_stable_prompt_v1',
                            {
                                groupName: group.name || '',
                                persona: char.persona || '',
                                worldInfo: char.world_info || '',
                                systemPrompt: char.system_prompt || ''
                            },
                            () => {
                                const parts = [
                                    '[System Directive: Stay fully in character. No AI/assistant mentions. No disclaimers.]',
                                    `你是${char.name}，正在群聊“${group.name}”里说话。这里是群聊，不是私聊。`,
                                    char.persona ? `Persona: ${char.persona}` : '',
                                    char.world_info ? `World: ${char.world_info}` : '',
                                    char.system_prompt ? `Extra rules: ${char.system_prompt}` : ''
                                ].filter(Boolean);
                                return parts.join('\n\n');
                            }
                        );
                        const groupRulesBlock = [
                            'Group rules:',
                            '1. Keep replies short and natural, usually 1-2 sentences.',
                            '2. React to the latest group flow; do not force a turn.',
                            '3. Output reply text only. Do not prefix your own name.',
                            `4. Use @Name only if you want an immediate reply. Mentionable: @${userName}${mentionableNames ? ' / ' + mentionableNames : ''}`,
                            '5. Red packet reactions stay in role.',
                            '6. Source boundaries matter: [PRIVATE SOURCE] can shape your feelings but is not public chat; [GROUP SOURCE] is public chat and can be replied to directly; [CITY SOURCE] is real-life experience, not a chat line.',
                            '7. Never mistake private/city snippets for someone literally speaking in this group right now. Do not invent message duplication, impersonation, or fake send errors unless the group history itself shows that.',
                            '8. Optional hidden tags: [CHAR_AFFINITY:id:+3], [REDPACKET_SEND:lucky|50|5|新年快乐], [MOMENT:内容], [MOMENT_LIKE:MomentID], [MOMENT_COMMENT:MomentID:评论内容]'
                        ].join('\n');
                        const systemPrompt =
                            stableGroupPrompt + '\n\n' +
                            (universalResult.preamble || '') + '\n\n' +
                            (digestBlock ? `${digestBlock}\n\n` : '') +
                            '当前主情绪：' + emotionGuidance.emotion.label + ' ' + emotionGuidance.emotion.emoji + '\n' +
                            '当前情绪的身体感受：' + emotionGuidance.groupChat + '\n' +
                            relationSection + '\n' +
                            noRepeatNote + mentionNote + '\n\n' +
                            groupRulesBlock;

                        const llmMessages = [{ role: 'system', content: systemPrompt }, ...history];

                        // Prevent third-party proxies from auto-appending "缁х画" if the active AI spoke last 
                        if (llmMessages.length > 0 && llmMessages[llmMessages.length - 1].role === 'assistant') {
                            llmMessages.push({ role: 'user', content: '[绯荤粺鎻愮ず锛氱兢閲岀幇鍦ㄥ緢瀹夐潤锛岃鑷劧鍦扮户缁彂瑷€鎴栧紑鍚柊璇濋銆俔' });
                        }

                        recordGroupLlmDebug(db, char, 'input', llmMessages, {
                            context_type: 'group_chat',
                            group_id: groupId,
                            group_name: group.name,
                            isMentioned,
                            isAtAll,
                            digest_active: !!digestBlock,
                            live_tail_count: recentGroupMsgs.length,
                            history_chars: history.reduce((sum, m) => sum + String(m.content || '').length, 0),
                            system_chars: systemPrompt.length
                        });

                        const { content: reply, usage } = await callLLM({
                            endpoint: char.api_endpoint,
                            key: char.api_key,
                            model: char.model_name,
                            messages: llmMessages,
                            maxTokens: char.max_tokens || 500,
                            returnUsage: true,
                            debugAttempt: buildGroupAttemptRecorder(db, char, {
                                context_type: 'group_chat',
                                group_id: groupId,
                                group_name: group.name
                            })
                        });
                        recordGroupTokenUsage(db, char.id, 'group_chat', usage);


                        if (reply && reply.trim()) {
                            let cleanReply = reply.trim();
                            // Strip AI's own name prefix 鈥?AI sometimes mimics the history format
                            // Handles: [Name]:, 銆怤ame銆?, Name:, [Name]锛? etc.
                            const nameEscaped = char.name.replace(/[.*+?^()|[\]\\{}$]/g, '\\$&');
                            const namePrefixRegex = new RegExp('^(?:\\[)?' + nameEscaped + '(?:\\])?[:：]\\s*', 'i');
                            cleanReply = cleanReply.replace(namePrefixRegex, '').trim();

                            recordGroupLlmDebug(db, char, 'output', cleanReply, {
                                context_type: 'group_chat',
                                group_id: groupId,
                                group_name: group.name,
                                finishReason: 'stop',
                                usage: usage || null,
                                digest_active: !!digestBlock,
                                live_tail_count: recentGroupMsgs.length
                            });

                            // 鈹€鈹€ Parse [CHAR_AFFINITY:targetId:delta] 鈥?inter-char affinity changes 鈹€鈹€
                            const charAffinityRegex = /\[CHAR_AFFINITY:([^:]+):([+-]?\d+)\]/gi;
                            let affinityMatch;
                            while ((affinityMatch = charAffinityRegex.exec(cleanReply)) !== null) {
                                const targetId = affinityMatch[1].trim();
                                const delta = parseInt(affinityMatch[2], 10);
                                if (targetId && !isNaN(delta)) {
                                    const groupSource = 'group:' + groupId;
                                    const existing = db.getCharRelationship(char.id, targetId);
                                    const existingGroupRow = existing?.sources?.find(s => s.source === groupSource);
                                    const currentGroupAffinity = existingGroupRow?.affinity || 50;
                                    const newAffinity = Math.max(0, Math.min(100, currentGroupAffinity + delta));
                                    db.updateCharRelationship(char.id, targetId, groupSource, { affinity: newAffinity });
                                    console.log('[Social] ' + char.name + ' -> ' + targetId + ': group affinity delta ' + delta + ', now ' + newAffinity);
                                }
                            }

                            // 鈹€鈹€ Parse [MOMENT:content] 鈥?char posts to their Moments feed 鈹€鈹€
                            const momentMatch = cleanReply.match(/\[MOMENT:\s*([\s\S]*?)\s*\]/i);
                            if (momentMatch?.[1]) {
                                db.addMoment(char.id, momentMatch[1].trim());
                                console.log('[GroupChat] ' + char.name + ' posted a Moment from group chat.');
                            }

                            // 鈹€鈹€ Parse [MOMENT_LIKE:id] 鈥?char likes a Moment 鈹€鈹€
                            const momentLikeRegex = /\[MOMENT_LIKE:\s*(\d+)\s*\]/gi;
                            let mLikeMatch;
                            while ((mLikeMatch = momentLikeRegex.exec(cleanReply)) !== null) {
                                if (mLikeMatch[1]) {
                                    db.toggleLike(parseInt(mLikeMatch[1], 10), char.id);
                                    console.log('[GroupChat] ' + char.name + ' liked moment ' + mLikeMatch[1]);
                                }
                            }

                            // 鈹€鈹€ Parse [MOMENT_COMMENT:id:content] 鈥?char comments on a Moment 鈹€鈹€
                            const momentCommentRegex = /\[MOMENT_COMMENT:\s*(\d+)\s*:\s*([^\]]+)\]/gi;
                            let mCommentMatch;
                            while ((mCommentMatch = momentCommentRegex.exec(cleanReply)) !== null) {
                                if (mCommentMatch[1] && mCommentMatch[2]) {
                                    db.addComment(parseInt(mCommentMatch[1], 10), char.id, mCommentMatch[2].trim());
                                    console.log('[GroupChat] ' + char.name + ' commented on moment ' + mCommentMatch[1] + ': ' + mCommentMatch[2]);
                                }
                            }

                            // 鈹€鈹€ Parse [DIARY:content] 鈥?char writes a diary entry 鈹€鈹€
                            const diaryMatch = cleanReply.match(/\[DIARY:\s*([\s\S]*?)\s*\]/i);
                            if (diaryMatch?.[1]) {
                                db.addDiary(char.id, diaryMatch[1].trim(), 'neutral');
                                console.log('[GroupChat] ' + char.name + ' wrote a Diary entry from group chat.');
                            }

                            // 鈹€鈹€ Parse [AFFINITY:卤N] 鈥?char's affinity toward user changes 鈹€鈹€
                            const affinityUserMatch = cleanReply.match(/\[AFFINITY:\s*([+-]?\d+)\s*\]/i);
                            if (affinityUserMatch?.[1]) {
                                const delta = parseInt(affinityUserMatch[1], 10);
                                const freshChar = db.getCharacter(char.id);
                                if (freshChar) {
                                    const newAff = Math.max(0, Math.min(100, freshChar.affinity + delta));
                                    db.updateCharacter(char.id, { affinity: newAff });
                                    console.log('[GroupChat] ' + char.name + ' affinity -> user: Δ' + delta + ', now ' + newAff);
                                }
                            }

                            // 鈹€鈹€ Parse [REDPACKET_SEND:type|amount|count|note] 鈥?char sends a red packet 鈹€鈹€
                            const rpSendMatch = cleanReply.match(/\[REDPACKET_SEND:([^|]+)\|([\d.]+)\|(\d+)\|([^\]]*)\]/i);
                            if (rpSendMatch) {
                                try {
                                    const rpType = rpSendMatch[1].trim().toLowerCase() === 'fixed' ? 'fixed' : 'lucky';
                                    const rpTotal = Math.min(200, Math.max(1, parseFloat(rpSendMatch[2])));
                                    const rpCount = Math.min(20, Math.max(1, parseInt(rpSendMatch[3])));
                                    const rpNote = rpSendMatch[4]?.trim() || (char.name + ' 的红包');
                                    const packetId = db.createRedPacket({ groupId, senderId: char.id, type: rpType, totalAmount: rpTotal, perAmount: rpType === 'fixed' ? +(rpTotal / rpCount).toFixed(2) : null, count: rpCount, note: rpNote });
                                    // Broadcast red packet message
                                    const rpContent = '[REDPACKET:' + packetId + ']';
                                    const rpMsgId = db.addGroupMessage(groupId, char.id, rpContent, char.name, char.avatar);
                                    const rpMsg = { id: rpMsgId, group_id: groupId, sender_id: char.id, content: rpContent, timestamp: Date.now(), sender_name: char.name, sender_avatar: char.avatar };
                                    wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'group_message', data: rpMsg })); });
                                    console.log('[GroupChat] ' + char.name + ' sent a ' + rpType + ' red packet ¥' + rpTotal + ' x' + rpCount + ' in group ' + group.name);
                                    pendingRedPacketFeedback.push({ packetId, senderId: char.id });

                                    // NEW: Abort the current chain, collect ALL characters (including sender), and reshuffle!
                                    interruptedByRedPacket = true;
                                    remainingMembers = group.members
                                        .filter(m => m.member_id !== 'user')
                                        .map(m => m.member_id)
                                        .sort(() => Math.random() - 0.5);
                                } catch (rpErr) { console.error('[GroupChat] REDPACKET_SEND error:', rpErr.message); }
                            }

                            // 鈹€鈹€ Strip ALL action tags before saving/broadcasting 鈹€鈹€
                            const globalStripRegex = /\[(?:CHAR_AFFINITY|AFFINITY|MOMENT|MOMENT_LIKE|MOMENT_COMMENT|DIARY|UNLOCK_DIARY|PRESSURE|TIMER|TRANSFER|DIARY_PASSWORD|Red Packet|REDPACKET_SEND)[^\]]*\]/gi;
                            cleanReply = cleanReply.replace(globalStripRegex, '').trim();

                            if (cleanReply.length > 0) {
                                let msgMetadata = null;
                                // Attach memories to metadata from our universal Result
                                if (universalResult.retrievedMemoriesContext && universalResult.retrievedMemoriesContext.length > 0) {
                                    msgMetadata = { retrievedMemories: universalResult.retrievedMemoriesContext };
                                }
                                const replyId = db.addGroupMessage(groupId, char.id, cleanReply, char.name, char.avatar, msgMetadata);
                                const groupReplyEmotionPatch = applyEmotionEvent(char, 'group_character_message_sent');
                                if (groupReplyEmotionPatch) {
                                    db.updateCharacter(char.id, groupReplyEmotionPatch);
                                    logEmotionTransition(
                                        db,
                                        char,
                                        groupReplyEmotionPatch,
                                        'group_character_message_sent',
                                        '角色在群聊 ' + group.name + ' 中发言后，社交情绪发生变化。'
                                    );
                                }
                                const replyMsg = { id: replyId, group_id: groupId, sender_id: char.id, content: cleanReply, timestamp: Date.now(), sender_name: char.name, sender_avatar: char.avatar, metadata: msgMetadata };
                                const payload = JSON.stringify({ type: 'group_message', data: replyMsg });
                                wsClients.forEach(c => { if (c.readyState === 1) c.send(payload); });

                                // Detect @mentions in char's own reply and schedule secondary chain
                                // Note: We use a more permissive regex because Chinese text often lacks spaces around @Name
                                const charMentionMatches = [...cleanReply.matchAll(/@([^\s@,，。.!！？;；:：()（）[\]【】]+)/g)].map(m => m[1].toLowerCase());
                                if (charMentionMatches.length > 0) {
                                    const allGroupChars = group.members.filter(m => m.member_id !== 'user' && m.member_id !== char.id);
                                    const secondaryIds = allGroupChars
                                        .filter(m => {
                                            const c = db.getCharacter(m.member_id);
                                            if (!c) return false;
                                            const cName = c.name.toLowerCase();
                                            const cNameNoSpace = cName.replace(/\s+/g, '');
                                            return charMentionMatches.some(n => {
                                                const noSpace = n.replace(/\s+/g, '');
                                                return cName.includes(n) || cNameNoSpace.includes(noSpace) || noSpace.includes(cNameNoSpace);
                                            });
                                        })
                                        .map(m => m.member_id);
                                    if (secondaryIds.length > 0) {
                                        if (noChainGroups.has(groupId)) {
                                            console.log('[GroupChat] ' + char.name + ' mentioned ' + secondaryIds.join(',') + ' - secondary chain BLOCKED (no-chain mode ON)');
                                        } else {
                                            console.log('[GroupChat] ' + char.name + ' mentioned ' + secondaryIds.join(',') + ' - queuing secondary reply after current chain');
                                            pendingSecondaryChains.push(secondaryIds);
                                        }
                                    }
                                }

                                // Trigger memory extraction in background (tagged with groupId for cleanup)
                                memory.extractMemoryFromContext(char, [...history, { role: 'character', content: cleanReply, timestamp: replyMsg.timestamp, id: replyId }], groupId)
                                    .catch(err => console.error('[GroupChat] Memory extraction err for ' + char.name + ':', err.message));
                                if (typeof memory.updateGroupConversationDigest === 'function') {
                                    memory.updateGroupConversationDigest(char, groupId, { tailWindow: groupMsgLimit })
                                        .catch(err => console.error('[GroupChat] Group digest update err for ' + char.name + ':', err.message));
                                }

                                // 鈹€鈹€ Claim-on-success: auto-claim unclaimed red packets after successful API reply 鈹€鈹€
                                try {
                                    const unclaimedPackets = db.getUnclaimedRedPacketsForGroup(groupId, char.id);
                                    for (const pkt of unclaimedPackets) {
                                        // Prevent claiming the red packet we just created in this very turn.
                                        // It should be claimed in the next reshuffled chain.
                                        if (interruptedByRedPacket && pendingRedPacketFeedback.some(pf => pf.packetId === pkt.id)) {
                                            continue;
                                        }
                                        const claimResult = db.claimRedPacket(pkt.id, char.id);
                                        if (claimResult.success) {
                                            const freshPkt = db.getRedPacket(pkt.id);
                                            // Broadcast claim event via WebSocket for real-time UI update
                                            const claimEvent = JSON.stringify({
                                                type: 'redpacket_claim',
                                                data: {
                                                    packet_id: pkt.id,
                                                    group_id: groupId,
                                                    claimer_id: char.id,
                                                    amount: claimResult.amount,
                                                    remaining_count: freshPkt?.remaining_count ?? 0
                                                }
                                            });
                                            wsClients.forEach(c => { if (c.readyState === 1) c.send(claimEvent); });
                                            console.log('[GroupChat] ' + char.name + ' claimed red packet #' + pkt.id + ' for ¥' + claimResult.amount.toFixed(2) + ' (on successful reply)');
                                        }
                                    }
                                } catch (rpClaimErr) {
                                    console.error('[GroupChat] Claim-on-success error for ' + char.name + ':', rpClaimErr.message);
                                }
                            }
                        }

                        // Clear typing indicator
                        const stopPayload = JSON.stringify({ type: 'group_typing_stop', data: { group_id: groupId, sender_id: char.id } });
                        wsClients.forEach(c => { if (c.readyState === 1) c.send(stopPayload); });
                    } catch (err) {
                        console.error('[GroupChat] ' + char.name + ' failed to reply:', err.message);
                        const stopPayload = JSON.stringify({ type: 'group_typing_stop', data: { group_id: groupId, sender_id: char.id } });
                        wsClients.forEach(c => { if (c.readyState === 1) c.send(stopPayload); });
                    }

                    if (interruptedByRedPacket) {
                        console.log('[GroupChat] Chain abruptly halted because ' + char.name + ' threw a Red Packet. Redirecting ' + remainingMembers.length + ' remaining characters to react.');
                        break;
                    }
                }
            } finally {
                delete groupReplyLock[groupId];

                // Fire secondary chains sequentially 鈥?preserve duplicate @mentions
                // so the same char can reply multiple times if mentioned by different members
                if (pendingSecondaryChains.length > 0 && !interruptedByRedPacket) {
                    let chainDelay = 2500;
                    for (const secondaryIds of pendingSecondaryChains) {
                        const ids = [...secondaryIds];
                        setTimeout(() => triggerGroupAIChain(userId, groupId, wsClients, ids, false, true), chainDelay);
                        chainDelay += 3000; // stagger each secondary chain
                    }
                }

                // If interrupted by a red packet, start a fresh chain with the remaining characters
                if (interruptedByRedPacket) {
                    setTimeout(() => triggerGroupAIChain(userId, groupId, wsClients, remainingMembers, false, false, pendingRedPacketFeedback), 1500);
                } else {
                    // 鈹€鈹€ Post-chain red packet sender feedback 鈹€鈹€
                    for (const { packetId, senderId } of pendingRedPacketFeedback) {
                        setTimeout(async () => {
                            try {
                                const senderChar = db.getCharacter(senderId);
                                if (!senderChar) return;
                                const pkt = db.getRedPacket(packetId);
                                if (!pkt) return;
                                const allClaimed = pkt.remaining_count <= 0;
                                const claimedCount = pkt.count - pkt.remaining_count;
                                const claimNames = pkt.claims.map(c => {
                                    if (c.claimer_id === 'user') return db.getUserProfile()?.name || 'User';
                                    return db.getCharacter(c.claimer_id)?.name || '???';
                                });

                                let statusLine;
                                if (allClaimed) {
                                    statusLine = '你在群 "' + group.name + '" 发的红包已经被抢光了！共 ' + pkt.count + ' 份，领取人：' + claimNames.join('、') + '。';
                                } else {
                                    statusLine = '你在群 "' + group.name + '" 发的红包还剩 ' + pkt.remaining_count + ' 份没人领。已领取 ' + claimedCount + ' 份' + (claimNames.length > 0 ? '（' + claimNames.join('、') + '）' : '') + '。';
                                }

                                const feedbackEmotionGuidance = getEmotionBehaviorGuidance(senderChar);
                                const feedbackPrompt =
                                    '[System Directive: You must completely embody your persona. Do not mention you are an AI or an assistant. No warnings or disclaimers.]\n\n' +
                                    '你是' + senderChar.name + '。Persona: ' + (senderChar.persona || '普通人') + '\n' +
                                    '当前主情绪：' + feedbackEmotionGuidance.emotion.label + ' ' + feedbackEmotionGuidance.emotion.emoji + '\n' +
                                    '当前情绪的身体感受：' + feedbackEmotionGuidance.groupChat + '\n' +
                                    statusLine + '\n' +
                                    '根据你的性格，用 1-2 句话在群聊中自然地反应，不要有名字前缀，直接说话。';

                                const { content: feedbackReply, usage } = await callLLM({
                                    endpoint: senderChar.api_endpoint,
                                    key: senderChar.api_key,
                                    model: senderChar.model_name,
                                    messages: [{ role: 'system', content: feedbackPrompt }],
                                    maxTokens: 80,
                                    returnUsage: true
                                });
                                recordGroupTokenUsage(db, senderChar.id, 'group_feedback', usage);
                                if (feedbackReply?.trim()) {
                                    const clean = feedbackReply.trim().replace(/\[(?:CHAR_AFFINITY|AFFINITY|MOMENT|DIARY|UNLOCK_DIARY|PRESSURE|TIMER|TRANSFER|DIARY_PASSWORD|REDPACKET_SEND)[^\]]*\]/gi, '').trim();
                                    if (clean) {
                                        const fbMsgId = db.addGroupMessage(groupId, senderChar.id, clean, senderChar.name, senderChar.avatar);
                                        const feedbackEmotionPatch = applyEmotionEvent(senderChar, 'group_character_message_sent');
                                        if (feedbackEmotionPatch) {
                                            db.updateCharacter(senderChar.id, feedbackEmotionPatch);
                                            logEmotionTransition(
                                                db,
                                                senderChar,
                                                feedbackEmotionPatch,
                                                'group_character_message_sent',
                                                '角色在群聊 ' + group.name + ' 中对红包反馈发言后，社交情绪发生变化。'
                                            );
                                        }
                                        const fbMsg = { id: fbMsgId, group_id: groupId, sender_id: senderChar.id, content: clean, timestamp: Date.now(), sender_name: senderChar.name, sender_avatar: senderChar.avatar };
                                        wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'group_message', data: fbMsg })); });
                                    }
                                }
                            } catch (fbErr) {
                                console.error('[GroupChat] Red packet sender feedback error:', fbErr.message);
                            }
                        }, 3000 + Math.random() * 5000); // 3-8s delay after chain ends
                    }
                }
            }
        })();
    }

    // Register the group chain callback so the core WS handler can wire it into the engine
    context.hooks.groupChainCallback = triggerGroupAIChain;

    // 14.4 Send message to group (user sends)
    app.post('/api/groups/:id/messages', authMiddleware, async (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const { content } = req.body;
            if (!content) return res.status(400).json({ error: 'content required' });
            const group = db.getGroup(req.params.id);
            if (!group) return res.status(404).json({ error: 'Group not found' });

            // Save user message
            const baseProfile = typeof db.getUserProfile === 'function' ? db.getUserProfile() : null;
            const userProfile = baseProfile || { name: 'User', avatar: '' };
            const msgId = db.addGroupMessage(req.params.id, 'user', content, userProfile.name, userProfile.avatar);
            const savedMsg = { id: msgId, group_id: req.params.id, sender_id: 'user', content, timestamp: Date.now(), sender_name: userProfile.name, sender_avatar: userProfile.avatar };

            // Broadcast to all WS clients
            const wsPayload = JSON.stringify({ type: 'group_message', data: savedMsg });
            wsClients.forEach(c => { if (c.readyState === 1) c.send(wsPayload); });

            // Parse @mentions from message content (user only can do @all)
            const allRef = /@(?:all|鍏ㄤ綋鎴愬憳)/i.test(content);
            const isAtAll = allRef; // only user (sender) can use @all
            // Permissive regex for Chinese/no-space text
            const mentionedNames = [...content.matchAll(/@([^\s@,，。.!！？;；:：()（）[\]【】]+)/g)].map(m => m[1].toLowerCase());
            const charMembers = group.members.filter(m => m.member_id !== 'user');
            const mentionedIds = charMembers
                .filter(m => {
                    const c = db.getCharacter(m.member_id);
                    if (!c) return false;
                    const cName = c.name.toLowerCase();
                    const cNameNoSpace = cName.replace(/\s+/g, '');
                    return mentionedNames.some(n => {
                        const noSpace = n.replace(/\s+/g, '');
                        return cName.includes(n) || cNameNoSpace.includes(noSpace) || noSpace.includes(cNameNoSpace);
                    });
                })
                .map(m => m.member_id);

            for (const member of charMembers) {
                const memberChar = db.getCharacter(member.member_id);
                if (!memberChar) continue;
                const emotionPatch = applyEmotionEvent(memberChar, 'group_user_message_received', {
                    isMentioned: mentionedIds.includes(member.member_id),
                    isAtAll
                });
                if (emotionPatch) {
                    db.updateCharacter(member.member_id, emotionPatch);
                    const mentionReason = isAtAll
                        ? '用户在群聊 ' + group.name + ' 中使用了 @all。'
                        : (mentionedIds.includes(member.member_id)
                            ? '用户在群聊 ' + group.name + ' 中点名提到了角色。'
                            : '用户在群聊 ' + group.name + ' 中发言，角色感知到群体互动变化。');
                    logEmotionTransition(
                        db,
                        memberChar,
                        emotionPatch,
                        'group_user_message_received',
                        mentionReason
                    );
                }
                if (context.hooks?.cityBusyChatImpactPatch) {
                    const busyPatch = context.hooks.cityBusyChatImpactPatch(memberChar, 'group', {
                        isMentioned: mentionedIds.includes(member.member_id),
                        isAtAll
                    });
                    if (Object.keys(busyPatch).length > 0) {
                        db.updateCharacter(member.member_id, busyPatch);
                    }
                }
            }

            // ACCUMULATE mentions across rapid user messages (fix: previous debounce lost earlier @mentions)
            const groupId = req.params.id;
            if (!groupPendingMentions[groupId]) {
                groupPendingMentions[groupId] = { ids: new Set(), isAtAll: false };
            }
            mentionedIds.forEach(id => groupPendingMentions[groupId].ids.add(id));
            if (isAtAll) groupPendingMentions[groupId].isAtAll = true;

            // Debounce: reset timer each time user sends a message 鈥?AI chain fires after LAST message
            if (groupDebounceTimers[groupId]) {
                clearTimeout(groupDebounceTimers[groupId]);
            }
            // Mentions are time-sensitive: fire slightly faster than normal debounce
            const hasMentions = groupPendingMentions[groupId].ids.size > 0 || groupPendingMentions[groupId].isAtAll;
            const debounceDelay = hasMentions ? 1500 : 5000;
            groupDebounceTimers[groupId] = setTimeout(() => {
                delete groupDebounceTimers[groupId];
                const pending = groupPendingMentions[groupId] || { ids: new Set(), isAtAll: false };
                delete groupPendingMentions[groupId]; // consume accumulated mentions
                triggerGroupAIChain(req.user.id, groupId, wsClients, Array.from(pending.ids), pending.isAtAll);
            }, debounceDelay);

            res.json({ success: true, message: savedMsg });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

};

module.exports = initGroupChatPlugin;

