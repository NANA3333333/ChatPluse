const initSocialHousingDb = require('./db');
const initCityDb = require('../city/cityDb');

const AUTO_TICK_MS = 60 * 1000;

function compactText(value, fallback = '') {
    return String(value || '').replace(/\s+/g, ' ').trim() || fallback;
}

function buildAgencyAdKey(title, content) {
    return `${compactText(title)}\n${compactText(content)}`;
}

function unwrapAgencyJsonText(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const fenceMatch = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenceMatch ? String(fenceMatch[1] || '').trim() : raw;
}

function looksLikePriceText(text) {
    const value = String(text || '');
    return /\d/.test(value) && /(周租|售价|买断价|元|金币|租)/.test(value);
}

function getAgencyModelOptions(db) {
    const chars = typeof db.getCharacters === 'function' ? db.getCharacters() : [];
    return chars
        .filter((char) => char?.api_endpoint && char?.api_key && char?.model_name)
        .map((char) => ({
            id: String(char.id),
            name: String(char.name || char.id),
            model_name: String(char.model_name || ''),
            api_endpoint: String(char.api_endpoint || '')
        }));
}

function resolveAgencyAiChar(db, config = {}) {
    const chars = typeof db.getCharacters === 'function' ? db.getCharacters() : [];
    if (String(config.model_char_id || 'auto') !== 'auto') {
        const selected = chars.find(
            (char) => String(char.id) === String(config.model_char_id) && char?.api_endpoint && char?.api_key && char?.model_name
        );
        if (selected) return selected;
    }
    return chars.find((char) => char?.api_endpoint && char?.api_key && char?.model_name) || null;
}

function removeAgencyArtifacts(cityDb, title, content) {
    if (!cityDb?.db) return;
    const normalizedTitle = compactText(title);
    const normalizedContent = compactText(content);
    if (!normalizedContent) return;
    const announcementLogContent = `[中介所广告] ${normalizedTitle} | ${normalizedContent}`;

    cityDb.db.prepare(`
        DELETE FROM city_announcements
        WHERE source_type = 'agency'
          AND TRIM(title) = ?
          AND TRIM(content) = ?
    `).run(normalizedTitle, normalizedContent);

    cityDb.db.prepare(`
        DELETE FROM city_logs
        WHERE character_id = 'system'
          AND action_type = 'ANNOUNCE'
          AND TRIM(content) = ?
    `).run(announcementLogContent);
}

function cleanupOrphanAgencyArtifacts(socialHousingDb, cityDb) {
    if (!socialHousingDb || !cityDb?.db) return;
    const ads = socialHousingDb.getAgencyAds(500) || [];
    const keepKeys = new Set(
        ads.map((ad) => `${compactText(ad.title)}\n${compactText(ad.content)}`).filter(Boolean)
    );

    const announcementRows = cityDb.db.prepare(`
        SELECT id, title, content
        FROM city_announcements
        WHERE source_type = 'agency'
    `).all();
    for (const row of announcementRows) {
        const key = `${compactText(row.title)}\n${compactText(row.content)}`;
        if (!keepKeys.has(key)) {
            removeAgencyArtifacts(cityDb, row.title, row.content);
        }
    }

    const logRows = cityDb.db.prepare(`
        SELECT id, content
        FROM city_logs
        WHERE character_id = 'system'
          AND action_type = 'ANNOUNCE'
          AND content LIKE '[中介所广告] %'
    `).all();
    for (const row of logRows) {
        const raw = compactText(row.content);
        const body = raw.replace(/^\[中介所广告\]\s*/, '');
        const splitIndex = body.indexOf(' | ');
        const title = splitIndex >= 0 ? body.slice(0, splitIndex) : '';
        const content = splitIndex >= 0 ? body.slice(splitIndex + 3) : body;
        const key = `${compactText(title)}\n${compactText(content)}`;
        if (!keepKeys.has(key)) {
            cityDb.db.prepare('DELETE FROM city_logs WHERE id = ?').run(Number(row.id));
        }
    }
}

