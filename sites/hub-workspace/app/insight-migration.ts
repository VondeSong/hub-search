import type { HubItem, SourceId as HubSourceId, Section } from "./data";

/**
 * Data migrated from Hub Insights Lab v2 into the complete Hub workspace.
 * The source app contains four canonical discoveries, nine example documents,
 * and two bounded follow-up topics. Everything below remains prototype data.
 * Browser-local user state is deliberately not represented as transferred data.
 */
export const INSIGHTS_SOURCE_SITE = "https://hub-insights-lab-von11.song02211368537057.chatgpt.site";
export const INSIGHTS_REFERENCE_DATE = "2026-11-08";
export const LEGACY_INSIGHTS_STORAGE_KEYS = ["hub-insights-interactive-v2", "hub-insights-interactive-v1"] as const;

type LegacySourceId = 'craft-car' | 'obsidian-main' | 'dida-work' | 'reading';

type LegacySource = {
  id: LegacySourceId;
  name: string;
  provider: string;
  description: string;
  count: number;
  color: string;
};

type LegacyEvidence = {
  id: string;
  sourceId: LegacySourceId;
  title: string;
  path: string;
  updatedAt: string;
  quote: string;
  content: string;
};

type LegacyInsight = {
  id: string;
  kind: 'attention' | 'knowledge' | 'reading' | 'project';
  title: string;
  description: string;
  meaning: string;
  uncertainty: string;
  sourceIds: LegacySourceId[];
  evidenceIds: string[];
  actionLabel: string;
  actionType: 'compare' | 'checklist' | 'archive' | 'followup';
  period: 'today' | 'week';
  priority: number;
  tag: string;
};

type LegacyWatchItem = {
  id: string;
  title: string;
  description: string;
  sourceIds: LegacySourceId[];
  remaining: number;
  expires: string;
  enabled: boolean;
  relatedInsightId: string;
};


const LEGACY_SOURCES: LegacySource[] = [
  {
    id: 'craft-car',
    name: '汽车工程',
    provider: 'Craft',
    description: '工程笔记、装配记录与项目资料',
    count: 24,
    color: '#7e77bf',
  },
  {
    id: 'obsidian-main',
    name: '我的知识库',
    provider: 'Obsidian',
    description: '现场记录、字段映射与知识沉淀',
    count: 38,
    color: '#8b79b8',
  },
  {
    id: 'dida-work',
    name: '工作清单',
    provider: '滴答清单',
    description: '已同步的工作任务与检查项',
    count: 12,
    color: '#6d8db9',
  },
  {
    id: 'reading',
    name: '阅读收件箱',
    provider: '阅读',
    description: '待读材料、摘录与待整理文章',
    count: 9,
    color: '#b28f59',
  },
];

