function clampAffinity(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) return null;
    return parsed;
}

function stripModelFormatting(result) {
    return String(result || '')
        .replace(/```[a-z]*\s*/gi, '')
        .replace(/```/g, '')
        .trim();
}

function buildImpressionPrompt(fromChar, toChar, { regenerate = false } = {}) {
    const fromPersona = (fromChar.persona || '').substring(0, 200);
    const toPersona = (toChar.persona || '').substring(0, 200);
    const intro = regenerate
        ? `You just met someone named "${toChar.name}".`
        : `You were just introduced to someone named "${toChar.name}".`;
    const impressionLabel = regenerate ? '<one sentence first impression>' : '<one sentence>';
    return `You are ${fromChar.name}. Your personality: ${fromPersona} \n${intro}Their description: ${toPersona}.\nRespond with ONLY a valid JSON object, no markdown, no extra text: \n{ "affinity": <integer 1 - 100 >, "impression": "${impressionLabel}" } `;
}

function parseImpressionResult(cleaned, {
    logPrefix = '[Social]',
    verbose = false
} = {}) {
    try {
        const parsed = JSON.parse(cleaned);
        const affinity = clampAffinity(parsed.affinity);
        const impression = String(parsed.impression || '').trim();
        if (affinity && impression) {
            return {
                affinity,
                impression: impression.substring(0, 200)
            };
        }
    } catch (e) {
        if (verbose) console.log(`${logPrefix} JSON.parse failed:`, e.message);
    }

    if (verbose) console.warn(`${logPrefix} No valid impression JSON. Cleaned response length:`, cleaned.length);
    return null;
}

async function requestImpression({ callLLM, fromChar, toChar, userPrompt, withSystem, logPrefix, parseOptions }) {
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
        console.warn(`${logPrefix} LLM call error for ${fromChar.name}->${toChar.name} (withSystem = ${withSystem}): ${llmErr.message}`);
        return null;
    }

    if (!result || !result.trim()) {
        console.warn(`${logPrefix} LLM returned empty for ${fromChar.name}->${toChar.name} (withSystem = ${withSystem})`);
        return null;
    }

    console.log(`${logPrefix} LLM returned ${result.length} chars for ${fromChar.name}->${toChar.name}`);
    return parseImpressionResult(stripModelFormatting(result), { logPrefix, ...parseOptions });
}

async function generateInitialImpression({ db, callLLM, fromChar, toChar }) {
    const userPrompt = buildImpressionPrompt(fromChar, toChar);
    try {
        let result = await requestImpression({
            callLLM,
            fromChar,
            toChar,
            userPrompt,
            withSystem: true,
            logPrefix: '[Social]',
            parseOptions: {}
        });
        if (!result) {
            console.warn(`[Social] Attempt 1 failed for ${fromChar.name}->${toChar.name}, retrying without system role(Gemini fallback)`);
            result = await requestImpression({
                callLLM,
                fromChar,
                toChar,
                userPrompt,
                withSystem: false,
                logPrefix: '[Social]',
                parseOptions: {}
            });
        }

        if (result) {
            db.initCharRelationship(fromChar.id, toChar.id, result.affinity, result.impression, 'recommend');
            console.log(`[Social] ${fromChar.name}->${toChar.name}: affinity = ${result.affinity}, impressionLength = ${result.impression.length}`);
        } else {
            console.warn(`[Social] Both attempts failed for ${fromChar.name}->${toChar.name}, no impression stored`);
        }
    } catch (err) {
        console.error(`[Social] Impression error ${fromChar.name}->${toChar.name}: `, err.message);
    }
}

function scheduleInitialImpressions({ db, callLLM, sourceChar, targetChar }) {
    Promise.all([
        generateInitialImpression({ db, callLLM, fromChar: sourceChar, toChar: targetChar }),
        generateInitialImpression({ db, callLLM, fromChar: targetChar, toChar: sourceChar })
    ]).catch(e => console.error('[Social] Impression generation error:', e));
}

async function regenerateImpression({ callLLM, fromChar, toChar }) {
    const userPrompt = buildImpressionPrompt(fromChar, toChar, { regenerate: true });
    const parseOptions = { verbose: true };
    let result = await requestImpression({
        callLLM,
        fromChar,
        toChar,
        userPrompt,
        withSystem: true,
        logPrefix: '[Social/Regen]',
        parseOptions
    });
    if (!result) {
        console.warn(`[Social / Regen] Attempt 1 failed for ${fromChar.name}->${toChar.name}, retrying without system role`);
        result = await requestImpression({
            callLLM,
            fromChar,
            toChar,
            userPrompt,
            withSystem: false,
            logPrefix: '[Social/Regen]',
            parseOptions
        });
    }
    return result;
}

module.exports = {
    scheduleInitialImpressions,
    regenerateImpression
};
