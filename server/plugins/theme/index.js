/**
 * Theme DLC — AI Theme Generation
 * Extracted from server/index.js
 */
module.exports = function initTheme(app, context) {
    const { authMiddleware, getUserDb, callLLM } = context;

    // Theme Generation Guide (downloadable prompt)
    app.get('/api/theme-guide', authMiddleware, (req, res) => {
        try {
            const guideText = `ChatPulse Theme Generation Guide

You are an expert UI/UX designer. I want you to create a custom theme for my ChatPulse application.
ChatPulse uses a strict CSS Variable system at the :root level. 
Please generate a JSON object containing the following keys with HEX color values that form a cohesive, beautiful theme:

{
  "--bg-main": "Main app background color (e.g. #F8F0F5)",
  "--bg-sidebar": "Very left navigation bar background (e.g. #2A2D3E)",
  "--bg-sidebar-hover": "Hover state for sidebar icons (e.g. rgba(255,255,255,0.1))",
  "--bg-contacts": "Contacts list middle column background (e.g. #F0F4FA)",
  "--bg-chat-area": "Right side chatting area background (e.g. #F8F0F5)",
  "--bg-input": "Message input box background (e.g. #FFFFFF)",
  "--text-primary": "Main reading text color (e.g. #333333)",
  "--text-secondary": "Muted text / timestamps (e.g. #999999)",
  "--bubble-user-bg": "Background for messages I send (e.g. #B8D4F0)",
  "--bubble-user-text": "Text color for my messages (e.g. #333333)",
  "--bubble-ai-bg": "Background for AI messages (e.g. #FFF0F5)",
  "--bubble-ai-text": "Text color for AI messages (e.g. #333333)",
  "--accent-color": "Primary brand color for active items/buttons (e.g. #7B9FE0)",
  "--accent-hover": "Hover state for primary buttons (e.g. #9BB5E8)",
  "--border-color": "Subtle borders between panes (e.g. #E0E0E0)"
}

Only output the raw valid JSON object, without markdown formatting or surrounding explanations. I need to upload this directly into the app.`;

            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="chatpulse-theme-prompt.txt"');
            res.send(guideText);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // AI Theme Generation
    app.post('/api/theme/generate', authMiddleware, async (req, res) => {
        try {
            const { query, api_endpoint, api_key, model_name } = req.body;
            if (!query || !api_endpoint || !api_key || !model_name) {
                return res.status(400).json({ error: 'Missing required API keys or theme description.' });
            }

            const systemPrompt = `You are an expert UI/UX designer. Create a custom theme for a chat application based on the user's request.
Return ONLY a raw JSON object with no markdown formatting. Do not include \`\`\`json blocks.
The JSON MUST have the EXACT following keys with valid 6-hex-digit HTML color codes (e.g. #F8F0F5):
- "--bg-main" (Main app background color)
- "--bg-sidebar" (Very left navigation bar background)
- "--bg-contacts" (Contacts list middle column background)
- "--bg-chat-area" (Right side chatting area background)
- "--bg-input" (Message input box background)
- "--text-primary" (Main reading text color)
- "--text-secondary" (Muted text / timestamps)
- "--bubble-user-bg" (Background for messages I send)
- "--bubble-user-text" (Text color for my messages)
- "--bubble-ai-bg" (Background for AI messages)
- "--bubble-ai-text" (Text color for AI messages)
- "--accent-color" (Primary brand color for active items/buttons)
- "--accent-hover" (Hover state for primary buttons)
- "--border-color" (Subtle borders between panes)
`;

            const generatedText = await callLLM({
                endpoint: api_endpoint,
                key: api_key,
                model: model_name,
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: query }],
                maxTokens: 800,
                temperature: 0.7
            });

            console.log(`[Theme Generator Raw Output]`, generatedText);

            // Aggressively strip markdown formatting
            let cleanText = generatedText.replace(/```json/gi, '').replace(/```/g, '').trim();

            const startIdx = cleanText.indexOf('{');
            const endIdx = cleanText.lastIndexOf('}');
            if (startIdx !== -1 && endIdx !== -1) {
                const jsonText = cleanText.slice(startIdx, endIdx + 1);
                try {
                    const parsed = JSON.parse(jsonText);
                    return res.json({ success: true, theme_config: parsed });
                } catch (err) {
                    console.error('JSON.parse failed on this theme string:\n', jsonText);
                    throw new Error('LLM JSON Syntax Error: ' + err.message);
                }
            } else {
                console.error('Failed to find JSON brackets in cleanText:', cleanText);
                throw new Error('LLM did not return a valid JSON object. Check Server Logs.');
            }
        } catch (e) {
            console.error('Theme Generation Error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    console.log('[Theme DLC] Theme generation routes registered.');
};
