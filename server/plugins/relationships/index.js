/**
 * Relationships DLC — Social Graph & Inter-Character Impressions
 * Extracted from server/index.js
 */
module.exports = function initRelationships(app, context) {
    const { authMiddleware, getUserDb, callLLM } = context;

    // 13. Friendships
    app.get('/api/characters/:id/friends', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const friends = db.getFriends(req.params.id);
            res.json(friends);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/characters/:id/friends', authMiddleware, async (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const { target_id } = req.body;
            if (!target_id) return res.status(400).json({ error: 'target_id is required' });

            const added = db.addFriend(req.params.id, target_id);
            if (added) {
                const sourceChar = db.getCharacter(req.params.id);
                const targetChar = db.getCharacter(target_id);
                if (sourceChar && targetChar) {
                    db.addMessage(req.params.id, 'user', `[CONTACT_CARD:${targetChar.id}:${targetChar.name}:${targetChar.avatar}]`);
                    db.addMessage(target_id, 'user', `[CONTACT_CARD:${sourceChar.id}:${sourceChar.name}:${sourceChar.avatar}]`);

                    // Generate initial impressions for both characters via LLM (fire-and-forget)
                    const generateImpression = async (fromChar, toChar) => {
                        const tryGenerate = async (withSystem) => {
                            const fromPersona = (fromChar.persona || '').substring(0, 200);
                            const toPersona = (toChar.persona || '').substring(0, 200);
                            const userPrompt = `You are ${fromChar.name}. Your personality: ${fromPersona} \nYou were just introduced to someone named "${toChar.name}".Their description: ${toPersona}.\nRespond with ONLY a valid JSON object, no markdown, no extra text: \n{ "affinity": <integer 1 - 100 >, "impression": "<one sentence>" } `;
                            const messages = withSystem
                                ? [{ role: 'system', content: 'You are a JSON-only response bot. Output only a raw JSON object.' }, { role: 'user', content: userPrompt }]
                                : [{ role: 'user', content: userPrompt }];
                            const result = await callLLM({
                                endpoint: fromChar.api_endpoint,
                                key: fromChar.api_key,
                                model: fromChar.model_name,
                                messages,
                                maxTokens: 200,
                                temperature: 0.3
                            });
                            if (!result || !result.trim()) {
                                console.warn(`[Social] LLM returned empty for ${fromChar.name}→${toChar.name} (withSystem = ${withSystem})`);
                                return null;
                            }
                            console.log(`[Social] Raw LLM output for ${fromChar.name}→${toChar.name}: ${result.substring(0, 300)} `);
                            const cleaned = (result || '').replace(/```[a - z] *\n ? /gi, '').replace(/```/g, '').trim();
                            const m = cleaned.match(/\{[\s\S]*\}/);
                            if (m) {
                                try {
                                    const parsed = JSON.parse(m[0]);
                                    if (parsed.impression) {
                                        return { affinity: Math.max(1, Math.min(100, parseInt(parsed.affinity) || 50)), impression: String(parsed.impression).substring(0, 200) };
                                    }
                                } catch (e) { /* JSON.parse failed */ }
                            }
                            // Simple regex extraction
                            const aNum = cleaned.match(/affinity\D*(\d+)/i);
                            const iText = cleaned.match(/impression\D{0,5}["'](.+?)["']/is) || cleaned.match(/impression\D{0,5}(.+)/is);
                            if (aNum && iText) {
                                const imp = iText[1].replace(/["'}\]]+\s*$/, '').trim();
                                if (imp.length > 2) return { affinity: Math.max(1, Math.min(100, parseInt(aNum[1]) || 50)), impression: imp.substring(0, 200) };
                            }
                            // Fallback: affinity found but no impression — use default
                            if (aNum) {
                                const aVal = Math.max(1, Math.min(100, parseInt(aNum[1]) || 50));
                                const defaultImp = aVal >= 70 ? 'Seems interesting, would like to know more.'
                                    : aVal >= 40 ? 'No strong feelings yet.' : 'Not sure about this person.';
                                return { affinity: aVal, impression: defaultImp };
                            }
                            return null;
                        };

                        try {
                            // Attempt 1: with system role (GPT-4/Grok)
                            let result = await tryGenerate(true);
                            if (!result) {
                                console.warn(`[Social] Attempt 1 failed for ${fromChar.name}→${toChar.name}, retrying without system role(Gemini fallback)`);
                                // Attempt 2: without system role (Gemini native API)
                                result = await tryGenerate(false);
                            }

                            if (result) {
                                db.initCharRelationship(fromChar.id, toChar.id, result.affinity, result.impression, 'recommend');
                                console.log(`[Social] ${fromChar.name}→${toChar.name}: affinity = ${result.affinity}, "${result.impression}"`);
                            } else {
                                console.warn(`[Social] Both attempts failed for ${fromChar.name}→${toChar.name}, storing empty impression`);
                                db.initCharRelationship(fromChar.id, toChar.id, 50, '', 'recommend');
                            }
                        } catch (err) {
                            console.error(`[Social] Impression error ${fromChar.name}→${toChar.name}: `, err.message);
                            db.initCharRelationship(fromChar.id, toChar.id, 50, '', 'recommend');
                        }
                    };

                    // Generate both impressions in parallel (don't block the response)
                    Promise.all([
                        generateImpression(sourceChar, targetChar),
                        generateImpression(targetChar, sourceChar)
                    ]).catch(e => console.error('[Social] Impression generation error:', e));
                }
            }
            res.json({ success: true, added });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 13.5 Get character relationships (inter-char affinity)
    app.get('/api/characters/:id/relationships', authMiddleware, (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const relationships = db.getCharRelationships(req.params.id);
            // Enrich with character names and avatars — skip if target no longer exists
            const enriched = relationships
                .filter(r => db.getCharacter(r.targetId) !== undefined)
                .map(r => {
                    const targetChar = db.getCharacter(r.targetId);
                    return {
                        ...r,
                        targetName: targetChar?.name || 'Unknown',
                        targetAvatar: targetChar?.avatar || ''
                    };
                });
            res.json(enriched);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 13.6 Regenerate impression for a specific relationship pair
    app.post('/api/characters/:id/relationships/regenerate', authMiddleware, async (req, res) => {
        const db = getUserDb(req.user.id);
        try {
            const { target_id } = req.body;
            if (!target_id) return res.status(400).json({ error: 'target_id required' });
            const fromChar = db.getCharacter(req.params.id);
            const toChar = db.getCharacter(target_id);
            if (!fromChar || !toChar) return res.status(404).json({ error: 'Character not found' });

            const fromPersona = (fromChar.persona || '').substring(0, 200);
            const toPersona = (toChar.persona || '').substring(0, 200);
            const userPrompt = `You are ${fromChar.name}. Your personality: ${fromPersona} \nYou just met someone named "${toChar.name}".Their description: ${toPersona}.\nRespond with ONLY a valid JSON object, no markdown, no extra text: \n{ "affinity": <integer 1 - 100 >, "impression": "<one sentence first impression>" } `;

            const tryCall = async (withSystem) => {
                const messages = withSystem
                    ? [{ role: 'system', content: 'You are a JSON-only response bot. Output only a raw JSON object.' }, { role: 'user', content: userPrompt }]
                    : [{ role: 'user', content: userPrompt }];
                let result;
                try {
                    result = await callLLM({
                        endpoint: fromChar.api_endpoint,
                        key: fromChar.api_key,
                        model: fromChar.model_name,
                        messages,
                        maxTokens: 200,
                        temperature: 0.3
                    });
                } catch (llmErr) {
                    console.warn(`[Social / Regen] LLM call error for ${fromChar.name}→${toChar.name} (withSystem = ${withSystem}): ${llmErr.message}`);
                    return null;
                }
                if (!result || !result.trim()) {
                    console.warn(`[Social / Regen] LLM returned empty for ${fromChar.name}→${toChar.name} (withSystem = ${withSystem})`);
                    return null;
                }
                console.log(`[Social / Regen] Raw LLM output for ${fromChar.name}→${toChar.name}: ${result.substring(0, 400)} `);
                try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'data', 'debug_regen.txt'), `[${new Date().toISOString()}] ${fromChar.name}→${toChar.name} (withSystem = ${withSystem}): \n${result} \n-- -\n`, { flag: 'a' }); } catch (e) { }
                const cleaned = (result || '').replace(/```[a - z] *\n ? /gi, '').replace(/```/g, '').trim();

                // Strategy 1: standard JSON.parse on the largest {...} block
                const m = cleaned.match(/\{[\s\S]*\}/);
                if (m) {
                    try {
                        const parsed = JSON.parse(m[0]);
                        if (parsed.impression) {
                            return { affinity: Math.max(1, Math.min(100, parseInt(parsed.affinity) || 50)), impression: String(parsed.impression).substring(0, 200), _raw: cleaned };
                        }
                    } catch (e) {
                        console.log('[Social/Regen] JSON.parse failed:', e.message, 'Input:', m[0].substring(0, 150));
                    }
                }

                // Strategy 2: simple number + text extraction
                const aNum = cleaned.match(/affinity\D*(\d+)/i);
                const iText = cleaned.match(/impression\D{0,5}["'](.+?)["']/is) || cleaned.match(/impression\D{0,5}(.+)/is);
                console.log('[Social/Regen] Strategy 2:', 'aNum=', aNum?.[1], 'iText=', iText?.[1]?.substring(0, 80));
                if (aNum && iText) {
                    const imp = iText[1].replace(/["'}\]]+\s*$/, '').trim();
                    if (imp.length > 2) {
                        return { affinity: Math.max(1, Math.min(100, parseInt(aNum[1]) || 50)), impression: imp.substring(0, 200), _raw: cleaned };
                    }
                }

                // Strategy 3: if affinity number found, use any remaining text as impression
                if (aNum) {
                    const leftover = cleaned.replace(/[{}]/g, '').replace(/affinity\D*\d+/i, '').replace(/impression/i, '').replace(/["':,]/g, ' ').trim();
                    console.log('[Social/Regen] Strategy 3 leftover:', leftover.substring(0, 100));
                    if (leftover.length > 3) {
                        return { affinity: Math.max(1, Math.min(100, parseInt(aNum[1]) || 50)), impression: leftover.substring(0, 200), _raw: cleaned };
                    }
                }
                // Strategy 4: affinity found but absolutely no impression text — generate a default one
                if (aNum) {
                    const aVal = Math.max(1, Math.min(100, parseInt(aNum[1]) || 50));
                    const defaultImp = aVal >= 70 ? 'Seems interesting, would like to know more.'
                        : aVal >= 40 ? 'No strong feelings yet.'
                            : 'Not sure about this person.';
                    console.log(`[Social / Regen] Strategy 4: using default impression for affinity = ${aVal}`);
                    return { affinity: aVal, impression: defaultImp, _raw: cleaned };
                }

                console.warn('[Social/Regen] All strategies failed. Cleaned:', cleaned.substring(0, 300));
                return null;
            };

            let out = await tryCall(true);
            if (!out) {
                console.warn(`[Social / Regen] Attempt 1 failed for ${fromChar.name}→${toChar.name}, retrying without system role`);
                out = await tryCall(false);
            }
            if (!out) return res.status(500).json({ error: `Both attempts returned no valid JSON.Check your Gemini API config.` });

            db.initCharRelationship(fromChar.id, toChar.id, out.affinity, out.impression, 'recommend');
            res.json({ success: true, affinity: out.affinity, impression: out.impression });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    console.log('[Relationships DLC] Relationship matching routes registered.');
};