function getPublicAgencyAnnouncements(cityDb, limit = 50) {
    if (typeof cityDb?.getCityAnnouncements !== 'function') return [];
    return (cityDb.getCityAnnouncements(limit) || []).filter((item) => String(item.source_type || '') === 'agency');
}

function getAgencyAdsWithPublishState(socialHousingDb, cityDb, limit = 12) {
    const publicKeys = new Set(
        getPublicAgencyAnnouncements(cityDb, 50)
            .map((item) => buildAgencyAdKey(item.title, item.content))
            .filter(Boolean)
    );
    return (socialHousingDb.getAgencyAds(limit) || []).map((ad) => ({
        ...ad,
        is_published: publicKeys.has(buildAgencyAdKey(ad.title, ad.content))
    }));
}

function doesAgencyAdReferenceHome(ad, home) {
    const title = compactText(ad?.title);
    const content = compactText(ad?.content);
    const haystack = `${title}\n${content}`;
    const signals = [
        home?.id,
        home?.name
    ]
        .map((value) => compactText(value))
        .filter(Boolean);
    return signals.some((signal) => haystack.includes(signal));
}

function removeAgencyArtifactsForHome(socialHousingDb, cityDb, home) {
    if (!socialHousingDb || !cityDb || !home) return 0;
    const ads = socialHousingDb.getAgencyAds(500) || [];
    let removedCount = 0;
    for (const ad of ads) {
        if (!doesAgencyAdReferenceHome(ad, home)) continue;
        removeAgencyArtifacts(cityDb, ad.title, ad.content);
        socialHousingDb.deleteAgencyAd(ad.id);
        removedCount += 1;
    }
    return removedCount;
}

function recordAgencyDebug(db, aiChar, direction, payload, meta = {}) {
    if (!db || typeof db.addLlmDebugLog !== 'function' || !aiChar || aiChar.llm_debug_capture !== 1) return;
    try {
        const normalizedPayload = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
        db.addLlmDebugLog({
            character_id: aiChar.id,
            direction,
            context_type: meta.context_type || 'social_housing_agency',
            payload: normalizedPayload || '',
            meta,
            timestamp: Date.now()
        });
    } catch (e) {
        console.warn('[SocialHousing] Failed to record agency debug:', e.message);
    }
}

function buildAgencySnapshot(socialHousingDb, db) {
    const homes = (socialHousingDb.getHousingTiers() || [])
        .filter((item) => Number(item.is_enabled ?? 1) === 1)
        .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || Number(a.weekly_rent || 0) - Number(b.weekly_rent || 0));
    const classes = socialHousingDb.getClasses();
    const characters = socialHousingDb.getCharactersWithBindings(() => db.getCharacters());

    const urgentCharacters = characters
        .filter((char) => ['overdue', 'unstable', 'temporary'].includes(String(char.binding?.housing_status || '')))
        .slice(0, 4)
        .map((char) => ({
            name: char.name,
            status: char.binding?.housing_status || 'stable',
            wallet: Number(char.wallet || 0),
            housing_name: char.binding?.housing?.name || '',
            rent_weekly: Number(char.binding?.rent_weekly || 0)
        }));

    const availableHomes = homes.map((item) => ({
        id: String(item.id || ''),
        name: String(item.name || ''),
        emoji: String(item.emoji || ''),
        weekly_rent: Number(item.weekly_rent || 0),
        deposit: Number(item.deposit || 0),
        sale_price: Number(item.sale_price || 0),
        comfort: Number(item.comfort || 0),
        prestige: Number(item.prestige || 0),
        privacy: Number(item.privacy || 0),
        description: String(item.description || '')
    }));

    return {
        homes_count: availableHomes.length,
        classes_count: classes.length,
        urgent_characters: urgentCharacters,
        available_homes: availableHomes
    };
}

