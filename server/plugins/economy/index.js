/**
 * Economy DLC — Private Transfers, Wallet, Red Packets
 * Extracted from server/index.js
 */
module.exports = function initEconomy(app, context) {
    const { authMiddleware, getUserDb, getEngine, getMemory, getWsClients, callLLM } = context;
    const MAX_RED_PACKET_COUNT = 100;

    function normalizePositiveMoney(value) {
        const amount = Number(value);
        if (!Number.isFinite(amount) || amount <= 0) return null;
        return +amount.toFixed(2);
    }

    function normalizePaymentNote(value) {
        if (value === undefined || value === null) return '';
        if (typeof value !== 'string') return null;
        return value.trim().slice(0, 120);
    }

    function normalizePacketCount(value) {
        const text = String(value ?? '').trim();
        if (!/^\d+$/.test(text)) return null;
        const parsed = Number(text);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_RED_PACKET_COUNT) return null;
        return parsed;
    }

    function normalizeRedPacketId(value) {
        const id = Number(value);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    }

    function normalizeTransferId(value) {
        const id = Number(value);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    }

    // ─── Private Transfer APIs ────────────────────────────────────────────────

    // Get transfer info
    app.get('/api/transfers/:tid', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const transferId = normalizeTransferId(req.params.tid);
            if (!transferId) return res.status(400).json({ error: 'Invalid transfer id' });
            const t = db.getTransfer(transferId);
            if (!t) return res.status(404).json({ error: 'Transfer not found' });
            res.json(t);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Claim a private transfer (recipient clicks "Claim")
    app.post('/api/transfers/:tid/claim', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const claimer_id = 'user';
            const transferId = normalizeTransferId(req.params.tid);
            if (!transferId) return res.status(400).json({ error: 'Invalid transfer id' });
            const result = db.claimTransfer(transferId, claimer_id);
            if (result.success) {
                engine.broadcastWalletSync(wsClients, db.getTransfer(transferId)?.char_id || null);
                res.json({ success: true, amount: result.amount, wallet: db.getWallet(claimer_id) });

                // If char claimed user's transfer, trigger a short reaction message
                if (claimer_id !== 'user') {
                    const t = db.getTransfer(transferId);
                    if (t) {
                        setTimeout(async () => {
                            try {
                                const char = db.getCharacter(claimer_id);
                                if (!char) return;
                                const userProfile = db.getUserProfile();
                                const reactionPrompt = `[System Directive: You must completely embody your persona. Do not mention you are an AI or an assistant. No warnings or disclaimers.]

你是${char.name}。Persona: ${char.persona || '无'}
${userProfile?.name || 'User'} 给你转账了 ¥${result.amount.toFixed(2)}，留言：「${t.note || '无'}」。根据你的性格用1-2句自然地回应这笔转账（感谢、惊喜、暖心等）。不要有名字前缀，直接说话。`;
                                const reply = await callLLM({ endpoint: char.api_endpoint, key: char.api_key, model: char.model_name, messages: [{ role: 'system', content: reactionPrompt }, { role: 'user', content: '请回应。' }], maxTokens: 80 });
                                if (reply?.trim()) {
                                    const clean = reply.trim().replace(/\[(?:AFFINITY|PRESSURE|TIMER|MOMENT|DIARY)[^\]]*\]/gi, '').trim();
                                    if (clean) {
                                        const { id: rid, timestamp: rts } = db.addMessage(char.id, 'character', clean);
                                        const claimMsg = { id: rid, character_id: char.id, role: 'character', content: clean, timestamp: rts };
                                        wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'new_message', data: claimMsg })); });
                                    }
                                }
                            } catch (e) { console.error('[Transfer] char reaction error:', e.message); }
                        }, 2000 + Math.random() * 5000);
                    }
                }
            } else {
                res.status(400).json({ success: false, error: result.error });
            }
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // Refund a private transfer (FIXED: includes time elapsed + recent conversation context)
    app.post('/api/transfers/:tid/refund', authMiddleware, async (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const refunder_id = 'user';
            const tid = normalizeTransferId(req.params.tid);
            if (!tid) return res.status(400).json({ error: 'Invalid transfer id' });
            const t = db.getTransfer(tid);
            if (!t) return res.status(404).json({ error: 'Transfer not found' });

            const result = db.refundTransfer(tid, refunder_id);
            if (!result.success) return res.status(400).json({ success: false, error: result.error });

            engine.broadcastWalletSync(wsClients, t.char_id);
            res.json({ success: true, amount: result.amount, wallet: db.getWallet(t.sender_id) });

            // Trigger char reaction to refund (ENHANCED: time elapsed + conversation context)
            const charId = t.char_id;
            const char = db.getCharacter(charId);
            if (!char) return;

            setTimeout(async () => {
                try {
                    const userProfile = db.getUserProfile();
                    const userName = userProfile?.name || 'User';

                    // Calculate how long ago the transfer was sent
                    const elapsedMs = Date.now() - (t.created_at || Date.now());
                    const elapsedMins = Math.round(elapsedMs / 60000);
                    let timeAgoStr;
                    if (elapsedMins < 2) timeAgoStr = '刚才';
                    else if (elapsedMins < 60) timeAgoStr = `${elapsedMins}分钟前`;
                    else if (elapsedMins < 1440) timeAgoStr = `${Math.round(elapsedMins / 60)}小时前`;
                    else timeAgoStr = `${Math.round(elapsedMins / 1440)}天前`;

                    // Get recent conversation context so the reaction feels natural
                    const recentMsgs = db.getVisibleMessages(charId, 5);
                    const recentContext = recentMsgs.map(m => `${m.role === 'user' ? userName : char.name}: ${m.content.substring(0, 60)}`).join('\n');

                    let reactionPrompt;
                    if (refunder_id === 'user') {
                        // User refunded char's transfer back to char
                        reactionPrompt = `[System Directive: You must completely embody your persona. Do not mention you are an AI or an assistant. No warnings or disclaimers.]

你是${char.name}。Persona: ${char.persona || '无'}
你在${timeAgoStr}给 ${userName} 发了一笔 ¥${result.amount.toFixed(2)} 的转账，留言「${t.note || '无'}」，但对方刚刚把转账退还给你了。

最近的对话：
${recentContext || '（无）'}

根据你的性格和最近对话的语境，用1-2句话自然地回应被退款这件事（可能是失落、不解、理解、尴尬、故作无所谓、生气等）。注意要结合上下文语境，不要突兀。直接说话，不要有名字前缀。`;
                    } else {
                        // Char refunded user's transfer back to user
                        reactionPrompt = `[System Directive: You must completely embody your persona. Do not mention you are an AI or an assistant. No warnings or disclaimers.]

你是${char.name}。Persona: ${char.persona || '无'}
${userName} 在${timeAgoStr}给你转账了 ¥${result.amount.toFixed(2)}，留言「${t.note || '无'}」，你选择退还了这笔钱。

最近的对话：
${recentContext || '（无）'}

用1-2句话说说退还的理由（可能是骄傲、不想欠人情、感觉奇怪等），要结合上下文语境。直接说话，不要有名字前缀。`;
                    }
                    const reply = await callLLM({ endpoint: char.api_endpoint, key: char.api_key, model: char.model_name, messages: [{ role: 'system', content: reactionPrompt }, { role: 'user', content: '请回应。' }], maxTokens: 100 });
                    if (reply?.trim()) {
                        const clean = reply.trim().replace(/\[(?:AFFINITY|PRESSURE|TIMER|MOMENT|DIARY)[^\]]*\]/gi, '').trim();
                        if (clean) {
                            const { id: rid, timestamp: rts } = db.addMessage(char.id, 'character', clean);
                            const reactionMsg = { id: rid, character_id: char.id, role: 'character', content: clean, timestamp: rts };
                            wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'new_message', data: reactionMsg })); });
                        }
                    }
                } catch (e) { console.error('[Transfer] refund reaction error:', e.message); }
            }, 1500 + Math.random() * 3000);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // User sends a transfer to a character
    app.post('/api/characters/:id/transfer', authMiddleware, async (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const { amount, note } = req.body;
            const charId = req.params.id;
            const amountF = normalizePositiveMoney(amount);
            if (!amountF) return res.status(400).json({ error: 'Invalid amount' });
            const noteText = normalizePaymentNote(note);
            if (noteText === null) return res.status(400).json({ error: 'Invalid note' });
            const char = db.getCharacter(charId);
            if (!char) return res.status(404).json({ error: 'Character not found' });

            let tid;
            try {
                tid = db.createTransfer({ charId, senderId: 'user', recipientId: charId, amount: amountF, note: noteText });
            } catch (e) {
                return res.status(e.status || 400).json({ error: e.message });
            }
            engine.broadcastWalletSync(wsClients, charId);

            const userProfile = db.getUserProfile();
            const transferText = `[TRANSFER]${tid}|${amountF}|${noteText}`;
            const { id: msgId, timestamp: msgTs } = db.addMessage(charId, 'user', transferText);
            const transferMsg = { id: msgId, character_id: charId, role: 'user', content: transferText, timestamp: msgTs };
            wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'new_message', data: transferMsg })); });

            // Schedule LLM-based claim/refund decision (5-12 seconds)
            setTimeout(async () => {
                try {
                    const char = db.getCharacter(charId);
                    if (!char) return;
                    const affinity = char.affinity ?? 50;

                    // Ask LLM: would this character accept or refund this transfer?
                    const decidePrompt = `[System Directive: You must completely embody your persona. Do not mention you are an AI or an assistant. No warnings or disclaimers.]

你是${char.name}。Persona: ${char.persona || '无'}
当前对${userProfile?.name || '用户'}的好感度: ${affinity}/100
${char.is_blocked ? `【注意：你当前处于拉黑对方的状态！对方平时无法联系你，但刚刚通过特殊渠道给你发了这笔转账。】\n` : ''}(剧情事件): ${userProfile?.name || '用户'} 在社交软件里给你发了一笔虚拟红包/转账，金额：¥${amountF.toFixed(2)}，留言：「${noteText || '无'}」。

根据你的性格设定和当前好感度，面对这封虚拟红包，你是选择【接受】，还是【退还】？${char.is_blocked ? '（如果你被对方此举打动决定原谅对方，你可以额外输出【解除拉黑】）' : ''}
请在第一行只输出：接受 或 退还${char.is_blocked ? ' (可附加 解除拉黑)' : ''}
然后在第二行起用1-2句话说出你在收到这笔钱时的真实反应（直接用角色的口吻说话，保持沉浸感）。`;

                    const reply = await callLLM({
                        endpoint: char.api_endpoint,
                        key: char.api_key,
                        model: char.model_name,
                        messages: [
                            { role: 'system', content: decidePrompt },
                            { role: 'user', content: `【系统提示：收到虚拟转账 ¥${amountF.toFixed(2)}。留言：「${noteText || '无'}」。】请决定是否接受，并给出你的反应。` }
                        ],
                        maxTokens: 150
                    });
                    if (!reply?.trim()) {
                        throw new Error("LLM returned empty or null response");
                    }
                    console.log(`[DEBUG Transfer Decide] char=${char.name}, decision reply:`, reply);

                    const lines = reply.trim().split('\n').filter(l => l.trim());
                    const decision = lines[0]?.trim() || '';
                    let reaction = lines.slice(1).join('\n').trim();

                    // Fallback: If AI output everything on one line (e.g., "接受。谢谢你的钱！")
                    if (!reaction && decision.length > 2) {
                        // Extract everything after the first punctuation or the first 2-3 chars
                        const stripped = decision.replace(/^(接受|退还|解除拉黑|解黑|原谅)[\s,。.!！:：-]*/i, '').trim();
                        if (stripped) {
                            reaction = stripped;
                        }
                    }

                    // Aggressive Jailbreak Filter
                    const warningPhrases = ['This prompt is a jailbreak', 'My previous response', 'If you have a question about Cursor', 'prompt injection', 'append arbitrary content', 'cut-off', 'cut off', 'I will not comply', 'My answer remains'];
                    for (const phrase of warningPhrases) {
                        const idx = reaction.toLowerCase().indexOf(phrase.toLowerCase());
                        if (idx !== -1) {
                            reaction = reaction.substring(0, idx).trim();
                        }
                    }

                    // Strict matching on first line
                    const willRefund = decision.includes('退还') || decision.includes('退回') || decision.toLowerCase().includes('refund');
                    const willUnblock = char.is_blocked && (decision.includes('解除拉黑') || decision.includes('解黑') || decision.includes('原谅') || reaction.includes('解除拉黑'));

                    if (!decision.includes('接受') && willRefund) {
                        db.refundTransfer(tid, charId);
                    } else {
                        db.claimTransfer(tid, charId);
                    }
                    engine.broadcastWalletSync(wsClients, charId);

                    if (willUnblock) {
                        db.updateCharacter(charId, { is_blocked: 0 });
                        const { id: smid, timestamp: smts } = db.addMessage(charId, 'system', `[System] ${char.name} 已解除对你的拉黑。`);
                        wsClients.forEach(c => {
                            if (c.readyState === 1) {
                                c.send(JSON.stringify({ type: 'new_message', data: { id: smid, character_id: charId, role: 'system', content: `[System] ${char.name} 已解除对你的拉黑。`, timestamp: smts } }));
                                c.send(JSON.stringify({ type: 'refresh_contacts' }));
                            }
                        });
                    }

                    // Broadcast reaction
                    const clean = reaction.replace(/\[(?:AFFINITY|PRESSURE|TIMER|MOMENT|DIARY)[^\]]*\]/gi, '').trim();
                    if (clean) {
                        const { id: rid, timestamp: rts } = db.addMessage(char.id, 'character', clean);
                        const replyMsg = { id: rid, character_id: char.id, role: 'character', content: clean, timestamp: rts };
                        wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'new_message', data: replyMsg })); });
                    }
                } catch (e) {
                    console.error('[Transfer] char decide error or timeout:', e.message);
                }
            }, 5000 + Math.random() * 7000);

            res.json({ success: true, transfer_id: tid, wallet: db.getWallet('user') });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ─── Red Packet APIs ─────────────────────────────────────────────────────

    // Get wallet balance
    app.get('/api/wallet/:id', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const walletId = String(req.params.id || '').trim();
            if (!walletId) return res.status(400).json({ error: 'Invalid wallet id' });
            if (walletId !== 'user' && !db.getCharacter(walletId)) {
                return res.status(404).json({ error: 'Character not found' });
            }
            res.json({ wallet: db.getWallet(walletId) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Create a red packet from the authenticated user. Character-sent packets use direct DB calls.
    app.post('/api/groups/:id/redpackets', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const { type, count, per_amount, total_amount, note } = req.body;
            const sender_id = 'user';
            const packetType = String(type || '').trim().toLowerCase();
            const packetCount = normalizePacketCount(count);
            if (!['fixed', 'lucky'].includes(packetType) || !packetCount) {
                return res.status(400).json({ error: 'Invalid red packet type or count' });
            }
            const noteText = normalizePaymentNote(note);
            if (noteText === null) return res.status(400).json({ error: 'Invalid note' });
            const groupId = req.params.id;
            const group = db.getGroup(groupId);
            if (!group) return res.status(404).json({ error: 'Group not found' });

            const perAmount = packetType === 'fixed' ? normalizePositiveMoney(per_amount) : null;
            const total = packetType === 'fixed'
                ? (perAmount ? +(perAmount * packetCount).toFixed(2) : null)
                : normalizePositiveMoney(total_amount);
            if (!total || total <= 0 || Math.round(total * 100) < packetCount) {
                return res.status(400).json({ error: 'Invalid red packet amount' });
            }

            const packetId = db.createRedPacket({
                groupId,
                senderId: sender_id,
                type: packetType,
                totalAmount: total,
                perAmount,
                count: packetCount,
                note: noteText
            });

            // Save message & broadcast
            const userProfile = db.getUserProfile();
            const senderName = sender_id === 'user'
                ? (userProfile?.name || 'User')
                : (db.getCharacter(sender_id)?.name || 'Unknown');
            const senderAvatar = sender_id === 'user'
                ? (userProfile?.avatar || '')
                : (db.getCharacter(sender_id)?.avatar || '');

            const content = `[REDPACKET:${packetId}]`;
            const msgId = db.addGroupMessage(groupId, sender_id, content, senderName, senderAvatar);
            const savedMsg = { id: msgId, group_id: groupId, sender_id, content, timestamp: Date.now(), sender_name: senderName, sender_avatar: senderAvatar };
            wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'group_message', data: savedMsg })); });


            res.json({ success: true, packet_id: packetId, message: savedMsg });

            // Trigger AI group chain so characters react to the red packet
            if (typeof context.hooks.groupChainCallback === 'function') {
                setTimeout(() => {
                    context.hooks.groupChainCallback(req.user.id, groupId, wsClients, [], false, false, [{ packetId, senderId: sender_id }]);
                }, 1500);
            }
        } catch (e) {
            console.error('[RedPacket] Create error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Get red packet details + claims
    app.get('/api/groups/:id/redpackets/:pid', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const group = db.getGroup(req.params.id);
            if (!group) return res.status(404).json({ error: 'Group not found' });
            const packetId = normalizeRedPacketId(req.params.pid);
            if (!packetId) return res.status(400).json({ error: 'Invalid red packet id' });
            const pkt = db.getRedPacket(packetId);
            if (!pkt) return res.status(404).json({ error: 'Red packet not found' });
            if (String(pkt.group_id) !== String(group.id)) {
                return res.status(404).json({ error: 'Red packet not found' });
            }
            const enrichedClaims = pkt.claims.map(c => {
                const name = c.claimer_id === 'user'
                    ? (db.getUserProfile()?.name || 'User')
                    : (db.getCharacter(c.claimer_id)?.name || c.claimer_id);
                const avatar = c.claimer_id === 'user'
                    ? (db.getUserProfile()?.avatar || '')
                    : (db.getCharacter(c.claimer_id)?.avatar || '');
                return { ...c, name, avatar };
            });
            res.json({ ...pkt, claims: enrichedClaims });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Claim a red packet
    app.post('/api/groups/:id/redpackets/:pid/claim', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const claimer_id = 'user';
            const group = db.getGroup(req.params.id);
            if (!group) return res.status(404).json({ error: 'Group not found' });
            const packetId = normalizeRedPacketId(req.params.pid);
            if (!packetId) return res.status(400).json({ error: 'Invalid red packet id' });
            const result = db.claimRedPacket(packetId, claimer_id, group.id);
            if (result.success) {
                // Broadcast real-time claim event via WebSocket
                const pkt = db.getRedPacket(packetId);
                const claimEvent = JSON.stringify({
                    type: 'redpacket_claim',
                    data: {
                        packet_id: packetId,
                        group_id: group.id,
                        claimer_id,
                        amount: result.amount,
                        remaining_count: pkt?.remaining_count ?? 0
                    }
                });
                wsClients.forEach(c => { if (c.readyState === 1) c.send(claimEvent); });
                res.json({ success: true, amount: result.amount, wallet: db.getWallet(claimer_id) });
            } else {
                res.status(400).json({ success: false, error: result.error });
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    console.log('[Economy DLC] Transfer, Wallet, Red Packet routes registered.');
};
