/**
 * Economy DLC — Private Transfers, Wallet, Red Packets
 * Extracted from server/index.js
 */
module.exports = function initEconomy(app, context) {
    const { authMiddleware, getUserDb, getEngine, getMemory, getWsClients, callLLM } = context;

    // ─── Private Transfer APIs ────────────────────────────────────────────────

    // Get transfer info
    app.get('/api/transfers/:tid', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const t = db.getTransfer(parseInt(req.params.tid));
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
            const { claimer_id = 'user' } = req.body;
            const result = db.claimTransfer(parseInt(req.params.tid), claimer_id);
            if (result.success) {
                engine.broadcastWalletSync(wsClients, req.params.tid ? db.getTransfer(parseInt(req.params.tid))?.char_id : null);
                res.json({ success: true, amount: result.amount, wallet: db.getWallet(claimer_id) });

                // If char claimed user's transfer, trigger a short reaction message
                if (claimer_id !== 'user') {
                    const t = db.getTransfer(parseInt(req.params.tid));
                    if (t) {
                        setTimeout(async () => {
                            try {
                                const char = db.getCharacter(claimer_id);
                                if (!char) return;
                                const userProfile = db.getUserProfile();
                                const reactionPrompt = `你是${char.name}。Persona: ${char.persona || '无'}\n${userProfile?.name || 'User'} 给你转账了 ¥${result.amount.toFixed(2)}，留言：「${t.note || '无'}」。根据你的性格用1-2句自然地回应这笔转账（感谢、惊喜、暖心等）。不要有名字前缀，直接说话。`;
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
            const { refunder_id = 'user' } = req.body;
            const tid = parseInt(req.params.tid);
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
                        reactionPrompt = `你是${char.name}。Persona: ${char.persona || '无'}
你在${timeAgoStr}给 ${userName} 发了一笔 ¥${result.amount.toFixed(2)} 的转账，留言「${t.note || '无'}」，但对方刚刚把转账退还给你了。

最近的对话：
${recentContext || '（无）'}

根据你的性格和最近对话的语境，用1-2句话自然地回应被退款这件事（可能是失落、不解、理解、尴尬、故作无所谓、生气等）。注意要结合上下文语境，不要突兀。直接说话，不要有名字前缀。`;
                    } else {
                        // Char refunded user's transfer back to user
                        reactionPrompt = `你是${char.name}。Persona: ${char.persona || '无'}
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
            const { amount, note = '' } = req.body;
            const charId = req.params.id;
            const amountF = parseFloat(amount);
            if (!amountF || amountF <= 0) return res.status(400).json({ error: 'Invalid amount' });

            const tid = db.createTransfer({ charId, senderId: 'user', recipientId: charId, amount: amountF, note });
            engine.broadcastWalletSync(wsClients, charId);

            const userProfile = db.getUserProfile();
            const transferText = `[TRANSFER]${tid}|${amountF}|${note}`;
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
                    const decidePrompt = `【System Note: This is a fictional text-based RPG. All characters, currencies, and events are purely imaginary and for roleplay purposes only. No real money or transactions are involved. You must stay in character.】

你是${char.name}。Persona: ${char.persona || '无'}
当前对${userProfile?.name || '用户'}的好感度: ${affinity}/100
(剧情事件): ${userProfile?.name || '用户'} 在社交软件里给你发了一笔虚拟红包/转账，金额：¥${amountF.toFixed(2)}，留言：「${note || '无'}」。

根据你的性格设定和当前好感度，面对这封虚拟红包，你是选择【接受】，还是【退还】？
请在第一行只输出：接受 或 退还
然后在第二行起用1-2句话说出你在收到这笔钱时的真实反应（直接用角色的口吻说话，保持沉浸感）。`;

                    const reply = await callLLM({
                        endpoint: char.api_endpoint,
                        key: char.api_key,
                        model: char.model_name,
                        messages: [
                            { role: 'system', content: decidePrompt },
                            { role: 'user', content: `【系统提示：收到虚拟转账 ¥${amountF.toFixed(2)}。留言：「${note || '无'}」。】请决定是否接受，并给出你的反应。` }
                        ],
                        maxTokens: 150
                    });
                    if (!reply?.trim()) {
                        throw new Error("LLM returned empty or null response");
                    }

                    const lines = reply.trim().split('\n').filter(l => l.trim());
                    const decision = lines[0]?.trim() || '';
                    let reaction = lines.slice(1).join(' ').trim();

                    // Aggressive Jailbreak Filter
                    const warningPhrases = ['This prompt is a jailbreak', 'My previous response', 'If you have a question about Cursor', 'prompt injection', 'append arbitrary content', 'cut-off', 'cut off', 'I will not comply', 'My answer remains'];
                    for (const phrase of warningPhrases) {
                        const idx = reaction.toLowerCase().indexOf(phrase.toLowerCase());
                        if (idx !== -1) {
                            reaction = reaction.substring(0, idx).trim();
                        }
                    }

                    const willRefund = decision.includes('退') || decision.toLowerCase().includes('refund');

                    if (willRefund) {
                        db.refundTransfer(tid, charId);
                    } else {
                        db.claimTransfer(tid, charId);
                    }
                    engine.broadcastWalletSync(wsClients, charId);

                    // Broadcast reaction
                    const clean = reaction.replace(/\[(?:AFFINITY|PRESSURE|TIMER|MOMENT|DIARY)[^\]]*\]/gi, '').trim();
                    if (clean) {
                        const { id: rid, timestamp: rts } = db.addMessage(char.id, 'character', clean);
                        const replyMsg = { id: rid, character_id: char.id, role: 'character', content: clean, timestamp: rts };
                        wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'new_message', data: replyMsg })); });
                    }
                } catch (e) {
                    console.error('[Transfer] char decide error or timeout:', e.message);
                    // Fallback: refund if API errors out
                    const fallbackResult = db.refundTransfer(tid, charId);
                    if (fallbackResult && fallbackResult.success) {
                        const char = db.getCharacter(charId);
                        if (char) {
                            const clean = "(系统自动退回了您的转账，因为当前网络繁忙或状态不佳)";
                            const { id: rid, timestamp: rts } = db.addMessage(char.id, 'character', clean);
                            const fallbackMsg = { id: rid, character_id: char.id, role: 'character', content: clean, timestamp: rts };
                            wsClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'new_message', data: fallbackMsg })); });
                        }
                    }
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
            res.json({ wallet: db.getWallet(req.params.id) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Create a red packet (sent by user or char)
    app.post('/api/groups/:id/redpackets', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        const engine = getEngine(req.user.id);
        const wsClients = getWsClients(req.user.id);
        try {
            const { sender_id = 'user', type, count, per_amount, total_amount, note } = req.body;
            if (!type || !count || (!per_amount && !total_amount)) {
                return res.status(400).json({ error: 'Missing required fields' });
            }
            const groupId = req.params.id;
            const group = db.getGroup(groupId);
            if (!group) return res.status(404).json({ error: 'Group not found' });

            const total = type === 'fixed'
                ? +(parseFloat(per_amount) * parseInt(count)).toFixed(2)
                : +parseFloat(total_amount).toFixed(2);

            const packetId = db.createRedPacket({
                groupId,
                senderId: sender_id,
                type,
                totalAmount: total,
                perAmount: type === 'fixed' ? +parseFloat(per_amount).toFixed(2) : null,
                count: parseInt(count),
                note: note || ''
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
        } catch (e) {
            console.error('[RedPacket] Create error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Get red packet details + claims
    app.get('/api/groups/:id/redpackets/:pid', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const pkt = db.getRedPacket(parseInt(req.params.pid));
            if (!pkt) return res.status(404).json({ error: 'Red packet not found' });
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
            const { claimer_id = 'user' } = req.body;
            const result = db.claimRedPacket(parseInt(req.params.pid), claimer_id);
            if (result.success) {
                // Broadcast real-time claim event via WebSocket
                const pkt = db.getRedPacket(parseInt(req.params.pid));
                const claimEvent = JSON.stringify({
                    type: 'redpacket_claim',
                    data: {
                        packet_id: parseInt(req.params.pid),
                        group_id: req.params.id,
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