async function generateAgencyAd({ callLLM, db, config, snapshot, aiChar }) {
    const endpoint = compactText(aiChar?.api_endpoint || config.llm_endpoint);
    const key = compactText(aiChar?.api_key || config.llm_key);
    const model = compactText(aiChar?.model_name || config.llm_model);

    if (!endpoint || !key || !model) {
        throw new Error('Agency AI model config is missing. Please choose an available API.');
    }
    if (!Array.isArray(snapshot.available_homes) || snapshot.available_homes.length === 0) {
        throw new Error('Agency AI has no enabled homes to promote.');
    }

    const systemPrompt = compactText(
        config.persona_prompt,
        '你是商业街里的房产中介所 AI，擅长像真人中介一样推销房子。你每次都要从可推销房子列表里挑一套房，广告里必须明确写出价格、具体房名或门牌、以及一句卖点。'
    );

    const userPrompt = [
        '请根据下面的数据，为商业街生成一条简短、自然、像真人门店广告一样的房产广告。',
        '要求：',
        '1. 只输出 JSON。',
        '2. JSON 格式必须是 {"title":"标题","content":"正文"}。',
        '3. 标题不超过 16 个字。',
        '4. 正文 1 到 2 句话，不要出现系统、AI、JSON 这些词。',
        '5. 必须明确写出价格，至少出现一次：周租 / 售价 / 买断价 / 元 / 金币。',
        '6. 必须明确写出推销的是哪套房，至少提到房名或门牌中的一个具体标识。',
        '7. 不要每次都推最便宜那套，优先在不同房子之间轮换。',
        `8. 门店名：${config.agency_name}`,
        `9. 顾问名：${config.agent_name}`,
        `10. 经营范围：${config.business_scope}`,
        '',
        '[当前可推销房子列表]',
        JSON.stringify(snapshot, null, 2)
    ].join('\n');

    const richerAdInstructions = [
        '',
        '[补充增强要求]',
        '- 这次广告要比普通短句更像真实中介传单，信息更丰富一些。',
        '- 标题不要太短，尽量带上小区名、门牌、户型或卖点。',
        '- 正文尽量写成 2 到 4 句，而不是只有一句话。',
        '- 除了价格，还尽量自然写出：户型、押金、适合什么人、安静/采光/独卫/离哪里近/适合独居或情侣等信息。',
        '- 文风要像真人中介门店张贴的传单，具体、热情、接地气，不要像系统总结。',
        '- 不要只说“快来看”，而是让租房者看完就知道这套房大概什么样、为什么值得来看。'
    ].join('\n');
    const homeIdInstruction = '\n[home_id requirement]\nIf possible, include an extra JSON field named "home_id". Its value must be exactly one housing id from the provided list.\n';
    const finalUserPrompt = `${userPrompt}${richerAdInstructions}${homeIdInstruction}`;

    recordAgencyDebug(db, aiChar, 'input', {
        system_prompt: systemPrompt,
        user_prompt: finalUserPrompt
    }, {
        context_type: 'social_housing_agency_ad',
        model,
        endpoint
    });

    const result = await callLLM({
        endpoint,
        key,
        model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: finalUserPrompt }
        ],
        maxTokens: 3000,
        temperature: 0.9,
        returnUsage: true
    });

    const raw = typeof result === 'string' ? result : result?.content;
    const finishReason = String(result?.finishReason || '').trim();

    recordAgencyDebug(db, aiChar, 'output', String(raw || ''), {
        context_type: 'social_housing_agency_ad',
        model,
        endpoint,
        finishReason,
        cached: !!result?.cached,
        usage: result?.usage || null
    });

    if (finishReason === 'length') {
        throw new Error('Agency AI output was truncated. Please retry.');
    }

    let parsed;
    try {
        parsed = JSON.parse(unwrapAgencyJsonText(raw));
    } catch (e) {
        throw new Error('Agency AI output was malformed. Please retry.');
    }

    const title = compactText(parsed?.title, `${config.agency_name || '安家置业'}新房讯息`);
    const content = compactText(parsed?.content);
    const selectedHomeId = compactText(parsed?.home_id || parsed?.homeId);
    if (!title || !content) {
        throw new Error('Agency AI output was malformed. Please retry.');
    }
    if (!looksLikePriceText(`${title} ${content}`)) {
        throw new Error('Agency AI output was missing price information. Please retry.');
    }

    const normalizedAdText = `${title} ${content}`;
    const availableHomeSignals = snapshot.available_homes
        .map((item) => ({
            id: compactText(item.id),
            signals: [item.name, item.id]
                .filter(Boolean)
                .map((value) => String(value || '').trim())
                .filter(Boolean)
        }))
        .filter((item) => item.id || item.signals.length > 0);
    const mentionsSpecificHome = availableHomeSignals.some((item) =>
        item.signals.some((signal) => signal && normalizedAdText.includes(signal))
    );
    const selectedHomeExists = !!selectedHomeId && availableHomeSignals.some((item) => item.id === selectedHomeId);
    if (!mentionsSpecificHome && !selectedHomeExists) {
        throw new Error('Agency AI output did not mention a specific home. Please retry.');
    }

    return { title, content, home_id: selectedHomeExists ? selectedHomeId : '' };
}

