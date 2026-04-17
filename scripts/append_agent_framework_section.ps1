Add-Type -AssemblyName System.IO.Compression.FileSystem

$docPath = Join-Path (Get-Location) 'agent工作流.docx'
$zip = [System.IO.Compression.ZipFile]::Open($docPath, [System.IO.Compression.ZipArchiveMode]::Update)

try {
  $entry = $zip.GetEntry('word/document.xml')
  if (-not $entry) { throw 'word/document.xml not found' }

  $reader = New-Object System.IO.StreamReader($entry.Open())
  $xmlText = $reader.ReadToEnd()
  $reader.Close()

  function Escape-XmlText([string]$text) {
    return [System.Security.SecurityElement]::Escape([string]$text)
  }

  function New-ParagraphXml([string]$text, [bool]$isHeading = $false, [bool]$isCentered = $false) {
    $safe = Escape-XmlText $text
    if ($isHeading) {
      return '<w:p><w:pPr><w:spacing w:before="120" w:after="160"/><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:rFonts w:hint="eastAsia" w:ascii="黑体" w:hAnsi="黑体" w:eastAsia="黑体" w:cs="黑体"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t>' + $safe + '</w:t></w:r></w:p>'
    }
    $jc = 'left'
    if ($isCentered) { $jc = 'center' }
    return '<w:p><w:pPr><w:spacing w:after="140"/><w:jc w:val="' + $jc + '"/><w:rPr><w:rFonts w:hint="eastAsia" w:ascii="黑体" w:hAnsi="黑体" w:eastAsia="黑体" w:cs="黑体"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:hint="eastAsia" w:ascii="黑体" w:hAnsi="黑体" w:eastAsia="黑体" w:cs="黑体"/><w:b w:val="0"/><w:bCs w:val="0"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr><w:t>' + $safe + '</w:t></w:r></w:p>'
  }

  $paragraphs = @(
    (New-ParagraphXml '七、当前热门开源 Agent 框架工作流（截至 2026-04-13）' $true),
    (New-ParagraphXml '下面这部分按当前官方 GitHub 仓库星标、官方文档活跃度和社区使用热度，选取目前讨论度较高的几类开源 Agent 框架：AutoGen、CrewAI、LangGraph、Mastra。它们虽然实现风格不同，但主流工作流已经逐渐收敛到“任务输入 -> 状态管理 -> 规划或路由 -> Agent/Tool 执行 -> 记忆与检查点 -> 人工干预/恢复 -> 输出结果”这一条主线。'),
    (New-ParagraphXml '1. AutoGen（microsoft/autogen，GitHub 约 57k stars）'),
    (New-ParagraphXml '核心思路：以“多 Agent 消息传递”作为中心机制。一个任务进入后，通常先交给主 Assistant 或 Team，再通过消息传递交给其他专业 Agent、工具 Agent 或 MCP 工作台处理，直到满足终止条件。'),
    (New-ParagraphXml '典型工作流：任务输入 -> 主 Agent 接收任务 -> 根据规则或工具包装器把任务转给专家 Agent -> 多 Agent 对话/协作 -> 调用工具或 MCP -> 达到终止条件 -> 汇总最终结果。'),
    (New-ParagraphXml '框架结构上，AutoGen 官方将其拆成 Core API、AgentChat API 和 Extensions API：底层是事件驱动和消息传递，上层是更易用的多 Agent 对话抽象，再往外是模型、工具和执行能力扩展。'),
    (New-ParagraphXml '当前需要特别注意：AutoGen 官方 README 已明确标注其处于 maintenance mode。也就是说，它仍然是当前很有代表性的开源多 Agent 框架，但新项目官方更推荐迁移到 Microsoft Agent Framework。'),
    (New-ParagraphXml '2. CrewAI（crewAIInc/crewAI，GitHub 约 48.7k stars）'),
    (New-ParagraphXml '核心思路：把 Agent 协作拆成两层，一层是 Crews，强调角色化 Agent 团队协作；另一层是 Flows，强调生产级、事件驱动的精确流程控制。'),
    (New-ParagraphXml '典型工作流：触发输入 -> Flow 的 @start() 节点启动 -> 状态对象保存上下文 -> @listen() 监听上一步输出 -> @router() 做条件路由 -> 调用 Crew 或单个 Agent 执行任务 -> 结果汇总并继续流转 -> 必要时做 checkpoint 持久化和恢复。'),
    (New-ParagraphXml 'CrewAI 的特点是把“自主协作”和“可控编排”分开处理：需要 Agent 自由分工时用 Crew，需要确定的生产路径时用 Flow，所以比较适合企业自动化和业务流程场景。'),
    (New-ParagraphXml '3. LangGraph（langchain-ai/langgraph，GitHub 约 29.1k stars）'),
    (New-ParagraphXml '核心思路：把 Agent 明确建模成“图”。节点（node）负责执行某一步，例如分类、检索、分析、工具调用；边（edge）负责决定下一步去哪里；共享 state 负责把中间结果在整个执行过程中持续保存。'),
    (New-ParagraphXml '典型工作流：任务输入 -> 写入 graph state -> 从 START 进入首个节点 -> 节点执行模型或工具 -> 把输出写回 state -> 条件边决定后续节点 -> 在每个 graph step 做 checkpoint -> 如需人工审核则 interrupt 并暂停 -> 恢复后继续执行 -> 到 END 输出结果。'),
    (New-ParagraphXml 'LangGraph 的突出点是 durable execution、checkpoint、human-in-the-loop、long-running stateful workflow。也就是说，它非常适合那种会分支、会循环、会中断、需要恢复、需要长期状态的 Agent 系统。'),
    (New-ParagraphXml '4. Mastra（mastra-ai/mastra，GitHub 约 22.9k stars）'),
    (New-ParagraphXml '核心思路：用 TypeScript 生态做“Agent + Workflow + Tool + Memory”的一体化编排。Mastra 官方把 workflows 描述成 execution graph，可以直接编排 agents 和 tool calls。'),
    (New-ParagraphXml '典型工作流：输入进入 workflow -> 执行图按 sequential / parallel / branch / loops 运行 -> 节点里可以调用 agent、tool 或嵌套 workflow -> 状态在流程中持续保存 -> 遇到人工审核点时 suspend -> 审核后 resume -> 输出结果并记录观测数据。'),
    (New-ParagraphXml 'Mastra 的优势是“工程化味道很重”：它把 agent、memory、MCP、observability、workflow 都放在一个比较完整的 TypeScript 体系里，适合前后端一体和产品化落地。'),
    (New-ParagraphXml '5. 当前热门框架的共同工作流特征'),
    (New-ParagraphXml '综合来看，这几类热门开源 Agent 框架的工作流已经比较趋同：'),
    (New-ParagraphXml '（1）先接收任务输入，并把输入转成共享状态或共享上下文。'),
    (New-ParagraphXml '（2）通过 planner、router、graph edge 或 flow decorator 决定后续分支，而不是只靠一次性 prompt 硬推到底。'),
    (New-ParagraphXml '（3）在执行层调用 agent、tool、子 agent、MCP 或外部系统。'),
    (New-ParagraphXml '（4）把中间结果持续写回 state / memory / checkpoint，使流程可以恢复、复盘和长期运行。'),
    (New-ParagraphXml '（5）在关键节点支持 human-in-the-loop，也就是暂停、审核、修改后继续执行。'),
    (New-ParagraphXml '（6）在输出阶段除了给用户最终结果，还会留下 trace、日志、状态快照和评估数据，方便调试和优化。'),
    (New-ParagraphXml '对本项目的启发是：你现在这套 ChatPulse 工作流，实际上已经很接近当前主流 Agent 框架的工程化方向了。区别主要不在“有没有 Agent”，而在于是否把输入、状态、路由、检索、执行、恢复、观测这些环节拆清楚并可持续复用。'),
    (New-ParagraphXml '参考来源（2026-04-13 检索）：'),
    (New-ParagraphXml 'AutoGen GitHub README：https://github.com/microsoft/autogen'),
    (New-ParagraphXml 'CrewAI GitHub README：https://github.com/crewAIInc/crewAI'),
    (New-ParagraphXml 'CrewAI Flows Docs：https://docs.crewai.com/en/concepts/flows'),
    (New-ParagraphXml 'LangGraph GitHub README：https://github.com/langchain-ai/langgraph'),
    (New-ParagraphXml 'LangGraph Docs：https://docs.langchain.com/oss/python/langgraph/quickstart'),
    (New-ParagraphXml 'Mastra Workflows：https://mastra.ai/workflows'),
    (New-ParagraphXml 'Mastra Agents：https://mastra.ai/agents')
  )

  $insertXml = [string]::Join('', $paragraphs)
  $updated = $xmlText -replace '<w:sectPr>', ($insertXml + '<w:sectPr>')
  if ($updated -eq $xmlText) { throw 'Failed to insert new section before w:sectPr' }

  $entry.Delete()
  $newEntry = $zip.CreateEntry('word/document.xml')
  $writer = New-Object System.IO.StreamWriter($newEntry.Open())
  $writer.Write($updated)
  $writer.Close()
}
finally {
  $zip.Dispose()
}