const LEGACY_EVIDENCE: LegacyEvidence[] = [
  {
    id: 'assembly-craft',
    sourceId: 'craft-car',
    title: '卡扣装配说明 · 设计评审稿',
    path: '汽车工程 / 装配工艺 / 卡扣装配说明',
    updatedAt: '今天 09:20',
    quote: '建议先安装卡扣 1，再安装卡扣 2。',
    content: '适用范围\n本页是一份用于演示的装配说明，记录 A 平台试制车型、左前门线束与饰板装配的讨论。记录采用设计评审稿中的编号，卡扣 1 位于主分支固定点，卡扣 2 位于连接器附近。编号只在本页示意范围内有效，不能直接套用到其他车型。\n\n装配建议\n建议先安装卡扣 1，再安装卡扣 2。这个顺序的依据是先固定主分支，再调整连接器附近的余量。试装时需要保留线束转动空间，检查卡扣完全就位后再进行饰板闭合。该建议来自桌面评审，尚未包含完整的现场验证记录。\n\n版本与条件\n当前摘录对应饰板方案 A、支架版本 V2。若现场采用了不同支架、左右门镜像件或新的连接器定位方式，装配顺序可能需要调整。两种顺序是否冲突，应先核对车型、零件版本、观察方向与编号对应关系。\n\n待核对事项\n下一次验证应记录实际零件号、试装照片和操作者说明，再对照现场记录确认适用条件。在这些信息齐备前，本页仅作为一个可追溯的建议，不作为判定现场操作正确与否的依据。',
  },
  {
    id: 'assembly-obsidian',
    sourceId: 'obsidian-main',
    title: '试装现场记录 · 左前门线束',
    path: '工程现场 / 试装 / 左前门线束记录.md',
    updatedAt: '今天 10:05',
    quote: '现场本次先安装卡扣 2，再安装卡扣 1。',
    content: '记录范围\n这是一份交互预览使用的现场记录，描述一轮左前门线束试装。现场采用试制工位的零件组合，记录人沿用了当时照片中的卡扣编号。记录未附正式工艺签发号，也没有说明照片视角是否与设计评审稿相同。\n\n实际观察\n现场本次先安装卡扣 2，再安装卡扣 1。操作者解释，先固定连接器附近的分支，便于检查线束与支架之间的走向，再将主分支压入剩余固定点。记录没有出现拉扯、干涉或返工的明确描述，因此不能仅凭顺序不同认定存在问题。\n\n适用条件\n现场使用的支架标签暂记为 V3，饰板方案尚待补充。若设计说明对应 V2 支架，这个差异可能来自零件版本变化；若编号或观察方向不同，也可能只是描述方式不同。需要以原始照片和零件清单确认，当前不作单一解释。\n\n后续核对\n建议把本页与设计评审稿放在同一视图，逐项核对车型、支架版本、卡扣编号和安装空间。确认两份记录讨论同一条件后，再决定是否更新说明或补一轮试装。核对结果应保留出处与确认人，方便后续继续追溯。',
  },
  {
    id: 'dxf-craft',
    sourceId: 'craft-car',
    title: 'DXF 线表整理 · 字段对照草稿',
    path: '汽车工程 / 数据整理 / DXF 线表字段对照',
    updatedAt: '今天 08:45',
    quote: '先选一份小样例，核对 CIRCUIT NBR、Cav 和 wire 的对应关系。',
    content: '工作范围\n本文是一个示例数据整理草稿，讨论如何把 DXF 图纸中的线表信息整理为可检查的结构。目标是验证字段理解和提取步骤，不是直接处理全部图纸。当前材料包含字段说明、少量截图和一份候选映射，尚没有完整的生产样本。\n\n验证入口\n先选一份小样例，核对 CIRCUIT NBR、Cav 和 wire 的对应关系。CIRCUIT NBR 暂按回路标识理解，Cav 暂按连接器腔位理解，wire 暂按导线信息理解。字段含义必须结合图纸表头、图例和具体行内容确认，不能只凭名称统一转换。\n\n建议步骤\n保留原始行号与截图位置，先手动标记五条记录，再检查程序提取结果是否保留前导零、分隔符和空白值。对跨行文本或合并单元格，应同时记录原文与解释后的字段，避免处理后无法复核。\n\n验收边界\n小样例验证只说明选中资料中的映射可用，不代表所有车型或图纸版本一致。若发现一个字段在不同表头中有不同含义，应拆分映射规则并保留待确认项。最终输出需要包含样例、字段对照、异常清单和一份能重新执行的检查步骤。',
  },
  {
    id: 'dxf-reading',
    sourceId: 'reading',
    title: 'DXF 表格提取与人工核对方法',
    path: '阅读收件箱 / 工程数据 / DXF 表格提取方法',
    updatedAt: '昨天 18:30',
    quote: '字段提取后应保留原始文本、所在位置和人工核对结果。',
    content: '材料范围\n这篇方法摘录为预览构造的阅读材料，介绍工程图纸表格提取的一种验证思路。讨论对象是由文本实体组成的线表，不涵盖扫描图片、缺失字体或所有复杂图框。阅读材料可以提供检查方法，但不能替代目标图纸的实际验证。\n\n核心方法\n字段提取后应保留原始文本、所在位置和人工核对结果。这样可以追踪一个结构化字段来自哪一行、哪一个文本实体，也便于解释合并、拆分或纠正的原因。对看起来相似的字段，先保存候选解释，再由样例确认其业务含义。\n\n适合尝试的样例\n可选取一张线表清晰、行数较少且包含空值的图纸，人工整理几条 CIRCUIT NBR、Cav 与 wire 记录。检查导线信息是否包含颜色、截面积或其他组合内容，腔位是否保留字母与前导零，回路标识是否存在重复。\n\n结果表达\n验证报告应区分已核对、待解释与提取失败三种状态，并给出原始位置。若样例通过，再逐步扩大到另一个版本或不同表格样式。方法文章与项目草稿可以组成一次小规模验证，但通过标准仍需由使用者结合目标资料设定。',
  },
  {
    id: 'harness-reading',
    sourceId: 'reading',
    title: '线束设计笔记 · 从阅读到检查项',
    path: '阅读收件箱 / 线束设计 / 设计检查笔记',
    updatedAt: '昨天 16:10',
    quote: '将设计原则、适用条件和检查问题一起保存，后续更容易复用。',
    content: '阅读范围\n本文为洞察预览准备的线束设计材料，围绕布置、固定与后续检查展开。它是一份方法性笔记，不代表某个具体项目的验收标准。原文按主题记录思路，其中数值、零件规格和企业规范均未补齐，归档时应保留这一范围。\n\n值得保留的内容\n将设计原则、适用条件和检查问题一起保存，后续更容易复用。例如，讨论固定点时同时记录可用空间、装配方向与维修可达性；讨论分支走向时，保留需要现场确认的干涉位置。这样可以把阅读结果变成下一次评审的提问依据。\n\n整理建议\n可以先形成三个小节：布置与保护、固定与装配、检查与验证。每个小节保留一段原文摘录，再补充一句自己的理解。尚未验证的推论使用待核对标记，避免与已经确认的工程结论混在一起。归档条目同时保留材料标题和来源入口。\n\n可执行的下一步\n先生成归档草稿，由使用者检查标题、分类与摘录范围，再选择目标知识库。在草稿得到确认前，不改变原有材料状态。未来若项目验证产生了新的结论，可以补充关联记录，让原则、实例和验证结果能够相互查阅。',
  },
  {
    id: 'wire-map-v1-craft',
    sourceId: 'craft-car',
    title: 'DXF 验证准备 · 旧映射快照 V1',
    path: '汽车工程 / 数据整理 / 验证准备 / 字段映射 V1',
    updatedAt: '11 月 6 日 14:10',
    quote: '本轮准备沿用 V1 映射：Cav 暂按纯数字保存；尚未加入字母与前导零的检查项。',
    content: '快照范围\n这是一份用于交互预览的旧映射快照，保存 DXF 小样例验证准备时采用的候选规则。它只记录当时的草稿，不代表规则已经验证通过，也不能说明当前程序仍在采用该规则。\n\n原有准备\n本轮准备沿用 V1 映射：Cav 暂按纯数字保存；尚未加入字母与前导零的检查项。wire 仅保留原始文本，具体含义等待人工样例确认。准备材料计划使用五条手工标记记录，逐行核对提取结果和原始位置。\n\n关联工作\n此快照关联“DXF 线表 · 小样例验证”的准备清单。记录中尚未出现对新映射笔记的审阅结论，因此不能根据这份历史快照判断后续是否已在线下更新。\n\n复核方式\n若新的字段映射改变了 Cav 的保存方式，应先核对目标样例是否包含 A01、01 等字符串，再决定补充检查项或修订候选规则。旧快照和新笔记应同时保留，实际代码与清单的更新需要另行确认。',
  },
  {
    id: 'wire-map-obsidian',
    sourceId: 'obsidian-main',
    title: '线表字段映射 · 样例核对记录',
    path: '工程知识 / 数据处理 / 线表字段映射.md',
    updatedAt: '今天 10:40',
    quote: 'Cav 保留字母与前导零，wire 暂存原始文本，不自动拆成多个字段。',
    content: '本次更新范围\n这份示例笔记保存线表字段映射的局部调整，更新对象是一组演示样例。它补充了字段保存方式，并未声明所有 DXF 图纸都适用同一规则。候选映射仍需要与项目草稿中的原始样例逐行对照。\n\n更新内容\nCav 保留字母与前导零，wire 暂存原始文本，不自动拆成多个字段。此前的草稿把腔位当作纯数字理解，本次调整允许保留例如 A01 这样的字符串。wire 的含义可能随表格样式变化，因此暂不自动拆分颜色、截面积与编号。\n\n核对记录\n演示样例中三条记录可以按原文读出，一条记录存在跨行显示，另有一条空值需要确认含义。这里的五条样例只用于展示核对过程；没有验证过的行不应自动继承已核对状态。每次修改映射后，应重新检查此前保存的原文位置。\n\n下一步\n将此更新与字段对照草稿一起审阅，确认命名、空值策略和原文保留方式是否一致。若决定采用新映射，再更新验证清单并记录适用版本。已有记录的改变是一次复查信号，不能单独证明整个提取流程已经完成或已经可以用于生产。',
  },
  {
    id: 'review-dida',
    sourceId: 'dida-work',
    title: '准备线表样例评审',
    path: '工作清单 / 工程数据 / 准备线表样例评审',
    updatedAt: '昨天 15:25',
    quote: '评审前准备一份原始样例、字段对照和待确认问题。',
    content: '任务范围\n这是一条演示用的工作清单任务，内容是准备一次线表样例评审。任务记录列出所需材料，但没有提供评审已经举行、材料已经送达或相关人员已经确认的证据。展示此任务只是为了帮助组织下一步，不据此推断项目是否停滞。\n\n任务说明\n评审前准备一份原始样例、字段对照和待确认问题。样例应能清楚展示回路标识、腔位和导线字段，字段对照需要标明候选解释，问题清单应包含空值、重复标识与跨行文本的处理方式。\n\n准备检查\n选择的样例需要与阅读材料中的方法范围匹配，保留原始截图和文本。若使用知识库中的新映射，先确认它的适用版本，并记录与旧草稿的变化。准备过程中可以把问题整理成一页，供评审时逐项确认。\n\n任务状态解释\n当前同步内容仅说明任务存在及其要求，不说明每一项准备工作的实际完成情况。可以从已关联材料生成一份评审提纲，再由使用者确认是否齐备。任何任务完成、截止日期调整或人员通知，都应由相应操作的实际结果来确认。',
  },
  {
    id: 'photo-dida',
    sourceId: 'dida-work',
    title: '补齐试装记录的版本信息',
    path: '工作清单 / 试装记录 / 补齐版本信息',
    updatedAt: '本周三 14:00',
    quote: '补充车型、支架版本和卡扣编号对应图，再确认是否需要复试。',
    content: '记录范围\n这条示例任务用于说明一次装配记录核对需要哪些输入。它关联的是左前门线束试装材料，目标是补充描述条件，让设计建议与现场观察可以在同一范围内比较。任务文字本身不等同于已经执行的检查结果。\n\n任务要求\n补充车型、支架版本和卡扣编号对应图，再确认是否需要复试。优先找到当时使用的零件清单和现场照片，检查照片中的编号与设计评审稿是否一致。若零件版本不同，应分别记录两套适用条件，再讨论顺序差异。\n\n提问方式\n可以询问现场记录人：本次使用哪一版支架，先固定连接器分支的原因是什么，是否受到工位空间影响。提问应引用对应记录，保留尚未确认的内容，不预先认定设计说明或现场操作存在错误。\n\n后续判断\n只有在车型、版本和编号一致，且差异影响操作要求时，才考虑安排进一步验证。否则，补充适用条件可能已经足以解释两份材料。洞察面板可以准备核对问题或跟进草稿，实际确认结果仍应回到原记录和任务中，保留可追溯的依据。',
  },
];