module.exports = function initSocialHousingPlugin(app, context) {
    const { authMiddleware, authDb, getUserDb, getWsClients, callLLM } = context;

    function ensureSocialHousingDb(db) {
        if (!db.socialHousing) {
            const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : db;
            db.socialHousing = initSocialHousingDb(rawDb);
        }
        return db.socialHousing;
    }

    function ensureCityDb(db) {
        if (!db.city) {
            const rawDb = typeof db.getRawDb === 'function' ? db.getRawDb() : db;
            db.city = initCityDb(rawDb);
        }
        return db.city;
    }

    async function publishAgencyAdForDb(db, triggerType = 'manual') {
        const socialHousingDb = ensureSocialHousingDb(db);
        const cityDb = ensureCityDb(db);
        const config = socialHousingDb.getAgencyConfig();
        const snapshot = buildAgencySnapshot(socialHousingDb, db);
        const aiChar = resolveAgencyAiChar(db, config);
        const ad = await generateAgencyAd({ callLLM, db, config, snapshot, aiChar });

        socialHousingDb.addAgencyAd({
            title: ad.title,
            content: ad.content,
            trigger_type: triggerType,
            office_district: config.office_district
        });

        const intervalMinutes = Math.max(60, Number(config.decision_interval_hours || 6) * 60);
        socialHousingDb.saveAgencyConfig({
            ...config,
            ad_enabled: Number(config.enabled || 0) === 1 ? 1 : 0,
            ad_min_interval_minutes: intervalMinutes,
            ad_max_interval_minutes: intervalMinutes,
            last_ad_at: Date.now(),
            next_ad_at: Date.now() + intervalMinutes * 60 * 1000,
            last_error: '',
            last_error_at: 0
        });

        if (typeof cityDb.logAction === 'function') {
            cityDb.logAction('system', 'ANNOUNCE', `[中介所广告] ${ad.title} | ${ad.content}`, 0, 0, config.office_district || 'street');
        }
        if (typeof cityDb.addCityAnnouncement === 'function') {
            cityDb.addCityAnnouncement('agency', ad.title, ad.content, config.office_district || 'street');
        }

        return {
            ...ad,
            office_district: config.office_district || 'street'
        };
    }

    app.get('/api/social-housing/bootstrap', authMiddleware, (req, res) => {
        try {
            const socialHousingDb = ensureSocialHousingDb(req.db);
            const cityDb = ensureCityDb(req.db);
            cleanupOrphanAgencyArtifacts(socialHousingDb, cityDb);
            const publicAgencyAnnouncements = getPublicAgencyAnnouncements(cityDb, 50);
            res.json({
                success: true,
                classes: socialHousingDb.getClasses(),
                housing_tiers: socialHousingDb.getHousingTiers(),
                characters: socialHousingDb.getCharactersWithBindings(() => req.db.getCharacters()),
                districts: cityDb.getDistricts ? cityDb.getDistricts() : [],
                agency_model_options: getAgencyModelOptions(req.db),
                agency: socialHousingDb.getAgencyConfig(),
                agency_ads: getAgencyAdsWithPublishState(socialHousingDb, cityDb, 12),
                public_agency_announcements: publicAgencyAnnouncements
            });
        } catch (e) {
            try {
                const socialHousingDb = ensureSocialHousingDb(req.db);
                const current = socialHousingDb.getAgencyConfig();
                socialHousingDb.saveAgencyConfig({
                    ...current,
                    last_error: String(e.message || '中介所 AI 执行失败'),
                    last_error_at: Date.now()
                });
            } catch (_) { /* ignore */ }
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/social-housing/classes', authMiddleware, (req, res) => {
        try {
            const socialHousingDb = ensureSocialHousingDb(req.db);
            const payload = req.body || {};
            if (!String(payload.name || '').trim()) {
                return res.status(400).json({ success: false, error: '缺少阶级名称' });
            }
            const id = socialHousingDb.upsertClass(payload);
            res.json({ success: true, id, classes: socialHousingDb.getClasses() });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.delete('/api/social-housing/classes/:id', authMiddleware, (req, res) => {
        try {
            const socialHousingDb = ensureSocialHousingDb(req.db);
            socialHousingDb.deleteClass(req.params.id);
            res.json({ success: true, classes: socialHousingDb.getClasses() });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/social-housing/housing', authMiddleware, (req, res) => {
        try {
            const socialHousingDb = ensureSocialHousingDb(req.db);
            const payload = req.body || {};
            if (!String(payload.name || '').trim()) {
                return res.status(400).json({ success: false, error: '缺少房子名称' });
            }
            const id = socialHousingDb.upsertHousing(payload);
            res.json({ success: true, id, housing_tiers: socialHousingDb.getHousingTiers() });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.delete('/api/social-housing/housing/:id', authMiddleware, (req, res) => {
        try {
            const socialHousingDb = ensureSocialHousingDb(req.db);
            const cityDb = ensureCityDb(req.db);
            const housingList = socialHousingDb.getHousingTiers() || [];
            const removedHome = housingList.find((item) => String(item.id) === String(req.params.id)) || null;
            socialHousingDb.deleteHousing(req.params.id);
            const removedAgencyAds = removedHome ? removeAgencyArtifactsForHome(socialHousingDb, cityDb, removedHome) : 0;
            res.json({
                success: true,
                removed_agency_ads: removedAgencyAds,
                housing_tiers: socialHousingDb.getHousingTiers(),
                agency_ads: getAgencyAdsWithPublishState(socialHousingDb, cityDb, 12)
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/social-housing/characters/:id/binding', authMiddleware, (req, res) => {
        try {
            const socialHousingDb = ensureSocialHousingDb(req.db);
            const character = req.db.getCharacter(req.params.id);
            if (!character) {
                return res.status(404).json({ success: false, error: '角色不存在' });
            }
            socialHousingDb.saveBinding(req.params.id, req.body || {});
            res.json({
                success: true,
                characters: socialHousingDb.getCharactersWithBindings(() => req.db.getCharacters())
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/social-housing/agency', authMiddleware, (req, res) => {
        try {
            const socialHousingDb = ensureSocialHousingDb(req.db);
            const current = socialHousingDb.getAgencyConfig();
            const decisionIntervalHours = Math.max(1, Number(req.body?.decision_interval_hours ?? current.decision_interval_hours ?? 6));
            const saved = socialHousingDb.saveAgencyConfig({
                ...current,
                ...req.body,
                ad_enabled: Number(req.body?.enabled ?? current.enabled ?? 1) === 1 ? 1 : 0,
                ad_min_interval_minutes: decisionIntervalHours * 60,
                ad_max_interval_minutes: decisionIntervalHours * 60,
                decision_interval_hours: decisionIntervalHours,
                next_ad_at: Number(req.body?.next_ad_at ?? current.next_ad_at ?? 0)
            });
            res.json({ success: true, agency: saved });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/social-housing/agency/publish-ad', authMiddleware, async (req, res) => {
        try {
            const ad = await publishAgencyAdForDb(req.db, 'manual');
            const socialHousingDb = ensureSocialHousingDb(req.db);
            const wsClients = getWsClients(req.user.id);
            wsClients?.forEach((client) => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({ type: 'city_update', action: 'social-housing-ad', message: ad.content }));
                }
            });
            res.json({
                success: true,
                ad,
                agency: socialHousingDb.getAgencyConfig(),
                agency_ads: getAgencyAdsWithPublishState(socialHousingDb, ensureCityDb(req.db), 12)
            });
        } catch (e) {
            try {
                const socialHousingDb = ensureSocialHousingDb(req.db);
                const current = socialHousingDb.getAgencyConfig();
                socialHousingDb.saveAgencyConfig({
                    ...current,
                    last_error: String(e.message || '中介所 AI 执行失败'),
                    last_error_at: Date.now()
                });
            } catch (_) { /* ignore */ }
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.delete('/api/social-housing/agency/ads/:id', authMiddleware, (req, res) => {
        try {
            const socialHousingDb = ensureSocialHousingDb(req.db);
            const cityDb = ensureCityDb(req.db);
            const ad = socialHousingDb.getAgencyAdById(req.params.id);
            if (!ad) {
                return res.status(404).json({ success: false, error: '中介广告记录不存在' });
            }

            removeAgencyArtifacts(cityDb, ad.title, ad.content);
            socialHousingDb.deleteAgencyAd(req.params.id);
            res.json({
                success: true,
                agency_ads: getAgencyAdsWithPublishState(socialHousingDb, cityDb, 12)
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    setInterval(async () => {
        const users = typeof authDb.getAllUsers === 'function' ? authDb.getAllUsers() : [];
        for (const user of users) {
            try {
                if (String(user.status || 'active') !== 'active') continue;
                const db = getUserDb(user.id);
                const socialHousingDb = ensureSocialHousingDb(db);
                const config = socialHousingDb.getAgencyConfig();
                if (Number(config.enabled || 0) !== 1 || Number(config.ad_enabled || 0) !== 1) continue;

                const now = Date.now();
                const intervalMinutes = Math.max(60, Number(config.decision_interval_hours || 6) * 60);
                if (Number(config.next_ad_at || 0) <= 0) {
                    socialHousingDb.saveAgencyConfig({
                        ...config,
                        ad_min_interval_minutes: intervalMinutes,
                        ad_max_interval_minutes: intervalMinutes,
                        next_ad_at: now + intervalMinutes * 60 * 1000
                    });
                    continue;
                }
                if (Number(config.next_ad_at || 0) > now) continue;

                await publishAgencyAdForDb(db, 'auto');
                const wsClients = getWsClients(user.id);
                wsClients?.forEach((client) => {
                    if (client.readyState === 1) {
                        client.send(JSON.stringify({ type: 'city_update', action: 'social-housing-ad' }));
                    }
                });
            } catch (e) {
                try {
                    const db = getUserDb(user.id);
                    const socialHousingDb = ensureSocialHousingDb(db);
                    const current = socialHousingDb.getAgencyConfig();
                    socialHousingDb.saveAgencyConfig({
                        ...current,
                        last_error: String(e.message || '中介所 AI 自动执行失败'),
                        last_error_at: Date.now()
                    });
                } catch (_) { /* ignore */ }
            }
        }
    }, AUTO_TICK_MS);
};
