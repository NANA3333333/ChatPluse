function createActionService(deps = {}) {
    const {
        normalizeSurvivalState,
        districtsFallbackForExhaustion,
        getDistrictStateEffects,
        ensureCityGrowthDb,
        schoolLogic,
        buildGamblingOutcomeNarrations,
        broadcastCityToChat,
        buildCollapsedCityLog,
        pickSettledShopItemFromNarrations,
        isWeakCityNarration,
        regenerateActionNarrations,
        clamp,
        broadcastCityEvent,
        handleQuestLifecycleAfterAction,
        applyStateEffectsToCharacter,
        logEmotionTransitionToState,
        getWsClients,
        getEngine,
        isCollapsedCityLog,
        isHackerDistrict,
        buildHackerIntelAppendix,
        triggerHackerIntelReply,
        getMedicalStayMinutes,
        getCityNowMs
    } = deps;

    async function applyDecision(district, char, db, userId, currentCals, config, activeEvents, richNarrations = null, options = {}) {
        const currentState = normalizeSurvivalState(char);
        const preserveDirectedDistrict = !!options.preserveDirectedDistrict;
        const cityNowMs = Number(options.cityNowMs || 0) || Number(getCityNowMs?.(config) || 0) || Date.now();
        if (!preserveDirectedDistrict) {
            if (
                currentState.energy < 20 &&
                ['work', 'education', 'gambling', 'leisure', 'wander'].includes(district.type)
            ) {
                district = districtsFallbackForExhaustion(char, db) || district;
            } else if (
                currentState.energy < 35 &&
                ['work', 'education', 'gambling'].includes(district.type)
            ) {
                district = districtsFallbackForExhaustion(char, db) || district;
            }
        }

        const inflation = parseFloat(config.inflation) || 1.0;
        const workBonus = parseFloat(config.work_bonus) || 1.0;
        const taskNarrationText = [
            richNarrations?.log,
            richNarrations?.chat,
            richNarrations?.moment,
            richNarrations?.diary
        ].map((value) => String(value || '').trim()).filter(Boolean).join('\n');
        const rawQuestIntent = richNarrations?.quest_intent;
        const questIntentStage = rawQuestIntent && typeof rawQuestIntent === 'object'
            ? String(rawQuestIntent.stage || '').trim().toLowerCase()
            : '';
        const activeQuestClaim = db.city.getCharacterActiveQuestClaim?.(char.id) || null;
        const activeQuestTitle = String(activeQuestClaim?.title || '').trim();
        const isQuestAction = ['claim', 'progress', 'report'].includes(questIntentStage)
            || (!!activeQuestClaim && /汇报|交付|递交|交差|报告任务|送去交单|去交单/.test(taskNarrationText))
            || (!!activeQuestTitle && taskNarrationText.includes(activeQuestTitle));
        const districtMoneyCost = isQuestAction ? 0 : Number(district.money_cost || 0);
        let dCal = -(district.cal_cost || 0) + (district.cal_reward || 0);
        let dMoney = -districtMoneyCost * inflation + (district.money_reward || 0) * workBonus;
        let stateEffects = getDistrictStateEffects(district, richNarrations);
        const growthDb = ensureCityGrowthDb(db);
        const schoolProfile = schoolLogic.getCharacterSchoolProfile(growthDb, char.id);
        stateEffects = schoolLogic.applySchoolPerksToState(district, stateEffects, schoolProfile, currentState);

        if (district.type === 'work' && dMoney > 0 && schoolProfile.vocational > 0) {
            const vocationalBonus = schoolProfile.vocational >= 70
                ? 0.22
                : schoolProfile.vocational >= 40
                    ? 0.12
                    : schoolProfile.vocational >= 20
                        ? 0.06
                        : 0;
            if (vocationalBonus > 0) {
                dMoney = Math.round(dMoney * (1 + vocationalBonus));
                stateEffects = {
                    ...stateEffects,
                    stress: stateEffects.stress - (schoolProfile.vocational >= 70 ? 3 : 1),
                    mood: stateEffects.mood + (schoolProfile.vocational >= 70 ? 2 : 1)
                };
            }
        }

        if (activeEvents && activeEvents.length > 0) {
            for (const evt of activeEvents) {
                let eff = {};
                try { eff = typeof evt.effect_json === 'string' ? JSON.parse(evt.effect_json) : (evt.effect_json || {}); } catch (e) { continue; }
                if (eff.district && eff.district !== district.id) continue;
                if (eff.cal_bonus) dCal += Number(eff.cal_bonus) || 0;
                if (eff.money_bonus) dMoney += Number(eff.money_bonus) || 0;
                if (eff.price_modifier) dMoney *= Number(eff.price_modifier) || 1;
                if (eff.cal_modifier) dCal *= Number(eff.cal_modifier) || 1;
                console.log(`[City/Event] ${evt.emoji}${evt.title} 影响 ${char.name} @ ${district.name}: cal${eff.cal_bonus || 0} money${eff.money_bonus || 0}`);
            }
            dCal = Math.round(dCal);
            dMoney = Math.round(dMoney);
        }

        const getLogText = (defaultString, logOptions = {}) => {
            if (logOptions.forceDefault) return defaultString;
            if (!richNarrations) return defaultString;
            const candidates = [
                richNarrations.log,
                richNarrations.diary,
                richNarrations.moment,
                richNarrations.chat
            ].map(v => String(v || '').trim()).filter(Boolean);

            for (const candidate of candidates) {
                return candidate;
            }
            return defaultString;
        };
        let primaryActionLogId = 0;
        const finishBrokeAction = async (brokeLog) => {
            primaryActionLogId = db.city.logAction(char.id, 'BROKE', brokeLog, 0, 0, district.id);
            const questOutcome = await handleQuestLifecycleAfterAction(db, char, district, richNarrations, { actionLogId: primaryActionLogId });
            const bonusMoney = Number(questOutcome?.bonusMoney || 0);
            const bonusCalories = Number(questOutcome?.bonusCalories || 0);
            if (bonusMoney || bonusCalories) {
                const patch = {
                    wallet: Math.max(0, (char.wallet || 0) + bonusMoney),
                    calories: Math.min(4000, Math.max(0, currentCals + bonusCalories))
                };
                db.updateCharacter(char.id, patch);
                const wsClients = getWsClients(userId);
                const engine = getEngine(userId);
                if (engine && typeof engine.broadcastWalletSync === 'function') {
                    engine.broadcastWalletSync(wsClients, char.id);
                }
            }
        };

        if (district.type === 'gambling') {
            const winRate = parseFloat(config.gambling_win_rate) || 0.35;
            const payout = parseFloat(config.gambling_payout) || 3.0;
            const didWin = Math.random() < winRate;
            if (didWin) {
                dMoney = districtMoneyCost * payout;
                stateEffects = { ...stateEffects, mood: stateEffects.mood + 10, stress: stateEffects.stress - 6 };
                const gamblingNarrations = await buildGamblingOutcomeNarrations(char, district, db, {
                    didWin: true,
                    moneyDelta: dMoney,
                    calDelta: dCal
                }, richNarrations);
                const winLog = String(gamblingNarrations.log || `${char.name} 在 ${district.emoji}${district.name} 赢了一大笔钱 😎`).trim();
                primaryActionLogId = db.city.logAction(char.id, district.id.toUpperCase(), winLog, dCal, dMoney, district.id);
                richNarrations = gamblingNarrations;
                broadcastCityToChat(userId, char, winLog, 'GAMBLING_WIN', richNarrations);
            } else {
                dMoney = -districtMoneyCost * inflation;
                stateEffects = { ...stateEffects, mood: stateEffects.mood - 8, stress: stateEffects.stress + 8 };
                const gamblingNarrations = await buildGamblingOutcomeNarrations(char, district, db, {
                    didWin: false,
                    moneyDelta: dMoney,
                    calDelta: dCal
                }, richNarrations);
                const loseLog = String(gamblingNarrations.log || `${char.name} 在 ${district.emoji}${district.name} 输光了 😵`).trim();
                primaryActionLogId = db.city.logAction(char.id, district.id.toUpperCase(), loseLog, dCal, dMoney, district.id);
                richNarrations = gamblingNarrations;
                broadcastCityToChat(userId, char, loseLog, 'GAMBLING_LOSE', richNarrations);
            }
        } else if (district.type === 'food' || district.type === 'shopping') {
            const realCost = districtMoneyCost * inflation;
            if (realCost > 0 && (char.wallet || 0) < realCost) {
                const brokeLog = getLogText(buildCollapsedCityLog(char, '金币不足，文案折叠', { district }));
                await finishBrokeAction(brokeLog);
                return;
            }
            if (!isQuestAction) {
                let shopItems = db.city.getItemsAtDistrict(district.id);
                shopItems = shopItems.filter(i => i.stock === -1 || i.stock > 0);

                if (shopItems.length > 0) {
                    const settledNarratedItem = pickSettledShopItemFromNarrations(shopItems, richNarrations);
                    const item = settledNarratedItem || shopItems[Math.floor(Math.random() * shopItems.length)];
                    const itemCost = item.buy_price * inflation;
                    if ((char.wallet || 0) >= itemCost) {
                        if (!richNarrations || isWeakCityNarration(richNarrations?.log, char, district)) {
                            richNarrations = await regenerateActionNarrations(char, district, db, richNarrations || {}, {
                                item,
                                currentCals
                            });
                        }
                        db.city.decreaseItemStock(item.id, 1);

                        if (district.id === 'restaurant') {
                            dMoney = -itemCost;
                            dCal = -(district.cal_cost || 0) + (item.cal_restore || 0);
                            const satietyBoost = clamp(Math.round((item.cal_restore || 0) / 18), 10, 30);
                            const loadBoost = clamp(Math.round((item.cal_restore || 0) / 24), 8, 24);
                            stateEffects = {
                                ...stateEffects,
                                energy: stateEffects.energy + 6,
                                stress: stateEffects.stress - 2,
                                mood: stateEffects.mood + 2,
                                satiety: (stateEffects.satiety || 0) + satietyBoost,
                                stomach_load: (stateEffects.stomach_load || 0) + loadBoost,
                                sleep_debt: (stateEffects.sleep_debt || 0) + Math.round(loadBoost * 0.6)
                            };
                            const eatLog = getLogText(buildCollapsedCityLog(char, '进食文案生成失败', { district }), { allowWeak: true });
                            primaryActionLogId = db.city.logAction(char.id, 'EAT', eatLog, dCal, dMoney, district.id);
                            broadcastCityEvent(userId, char.id, 'EAT', eatLog);
                            broadcastCityToChat(userId, char, eatLog, 'EAT', richNarrations);
                        } else {
                            db.city.addToInventory(char.id, item.id, 1);
                            dMoney = -itemCost;
                            dCal = -(district.cal_cost || 0);
                            const buyLog = getLogText(buildCollapsedCityLog(char, '购物文案生成失败', { district }), { allowWeak: true });
                            primaryActionLogId = db.city.logAction(char.id, 'BUY', buyLog, dCal, dMoney, district.id);
                            broadcastCityEvent(userId, char.id, 'BUY', buyLog);
                            broadcastCityToChat(userId, char, buyLog, 'BUY', richNarrations);
                        }

                        const questOutcome = await handleQuestLifecycleAfterAction(db, char, district, richNarrations, { actionLogId: primaryActionLogId });
                        const newCals = Math.min(4000, Math.max(0, currentCals + dCal + Number(questOutcome.bonusCalories || 0)));
                        const newWallet = Math.max(0, (char.wallet || 0) + dMoney + Number(questOutcome.bonusMoney || 0));
                        const nextState = applyStateEffectsToCharacter(char, stateEffects);
                        const shoppingPatch = {
                            calories: newCals,
                            city_status: newCals < 500 ? 'hungry' : 'idle',
                            location: district.id,
                            wallet: newWallet,
                            ...nextState
                        };
                        db.updateCharacter(char.id, shoppingPatch);
                        logEmotionTransitionToState(
                            db,
                            char,
                            { ...char, ...shoppingPatch },
                            `city_action_${district.type}`,
                            `角色在商业街 ${district.name} 完成了一次${district.type === 'food' ? '进食' : '消费'}行为，状态与主情绪随之变化。`
                        );

                        const wsClients = getWsClients(userId);
                        const engine = getEngine(userId);
                        if (engine && typeof engine.broadcastWalletSync === 'function') {
                            engine.broadcastWalletSync(wsClients, char.id);
                        }

                        return;
                    }
                }
            }
            if (realCost > 0 && (char.wallet || 0) < realCost) {
                const brokeLog = getLogText(buildCollapsedCityLog(char, '金币不足，文案折叠', { district }));
                await finishBrokeAction(brokeLog);
                return;
            }
            const normalLog = getLogText(buildCollapsedCityLog(char, '行动文案生成失败', { district }));
            primaryActionLogId = db.city.logAction(char.id, district.id.toUpperCase(), normalLog, dCal, dMoney, district.id);
            if (richNarrations) broadcastCityToChat(userId, char, normalLog, district.id.toUpperCase(), richNarrations);
        } else if (district.type === 'medical') {
            if (districtMoneyCost > 0 && (char.wallet || 0) < districtMoneyCost * inflation) {
                const brokeLog = getLogText(buildCollapsedCityLog(char, '金币不足，文案折叠', { district }));
                await finishBrokeAction(brokeLog);
                return;
            }
            if (currentCals >= 800) {
                dCal = -(district.cal_cost || 0);
                const punishLog = getLogText(buildCollapsedCityLog(char, '医疗行动文案折叠', { district }));
                primaryActionLogId = db.city.logAction(char.id, district.id.toUpperCase(), punishLog, dCal, dMoney, district.id);
                if (richNarrations) broadcastCityToChat(userId, char, punishLog, district.id.toUpperCase(), richNarrations);
            } else {
                dCal = -(district.cal_cost || 0);
                stateEffects = { energy: 0, sleep_debt: 0, stress: 0, social_need: 0, health: 0, mood: 0, satiety: 0, stomach_load: 0 };
                const normalLog = getLogText(buildCollapsedCityLog(char, '医疗行动文案生成失败', { district }), { forceDefault: true });
                primaryActionLogId = db.city.logAction(char.id, district.id.toUpperCase(), normalLog, dCal, dMoney, district.id);
                if (richNarrations) broadcastCityToChat(userId, char, normalLog, district.id.toUpperCase(), richNarrations);
            }
        } else {
            if (districtMoneyCost > 0 && (char.wallet || 0) < districtMoneyCost * inflation) {
                const brokeLog = getLogText(buildCollapsedCityLog(char, '金币不足，文案折叠', { district }));
                await finishBrokeAction(brokeLog);
                return;
            }
            let normalLog = getLogText(buildCollapsedCityLog(char, '行动文案生成失败', { district }));
            let hackerIntelPayload = '';
            if (district.type === 'education') {
                const studyResult = schoolLogic.getSchoolActionEffects(growthDb, char, district, currentState);
                if (studyResult) {
                    growthDb.addCharacterCourseMastery(char.id, studyResult.course.id, studyResult.gain);
                    stateEffects = {
                        ...stateEffects,
                        mood: stateEffects.mood + 2,
                        stress: stateEffects.stress - 1
                    };
                    const schoolProgressText = `课程=${studyResult.course.emoji}${studyResult.course.name} | 熟练度=+${studyResult.gain} | 当前=${studyResult.afterMastery}/100`;
                    const schoolUnlockText = String(schoolLogic.describeSchoolUnlock(studyResult.course.id, studyResult.unlockedTier) || '').trim();
                    if (isCollapsedCityLog(normalLog)) {
                        normalLog = [normalLog, schoolProgressText, schoolUnlockText].filter(Boolean).join(' | ');
                    } else {
                        normalLog = `${normalLog} 这次主要上了 ${studyResult.course.emoji}${studyResult.course.name}，熟练度 +${studyResult.gain}，现在是 ${studyResult.afterMastery}/100。${schoolUnlockText}`.trim();
                    }
                }
            }
            if (isHackerDistrict(district)) {
                hackerIntelPayload = buildHackerIntelAppendix(db, char);
                normalLog = `${normalLog}\n\n[黑客据点情报]\n${hackerIntelPayload}`.trim();
            }
            primaryActionLogId = db.city.logAction(char.id, district.id.toUpperCase(), normalLog, dCal, dMoney, district.id);
            if (richNarrations) broadcastCityToChat(userId, char, normalLog, district.id.toUpperCase(), richNarrations);
            if (hackerIntelPayload) {
                triggerHackerIntelReply(userId, char, hackerIntelPayload).catch(err => {
                    console.error(`[City->Chat] 黑客据点私聊回报失败: ${err.message}`);
                });
            }
        }

        const questOutcome = await handleQuestLifecycleAfterAction(db, char, district, richNarrations, { actionLogId: primaryActionLogId });
        const totalCalDelta = dCal + Number(questOutcome.bonusCalories || 0);
        const totalMoneyDelta = dMoney + Number(questOutcome.bonusMoney || 0);
        const newCals = Math.min(4000, Math.max(0, currentCals + totalCalDelta));
        const newWallet = Math.max(0, (char.wallet || 0) + totalMoneyDelta);
        const nextState = applyStateEffectsToCharacter(char, stateEffects);
        const newCityStatus = district.type === 'medical' && currentCals < 800
            ? 'medical'
            : district.duration_ticks > 1
                ? (district.type === 'work' ? 'working' : district.type === 'rest' ? 'sleeping' : 'eating')
                : (newCals < 500 ? 'hungry' : 'idle');

        const medicalStayMinutes = district.type === 'medical' && newCityStatus === 'medical'
            ? getMedicalStayMinutes(district)
            : 0;

        const actionPatch = {
            calories: newCals,
            city_status: newCityStatus,
            location: district.id,
            wallet: newWallet,
            city_status_started_at: newCityStatus === 'medical' ? cityNowMs : 0,
            city_status_until_at: newCityStatus === 'medical' ? cityNowMs + medicalStayMinutes * 60 * 1000 : 0,
            city_medical_last_recovery_at: newCityStatus === 'medical' ? cityNowMs : 0,
            work_distraction: newCityStatus === 'working' ? 0 : (char.work_distraction ?? 0),
            sleep_disruption: newCityStatus === 'sleeping' ? 0 : (char.sleep_disruption ?? 0),
            ...nextState
        };
        db.updateCharacter(char.id, actionPatch);
        logEmotionTransitionToState(
            db,
            char,
            { ...char, ...actionPatch },
            `city_action_${district.type}`,
            `角色在商业街执行了 ${district.name} 行动，生理状态与主情绪发生变化。`
        );
        broadcastCityEvent(userId, char.id, district.id.toUpperCase(), `${char.name} -> ${district.emoji} ${district.name}`);

        const wsClients = getWsClients(userId);
        const engine = getEngine(userId);
        if (engine && typeof engine.broadcastWalletSync === 'function') {
            engine.broadcastWalletSync(wsClients, char.id);
        }
    }

    return { applyDecision };
}

module.exports = { createActionService };
