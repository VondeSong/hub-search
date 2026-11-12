export type SourceId = 'craft' | 'obsidian' | 'ticktick' | 'notion' | 'feishu' | 'hub';
export type ItemKind = 'note' | 'task' | 'reading' | 'journal';
export type Section = {
  assistantSourceIds?: string[];
  assistantOperationId?: string;
  type: 'p' | 'h2' | 'quote' | 'callout' | 'list' | 'checklist';
  text?: string;
  items?: string[];
};
export type HubItem = {
  id: string;
  title: string;
  kind: ItemKind;
  source: SourceId;
  space: string;
  group: '今天' | '昨天' | '本周' | '上周';
  date: string;
  dateLabel: string;
  tags: string[];
  excerpt: string;
  sections: Section[];
  taskState?: 'todo' | 'doing' | 'waiting' | 'done';
  readState?: 'inbox' | 'reading' | 'done' | 'archived' | 'abandoned';
  due?: string;
  completedOn?: string;
  project?: string;
  originInsightId?: string;
  workId?: string;
};

export const sourceMeta: Record<SourceId, { name: string; label: string; color: string; icon: string }> = {
  craft: { name: 'Craft', label: 'Car · 汽车线束', color: '#B27D56', icon: 'C' },
  obsidian: { name: 'Obsidian', label: 'main · 知识笔记', color: '#8A72BB', icon: 'O' },
  ticktick: { name: '滴答清单', label: '滴答清单 · 行动', color: '#527FC7', icon: 'T' },
  notion: { name: 'Notion', label: 'software · 工具研究', color: '#73716F', icon: 'N' },
  feishu: { name: '飞书', label: '项目资料 · 示例', color: '#558CA3', icon: 'F' },
  hub: { name: 'Hub', label: 'Hub · 工作空间', color: '#536E60', icon: 'H' },
};

