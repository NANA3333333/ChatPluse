const fs = require('fs');
const path = require('path');
const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType
} = require('docx');

const outputPath = path.join(process.cwd(), 'Prompt工程说明.docx');

function para(text, options = {}) {
    return new Paragraph({
        alignment: options.alignment || AlignmentType.LEFT,
        spacing: options.spacing || { after: 140 },
        heading: options.heading,
        children: [
            new TextRun({
                text,
                bold: !!options.bold,
                size: options.size || 24,
                font: options.font || 'Microsoft YaHei'
            })
        ]
    });
}

function codeLine(text) {
    return new Paragraph({
        spacing: { after: 120 },
        children: [
            new TextRun({
                text,
                font: 'Consolas',
                size: 21
            })
        ]
    });
}

const children = [
    para('ChatPulse Prompt 工程说明', {
        bold: true,
        size: 34,
        alignment: AlignmentType.CENTER,
        spacing: { after: 260 }
    }),
    para('说明：本文档用于梳理当前项目中的 Prompt 工程实现方式，重点说明固定 Prompt、动态状态 Prompt、情绪映射机制，以及后续可落地的“分档提示词”改造方向。'),

    para('一、结论概述', { heading: HeadingLevel.HEADING_1 }),
    para('当前项目已经具备 Prompt 工程基础，但实现方式不是“心情 20 一套 Prompt、心情 80 另一套 Prompt”这种离散模板，而是“固定角色 Prompt + 动态上下文状态块 + 情绪/状态映射规则”的连续注入方案。'),
    para('换句话说，项目现在已经做到了“状态会影响回复”，只是这种影响主要通过状态文本块进入 Prompt，再由模型自行表现出来，而不是通过显式的分档模板直接约束输出风格。'),

    para('二、当前 Prompt 结构', { heading: HeadingLevel.HEADING_1 }),
    para('项目中的 Prompt 大体分为两层：稳定底座和动态状态。'),
    codeLine('稳定底座 Prompt = stableCharacterBlock'),
    codeLine('动态状态 Prompt = dynamicPromptBase + universalResult.preamble'),
    codeLine('最终系统 Prompt = stableCharacterBlock + dynamicPrompt'),
    para('对应主逻辑位于 server/engine.js 的 buildPrompt()。'),

    para('1. 稳定底座 Prompt', { heading: HeadingLevel.HEADING_2 }),
    para('稳定底座主要负责定义“这个角色是谁、怎么说话、有哪些长期规则”，一般不会因为单轮状态变化而大幅改变。'),
    para('当前稳定底座主要包含：'),
    para('1. 角色 persona。'),
    para('2. 世界观 world_info。'),
    para('3. 用户身份锚点。'),
    para('4. Response Style Constitution。'),
    para('5. Guidelines。'),
    para('6. Dialogue Style Examples。'),
    para('7. 角色额外 system_prompt。'),
    para('这些内容决定了角色的长期说话风格和行为边界，属于 Prompt 的“角色骨架”。'),

    para('2. 动态状态 Prompt', { heading: HeadingLevel.HEADING_2 }),
    para('动态状态 Prompt 由 buildUniversalContext() 生成，主要负责把当前轮次相关的运行状态、上下文和情绪状态注入模型。'),
    para('当前会进入动态 Prompt 的信息包括：'),
    para('1. 当前时间段：早上 / 中午 / 下午 / 晚上 / 深夜。'),
    para('2. 身体状态：精力、睡眠债、健康、饱腹感、胃负担。'),
    para('3. 情绪状态：主情绪、私聊倾向、群聊倾向。'),
    para('4. 压力状态：pressure_level。'),
    para('5. 嫉妒状态、被忽视状态、商业街余震。'),
    para('6. 当前生活场景：工作中、休息中、进食中、治疗中等。'),
    para('7. 关系锚点和部分跨上下文信息。'),
    para('这一层决定了“角色此刻以什么状态说话”，属于 Prompt 的“当前态”。'),

    para('三、情绪状态是如何进入 Prompt 的', { heading: HeadingLevel.HEADING_1 }),
    para('项目中并不是直接使用 mood=20 或 mood=80 这类原始数值，而是先做一层情绪解释，再把解释后的结果转成文字约束。'),

    para('1. 数值状态来源', { heading: HeadingLevel.HEADING_2 }),
    para('角色身上当前可用于情绪计算的主要字段包括：'),
    para('1. mood。'),
    para('2. stress。'),
    para('3. social_need。'),
    para('4. pressure_level。'),
    para('5. jealousy_level。'),
    para('6. sleep_debt。'),
    para('7. health。'),
    para('8. city_ignore_streak / city_reply_pending 等互动状态。'),

    para('2. 情绪桥接层', { heading: HeadingLevel.HEADING_2 }),
    para('在 server/emotion.js 中，getLegacyEmotionBridge() 会先对 mood、stress、social_need 做一次“桥接修正”。'),
    para('例如：'),
    para('1. pressure_level 越高，会压低 mood。'),
    para('2. ignoreStreak 越高，会提升 stress 和 socialNeed。'),
    para('3. replyPending 会进一步拉高焦虑和在意程度。'),
    para('这意味着 Prompt 里看到的情绪，不是数据库字段的生值，而是融合了关系压力和被忽视状态之后的“有效状态”。'),

    para('3. 情绪标签推断层', { heading: HeadingLevel.HEADING_2 }),
    para('deriveEmotion() 会把当前数值推断成更高层的情绪标签，例如：'),
    para('1. jealous'),
    para('2. hurt'),
    para('3. angry'),
    para('4. lonely'),
    para('5. happy'),
    para('6. sad'),
    para('7. tense'),
    para('8. sleepy'),
    para('9. unwell'),
    para('10. calm'),
    para('模型最终接收到的不是“mood=37”，而是“当前主情绪=委屈/嫉妒/紧绷”等更易理解的语义标签。'),

    para('4. 情绪转成 Prompt 文本', { heading: HeadingLevel.HEADING_2 }),
    para('在 contextBuilder.js 中，buildCompactEmotionImpact()、getPressureHint()、getPhysicalCondition() 等函数会把情绪和状态转成 Prompt 文本，比如：'),
    para('1. [主情绪]: 委屈 / 嫉妒 / 平静。'),
    para('2. [私聊倾向]: 更试探、更索安抚、更带刺。'),
    para('3. [强情绪边界]: 强情绪下仍要控制句数。'),
    para('4. [压力影响]: 焦虑强，语气更委屈或索安抚。'),
    para('5. [忙碌余压] / [补觉余压] / [商业街余震] 等场景化影响。'),
    para('也就是说，当前方案是先把状态翻译成自然语言提示，再交给模型表演。'),

    para('四、当前方案的优点', { heading: HeadingLevel.HEADING_1 }),
    para('1. 灵活。状态是连续变化的，不必每个分值都维护一套独立模板。'),
    para('2. 可组合。情绪、身体状态、时间、场景、关系可以同时作用于 Prompt。'),
    para('3. 更自然。模型不是机械套模板，而是在多个状态提示共同作用下生成更细腻的表达。'),
    para('4. 工程上已经具备扩展基础，不需要从零重做。'),

    para('五、当前方案的不足', { heading: HeadingLevel.HEADING_1 }),
    para('虽然当前方案能让状态影响回复，但对于需求方和验收方来说，它的可见性和可控性还不够强。主要问题有：'),
    para('1. 状态影响是隐式的。很难直接说清“心情 20 和心情 80 的输出到底差在哪”。'),
    para('2. 缺少明确的分档行为定义。当前更多是语义提示，而不是可验收的档位模板。'),
    para('3. 不利于产品讨论。业务方更容易接受“低心情档要短句、冷一点、高心情档要更主动”这种明确规则。'),
    para('4. 调试成本较高。当前要看多层状态共同作用后模型是否表现正确，不如分档模板直观。'),

    para('六、如果要做“心情 20 / 心情 80 不同提示词”，应该怎么改', { heading: HeadingLevel.HEADING_1 }),
    para('最适合的做法不是推翻现有方案，而是在现有情绪系统上增加一层“状态分档模板层”。'),
    codeLine('原始数值 -> 情绪桥接 -> 情绪标签 -> 状态分档 -> 分档提示词模板 -> 动态 Prompt'),

    para('1. 建议新增的分档层', { heading: HeadingLevel.HEADING_2 }),
    para('可以新增类似下面这些概念：'),
    para('1. moodBand：0-20 / 21-40 / 41-60 / 61-80 / 81-100'),
    para('2. stressBand：低压 / 中压 / 高压'),
    para('3. relationshipBand：疏离 / 正常 / 亲近 / 高依赖'),
    para('4. energyBand：低能量 / 正常 / 高能量'),

    para('2. 示例：心情分档提示词', { heading: HeadingLevel.HEADING_2 }),
    para('例如仅对 mood 做一层显式模板化：'),
    para('心情 0-20：'),
    para('1. 回复更短，更钝，更懒得展开。'),
    para('2. 更容易烦、闷、冷淡或低气压。'),
    para('3. 不主动卖萌，不主动高能互动。'),
    para('4. 除非用户明显安抚，否则不要快速转好。'),
    para('心情 21-40：'),
    para('1. 有点低落或不耐烦，但还愿意接话。'),
    para('2. 允许轻微阴阳怪气、嘴硬或敷衍。'),
    para('3. 句子仍偏短。'),
    para('心情 41-60：'),
    para('1. 常规自然状态。'),
    para('2. 可正常交流，不额外强调情绪。'),
    para('心情 61-80：'),
    para('1. 更放松、更顺口。'),
    para('2. 互动意愿更高，接梗更自然。'),
    para('3. 更容易表现出亲近感。'),
    para('心情 81-100：'),
    para('1. 明显轻快、主动。'),
    para('2. 更愿意延展对话。'),
    para('3. 更容易出现玩笑、撒娇、主动贴近。'),

    para('3. 推荐的工程实现方式', { heading: HeadingLevel.HEADING_2 }),
    para('推荐不要把整套 Prompt 全拆成多套，而是在 buildUniversalContext() 附近新增一个可插拔函数，比如：'),
    codeLine('buildMoodBandPrompt(character)'),
    codeLine('buildStressBandPrompt(character)'),
    codeLine('buildRelationshipBandPrompt(character)'),
    para('这些函数只负责返回一小段清晰的“分档提示词块”，再和现有的情绪文字块一起拼接。这样可以保留当前系统的灵活性，同时增加业务上可解释、可验收的模板层。'),

    para('七、对当前项目的判断', { heading: HeadingLevel.HEADING_1 }),
    para('这个项目当前的 Prompt 工程已经具备如下能力：'),
    para('1. 有稳定角色 Prompt。'),
    para('2. 有动态状态 Prompt。'),
    para('3. 有情绪状态推断。'),
    para('4. 有身体和场景状态注入。'),
    para('5. 有关系和压力状态影响。'),
    para('缺的不是 Prompt 工程本身，而是“显式分档模板层”。'),
    para('因此，如果下一步产品需求是“让心情 20 和心情 80 的表现差异更容易定义、测试和验收”，最合理的方案是在现有情绪系统上补一层状态分档模板，而不是推翻当前 Prompt 架构。'),

    para('八、涉及的主要代码位置', { heading: HeadingLevel.HEADING_1 }),
    para('1. server/engine.js：buildPrompt()，负责最终系统 Prompt 组装。'),
    para('2. server/contextBuilder.js：buildUniversalContext()，负责动态状态 Prompt 拼接。'),
    para('3. server/emotion.js：deriveEmotion()、getLegacyEmotionBridge()，负责情绪推断与状态修正。'),
    para('4. server/db.js：角色 mood / stress / social_need / pressure_level 等状态字段来源。'),

    para('九、建议的下一步', { heading: HeadingLevel.HEADING_1 }),
    para('如果后续要快速向需求方对齐，建议先做一版“只针对 mood 的五档提示词模板”，因为它最直观、最容易讲清楚，也最容易做 A/B 测试。'),
    para('等 mood 分档验证通过后，再把 stress、relationship、energy 等档位逐步补上。这样风险最低，也最容易让业务方快速看到效果。')
];

const doc = new Document({
    sections: [{ properties: {}, children }]
});

Packer.toBuffer(doc).then((buffer) => {
    fs.writeFileSync(outputPath, buffer);
    console.log(outputPath);
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
