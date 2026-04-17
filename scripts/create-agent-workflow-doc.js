const fs = require('fs');
const path = require('path');
const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    ImageRun
} = require('docx');

const outputPath = path.join(process.cwd(), 'ChatPulse_Agent_Workflow_WPS_v2.docx');
const pngPath = path.join(process.cwd(), 'agent_workflow.png');

function p(text, options = {}) {
    return new Paragraph({
        alignment: options.alignment || AlignmentType.LEFT,
        spacing: options.spacing || { after: 140 },
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

function mono(text) {
    return new Paragraph({
        spacing: { after: 120 },
        children: [
            new TextRun({
                text,
                font: 'Consolas',
                size: 22
            })
        ]
    });
}

const doc = new Document({
    sections: [
        {
            properties: {},
            children: [
                p('ChatPulse Agent 工作流说明', {
                    bold: true,
                    size: 34,
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 260 }
                }),
                p('说明：本文档基于项目实际实现整理，重点说明 Agent 的输入、数据收集、决策流转和输出闭环。'),

                new Paragraph({
                    text: '一、整体流程',
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 120, after: 160 }
                }),
                mono('用户输入'),
                mono('  -> 会话状态整理（最近消息 / 对话摘要 / 角色状态）'),
                mono('  -> 切题判断（继续当前话题 / 切换话题 / 追问历史）'),
                mono('  -> 上下文路由（city_detail / school_detail / society_detail）'),
                mono('  -> RAG规划（topics + decision）'),
                mono('  -> 分支判断：'),
                mono('       1) ENOUGH_CONTEXT -> 直接生成回复'),
                mono('       2) SEARCH_MEMORY -> 查询改写 -> 记忆检索 -> 注入上下文'),
                mono('       3) BROWSE_DATE -> 按时间范围回看 -> 注入上下文'),
                mono('  -> 统一上下文构建'),
                mono('  -> 生成角色回复'),
                mono('  -> 写回消息 / 状态 / 调试信息'),
                mono('  -> 提取长期记忆并入库'),

                new Paragraph({
                    text: '二、流程图（Mermaid 源码）',
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 120, after: 160 }
                }),
                ...(fs.existsSync(pngPath)
                    ? [
                        new Paragraph({
                            spacing: { after: 180 },
                            alignment: AlignmentType.CENTER,
                            children: [
                                new ImageRun({
                                    data: fs.readFileSync(pngPath),
                                    type: 'png',
                                    transformation: {
                                        width: 760,
                                        height: 176
                                    },
                                    fallback: {
                                        type: 'png',
                                        data: fs.readFileSync(pngPath)
                                    }
                                })
                            ]
                        }),
                        p('上图为根据 Mermaid 工作流描述渲染得到的实际流程图。', {
                            alignment: AlignmentType.CENTER
                        })
                    ]
                    : []),
                mono('flowchart LR'),
                mono('    A[用户输入] --> B[整理会话状态 最近消息/摘要/角色状态]'),
                mono('    B --> C[切题判断 continue or switch]'),
                mono('    C --> D[上下文路由 city/school/society]'),
                mono('    D --> E[RAG规划 topics + decision]'),
                mono('    E --> F{是否需要检索}'),
                mono('    F -->|否| G[构建统一上下文]'),
                mono('    F -->|记忆检索| H[查询改写 + 多槽位检索]'),
                mono('    F -->|日期回看| I[按时间范围回顾]'),
                mono('    H --> G'),
                mono('    I --> G'),
                mono('    G --> J[生成角色回复]'),
                mono('    J --> K[写回消息/状态/调试信息]'),
                mono('    K --> L[提取长期记忆并入库]'),

                new Paragraph({
                    text: '三、输入数据',
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 120, after: 160 }
                }),
                p('1. 用户最新消息。'),
                p('2. 最近可见聊天记录 liveHistory。'),
                p('3. 对话摘要 conversationDigest。'),
                p('4. 用户资料、角色设定、模型配置。'),
                p('5. 角色实时状态，如位置、体力、情绪、钱包、工作/休息状态。'),
                p('6. 商业街、朋友圈、群聊/私聊交叉上下文。'),
                p('7. 长期记忆库中的可检索记忆。'),

                new Paragraph({
                    text: '四、中间收集的数据',
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 120, after: 160 }
                }),
                p('1. topicSwitchState：判断当前输入是继续当前话题、切换话题，还是追问刚检索出的历史。'),
                p('2. moduleRoutes：决定是否加载 city_detail、school_detail、society_detail 等详细模块。'),
                p('3. plannerTopics：从最近对话中抽取的潜在检索主题。'),
                p('4. ragDecision：决定是直接回答、检索长期记忆，还是按日期回看。'),
                p('5. retrievalRequest：结构化检索请求，包含 queries、memory_focus、memory_tier、temporal_hint、limit。'),
                p('6. retrievedMemories：检索命中的记忆及其时间、来源、重要度、命中槽位等信息。'),
                p('7. ragProgress：前端展示的多阶段执行进度。'),

                new Paragraph({
                    text: '五、数据如何影响后续 Agent 活动',
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 120, after: 160 }
                }),
                p('1. 如果 topicSwitchState 为 SWITCH_TOPIC，则后续回复与检索优先围绕新输入，不再延续旧线程。'),
                p('2. 如果 topicSwitchState 为 FOLLOW_UP_ON_RETRIEVED_HISTORY，则系统会把当前输入视为对刚检索历史内容的继续追问。'),
                p('3. 如果 moduleRoutes.city_detail = 1，则会加载商业街/现实生活细节模块；否则保持在普通对话层。'),
                p('4. 如果 ragDecision = ENOUGH_CONTEXT，则不走检索，直接基于当前摘要和近期聊天生成回复。'),
                p('5. 如果 ragDecision = SEARCH_MEMORY，则进入查询改写与长期记忆检索流程。'),
                p('6. 如果 ragDecision = BROWSE_DATE，则按时间范围回看历史，而不是做普通语义检索。'),
                p('7. 如果命中高价值记忆，如 user_profile、user_current_arc、relationship 且 tier 为 core/active，则这些结果会优先影响最终回复。'),
                p('8. 如果检索结果不足或输出异常，则系统会降级处理，保证主回复链路不中断。'),

                new Paragraph({
                    text: '六、输出与闭环',
                    heading: HeadingLevel.HEADING_1,
                    spacing: { before: 120, after: 160 }
                }),
                p('1. 面向用户的输出：角色化自然语言回复。'),
                p('2. 面向系统的输出：RAG 状态、路由结果、检索元数据、调试日志、状态变更。'),
                p('3. 每轮对话结束后，系统会从近期消息中抽取值得保留的长期记忆，并写入 SQLite + Qdrant。'),
                p('4. 这些新记忆会在后续轮次再次被检索出来，继续影响 Agent 的判断与回复，形成“输入 -> 决策 -> 输出 -> 记忆沉淀 -> 再利用”的闭环。')
            ]
        }
    ]
});

Packer.toBuffer(doc).then((buffer) => {
    fs.writeFileSync(outputPath, buffer);
    console.log(outputPath);
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