const LEGACY_INSIGHTS: LegacyInsight[] = [
  {
    id: 'assembly',
    kind: 'attention',
    title: '卡扣装配顺序，先核对适用版本',
    description: '设计稿建议先 1 后 2，现场记录采用先 2 后 1。两份材料可能对应不同支架版本。',
    meaning: '把车型、支架版本和编号对齐，才能判断是否需要补充说明或再做一次试装。',
    uncertainty: '设计稿记录 V2，现场暂记 V3；饰板方案与编号对应关系尚未确认。',
    sourceIds: ['craft-car', 'obsidian-main'],
    evidenceIds: ['assembly-craft', 'assembly-obsidian'],
    actionLabel: '核对原文差异',
    actionType: 'compare',
    period: 'today',
    priority: 1,
    tag: '需要核对',
  },
  {
    id: 'mapping-change',
    kind: 'attention',
    title: '字段映射已更新，旧验证清单可能需要调整',
    description: '新记录要求 Cav 保留字母与前导零；验证准备的 V1 快照仍按纯数字处理，尚未看到同步修订的依据。',
    meaning: '在继续 DXF 样例验证前，先核对候选规则和检查项，避免把字段格式差异误判成提取结果一致。',
    uncertainty: '旧快照不代表当前代码或清单的真实状态；是否已在线下修订，以及新规则适用哪些图纸，仍需确认。',
    sourceIds: ['craft-car', 'obsidian-main'],
    evidenceIds: ['wire-map-v1-craft', 'wire-map-obsidian'],
    actionLabel: '核对版本影响',
    actionType: 'compare',
    period: 'today',
    priority: 2,
    tag: '资料变化',
  },
  {
    id: 'dxf',
    kind: 'knowledge',
    title: '准备 DXF 验证时，这两份材料可以直接复用',
    description: '字段对照草稿与人工核对方法，可以一起用于准备 CIRCUIT NBR、Cav 和 wire 的第一轮验证清单。',
    meaning: '现有资料已能支持一轮有范围、有检查项的验证，结果可以继续沉淀为可复用方法。',
    uncertainty: '字段映射还需要真实样例逐行确认；一份样例通过，不代表所有图纸版本适用。',
    sourceIds: ['craft-car', 'reading'],
    evidenceIds: ['dxf-craft', 'dxf-reading'],
    actionLabel: '生成验证清单',
    actionType: 'checklist',
    period: 'today',
    priority: 2,
    tag: '可以推进',
  },
  {
    id: 'archive',
    kind: 'reading',
    title: '试装复核前，可复用阅读中的检查问题',
    description: '版本信息补齐任务需要明确的复核问题；已有阅读中的布置、固定与检查条件，可以补充这次评审提纲。',
    meaning: '围绕已有试装复核工作准备一份带来源的评审笔记，保留装配空间、固定方式与适用条件的问题，供你决定是否采用。',
    uncertainty: '材料没有完整项目参数，整理后的内容仍需要结合具体车型和规范使用。',
    sourceIds: ['reading', 'dida-work'],
    evidenceIds: ['harness-reading', 'photo-dida'],
    actionLabel: '准备复核笔记',
    actionType: 'archive',
    period: 'today',
    priority: 3,
    tag: '适合沉淀',
  },
  {
    id: 'review-prep',
    kind: 'project',
    title: '线表样例评审，可以先整理一页提纲',
    description: '工作清单需要原始样例、字段对照与问题清单；现有草稿和映射记录可以作为准备入口。',
    meaning: '将准备材料与待确认问题汇总，可以让下一次评审更容易逐项核对。',
    uncertainty: '当前记录没有评审结果，也不能确认材料是否已经齐备，需要你核对实际进展。',
    sourceIds: ['dida-work', 'craft-car', 'obsidian-main'],
    evidenceIds: ['review-dida', 'dxf-craft', 'wire-map-obsidian'],
    actionLabel: '准备评审提纲',
    actionType: 'followup',
    period: 'week',
    priority: 4,
    tag: '准备下一步',
  },
  {
    id: 'version-followup',
    kind: 'attention',
    title: '版本核对问题，可以直接带回试装记录',
    description: '工作清单已列出需要补充的条件，适合整理成一次明确的核对请求。',
    meaning: '先问清车型、支架与编号，再决定是否需要复试，减少没有依据的判断。',
    uncertainty: '还没有看到条件确认的记录，是否已在线下完成核对，需要使用者补充。',
    sourceIds: ['dida-work', 'obsidian-main'],
    evidenceIds: ['photo-dida', 'assembly-obsidian'],
    actionLabel: '整理核对问题',
    actionType: 'followup',
    period: 'week',
    priority: 5,
    tag: '待补充条件',
  },
];

