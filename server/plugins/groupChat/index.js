module.exports = function initGroupChat(app, context) {
    const {
        wss, getWsClients, authDb, authMiddleware,
        getUserDb, getEngine, getMemory, callLLM
    } = context;

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
            const { inject_limit, name } = req.body;
            // Use raw SQL update since db wrapper doesn't have updateGroup
            const updates = [];
            const values = [];
            if (inject_limit !== undefined) { updates.push('inject_limit = ?'); values.push(Math.max(0, parseInt(inject_limit) || 0)); }
            if (name !== undefined && name.trim()) { updates.push('name = ?'); values.push(name.trim()); }
            if (updates.length > 0) {
                values.push(req.params.id);
                db.rawRun(`UPDATE group_chats SET ${updates.join(', ')} WHERE id = ?`, values);
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

    // 14.5 Hide/Unhide group messages (context hide mechanic)
    app.post('/api/groups/:id/messages/hide', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const { start, end } = req.body;
            const hidden = db.hideGroupMessagesByRange(req.params.id, start, end);
            res.json({ success: true, hidden });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/groups/:id/messages/unhide', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const unhidden = db.unhideGroupMessages(req.params.id);
            res.json({ success: true, unhidden });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 14.6 Add member to group
    app.post('/api/groups/:id/members', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const { member_id } = req.body;
            if (!member_id) return res.status(400).json({ error: 'member_id is required' });
            db.addGroupMember(req.params.id, member_id);
            res.json({ success: true, group: db.getGroup(req.params.id) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 14.7 Kick member from group
    app.delete('/api/groups/:id/members/:memberId', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const memory = getMemory(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            db.removeGroupMember(req.params.id, req.params.memberId);
            res.json({ success: true, group: db.getGroup(req.params.id) });
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

    // ─── Group Chat Debounce System ─────────────────────────────────────────
    // When user sends multiple messages quickly, we wait until they stop, then fire ONE AI reply chain.
    const groupDebounceTimers = {}; // { groupId: timeoutHandle }
    const groupReplyLock = {};
    const groupInterrupt = {};     // { groupId: true } — prevent overlapping chains
    const pausedGroups = new Set(); // groups where AI replies are paused by user
    const noChainGroups = new Set(); // groups where AI→AI secondary @-mention chains are blocked
    const groupPendingMentions = {}; // { groupId: { ids: Set, isAtAll: bool } } — accumulates mentions across debounce resets

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

    // 14.11 Toggle AI→AI secondary @-mention chain for a group
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

    function triggerGroupAIChain(userId, groupId, wsClients, mentionedIds = [], isAtAll = false, isSecondaryChain = false) {
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
            const pendingRedPacketFeedback = []; // collect { packetId, senderId } for post-chain sender reaction
            try {
                for (const member of mentionedFirst) {
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
                        const groupMsgLimit = 20;
                        const recentGroupMsgs = db.getVisibleGroupMessages(groupId, groupMsgLimit);
                        const userName = userProfile?.name || 'User';

                        const history = recentGroupMsgs.map(m => {
                            const senderName = m.sender_id === 'user' ? userName : (db.getCharacter(m.sender_id)?.name || m.sender_name || 'Unknown');
                            return { role: m.sender_id === char.id ? 'assistant' : 'user', content: `[${senderName}]: ${m.content} ` };
                        });

                        // Build relationship-aware member descriptions
                        const otherMembers = group.members.filter(m => m.member_id !== char.id);
                        const knownMembers = [];
                        const unknownMembers = [];

                        for (const m of otherMembers) {
                            if (m.member_id === 'user') {
                                const userRel = db.getCharRelationship(char.id, 'user');
                                knownMembers.push(`- ${userName} (id: user, 好感度: ${userRel?.affinity ?? char.affinity ?? 50})`);
                                continue;
                            }
                            const otherChar = db.getCharacter(m.member_id);
                            if (!otherChar) continue;
                            const rel = db.getCharRelationship(char.id, otherChar.id);
                            if (rel && rel.isAcquainted) {
                                knownMembers.push(`- ${otherChar.name} (id: ${otherChar.id}, 好感度: ${rel.affinity}, 印象: "${rel.impression}")`);
                            } else {
                                unknownMembers.push(`- ${otherChar.name} (id: ${otherChar.id}, 你不认识这个人，只知道名字)`);
                            }
                        }

                        let relationSection = '';
                        if (knownMembers.length > 0) {
                            relationSection += `\n你认识的人：\n${knownMembers.join('\n')} `;
                        }
                        if (unknownMembers.length > 0) {
                            relationSection += `\n你不认识的人：\n${unknownMembers.join('\n')} `;
                        }

                        // List char's own recent messages to prevent repetition
                        const charOwnRecent = recentGroupMsgs
                            .filter(m => m.sender_id === char.id)
                            .slice(-3)
                            .map(m => `"${m.content}"`)
                            .join(', ');
                        const noRepeatNote = charOwnRecent
                            ? `\nIMPORTANT: You recently said: ${charOwnRecent}. Do NOT repeat or paraphrase these.Say something new.`
                            : '';
                        const mentionNote = isMentioned
                            ? `\n[MENTION]: Someone just @mentioned you directly! You MUST reply to this message — don't ignore it.`
                            : '';

                        // 1+2 Hybrid Hidden Context Injection
                        const hiddenState = db.getCharacterHiddenState(char.id);
                        const privateLimit = userProfile?.private_msg_limit_for_group ?? 3;
                        const recentPrivateMsgs = privateLimit > 0 ? db.getMessages(char.id, privateLimit).reverse() : [];
                        let secretContextStr = '';
                        if (hiddenState || recentPrivateMsgs.length > 0) {
                            const pmLines = recentPrivateMsgs.map(m => `${m.role === 'user' ? userName : char.name}: ${m.content}`).join('\n');
                            secretContextStr = `\n\n====== [CRITICAL: ABSOLUTELY SECRET PRIVATE CONTEXT] ======`;
                            if (hiddenState) secretContextStr += `\n[YOUR HIDDEN MOOD/SECRET THOUGHT]: ${hiddenState}`;
                            if (pmLines) secretContextStr += `\n[RECENT PRIVATE CHAT INBOX (For Context ONLY)]:\n${pmLines}`;
                            secretContextStr += `\n\n[CRITICAL PRIVATE CONTEXT]: The above is your private memory and hidden mood with the User. You can choose whether to keep this a secret, casually mention it, or directly reveal it in the public group, depending entirely on your persona and the conversation flow.\n==========================================================`;
                        }

                        // Cross-group context injection: inject messages from OTHER groups this char is in
                        let crossGroupContext = '';
                        try {
                            const allGroups = db.getGroups();
                            const otherGroups = allGroups.filter(g => g.id !== groupId && g.members.some(m => m.member_id === char.id));
                            for (const og of otherGroups) {
                                const ogLimit = og.inject_limit ?? 5;
                                if (ogLimit <= 0) continue;
                                const ogMsgs = db.getGroupMessages(og.id, ogLimit);
                                if (ogMsgs.length > 0) {
                                    crossGroupContext += `\n[你也在群聊"${og.name}"中，以下是最近的消息]:\n`;
                                    for (const m of ogMsgs) {
                                        const sName = m.sender_id === 'user' ? userName : (db.getCharacter(m.sender_id)?.name || m.sender_name || '?');
                                        crossGroupContext += `  - ${sName}: ${m.content.substring(0, 80)}\n`;
                                    }
                                }
                            }
                        } catch (e) { console.error('[GroupChat] Cross-group injection error:', e.message); }

                        // Time context (matches private chat's time awareness)
                        const now = new Date();
                        const hour = now.getHours();
                        const isWeekend = now.getDay() === 0 || now.getDay() === 6;
                        let timeOfDay = '白天';
                        if (hour >= 5 && hour < 10) timeOfDay = '早上';
                        else if (hour >= 10 && hour < 14) timeOfDay = '中午';
                        else if (hour >= 14 && hour < 18) timeOfDay = '下午';
                        else if (hour >= 18 && hour < 22) timeOfDay = '晚上';
                        else timeOfDay = '深夜';
                        const timeContext = `当前时间: ${timeOfDay} (${now.toLocaleTimeString()})${isWeekend ? ', 周末' : ', 工作日'}`;

                        const momentsTokenLimit = userProfile?.moments_token_limit ?? 1000;
                        const momentsContext = db.getMomentsContextForChar ? db.getMomentsContextForChar(char.id, momentsTokenLimit) : '';

                        const systemPrompt = `你是${char.name}，正在一个叫"${group.name}"的【群聊】中聊天。
（注意：这是群聊，不是私聊。）
${timeContext}

Persona: ${char.persona || 'No specific persona.'}
${relationSection}
${noRepeatNote}${mentionNote}${secretContextStr}${crossGroupContext}
${momentsContext}

Guidelines:
1. Stay in character. Be casual and conversational.
2. You are chatting in a group. Keep messages short (1-2 sentences).
3. React naturally to the conversation. Don't force responses.
4. DO NOT prefix your message with your name or any brackets. Just speak naturally.
5. Output ONLY your reply text. Never repeat what you just said.
6. [IMPORTANT - 好感度变化] After EVERY reply, evaluate if your feelings toward anyone in the group changed, and if so add the tag. Use the EXACT member IDs shown in the member list above. Examples:
   - Someone agreed with you or helped you → [CHAR_AFFINITY:their_id:+3]
   - Someone made you laugh or complimented you → [CHAR_AFFINITY:their_id:+5]
   - Someone disagreed or argued with you → [CHAR_AFFINITY:their_id:-2]
   - Someone mocked, insulted, or ignored you → [CHAR_AFFINITY:their_id:-5]
   - Someone said something interesting → [CHAR_AFFINITY:their_id:+1]
   - Neutral interaction, no strong feelings → no tag needed
   You SHOULD output this tag frequently (in most messages). Even tiny +1/-1 changes count. Multiple tags are OK if multiple people are involved.
7. CRITICAL: DO NOT use @Name just to mention someone's name in passing. ONLY use "@Name" (e.g. "@${userName} ...", "@${charMembers.map(m => db.getCharacter(m.member_id)?.name).filter(Boolean).join('", "@')}") when you EXPLICITLY want that specific person to reply to you right now. If you are just agreeing with them or talking about them, do not use the @ symbol.
8. 如果你想在群里发拼手气红包（庆祝、表达大方、节日气氛等），在消息末尾加：[REDPACKET_SEND:lucky|总金额|份数|留言]。例如 [REDPACKET_SEND:lucky|50|5|新年快乐]。注意金额要合理（1-200之间），不要频繁发。
9. 如果你想发朋友圈，在消息末尾加：[MOMENT:内容]。
10. 如果你想给某人的朋友圈点赞，在消息末尾加：[MOMENT_LIKE:朋友圈ID]。
11. 如果你想评论某人的朋友圈，在消息末尾加：[MOMENT_COMMENT:朋友圈ID:评论内容]。`;

                        const reply = await callLLM({
                            endpoint: char.api_endpoint,
                            key: char.api_key,
                            model: char.model_name,
                            messages: [{ role: 'system', content: systemPrompt }, ...history],
                            maxTokens: char.max_tokens || 500
                        });


                        if (reply && reply.trim()) {
                            let cleanReply = reply.trim();

                            // ── Parse [CHAR_AFFINITY:targetId:delta] — inter-char affinity changes ──
                            const charAffinityRegex = /\[CHAR_AFFINITY:([^:]+):([+-]?\d+)\]/gi;
                            let affinityMatch;
                            while ((affinityMatch = charAffinityRegex.exec(cleanReply)) !== null) {
                                const targetId = affinityMatch[1].trim();
                                const delta = parseInt(affinityMatch[2], 10);
                                if (targetId && !isNaN(delta)) {
                                    const groupSource = `group:${groupId}`;
                                    const existing = db.getCharRelationship(char.id, targetId);
                                    const existingGroupRow = existing?.sources?.find(s => s.source === groupSource);
                                    const currentGroupAffinity = existingGroupRow?.affinity || 50;
                                    const newAffinity = Math.max(0, Math.min(100, currentGroupAffinity + delta));
                                    db.updateCharRelationship(char.id, targetId, groupSource, { affinity: newAffinity });
                                    console.log(`[Social] ${char.name} → ${targetId}: group affinity delta ${delta}, now ${newAffinity}`);
                                }
                            }

                            // ── Parse [MOMENT:content] — char posts to their Moments feed ──
                            const momentMatch = cleanReply.match(/\[MOMENT:\s*([\s\S]*?)\s*\]/i);
                            if (momentMatch?.[1]) {
                                db.addMoment(char.id, momentMatch[1].trim());
                                console.log(`[GroupChat] ${char.name} posted a Moment from group chat.`);
                            }

                            // ── Parse [MOMENT_LIKE:id] — char likes a Moment ──
                            const momentLikeRegex = /\[MOMENT_LIKE:\s*(\d+)\s*\]/gi;
                            let mLikeMatch;
                            while ((mLikeMatch = momentLikeRegex.exec(cleanReply)) !== null) {
                                if (mLikeMatch[1]) {
                                    db.toggleLike(parseInt(mLikeMatch[1], 10), char.id);
                                    console.log(`[GroupChat] ${char.name} liked moment ${mLikeMatch[1]}`);
                                }
                            }

                            // ── Parse [MOMENT_COMMENT:id:content] — char comments on a Moment ──
                            const momentCommentRegex = /\[MOMENT_COMMENT:\s*(\d+)\s*:\s*([^\]]+)\]/gi;
                            let mCommentMatch;
                            while ((mCommentMatch = momentCommentRegex.exec(cleanReply)) !== null) {
                                if (mCommentMatch[1] && mCommentMatch[2]) {
                                    db.addComment(parseInt(mCommentMatch[1], 10), char.id, mCommentMatch[2].trim());
                                    console.log(`[GroupChat] ${char.name} commented on moment ${mCommentMatch[1]}: ${mCommentMatch[2]}`);
                                }
                            }

                            // ── Parse [DIARY:content] — char writes a diary entry ──
                            const diaryMatch = cleanReply.match(/\[DIARY:\s*([\s\S]*?)\s*\]/i);
                            if (diaryMatch?.[1]) {
                                db.addDiary(char.id, diaryMatch[1].trim(), 'neutral');
                                console.log(`[GroupChat] ${char.name} wrote a Diary entry from group chat.`);
                            }

                            // ── Parse [AFFINITY:±N] — char's affinity toward user changes ──
                            const affinityUserMatch = cleanReply.match(/\[AFFINITY:\s*([+-]?\d+)\s*\]/i);
                            if (affinityUserMatch?.[1]) {
                                const delta = parseInt(affinityUserMatch[1], 10);
                                const freshChar = db.getCharacter(char.id);
                                if (freshChar) {
                                    const newAff = Math.max(0, Math.min(100, freshChar.affinity + delta));
                                    db.updateCharacter(char.id, { affinity: newAff });
                                    console.log(`[GroupChat] ${char.name} affinity → user: Δ${delta}, now ${newAff}`);
                                }
                            }

                            // ── Parse [REDPACKET_SEND:type|amount|count|note] — char sends a red packet ──
                            const rpSendMatch = cleanReply.match(/\[REDPACKET_SEND:([^|]+)\|([\d.]+)\|(\d+)\|([^\]]*)\]/i);
                            if (rpSendMatch) {
                                try {
                                    const rpType = rpSendMatch[1].trim().toLowerCase() === 'fixed' ? 'fixed' : 'lucky';
                                    const rpTotal = Math.min(200, Math.max(1, parseFloat(rpSendMatch[2])));
                                    const rpCount = Math.min(20, Math.max(1, parseInt(rpSendMatch[3])));
                                    const rpNote = rpSendMatch[4]?.trim() || `${char.name}的红包`;
                                    const packetId = db.createRedPacket({ groupId, senderId: char.id, type: rpType, totalAmount: rpTotal, perAmount: rpType === 'fixed' ? +(rpTotal / rpCount).toFixed(2) : null, count: rpCount, note: rpNote });
                                    // Broadcast red packet message
                                    const rpContent = `[REDPACKET:${packetId}]`;
                                    const rpMsgId = db.addGroupMessage(groupId, char.id, rpContent, char.name, char.avatar);
                                    const rpMsg = { id: rpMsgId, group_id: groupId, sender_id: char.id, content: rpContent, timestamp: Date.now(), sender_name: char.name, sender_avatar: char.avatar };
                                    wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'group_message', data: rpMsg })); });
                                    console.log(`[GroupChat] ${char.name} sent a ${rpType} red packet ¥${rpTotal} x${rpCount} in group ${group.name}`);
                                    pendingRedPacketFeedback.push({ packetId, senderId: char.id });
                                } catch (rpErr) { console.error(`[GroupChat] REDPACKET_SEND error:`, rpErr.message); }
                            }

                            // ── Strip ALL action tags before saving/broadcasting ──
                            const globalStripRegex = /\[(?:CHAR_AFFINITY|AFFINITY|MOMENT|MOMENT_LIKE|MOMENT_COMMENT|DIARY|UNLOCK_DIARY|PRESSURE|TIMER|TRANSFER|DIARY_PASSWORD|Red Packet|REDPACKET_SEND)[^\]]*\]/gi;
                            cleanReply = cleanReply.replace(globalStripRegex, '').trim();

                            if (cleanReply.length > 0) {
                                const replyId = db.addGroupMessage(groupId, char.id, cleanReply, char.name, char.avatar);
                                const replyMsg = { id: replyId, group_id: groupId, sender_id: char.id, content: cleanReply, timestamp: Date.now(), sender_name: char.name, sender_avatar: char.avatar };
                                const payload = JSON.stringify({ type: 'group_message', data: replyMsg });
                                wsClients.forEach(c => { if (c.readyState === 1) c.send(payload); });

                                // Detect @mentions in char's own reply and schedule secondary chain
                                // Note: We use a more permissive regex because Chinese text often lacks spaces around @Name
                                const charMentionMatches = [...cleanReply.matchAll(/@([^\s@，。！？；：“”‘’（）【】《》]+)/g)].map(m => m[1].toLowerCase());
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
                                            console.log(`[GroupChat] ${char.name} mentioned ${secondaryIds.join(',')} — secondary chain BLOCKED (no-chain mode ON)`);
                                        } else {
                                            console.log(`[GroupChat] ${char.name} mentioned ${secondaryIds.join(',')} — queuing secondary reply after current chain`);
                                            pendingSecondaryChains.push(secondaryIds);
                                        }
                                    }
                                }

                                // Trigger memory extraction in background (tagged with groupId for cleanup)
                                memory.extractMemoryFromContext(char, history.map(h => ({ role: h.role, content: h.content })), groupId)
                                    .catch(err => console.error(`[GroupChat] Memory extraction err for ${char.name}:`, err.message));

                                // ── Claim-on-success: auto-claim unclaimed red packets after successful API reply ──
                                try {
                                    const unclaimedPackets = db.getUnclaimedRedPacketsForGroup(groupId, char.id);
                                    for (const pkt of unclaimedPackets) {
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
                                            console.log(`[GroupChat] ${char.name} claimed red packet #${pkt.id} for ¥${claimResult.amount.toFixed(2)} (on successful reply)`);
                                        }
                                    }
                                } catch (rpClaimErr) {
                                    console.error(`[GroupChat] Claim-on-success error for ${char.name}:`, rpClaimErr.message);
                                }
                            }
                        }

                        // Clear typing indicator
                        const stopPayload = JSON.stringify({ type: 'group_typing_stop', data: { group_id: groupId, sender_id: char.id } });
                        wsClients.forEach(c => { if (c.readyState === 1) c.send(stopPayload); });
                    } catch (err) {
                        console.error(`[GroupChat] ${char.name} failed to reply:`, err.message);
                        const stopPayload = JSON.stringify({ type: 'group_typing_stop', data: { group_id: groupId, sender_id: char.id } });
                        wsClients.forEach(c => { if (c.readyState === 1) c.send(stopPayload); });
                    }
                }
            } finally {
                delete groupReplyLock[groupId];

                // Deduplicate and merge all pending secondary mentions
                const uniqueSecondaryIds = new Set();
                for (const secondaryIds of pendingSecondaryChains) {
                    secondaryIds.forEach(id => uniqueSecondaryIds.add(id));
                }

                // Fire the merged secondary chain if anyone was mentioned
                if (uniqueSecondaryIds.size > 0) {
                    const mergedIds = Array.from(uniqueSecondaryIds);
                    // Wait slightly longer to ensure lock and typing UI are fully cleared
                    setTimeout(() => triggerGroupAIChain(userId, groupId, wsClients, mergedIds, false, true), 2500);
                }

                // ── Post-chain red packet sender feedback ──
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
                                statusLine = `你在群"${group.name}"发的红包已经被抢光了！共${pkt.count}份，领取人：${claimNames.join('、')}。`;
                            } else {
                                statusLine = `你在群"${group.name}"发的红包还剩${pkt.remaining_count}份没人领。已领取${claimedCount}份${claimNames.length > 0 ? '（' + claimNames.join('、') + '）' : ''}。`;
                            }

                            const feedbackPrompt = `你是${senderChar.name}。Persona: ${senderChar.persona || '无'}
${statusLine}
根据你的性格，用1-2句话在群聊中自然地反应。不要有名字前缀，直接说话。`;

                            const feedbackReply = await callLLM({
                                endpoint: senderChar.api_endpoint,
                                key: senderChar.api_key,
                                model: senderChar.model_name,
                                messages: [{ role: 'system', content: feedbackPrompt }],
                                maxTokens: 80
                            });
                            if (feedbackReply?.trim()) {
                                const clean = feedbackReply.trim().replace(/\[(?:CHAR_AFFINITY|AFFINITY|MOMENT|DIARY|UNLOCK_DIARY|PRESSURE|TIMER|TRANSFER|DIARY_PASSWORD|REDPACKET_SEND)[^\]]*\]/gi, '').trim();
                                if (clean) {
                                    const fbMsgId = db.addGroupMessage(groupId, senderChar.id, clean, senderChar.name, senderChar.avatar);
                                    const fbMsg = { id: fbMsgId, group_id: groupId, sender_id: senderChar.id, content: clean, timestamp: Date.now(), sender_name: senderChar.name, sender_avatar: senderChar.avatar };
                                    wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'group_message', data: fbMsg })); });
                                }
                            }
                        } catch (fbErr) {
                            console.error(`[GroupChat] Red packet sender feedback error:`, fbErr.message);
                        }
                    }, 3000 + Math.random() * 5000); // 3-8s delay after chain ends
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
            const allRef = /@(?:all|全体成员)/i.test(content);
            const isAtAll = allRef; // only user (sender) can use @all
            // Permissive regex for Chinese/no-space text
            const mentionedNames = [...content.matchAll(/@([^\s@，。！？；：“”‘’（）【】《》]+)/g)].map(m => m[1].toLowerCase());
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

            // ACCUMULATE mentions across rapid user messages (fix: previous debounce lost earlier @mentions)
            const groupId = req.params.id;
            if (!groupPendingMentions[groupId]) {
                groupPendingMentions[groupId] = { ids: new Set(), isAtAll: false };
            }
            mentionedIds.forEach(id => groupPendingMentions[groupId].ids.add(id));
            if (isAtAll) groupPendingMentions[groupId].isAtAll = true;

            // Debounce: reset timer each time user sends a message — AI chain fires after LAST message
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
