// Native fetch is available in Node 18+ (no require needed)

/**
 * Universal adapter for making calls to OpenAI-compatible LLM endpoints.
 * @param {Object} options
 * @param {string} options.endpoint The base URL (e.g., https://api.openai.com/v1)
 * @param {string} options.key The API key for authorization
 * @param {string} options.model The model identifier (e.g., gpt-4o, deepseek-chat)
 * @param {Array} options.messages Array of message objects {role, content}
 * @param {number} options.maxTokens Max tokens to generate
 * @param {number} options.temperature Generation temperature
 * @returns {Promise<string>} The generated reply text
 */
async function callLLM({ endpoint, key, model, messages, maxTokens = 2000, temperature = 0.9 }) {
    if (!endpoint || !key || !model) {
        throw new Error('LLM call missing required configuration (endpoint, key, or model).');
    }

    // Ensure endpoint doesn't end with a slash for consistent concatenation
    let baseUrl = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
    if (baseUrl.endsWith('/chat/completions')) {
        baseUrl = baseUrl.slice(0, -'/chat/completions'.length);
    }
    const url = `${baseUrl}/chat/completions`;

    // Retry up to 2 times if model returns empty content
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            // On retry, bump temperature slightly to encourage different output
            const attemptTemp = attempt > 1 ? Math.min(1.2, temperature + 0.2) : temperature;

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`,
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages,
                    max_tokens: maxTokens,
                    temperature: attemptTemp,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API Error ${response.status}: ${errorText}`);
            }

            const data = await response.json();

            if (!data.choices || !data.choices[0] || !data.choices[0].message) {
                console.error(`[LLM Debug] Unexpected response structure:`, JSON.stringify(data).substring(0, 500));
                throw new Error('Unexpected response format from API');
            }

            let content = data.choices[0].message.content || '';
            const finishReason = data.choices[0].finish_reason || 'unknown';

            // Try alternative content fields if primary is empty
            if (!content) {
                content = data.choices[0].message.text
                    || data.choices[0].text
                    || data.choices[0].message.reasoning_content
                    || '';
            }

            // Strip <think>...</think> blocks from reasoning models (DeepSeek-R1, QwQ, etc.)
            content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            content = content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();

            // Strip any leftover orphan opening/closing think tags
            content = content.replace(/<\/?think>/gi, '').trim();
            content = content.replace(/<\/?thinking>/gi, '').trim();

            // If stripping removed everything, recover the non-tag content
            if (content.length === 0 && (data.choices[0].message.content || '').length > 0) {
                const rawContent = data.choices[0].message.content;
                console.warn(`[LLM Warning] Think-tag stripping removed ALL content. Recovering...`);
                content = rawContent
                    .replace(/<\/?think>/gi, '')
                    .replace(/<\/?thinking>/gi, '')
                    .trim();
            }

            // If content is still empty, retry (unless last attempt)
            if (!content && attempt < maxAttempts) {
                console.warn(`[LLM Retry] Empty response from ${model} (finish_reason=${finishReason}), retrying (attempt ${attempt + 1}/${maxAttempts})...`);
                continue;
            }

            if (!content) {
                console.warn(`[LLM Warning] Empty response from ${model} after ${maxAttempts} attempts (finish_reason=${finishReason})`);
            }

            return content;
        } catch (error) {
            // On non-empty errors, don't retry — throw immediately
            console.error(`[LLM Error] (${model} at ${endpoint}):`, error.message);
            let errorMsg = error.message;
            if (errorMsg.includes('fetch failed') || errorMsg.includes('ECONNREFUSED')) {
                errorMsg = `网络连接失败 (fetch failed)。请检查您的 API Endpoint [${endpoint}] 是否填写正确，以及目标服务器是否正在运行并未被防火墙拦截。`;
            } else if (errorMsg.includes('Unexpected response format')) {
                errorMsg = `API 返回格式异常。请确认您使用的是兼容 OpenAI 格式的接口。`;
            }
            throw new Error(errorMsg);
        }
    }

    return ''; // Shouldn't reach here, but safety fallback
}

module.exports = {
    callLLM
};
