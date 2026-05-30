const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');

function readRepoFile(...segments) {
    return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

function walkFiles(dir, predicate, shouldSkipDir = () => false, results = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!shouldSkipDir(fullPath)) {
                walkFiles(fullPath, predicate, shouldSkipDir, results);
            }
            continue;
        }
        if (predicate(fullPath)) results.push(fullPath);
    }
    return results;
}

test('system backup export is protected by normal auth middleware', () => {
    const backupPlugin = readRepoFile('server', 'plugins', 'backup', 'index.js');

    assert.match(
        backupPlugin,
        /app\.get\(\s*['"]\/api\/system\/export['"]\s*,\s*authMiddleware\s*,/,
        'export route must use the shared auth middleware'
    );
    assert.doesNotMatch(
        backupPlugin,
        /req\.query\.token|jwt\.verify\(|JWT_SECRET/,
        'export route must not accept or verify URL query tokens directly'
    );
});

test('settings backup download does not put auth tokens in URLs', () => {
    const settingsPanel = readRepoFile('client', 'src', 'components', 'SettingsPanel.jsx');

    assert.doesNotMatch(settingsPanel, /system\/export\?token=/, 'backup URL must not include token query params');
    assert.match(settingsPanel, /fetch\(`\$\{apiUrl\}\/system\/export`/, 'backup export should be downloaded with fetch');
    assert.match(settingsPanel, /Authorization['"]?\s*:\s*`Bearer \$\{localStorage\.getItem\('cp_token'\) \|\| ''\}`/, 'backup fetch must send the cp_token authorization header');
});

test('settings theme guide download sends auth headers', () => {
    const settingsPanel = readRepoFile('client', 'src', 'components', 'SettingsPanel.jsx');

    assert.doesNotMatch(settingsPanel, /href=\{`\$\{apiUrl\}\/theme-guide`\}/, 'theme guide download must not use an unauthenticated anchor href');
    assert.match(settingsPanel, /fetch\(`\$\{apiUrl\}\/theme-guide`,\s*\{[\s\S]*Authorization['"]?\s*:\s*`Bearer \$\{localStorage\.getItem\('cp_token'\) \|\| ''\}`/, 'theme guide fetch must send the cp_token authorization header');
    assert.match(settingsPanel, /downloadAnchorNode\.download = 'chatpulse-theme-prompt\.txt'/, 'theme guide download filename should stay stable');
});

test('social and drawer panels send auth to protected APIs', () => {
    const addCharacterModal = readRepoFile('client', 'src', 'components', 'AddCharacterModal.jsx');
    const createGroupModal = readRepoFile('client', 'src', 'components', 'CreateGroupModal.jsx');
    const momentsFeed = readRepoFile('client', 'src', 'components', 'MomentsFeed.jsx');
    const diaryTable = readRepoFile('client', 'src', 'components', 'DiaryTable.jsx');
    const recommendModal = readRepoFile('client', 'src', 'components', 'RecommendModal.jsx');
    const chatSettingsDrawer = readRepoFile('client', 'src', 'components', 'ChatSettingsDrawer.jsx');

    assert.match(addCharacterModal, /fetch\(`\$\{apiUrl\}\/characters`,\s*\{[\s\S]*headers: authJsonHeaders/, 'character creation should send auth and JSON headers');
    assert.match(addCharacterModal, /fetch\(`\$\{apiUrl\}\/characters\/generate`,\s*\{[\s\S]*headers: authJsonHeaders/, 'character generation should send auth and JSON headers');
    assert.match(addCharacterModal, /fetch\(`\$\{apiUrl\}\/models`,\s*\{[\s\S]*headers: authJsonHeaders/, 'add-character model lookup should send auth and JSON headers');
    assert.match(createGroupModal, /fetch\(`\$\{apiUrl\}\/groups`,\s*\{[\s\S]*headers: authJsonHeaders/, 'group creation should send auth and JSON headers');

    assert.match(momentsFeed, /fetch\(`\$\{apiUrl\}\/characters`, \{ headers: authOnlyHeaders \}\)/, 'moments character preload should send auth');
    assert.match(momentsFeed, /fetch\(`\$\{apiUrl\}\/moments`, \{ headers: authOnlyHeaders \}\)/, 'moments list should send auth');
    assert.match(momentsFeed, /fetch\(`\$\{apiUrl\}\/moments`,\s*\{[\s\S]*headers: authJsonHeaders/, 'moment creation should send auth and JSON headers');
    assert.match(momentsFeed, /fetch\(`\$\{apiUrl\}\/moments\/\$\{id\}\/like`,\s*\{[\s\S]*headers: authJsonHeaders/, 'moment likes should send auth and JSON headers');
    assert.match(momentsFeed, /fetch\(`\$\{apiUrl\}\/moments\/\$\{momentId\}\/comment`,\s*\{[\s\S]*headers: authJsonHeaders/, 'moment comments should send auth and JSON headers');
    assert.doesNotMatch(momentsFeed, /fetch\(`\$\{apiUrl\}\/moments`\)/, 'moments should not use naked protected fetch calls');

    assert.match(diaryTable, /fetch\(`\$\{apiUrl\}\/diaries\/\$\{contact\.id\}`, \{ headers: authOnlyHeaders \}\)/, 'diary reads should send auth');
    assert.match(diaryTable, /fetch\(`\$\{apiUrl\}\/diaries\/\$\{contact\.id\}\/unlock`,\s*\{[\s\S]*headers: authJsonHeaders/, 'diary unlock should send auth and JSON headers');
    assert.match(recommendModal, /fetch\(`\$\{apiUrl\}\/characters\/\$\{currentContact\.id\}\/friends`, \{ headers: authOnlyHeaders \}\)/, 'recommend modal friend list should send auth');

    assert.match(chatSettingsDrawer, /fetch\(`\$\{apiUrl\}\/characters\/\$\{contact\.id\}\/relationships`, \{ headers: authOnlyHeaders \}\)/, 'relationship drawer reads should send auth');
    assert.match(chatSettingsDrawer, /fetch\(`\$\{apiUrl\}\/city\/schedules\/\$\{contact\.id\}`, \{ headers: authOnlyHeaders \}\)/, 'schedule drawer reads should send auth');
    assert.match(chatSettingsDrawer, /fetch\(`\$\{apiUrl\}\/characters\/\$\{contact\.id\}\/impressions\/\$\{targetId\}\?limit=10`, \{ headers: authOnlyHeaders \}\)/, 'impression history reads should send auth');
});

test('backup zip import validates entry paths before extraction', () => {
    const backupPlugin = readRepoFile('server', 'plugins', 'backup', 'index.js');

    assert.doesNotMatch(
        backupPlugin,
        /unzipper\.Extract\(/,
        'backup imports must not blindly extract zip archives'
    );
    assert.match(backupPlugin, /function resolveSafeZipEntryPath/, 'backup imports should validate each zip entry path');
    assert.match(backupPlugin, /path\.posix\.normalize\(rawPath\)/, 'zip path validation should normalize archive paths');
    assert.match(backupPlugin, /normalizedPath\.startsWith\('\.\.\/'\)/, 'zip path validation should reject traversal entries');
    assert.match(backupPlugin, /unzipper\.Open\.file\(zipPath\)/, 'backup imports should inspect entries before writing them');
});

test('upload references used by backup and admin stats stay inside uploads', () => {
    const files = [
        readRepoFile('server', 'plugins', 'backup', 'index.js'),
        readRepoFile('server', 'plugins', 'adminDashboard', 'index.js')
    ];

    for (const source of files) {
        assert.match(source, /path\.posix\.normalize\(rel\)/, 'upload reference paths should be normalized as POSIX relative paths');
        assert.match(source, /rel\.includes\('\\0'\)/, 'upload reference paths should reject null bytes');
        assert.match(source, /normalizedPath\.startsWith\('\.\.\/'\)/, 'upload reference paths should reject traversal');
        assert.match(source, /normalizedPath\.startsWith\('uploads\/'\)/, 'upload references should be constrained to the uploads prefix');
        assert.match(source, /(?:function|const)\s+resolveUploadReferencePath/, 'file access should re-resolve upload references before use');
        assert.match(source, /path\.resolve\(/, 'upload reference file access should use resolved absolute paths');
    }
});

test('general upload endpoint only stores verified image files', () => {
    const serverIndex = readRepoFile('server', 'index.js');

    assert.match(serverIndex, /const allowedImageMimeTypes = new Set\(\[/, 'upload endpoint should enumerate allowed image MIME types');
    assert.match(serverIndex, /const allowedImageExtensions = new Set\(\[/, 'upload endpoint should enumerate allowed image extensions');
    assert.match(serverIndex, /function isValidImageUploadContent\(file\)/, 'upload endpoint should verify saved image content');
    assert.match(serverIndex, /upload\.single\('image'\)/, 'upload endpoint should accept one image field only');
    assert.match(serverIndex, /cleanupUploadedFile\(file\)/, 'invalid uploads should be deleted after content validation');
    assert.doesNotMatch(serverIndex, /file\.originalname\.endsWith\('\.db'\)/, 'general image upload must not accept database files');
    assert.doesNotMatch(serverIndex, /Only images and \.db backups are allowed/, 'general image upload copy must not advertise DB backup upload support');
});

test('tts audio downloads are constrained to the current user audio directory', () => {
    const serverIndex = readRepoFile('server', 'index.js');

    assert.match(serverIndex, /const ttsAudioRoot = path\.resolve\(__dirname, '\.\.', 'data', 'tts'\)/, 'TTS audio root should be explicit');
    assert.match(serverIndex, /function resolveTtsAudioPath\(userId, audioPath\)/, 'TTS audio route should resolve stored paths through a boundary helper');
    assert.match(serverIndex, /path\.resolve\(ttsAudioRoot, String\(userId \|\| 'default'\)\)/, 'TTS audio route should scope files to the current user');
    assert.match(serverIndex, /resolvedPath\.startsWith\(userAudioRoot \+ path\.sep\)/, 'TTS audio route should reject paths outside the user audio directory');
    assert.match(serverIndex, /const audioPath = resolveTtsAudioPath\(req\.user\.id, row\.audio_path\)/, 'TTS audio route should validate the DB path before use');
    assert.match(serverIndex, /res\.sendFile\(audioPath\)/, 'TTS audio route should send only the resolved bounded path');
    assert.doesNotMatch(serverIndex, /res\.sendFile\(path\.resolve\(row\.audio_path\)\)/, 'TTS audio route must not send arbitrary DB paths');
    assert.match(serverIndex, /function sanitizeTtsMimeType\(value\)/, 'TTS audio route should sanitize DB-provided MIME types');
});

test('character and memory export filenames never reuse raw character ids', () => {
    const serverIndex = readRepoFile('server', 'index.js');

    assert.match(serverIndex, /function sanitizeDownloadName\(value, fallback = 'character'\)/, 'download filenames should use a shared sanitizer');
    assert.match(serverIndex, /const clean = \(input\) => String\(input \|\| ''\)/, 'download filename fallback values should also be sanitized');
    assert.match(serverIndex, /const filenameId = sanitizeDownloadName\(req\.params\.characterId, 'character'\)/, 'character archive export should sanitize character ids');
    assert.match(serverIndex, /filename="\$\{filenameBase\}_\$\{filenameId\}_character_export\.json"/, 'character archive filename should use the sanitized id');
    assert.match(serverIndex, /const filenameId = sanitizeDownloadName\(characterId, 'character'\)/, 'memory export should sanitize character ids');
    assert.match(serverIndex, /filename="\$\{filenameBase\}_\$\{filenameId\}_memories_export\.json"/, 'memory export filename should use the sanitized id');
    assert.doesNotMatch(serverIndex, /filename="\$\{filenameBase\}_\$\{req\.params\.characterId\}_character_export\.json"/, 'character archive filename must not include raw route params');
    assert.doesNotMatch(serverIndex, /filename="\$\{filenameBase\}_\$\{characterId\}_memories_export\.json"/, 'memory export filename must not include raw route params');
});

test('models proxy requires auth and does not put provider keys in URLs', () => {
    const serverIndex = readRepoFile('server', 'index.js');
    const clientSrc = path.join(repoRoot, 'client', 'src');
    const offenders = [];

    assert.match(
        serverIndex,
        /app\.post\(\s*['"]\/api\/models['"]\s*,\s*authMiddleware\s*,/,
        'models proxy POST route must use shared auth middleware'
    );
    assert.match(
        serverIndex,
        /app\.get\(\s*['"]\/api\/models['"]\s*,\s*authMiddleware\s*,/,
        'legacy models proxy GET route must also require auth'
    );

    for (const filePath of walkFiles(clientSrc, (candidate) => /\.(js|jsx)$/.test(candidate))) {
        const text = fs.readFileSync(filePath, 'utf8');
        if (/\/models\?endpoint=.*key=|\/models\?endpoint=\$\{/.test(text)) {
            offenders.push(path.relative(repoRoot, filePath));
        }
    }

    assert.deepEqual(offenders, [], 'provider API keys must not be sent through /api/models query strings');
});

test('websocket auth does not put JWTs in URLs and checks account state', () => {
    const app = readRepoFile('client', 'src', 'App.jsx');
    const serverIndex = readRepoFile('server', 'index.js');

    assert.doesNotMatch(app, /new WebSocket\(`\$\{WS_URL\}\/\?token=\$\{token\}`\)/, 'frontend websocket must not put JWTs in the URL');
    assert.match(app, /new WebSocket\(WS_URL\)/, 'frontend websocket should connect without query-string credentials');
    assert.match(serverIndex, /function verifyAuthToken\(token\)/, 'HTTP and WS auth should share token verification');
    assert.match(serverIndex, /verifyAuthToken\(data\.token\)/, 'websocket auth message should use shared token verification');
    assert.match(serverIndex, /authDb\.getUserById\(decoded\.id\)/, 'shared auth must check that the user still exists');
    assert.match(serverIndex, /authUser\.status === 'banned'/, 'shared auth must reject banned users');
    assert.match(serverIndex, /decoded\.tokenVersion[\s\S]*authUser\.token_version/, 'shared auth must reject stale tokens after password or account changes');
});

test('admin user mutations cannot target the protected root account', () => {
    const adminDashboard = readRepoFile('server', 'plugins', 'adminDashboard', 'index.js');

    assert.match(adminDashboard, /const getMutableAdminTarget = \(req, res\) => \{/, 'admin dashboard should centralize target-user validation');
    assert.match(adminDashboard, /targetUser\.role === 'root'[\s\S]*Root account is protected/, 'root account should be protected from admin mutations');

    const protectedRoutes = [
        "app.delete('/api/admin/users/:id'",
        "app.post('/api/admin/users/:id/ban'",
        "app.post('/api/admin/users/:id/role'",
        "app.post('/api/admin/users/:id/reset-password'",
        "app.post('/api/admin/users/:id/force-logout'"
    ];

    for (const route of protectedRoutes) {
        const routeIndex = adminDashboard.indexOf(route);
        assert.notEqual(routeIndex, -1, `${route} should exist`);
        const routeBlock = adminDashboard.slice(routeIndex, routeIndex + 900);
        assert.match(routeBlock, /getMutableAdminTarget\(req, res\)/, `${route} must reject root targets before mutating users`);
    }
});

test('admin invite creation is a POST-only state change', () => {
    const adminDashboard = readRepoFile('server', 'plugins', 'adminDashboard', 'index.js');
    const adminClient = readRepoFile('client', 'src', 'components', 'AdminDashboard.jsx');

    assert.match(
        adminDashboard,
        /app\.post\(\s*['"]\/api\/admin\/invites['"]\s*,\s*authMiddleware\s*,\s*adminMiddleware\s*,/,
        'invite creation must use POST'
    );
    assert.doesNotMatch(
        adminDashboard,
        /app\.get\(\s*['"]\/api\/admin\/invites['"]/,
        'invite creation must not be exposed as a state-changing GET route'
    );
    assert.match(
        adminClient,
        /fetch\(`\$\{cleanApiUrl\}\/api\/admin\/invites`,\s*\{\s*method: 'POST'/,
        'admin UI should create invite codes with POST'
    );
});

test('transfer card calls authenticated transfer APIs', () => {
    const messageBubble = readRepoFile('client', 'src', 'components', 'MessageBubble.jsx');
    const economyPlugin = readRepoFile('server', 'plugins', 'economy', 'index.js');

    assert.match(economyPlugin, /app\.get\(\s*['"]\/api\/transfers\/:tid['"]\s*,\s*authMiddleware\s*,/, 'transfer status API is authenticated');
    assert.match(economyPlugin, /app\.post\(\s*['"]\/api\/transfers\/:tid\/claim['"]\s*,\s*authMiddleware\s*,/, 'transfer claim API is authenticated');
    assert.match(economyPlugin, /app\.post\(\s*['"]\/api\/transfers\/:tid\/refund['"]\s*,\s*authMiddleware\s*,/, 'transfer refund API is authenticated');
    assert.match(messageBubble, /function buildAuthHeaders/, 'transfer card should share an auth header helper');
    assert.match(messageBubble, /window\.localStorage\.getItem\('cp_token'\)/, 'transfer card should read the current cp_token');
    assert.match(messageBubble, /headers: buildAuthHeaders\(\)/, 'transfer status refresh should send auth headers');
    assert.match(messageBubble, /headers: buildAuthHeaders\(\{ 'Content-Type': 'application\/json' \}\)/, 'transfer actions should send auth and JSON headers');
    assert.doesNotMatch(messageBubble, /fetch\(`\$\{apiUrl\}\/transfers\/\$\{tid\}`\)/, 'transfer status must not be fetched without auth options');
});

test('interactive HTTP routes do not trust client-supplied actor ids', () => {
    const serverIndex = readRepoFile('server', 'index.js');
    const economyPlugin = readRepoFile('server', 'plugins', 'economy', 'index.js');
    const momentsFeed = readRepoFile('client', 'src', 'components', 'MomentsFeed.jsx');
    const groupChatWindow = readRepoFile('client', 'src', 'components', 'GroupChatWindow.jsx');

    assert.match(serverIndex, /db\.toggleLike\(req\.params\.id, 'user'\)/, 'moment likes should always use the authenticated user actor');
    assert.match(serverIndex, /db\.addComment\(req\.params\.id, 'user', content\)/, 'moment comments should always use the authenticated user actor');
    assert.doesNotMatch(serverIndex, /const \{ liker_id \} = req\.body/, 'moment like route must not trust a request-body liker id');
    assert.doesNotMatch(serverIndex, /const \{ author_id, content \} = req\.body/, 'moment comment route must not trust a request-body author id');

    assert.match(economyPlugin, /const claimer_id = 'user';[\s\S]*db\.claimTransfer\(parseInt\(req\.params\.tid\), claimer_id\)/, 'transfer claim should always use the authenticated user actor');
    assert.match(economyPlugin, /const refunder_id = 'user';[\s\S]*db\.refundTransfer\(tid, refunder_id\)/, 'transfer refund should always use the authenticated user actor');
    assert.match(economyPlugin, /const sender_id = 'user';[\s\S]*db\.createRedPacket\(\{[\s\S]*senderId: sender_id/, 'red packet creation should always use the authenticated user actor');
    assert.match(economyPlugin, /const claimer_id = 'user';[\s\S]*db\.claimRedPacket\(parseInt\(req\.params\.pid\), claimer_id\)/, 'red packet claim should always use the authenticated user actor');
    assert.doesNotMatch(economyPlugin, /const \{ claimer_id = 'user' \} = req\.body/, 'economy routes must not trust request-body claimer ids');
    assert.doesNotMatch(economyPlugin, /const \{ sender_id = 'user'/, 'red packet creation must not trust request-body sender ids');

    assert.doesNotMatch(momentsFeed, /liker_id: 'user'|author_id: 'user'/, 'moments UI should not send spoofable actor ids');
    assert.doesNotMatch(groupChatWindow, /claimer_id: 'user'/, 'red packet UI should not send spoofable actor ids');
});

test('red packet creation rejects invalid money and count values before wallet writes', () => {
    const economyPlugin = readRepoFile('server', 'plugins', 'economy', 'index.js');
    const dbSource = readRepoFile('server', 'db.js');

    assert.match(economyPlugin, /function normalizePositiveMoney\(value\)/, 'red packet API should normalize positive money values');
    assert.match(economyPlugin, /function normalizePacketCount\(value\)/, 'red packet API should normalize bounded counts');
    assert.match(economyPlugin, /!\['fixed', 'lucky'\]\.includes\(packetType\) \|\| !packetCount/, 'red packet API should reject invalid types and counts');
    assert.match(economyPlugin, /if \(!total \|\| total <= 0\)/, 'red packet API should reject zero, negative, and non-finite totals');
    assert.match(economyPlugin, /perAmount \? \+\(perAmount \* packetCount\)\.toFixed\(2\) : null/, 'fixed red packet totals should be derived from validated positive per-person amounts');
    assert.doesNotMatch(economyPlugin, /parseFloat\(total_amount\)\.toFixed\(2\)/, 'red packet API must not accept raw total_amount parsing without validation');
    assert.doesNotMatch(economyPlugin, /parseFloat\(per_amount\) \* parseInt\(count\)/, 'red packet API must not multiply raw amount/count values');

    assert.match(dbSource, /if \(!Number\.isFinite\(packetTotal\) \|\| packetTotal <= 0\) throw new Error\('红包金额无效'\)/, 'DB red packet creation should reject invalid totals');
    assert.match(dbSource, /if \(!Number\.isSafeInteger\(packetCount\) \|\| packetCount < 1 \|\| packetCount > 100\) throw new Error\('红包个数无效'\)/, 'DB red packet creation should reject unsafe counts');
    assert.match(dbSource, /if \(packetType === 'fixed' && \(!Number\.isFinite\(packetPerAmount\) \|\| packetPerAmount <= 0\)\) throw new Error\('红包金额无效'\)/, 'DB fixed red packet creation should reject invalid per-person amounts');
    assert.match(dbSource, /bal < packetTotal/, 'wallet balance checks should use validated positive totals');
    assert.doesNotMatch(dbSource, /bal < totalAmount/, 'wallet balance checks must not use raw totalAmount values');
});

test('group message batch deletion is constrained to the route group', () => {
    const groupChatPlugin = readRepoFile('server', 'plugins', 'groupChat', 'index.js');
    const dbSource = readRepoFile('server', 'db.js');

    assert.match(groupChatPlugin, /db\.deleteGroupMessages\(req\.params\.id, messageIds\)/, 'group batch delete route should pass the current group id to the DB');
    assert.match(dbSource, /function deleteGroupMessages\(groupId, messageIds\)/, 'DB helper should require a group id for batch group message deletion');
    assert.match(dbSource, /filter\(id => Number\.isSafeInteger\(id\) && id > 0\)/, 'DB helper should normalize message ids before building the placeholder list');
    assert.match(dbSource, /DELETE FROM group_messages WHERE group_id = \? AND id IN/, 'DB helper should constrain deletion by group_id and message id');
    assert.doesNotMatch(dbSource, /DELETE FROM group_messages WHERE id IN/, 'DB helper must not delete group messages by id alone');
});

test('settings upload and memo drawer avoid debug logs and use explicit auth', () => {
    const settingsPanel = readRepoFile('client', 'src', 'components', 'SettingsPanel.jsx');
    const memoTable = readRepoFile('client', 'src', 'components', 'MemoTable.jsx');

    assert.doesNotMatch(settingsPanel, /DEBUG:|DEBUG Upload/, 'avatar upload should not leave production debug logs');
    assert.doesNotMatch(memoTable, /MemoTable rendering|Real-time memory update/, 'memo drawer should not log on every render/update');
    assert.match(memoTable, /function buildAuthHeaders/, 'memo drawer should centralize auth headers');
    assert.match(memoTable, /fetch\(`\$\{apiUrl\}\/memories\/\$\{contact\.id\}`,\s*\{ headers: buildAuthHeaders\(\) \}\)/, 'memo load should send auth headers explicitly');
    assert.match(memoTable, /fetch\(`\$\{apiUrl\}\/memories\/\$\{id\}`,\s*\{ method: 'DELETE', headers: buildAuthHeaders\(\) \}\)/, 'memo delete should send auth headers explicitly');
    assert.match(memoTable, /fetch\(`\$\{apiUrl\}\/memories\/\$\{contact\.id\}\/extract`,\s*\{ method: 'POST', headers: buildAuthHeaders\(\) \}\)/, 'memo extraction should send auth headers explicitly');
});

test('relationships plugin does not persist or log raw LLM responses', () => {
    const relationships = readRepoFile('server', 'plugins', 'relationships', 'index.js');
    const leakingConsoleLines = relationships
        .split(/\r?\n/)
        .filter(line => /console\.(?:log|warn|error)/.test(line))
        .filter(line => /Raw LLM output|Input:|Cleaned:|result\.substring|cleaned\.substring|m\[0\]\.substring|leftover\.substring|iText\?\.\[1\]\?\.substring/.test(line));

    assert.doesNotMatch(relationships, /writeFileSync/, 'relationship regeneration must not write raw model output to debug files');
    assert.doesNotMatch(relationships, /debug_regen\.txt/, 'relationship regeneration must not create ad-hoc debug files');
    assert.doesNotMatch(relationships, /Raw LLM output/, 'relationship routes must not log raw model output');
    assert.doesNotMatch(relationships, /_raw:\s*cleaned/, 'relationship parsing should not carry raw model output beyond local parsing');
    assert.deepEqual(leakingConsoleLines, [], 'relationship debug logging should not include raw response snippets');
});

test('LLM generation routes do not log raw generated content', () => {
    const serverIndex = readRepoFile('server', 'index.js');
    const themePlugin = readRepoFile('server', 'plugins', 'theme', 'index.js');

    assert.doesNotMatch(serverIndex, /Generator Raw Output/, 'character generator must not log raw model output');
    assert.doesNotMatch(serverIndex, /JSON\.parse failed on this string/, 'character generator must not log failed raw JSON');
    assert.doesNotMatch(serverIndex, /Failed to find JSON brackets in cleanText:\s*,\s*cleanText/, 'character generator must not log raw non-JSON responses');
    assert.match(serverIndex, /\[Character Generator\] LLM returned \$\{String\(generatedText \|\| ''\)\.length\} chars\./, 'character generator should retain non-content diagnostics');

    assert.doesNotMatch(themePlugin, /Theme Generator Raw Output/, 'theme generator must not log raw model output');
    assert.doesNotMatch(themePlugin, /JSON\.parse failed on this theme string/, 'theme generator must not log failed raw JSON');
    assert.doesNotMatch(themePlugin, /Failed to find JSON brackets in cleanText:\s*,\s*cleanText/, 'theme generator must not log raw non-JSON responses');
    assert.match(themePlugin, /\[Theme Generator\] LLM returned \$\{String\(generatedText \|\| ''\)\.length\} chars\./, 'theme generator should retain non-content diagnostics');
});

test('login screen does not expose default Nana credentials', () => {
    const login = readRepoFile('client', 'src', 'components', 'Login.jsx');

    assert.doesNotMatch(login, /默认账号\s*Nana|Nana，默认密码|默认密码\s*12345|12345/, 'login page should not display default credentials');
});

test('account settings copy does not expose the default root password', () => {
    const settingsPanel = readRepoFile('client', 'src', 'components', 'SettingsPanel.jsx');

    assert.doesNotMatch(
        settingsPanel,
        /Default root password is 12345|默认 root 密码为 12345|默认密码\s*12345/,
        'account settings should not reveal the initial root password'
    );
});

test('fresh installs do not fall back to a hardcoded root password', () => {
    const authDb = readRepoFile('server', 'authDb.js');
    const readme = readRepoFile('README.md');

    assert.doesNotMatch(authDb, /ADMIN_PASSWORD\s*\|\|\s*['"]12345['"]/, 'auth DB must not fall back to a hardcoded root password');
    assert.match(authDb, /generateInitialAdminPassword\(\)/, 'auth DB should generate a first-run password when ADMIN_PASSWORD is absent');
    assert.match(authDb, /crypto\.randomBytes\(/, 'generated first-run password should use cryptographic randomness');
    assert.doesNotMatch(readme, /Default password:\s*`12345`|默认密码：`12345`/, 'README must not advertise a hardcoded default root password');
});

test('client code uses cp_token instead of legacy token storage', () => {
    const clientSrc = path.join(repoRoot, 'client', 'src');
    const offenders = [];

    function scan(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scan(fullPath);
                continue;
            }
            if (!/\.(js|jsx)$/.test(entry.name)) continue;
            const text = fs.readFileSync(fullPath, 'utf8');
            if (/localStorage\.(getItem|setItem|removeItem)\(['"]token['"]\)/.test(text)) {
                offenders.push(path.relative(repoRoot, fullPath));
            }
        }
    }

    scan(clientSrc);
    assert.deepEqual(offenders, [], 'legacy localStorage token key should not be used');
});

test('doctor opens sqlite native module instead of only checking installation', () => {
    const doctor = readRepoFile('scripts', 'doctor.js');

    assert.match(doctor, /new Database\(':memory:'\)/, 'doctor should instantiate better-sqlite3 to catch ABI mismatches');
    assert.match(doctor, /SQLite native module/, 'doctor should report the sqlite native module check');
});

test('critical db migrations add grouped columns independently', () => {
    const dbSource = readRepoFile('server', 'db.js');

    assert.match(dbSource, /function addColumnIfMissing/, 'db migrations should use schema-aware column creation');
    assert.match(dbSource, /addColumnIfMissing\('group_messages', 'sender_name', 'TEXT'\)/, 'sender_name should be checked independently');
    assert.match(dbSource, /addColumnIfMissing\('group_messages', 'sender_avatar', 'TEXT'\)/, 'sender_avatar should be checked independently');
    assert.match(dbSource, /addColumnIfMissing\('messages', 'is_summarized', 'INTEGER DEFAULT 0'\)/, 'private message summary flag should be checked independently');
    assert.match(dbSource, /addColumnIfMissing\('group_messages', 'is_summarized', 'INTEGER DEFAULT 0'\)/, 'group message summary flag should be checked independently');
    assert.match(dbSource, /addColumnIfMissing\('characters', 'memory_api_endpoint', 'TEXT'\)/, 'character memory endpoint migration should be checked explicitly');
    assert.match(dbSource, /addColumnIfMissing\('characters', 'memory_api_key', 'TEXT'\)/, 'character memory key migration should be checked explicitly');
    assert.match(dbSource, /addColumnIfMissing\('characters', 'memory_model_name', 'TEXT'\)/, 'character memory model migration should be checked explicitly');
    assert.match(dbSource, /addColumnIfMissing\('characters', 'tts_enabled', 'INTEGER DEFAULT 0'\)/, 'character TTS enabled migration should be checked explicitly');
    assert.match(dbSource, /addColumnIfMissing\('characters', 'tts_provider', "TEXT DEFAULT 'tencent'"\)/, 'character TTS provider migration should be checked explicitly');
    assert.match(dbSource, /addColumnIfMissing\('characters', 'tts_trigger_mode', "TEXT DEFAULT 'tagged'"\)/, 'character TTS trigger migration should be checked explicitly');
    assert.match(dbSource, /addColumnIfMissing\('characters', 'llm_debug_capture', 'INTEGER DEFAULT 1'\)/, 'character LLM debug migration should match fresh-schema defaults');
    assert.doesNotMatch(
        dbSource,
        /ALTER TABLE group_messages ADD COLUMN sender_name TEXT['"`\s\S]*ALTER TABLE group_messages ADD COLUMN sender_avatar TEXT/,
        'sender_name and sender_avatar migrations must not share a silent try/catch block'
    );
    assert.doesNotMatch(
        dbSource,
        /try \{ db\.prepare\(['"]ALTER TABLE characters ADD COLUMN (?:memory_api|tts_)/,
        'character memory/TTS migrations must not silently catch ALTER TABLE failures'
    );
    assert.doesNotMatch(
        dbSource,
        /ALTER TABLE characters ADD COLUMN llm_debug_capture INTEGER DEFAULT 0/,
        'character LLM debug migration must not diverge from the fresh-schema default'
    );
});

test('city db migrations check columns after tables exist', () => {
    const cityDbSource = readRepoFile('server', 'plugins', 'city', 'cityDb.js');

    assert.match(cityDbSource, /function addColumnIfMissing/, 'city migrations should use schema-aware column creation');
    assert.match(cityDbSource, /CREATE TABLE IF NOT EXISTS city_quests[\s\S]*addColumnIfMissing\('city_quests', 'target_district'/, 'city_quests columns should be added after the table exists');
    assert.doesNotMatch(cityDbSource, /try \{ db\.exec\("ALTER TABLE city_quests ADD COLUMN/, 'city_quests migrations should not silently run before table creation');
    assert.match(cityDbSource, /addColumnIfMissing\('characters', 'calories', 'INTEGER DEFAULT 2000'\)/, 'city character columns should be checked explicitly');
    assert.match(cityDbSource, /addColumnIfMissing\('city_items', 'stock', 'INTEGER DEFAULT -1'\)/, 'city item stock migration should be checked explicitly');
});

test('small plugin db migrations avoid silent alter-table catches', () => {
    const growthDbSource = readRepoFile('server', 'plugins', 'cityGrowth', 'growthDb.js');
    const socialHousingDbSource = readRepoFile('server', 'plugins', 'socialHousing', 'db.js');

    assert.match(growthDbSource, /function addColumnIfMissing/, 'cityGrowth migrations should use schema-aware column creation');
    assert.match(growthDbSource, /addColumnIfMissing\('city_school_courses', 'prompt_effect_basic'/, 'cityGrowth basic prompt effect migration should be explicit');
    assert.doesNotMatch(growthDbSource, /try \{ db\.exec\("ALTER TABLE/, 'cityGrowth should not silently catch ALTER TABLE migrations');

    assert.match(socialHousingDbSource, /function addColumnIfMissing/, 'socialHousing migrations should use schema-aware column creation');
    assert.match(socialHousingDbSource, /addColumnIfMissing\('social_housing_bindings', 'rent_due_at'/, 'socialHousing rent migration should be explicit');
    assert.match(socialHousingDbSource, /addColumnIfMissing\('social_housing_agency', 'decision_interval_hours'/, 'socialHousing agency migration should be explicit');
    assert.doesNotMatch(socialHousingDbSource, /try \{ db\.exec\("ALTER TABLE/, 'socialHousing should not silently catch ALTER TABLE migrations');
});

test('runtime source does not contain common mojibake markers', () => {
    const roots = [
        path.join(repoRoot, 'client', 'src'),
        path.join(repoRoot, 'server'),
        path.join(repoRoot, 'scripts')
    ];
    const ignoredParts = [
        `${path.sep}node_modules${path.sep}`,
        `${path.sep}.runtime${path.sep}`,
        `${path.sep}client${path.sep}dist${path.sep}`,
        `${path.sep}server${path.sep}public${path.sep}assets${path.sep}`,
        `${path.sep}server${path.sep}_archive_tools${path.sep}`,
        `${path.sep}server${path.sep}test${path.sep}`
    ];
    const mojibakePattern = /鈥|鈹|锛|锟|�|Ã|Â|鈫|扐/;
    const offenders = [];
    const shouldSkipDir = (dir) => ignoredParts.some((part) => `${dir}${path.sep}`.includes(part));

    for (const root of roots) {
        for (const filePath of walkFiles(root, (candidate) => /\.(js|jsx|md|css|json)$/.test(candidate), shouldSkipDir)) {
            if (ignoredParts.some((part) => filePath.includes(part))) continue;
            const text = fs.readFileSync(filePath, 'utf8');
            if (mojibakePattern.test(text)) {
                offenders.push(path.relative(repoRoot, filePath));
            }
        }
    }

    assert.deepEqual(offenders, [], 'runtime source should not contain common mojibake markers');
});
