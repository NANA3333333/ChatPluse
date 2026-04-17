const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const docPath = path.join(process.cwd(), 'agent工作流.docx');
const marker = '七、当前热门开源 Agent 框架工作流（截至 2026-04-13）';

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function paragraph(text, { heading = false, centered = false } = {}) {
  const safe = escapeXml(text);
  if (heading) {
    return '<w:p><w:pPr><w:spacing w:before="120" w:after="160"/><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:rFonts w:hint="eastAsia" w:ascii="黑体" w:hAnsi="黑体" w:eastAsia="黑体" w:cs="黑体"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t>' + safe + '</w:t></w:r></w:p>';
  }
  const align = centered ? 'center' : 'left';
  return '<w:p><w:pPr><w:spacing w:after="140"/><w:jc w:val="' + align + '"/><w:rPr><w:rFonts w:hint="eastAsia" w:ascii="黑体" w:hAnsi="黑体" w:eastAsia="黑体" w:cs="黑体"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:hint="eastAsia" w:ascii="黑体" w:hAnsi="黑体" w:eastAsia="黑体" w:cs="黑体"/><w:b w:val="0"/><w:bCs w:val="0"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr><w:t>' + safe + '</w:t></w:r></w:p>';
}

const paragraphs = [
  paragraph(marker, { heading: true }),
  paragraph('下面这部分按当前官方 GitHub 仓库星标、官方文档活跃度和社区使用热度，选取目前讨论度较高的几类开源 Agent 框架：AutoGen、CrewAI、LangGraph、Mastra。它们虽然实现风格不同，但主流工作流已经逐渐收敛到“任务输入 -> 状态管理 -> 规划或路由 -> Agent/Tool 执行 -> 记忆与检查点 -> 人工干预/恢复 -> 输出结果”这一条主线。'),
  paragraph('1. AutoGen（microsoft/autogen，GitHub 约 57k stars）'),
  paragraph('核心思路：以“多 Agent 消息传递”作为中心机制。一个任务进入后，通常先交给主 Assistant 或 Team，再通过消息传递交给其他专业 Agent、工具 Agent 或 MCP 工作台处理，直到满足终止条件。'),
  paragraph('典型工作流：任务输入 -> 主 Agent 接收任务 -> 根据规则或工具包装器把任务转给专家 Agent -> 多 Agent 对话/协作 -> 调用工具或 MCP -> 达到终止条件 -> 汇总最终结果。'),
  paragraph('框架结构上，AutoGen 官方将其拆成 Core API、AgentChat API 和 Extensions API：底层是事件驱动和消息传递，上层是更易用的多 Agent 对话抽象，再往外是模型、工具和执行能力扩展。'),
  paragraph('当前需要特别注意：AutoGen 官方 README 已明确标注其处于 maintenance mode。也就是说，它仍然是当前很有代表性的开源多 Agent 框架，但新项目官方更推荐迁移到 Microsoft Agent Framework。'),
  paragraph('2. CrewAI（crewAIInc/crewAI，GitHub 约 48.7k stars）'),
  paragraph('核心思路：把 Agent 协作拆成两层，一层是 Crews，强调角色化 Agent 团队协作；另一层是 Flows，强调生产级、事件驱动的精确流程控制。'),
  paragraph('典型工作流：触发输入 -> Flow 的 @start() 节点启动 -> 状态对象保存上下文 -> @listen() 监听上一步输出 -> @router() 做条件路由 -> 调用 Crew 或单个 Agent 执行任务 -> 结果汇总并继续流转 -> 必要时做 checkpoint 持久化和恢复。'),
  paragraph('CrewAI 的特点是把“自主协作”和“可控编排”分开处理：需要 Agent 自由分工时用 Crew，需要确定的生产路径时用 Flow，所以比较适合企业自动化和业务流程场景。'),
  paragraph('3. LangGraph（langchain-ai/langgraph，GitHub 约 29.1k stars）'),
  paragraph('核心思路：把 Agent 明确建模成“图”。节点（node）负责执行某一步，例如分类、检索、分析、工具调用；边（edge）负责决定下一步去哪里；共享 state 负责把中间结果在整个执行过程中持续保存。'),
  paragraph('典型工作流：任务输入 -> 写入 graph state -> 从 START 进入首个节点 -> 节点执行模型或工具 -> 把输出写回 state -> 条件边决定后续节点 -> 在每个 graph step 做 checkpoint -> 如需人工审核则 interrupt 并暂停 -> 恢复后继续执行 -> 到 END 输出结果。'),
  paragraph('LangGraph 的突出点是 durable execution、checkpoint、human-in-the-loop、long-running stateful workflow。也就是说，它非常适合那种会分支、会循环、会中断、需要恢复、需要长期状态的 Agent 系统。'),
  paragraph('4. Mastra（mastra-ai/mastra，GitHub 约 22.9k stars）'),
  paragraph('核心思路：用 TypeScript 生态做“Agent + Workflow + Tool + Memory”的一体化编排。Mastra 官方把 workflows 描述成 execution graph，可以直接编排 agents 和 tool calls。'),
  paragraph('典型工作流：输入进入 workflow -> 执行图按 sequential / parallel / branch / loops 运行 -> 节点里可以调用 agent、tool 或嵌套 workflow -> 状态在流程中持续保存 -> 遇到人工审核点时 suspend -> 审核后 resume -> 输出结果并记录观测数据。'),
  paragraph('Mastra 的优势是“工程化味道很重”：它把 agent、memory、MCP、observability、workflow 都放在一个比较完整的 TypeScript 体系里，适合前后端一体和产品化落地。'),
  paragraph('5. 当前热门框架的共同工作流特征'),
  paragraph('综合来看，这几类热门开源 Agent 框架的工作流已经比较趋同：'),
  paragraph('（1）先接收任务输入，并把输入转成共享状态或共享上下文。'),
  paragraph('（2）通过 planner、router、graph edge 或 flow decorator 决定后续分支，而不是只靠一次性 prompt 硬推到底。'),
  paragraph('（3）在执行层调用 agent、tool、子 agent、MCP 或外部系统。'),
  paragraph('（4）把中间结果持续写回 state / memory / checkpoint，使流程可以恢复、复盘和长期运行。'),
  paragraph('（5）在关键节点支持 human-in-the-loop，也就是暂停、审核、修改后继续执行。'),
  paragraph('（6）在输出阶段除了给用户最终结果，还会留下 trace、日志、状态快照和评估数据，方便调试和优化。'),
  paragraph('对本项目的启发是：你现在这套 ChatPulse 工作流，实际上已经很接近当前主流 Agent 框架的工程化方向了。区别主要不在“有没有 Agent”，而在于是否把输入、状态、路由、检索、执行、恢复、观测这些环节拆清楚并可持续复用。'),
  paragraph('参考来源（2026-04-13 检索）：'),
  paragraph('AutoGen GitHub README：https://github.com/microsoft/autogen'),
  paragraph('CrewAI GitHub README：https://github.com/crewAIInc/crewAI'),
  paragraph('CrewAI Flows Docs：https://docs.crewai.com/en/concepts/flows'),
  paragraph('LangGraph GitHub README：https://github.com/langchain-ai/langgraph'),
  paragraph('LangGraph Docs：https://docs.langchain.com/oss/python/langgraph/quickstart'),
  paragraph('Mastra Workflows：https://mastra.ai/workflows'),
  paragraph('Mastra Agents：https://mastra.ai/agents')
].join('');

if (!fs.existsSync(docPath)) {
  throw new Error(`Document not found: ${docPath}`);
}

const zip = new AdmZip(docPath);
const entry = zip.getEntry('word/document.xml');
if (!entry) {
  throw new Error('word/document.xml not found');
}

const xmlText = zip.readAsText(entry, 'utf8');
if (xmlText.includes(marker)) {
  console.log('section-exists');
  process.exit(0);
}

const updated = xmlText.replace('<w:sectPr>', `${paragraphs}<w:sectPr>`);
if (updated === xmlText) {
  throw new Error('Failed to insert section before w:sectPr');
}

zip.updateFile('word/document.xml', Buffer.from(updated, 'utf8'));
zip.writeZip(docPath);
console.log('updated', docPath);
