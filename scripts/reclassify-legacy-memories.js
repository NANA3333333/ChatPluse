const { getUserDb } = require('../server/db');
const { getMemory } = require('../server/memory');

function matchesAny(text, patterns) {
    return patterns.some(pattern => pattern.test(text));
}

function classifyLegacyMemory(memory) {
    const text = [
        memory.summary || '',
        memory.content || '',
        memory.event || ''
    ].join('\n');
    const summary = String(memory.summary || '');

    const identityPatterns = [
        /大[一二三四]|学生|本科|研究生|非科班|学历|专业|学校|年级|必修课|java|海归|留学生/i,
        /个人信息|学习背景|身份|背景/i
    ];
    const currentArcPatterns = [
        /工作|实习|项目|开发|缓存库|记忆库|offer|入职|薪资|面试|求职|公司|cto|ceo|hr|远程办公|前端|部署|内测/i,
        /职业|赛道|进度|开发项目|个人项目|录用|岗位/i
    ];

    let memoryFocus = null;
    let memoryTier = null;

    if (matchesAny(text, identityPatterns) && !/Claude|Gemini|Grok|GLM/i.test(summary)) {
        memoryFocus = 'user_profile';
        memoryTier = matchesAny(text, [/大[三四]|学生|本科|非科班|学历|专业|学校|身份/i]) ? 'core' : 'active';
    } else if (matchesAny(text, currentArcPatterns) && !/^Claude\b/i.test(summary)) {
        memoryFocus = 'user_current_arc';
        memoryTier = matchesAny(text, [/offer|录用|岗位|实习|项目|求职|面试|入职|公司|开发/i]) ? 'active' : 'ambient';
    } else {
        return null;
    }

    if (memoryFocus === memory.memory_focus && memoryTier === memory.memory_tier) {
        return null;
    }

    return { memory_focus: memoryFocus, memory_tier: memoryTier };
}

async function main() {
    const userId = process.argv[2];
    const characterId = process.argv[3];
    const shouldApply = process.argv.includes('--apply');

    if (!userId || !characterId) {
        console.error('Usage: node scripts/reclassify-legacy-memories.js <userId> <characterId> [--apply]');
        process.exit(1);
    }

    const db = getUserDb(userId);
    const memory = getMemory(userId);
    const allRows = db.getMemories(characterId) || [];
    const candidates = allRows.filter(row =>
        String(row.memory_focus || '') === 'general' &&
        String(row.memory_tier || '') === 'ambient' &&
        Number(row.is_archived || 0) === 0
    );

    const plannedUpdates = [];
    for (const row of candidates) {
        const patch = classifyLegacyMemory(row);
        if (patch) {
            plannedUpdates.push({
                id: row.id,
                summary: row.summary || row.event || '',
                from_focus: row.memory_focus,
                from_tier: row.memory_tier,
                to_focus: patch.memory_focus,
                to_tier: patch.memory_tier
            });
        }
    }

    console.log(JSON.stringify({
        userId,
        characterId,
        candidateCount: candidates.length,
        reclassifyCount: plannedUpdates.length,
        preview: plannedUpdates.slice(0, 60)
    }, null, 2));

    if (!shouldApply) {
        return;
    }

    for (const item of plannedUpdates) {
        db.updateMemory(item.id, {
            memory_focus: item.to_focus,
            memory_tier: item.to_tier
        });
    }

    await memory.rebuildIndex(characterId);

    console.log(JSON.stringify({
        applied: plannedUpdates.length,
        rebuiltIndex: true
    }, null, 2));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