const LEGACY_WATCHES: LegacyWatchItem[] = [
  {
    id: 'watch-dxf',
    title: 'DXF 样例验证',
    description: '关联材料变化后，复查字段映射与验证清单。',
    sourceIds: ['craft-car', 'reading', 'obsidian-main'],
    remaining: 2,
    expires: '11月14日',
    enabled: true,
    relatedInsightId: 'dxf',
  },
  {
    id: 'watch-assembly',
    title: '卡扣装配版本核对',
    description: '待你确认观察范围后，跟进两份记录的变化。',
    sourceIds: ['craft-car', 'obsidian-main'],
    remaining: 3,
    expires: '11月14日',
    enabled: false,
    relatedInsightId: 'assembly',
  },
];

type LegacyInsightContext = {
  category: 'change' | 'difference' | 'reuse';
  relevance: string;
  workId: string;
  workTitle: string;
  ageDays: number;
  detectedAt: string;
  mergedCount: number;
};

// These are example relationships inside the existing Hub workspace.
// Multiple findings can continue the same work; they are not separate agents.
const LEGACY_CONTEXT: Record<string, LegacyInsightContext> = {
  assembly: {
    category: 'difference',
    relevance: '你正在核对左前门线束的试装记录。顺序差异可能影响工艺说明，但要先确认两份资料是否讨论同一车型和零件版本。',
    workId: 'work-assembly-review',
    workTitle: '左前门线束 · 试装记录核对',
    ageDays: 0,
    detectedAt: '2026-11-08 10:18',
    mergedCount: 2,
  },
  'mapping-change': {
    category: 'change',
    relevance: '你准备的 DXF 样例验证仍关联旧映射快照。新记录改变了 Cav 的保留方式，已有验证清单需要核对是否同步调整。',
    workId: 'work-dxf-validation',
    workTitle: 'DXF 线表 · 小样例验证',
    ageDays: 0,
    detectedAt: '2026-11-08 10:45',
    mergedCount: 1,
  },
  dxf: {
    category: 'reuse',
    relevance: '你正在准备 DXF 线表提取的小样例验证。已有字段草稿和人工核对方法，可以直接帮助你确定第一轮检查项。',
    workId: 'work-dxf-validation',
    workTitle: 'DXF 线表 · 小样例验证',
    ageDays: 2,
    detectedAt: '2026-11-06 16:30',
    mergedCount: 2,
  },
  archive: {
    category: 'reuse',
    relevance: '已有“补齐试装记录版本信息”的工作需要准备复核问题。阅读笔记里的装配空间、固定方式与检查条件，可以补充这次复核提纲。',
    workId: 'work-assembly-review',
    workTitle: '左前门线束 · 试装记录核对',
    ageDays: 7,
    detectedAt: '2026-11-01 09:10',
    mergedCount: 1,
  },
  'review-prep': {
    category: 'reuse',
    relevance: '线表样例评审需要原始样例、字段对照与待确认问题，已有材料可以继续用于同一项验证工作。',
    workId: 'work-dxf-validation',
    workTitle: 'DXF 线表 · 小样例验证',
    ageDays: 3,
    detectedAt: '2026-11-05 15:25',
    mergedCount: 1,
  },
  'version-followup': {
    category: 'difference',
    relevance: '试装记录核对仍缺车型、支架与编号条件，已有任务可以帮助整理明确的核对问题。',
    workId: 'work-assembly-review',
    workTitle: '左前门线束 · 试装记录核对',
    ageDays: 4,
    detectedAt: '2026-11-04 14:00',
    mergedCount: 1,
  },
};

