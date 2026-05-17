const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'tts');
const TTS_INTENT_REGEX = /\[TTS_INTENT:\s*([\s\S]*?)\]/i;
const TTS_INTENT_GLOBAL_REGEX = /\[TTS_INTENT:\s*[\s\S]*?\]/gi;

function parseJsonPayload(text) {
    const raw = String(text || '').trim();
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch (e) {
        return { reason: raw.replace(/[{}"']/g, '').slice(0, 120) };
    }
}

function parseTtsIntentTag(text) {
    const match = String(text || '').match(TTS_INTENT_REGEX);
    if (!match) return null;
    const intent = parseJsonPayload(match[1]);
    return {
        style: String(intent.style || intent.tone || '').trim(),
        reason: String(intent.reason || '').trim(),
        priority: Number(intent.priority || 1) || 1
    };
}

function stripTtsIntentTags(text) {
    return String(text || '').replace(TTS_INTENT_GLOBAL_REGEX, '').replace(/\n{3,}/g, '\n\n').trim();
}

function hmacSha256(key, data, encoding) {
    return crypto.createHmac('sha256', key).update(data).digest(encoding);
}

function sha256(data, encoding = 'hex') {
    return crypto.createHash('sha256').update(data).digest(encoding);
}

function parseTencentCredentials(value) {
    const raw = String(value || '').trim();
    if (!raw) return { secretId: '', secretKey: '' };

    const secretIdMatch = raw.match(/SecretId\s*[:：]?\s*([A-Za-z0-9_-]+)/i);
    const secretKeyMatch = raw.match(/SecretKey\s*[:：]?\s*([A-Za-z0-9_-]+)/i);
    if (secretIdMatch?.[1] && secretKeyMatch?.[1]) {
        return {
            secretId: secretIdMatch[1].trim(),
            secretKey: secretKeyMatch[1].trim()
        };
    }

    const compact = raw.replace(/\r?\n/g, ' ').trim();
    const separator = compact.includes(':') ? ':' : (compact.includes('|') ? '|' : '');
    if (separator) {
        const [secretId, ...rest] = compact.split(separator);
        return {
            secretId: String(secretId || '').trim(),
            secretKey: rest.join(separator).trim()
        };
    }

    const parts = compact.split(/\s+/).filter(Boolean);
    return {
        secretId: parts[0] || '',
        secretKey: parts[1] || ''
    };
}

function resolveTencentEndpoint(endpoint = '') {
    const raw = String(endpoint || '').trim();
    if (!raw) return { url: 'https://tts.tencentcloudapi.com', host: 'tts.tencentcloudapi.com', region: 'ap-guangzhou' };
    if (/^https?:\/\//i.test(raw)) {
        const url = new URL(raw);
        return { url: `${url.protocol}//${url.host}`, host: url.host, region: '' };
    }
    return { url: 'https://tts.tencentcloudapi.com', host: 'tts.tencentcloudapi.com', region: raw };
}

async function synthesizeTencent({ character, text, intent }) {
    const { secretId, secretKey } = parseTencentCredentials(character.tts_api_key);
    if (!secretId || !secretKey) throw new Error('腾讯云 TTS 需要粘贴 SecretId 和 SecretKey，可直接使用腾讯云弹窗里的两行格式。');

    const endpoint = resolveTencentEndpoint(character.tts_endpoint);
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const voiceType = Number(character.tts_voice || 101001);
    const body = {
        Text: String(text || '').slice(0, 500),
        SessionId: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
        ModelType: 1,
        VoiceType: voiceType,
        Codec: 'mp3',
        SampleRate: 16000,
        Speed: 0,
        Volume: 0,
        PrimaryLanguage: 1
    };
    if (String(character.tts_model || '').toLowerCase() === 'premium') {
        body.ModelType = 1;
    }
    const payload = JSON.stringify(body);
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${endpoint.host}\nx-tc-action:texttovoice\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest = [
        'POST',
        '/',
        '',
        canonicalHeaders,
        signedHeaders,
        sha256(payload)
    ].join('\n');
    const credentialScope = `${date}/tts/tc3_request`;
    const stringToSign = [
        'TC3-HMAC-SHA256',
        timestamp,
        credentialScope,
        sha256(canonicalRequest)
    ].join('\n');
    const secretDate = hmacSha256(`TC3${secretKey}`, date);
    const secretService = hmacSha256(secretDate, 'tts');
    const secretSigning = hmacSha256(secretService, 'tc3_request');
    const signature = hmacSha256(secretSigning, stringToSign, 'hex');
    const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const headers = {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
        Host: endpoint.host,
        'X-TC-Action': 'TextToVoice',
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Version': '2019-08-23'
    };
    if (endpoint.region) headers['X-TC-Region'] = endpoint.region;

    const res = await fetch(endpoint.url, { method: 'POST', headers, body: payload });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.Response?.Error) {
        const err = data.Response?.Error;
        throw new Error(err?.Message || `腾讯云 TTS 请求失败 (${res.status})`);
    }
    const audio = data.Response?.Audio;
    if (!audio) throw new Error('腾讯云 TTS 没有返回音频。');
    return { buffer: Buffer.from(audio, 'base64'), mimeType: 'audio/mpeg', extension: 'mp3' };
}

async function synthesizeOpenAI({ character, text }) {
    const key = String(character.tts_api_key || '').trim();
    if (!key) throw new Error('OpenAI TTS 需要 API Key。');
    const endpoint = String(character.tts_endpoint || 'https://api.openai.com/v1/audio/speech').trim();
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: character.tts_model || 'gpt-4o-mini-tts',
            voice: character.tts_voice || 'alloy',
            input: String(text || '').slice(0, 4000),
            response_format: 'mp3'
        })
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`OpenAI TTS 请求失败 (${res.status}) ${detail.slice(0, 160)}`);
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: 'audio/mpeg', extension: 'mp3' };
}

