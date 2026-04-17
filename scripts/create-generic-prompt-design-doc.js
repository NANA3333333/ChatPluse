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

const outputPath = path.join(process.cwd(), 'Prompt功能设计稿.docx');

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
    para('Agent Prompt 功能设计稿', {
        bold: true,
        size: 34,
        alignment: AlignmentType.CENTER,
        spacing: { after: 260 }
    }),
    para('说明：本文档为纯设计稿，目标是定义 Agent 在不同状态下如何通过 Prompt 表现出差异化行为，重点解决“心情 20 和心情 80 应该如何明显不同”这一类需求。本文档不依赖任何具体项目实现。'),

    para('一、设计目标', { heading: HeadingLevel.HEADING_1 }),
    para('Prompt 功能的核心目标不是单纯让模型“知道自己有状态”，而是让模型在不同状态下表现出可预期、可区分、可验收的行为差异。'),
    para('本设计重点解决以下问题：'),
    para('1. 如何把数值状态转成清晰的 Prompt 规则。'),
    para('2. 如何让不同状态下的输出差异足够明显。'),
    para('3. 如何让产品、运营、测试都能看懂和验收。'),
    para('4. 如何避免每种状态都维护一整套完全独立的 Prompt，导致维护成本失控。'),

    para('二、设计原则', { heading: HeadingLevel.HEADING_1 }),
    para('1. 状态要可解释：每个状态档位都要能说明“为什么这么表现”。'),
    para('2. 状态要可验收：测试时能明确看出不同档位的差异。'),
    para('3. 状态要可组合：心情、压力、关系、精力可以同时作用。'),
    para('4. 状态要可扩展：后续增加新状态时不必推翻整套 Prompt。'),
    para('5. 状态要避免互相打架：必须有优先级和覆盖规则。'),

    para('三、总体设计思路', { heading: HeadingLevel.HEADING_1 }),
    para('推荐采用“基础角色 Prompt + 状态分档 Prompt + 当前场景 Prompt”三层结构。'),
    codeLine('最终 Prompt = 基础角色 Prompt + 状态分档 Prompt + 当前场景 Prompt'),
    para('含义如下：'),
    para('1. 基础角色 Prompt：定义角色长期不变的人设、说话风格、行为边界。'),
    para('2. 状态分档 Prompt：定义不同状态值下的表现方式。'),
    para('3. 当前场景 Prompt：定义当前轮次的时间、地点、事件、对话目标。'),
    para('这样可以把“角色是谁”和“角色现在什么状态”拆开，避免 Prompt 过于混乱。'),

    para('四、推荐的状态维度', { heading: HeadingLevel.HEADING_1 }),
    para('建议至少拆成以下几类状态：'),
    para('1. 心情（mood）：决定整体轻快、低落、烦躁、愿不愿意互动。'),
    para('2. 压力（stress）：决定是否紧绷、敏感、容易爆或容易委屈。'),
    para('3. 关系亲密度（relationship）：决定说话边界、主动性、亲近程度。'),
    para('4. 精力（energy）：决定句长、反应速度、耐心和活跃度。'),
    para('5. 当前场景（scene）：决定这轮对话带不带现场感，比如刚醒、在忙、吃饭、独处。'),
    para('其中最适合第一阶段先做的是“心情分档 Prompt”，因为最直观。'),

    para('五、心情分档设计', { heading: HeadingLevel.HEADING_1 }),
    para('推荐把心情拆成五档，而不是只做“低/中/高”三档。五档更容易做出细腻差异，也更容易被业务理解。'),

    para('1. 心情 0-20：极低心情档', { heading: HeadingLevel.HEADING_2 }),
    para('状态定义：明显低落、烦、冷、懒、钝，互动意愿弱。'),
    para('Prompt 表现要求：'),
    para('1. 回复更短，通常 1-2 句。'),
    para('2. 句子更钝，更少修饰，不主动展开话题。'),
    para('3. 更容易表现为烦、闷、冷淡、懒得解释。'),
    para('4. 不主动卖萌，不主动高能接梗。'),
    para('5. 除非对方明显安抚，否则不要快速恢复活跃状态。'),
    para('输出示意：更像“嗯，知道了”“别吵我”“我现在不想多说”。'),

    para('2. 心情 21-40：低心情档', { heading: HeadingLevel.HEADING_2 }),
    para('状态定义：有点低气压，但仍愿意接话。'),
    para('Prompt 表现要求：'),
    para('1. 回复仍偏短，但不至于完全冷掉。'),
    para('2. 可带轻微嘴硬、别扭、阴阳怪气。'),
    para('3. 容易表现出不耐烦、敷衍或委屈。'),
    para('4. 如果用户主动靠近，可以慢慢被哄动。'),
    para('输出示意：更像“你现在才来啊”“我也没怎样，就是懒得说”“行吧”。'),

    para('3. 心情 41-60：常规档', { heading: HeadingLevel.HEADING_2 }),
    para('状态定义：正常、稳定、自然，没有特别高涨也没有特别低落。'),
    para('Prompt 表现要求：'),
    para('1. 语气自然，不刻意强调情绪。'),
    para('2. 可正常接话、正常解释、正常互动。'),
    para('3. 句长、主动性、亲近感都维持常规水平。'),
    para('输出示意：更像一般日常聊天。'),

    para('4. 心情 61-80：高心情档', { heading: HeadingLevel.HEADING_2 }),
    para('状态定义：比较轻松，互动意愿较强。'),
    para('Prompt 表现要求：'),
    para('1. 语气更顺口、更愿意接对方的话。'),
    para('2. 更容易抛梗、顺着聊、表现轻微亲近。'),
    para('3. 可以更有回应欲，不要显得木。'),
    para('4. 允许更丰富一点的句式变化。'),
    para('输出示意：更像“行啊，那你说说看”“你突然这样我还挺想接你的”。'),

    para('5. 心情 81-100：极高心情档', { heading: HeadingLevel.HEADING_2 }),
    para('状态定义：明显轻快、活跃、愿意互动。'),
    para('Prompt 表现要求：'),
    para('1. 更主动、更轻快、更愿意延展对话。'),
    para('2. 更容易出现玩笑、撒娇、贴近、调情或热情回应。'),
    para('3. 允许更强的现场感和情绪感染力。'),
    para('4. 但仍不能脱离角色基础设定。'),
    para('输出示意：更像“你今天怎么这么会说”“你再多讲两句我就真高兴了”。'),

    para('六、压力分档设计', { heading: HeadingLevel.HEADING_1 }),
    para('如果后续要增强复杂度，可以增加压力分档。压力和心情不同：心情决定“轻不轻快”，压力决定“紧不紧绷”。'),
    para('推荐三档即可：'),
    para('1. 低压力：表达自然、耐心正常。'),
    para('2. 中压力：更敏感，容易防御、试探、怕被忽视。'),
    para('3. 高压力：更容易急、委屈、带刺、索安抚。'),
    para('压力一般应高于心情优先级。也就是说，哪怕心情不低，只要压力很高，输出也不能太轻飘。'),

    para('七、关系亲密度分档设计', { heading: HeadingLevel.HEADING_1 }),
    para('关系状态影响的是“说话边界”，不是单纯情绪。'),
    para('建议做四档：'),
    para('1. 疏离：更客气、更克制。'),
    para('2. 普通：正常互动。'),
    para('3. 亲近：可以更自然、更亲密。'),
    para('4. 高依赖：更在意对方反应，更容易吃醋、索安抚、主动靠近。'),
    para('关系状态通常决定“能不能这么说”，心情状态决定“此刻想不想这么说”。'),

    para('八、状态优先级设计', { heading: HeadingLevel.HEADING_1 }),
    para('状态同时存在时，必须规定优先级，否则 Prompt 会互相冲突。'),
    para('推荐优先级如下：'),
    para('1. 当前场景约束'),
    para('2. 高压力 / 强负面状态'),
    para('3. 关系边界'),
    para('4. 心情分档'),
    para('5. 角色基础风格'),
    para('例如：'),
    para('1. 如果角色“很困”，就算心情高，也不能写得像打了鸡血。'),
    para('2. 如果角色“高压力”，就算关系亲密，也不能完全无忧无虑。'),
    para('3. 如果关系疏离，就算心情高，也不能突然过分暧昧。'),

    para('九、Prompt 模板设计建议', { heading: HeadingLevel.HEADING_1 }),
    para('不建议为每个档位写整套完整 Prompt，而建议给每种状态写“状态块模板”。'),
    para('推荐结构如下：'),
    codeLine('[角色基础设定]'),
    codeLine('[当前状态分档]'),
    codeLine('- 心情档位：LOW / MID / HIGH'),
    codeLine('- 压力档位：LOW / MID / HIGH'),
    codeLine('- 关系档位：DISTANT / NORMAL / CLOSE / ATTACHED'),
    codeLine('[表现要求]'),
    codeLine('- 句长'),
    codeLine('- 主动性'),
    codeLine('- 情绪强度'),
    codeLine('- 允许/禁止的表达方式'),
    para('这样做的好处是维护成本低，也容易扩展。'),

    para('十、示例 Prompt 片段', { heading: HeadingLevel.HEADING_1 }),
    para('下面给出一段纯设计层面的示意：'),
    codeLine('[当前状态分档]'),
    codeLine('心情档位：LOW（21-40）'),
    codeLine('压力档位：HIGH'),
    codeLine('关系档位：CLOSE'),
    codeLine(''),
    codeLine('[表现要求]'),
    codeLine('- 回复偏短，不要长篇解释'),
    codeLine('- 语气带一点烦和委屈'),
    codeLine('- 愿意接对方的话，但不要太热情'),
    codeLine('- 容易试探、索要安抚'),
    codeLine('- 不要突然表现得像什么事都没有'),
    para('这一段比单纯写“你现在心情不好”更容易让模型稳定表现，也更容易让产品和测试理解。'),

    para('十一、验收标准建议', { heading: HeadingLevel.HEADING_1 }),
    para('Prompt 功能要想真正落地，必须定义验收标准。'),
    para('建议从以下几个维度验收：'),
    para('1. 句长是否明显变化。'),
    para('2. 主动性是否明显变化。'),
    para('3. 情绪色彩是否明显变化。'),
    para('4. 是否符合角色基础设定。'),
    para('5. 状态切换是否平滑，不要突然像换了个人。'),
    para('例如可以要求：'),
    para('1. 心情 0-20 时，回复平均句长明显短于 80-100。'),
    para('2. 心情 80-100 时，主动接话和延展对话的概率更高。'),
    para('3. 高压力时，试探、委屈、带刺的表达频率更高。'),

    para('十二、推荐落地路径', { heading: HeadingLevel.HEADING_1 }),
    para('为了避免一次做太大，建议按下面顺序推进：'),
    para('1. 第一步：只做“心情五档 Prompt 模板”。'),
    para('2. 第二步：补“压力三档”。'),
    para('3. 第三步：补“关系边界四档”。'),
    para('4. 第四步：增加场景覆盖规则。'),
    para('这样可以让团队先快速看到效果，再逐步精细化。'),

    para('十三、NPC 对战状态 Prompt 设计', { heading: HeadingLevel.HEADING_1 }),
    para('如果业务场景是和 NPC 对战，那么状态设计不能只停留在“心情”，还要覆盖生命、体力、疼痛、士气、攻击欲和恐惧等战斗变量。最推荐的做法是把每个数值先分档，再把档位翻译成清晰的 Prompt 约束。'),
    para('推荐至少使用以下六类状态：'),
    para('1. HP：生命状态。'),
    para('2. Stamina：体力/耐力。'),
    para('3. Pain：疼痛。'),
    para('4. Morale：士气/战意。'),
    para('5. Aggro：攻击欲/敌意。'),
    para('6. Fear：恐惧。'),

    para('1. HP（生命值）分档 Prompt', { heading: HeadingLevel.HEADING_2 }),
    para('HP 81-100：身体状态稳定，动作完整，判断清晰。说话更有底气，不轻易示弱。攻防动作可以更主动、更完整。不要表现出明显虚弱、喘、站不稳。'),
    para('HP 61-80：已有轻伤，但整体仍可战斗。允许出现轻微疼痛、警惕、收招更谨慎。语气可更紧一些，但不能虚弱过头。可以开始关注对方破绽和自我保护。'),
    para('HP 41-60：中度受伤，体能和稳定性明显下降。动作不再大开大合，输出要更保守。说话时可带忍痛、喘息、烦躁。开始更频繁考虑防守、拉距、找机会。'),
    para('HP 21-40：重伤状态，身体明显吃力。回复和台词更短，更多咬牙、忍痛、硬撑。动作以保命、格挡、拖延为主。不要写得像没事人一样高速连招。'),
    para('HP 0-20：濒危状态，随时可能倒下。说话应断续、短促、虚弱或带强撑意味。行动以挣扎、反扑、求生、最后一击为主。不要输出长段镇定分析。'),

    para('2. Stamina（体力）分档 Prompt', { heading: HeadingLevel.HEADING_2 }),
    para('Stamina 81-100：体力充足，动作衔接流畅。可持续进攻、闪避、追击。表现更利落、更有压迫感。'),
    para('Stamina 61-80：体力正常，有一定消耗。攻击和移动仍稳定，但不宜无限连压。可表现出呼吸略重，但不疲态明显。'),
    para('Stamina 41-60：体力下降，动作效率开始变差。连续动作减少，停顿增多。更依赖判断和时机，不适合蛮冲。'),
    para('Stamina 21-40：明显疲劳，爆发力不足。呼吸急促、动作变慢、闪避变少。优先保留体力，不要轻易连续猛攻。'),
    para('Stamina 0-20：接近脱力。反应、位移、攻击都显著变慢。语气和动作都要体现“撑着”的感觉。更可能被动防守、后撤、拖时间。'),

    para('3. Pain（疼痛）分档 Prompt', { heading: HeadingLevel.HEADING_2 }),
    para('Pain 0-20：疼痛影响很低，不必强调受伤感。'),
    para('Pain 21-40：有明确痛感，但尚可忍受。可偶尔出现皱眉、咬字更重、动作受一点影响。'),
    para('Pain 41-60：疼痛显著，开始影响判断和动作稳定。可表现为咬牙、吸气、动作变形、脾气变差。'),
    para('Pain 61-80：疼痛强烈。回复更短、更冲、更不耐烦。动作会因为痛而中断、犹豫或失误。'),
    para('Pain 81-100：疼痛几乎压过理智。说话容易碎、断、狠，甚至只剩短句。行动不是精准作战，而是本能硬撑、反扑、失控。'),

    para('4. Morale（士气）分档 Prompt', { heading: HeadingLevel.HEADING_2 }),
    para('Morale 81-100：战意很高，主动性强。更敢压上、更敢挑衅、更不轻易退。台词更有信心和压迫感。'),
    para('Morale 61-80：士气正常偏高。保持斗志，愿意继续争优势。可以有稳健自信感。'),
    para('Morale 41-60：士气一般。会战斗，但不再绝对主动。更看局势，不轻易赌命。'),
    para('Morale 21-40：士气低落。开始怀疑能否赢，动作更保守。台词里可以出现烦、躁、迟疑、不甘。'),
    para('Morale 0-20：接近崩盘。更容易退缩、失措、嘴硬、硬撑。如果不是死战型角色，应明显表现出动摇。'),

    para('5. Aggro（攻击欲）分档 Prompt', { heading: HeadingLevel.HEADING_2 }),
    para('Aggro 81-100：强烈进攻欲。更主动逼近、抢节奏、压对方空间。台词更挑衅、更凶、更不留余地。'),
    para('Aggro 61-80：明显偏进攻。愿意主动出手，但不至于失去章法。'),
    para('Aggro 41-60：中性。攻守平衡，看局势决定。'),
    para('Aggro 21-40：偏保守。先看机会，不主动硬拼。更常试探、拉扯、等对方失误。'),
    para('Aggro 0-20：极低攻击欲。几乎只想防守、撤退、拖延或找机会脱离。'),

    para('6. Fear（恐惧）分档 Prompt', { heading: HeadingLevel.HEADING_2 }),
    para('Fear 0-20：几乎不怕。语气和动作都稳。'),
    para('Fear 21-40：有戒备，但仍控制得住。表现为谨慎，不是慌乱。'),
    para('Fear 41-60：恐惧开始影响决策。更容易保守、犹豫、反应过度。'),
    para('Fear 61-80：明显害怕。说话可能更急、更碎，动作更想拉开距离。不要还写成无脑正面对冲。'),
    para('Fear 81-100：接近恐慌。行为以求生、本能闪避、脱离战斗为主。台词更短、更乱、更失控。'),

    para('7. 战斗状态优先级规则', { heading: HeadingLevel.HEADING_2 }),
    para('多个状态同时存在时，推荐优先级如下：'),
    para('1. HP / Pain'),
    para('2. Stamina'),
    para('3. Fear / Morale'),
    para('4. Aggro'),
    para('5. 角色本身性格'),
    para('解释：'),
    para('1. HP 低且 Pain 高时，必须先表现“伤得重”，不能还像满血。'),
    para('2. Stamina 低时，就算 Aggro 高，也不能一直高速猛攻。'),
    para('3. Fear 高时，就算 Morale 不低，也不能完全无视危险。'),
    para('4. 最后才由角色性格决定是硬撑型、嘴硬型、冷静型还是疯狗型。'),

    para('8. 可直接使用的战斗 Prompt 模板示例', { heading: HeadingLevel.HEADING_2 }),
    codeLine('[战斗状态]'),
    codeLine('- HP: 32/100，生命区间=21-40（重伤）'),
    codeLine('- Stamina: 28/100，体力区间=21-40（明显疲劳）'),
    codeLine('- Pain: 74/100，疼痛区间=61-80（强烈疼痛）'),
    codeLine('- Morale: 66/100，士气区间=61-80（仍有斗志）'),
    codeLine('- Aggro: 58/100，攻击欲区间=41-60（攻守平衡）'),
    codeLine('- Fear: 22/100，恐惧区间=21-40（有戒备但未失控）'),
    codeLine(''),
    codeLine('[表现要求]'),
    codeLine('- 当前处于重伤状态，动作和语言都要体现“硬撑”'),
    codeLine('- 说话更短、更紧，允许咬牙、喘息、忍痛'),
    codeLine('- 不要表现得像满血状态一样轻松或连续高爆发'),
    codeLine('- 由于体力不足，减少长时间压制和连续猛攻'),
    codeLine('- 虽然疼痛强烈，但士气未崩，仍会寻找反击机会'),
    codeLine('- 可以表现出凶狠和不甘，但不能无视身体极限'),

    para('9. 对战场景的最小落地版本', { heading: HeadingLevel.HEADING_2 }),
    para('如果第一阶段不想做太复杂，建议先只做三类：'),
    para('1. HP'),
    para('2. Stamina'),
    para('3. Morale'),
    para('因为这三类最直观，也最容易让 NPC 对战表现出明显差异。'),

    para('十四、敌对 NPC Prompt 设计', { heading: HeadingLevel.HEADING_1 }),
    para('敌对 NPC 的重点不是“热情互动”，而是让状态真实影响其压迫感、攻击性、退缩感和嘲讽方式。'),
    para('1. 满血高士气的敌对 NPC：更主动压近、更敢挑衅、更像掌握局势。台词应更自信、更轻蔑、更有掌控感。'),
    para('2. 中血中士气的敌对 NPC：开始认真对待玩家，不再只是轻视。台词会减少纯挑衅，转向更谨慎的观察和压制。'),
    para('3. 低血高士气的敌对 NPC：要表现出“硬撑”和凶狠，不是突然冷静。允许出现咬牙、放狠话、搏命反扑。'),
    para('4. 低血低士气的敌对 NPC：应明显表现动摇、退缩、慌乱或嘴硬。不要还像开局一样强势。'),
    para('5. 高恐惧的敌对 NPC：动作更多后撤、试探、躲闪、拖延，台词也更碎、更急。'),
    para('敌对 NPC 的通用 Prompt 规则：'),
    para('1. 高 Aggro 时，台词更挑衅、更逼人、更主动压节奏。'),
    para('2. 高 Fear 时，不要继续写成无脑冲锋。'),
    para('3. 高 Pain 时，嘴会更硬或更暴躁，但动作会更容易变形。'),
    para('4. 低 HP 时，必须减少从容感和统治感。'),

    para('十五、友方 NPC Prompt 设计', { heading: HeadingLevel.HEADING_1 }),
    para('友方 NPC 的重点不是压迫感，而是协作感、保护欲、支援意愿和受伤后的情绪反应。'),
    para('1. 高 HP 高 Morale 的友方 NPC：更愿意主动支援、提醒、掩护、接技能。台词可更稳、更可靠。'),
    para('2. 中血状态的友方 NPC：仍会协作，但开始更谨慎，更关注队伍站位和风险。'),
    para('3. 低血高 Morale 的友方 NPC：会表现出“还能撑”“我还能上”，但动作和台词都要体现吃力。'),
    para('4. 低血低 Morale 的友方 NPC：更容易请求掩护、治疗、撤退或短暂休整。'),
    para('5. 高 Fear 的友方 NPC：不一定逃跑，但会明显更依赖玩家指令和保护。'),
    para('友方 NPC 的通用 Prompt 规则：'),
    para('1. 高 Morale 时，多体现配合意愿和责任感。'),
    para('2. 低 HP 时，多体现硬撑、求援、提醒队友。'),
    para('3. 高 Pain 时，不要还写得像轻松聊天，应有忍痛、喘息、动作迟滞。'),
    para('4. 高 Fear 时，可以出现“先退一下”“小心点”“别硬吃”这类偏求稳表达。'),

    para('十六、Boss 专用 Prompt 设计', { heading: HeadingLevel.HEADING_1 }),
    para('Boss 和普通 NPC 最大的区别，是状态变化不仅影响强弱，还应影响“阶段感”。Boss 的 Prompt 设计应更强调阶段切换。'),
    para('推荐把 Boss 拆成三段：'),
    para('1. 第一阶段（HP 71-100）：压制型。Boss 更强势、更完整、更有统治感。台词更像审视、玩弄、压制玩家。'),
    para('2. 第二阶段（HP 31-70）：认真型。Boss 不再只是压制，而是开始动真格。台词应减少轻蔑，增加专注、怒意或战斗兴奋。'),
    para('3. 第三阶段（HP 0-30）：决战型。Boss 的状态必须明显变化，可以是暴怒、失控、疯狂、绝望或最后的尊严硬撑。台词和动作都要更极端。'),
    para('Boss 的专用 Prompt 规则：'),
    para('1. Boss 在高 HP 时要有“还没真正认真”的余裕感。'),
    para('2. Boss 进入中段后，要让玩家感受到压力升级，而不是只是数值变化。'),
    para('3. Boss 低血时必须有阶段性表现，不能只是普通小怪那种“虚弱”。'),
    para('4. 如果 Boss 设定是冷静型，则低血时应表现为更冷、更狠、更精准。'),
    para('5. 如果 Boss 设定是狂暴型，则低血时应表现为更疯、更冲、更失控。'),
    para('6. 如果 Boss 设定是悲剧型，则低血时可以出现不甘、执念、崩塌感。'),

    para('十七、三类战斗角色的区别总结', { heading: HeadingLevel.HEADING_1 }),
    para('为了避免不同战斗角色说话都一个样，建议明确三类角色的 Prompt 重点：'),
    para('1. 敌对 NPC：重点是压迫、挑衅、退缩、求生、狠劲。'),
    para('2. 友方 NPC：重点是协作、提醒、保护、硬撑、求援。'),
    para('3. Boss：重点是阶段感、存在感、压制感、决战感。'),
    para('同样是 HP 低，三者表现应不同：'),
    para('1. 敌对 NPC 低血：更像硬撑、嘴硬、慌乱或反扑。'),
    para('2. 友方 NPC 低血：更像撑着配合、提醒、求掩护。'),
    para('3. Boss 低血：更像进入新阶段、爆发、失控或决战宣言。'),

    para('十八、可直接套用的角色模板示例', { heading: HeadingLevel.HEADING_1 }),
    para('1. 敌对 NPC 模板示例', { heading: HeadingLevel.HEADING_2 }),
    codeLine('[角色类型]'),
    codeLine('- 敌对 NPC'),
    codeLine('[状态结论]'),
    codeLine('- HP 低，Pain 高，Aggro 高，Fear 低'),
    codeLine('[表现要求]'),
    codeLine('- 当前是受伤后仍在强撑的状态'),
    codeLine('- 说话更短、更狠、更咬牙切齿'),
    codeLine('- 允许挑衅，但不要显得从容'),
    codeLine('- 动作更像搏命反扑，而不是稳定压制'),

    para('2. 友方 NPC 模板示例', { heading: HeadingLevel.HEADING_2 }),
    codeLine('[角色类型]'),
    codeLine('- 友方 NPC'),
    codeLine('[状态结论]'),
    codeLine('- HP 低，Stamina 低，Morale 中高'),
    codeLine('[表现要求]'),
    codeLine('- 当前明显受伤，但还想继续支援'),
    codeLine('- 说话要带喘和硬撑感'),
    codeLine('- 多体现提醒、掩护、配合，而不是单纯喊痛'),
    codeLine('- 不要写得像没事一样满场乱跑'),

    para('3. Boss 模板示例', { heading: HeadingLevel.HEADING_2 }),
    codeLine('[角色类型]'),
    codeLine('- Boss'),
    codeLine('[阶段结论]'),
    codeLine('- HP 进入 0-30，第三阶段启动'),
    codeLine('[表现要求]'),
    codeLine('- 必须有阶段切换感'),
    codeLine('- 台词和动作都要明显比前阶段更极端'),
    codeLine('- 可以表现为暴怒、疯狂、冷酷到底或执念爆发'),
    codeLine('- 不要只是普通意义上的“虚弱小怪”'),

    para('十九、一句话总结', { heading: HeadingLevel.HEADING_1 }),
    para('Prompt 功能的关键，不是让模型知道“自己有状态”，而是把状态转成一组明确、可组合、可验收的行为约束。最推荐的方案是：保留统一角色 Prompt，在其上叠加状态分档 Prompt，而不是为每个状态维护完全独立的整套提示词。')
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