const LEGACY_TOPIC_DETAILS: Record<string, { question: string; trigger: string; schedule: string }> = {
  'watch-dxf': {
    question: 'DXF 字段映射与小样例验证的依据有没有变化？',
    trigger: '所选映射笔记改变 Cav、wire 的解释或保存方式，可能影响现有验证清单时提醒。',
    schedule: '应用运行期间，在所选来源发生变化后复查；7 天内最多 3 轮。',
  },
  'watch-assembly': {
    question: '两份装配记录是否已补齐一致的适用条件？',
    trigger: '车型、支架版本或卡扣编号有新的确认记录，足以改变当前判断时提醒。',
    schedule: '启用后在应用运行期间复查已授权资料；7 天内最多 3 轮。',
  },
};

export const MIGRATED_CHECKLIST_STEPS: string[] = [
  '选择一份范围明确的小样例，记录车型、图纸版本与表格样式。',
  '人工标记五条原始记录，并保留行号、截图位置和完整文本。',
  '逐行核对 CIRCUIT NBR、Cav 与 wire 的实际含义和对应关系。',
  '检查字母、前导零、空值、重复标识与跨行文本是否被保留。',
  '分别标注已核对、待解释和提取失败，记录差异及处理依据。',
  '保存适用范围与核对结果，再决定是否扩大到另一份图纸。',
];