async function synthesizeCustom({ character, text, intent }) {
    const endpoint = String(character.tts_endpoint || '').trim();
    if (!endpoint) throw new Error('自定义 TTS 需要填写 Endpoint。');
    const headers = { 'Content-Type': 'application/json' };
    const key = String(character.tts_api_key || '').trim();
    if (key) headers.Authorization = key.startsWith('Bearer ') ? key : `Bearer ${key}`;
    const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            text,
            voice: character.tts_voice || '',
            model: character.tts_model || '',
            intent: intent || null,
            response_format: 'mp3'
        })
    });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`自定义 TTS 请求失败 (${res.status}) ${detail.slice(0, 160)}`);
    }
    if (/audio\//i.test(contentType)) {
        return { buffer: Buffer.from(await res.arrayBuffer()), mimeType: contentType.split(';')[0], extension: 'mp3' };
    }
    const data = await res.json();
    const base64 = data.audio_base64 || data.audio || data.data;
    if (!base64) throw new Error('自定义 TTS 没有返回 audio_base64/audio。');
    return {
        buffer: Buffer.from(String(base64).replace(/^data:audio\/\w+;base64,/, ''), 'base64'),
        mimeType: data.mime_type || 'audio/mpeg',
        extension: data.extension || 'mp3'
    };
}

async function synthesizeSpeech({ character, text, intent }) {
    const provider = String(character.tts_provider || 'tencent').trim().toLowerCase();
    if (provider === 'tencent') return synthesizeTencent({ character, text, intent });
    if (provider === 'openai') return synthesizeOpenAI({ character, text, intent });
    if (provider === 'custom') return synthesizeCustom({ character, text, intent });
    throw new Error(`${character.tts_provider || provider} TTS 运行接口还没接入。`);
}

function shouldSynthesizePrivateTts({ character, text, intent, isUserReply }) {
    if (!isUserReply) return false;
    if (!character || Number(character.tts_enabled || 0) !== 1) return false;
    if (!String(text || '').trim()) return false;
    const mode = String(character.tts_trigger_mode || 'tagged').trim();
    if (mode === 'all_private') return true;
    return !!intent;
}

async function synthesizeAndStoreMessage({ db, userId, character, messageId, text, intent, broadcastEvent, wsClients }) {
    const id = Number(messageId || 0);
    if (!id) return null;
    db.upsertMessageTts?.({
        message_id: id,
        character_id: character.id,
        provider: character.tts_provider || 'tencent',
        voice: character.tts_voice || '',
        model: character.tts_model || '',
        status: 'pending',
        intent_json: JSON.stringify(intent || {}),
        updated_at: Date.now()
    });
    try {
        const audio = await synthesizeSpeech({ character, text, intent });
        const dir = path.join(DATA_DIR, String(userId || 'default'));
        fs.mkdirSync(dir, { recursive: true });
        const filename = `${id}.${audio.extension || 'mp3'}`;
        const audioPath = path.join(dir, filename);
        fs.writeFileSync(audioPath, audio.buffer);
        const row = db.upsertMessageTts?.({
            message_id: id,
            character_id: character.id,
            provider: character.tts_provider || 'tencent',
            voice: character.tts_voice || '',
            model: character.tts_model || '',
            status: 'ready',
            mime_type: audio.mimeType || 'audio/mpeg',
            audio_path: audioPath,
            error: '',
            intent_json: JSON.stringify(intent || {}),
            updated_at: Date.now()
        });
        const payload = {
            type: 'tts_ready',
            data: {
                message_id: id,
                character_id: character.id,
                status: 'ready',
                audio_url: `/api/tts/audio/${id}`,
                provider: character.tts_provider || 'tencent',
                voice: character.tts_voice || '',
                model: character.tts_model || '',
                autoplay: Number(character.tts_autoplay || 0) === 1
            }
        };
        if (typeof broadcastEvent === 'function') broadcastEvent(wsClients, payload);
        return row;
    } catch (e) {
        db.upsertMessageTts?.({
            message_id: id,
            character_id: character.id,
            provider: character.tts_provider || 'tencent',
            voice: character.tts_voice || '',
            model: character.tts_model || '',
            status: 'error',
            error: e.message,
            intent_json: JSON.stringify(intent || {}),
            updated_at: Date.now()
        });
        if (typeof broadcastEvent === 'function') {
            broadcastEvent(wsClients, {
                type: 'tts_ready',
                data: {
                    message_id: id,
                    character_id: character.id,
                    status: 'error',
                    error: e.message
                }
            });
        }
        console.warn(`[TTS] Failed for message ${id}: ${e.message}`);
        return null;
    }
}

module.exports = {
    parseTtsIntentTag,
    stripTtsIntentTags,
    shouldSynthesizePrivateTts,
    synthesizeAndStoreMessage,
    synthesizeSpeech
};
