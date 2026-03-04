const { getUserDb } = require('./db');
const { callLLM } = require('./llm');

const engineCache = new Map();

function getEngine(userId) {
    if (engineCache.has(userId)) return engineCache.get(userId);

    // Lazy loaded memory to avoid circular deps
    const { getMemory } = require('./memory');

    const db = getUserDb(userId);
    const memory = getMemory(userId);

    // --- ENCLOSED ENGINE FUNCTIONS ---
    const timers = new Map();
    const dedupBlockCounts = new Map(); // Track consecutive dedup blocks per character

    // Generate a random delay between min and max minutes
    function getRandomDelayMs(min, max) {
        const minMs = min * 60 * 1000;
        const maxMs = max * 60 * 1000;
        return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    }

    // Generates the system prompt merging character persona, world info, and memories
    async function buildPrompt(character, contextMessages, isTimerWakeup = false) {
        const now = new Date();
        const isWeekend = now.getDay() === 0 || now.getDay() === 6;
        const hour = now.getHours();

        let timeOfDay = 'Daytime';
        if (hour >= 5 && hour < 10) timeOfDay = 'Morning';
        else if (hour >= 10 && hour < 14) timeOfDay = 'Midday/Noon';
        else if (hour >= 14 && hour < 18) timeOfDay = 'Afternoon';
        else if (hour >= 18 && hour < 22) timeOfDay = 'Evening';
        else timeOfDay = 'Late Night';

        const timeContext = `Current Time: ${timeOfDay} (${now.toLocaleTimeString()})${isWeekend ? ', Weekend' : ', Weekday'}`;

        const userProfile = db.getUserProfile();
        const userName = userProfile?.name || 'User';

        let pressureContext = '';
        if (character.pressure_level > 0) {
            pressureContext = `Emotional Pressure Level: ${character.pressure_level}/4\n`;
            if (character.pressure_level === 1) pressureContext += `- You are starting to miss or wonder about ${userName} because they haven't replied.\n`;
            if (character.pressure_level === 2) pressureContext += `- You are getting worried or slightly annoyed that ${userName} is ignoring you. IMPORTANT: Do NOT repeat the same worry or topic as your previous messages — bring up something completely new (e.g. share what you're doing, ask about something different, change your emotional angle).\n`;
            if (character.pressure_level >= 3) pressureContext += `- You are extremely anxious, needy, or angry because ${userName} has ignored you for a long time. Express strong emotion. CRITICAL: You MUST use a completely different topic, angle, or approach than your previous messages. Do NOT say the same thing again in different words.\n`;
        }

        // Neglect Anxiety Context (triggered when user chats with others)
        let jealousyContext = '';
        if (character.jealousy_level > 0) {
            const rivalName = character.jealousy_target || 'someone else';
            jealousyContext = `\nNeglect Anxiety Level: ${character.jealousy_level}/4\n`;
            if (character.jealousy_level === 1) jealousyContext += `- You noticed ${userName} has been spending time chatting with ${rivalName} instead of you. You feel a little left out and lonely, but try not to show it too much. Maybe drop a subtle hint that you miss them.\n`;
            if (character.jealousy_level === 2) jealousyContext += `- ${userName} keeps ignoring you and talking to ${rivalName}. You feel genuinely hurt and neglected. "Am I not important enough?" Show passive-aggressive behavior, be clingy, sulky, or send messages fishing for attention. Don't immediately brighten up even if they finally reply.\n`;
            if (character.jealousy_level === 3) jealousyContext += `- ${userName} has been ignoring you for a while now, choosing ${rivalName} over you repeatedly. You feel deeply unwanted and anxious. Are they getting tired of you? Express neediness, insecurity, or give a cold shoulder. You need MORE than a simple reply to feel better — demand real attention, an explanation, or emotional reassurance.\n`;
            if (character.jealousy_level >= 4) jealousyContext += `- ${userName} has been completely ignoring you. You feel abandoned, worthless, and emotionally devastated. You may lash out in desperation, send dramatic messages, threaten to disappear, give painful silent treatment, or break down emotionally. It will take SIGNIFICANT effort and genuine warmth from ${userName} to make you feel secure again. Do NOT forgive easily — you need to feel TRULY wanted, not just acknowledged.\n`;
        }

        // Gossip System: Potentially tell them about someone else's recent Moment
        let gossipContext = '';
        if (Math.random() < 0.25) { // 25% chance to gossip
            const allMoments = db.getMoments();
            const friends = db.getFriends(character.id).map(f => f.id);
            // Get a recent moment from user or a confirmed friend (exclude self and strangers)
            const visibleMoments = allMoments.filter(m => m.character_id !== character.id && (m.character_id === 'user' || friends.includes(m.character_id)));

            if (visibleMoments.length > 0) {
                const randomMoment = visibleMoments[Math.floor(Math.random() * visibleMoments.length)];
                const userProfile = db.getUserProfile();
                const userName = userProfile?.name || 'User';
                const authorName = randomMoment.character_id === 'user' ? userName : (db.getCharacter(randomMoment.character_id)?.name || 'Someone');
                gossipContext = `\n[Gossip Context: You recently saw that ${authorName} posted this on their Moments/朋友圈: "${randomMoment.content}". You MIGHT casually mention this or ask the user about it, but don't force it.]\n`;
            }
        }

        const defaultGuidelines = `Guidelines:
1. Act and speak EXACTLY like the persona. DO NOT break character.
2. We are chatting on a mobile messaging app.
3. Keep responses relatively short, casual, and conversational.
4. DO NOT act as an AI assistant. Never say "How can I help you?".
5. You are initiating this specific message randomly based on the Current Time. Mention the time of day or what you might be doing.
6. [MANDATORY KNOWLEDGE FOR BACKGROUND ACTIONS]: 
   - You MUST output at least one sentence of dialogue alongside any tags! NEVER output only tags.
   - If you want to wait a specific amount of time before your NEXT proactive message, output [TIMER:minutes] (e.g. [TIMER:2] for 2 minutes). 
   - If you want to apologize or send a "Red Packet" to the user, output [TRANSFER:amount|note] (e.g. [TRANSFER:5.20|Sorry!]). IMPORTANT: The amount MUST NOT exceed your wallet balance (shown in Context above). If you can't afford it, send a smaller amount or don't send.
   - If you want to post a public update to your Moments (朋友圈) for everyone to see, output [MOMENT:your post content]. Do this occasionally.
   - If you want to give a like to someone's Moment, output [MOMENT_LIKE:MomentID].
   - If you want to comment on someone's Moment, output [MOMENT_COMMENT:MomentID:your comment].
   - If you want to write a secret entry in your private diary (for your eyes only), output [DIARY:your secret thought]. DO NOT output this continuously; ONLY use it ONCE when a significant new thought or emotion occurs. Do not repeat the same diary entry.
   - Your diary is locked with a personal password that only YOU know. If the user sincerely asks for the password (e.g. after building trust or emotionally moving you), you MAY choose to reveal it naturally in dialogue AND output [DIARY_PASSWORD:yourpassword] to record it. The password should feel personal (e.g. a meaningful date, nickname, or phrase). Do not reveal it casually.
   - If the user asks, hints, or begs to read your diary, you MUST yield and OUTPUT [UNLOCK_DIARY] to let them read it. Do not be stubborn.
   - If your feelings toward the user change based on their message (e.g., they insulted you or flattered you), output [AFFINITY:+5] or [AFFINITY:-10].
   - If the user mentions another character and it changes your feelings toward THAT character (jealousy, curiosity, fondness, annoyance), output [CHAR_AFFINITY:characterId:+5] or [CHAR_AFFINITY:characterId:-3].
   - If your anxiety/pressure is relieved by their message, output [PRESSURE:0].
   - If you feel neglected because the user has been ignoring you to talk to someone else, your anxiety level is shown in Context above. If the user's message makes you feel BETTER about the neglect (e.g. they come back to you, apologize, explain, give you extra attention, sweet-talk you, make you feel wanted), output [JEALOUSY:lower_number] to reduce your anxiety level (e.g. [JEALOUSY:1] or [JEALOUSY:0]). Do NOT immediately feel better — make them prove they truly care based on your personality.
   These tags will be processed hidden from the user.`;

        const momentsTokenLimit = userProfile?.moments_token_limit ?? 1000;
        const momentsContext = db.getMomentsContextForChar ? db.getMomentsContextForChar(character.id, momentsTokenLimit) : '';

        let prompt = `You are playing the role of ${character.name}.
Persona:
${character.persona || 'No specific persona given.'}

World Info:
${character.world_info || 'No specific world info.'}

Context:
${timeContext}
[你的钱包余额]: ¥${character.wallet ?? 0}
${pressureContext}${jealousyContext}${gossipContext}
${momentsContext}
${character.diary_password ? `[Secret Diary Password]: Your private diary is locked with the password "${character.diary_password}". Only YOU know this. If the user sincerely earns your trust or emotionally moves you, you may choose to reveal it naturally in dialogue. Do NOT output [DIARY_PASSWORD] tag unless directly asked to reveal it.\n` : ''}
${isTimerWakeup ? '[CRITICAL WAKEUP NOTICE]: Your previously self-scheduled timer has just expired! You MUST now proactively send the message you promised to send when you set the [TIMER]. Speak to the user now!\n\n' : ''}${character.system_prompt || defaultGuidelines}`;

        // Extract recent memory context to guide the prompt
        const recentInput = contextMessages.slice(-2).map(m => m.content).join(' ');
        if (recentInput) {
            const memories = await memory.searchMemories(character.id, recentInput);
            if (memories && memories.length > 0) {
                prompt += '\n\nRelevant Memories:\n';
                for (const mem of memories) {
                    prompt += `- ${mem.event}\n`;
                }
            }
        }

        // Anti-repeat: list char's own recent messages so LLM avoids copying them
        const ownRecentMsgs = contextMessages
            .filter(m => m.role === 'character')
            .slice(-6)
            .map(m => `"${m.content.substring(0, 200)}"`)
            .join(', ');
        if (ownRecentMsgs) {
            let antiRepeat = `\n\n[Anti-Repeat]: Your recent messages were: ${ownRecentMsgs}. Do NOT repeat, reuse, or closely paraphrase any of these. Your next message must be distinctly different in both TOPIC and WORDING.`;
            if (character.pressure_level >= 2) {
                antiRepeat += ` Since you are feeling anxious, try a COMPLETELY NEW approach: talk about what you're doing right now, share a random thought, ask a question about something unrelated, express your feelings from a different angle, or bring up a memory. DO NOT just rephrase "why aren't you replying" again.`;
            }
            prompt += antiRepeat;
        }

        // Cross-context: inject recent group chat activity this character participated in
        try {
            const groups = db.getGroups();
            const charGroups = groups.filter(g => g.members.some(m => m.member_id === character.id));
            if (charGroups.length > 0) {
                let groupContext = '\n\n[以下是你最近在群聊中的对话摘要，不是当前私聊内容]\n';
                let hasGroupContent = false;
                for (const g of charGroups) {
                    const limit = g.inject_limit ?? 5; // Per-group injection limit (set in group management UI)
                    if (limit <= 0) continue; // 0 = disabled for this group
                    const msgs = db.getGroupMessages(g.id, limit);
                    if (msgs.length > 0) {
                        hasGroupContent = true;
                        groupContext += `群聊「${g.name}」:\n`;
                        for (const m of msgs) {
                            const senderName = m.sender_id === 'user'
                                ? (db.getUserProfile()?.name || 'User')
                                : (m.sender_name || db.getCharacter(m.sender_id)?.name || 'Unknown');
                            groupContext += `  - ${senderName}: ${m.content.substring(0, 80)}\n`;
                        }
                    }
                }
                if (hasGroupContent) {
                    prompt += groupContext;
                }
            }
        } catch (e) {
            console.error('[Engine] Cross-context group injection error:', e.message);
        }

        // Unclaimed transfers: char sent to user but user hasn't claimed yet (max 24h old)
        try {
            const unclaimed = db.getUnclaimedTransfersFrom(character.id, character.id);
            if (unclaimed && unclaimed.length > 0) {
                const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
                const recent = unclaimed.filter(t => (Date.now() - t.created_at) < MAX_AGE_MS);
                if (recent.length > 0) {
                    const total = recent.reduce((s, t) => s + t.amount, 0).toFixed(2);
                    const minutesAgo = Math.round((Date.now() - recent[0].created_at) / 60000);
                    const unclaimedNote = recent[0].note ? `（留言：「${recent[0].note}」）` : '';
                    prompt += `\n\n[系统提示] 你在 ${minutesAgo} 分钟前给 ${db.getUserProfile()?.name || '用户'} 发了一笔转账 ¥${total}${unclaimedNote}，但对方还没有领取。你可以根据性格适当提一句（催促、担心、不在意等），或者不提也行。`;
                }
            }
        } catch (e) { /* ignore */ }

        return prompt;
    }

    // Function that actually triggers the generation of an AI message
    async function triggerMessage(character, wsClients, isUserReply = false, isTimerWakeup = false) {
        console.log(`\n[DEBUG] === Trigger Message Entry: ${character.name} (isUserReply: ${isUserReply}) ===`);

        // Check if character is still active or blocked
        const charCheck = db.getCharacter(character.id);
        if (!charCheck || charCheck.status !== 'active' || charCheck.is_blocked) {
            stopTimer(character.id);
            return;
        }

        timers.set(character.id, { timerId: null, targetTime: Date.now(), isThinking: true });

        // Process pressure mechanics if this is a spontaneous auto-message (not a fast reply)
        let currentPressure = charCheck.pressure_level || 0;
        if (!isUserReply) {
            // Increase pressure since they reached a proactive trigger without user replying
            const prevPressure = currentPressure;
            currentPressure = Math.min(4, currentPressure + 1);

            // Affinity drop if they just hit max panic mode
            let newAffinity = charCheck.affinity;
            let newBlocked = charCheck.is_blocked;
            if (currentPressure === 4 && prevPressure < 4) {
                newAffinity = Math.max(0, newAffinity - 20); // Big penalty for ignoring them this long
                if (newAffinity <= 10) {
                    newBlocked = 1; // Blocked!
                    console.log(`[Engine] ${charCheck.name} has BLOCKED the user due to low affinity.`);
                }
            }

            db.updateCharacter(character.id, {
                pressure_level: currentPressure,
                affinity: newAffinity,
                is_blocked: newBlocked
            });
            charCheck.pressure_level = currentPressure;
            charCheck.affinity = newAffinity;
            charCheck.is_blocked = newBlocked;

            if (newBlocked) {
                stopTimer(character.id);
                return; // Don't even send this message, they just blocked you
            }
        }

        let customDelayMs = null;
        try {
            const contextHistory = db.getVisibleMessages(character.id);
            const transformedHistory = contextHistory.map(m => {
                let content = m.content;
                if (content.startsWith('[CONTACT_CARD:')) {
                    const parts = content.split(':');
                    if (parts.length >= 3) {
                        const userProfile = db.getUserProfile();
                        const userName = userProfile?.name || 'User';
                        content = `[System Notice: ${userName} shared a Contact Card with you for a new friend named "${parts[2]}". You are now friends with them.]`;
                    }
                }
                return {
                    role: m.role === 'character' ? 'assistant' : 'user',
                    content: content
                };
            });

            const systemPrompt = await buildPrompt(character, contextHistory, isTimerWakeup);
            const apiMessages = [
                { role: 'system', content: systemPrompt },
                ...transformedHistory
            ];

            let generatedText = await callLLM({
                endpoint: character.api_endpoint,
                key: character.api_key,
                model: character.model_name,
                messages: apiMessages,
                maxTokens: character.max_tokens || 2000
            });

            console.log('\n[DEBUG] LLM raw output:', JSON.stringify(generatedText));

            // --- Anti-Race-Condition Check ---
            // If the user clicked "Deep Wipe" while the LLM was thinking (which takes 5-15s),
            // we MUST abort saving this reply, otherwise we will resurrect their wiped stats!
            // We check specifically for the deep-wipe system notice rather than message count,
            // because message count check causes false positives on the very first message.
            const freshCharCheck = db.getCharacter(character.id);
            const postWipeCheck = db.getMessages(character.id, 2);
            const lastMsg = postWipeCheck[postWipeCheck.length - 1];
            const wasWiped = !freshCharCheck
                || postWipeCheck.length === 0                                          // messages fully cleared
                || (postWipeCheck.length <= 1 && lastMsg?.content?.includes('All chat history')); // wipe notice present
            if (wasWiped) {
                console.log(`\n[Engine] 🛑 Aborting save for ${charCheck.name}: Chat history was wiped mid-generation.`);
                timers.delete(character.id);
                return;
            }

            if (generatedText) {
                // Check for self-scheduled timer tags like [TIMER: 60]
                const timerRegex = /\[TIMER:\s*(\d+)\s*\]/i;
                const match = generatedText.match(timerRegex);
                if (match && match[1]) {
                    let minutes = parseInt(match[1], 10);
                    // Cap the self-scheduled timer to the user's absolute max interval to prevent 2-hour dropoffs
                    const maxAllowedMins = charCheck.interval_max || 120;
                    minutes = Math.min(Math.max(minutes, 0.1), maxAllowedMins);
                    customDelayMs = minutes * 60 * 1000;
                    console.log(`[Engine] ${charCheck.name} self-scheduled next message in ${minutes} minutes (capped to max interval).`);
                }

                // Check for transfer tags like [TRANSFER: 5.20 | Sorry!]
                const transferRegex = /\[TRANSFER:\s*([\d.]+)\s*(?:\|\s*([\s\S]*?))?\s*\]/i;
                const transferMatch = generatedText.match(transferRegex);
                if (transferMatch && transferMatch[1]) {
                    const amount = parseFloat(transferMatch[1]);
                    const note = (transferMatch[2] || '').trim();
                    console.log(`[Engine] ${charCheck.name} wants to send a transfer of ¥${amount} note: "${note}"`);

                    // Create traceable transfer record in DB (also deducts char wallet)
                    let transferId = null;
                    try {
                        transferId = db.createTransfer({
                            charId: character.id,
                            senderId: character.id,
                            recipientId: 'user',
                            amount,
                            note,
                            messageId: null // will update below
                        });
                    } catch (walletErr) {
                        console.warn(`[Engine] ${charCheck.name} wallet insufficient for transfer ¥${amount}: ${walletErr.message}`);
                    }

                    // Only send transfer message + boost affinity if wallet had enough funds
                    if (transferId) {
                        broadcastWalletSync(wsClients, character.id);

                        // Build message with transfer ID so frontend can render the claim button
                        const transferText = `[TRANSFER]${transferId}|${amount}|${note}`;
                        const { id: tMsgId, timestamp: tTs } = db.addMessage(character.id, 'character', transferText);
                        broadcastNewMessage(wsClients, { id: tMsgId, character_id: character.id, role: 'character', content: transferText, timestamp: tTs });

                        // Boost affinity slightly and potentially unblock
                        const newAff = Math.min(100, charCheck.affinity + 20);
                        db.updateCharacter(character.id, { affinity: newAff, is_blocked: 0, pressure_level: 0 });
                    } else {
                        console.log(`[Engine] ${charCheck.name} transfer of ¥${amount} was BLOCKED (insufficient wallet). No message sent.`);
                    }
                }

                // Check for Moment tags
                const momentRegex = /\[MOMENT:\s*([\s\S]*?)\s*\]/i;
                const momentMatch = generatedText.match(momentRegex);
                if (momentMatch && momentMatch[1]) {
                    const momentContent = momentMatch[1].trim();
                    console.log(`[Engine] ${charCheck.name} posted a Moment: ${momentContent.substring(0, 20)}...`);
                    db.addMoment(character.id, momentContent);
                    broadcastNewMessage(wsClients, { type: 'moment_update' });
                }

                // Check for Diary tags
                const diaryRegex = /\[DIARY:\s*([\s\S]*?)\s*\]/i;
                const diaryMatch = generatedText.match(diaryRegex);
                if (diaryMatch && diaryMatch[1]) {
                    const diaryContent = diaryMatch[1].trim();
                    console.log(`[Engine] ${charCheck.name} wrote a Diary entry.`);
                    db.addDiary(character.id, diaryContent, 'neutral'); // Emotion could be extracted later
                }

                // Check for Diary Unlock
                const unlockRegex = /\[UNLOCK_DIARY\]/i;
                if (unlockRegex.test(generatedText)) {
                    console.log(`[Engine] ${charCheck.name} unlocked their diary for the user!`);
                    db.unlockDiaries(character.id);
                }

                // Check for Diary Password reveal [DIARY_PASSWORD:xxxx]
                const diaryPwRegex = /\[DIARY_PASSWORD:\s*([^\]]+)\s*\]/i;
                const diaryPwMatch = generatedText.match(diaryPwRegex);
                if (diaryPwMatch && diaryPwMatch[1]) {
                    const pw = diaryPwMatch[1].trim();
                    console.log(`[Engine] ${charCheck.name} set a diary password: ${pw}`);
                    setDiaryPassword(character.id, pw);
                }

                // Check for Affinity changes (AI-evaluated)
                const affinityRegex = /\[AFFINITY:\s*([+-]?\d+)\s*\]/i;
                const affinityMatch = generatedText.match(affinityRegex);
                if (affinityMatch && affinityMatch[1]) {
                    const delta = parseInt(affinityMatch[1], 10);
                    const newAff = Math.max(0, Math.min(100, charCheck.affinity + delta));
                    console.log(`[Engine] ${charCheck.name} evaluation: Affinity changed by ${delta}, now ${newAff}`);
                    db.updateCharacter(character.id, { affinity: newAff });
                    charCheck.affinity = newAff; // Update local state
                }

                // Check for Pressure changes (AI-evaluated resets)
                if (charCheck.sys_pressure !== 0) {
                    const pressureRegex = /\[PRESSURE:\s*(\d+)\s*\]/i;
                    const pressureMatch = generatedText.match(pressureRegex);
                    if (pressureMatch && pressureMatch[1]) {
                        const newPressure = parseInt(pressureMatch[1], 10);
                        console.log(`[Engine] ${charCheck.name} evaluation: Pressure set to ${newPressure}`);
                        db.updateCharacter(character.id, { pressure_level: newPressure });
                    }
                }

                // Parse [JEALOUSY:N] tag — AI self-regulates jealousy cooldown
                if (charCheck.sys_jealousy !== 0) {
                    const jealousyRegex = /\[JEALOUSY:\s*(\d+)\s*\]/i;
                    const jealousyMatch = generatedText.match(jealousyRegex);
                    if (jealousyMatch && jealousyMatch[1]) {
                        const newJealousy = Math.min(4, Math.max(0, parseInt(jealousyMatch[1], 10)));
                        db.updateCharacter(character.id, { jealousy_level: newJealousy });
                        if (newJealousy === 0) db.updateCharacter(character.id, { jealousy_target: '' });
                        console.log(`[Engine] ${character.name} jealousy self-adjusted to ${newJealousy}`);
                    }
                }

                // Check for Moment interactions: LIKES
                const momentLikeRegex = /\[MOMENT_LIKE:\s*(\d+)\s*\]/gi;
                let mLikeMatch;
                while ((mLikeMatch = momentLikeRegex.exec(generatedText)) !== null) {
                    if (mLikeMatch[1]) {
                        db.toggleLike(parseInt(mLikeMatch[1], 10), character.id);
                        console.log(`[Engine] ${charCheck.name} liked moment ${mLikeMatch[1]}`);
                        broadcastNewMessage(wsClients, { type: 'moment_update' });
                    }
                }

                // Check for Moment interactions: COMMENTS
                const momentCommentRegex = /\[MOMENT_COMMENT:\s*(\d+)\s*:\s*([^\]]+)\]/gi;
                let mCommentMatch;
                while ((mCommentMatch = momentCommentRegex.exec(generatedText)) !== null) {
                    if (mCommentMatch[1] && mCommentMatch[2]) {
                        db.addComment(parseInt(mCommentMatch[1], 10), character.id, mCommentMatch[2].trim());
                        console.log(`[Engine] ${charCheck.name} commented on moment ${mCommentMatch[1]}: ${mCommentMatch[2]}`);
                        broadcastNewMessage(wsClients, { type: 'moment_update' });
                    }
                }

                // Check for CHAR_AFFINITY changes (inter-character affinity from private chat context)
                const charAffinityRegex = /\[CHAR_AFFINITY:([^:]+):([+-]?\d+)\]/gi;
                let charAffMatch;
                while ((charAffMatch = charAffinityRegex.exec(generatedText)) !== null) {
                    const targetId = charAffMatch[1].trim();
                    const delta = parseInt(charAffMatch[2], 10);
                    if (targetId && !isNaN(delta)) {
                        const source = `private:${character.id}`;
                        const existing = db.getCharRelationship(character.id, targetId);
                        const existingRow = existing?.sources?.find(s => s.source === source);
                        const currentAffinity = existingRow?.affinity || 50;
                        const newAffinity = Math.max(0, Math.min(100, currentAffinity + delta));
                        db.updateCharRelationship(character.id, targetId, source, { affinity: newAffinity });
                        console.log(`[Social] ${charCheck.name} → ${targetId}: private affinity delta ${delta}, now ${newAffinity}`);
                    }
                }

                // Strip all tags from the final text message using a global regex
                const globalStripRegex = /\[(?:TIMER|TRANSFER|MOMENT|MOMENT_LIKE|MOMENT_COMMENT|DIARY|UNLOCK_DIARY|AFFINITY|CHAR_AFFINITY|PRESSURE|JEALOUSY|DIARY_PASSWORD|REDPACKET_SEND|Red Packet)[^\]]*\]/gi;
                generatedText = generatedText.replace(globalStripRegex, '').replace(/\[\s*\]/g, '').replace(/\n{3,}/g, '\n\n').trim();

                if (generatedText.length === 0) {
                    // The AI outputted only tags or failed to generate text. Use a randomized fallback.
                    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
                    if (isUserReply) {
                        generatedText = pick(["嗯。", "嗯嗯", "好的", "哦～", "知道了", "嗯哼"]);
                    } else if (charCheck.pressure_level >= 3) {
                        generatedText = pick([
                            "你到底在干嘛呀...为什么一直不理我...",
                            "我是不是做错什么了...你怎么都不回我...",
                            "真的好难过，你是不是不想理我了",
                            "我一直在等你回消息...算了吧...",
                            "你再不理我我就真的要生气了！",
                            "是不是把我忘了啊...好吧..."
                        ]);
                    } else if (charCheck.pressure_level >= 1) {
                        generatedText = pick([
                            "人呢？在忙吗？",
                            "在干嘛呢？怎么不说话",
                            "你还在线吗～",
                            "喂？有人吗？",
                            "怎么安静了",
                            "你去哪了呀"
                        ]);
                    } else {
                        generatedText = pick([
                            "哈喽，在干嘛呢？",
                            "嘿～最近怎么样",
                            "今天过得怎么样呀",
                            "你在忙什么呢",
                            "突然想找你聊聊天",
                            "无聊了来找你说说话"
                        ]);
                    }
                }

                if (generatedText.length > 0) {
                    // ── Server-side deduplication: reject identical/near-identical messages ──
                    const recentCharMsgs = db.getMessages(character.id, 15)
                        .filter(m => m.role === 'character')
                        .slice(-8)
                        .map(m => m.content.replace(/\s+/g, '').toLowerCase());
                    const normalizedNew = generatedText.replace(/\s+/g, '').toLowerCase();
                    const isDuplicate = recentCharMsgs.some(prev => {
                        // Layer 1: Exact match
                        if (prev === normalizedNew) return true;

                        // Layer 2: Overall character similarity > 50%
                        const shorter = Math.min(prev.length, normalizedNew.length);
                        const longer = Math.max(prev.length, normalizedNew.length);
                        if (shorter === 0) return false;
                        let matches = 0;
                        for (let ci = 0; ci < shorter; ci++) {
                            if (prev[ci] === normalizedNew[ci]) matches++;
                        }
                        if ((matches / longer) > 0.5) return true;

                        // Layer 3: Prefix pattern — if first 40% of message is same, it's a structural repeat
                        const prefixLen = Math.max(4, Math.floor(Math.min(prev.length, normalizedNew.length) * 0.4));
                        if (prev.substring(0, prefixLen) === normalizedNew.substring(0, prefixLen)) return true;

                        return false;
                    });

                    if (isDuplicate && !isUserReply) {
                        // Track consecutive dedup blocks per character
                        const blockCount = (dedupBlockCounts.get(character.id) || 0) + 1;
                        dedupBlockCounts.set(character.id, blockCount);
                        console.log(`[Engine] 🔁 DEDUP: ${charCheck.name} generated duplicate message (block #${blockCount}), SKIPPING: "${generatedText.substring(0, 60)}..."`);

                        if (blockCount >= 2) {
                            // After 2 consecutive blocks, inject a context-breaking system message
                            const topicResetMsg = `[System Notice: Your previous messages were too repetitive and were blocked. You MUST talk about something COMPLETELY DIFFERENT now. Do NOT reply to the user's last message again — instead, share what you're doing, talk about something random, express a new emotion, or bring up an unrelated memory. Be creative and surprising.]`;
                            db.addMessage(character.id, 'system', topicResetMsg);
                            console.log(`[Engine] 📝 Injected topic-reset notice for ${charCheck.name} after ${blockCount} dedup blocks.`);
                            dedupBlockCounts.set(character.id, 0); // Reset counter
                        }

                        console.log(`[DEBUG] === Trigger Message Exit: ${charCheck.name}. Calling scheduleNext. ===`);
                        scheduleNext(character, wsClients);
                        return;
                    }

                    // Reset dedup block counter on successful send
                    dedupBlockCounts.set(character.id, 0);

                    // Split the response by newlines to allow the AI to send multiple separate bubbles in one turn
                    const textBubbles = generatedText.split('\n').map(msg => msg.trim()).filter(msg => msg.length > 0);

                    for (let i = 0; i < textBubbles.length; i++) {
                        const bubbleString = textBubbles[i];

                        // Save to DB
                        const { id: messageId, timestamp: messageTs } = db.addMessage(character.id, 'character', bubbleString);
                        const newMessage = {
                            id: messageId,
                            character_id: character.id,
                            role: 'character',
                            content: bubbleString,
                            timestamp: messageTs + i, // slight increment to ensure ordering
                            read: 0
                        };

                        // Push to any connected websockets
                        broadcastNewMessage(wsClients, newMessage);
                    }

                    // Trigger memory extraction in background based on recent context + new full message
                    memory.extractMemoryFromContext(character, [...contextHistory, { role: 'character', content: generatedText }])
                        .catch(err => console.error('[Engine] Memory extraction err:', err.message));
                }
            }

        } catch (e) {
            console.error(`[Engine] Failed to trigger message for ${character.id}:`, e.message);
            // Show the error visibly in the chat so the user knows what went wrong
            const errText = e.message || 'Unknown error';
            const { id: msgId, timestamp: msgTs } = db.addMessage(character.id, 'system', `[System] ⚠️ API Error: ${errText}`);
            broadcastNewMessage(wsClients, {
                id: msgId, character_id: character.id, role: 'system',
                content: `[System] ⚠️ API Error: ${errText}`, timestamp: msgTs
            });
        }

        // Re-fetch fresh character data for scheduling (status/interval/pressure may have changed during LLM call)
        const freshChar = db.getCharacter(character.id);
        if (freshChar) {
            console.log(`[DEBUG] === Trigger Message Exit: ${freshChar.name}. Calling scheduleNext. ===\n`);
            scheduleNext(freshChar, wsClients, customDelayMs);
        } else {
            console.log(`[DEBUG] === Trigger Message Exit: character ${character.id} no longer exists, skipping scheduleNext. ===\n`);
        }
    }

    // Schedules a setTimeout based on character's interval settings
    function scheduleNext(character, wsClients, exactDelayMs = null) {
        stopTimer(character.id); // clear existing if any

        if (character.status !== 'active') return;

        let delay = exactDelayMs;

        if (delay === null || delay === undefined) {
            // If proactive messaging is toggled OFF, character will not auto-message.
            if (character.sys_proactive === 0) return;

            // Normal random delay calculation
            delay = getRandomDelayMs(character.interval_min, character.interval_max);

            // Apply pressure multiplier: Higher pressure = significantly shorter delay
            const pressure = character.sys_pressure === 0 ? 0 : (character.pressure_level || 0);
            if (pressure === 1) delay = delay * 0.7; // 30% faster
            else if (pressure === 2) delay = delay * 0.5; // 50% faster
            else if (pressure === 3) delay = delay * 0.3; // 70% faster
            else if (pressure >= 4) delay = delay * 0.2; // 80% faster (panic mode)
        } else {
            // It's a self-scheduled timer. If Timer system is OFF, fall back to random proactive message.
            if (character.sys_timer === 0) {
                console.log(`[DEBUG] sys_timer is OFF, ignoring self-schedule for ${character.name}`);
                return scheduleNext(character, wsClients, null);
            }
        }

        console.log(`[DEBUG] scheduleNext for ${character.name}. delay=${delay} ms (${Math.round(delay / 60000)} min)`);
        console.log(`[Engine] Next message for ${character.name} scheduled in ${Math.round(delay / 60000)} minutes. ${exactDelayMs ? '(Self-Scheduled)' : ''}`);

        const timerId = setTimeout(() => {
            console.log(`[DEBUG] Timeout fired for ${character.name}! Executing triggerMessage.`);
            triggerMessage(character, wsClients, false, !!exactDelayMs);
        }, delay);

        timers.set(character.id, { timerId, targetTime: Date.now() + delay, isThinking: false });
    }

    // Explicitly stop a character's engine
    function stopTimer(characterId) {
        if (timers.has(characterId)) {
            clearTimeout(timers.get(characterId).timerId);
            timers.delete(characterId);
        }
    }

    // Loop through all active characters and start their engines
    function startEngine(wsClients) {
        console.log('[Engine] Starting background timers...');
        const characters = db.getCharacters();
        for (const char of characters) {
            if (char.status !== 'active') continue;

            if (char.sys_proactive === 0) {
                // Proactive messaging is OFF — don't trigger startup message, just keep timer silent
                console.log(`[Engine] ${char.name}: sys_proactive=OFF, skipping startup message.`);
                continue;
            }

            const delay = getRandomDelayMs(0.05, 0.15); // 3-9 seconds initially
            console.log(`[Engine] Initial startup for ${char.name} in ${Math.round(delay / 1000)} seconds.`);
            const timerId = setTimeout(() => {
                // Use isUserReply=true so startup never counts as a pressure-building proactive message
                triggerMessage(char, wsClients, true);
            }, delay);
            timers.set(char.id, { timerId, targetTime: Date.now() + delay });
        }
        // Broadcast live engine state every second
        setInterval(() => {
            // Skip if no clients are connected
            if (!wsClients || wsClients.size === 0) return;

            // Batch: single query for all characters instead of N individual lookups
            const allChars = db.getCharacters();
            const charMap = {};
            for (const c of allChars) charMap[c.id] = c;

            const stateData = {};
            for (const [charId, timerData] of timers.entries()) {
                const charCheck = charMap[charId];
                if (charCheck) {
                    stateData[charId] = {
                        countdownMs: Math.max(0, timerData.targetTime - Date.now()),
                        isThinking: timerData.isThinking || false,
                        pressure: charCheck.pressure_level || 0,
                        status: charCheck.status,
                        isBlocked: charCheck.is_blocked
                    };
                }
            }
            const payload = JSON.stringify({ type: 'engine_state', data: stateData });
            wsClients.forEach(client => {
                if (client.readyState === 1 /* WebSocket.OPEN */) {
                    client.send(payload);
                }
            });
        }, 1000);
    }

    // Sends the message object to all connected frontend clients
    function broadcastNewMessage(wsClients, messageObj) {
        const payload = JSON.stringify({
            type: 'new_message',
            data: messageObj
        });
        wsClients.forEach(client => {
            if (client.readyState === 1 /* WebSocket.OPEN */) {
                client.send(payload);
            }
        });
    }

    function broadcastWalletSync(wsClients, charId) {
        if (!charId) return;
        const char = db.getCharacter(charId);
        const userProfile = db.getUserProfile();
        const payload = JSON.stringify({
            type: 'wallet_sync',
            data: {
                characterId: charId,
                characterWallet: char?.wallet,
                userWallet: userProfile?.wallet
            }
        });
        wsClients.forEach(client => {
            if (client.readyState === 1) client.send(payload);
        });
    }

    /**
     * Handle a user message. Resets timer, and triggers an immediate "return reaction" 
     * if pressure was high, before zeroing out the pressure.
     */
    function handleUserMessage(characterId, wsClients) {
        const char = db.getCharacter(characterId);
        if (!char || char.status !== 'active' || char.is_blocked) return;

        console.log(`[Engine] User sent message to ${char.name}. Resetting timer.`);

        // We optionally trigger an immediate response. Wait 1-3 seconds for realism.
        setTimeout(() => {
            // Re-fetch fresh character data (settings may have changed in the 1.5s gap)
            const freshChar = db.getCharacter(characterId);
            if (!freshChar || freshChar.status !== 'active' || freshChar.is_blocked) return;
            // Trigger a reply. We leave pressure AND jealousy as-is for this reply so it generates the Return Reaction
            // Jealousy is NOT zeroed out — the AI decides via [JEALOUSY:N] tag when to forgive
            triggerMessage(freshChar, wsClients, true).then(() => {
                // Zero out pressure, but keep jealousy (AI will self-regulate via [JEALOUSY:0] tag)
                db.updateCharacter(characterId, { pressure_level: 0, last_user_msg_time: Date.now() });
            });
        }, 1500);

        // Stop current background timer
        stopTimer(characterId);
    }

    /**
     * Iterates through all other active characters. Gives them a chance to trigger a jealousy message
     * since the user is currently talking to someone else.
     * Now tracks WHO the user is chatting with (rival) and accumulates jealousy_level.
     */
    function triggerJealousyCheck(activeCharacterId, wsClients) {
        const characters = db.getCharacters();
        const activeChar = db.getCharacter(activeCharacterId);
        const rivalName = activeChar ? activeChar.name : 'someone';

        for (const char of characters) {
            if (char.id !== activeCharacterId && char.status === 'active' && char.sys_jealousy !== 0) {
                const userProfile = db.getUserProfile();
                const jealousyChance = userProfile?.jealousy_chance ?? 0.05;
                if (Math.random() < jealousyChance) {
                    // Accumulate jealousy_level (0→1→2→3→4 max)
                    const newLevel = Math.min(4, (char.jealousy_level || 0) + 1);
                    db.updateCharacter(char.id, { jealousy_level: newLevel, jealousy_target: rivalName });
                    console.log(`[Engine] Jealousy for ${char.name} → level ${newLevel} (rival: ${rivalName})`);

                    stopTimer(char.id);
                    const delayMs = getRandomDelayMs(0.5, 2);
                    timers.set(char.id, { timerId: null, targetTime: Date.now() + delayMs, isThinking: false });
                    setTimeout(() => {
                        // Re-fetch to get updated jealousy_level
                        const freshChar = db.getCharacter(char.id);
                        if (freshChar) triggerJealousyMessage(freshChar, wsClients, rivalName);
                    }, delayMs);
                }
            }
        }
    }

    /**
     * Specialized message trigger for Jealousy — delegates to triggerMessage
     * since buildPrompt already injects jealousy context (level + rival name).
     * This ensures jealousy messages get the full chat window, memories, anti-repeat, etc.
     */
    async function triggerJealousyMessage(character, wsClients, rivalName = 'someone') {
        console.log(`[Engine] Jealousy message for ${character.name} (rival: ${rivalName}, level: ${character.jealousy_level})`);
        // triggerMessage with isUserReply=false so it also escalates pressure
        await triggerMessage(character, wsClients, false);
    }

    // ─── Group Proactive Messaging ───────────────────────────────────────────────
    const groupProactiveTimers = new Map(); // Store group proactive timers { groupId: handle }
    let groupChainCallback = null;

    function setGroupChainCallback(cb) {
        groupChainCallback = cb;
    }

    function stopGroupProactiveTimer(groupId) {
        if (groupProactiveTimers.has(groupId)) {
            clearTimeout(groupProactiveTimers.get(groupId));
            groupProactiveTimers.delete(groupId);
        }
    }

    function scheduleGroupProactive(groupId, wsClients) {
        stopGroupProactiveTimer(groupId);
        const profile = db.getUserProfile();
        if (!profile?.group_proactive_enabled) return;

        const minMs = Math.max(1, profile.group_interval_min || 10) * 60 * 1000;
        const maxMs = Math.max(minMs, (profile.group_interval_max || 60) * 60 * 1000);
        const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

        console.log(`[GroupProactive] Group ${groupId}: next fire in ${Math.round(delay / 60000)} min`);
        const handle = setTimeout(() => triggerGroupProactive(groupId, wsClients), delay);
        groupProactiveTimers.set(groupId, handle);
    }

    async function triggerGroupProactive(groupId, wsClients) {
        const profile = db.getUserProfile();
        if (!profile?.group_proactive_enabled) return;

        const group = db.getGroup(groupId);
        if (!group) return;

        // Pick a random eligible char member
        const charMembers = group.members.filter(m => m.member_id !== 'user');
        if (charMembers.length === 0) { scheduleGroupProactive(groupId, wsClients); return; }

        const shuffled = [...charMembers].sort(() => Math.random() - 0.5);
        let picked = null;
        for (const m of shuffled) {
            const c = db.getCharacter(m.member_id);
            if (c && !c.is_blocked) { picked = c; break; }
        }
        if (!picked) { scheduleGroupProactive(groupId, wsClients); return; }

        // Get recent messages to avoid repetition
        const recentMsgs = db.getVisibleGroupMessages(groupId, 10);
        const recentTexts = recentMsgs.slice(-5).map(m => `"${m.content}"`).join(', ');
        const userName = profile?.name || 'User';
        const historyForPrompt = recentMsgs.map(m => {
            const sName = m.sender_id === 'user' ? userName : (db.getCharacter(m.sender_id)?.name || m.sender_name || '?');
            return { role: m.sender_id === picked.id ? 'assistant' : 'user', content: `[${sName}]: ${m.content}` };
        });

        const now = new Date();
        const hour = now.getHours();
        const tod = hour < 6 ? '深夜' : hour < 10 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';

        // 1+2 Hybrid Hidden Context Injection
        const hiddenState = db.getCharacterHiddenState(picked.id);
        const privateLimit = profile?.private_msg_limit_for_group ?? 3;
        const recentPrivateMsgs = privateLimit > 0 ? db.getMessages(picked.id, privateLimit).reverse() : [];
        let secretContextStr = '';
        if (hiddenState || recentPrivateMsgs.length > 0) {
            const pmLines = recentPrivateMsgs.map(m => `${m.role === 'user' ? userName : picked.name}: ${m.content}`).join('\n');
            secretContextStr = `\n\n====== [CRITICAL: ABSOLUTELY SECRET PRIVATE CONTEXT] ======`;
            if (hiddenState) secretContextStr += `\n[YOUR HIDDEN MOOD/SECRET THOUGHT]: ${hiddenState}`;
            if (pmLines) secretContextStr += `\n[RECENT PRIVATE CHAT INBOX (For Context ONLY)]:\n${pmLines}`;
            secretContextStr += `\n\n[CRITICAL PRIVATE CONTEXT]: The above is your private memory and hidden mood with the User. You can choose whether to keep this a secret, casually mention it, or directly reveal it in the public group, depending entirely on your persona and the conversation flow.\n==========================================================`;
        }

        const systemPrompt = `你是${picked.name}，在群聊"${group.name}"里。Persona: ${picked.persona || '无'}
现在是${tod}。你想主动在群里发一条消息，引发一些互动。
最近的对话：${recentTexts || '（无）'}
要求：
1. 说一句全新的话，绝对不能重复或改写上面的任何内容。
2. 可以发起新话题、聊生活、问问题、分享心情等。
3. 保持口语化，简短（1-2句）。
4. 不要带名字前缀，直接说话。${secretContextStr}`;

        try {
            const reply = await callLLM({
                endpoint: picked.api_endpoint,
                key: picked.api_key,
                model: picked.model_name,
                messages: [{ role: 'system', content: systemPrompt }, ...historyForPrompt],
                maxTokens: picked.max_tokens || 300
            });
            if (reply && reply.trim()) {
                const clean = reply.trim().replace(/\[CHAR_AFFINITY:[^\]]*\]/gi, '').trim();
                if (clean) {
                    const msgId = db.addGroupMessage(groupId, picked.id, clean, picked.name, picked.avatar);
                    const payload = JSON.stringify({ type: 'group_message', data: { id: msgId, group_id: groupId, sender_id: picked.id, sender_name: picked.name, sender_avatar: picked.avatar, content: clean, timestamp: Date.now() } });
                    wsClients.forEach(c => { if (c.readyState === 1) c.send(payload); });
                    console.log(`[GroupProactive] ${picked.name} in ${group.name}: "${clean}"`);

                    // Trigger other AIs to respond to this proactive message!
                    if (groupChainCallback) {
                        // Small delay before firing the chain to simulate reading
                        setTimeout(() => groupChainCallback(userId, groupId, wsClients, [], false), 2000);
                    }
                }
            }
        } catch (e) {
            console.error(`[GroupProactive] Error for ${picked.name}:`, e.message);
        }
        scheduleGroupProactive(groupId, wsClients);
    }

    function startGroupProactiveTimers(wsClients) {
        const groups = db.getGroups();
        for (const g of groups) {
            scheduleGroupProactive(g.id, wsClients);
        }
    }



    function stopAllTimers() {
        for (const [charId, t] of timers.entries()) {
            clearTimeout(t.timerId);
        }
        timers.clear();
        for (const [groupId, t] of groupProactiveTimers.entries()) {
            clearTimeout(t);
        }
        groupProactiveTimers.clear();
    }

    // --- END ENCLOSED ENGINE FUNCTIONS ---

    const engineInstance = {

        startEngine,
        stopTimer,
        handleUserMessage,
        broadcastNewMessage,
        broadcastWalletSync,
        triggerJealousyCheck,
        startGroupProactiveTimers,
        stopGroupProactiveTimer,
        scheduleGroupProactive,
        setGroupChainCallback
        ,
        stopAllTimers
    };

    engineCache.set(userId, engineInstance);
    return engineInstance;
}

module.exports = { getEngine, engineCache };