export type InsightScopeId = LegacySourceId;
export type MigratedDraftType = "checklist" | "archive" | "task" | "followup";
export type MigratedCitation = { id: string; title: string; source: string; date: string; quote: string };
export type MigratedDiscovery = {
  id: string;
  category: "knowledge" | "life" | "decision";
  kind: string;
  title: string;
  summary: string;
  why: string;
  finding: string;
  condition: string;
  date: string;
  displayDate: string;
  action: string;
  assistant: string;
  evidence: MigratedCitation[];
  workId: string;
  workTitle: string;
  scopeIds: string[];
  draftTypes: MigratedDraftType[];
  detectedAt: string;
  mergedCount: number;
  analysisCategory: "change" | "difference" | "reuse";
};

export type MigratedEvidence = LegacyEvidence & {
  legacyId: string;
  hubSource: HubSourceId;
  libraryId: InsightScopeId;
  libraryName: string;
  date: string;
  dateLabel: string;
  group: HubItem["group"];
};

export type MigratedTopic = {
  id: string;
  title: string;
  description: string;
  question: string;
  trigger: string;
  sourceIds: string[];
  relatedInsightId: string;
  workId: string;
  workTitle: string;
  enabled: boolean;
  remaining: number;
  expiresLabel: string;
  expires: string;
  schedule: string;
  maxRounds: number;
  requiresAppOpen: boolean;
};

/** Old v1 rows were already merged by the source v2 app; do not add duplicate cards. */
export const INSIGHT_ID_ALIASES: Record<string, string> = {
  "review-prep": "dxf",
  "version-followup": "assembly",
};
export function canonicalInsightId(id: string): string {
  return INSIGHT_ID_ALIASES[id] || id;
}

export const MIGRATED_FEED_IDS = ["mapping-change", "assembly", "dxf", "archive"] as const;

const HUB_SOURCE_BY_LIBRARY: Record<InsightScopeId, HubSourceId> = {
  "craft-car": "craft",
  "obsidian-main": "obsidian",
  "dida-work": "ticktick",
  reading: "hub",
};

