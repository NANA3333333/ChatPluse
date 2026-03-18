const { encode } = require('gpt-tokenizer');

/**
 * server/utils/tokenizer.js
 * 
 * Utility for accurate token counting using gpt-tokenizer (cl100k_base).
 */

function getTokenCount(text) {
    if (!text) return 0;
    try {
        // gpt-tokenizer's encode function returns an array of token IDs
        const tokens = encode(text);
        return tokens.length;
    } catch (e) {
        console.warn('[Tokenizer] Accurate counting failed, falling back to naive estimation:', e.message);
        // Fallback to naive chars/2 estimation
        return Math.ceil(text.length / 2);
    }
}

module.exports = {
    getTokenCount
};