// Scenario data for the interactive prototype; these are not connected account records.
export const initialItems: HubItem[] = [
  {
    id: 'hub-acceptance', title: 'Hub 验收专用页', kind: 'note', source: 'obsidian',
    space: 'main / Hub验收库', group: '今天', date: '2026-11-08', dateLabel: '今天',
    tags: ['Hub', '设计'], excerpt: '用一份熟悉的资料，走完搜索、阅读、收藏和继续工作的过程。',
    sections: [
      { type: 'p', text: '这是一份用于浏览器原型的验收示例。先从日常使用出发，观察每一步是否自然、是否容易找到下一步。' },
      { type: 'h2', text: '从资料开始' },
      { type: 'checklist', items: ['搜索“线束”，确认结果与来源都清楚。', '打开一篇笔记，确认阅读位置不会被工具栏挤占。', '收藏页面，再从收藏入口找到它。', '打开助手，将当前资料加入讨论。'] },
      { type: 'quote', text: '一个好用的工作空间，让人把注意力放在事情上。' },
    ],
  },
  {
    id: 'ui-design', title: 'UI 设计示例', kind: 'note', source: 'craft',
    space: 'main / 设计参考', group: '今天', date: '2026-11-08', dateLabel: '今天',
    tags: ['设计', 'Hub'], excerpt: '克制的颜色、清楚的层级，以及阅读时能够安静下来的界面。',
    sections: [
      { type: 'p', text: '这份设计练习围绕 Hub 的四个区域展开。保留窄图标栏、二级导航、时间分组列表和右侧阅读面板，让洞察融入现有 Hub。先保持熟悉的位置，再改善间距、文字和状态反馈。' },
      { type: 'h2', text: '把层级留给内容' },
      { type: 'list', items: ['正文使用稳定的实底，导航和临时浮层保留适度通透。', '主标题、来源、时间保持不同的视觉重量。', '强调色用于当前选择和主要动作，避免每一块都争夺注意力。', '列表切换、返回和展开后，尽量保留阅读位置。'] },
      { type: 'quote', text: '质感来自许多小决定的一致：留白、字重、边界，以及点击后的回应。' },
    ],
  },
  {
    id: 'harness', title: '1 线束', kind: 'note', source: 'craft',
    space: 'Car / 线束知识', group: '昨天', date: '2026-11-07', dateLabel: '昨天',
    tags: ['线束'], excerpt: '线束资料的入口：回路、布置、物料、规范与问题记录。',
    sections: [
      { type: 'p', text: '本页是示例知识目录。记录以具体问题为入口，把图纸、依据和结论放在同一处，方便后续复核。' },
      { type: 'h2', text: '五个常用方向' },
      { type: 'list', items: ['回路：起点、终点、连接器和孔位是否能互相对应？', '布置：固定点、相邻件和运动包络需要核对哪些图纸？', '物料：零件号、适用条件及替代关系如何确认？', '规范：当前项目使用的版本和适用范围是什么？', '问题：现象、复现条件和验证结果是否完整？'] },
      { type: 'callout', text: '尺寸、力矩和选型条件以当前项目批准的资料为准；本页只提供整理思路。' },
    ],
  },
  {
    id: 'codex-hub', title: '把 Codex 接入 Hub 的意义', kind: 'note', source: 'ticktick',
    space: '滴答清单 / 收件箱', group: '本周', date: '2026-11-06', dateLabel: '2 天前',
    tags: ['AI', 'Hub', '决策'], excerpt: '让已经积累的资料成为可以推进工作的上下文，让成果回到自己的知识和任务系统。',
    sections: [
      { type: 'p', text: '把 Codex 接入 Hub，希望做到：让已有资料成为可以推进工作的上下文，让成果回到自己的知识和任务系统。这篇示例笔记用一个完整场景说明这件事。' },
      { type: 'p', text: '当我们打开一份资料，正在看的内容、所属项目和相关问题已经构成了起点。助手应当在明确选择的资料范围内接续工作，让引用、草稿和下一步能够被找到。' },
      { type: 'h2', text: '从阅读到成果，再到下一次继续' },
      { type: 'quote', text: '选中几篇材料 → 结合已有知识比较整理 → 更新专题笔记 → 提炼行动 → 下次继续。' },
      { type: 'p', text: '例如，准备整理 DXF 图纸到线表的流程时，可以把图纸说明、字段定义和已有疑问一起交给助手。先列出有依据的对应关系，再把无法确认的部分留成问题。结果值得保留时，再选择保存的位置。' },
      { type: 'list', items: ['找到上一次使用的材料、结论与未解决的问题。', '指出本次新增了什么，以及哪些原有结论需要重新核对。', '让每个建议都能回到相关资料，区分已知信息与待验证假设。', '保留确认过的成果，让下一次可以接着做。'] },
      { type: 'callout', text: '洞察负责发现联系与值得关注的变化；内容、任务、阅读和日志继续承接各自的记录与操作。' },
      { type: 'h2', text: '怎样判断是否真的有帮助？' },
      { type: 'checklist', items: ['是否减少了重复解释背景和来回复制材料？', '是否能从建议直接打开相关来源？', '是否产生了可以检查、修改和保存的成果？', '再次打开时，是否能看见上次做到哪里？'] },
    ],
  },
  {
    id: 'dxf-guide', title: 'DXF → 线表：先验证一个样本', kind: 'note', source: 'craft',
    space: 'Car / 图纸与数据', group: '昨天', date: '2026-11-07', dateLabel: '昨天',
    tags: ['DXF', '线束'], excerpt: '先明确字段和对应关系，再用一张样图逐行核对导出结果。',
    sections: [
      { type: 'p', text: '示例记录：11月5日先把验证范围收小到一张图纸，11月7日补充字段清单。第一轮以可人工对照的小样本为准，记录字段缺失和识别不确定的位置。自动提取的结果先作为待验证记录保留。' },
      { type: 'h2', text: '开始前要确认的字段' },
      { type: 'list', items: ['CIRCUIT NBR 在这套图纸中采用什么命名规则？', 'Cav 对应哪个连接器、哪个端点的孔位？', 'wire 字段代表线号、导线规格，还是其他属性？', '左右端信息、跨页连接和未连接端应如何表达？'] },
      { type: 'checklist', items: ['选取一张有完整说明的样图。', '人工记录几条可明确对应的回路作为核对样本。', '逐行比较导出结果，保留无法确认的字段。', '将误差类型记入问题清单，再调整下一轮。'] },
      { type: 'callout', text: '图纸标签的含义需要结合图例、字段说明和项目规则确认，不从字段名字直接推断工程结论。' },
    ],
  },
  {
    id: 'circuit', title: 'CIRCUIT NBR、Cav 与 wire 的区别', kind: 'note', source: 'craft',
    space: 'Car / 回路理解', group: '本周', date: '2026-11-05', dateLabel: '3 天前',
    tags: ['线束', 'DXF'], excerpt: '把连接器、孔位、回路号和导线信息放在同一条核对记录里。',
    sections: [
      { type: 'p', text: '示例记录：11月3日开始区分连接器、孔位与回路编号，11月5日补充核对问题。每条记录都保留图纸位置和不确定项，字段的具体含义仍需结合图纸说明确认。' },
      { type: 'h2', text: '一条回路的检查顺序' },
      { type: 'list', items: ['确认图纸名称、版本和适用车型。', '分别记录两端连接器名称与孔位标识。', '核对回路号、导线字段及相关说明。', '跨页引用是否能找到对应的另一端？', '存在重复编号或缺失信息时，应该向谁确认？'] },
      { type: 'quote', text: '先区分连接器、孔位与回路编号，再核对导线信息；不能只凭单个字段确认完整去向。' },
    ],
  },
  {
    id: 'catia', title: '7_Catia', kind: 'note', source: 'craft',
    space: 'Car / 设计工具', group: '本周', date: '2026-11-05', dateLabel: '3 天前',
    tags: ['线束', '设计'], excerpt: '围绕卡扣位置、装配关系和电气属性整理待验证的操作问题。',
    sections: [
      { type: 'p', text: '用具体问题整理 CATIA 操作记录：目标是什么、对象是什么、修改了哪些关系，以及如何验证结果。此处不预设软件版本或模块能力。' },
      { type: 'h2', text: '卡扣对称位置的验证' },
      { type: 'checklist', items: ['先明确参考平面与装配坐标系。', '对称位置是否与预期基准一致？', '原对象与副本的方向、约束是否需要分别确认？', '目标电气属性是否仍可读取和使用？', '使用隔离示例记录操作前后状态。'] },
      { type: 'callout', text: '在确认实际版本、许可模块与对象类型之前，把操作路线保留为待验证方案。' },
    ],
  },
  {
    id: 'decision-cloud', title: '决定记录：先验证云端归档', kind: 'note', source: 'hub',
    space: 'Hub / 决策记录', group: '上周', date: '2026-11-01', dateLabel: '1 周前',
    tags: ['决策', 'Hub', 'AI'], excerpt: '将判断依据与假设单独写下来，条件变化时能够重新评估。',
    sections: [
      { type: 'p', text: '这是11月1日的决策记录示例，保留当时的目标与理由：希望减少资料在设备之间的搬运。先验证一个来源能否完整完成读取、整理和保存。之后再决定是否扩大到其他资料。' },
      { type: 'h2', text: '需要验证的假设' },
      { type: 'list', items: ['常用资料能否在所需环境中稳定读取？', '需要哪些账号与来源授权，能否逐项控制？', '中途暂停后，结果和上下文是否容易找回？', '每次执行的时间与费用是否在可接受范围内？'] },
      { type: 'callout', text: '重新评估的触发点：来源限制改变、等待时间明显增加，或流程仍需要频繁手动搬运。' },
      { type: 'quote', text: '先验证一件真实的小事，再决定是否扩大范围。' },
    ],
  },
  {
    id: 't29', title: 'T29 · 项目知识入口', kind: 'note', source: 'craft',
    space: 'Car / 项目示例', group: '本周', date: '2026-11-04', dateLabel: '4 天前',
    tags: ['线束'], excerpt: '集中放置项目资料入口、待确认问题和已经形成的记录。',
    sections: [
      { type: 'p', text: '这里用 T29 作为示例项目名称，不包含真实项目文件或内部结论。知识入口只保留常用导航和问题索引。' },
      { type: 'h2', text: '项目资料的四个入口' },
      { type: 'list', items: ['图纸：文件、版本与适用范围。', '问题：现象、位置、条件与待确认点。', '决策：备选方案、取舍与后续检查。', '验证：做了什么、观察到什么、仍缺少什么。'] },
      { type: 'callout', text: '任务进度留在对应清单，资料页保留背景与证据；两者通过链接互相找到。' },
    ],
  },
  {
    id: 'standards', title: '2_规范与标准', kind: 'note', source: 'craft',
    space: 'Car / 基础资料', group: '本周', date: '2026-11-03', dateLabel: '5 天前',
    tags: ['线束'], excerpt: '让每条设计依据都能回到文件版本、适用范围和原始条款。',
    sections: [
      { type: 'p', text: '这份示例目录按问题组织资料，而不只按文件名排列。引用前先确认版本与适用范围，摘要旁保留原文位置。' },
      { type: 'h2', text: '引用依据时的核对项' },
      { type: 'checklist', items: ['是否是当前项目适用的批准版本？', '条款涉及的对象、工况与例外是什么？', '是否有客户要求或项目补充说明？', '摘要是否保留了限制条件？'] },
      { type: 'quote', text: '一条可用的知识，应当能解释它在什么情况下成立。' },
    ],
  },
  {
    id: 'parts-library', title: '3_物料与选型库', kind: 'note', source: 'craft',
    space: 'Car / 基础资料', group: '本周', date: '2026-11-03', dateLabel: '5 天前',
    tags: ['线束', '设计'], excerpt: '把零件信息、选型条件与尚未验证的兼容问题分开记录。',
    sections: [
      { type: 'p', text: '示例选型记录围绕连接器、端子、卡扣和保护件展开。记录中的空缺是后续确认的入口，不用相似外观代替适用性判断。' },
      { type: 'h2', text: '一张物料卡片需要什么？' },
      { type: 'list', items: ['零件名称、料号和来源文件。', '接口、尺寸及安装条件的核对位置。', '与相邻件的配合关系。', '候选替代件及需要验证的差异。', '确认日期、结论与仍未解决的问题。'] },
      { type: 'callout', text: '这里不提供通用的尺寸或兼容性结论；选型条件应回到对应技术资料核对。' },
    ],
  },
  {
    id: 'context7', title: 'Context7 · 工具研究笔记', kind: 'note', source: 'notion',
    space: 'software / AI 扩展', group: '本周', date: '2026-11-03', dateLabel: '5 天前',
    tags: ['AI', 'Hub'], excerpt: '用同一个小问题，观察文档检索是否让答案更可核对。',
    sections: [
      { type: 'p', text: '这是一份工具评估模板。工具名称是研究对象，页面不代表已经安装或连接。先确定要解决的问题，再设计一个能比较结果的小样例。' },
      { type: 'h2', text: '比较哪些结果？' },
      { type: 'list', items: ['返回的文档是否对应正在使用的版本？', '能否定位到原始页面与相关段落？', '答案中是否仍有需要人工核对的假设？', '操作步骤与等待时间是否值得保留？'] },
      { type: 'quote', text: '把工具放回实际问题里，才知道它是否帮上忙。' },
    ],
  },
  {
    id: 'ponytail', title: 'Ponytail · 使用场景待验证', kind: 'note', source: 'notion',
    space: 'software / AI 扩展', group: '本周', date: '2026-11-03', dateLabel: '5 天前',
    tags: ['AI'], excerpt: '先记录想解决的远程操作问题，再核对工具的支持范围。',
    sections: [
      { type: 'p', text: '示例研究问题：离开桌面后，如何了解正在执行的工作，并在需要时继续操作？这里保留评估方向，不假定任何功能已经可用。' },
      { type: 'h2', text: '下一步要弄清楚' },
      { type: 'checklist', items: ['支持哪些系统与连接方式？', '手机端能查看哪些执行状态？', '断开后能否继续同一项工作？', '访问与账号权限如何管理？'] },
      { type: 'callout', text: '结论状态：待验证。找到正式说明并完成一个小场景后，再决定是否采用。' },
    ],
  },
  {
    id: 'electrical-architecture', title: '9_整车电气系统与接口认知', kind: 'note', source: 'craft',
    space: 'Car / 系统理解', group: '上周', date: '2026-11-01', dateLabel: '1 周前',
    tags: ['线束'], excerpt: '从系统功能出发，整理控制器、接口与线束之间需要核对的关系。',
    sections: [
      { type: 'p', text: '建立系统理解时，先画清对象与关系，再补充接口和具体参数。本页是一组读图问题，用于引导资料整理。' },
      { type: 'h2', text: '读资料时带着这些问题' },
      { type: 'list', items: ['这个功能涉及哪些设备和控制器？', '每个接口承载什么信号或供电功能，依据在哪里？', '连接关系是否能与原理图、布置图对应？', '名称相似的接口是否属于同一对象？', '哪些问题需要结合项目说明进一步确认？'] },
      { type: 'quote', text: '先明确“谁与谁连接、为什么连接”，再处理细节。' },
    ],
  },
  {
    id: 'task-dxf', title: '验证一张 DXF 图纸的线表导出', kind: 'task', source: 'ticktick',
    space: '滴答清单 / 汽车线束', group: '今天', date: '2026-11-08', dateLabel: '今天',
    tags: ['DXF', '线束'], excerpt: '等待一张合适的脱敏图纸；可以先整理字段核对清单。',
    taskState: 'waiting', due: '2026-11-08', project: '汽车线束',
    sections: [
      { type: 'p', text: '示例任务尚在等待材料。任务尚未完成，当前下一步是准备可对照的图纸样本。所需的脱敏图纸还未到位，今天可以先依据已有笔记整理字段清单。' },
      { type: 'checklist', items: ['选择一张脱敏图纸，核对连接器编号、Cav、CIRCUIT NBR 和 wire。', '人工记录三条可确认的回路。', '对比导出结果并记录差异。'] },
      { type: 'callout', text: '恢复条件：取得有明确版本和字段说明的脱敏图纸。完成标准：每一条差异都有图纸位置和待确认问题。' },
    ],
  },
  {
    id: 'task-clip', title: '核对卡扣安装顺序并整理说明', kind: 'task', source: 'ticktick',
    space: '滴答清单 / 汽车线束', group: '昨天', date: '2026-11-07', dateLabel: '昨天',
    tags: ['线束', '复盘'], excerpt: '将现象、安装顺序和检查结果拆开记录，保留待验证的原因。',
    taskState: 'todo', due: '2026-11-08', project: '汽车线束',
    sections: [
      { type: 'p', text: '状态：待处理。需确认安装顺序与记录的样本范围。示例周记已记下完成一轮样本核对，但本任务还需要确认是否属于同一对象和同一验收范围，再整理说明。' },
      { type: 'checklist', items: ['描述位置和现象。', '分别记录两种安装顺序。', '明确需要观察的形变或干涉位置。', '补齐样本与检查条件。'] },
      { type: 'callout', text: '完成标准：其他人能够根据记录复核问题与下一步。' },
    ],
  },
  {
    id: 'task-insights', title: '体验洞察：从发现回到原始资料', kind: 'task', source: 'ticktick',
    space: '滴答清单 / Hub', group: '今天', date: '2026-11-08', dateLabel: '今天',
    tags: ['Hub', '设计'], excerpt: '检查一条发现是否有依据、是否能进入相关任务或日志。',
    taskState: 'todo', due: '2026-11-08', project: 'Hub',
    sections: [
      { type: 'p', text: '在示例原型中选择一条洞察，沿来源进入正文，再回到洞察。关注理解成本和返回路径。' },
      { type: 'checklist', items: ['发现是否用一句话说明值得注意的变化？', '来源条目是否能直接打开？', '待确认的内容是否清楚区分？', '处理后是否能在相应位置找到记录？'] },
      { type: 'quote', text: '先找到有依据的联系，再决定要不要行动。' },
    ],
  },
  {
    id: 'task-review', title: '用十分钟做一次本周回顾', kind: 'task', source: 'ticktick',
    space: '滴答清单 / 个人', group: '昨天', date: '2026-11-07', dateLabel: '昨天',
    tags: ['复盘'], excerpt: '看看推进了什么、哪里卡住，以及下周要保留的一件小事。',
    taskState: 'todo', due: '2026-11-08', project: '个人',
    sections: [
      { type: 'p', text: '这是一项个人回顾示例。只选少量有代表性的记录，保留能帮助下一次行动的信息。' },
      { type: 'list', items: ['本周有什么可见的进展？', '哪一步反复卡住，条件是什么？', '哪些阅读与正在做的事情有关？', '下周准备从哪一个具体动作开始？'] },
      { type: 'callout', text: '不需要把每一条未完成事项都解释为问题。' },
    ],
  },
  {
    id: 'task-theme', title: '检查浅色与深色主题的正文对比', kind: 'task', source: 'ticktick',
    space: '滴答清单 / Hub', group: '本周', date: '2026-11-06', dateLabel: '2 天前',
    tags: ['设计', 'Hub'], excerpt: '在相同页面切换主题，比较标题、正文、来源与选中状态。',
    taskState: 'done', due: '2026-11-06', project: 'Hub',
    sections: [
      { type: 'p', text: '示例任务状态为已完成，用来体验任务勾选与筛选。它不代表真实产品已通过主题验收。' },
      { type: 'checklist', items: ['同一篇长文在不同主题下保持可读。', '次要信息不与正文争夺注意力。', '选中项与悬停项能够区分。'] },
      { type: 'quote', text: '切换配色时，内容的层级应该保持一致。' },
    ],
  },
  {
    id: 'task-waiting', title: '等待样图字段说明后补充映射', kind: 'task', source: 'ticktick',
    space: '滴答清单 / 汽车线束', group: '本周', date: '2026-11-05', dateLabel: '3 天前',
    tags: ['DXF', '线束'], excerpt: '明确依赖的资料，收到说明后再确认字段含义。',
    taskState: 'waiting', project: '汽车线束',
    sections: [
      { type: 'p', text: '示例等待事项：当前缺少字段说明，先列出问题与需要的资料。等待不等于需要反复提醒自己重新分析。' },
      { type: 'list', items: ['需要确认 CIRCUIT NBR 与 wire 的定义。', '需要一条完整的起点到终点示例。', '确认后更新 DXF 字段整理页。'] },
      { type: 'callout', text: '恢复条件：拿到可核对的字段说明或完整样例。' },
    ],
  },
  {
    id: 'read-dxf', title: '稍后读：图纸数据整理的方法', kind: 'reading', source: 'ticktick',
    space: '阅读 / 滴答稍后读', group: '今天', date: '2026-11-08', dateLabel: '今天',
    tags: ['DXF', '线束'], excerpt: '从小样本验证开始，逐步建立可靠的字段对应。', readState: 'reading',
    sections: [
      { type: 'p', text: '这是一篇阅读演示材料，供体验阅读状态与关联笔记。主题是如何让提取结果更容易被人工核对。' },
      { type: 'h2', text: '边读边保留问题' },
      { type: 'list', items: ['样本覆盖了哪些图纸情况？', '每个字段能否回到原始位置？', '不确定结果如何单独标记？', '修改规则后，原有样本是否仍然正确？'] },
      { type: 'callout', text: '关联笔记：DXF → 线表：先验证一个样本。可以把阅读中的核对问题带入样图验证任务。' },
    ],
  },
  {
    id: 'read-craft', title: '阅读摘记：让知识空间更有秩序', kind: 'reading', source: 'craft',
    space: '阅读 / 设计与工具', group: '昨天', date: '2026-11-07', dateLabel: '昨天',
    tags: ['设计', 'Hub'], excerpt: '观察页面层级、留白与返回路径怎样影响连续阅读。', readState: 'done',
    sections: [
      { type: 'p', text: '这份示例阅读摘记以 Craft 一类知识工具为观察对象，记录可供 Hub 设计练习的问题，不引用具体产品版本的功能结论。' },
      { type: 'h2', text: '值得带回设计练习的观察' },
      { type: 'list', items: ['层级是否能在不反复读取文字的情况下被理解？', '页面切换是否保留了上下文？', '工具入口在需要时是否容易找到？', '正文区域是否留出了足够的安静空间？'] },
      { type: 'quote', text: '让资料容易找到，也让找到之后的阅读足够舒服。' },
    ],
  },
  {
    id: 'read-agent', title: '稍后读：助手怎样接着上一次工作', kind: 'reading', source: 'hub',
    space: '阅读 / AI 与工作方式', group: '本周', date: '2026-11-06', dateLabel: '2 天前',
    tags: ['AI', 'Hub'], excerpt: '连续工作需要明确材料、已完成成果和仍未解决的问题。', readState: 'inbox',
    sections: [
      { type: 'p', text: '阅读示例：将一次问答看成工作中的一个阶段，思考如何让后续更容易继续。' },
      { type: 'h2', text: '阅读时关注' },
      { type: 'list', items: ['上一次的成果保存在哪里？', '哪些资料和假设已经发生变化？', '接续时是否需要重新确认目标？', '用户能否看见并修改当前的工作范围？'] },
      { type: 'callout', text: '关联笔记：把 Codex 接入 Hub 的意义。' },
    ],
  },
  {
    id: 'read-catia', title: '待研究：CATIA 装配操作的验证方式', kind: 'reading', source: 'feishu',
    space: '阅读 / 项目资料示例', group: '本周', date: '2026-11-05', dateLabel: '3 天前',
    tags: ['线束', '设计'], excerpt: '把一次操作拆成目标、对象、约束与结果核对。', readState: 'inbox',
    sections: [
      { type: 'p', text: '这份演示材料用于练习资料归纳，不包含真实项目附件。阅读重点是如何说明一个操作为什么符合目标。' },
      { type: 'list', items: ['操作前，参考坐标系和选中对象是什么？', '修改后，哪些位置或属性发生了变化？', '哪些结果可以直接测量，哪些需要额外核对？'] },
      { type: 'callout', text: '相关问题可整理到 7_Catia 笔记中，保留软件环境与验证条件。' },
    ],
  },
  {
    id: 'read-architecture', title: '阅读专题：从接口理解电气系统', kind: 'reading', source: 'craft',
    space: '阅读 / 汽车线束', group: '本周', date: '2026-11-04', dateLabel: '4 天前',
    tags: ['线束'], excerpt: '用连接关系组织知识，逐步补全系统之间的联系。', readState: 'reading',
    sections: [
      { type: 'p', text: '示例专题把相关资料围绕一个问题聚合：如何从接口认识系统，而不只记住零件名称。' },
      { type: 'h2', text: '准备留下的阅读成果' },
      { type: 'list', items: ['一份对象与连接关系的草图。', '一组能够回到来源的接口说明。', '需要继续确认的名称、方向与适用范围。'] },
      { type: 'quote', text: '把新信息放到关系里，下一次需要时更容易想起来。' },
    ],
  },
  {
    id: 'read-knowledge', title: '阅读摘记：把收藏变成可继续的知识', kind: 'reading', source: 'obsidian',
    space: '阅读 / 个人知识管理', group: '上周', date: '2026-11-01', dateLabel: '1 周前',
    tags: ['复盘', 'Hub'], excerpt: '为一条收藏留下当时的问题，比堆积更多资料更容易继续。', readState: 'archived',
    sections: [
      { type: 'p', text: '这份归档阅读示例只保留最有用的一条想法：收藏时给未来的自己留下一个入口。' },
      { type: 'list', items: ['为什么现在保存这份资料？', '它与哪个项目或问题有关？', '下次打开时准备确认什么？'] },
      { type: 'quote', text: '一小段自己的问题，往往比一个没有背景的链接更有用。' },
    ],
  },
  {
    id: 'journal-today', title: '今天的工作与想法', kind: 'journal', source: 'hub',
    space: 'Hub / 日志', group: '今天', date: '2026-11-08', dateLabel: '今天',
    tags: ['复盘', 'Hub', 'DXF'], excerpt: '示例日志：还在等待脱敏图纸；部分资料仍在本地，先把可做的步骤整理好。',
    sections: [
      { type: 'p', text: '今日示例记录：想继续做线表验证，但还需要一份合适的脱敏图纸；可以先把字段清单整理好。材料何时到位还没有确认，当前未完成状态反映的是这项等待条件。' },
      { type: 'h2', text: '准备怎么开始' },
      { type: 'list', items: ['先整理已有的回路、孔位和导线字段问题。', '确认可用于验证的脱敏图纸何时可用。', '图纸到位后，先核对三条明确的回路。', '结束时留下差异与下一步，不急着扩大样本。'] },
      { type: 'callout', text: '部分资料还在本地。浏览器原型可以先验证流程，真实接入还需要逐项核对。先选一个当前可访问的来源验证读取、整理和保存，再决定其他来源的接入顺序。' },
    ],
  },
  {
    id: 'journal-yesterday', title: '11月3日 · 给未完成的事情留一个入口', kind: 'journal', source: 'obsidian',
    space: 'main / 日常记录', group: '本周', date: '2026-11-03', dateLabel: '5 天前',
    tags: ['复盘'], excerpt: '示例日志：结束前记下停在哪一步，让再次开始更轻。',
    sections: [
      { type: 'p', text: '这段示例回顾关注“收尾”。一件事没有做完时，仍然可以留下清楚的当前状态。' },
      { type: 'list', items: ['已经确认的内容是什么？', '现在缺少哪一份资料或哪一个决定？', '下次打开后最先做什么？'] },
      { type: 'callout', text: '练习：把“继续研究”改写成一个可以直接开始的动作。' },
    ],
  },
  {
    id: 'journal-friday', title: '11月6日 · 阅读与手头的工作', kind: 'journal', source: 'obsidian',
    space: 'main / 日常记录', group: '本周', date: '2026-11-06', dateLabel: '2 天前',
    tags: ['复盘', 'DXF'], excerpt: '示例日志：给阅读材料标记一个正在面对的问题。',
    sections: [
      { type: 'p', text: '示例观察：阅读时带着具体问题，更容易判断哪些内容值得留下。这里把图纸数据整理与 DXF 字段核对联系起来。' },
      { type: 'h2', text: '值得保留的联系' },
      { type: 'list', items: ['阅读材料提供了一个核对思路。', '实际样图提供了可以验证的对象。', '任务清单记录下一步动作。'] },
      { type: 'quote', text: '读到的内容，能够在下一次工作里派上用场。' },
    ],
  },
  {
    id: 'journal-week', title: '本周回顾：从记录走向验证', kind: 'journal', source: 'hub',
    space: 'Hub / 日志', group: '昨天', date: '2026-11-07', dateLabel: '昨天',
    tags: ['复盘', '决策', 'Hub', '线束'], excerpt: '示例周记：一轮卡扣样本核对已经完成，Hub 设计也开始围绕完整流程验证。',
    sections: [
      { type: 'p', text: '这是一份11月7日的周记示例，用于体验从时间线回看一组相关主题。它不记录真实个人活动。' },
      { type: 'callout', text: '卡扣安装顺序已经完成一轮样本核对，结果整理到工作记录中。这里只记下这一轮样本的进展，批次、对象和全部验收项仍需与原任务逐项对照。' },
      { type: 'h2', text: 'Hub：从讨论功能，到走通一个场景' },
      { type: 'quote', text: '先用一个真实场景串起资料、分析和结果，再检查每一处是否顺手。' },
      { type: 'list', items: ['Hub 的导航能否保持熟悉，同时让洞察容易找到？', '从资料进入助手，再把成果保存回来，这条路径是否连贯？', 'DXF 整理仍需合适的脱敏图纸，后续先验证一个小样本。', '云端流程究竟减少了哪些搬运步骤，需要单独保留证据。'] },
    ],
  },
];