/** `count` is the number of actually migrated documents, not the old illustrative library total. */
export const OLD_SOURCES = LEGACY_SOURCES.map((source) => ({
  ...source,
  description: source.id === "dida-work" ? "洞察原型中的工作任务摘录与检查项" : source.description,
  originalDemoCount: source.count,
  count: LEGACY_EVIDENCE.filter((evidence) => evidence.sourceId === source.id).length,
  hubSource: HUB_SOURCE_BY_LIBRARY[source.id],
}));

/** Stable, explicit mapping keeps reader links separate from similarly named existing Hub items. */
export const MIGRATED_EVIDENCE_ID_MAP: Record<string, string> = Object.fromEntries(
  LEGACY_EVIDENCE.map((evidence) => [evidence.id, `migrated-${evidence.id}`]),
);
export function migratedDocumentId(id: string): string {
  return MIGRATED_EVIDENCE_ID_MAP[id] || id;
}

const DOCUMENT_DATES: Record<string, { date: string; dateLabel: string; group: HubItem["group"] }> = {
  "assembly-craft": { date: "2026-11-08", dateLabel: "今天", group: "今天" },
  "assembly-obsidian": { date: "2026-11-08", dateLabel: "今天", group: "今天" },
  "dxf-craft": { date: "2026-11-08", dateLabel: "今天", group: "今天" },
  "dxf-reading": { date: "2026-11-07", dateLabel: "昨天", group: "昨天" },
  "harness-reading": { date: "2026-11-07", dateLabel: "昨天", group: "昨天" },
  "wire-map-v1-craft": { date: "2026-11-06", dateLabel: "2 天前", group: "本周" },
  "wire-map-obsidian": { date: "2026-11-08", dateLabel: "今天", group: "今天" },
  "review-dida": { date: "2026-11-07", dateLabel: "昨天", group: "昨天" },
  "photo-dida": { date: "2026-11-04", dateLabel: "4 天前", group: "本周" },
};

export const MIGRATED_EVIDENCE: MigratedEvidence[] = LEGACY_EVIDENCE.map((evidence) => ({
  ...evidence,
  id: migratedDocumentId(evidence.id),
  legacyId: evidence.id,
  hubSource: HUB_SOURCE_BY_LIBRARY[evidence.sourceId],
  libraryId: evidence.sourceId,
  libraryName: LEGACY_SOURCES.find((source) => source.id === evidence.sourceId)!.name,
  ...DOCUMENT_DATES[evidence.id],
}));

export function getMigratedEvidence(id: string): MigratedEvidence | undefined {
  const documentId = migratedDocumentId(id);
  return MIGRATED_EVIDENCE.find((evidence) => evidence.id === documentId);
}

function citation(id: string): MigratedCitation {
  const evidence = getMigratedEvidence(id)!;
  const library = OLD_SOURCES.find((source) => source.id === evidence.libraryId)!;
  return {
    id: evidence.id,
    title: evidence.title,
    source: `${library.id === "reading" ? "Hub" : library.provider} · ${library.name}`,
    date: evidence.updatedAt,
    quote: evidence.quote,
  };
}

const DRAFT_TYPES: Record<string, MigratedDraftType[]> = {
  "mapping-change": ["checklist", "task"],
  assembly: ["checklist", "task"],
  dxf: ["checklist", "followup", "task"],
  archive: ["archive", "checklist", "task"],
};

export const MIGRATED_DISCOVERIES: MigratedDiscovery[] = MIGRATED_FEED_IDS.map((id) => {
  const legacy = LEGACY_INSIGHTS.find((insight) => insight.id === id)!;
  const context = LEGACY_CONTEXT[id];
  return {
    id,
    category: "knowledge",
    kind: context.category === "change" ? "资料变化" : context.category === "difference" ? "需要核对" : "知识可复用",
    title: legacy.title,
    summary: legacy.description,
    why: context.relevance,
    finding: legacy.meaning,
    condition: legacy.uncertainty,
    date: context.detectedAt.slice(0, 10),
    displayDate: context.ageDays === 0 ? `今天 · ${context.detectedAt.slice(11)}` : `${context.detectedAt.slice(5, 7)}月${context.detectedAt.slice(8, 10)}日 · ${context.detectedAt.slice(11)}`,
    action: legacy.actionLabel,
    assistant: `继续“${context.workTitle}”这项工作，围绕“${legacy.title}”核对已有依据。${legacy.description}\n\n可以接着做：${legacy.meaning}\n尚待确认：${legacy.uncertainty}\n保留原文来源和适用范围，先准备可审阅草稿，由我确认后再决定如何采用。`,
    evidence: legacy.evidenceIds.map(citation),
    workId: context.workId,
    workTitle: context.workTitle,
    scopeIds: [...legacy.sourceIds],
    draftTypes: DRAFT_TYPES[id],
    detectedAt: context.detectedAt,
    mergedCount: context.mergedCount,
    analysisCategory: context.category,
  };
});

/** Follow-up work formerly shown as extra cards remains available as history/related-work context. */
export const MIGRATED_ALIAS_CONTEXT = LEGACY_INSIGHTS.filter((insight) => insight.id in INSIGHT_ID_ALIASES).map((insight) => ({
  legacyId: insight.id,
  canonicalId: canonicalInsightId(insight.id),
  title: insight.title,
  summary: insight.description,
  finding: insight.meaning,
  condition: insight.uncertainty,
  workId: LEGACY_CONTEXT[insight.id].workId,
  workTitle: LEGACY_CONTEXT[insight.id].workTitle,
  evidence: insight.evidenceIds.map(citation),
}));

export const MIGRATED_TOPICS: MigratedTopic[] = LEGACY_WATCHES.map((watch) => ({
  id: watch.id,
  title: watch.title,
  description: watch.description,
  ...LEGACY_TOPIC_DETAILS[watch.id],
  sourceIds: [...watch.sourceIds],
  relatedInsightId: canonicalInsightId(watch.relatedInsightId),
  workId: LEGACY_CONTEXT[watch.relatedInsightId].workId,
  workTitle: LEGACY_CONTEXT[watch.relatedInsightId].workTitle,
  enabled: watch.enabled,
  remaining: watch.remaining,
  // The source v2 UI uses Nov 15; the unused v1 fixture label still said Nov 14.
  expiresLabel: "11月15日",
  expires: "2026-11-15",
  maxRounds: 3,
  requiresAppOpen: true,
}));

export const SOURCE_SIMULATION_NOTE = "模拟版本已更新；相关发现现在待复核。此附注只演示版本变化后的处理流程，原文与引用摘录未重写，不能视为新的工程确认结果。";

export const SOURCE_VERSION_EXCERPTS: Record<string, { before: string; after: string; simulationNote: string }> = Object.fromEntries(
  MIGRATED_EVIDENCE.map((evidence) => [evidence.id, {
    before: evidence.quote,
    after: evidence.quote,
    simulationNote: SOURCE_SIMULATION_NOTE,
  }]),
);

export type SourceComparison = {
  before: { label: string; evidenceId: string; text: string };
  after: { label: string; evidenceId: string; text: string };
};

function comparisonSide(label: string, legacyId: string): SourceComparison["before"] {
  const evidence = getMigratedEvidence(legacyId)!;
  return { label, evidenceId: evidence.id, text: evidence.quote };
}

/** Each comparison names its own document; it does not claim two snapshots of one confirmed fact. */
export const SOURCE_COMPARISONS: Record<string, SourceComparison[]> = {
  "mapping-change": [{
    before: comparisonSide("旧映射快照 · V1", "wire-map-v1-craft"),
    after: comparisonSide("新映射 · 样例核对记录", "wire-map-obsidian"),
  }],
  assembly: [{
    before: comparisonSide("设计评审稿 · 支架 V2", "assembly-craft"),
    after: comparisonSide("现场记录 · 支架暂记 V3", "assembly-obsidian"),
  }],
};

/** Keep exact source prose and heading boundaries so every displayed citation is findable in the Hub reader. */
function documentSections(content: string): Section[] {
  return content.split(/\n\s*\n/).flatMap((block): Section[] => {
    const [heading, ...paragraphs] = block.split("\n");
    return [
      { type: "h2", text: heading },
      ...paragraphs.filter(Boolean).map((text): Section => ({ type: "p", text })),
    ];
  });
}

export const MIGRATED_HUB_ITEMS: HubItem[] = MIGRATED_EVIDENCE.map((evidence) => ({
  id: evidence.id,
  title: evidence.title,
  // The old task extracts state requirements, not completion; retain them as source notes.
  kind: evidence.libraryId === "reading" ? "reading" : "note",
  source: evidence.hubSource,
  space: evidence.path,
  group: evidence.group,
  date: evidence.date,
  dateLabel: evidence.dateLabel,
  tags: ["线束", "洞察依据", ...(evidence.libraryId === "dida-work" ? ["任务摘录", "状态待确认"] : []), ...(evidence.libraryId === "reading" ? ["阅读"] : [])],
  excerpt: evidence.quote,
  sections: [
    { type: "callout", text: `洞察原型中的示例资料。原资料库：${evidence.libraryName}；原路径：${evidence.path}；示例记录时间：${evidence.updatedAt}（以 2026 年 11 月 8 日为基准）。` },
    ...documentSections(evidence.content),
  ],
  ...(evidence.libraryId === "reading" ? { readState: "inbox" as const } : {}),
}));
