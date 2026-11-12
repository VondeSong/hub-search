import type { HubItem } from "./data";
import { getMigratedEvidence } from "./insight-migration";

/**
 * Fixed deliveries for the Issue #2 R2 interaction prototype: synthetic workflow
 * examples and explicitly marked, curated public-document cases. These are not
 * fetched Agent results or connected-account data. A delivery remains immutable;
 * its finding pointer is meaningful only inside it.
 */
export type ReportEvidence = {
  sourceId: string;
  sourceItemId?: string;
  title: string;
  provider: string;
  version: number;
  quote: string;
  location: string;
  origin: "record" | "user";
  relationship: "independent" | "retelling" | "user-correction";
  eventAt?: string;
  recordedAt?: string;
  modifiedAt?: string;
  observedAt?: string;
  citationValid?: boolean;
  sourceFingerprint?: string;
  /** Public sources are locally curated summaries, never verbatim page captures. */
  externalUrl?: string;
  publisher?: string;
  checkedAt?: string;
  excerptKind?: "summary";
};

export type ReportFinding = {
  pointer: string;
  title: string;
  summary: string;
  why: string;
  condition: string;
  category: "knowledge" | "life" | "decision";
  evidence: ReportEvidence[];
  requiresFeedback?: string;
  changeSummary?: string;
  resolvesFeedback?: boolean;
  caseStudy?: {
    scenario: string;
    learning: string;
    actionTitle: string;
    actionSteps: string[];
  };
};

export type ReportFixture = {
  id: string;
  workId: string;
  workTitle: string;
  title: string;
  publishedAt: string;
  coverageAsOf: string;
  observedAt: string;
  kind: "structured" | "native";
  status: "published" | "insufficientEvidence" | "unavailable";
  deliveryHash: string;
  findings: ReportFinding[];
  group: "normal" | "revision" | "boundary";
  summary: string;
  emptyReason?: string;
};

export type SourceVersionFixture = {
  version: number;
  content: string;
  modifiedAt?: string;
  fingerprint: string;
};

export type ReportSourceFixture = {
  id: string;
  title: string;
  provider: string;
  sourceItemId?: string;
  kind: "document" | "feedback";
  version: number;
  available: boolean;
  versions: SourceVersionFixture[];
  location: string;
  eventAt?: string;
  recordedAt?: string;
  observedAt?: string;
  externalUrl?: string;
  publisher?: string;
  checkedAt?: string;
  excerptKind?: "summary";
};

export const INSIGHT_PLAN_VERSION = "INS-PLAN-20261108-R2";
export const INSIGHT_SAMPLE_VERSION = "INS-SAMPLE-v1";
export const SAMPLE_WORK_A = "sample-work-a";
export const SAMPLE_WORK_B = "sample-work-b";
export const SAMPLE_METHOD_SOURCE_ID = "sample-method-d1";
export const SAMPLE_REVIEW_SOURCE_ID = "sample-review-d2";
export const SAMPLE_FEEDBACK_SOURCE_ID = "sample-feedback-u1";
export const SAMPLE_U1 = "这里的‘完成’仅指纸面原型，尚未完成实机验证。";

const D1_V1 = "样本编号为蓝湾-731。验证前先固定输入、预期结果和通过条件。";
const D1_V2 = "样本编号为蓝湾-731。验证前先固定输入、预期结果、通过条件和适用版本。";
const D2_V1 = "本周已完成原型验证；采用先小样本、再扩大范围的方法。";
const OBSERVED_AT = "2026-11-08T01:00:00Z";

/** A separate, additive pack for trying the discovery/status UI without empty tabs. */
export const INTERACTION_DEMO_VERSION = "interaction-demo-20261108-v1";
export const INTERACTION_WEEKLY_FEEDBACK = "示例补充：这是备用方案，工作日晚间不一定有固定的 30 分钟，先按有空时阅读。";
export const INTERACTION_MEETING_SOURCE_ID = "demo-trip-meeting";
export const PUBLIC_CASE_VERSION = "public-cases-20261108-v1";
export const PUBLIC_CASE_CHECKED_AT = "2026-11-08T07:55:21Z";

type InteractionDocument = {
  id: string;
  title: string;
  kind: HubItem["kind"];
  space: string;
  tags: string[];
  content: string;
  recordedAt: string;
  eventAt?: string;
  feedback?: boolean;
  followUp: string;
  nextVersion?: { content: string; modifiedAt: string; change: string };
};

// These are invented example records, never imported personal/account activity.
const INTERACTION_DOCUMENTS: InteractionDocument[] = [
  {
    id: "demo-reading-method", title: "清晰表达 · 阅读摘录", kind: "reading",
    space: "Hub / 互动示例 / 阅读与应用", tags: ["阅读", "表达", "示例"],
    recordedAt: "2026-11-03T12:00:00Z",
    content: "先写读者需要知道的结论，再给出证据与下一步。每条可复用笔记都要保留原文链接，并写一个自己的应用例子。",
    followUp: "这是为交互原型编写的方法摘录，未引用真实图书。可以将它与练习日志并排核对，再准备一份周报结构草稿。",
  },
  {
    id: "demo-reading-practice", title: "阅读应用 · 两次练习与下一步", kind: "journal",
    space: "Hub / 互动示例 / 阅读与应用", tags: ["阅读", "练习", "周报", "示例"],
    eventAt: "2026-11-06", recordedAt: "2026-11-07T00:20:00Z",
    content: "11 月 4 日和 6 日的两次练习均保留了原文链接与自己的应用例子。下一份周报需要说明已经完成的检查、仍不确定的事项和下一步安排。",
    followUp: "两次练习是预置的示例记录；只能说明这两次练习保留了什么，不能据此判断已经养成习惯或掌握方法。周报仍是待准备的计划。",
  },
  {
    id: "demo-weekly-plan", title: "下周安排 · 三件事与机动时间", kind: "note",
    space: "Hub / 互动示例 / 一周安排", tags: ["计划", "生活", "阅读", "示例"],
    recordedAt: "2026-11-07T12:00:00Z",
    content: "下周一到周五只排了三个必须完成的事项，周三晚间预留为机动时间。阅读先暂按每天晚上 30 分钟安排，周日再核对执行情况。",
    followUp: "这是未来一周的计划草稿，不是已经发生的时间记录。可以调整计划，也可以先保留空档；面板不会将未执行的计划解释成拖延。",
  },
  {
    id: "demo-weekly-review", title: "一周回看 · 临时事项的影响", kind: "journal",
    space: "Hub / 互动示例 / 一周安排", tags: ["生活", "复盘", "示例"],
    eventAt: "2026-11-05", recordedAt: "2026-11-06T01:10:00Z",
    content: "上周临时增加的一次资料核对占用了原定阅读时间。当晚只补记了三个问题，阅读留到周末继续。",
    followUp: "这是一条具体经历的示例自述，没有完整时长，也不代表整周都发生了同样的情况。保留问题清单，是之后继续阅读的入口。",
  },
  {
    id: "demo-weekly-feedback", title: "一周安排 · 预置的用户补充", kind: "note",
    space: "Hub / 互动示例 / 一周安排", tags: ["计划", "用户补充", "示例"],
    recordedAt: "2026-11-08T03:05:00Z", feedback: true,
    content: INTERACTION_WEEKLY_FEEDBACK,
    followUp: "这段话是为测试纠正流程预先填入的示例补充，不是你已经输入的个人意见。它与原计划分别保存；采用后续成果时仍需明确确认已处理这条反馈。",
  },
  {
    id: "demo-trip-plan", title: "周末出行 · 路线与雨天备选", kind: "note",
    space: "Hub / 互动示例 / 周末出行", tags: ["出行", "生活", "示例"],
    recordedAt: "2026-11-06T11:00:00Z",
    content: "晴天路线是河边步行；如出发前确认有雨，改去城市展览馆。展览馆开放时间、预约要求和交通方式尚未核实。",
    followUp: "地点和行程均为虚构的交互示例，不提供真实开放时间或天气。准备行程时可以先保留两个方案，再核实各自的条件。",
  },
  {
    id: INTERACTION_MEETING_SOURCE_ID, title: "周末出行 · 集合信息", kind: "note",
    space: "Hub / 互动示例 / 周末出行", tags: ["出行", "决定", "示例"],
    recordedAt: "2026-11-06T12:00:00Z",
    content: "周六上午 09:00 在南门集合，预计半天结束。路线仍按出发前确认的天气选择。",
    followUp: "这是行程计划，不代表出行已经发生。此示例会演示集合信息更新后，一条已处理发现仍需要复核。",
    nextVersion: {
      content: "周六上午 09:30 在东门集合，预计半天结束。路线仍按出发前确认的天气选择。",
      modifiedAt: "2026-11-08T03:20:00Z",
      change: "集合时间从 09:00 改为 09:30，地点从南门改为东门；行程时长与按天气选择路线的条件没有变化。",
    },
  },
  {
    id: "demo-tool-decision", title: "资料整理工具 · 购买前的判断条件", kind: "note",
    space: "Hub / 互动示例 / 工具选择", tags: ["工具", "决定", "示例"],
    recordedAt: "2026-11-04T12:00:00Z",
    content: "这次只在现有工具无法完成批量整理、引用追溯和本地导出时考虑购买新工具。先不购买新工具，用现有工具完成 20 条资料的小样例，再决定是否继续。",
    followUp: "这是虚构事项中的选择标准，未比较任何真实产品、价格或订阅。后续结果应与当时写下的条件比较，不倒推决策理由。",
  },
  {
    id: "demo-tool-trial", title: "资料整理工具 · 小样例试用记录", kind: "journal",
    space: "Hub / 互动示例 / 工具选择", tags: ["工具", "试用", "复盘", "示例"],
    eventAt: "2026-11-07", recordedAt: "2026-11-07T12:30:00Z",
    content: "试用目前完成了批量整理，引用追溯与本地导出还没有验证。20 条小样例已完成整理，原文链接均保留；尚未检验大批量速度。",
    followUp: "保留原文链接不等于已经验证完整引用追溯功能。小样例结果只覆盖已记录的 20 条资料，不能推断大批量性能或购买结论。",
  },
];

type PublicCaseDocument = {
  id: string;
  title: string;
  publisher: string;
  externalUrl: string;
  location: string;
  content: string;
  tags: string[];
  publishedOn?: string;
};

/**
 * Factual, original Chinese summaries of the linked official pages, checked on
 * the date above. The application scenarios below are our illustrations, not
 * reports of activity in the user's accounts. The source snapshot version is a
 * local summary revision and must not be mistaken for the product's version.
 */
const PUBLIC_CASE_DOCUMENTS: PublicCaseDocument[] = [
  {
    id: "public-ezdxf-insert", title: "ezdxf · INSERT 与块属性", publisher: "ezdxf 官方文档",
    externalUrl: "https://ezdxf.readthedocs.io/en/stable/blocks/insert.html", location: "INSERT / attribs · 中文摘要",
    content: "INSERT 表示块引用，可以附带 ATTRIB 属性；这些属性可由 attribs 列表读取。INSERT 还保留插入位置、旋转与缩放参数。",
    tags: ["DXF", "块属性", "线表"],
  },
  {
    id: "public-ezdxf-mtext", title: "ezdxf · MTEXT 文字提取", publisher: "ezdxf 官方文档",
    externalUrl: "https://ezdxf.readthedocs.io/en/stable/dxfentities/mtext.html", location: "MTEXT / plain_text · 中文摘要",
    content: "MTEXT 保存多行文字和内联格式；plain_text() 可返回去除内联格式代码的文本。读取多列文字时，还可使用 all_columns_plain_text() 取得各列内容。",
    tags: ["DXF", "多行文字", "提取"],
  },
  {
    id: "public-notion-linked", title: "Notion · 关联数据库视图", publisher: "Notion 官方帮助",
    externalUrl: "https://www.notion.com/help/guides/using-linked-databases", location: "Using linked databases · 中文摘要",
    content: "关联数据库可在不同页面显示同一数据库的内容。编辑其中的数据会同步到源数据库；筛选和视图设置只作用于当前关联视图。",
    tags: ["Notion", "资料组织", "视图"],
  },
  {
    id: "public-github-autoadd", title: "GitHub · 自动添加项目条目", publisher: "GitHub 官方文档",
    externalUrl: "https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/adding-items-automatically", location: "About automatically adding items · 中文摘要",
    content: "启用自动添加工作流时，已经存在且符合条件的条目不会立即补入项目。之后创建或更新的条目，在满足筛选条件时才会由该工作流添加。",
    tags: ["GitHub", "项目管理", "自动化"],
  },
  {
    id: "public-obsidian-backlinks", title: "Obsidian · 链接与未链接提及", publisher: "Obsidian 官方帮助",
    externalUrl: "https://obsidian.md/help/plugins/backlinks", location: "Show backlinks · 中文摘要",
    content: "Backlinks 区分已链接提及与未链接提及：前者来自包含内部链接的笔记，后者来自只出现当前笔记名称、尚未建立链接的位置。可以展开包含提及的段落来查看上下文。",
    tags: ["Obsidian", "阅读", "关联"],
  },
  {
    id: "public-craft-tasks", title: "Craft · 文档中的任务与集中视图", publisher: "Craft 官方博客",
    externalUrl: "https://www.craft.do/blog/introducing-tasks", location: "Stay Organized with Task View · 中文摘要", publishedOn: "2024-11-28",
    content: "Craft 的 Tasks 视图可从侧栏进入，汇总收件箱、置顶文档和包含任务的笔记。任务仍与文档相连，并可在文档之间移动。",
    tags: ["Craft", "任务", "回顾"],
  },
];

/** Stable synthetic fingerprint. This is a demo integrity check, not an access token. */
function fixtureFingerprint(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `demo-fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function version(versionNumber: number, content: string, modifiedAt?: string): SourceVersionFixture {
  return { version: versionNumber, content, modifiedAt, fingerprint: fixtureFingerprint(content) };
}

function migratedSource(id: string, location: string, modifiedAt: string): ReportSourceFixture {
  const source = getMigratedEvidence(id);
  if (!source) throw new Error(`Missing fixed prototype source: ${id}`);
  return {
    id: source.id,
    sourceItemId: source.id,
    title: source.title,
    provider: source.libraryId === "reading" ? "Hub · 阅读" : source.hubSource === "craft" ? "Craft" : "Obsidian",
    kind: "document",
    version: 1,
    available: true,
    location,
    observedAt: "2026-11-08T02:20:00Z",
    versions: [version(1, source.content, modifiedAt)],
  };
}

export const INTERACTION_SOURCE_FIXTURES: ReportSourceFixture[] = INTERACTION_DOCUMENTS.map(document => ({
  id: document.id,
  title: document.title,
  provider: document.feedback ? "Hub · 示例用户补充" : document.kind === "reading" ? "Hub · 阅读摘录" : document.kind === "journal" ? "Hub · 示例日志" : "Hub · 示例笔记",
  sourceItemId: document.id,
  kind: document.feedback ? "feedback" : "document",
  version: 1,
  available: true,
  location: "示例正文",
  eventAt: document.eventAt,
  recordedAt: document.feedback ? undefined : document.recordedAt,
  observedAt: document.feedback ? undefined : "2026-11-08T02:55:00Z",
  versions: [
    version(1, document.content, document.feedback ? undefined : document.recordedAt),
    ...(document.nextVersion ? [version(2, document.nextVersion.content, document.nextVersion.modifiedAt)] : []),
  ],
}));

export const PUBLIC_CASE_SOURCE_FIXTURES: ReportSourceFixture[] = PUBLIC_CASE_DOCUMENTS.map(document => ({
  id: document.id, sourceItemId: document.id, title: document.title, provider: document.publisher,
  kind: "document", version: 1, available: true, location: document.location,
  observedAt: PUBLIC_CASE_CHECKED_AT, checkedAt: PUBLIC_CASE_CHECKED_AT,
  externalUrl: document.externalUrl, publisher: document.publisher, excerptKind: "summary",
  versions: [version(1, document.content)],
}));

export const SOURCE_FIXTURES: ReportSourceFixture[] = [
  {
    id: SAMPLE_METHOD_SOURCE_ID,
    sourceItemId: SAMPLE_METHOD_SOURCE_ID,
    title: "验证方法",
    provider: "Hub · 方法笔记",
    kind: "document",
    version: 1,
    available: true,
    location: "正文 · 第 2 句",
    eventAt: "2026-10-28",
    recordedAt: "2026-10-28T04:00:00Z",
    observedAt: OBSERVED_AT,
    versions: [
      version(1, D1_V1, "2026-10-28T04:00:00Z"),
      version(2, D1_V2, "2026-11-08T02:40:00Z"),
    ],
  },
  {
    id: SAMPLE_REVIEW_SOURCE_ID,
    sourceItemId: SAMPLE_REVIEW_SOURCE_ID,
    title: "项目复盘",
    provider: "Hub · 生活与工作日志",
    kind: "document",
    version: 1,
    available: true,
    location: "正文 · 第 1 分句",
    eventAt: "2026-11-01",
    recordedAt: "2026-11-02T01:30:00Z",
    observedAt: OBSERVED_AT,
    versions: [version(1, D2_V1, "2026-11-02T01:30:00Z")],
  },
  {
    id: SAMPLE_FEEDBACK_SOURCE_ID,
    title: "本工作中的用户补充",
    provider: "Hub · 用户反馈",
    kind: "feedback",
    version: 1,
    available: true,
    location: "当前工作的事实纠正 · U1",
    versions: [version(1, SAMPLE_U1)],
    // The real local feedback event supplies its time. Do not invent a life event
    // time or present this fixed candidate as a correction the user already made.
  },
  migratedSource("dxf-craft", "验证入口 · 第 1 句", "2026-11-08T00:45:00Z"),
  migratedSource("dxf-reading", "核心方法 · 第 1 句", "2026-11-07T10:30:00Z"),
  migratedSource("assembly-craft", "装配建议 · 第 1 句", "2026-11-08T01:20:00Z"),
  migratedSource("assembly-obsidian", "实际观察 · 第 1 句", "2026-11-08T02:05:00Z"),
  {
    id: "sample-unreadable-source",
    title: "未获授权的示例来源",
    provider: "Hub · 访问边界示例",
    kind: "document",
    version: 1,
    available: false,
    location: "不可读取",
    versions: [],
  },
  ...INTERACTION_SOURCE_FIXTURES,
  ...PUBLIC_CASE_SOURCE_FIXTURES,
];

export function getSourceVersion(sourceId: string, versionNumber: number): SourceVersionFixture | undefined {
  return SOURCE_FIXTURES.find((source) => source.id === sourceId)?.versions.find((entry) => entry.version === versionNumber);
}

function citation(
  sourceId: string,
  versionNumber: number,
  quote: string,
  relationship: ReportEvidence["relationship"] = "independent",
): ReportEvidence {
  const source = SOURCE_FIXTURES.find((entry) => entry.id === sourceId);
  if (!source) throw new Error(`Missing fixed report source: ${sourceId}`);
  const sourceVersion = getSourceVersion(sourceId, versionNumber);
  return {
    sourceId,
    sourceItemId: source.sourceItemId,
    title: source.title,
    provider: source.provider,
    version: versionNumber,
    quote,
    location: source.location,
    origin: source.kind === "feedback" ? "user" : "record",
    relationship,
    eventAt: source.eventAt,
    recordedAt: source.recordedAt,
    modifiedAt: sourceVersion?.modifiedAt,
    observedAt: source.observedAt,
    citationValid: Boolean(source.available && sourceVersion?.content.includes(quote)),
    sourceFingerprint: sourceVersion?.fingerprint,
    ...(source.externalUrl ? {
      externalUrl: source.externalUrl, publisher: source.publisher,
      checkedAt: source.checkedAt, excerptKind: source.excerptKind,
    } : {}),
  };
}

/** Static citation validation; the ledger also checks current source access/version. */
export function getEvidenceIssue(evidence: ReportEvidence): string | undefined {
  const source = SOURCE_FIXTURES.find((entry) => entry.id === evidence.sourceId);
  if (!source) return "找不到引用的原对象，暂不能保存这条发现。";
  if (!source.available) return "该引用来源当前不可读取，暂不能保存这条发现。";
  const sourceVersion = getSourceVersion(evidence.sourceId, evidence.version);
  if (!sourceVersion) return "找不到引用所绑定的来源版本。";
  if (evidence.sourceFingerprint && evidence.sourceFingerprint !== sourceVersion.fingerprint) {
    return "引用版本的内容校验值不一致，需先回原工作核对。";
  }
  if (evidence.sourceItemId !== source.sourceItemId) {
    return "引用与原对象的定位不一致，暂不能保存这条发现。";
  }
  if ((source.externalUrl || evidence.externalUrl || evidence.publisher || evidence.checkedAt || evidence.excerptKind) && (evidence.externalUrl !== source.externalUrl || evidence.publisher !== source.publisher || evidence.checkedAt !== source.checkedAt || evidence.excerptKind !== source.excerptKind)) {
    return "公开资料的出处或摘要标识不完整，需先核对官方来源。";
  }
  if (evidence.citationValid === false || !evidence.quote.trim() || !sourceVersion.content.includes(evidence.quote)) {
    return "引文与绑定版本的原文不符，需先回原工作核对。";
  }
  return undefined;
}

const methodV1 = citation(SAMPLE_METHOD_SOURCE_ID, 1, "验证前先固定输入、预期结果和通过条件。");
const progressV1 = citation(SAMPLE_REVIEW_SOURCE_ID, 1, "本周已完成原型验证");
const userCorrection = citation(SAMPLE_FEEDBACK_SOURCE_ID, 1, SAMPLE_U1, "user-correction");
const methodV2 = citation(SAMPLE_METHOD_SOURCE_ID, 2, "验证前先固定输入、预期结果、通过条件和适用版本。");

const methodFinding: ReportFinding = {
  pointer: "/report/findings/0",
  title: "验证前需要固定输入、预期结果和通过条件。",
  summary: "方法笔记给出了开始验证前需要说清的三项内容。",
  why: "继续原型验证时，这三项能让每一轮的观察有明确的比较依据。",
  condition: "这是一条方法建议，不代表已经执行验证或达到通过条件；适用对象仍需在原工作确认。",
  category: "knowledge",
  evidence: [methodV1],
};

const progressFinding: ReportFinding = {
  pointer: "/report/findings/1",
  title: "本周已完成原型验证。",
  summary: "11 月 1 日的复盘记下了一次原型验证进展，完成范围尚未注明。",
  why: "安排下一轮时，可以先保留这次进展，再确认“完成”具体覆盖了什么。",
  condition: "原文是当时的自述，没有区分纸面原型和实机验证，也没有提供业务验收回执。",
  category: "life",
  evidence: [progressV1],
};

export function computeReportHash(input: Omit<ReportFixture, "deliveryHash"> | ReportFixture): string {
  // Field order in a supplied object must not change the identity of its content.
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]));
    }
    return value;
  }
  const { deliveryHash: _ignored, ...payload } = input as ReportFixture;
  return fixtureFingerprint(JSON.stringify(canonical(payload)));
}

function report(input: Omit<ReportFixture, "deliveryHash">): ReportFixture {
  return { ...input, deliveryHash: computeReportHash(input) };
}

const workA = {
  workId: SAMPLE_WORK_A,
  workTitle: "原型验证 · 方法与进展",
  kind: "structured" as const,
  status: "published" as const,
  coverageAsOf: "2026-11-08T01:00:00Z",
  observedAt: OBSERVED_AT,
};

const readingPractice: ReportFinding[] = [
  {
    pointer: "/report/findings/0",
    title: "这份阅读摘录，可以直接用在下一次周报里",
    summary: "“结论、证据、下一步”的表达顺序，与周报草稿要回答的三个问题正好对应。",
    why: "下一份周报仍待准备，可以先沿用已有阅读方法，少从空白页面重新组织一次。",
    condition: "这是对两个示例记录的应用建议，尚未生成或提交周报；需要再核对本次汇报对象与具体内容。",
    category: "knowledge",
    evidence: [
      citation("demo-reading-method", 1, "先写读者需要知道的结论，再给出证据与下一步。", "retelling"),
      citation("demo-reading-practice", 1, "下一份周报需要说明已经完成的检查、仍不确定的事项和下一步安排。"),
    ],
  },
  {
    pointer: "/report/findings/1",
    title: "两次小练习都保留了原文，复用时更容易核对",
    summary: "练习日志明确记下了两次原文链接和应用例子的保留情况，可以把这个做法继续用下去。",
    why: "下次从笔记准备材料时，原文与自己的理解可以分开查看，减少只记住一句结论的情况。",
    condition: "只覆盖 11 月 4 日、6 日这两次练习；不据此推断长期习惯、学习时长或掌握程度。",
    category: "knowledge",
    evidence: [
      citation("demo-reading-practice", 1, "11 月 4 日和 6 日的两次练习均保留了原文链接与自己的应用例子。"),
      citation("demo-reading-method", 1, "每条可复用笔记都要保留原文链接，并写一个自己的应用例子。", "retelling"),
    ],
  },
];

const weeklyPlanning: ReportFinding[] = [
  {
    pointer: "/report/findings/0",
    title: "下周的计划留有一个空档，可以先保留",
    summary: "计划为周三晚间留了机动时间，上周也有一次临时核对占用阅读时间的具体记录。",
    why: "安排下一周时，可以把这个空档留给变化中的事项，再决定是否补入新的计划。",
    condition: "这里只对照一份计划和一次经历；没有完整时间统计，不判断整个星期的投入或效率。",
    category: "life",
    evidence: [
      citation("demo-weekly-plan", 1, "下周一到周五只排了三个必须完成的事项，周三晚间预留为机动时间。"),
      citation("demo-weekly-review", 1, "上周临时增加的一次资料核对占用了原定阅读时间。"),
    ],
  },
  {
    pointer: "/report/findings/1",
    title: "每晚阅读 30 分钟，先核对它是否适合下周",
    summary: "计划暂写了固定的晚间阅读时段；它仍是待核对的安排，不能当成已经执行的记录。",
    why: "如果工作日晚间没有稳定空档，这项安排需要按可用时间调整，再决定怎样回看。",
    condition: "未知实际空闲时间，也没有阅读完成记录；不能把计划未执行解释为拖延或缺乏自律。",
    category: "life",
    evidence: [citation("demo-weekly-plan", 1, "阅读先暂按每天晚上 30 分钟安排，周日再核对执行情况。")],
  },
];

const tripPlanning: ReportFinding[] = [
  {
    pointer: "/report/findings/0",
    title: "雨天备选已经写好，出发前再核对开放条件",
    summary: "计划同时保留了步行与室内备选路线，展览馆的开放时间和预约要求仍未核实。",
    why: "可以先保留两个方案，把开放条件和当天安排留到出发前再确认，不必现在就确定其中一个。",
    condition: "路线和地点均为虚构示例；未读取真实天气、营业时间、预约信息或交通状态。",
    category: "life",
    evidence: [citation("demo-trip-plan", 1, "晴天路线是河边步行；如出发前确认有雨，改去城市展览馆。展览馆开放时间、预约要求和交通方式尚未核实。")],
  },
  {
    pointer: "/report/findings/1",
    title: "原定的集合时间已记下，出发前还要留意更新",
    summary: "原计划明确写了 09:00 南门集合、预计半天结束；路线仍要按出发前确认的天气选择。",
    why: "回看已经处理的安排时，需要确认它引用的仍是当前集合信息。",
    condition: "这是一项尚未发生的出行安排，没有实际出发记录；计划变动后还需要确认最终约定。",
    category: "decision",
    evidence: [citation(INTERACTION_MEETING_SOURCE_ID, 1, "周六上午 09:00 在南门集合，预计半天结束。")],
  },
];

const toolDecision: ReportFinding[] = [
  {
    pointer: "/report/findings/0",
    title: "购买决定可以等试用结束，再对照三项条件",
    summary: "当时的决定列了批量整理、引用追溯和本地导出三项条件，目前只完成了第一项验证。",
    why: "下一步可以先补齐剩下的验证，再按照原先写下的标准作选择。",
    condition: "这是虚构工具选择的记录对照，未比较真实产品或价格；保留链接不等于完整引用追溯已经验证。",
    category: "decision",
    evidence: [
      citation("demo-tool-decision", 1, "这次只在现有工具无法完成批量整理、引用追溯和本地导出时考虑购买新工具。"),
      citation("demo-tool-trial", 1, "试用目前完成了批量整理，引用追溯与本地导出还没有验证。"),
    ],
  },
  {
    pointer: "/report/findings/1",
    title: "先用现有工具做小样例，这个决定已有一次结果",
    summary: "20 条资料的小样例已经整理并保留原文链接，符合当时先试一次再决定的做法。",
    why: "可以先记住这次有用的验证步骤；遇到类似工具选择时，再带着适用条件复用。",
    condition: "只覆盖这 20 条示例资料；大批量性能、完整引用追溯和导出尚未验证，不自动推导购买结论。",
    category: "decision",
    evidence: [
      citation("demo-tool-decision", 1, "先不购买新工具，用现有工具完成 20 条资料的小样例，再决定是否继续。"),
      citation("demo-tool-trial", 1, "20 条小样例已完成整理，原文链接均保留；尚未检验大批量速度。"),
    ],
  },
];

const interactionReportBase = {
  kind: "structured" as const, status: "published" as const, group: "normal" as const,
  coverageAsOf: "2026-11-08T02:55:00Z", observedAt: "2026-11-08T02:55:00Z",
};

export const INTERACTION_REPORT_FIXTURES: ReportFixture[] = [
  report({ ...interactionReportBase, id: "demo-report-reading", workId: "demo-work-reading", workTitle: "阅读与应用 · 清晰表达", title: "从阅读摘录到下一次周报", publishedAt: "2026-11-08T03:00:00Z", summary: "预置互动示例：把阅读方法、两次练习与下一份周报的计划放在一起，保留可复用的依据。", findings: readingPractice }),
  report({ ...interactionReportBase, id: "demo-report-weekly", workId: "demo-work-weekly", workTitle: "一周安排 · 留白与推进", title: "下周计划与已有经历的对照", publishedAt: "2026-11-08T03:01:00Z", summary: "预置互动示例：比较一份未来计划和一次具体经历。计划、实际记录和用户补充分别表达。", findings: weeklyPlanning }),
  report({ ...interactionReportBase, id: "demo-report-trip", workId: "demo-work-trip", workTitle: "周末出行 · 路线与备选", title: "出行安排与需要确认的条件", publishedAt: "2026-11-08T03:02:00Z", summary: "预置互动示例：保留雨天备选与原定集合信息，供稍后和来源更新流程使用。", findings: tripPlanning }),
  report({ ...interactionReportBase, id: "demo-report-tools", workId: "demo-work-tools", workTitle: "工具选择 · 先验证再购买", title: "购买条件与小样例结果的对照", publishedAt: "2026-11-08T03:03:00Z", summary: "预置互动示例：对照当时记录的选择标准与一次小样例结果，区分已有进展和仍需验证的条件。", findings: toolDecision }),
  report({
    ...interactionReportBase, id: "demo-report-weekly-corrected", workId: "demo-work-weekly", workTitle: "一周安排 · 留白与推进",
    title: "阅读安排 · 根据示例补充调整", group: "revision", publishedAt: "2026-11-08T03:40:00Z", coverageAsOf: "2026-11-08T03:35:00Z", observedAt: "2026-11-08T03:35:00Z",
    summary: "用于体验显式更新的固定成果：需要先保存对应的示例反馈，再确认本成果已经处理该反馈。",
    findings: [{
      ...weeklyPlanning[1], pointer: "/report/findings/0", title: "阅读安排改为有空时进行，周日再回看",
      summary: "保留原计划作为背景，根据补充取消固定的每晚 30 分钟承诺，改为有空时阅读。",
      why: "下一周可以先试行较有弹性的安排，再在周日依据真实记录回看，而不是预先推断每天都能执行。",
      condition: "这里只修订计划表述，未修改原计划笔记或建立真实任务，也未记录实际阅读时间。",
      evidence: [weeklyPlanning[1].evidence[0], citation("demo-weekly-feedback", 1, INTERACTION_WEEKLY_FEEDBACK, "user-correction")],
      requiresFeedback: INTERACTION_WEEKLY_FEEDBACK, resolvesFeedback: true,
      changeSummary: "根据示例用户补充，将固定时长安排改为有空时阅读；周日回看的计划仍保留，原反馈与旧修订继续可查。",
    }],
  }),
  report({
    ...interactionReportBase, id: "demo-report-trip-updated", workId: "demo-work-trip", workTitle: "周末出行 · 路线与备选",
    title: "出行安排 · 集合信息已更新", group: "revision", publishedAt: "2026-11-08T03:30:00Z", coverageAsOf: "2026-11-08T03:25:00Z", observedAt: "2026-11-08T03:25:00Z",
    summary: "用于体验已处理发现重新复核的固定成果：原文 v2 只更新集合时间与地点，路线选择条件仍然保留。",
    findings: [{
      ...tripPlanning[1], pointer: "/report/findings/0", title: "集合改为 09:30 东门，路线仍待出发前确认",
      summary: "集合信息 v2 将时间延后半小时、地点改为东门；预计半天结束和按天气选择路线的条件没有变化。",
      why: "把这次有实质变化的集合信息补回原发现，已处理的安排也能继续保持可核对。",
      condition: "仍是虚构行程计划；没有发送通知、订票或更改任何真实日历。出发前仍要核对实际安排。",
      evidence: [{ ...citation(INTERACTION_MEETING_SOURCE_ID, 2, "周六上午 09:30 在东门集合，预计半天结束。"), observedAt: "2026-11-08T03:25:00Z" }],
      changeSummary: "来源 v1 → v2：集合时间 09:00 → 09:30，地点南门 → 东门；原发现身份和已处理状态保留。",
    }],
  }),
];

export type InteractionDemoSelection = {
  reportId: string;
  pointer: string;
  status: "active" | "later" | "done";
  snoozeHours?: number;
  starred?: boolean;
  feedback?: { kind: "fact" | "association" | "context"; text: string };
  sourceAdvance?: { sourceId: string; version: number; note: string };
};

export const INTERACTION_DEMO_SELECTIONS: InteractionDemoSelection[] = [
  { reportId: "demo-report-reading", pointer: "/report/findings/0", status: "active", starred: true },
  { reportId: "demo-report-reading", pointer: "/report/findings/1", status: "done" },
  { reportId: "demo-report-weekly", pointer: "/report/findings/0", status: "later", snoozeHours: 24 },
  { reportId: "demo-report-weekly", pointer: "/report/findings/1", status: "active", feedback: { kind: "context", text: INTERACTION_WEEKLY_FEEDBACK } },
  { reportId: "demo-report-trip", pointer: "/report/findings/0", status: "later", snoozeHours: 48 },
  { reportId: "demo-report-trip", pointer: "/report/findings/1", status: "done", sourceAdvance: { sourceId: INTERACTION_MEETING_SOURCE_ID, version: 2, note: "预置互动示例：集合信息已更新，已处理的发现需要重新核对。" } },
  { reportId: "demo-report-tools", pointer: "/report/findings/0", status: "later", snoozeHours: 72 },
  { reportId: "demo-report-tools", pointer: "/report/findings/1", status: "done", starred: true },
];

const publicReportBase = {
  kind: "structured" as const, status: "published" as const, group: "normal" as const,
  publishedAt: PUBLIC_CASE_CHECKED_AT, coverageAsOf: PUBLIC_CASE_CHECKED_AT, observedAt: PUBLIC_CASE_CHECKED_AT,
};

export const PUBLIC_CASE_REPORT_FIXTURES: ReportFixture[] = [
  report({
    ...publicReportBase, id: "public-case-dxf-text", workId: "public-work-dxf", workTitle: "线束图纸 · DXF 提取",
    title: "公开资料解读 · DXF 文字与属性", summary: "根据 ezdxf 官方文档整理的应用案例：区分块属性、多行文字与后续字段映射。未读取真实图纸。",
    findings: [{
      pointer: "/report/findings/0", title: "导出线表前，补查块属性与多行文字",
      summary: "DXF 中的文字可能保存在块属性或多行文字里。ezdxf 分别提供 ATTRIB 读取与 MTEXT 纯文本提取能力。",
      why: "准备提取 CIRCUIT NBR、Cav、wire 时，可先确认样本里的文字存在哪里，再判断每列的含义。",
      condition: "这是公开技术文档支持的提取思路，未检查你的实际图纸；实体类型和文字本身不能直接证明回路关系或字段映射正确。",
      category: "knowledge",
      evidence: [
        citation("public-ezdxf-insert", 1, "INSERT 表示块引用，可以附带 ATTRIB 属性；这些属性可由 attribs 列表读取。"),
        citation("public-ezdxf-mtext", 1, "MTEXT 保存多行文字和内联格式；plain_text() 可返回去除内联格式代码的文本。"),
      ],
      caseStudy: {
        scenario: "准备把一张线束 DXF 转成线表，画面上能看到字段，但尚不清楚它们是普通文字、块属性还是多行文字。",
        learning: "先找到数据的实际位置，再确认字段含义。读到了文字与正确还原线表，是两个需要分别核对的步骤。",
        actionTitle: "准备 DXF 提取核对清单",
        actionSteps: [
          "在一张授权样图中分别抽查普通文字、块属性和多行文字，记录其字段与位置。",
          "保留原始文字和清洗后的文字；检查换行、字母与前导零是否被误改。",
          "人工核对 CIRCUIT NBR、Cav、wire 的对应关系，再决定是否扩大提取范围。",
        ],
      },
    }],
  }),
  report({
    ...publicReportBase, id: "public-case-linked-views", workId: "public-work-notion", workTitle: "资料组织 · Notion 视图",
    title: "公开资料解读 · 同一资料的多个视图", summary: "根据 Notion 官方帮助整理的应用案例：视图筛选与资料本体修改的作用范围不同。",
    findings: [{
      pointer: "/report/findings/0", title: "同一份资料，多种视图；修改会回到源数据库",
      summary: "Notion 的关联数据库能在多个页面显示同一份内容。视图筛选彼此独立，数据编辑会同步回源数据库。",
      why: "整理工具研究或项目资料时，可以按不同目的浏览同一批条目，并在修改前明确它影响的是视图还是原资料。",
      condition: "这是 Notion 官方功能的应用案例；本站未连接或修改你的 Notion 数据库，也未证明当前 Hub 已实现相同同步机制。",
      category: "knowledge",
      evidence: [citation("public-notion-linked", 1, "编辑其中的数据会同步到源数据库；筛选和视图设置只作用于当前关联视图。")],
      caseStudy: {
        scenario: "同一个工具研究库需要出现在「待试用」「已经采用」和项目首页中，希望不同页面各有重点。",
        learning: "多个入口可以指向同一份资料。洞察与原资料之间也需要清楚的回链，让你知道自己正在改变哪一层。",
        actionTitle: "整理资料与视图的核对清单",
        actionSteps: [
          "挑选一个测试数据库，建立两个筛选不同的关联视图。",
          "修改一条测试记录，确认源数据库和另一个视图中的同一条记录同步变化。",
          "分别记录筛选设置与资料编辑的作用范围，为条目保留原页面链接。",
        ],
      },
    }],
  }),
  report({
    ...publicReportBase, id: "public-case-github-projects", workId: "public-work-github", workTitle: "开发进度 · GitHub Projects",
    title: "公开资料解读 · 自动入板的覆盖范围", summary: "根据 GitHub 官方文档整理的应用案例：新增或更新触发自动添加，启用本身不回填已有条目。",
    findings: [{
      pointer: "/report/findings/0", title: "自动入板启用后，已有 Issue 还要补入",
      summary: "GitHub Projects 的自动添加工作流不会在启用时补入已有条目。之后符合筛选条件的创建或更新才会触发添加。",
      why: "给已有项目建立看板时，应先核对历史 Issue 是否齐全，再用看板判断当前待办和进展。",
      condition: "未检查或更改你的 GitHub 仓库、Issue 或看板设置；这里指出的是官方规则及其应用条件，不声称你的看板已经漏项。",
      category: "decision",
      evidence: [citation("public-github-autoadd", 1, "启用自动添加工作流时，已经存在且符合条件的条目不会立即补入项目。")],
      caseStudy: {
        scenario: "一个项目已经积累了一批 Issue，现在才建立 Projects 看板并开启自动添加，希望以后统一查看进度。",
        learning: "自动化规则需要区分历史覆盖和后续触发。面板没有显示某件事，不能直接说明它不存在或已经完成。",
        actionTitle: "准备项目看板完整性核对",
        actionSteps: [
          "将现有 Issue 列表与看板条目逐项对照，标记未纳入且仍需要跟踪的事项。",
          "为已有事项准备一次补入清单，核对每条是否符合当前项目范围。",
          "再用一条测试 Issue 验证新建或更新后的自动添加行为，并记录筛选条件。",
        ],
      },
    }],
  }),
  report({
    ...publicReportBase, id: "public-case-backlinks", workId: "public-work-reading", workTitle: "阅读应用 · 笔记关联",
    title: "公开资料解读 · 提及、链接与上下文", summary: "根据 Obsidian 官方帮助整理的应用案例：文本提及可作为待核对线索，已建立的链接与之分开。",
    findings: [{
      pointer: "/report/findings/0", title: "提到了同一个词，先看上下文再建立关联",
      summary: "Obsidian 将已建立内部链接的提及，与只出现笔记名称的未链接提及分开展示，并允许展开所在段落。",
      why: "从阅读笔记或日志发现重复概念时，可以先核对两段内容讨论的是不是同一件事，再决定是否复用。",
      condition: "这是公开产品机制的应用案例，未扫描你的 Obsidian 库。相同名称或重复词语不能单独证明事实关联、因果关系或长期趋势。",
      category: "knowledge",
      evidence: [citation("public-obsidian-backlinks", 1, "Backlinks 区分已链接提及与未链接提及：前者来自包含内部链接的笔记，后者来自只出现当前笔记名称、尚未建立链接的位置。")],
      caseStudy: {
        scenario: "一篇阅读摘录和一则项目日志里都出现同一个概念，希望知道它们能否一起用于解释眼前的问题。",
        learning: "共同词语提供查找线索，原段落提供判断条件。关联应该能说明理由，并允许你保留不同语境。",
        actionTitle: "准备一次笔记关联核对",
        actionSteps: [
          "选一处未链接提及，打开它所在的完整段落和目标笔记。",
          "核对名称、对象与使用情境，区分同名词语和同一概念。",
          "确认可复用后再建立链接，写一句关联理由；不同含义则分别保留。",
        ],
      },
    }],
  }),
  report({
    ...publicReportBase, id: "public-case-tasks-context", workId: "public-work-craft", workTitle: "每周回顾 · 任务与笔记",
    title: "公开资料解读 · 从任务回到文档背景", summary: "根据 Craft 官方 Tasks 介绍整理的应用案例：集中查看任务，同时保留原文档的背景。",
    findings: [{
      pointer: "/report/findings/0", title: "回顾一周时，把任务与它的笔记一起看",
      summary: "Craft 的 Tasks 视图汇总收件箱、置顶文档和含任务的笔记，让分散在文档中的任务有一个集中入口。",
      why: "整理一周进展时，可以从任务回到笔记，核对当时的目标、已有产出和仍未解决的问题。",
      condition: "这是基于公开文档的回顾方法示例，未读取你的任务或日志。某条任务完成不等于整个项目完成，计划也不等于已经发生的记录。",
      category: "life",
      evidence: [citation("public-craft-tasks", 1, "Craft 的 Tasks 视图可从侧栏进入，汇总收件箱、置顶文档和包含任务的笔记。")],
      caseStudy: {
        scenario: "一周的任务散在项目文档、阅读笔记和每日记录中，回顾时只看到任务标题，难以判断实际推进了什么。",
        learning: "汇总入口帮助找到事情，原笔记帮助理解事情。洞察可以把状态和上下文一起带回，再由你确认下一步。",
        actionTitle: "准备一页周回顾草稿",
        actionSteps: [
          "各选一条已完成与未完成的任务，找到关联的文档或每日记录。",
          "分别核对原目标、已有产出、剩余问题；没有记录的结果先标为待确认。",
          "整理「已有成果／仍待核对／下一步」，并为每项保留回到任务与笔记的入口。",
        ],
      },
    }],
  }),
];

export const PUBLIC_CASE_SELECTIONS: { reportId: string; pointer: string }[] = PUBLIC_CASE_REPORT_FIXTURES.map(item => ({
  reportId: item.id, pointer: "/report/findings/0",
}));

export const REPORT_FIXTURES: ReportFixture[] = [
  report({
    ...workA,
    id: "sample-r1",
    title: "验证方法与阶段进展",
    publishedAt: "2026-11-08T01:10:00Z",
    group: "normal",
    summary: "基于已选的《验证方法》和《项目复盘》，保存方法建议与一条有范围限制的进展记录。",
    findings: [methodFinding, progressFinding],
  }),
  report({
    id: "report-dxf-preparation",
    workId: "work-dxf-validation",
    workTitle: "DXF 线表 · 小样例验证",
    title: "小样例验证的准备依据",
    kind: "structured",
    status: "published",
    group: "normal",
    publishedAt: "2026-11-08T01:30:00Z",
    coverageAsOf: "2026-11-08T01:20:00Z",
    observedAt: "2026-11-08T01:20:00Z",
    summary: "整理这项工作中已经选定的字段草稿与方法摘录，说明第一轮验证可以如何准备。",
    findings: [{
      pointer: "/report/findings/0",
      title: "第一轮 DXF 验证，可以从保留原文的小样例开始",
      summary: "字段草稿明确了核对对象；方法摘录补充了原始文本、位置和人工核对结果的保留方式。",
      why: "这两份材料已在当前工作中选定，可以帮助明确下一轮验证的输入与记录方式。",
      condition: "尚未执行真实图纸验证。阅读摘录属于方法转述，其原始出处未在本次材料中核定；两条引文不等于两次独立验证。",
      category: "knowledge",
      evidence: [
        citation("migrated-dxf-craft", 1, "先选一份小样例，核对 CIRCUIT NBR、Cav 和 wire 的对应关系。"),
        citation("migrated-dxf-reading", 1, "字段提取后应保留原始文本、所在位置和人工核对结果。", "retelling"),
      ],
    }],
  }),
  report({
    id: "report-assembly-conditions",
    workId: "work-assembly-review",
    workTitle: "试装记录 · 版本核对",
    title: "装配顺序差异与适用条件",
    kind: "structured",
    status: "published",
    group: "normal",
    publishedAt: "2026-11-08T02:30:00Z",
    coverageAsOf: "2026-11-08T02:20:00Z",
    observedAt: "2026-11-08T02:20:00Z",
    summary: "比较当前工作已经选定的设计稿与现场记录，保留差异及尚未对齐的版本条件。",
    findings: [{
      pointer: "/report/findings/0",
      title: "装配顺序不同，先确认两份记录的适用版本",
      summary: "设计稿建议先 1 后 2，现场记录采用先 2 后 1。当前材料尚不足以判断两者是否冲突。",
      why: "准备复核说明时，需要先对齐支架版本、车型与卡扣编号，才能决定是否继续验证。",
      condition: "设计稿对应 V2，现场暂记 V3；饰板方案和编号对应关系尚未确认。不能仅凭顺序不同判定操作错误。",
      category: "knowledge",
      evidence: [
        citation("migrated-assembly-craft", 1, "建议先安装卡扣 1，再安装卡扣 2。"),
        citation("migrated-assembly-obsidian", 1, "现场本次先安装卡扣 2，再安装卡扣 1。"),
      ],
    }],
  }),
  report({
    ...workA,
    id: "sample-r2",
    title: "方法与进展 · 重新整理",
    publishedAt: "2026-11-08T02:00:00Z",
    group: "revision",
    summary: "同一工作的新交付调整了文字与顺序；选择对应候选后，才能更新原发现。",
    findings: [
      {
        ...progressFinding,
        pointer: "/report/findings/0",
        title: "已完成本周的原型验证。",
        changeSummary: "整理了表述并调整了报告中的顺序；没有新增完成范围的证据。",
      },
      {
        ...methodFinding,
        pointer: "/report/findings/1",
        title: "验证前应先确定输入、预期结果和通过条件。",
        changeSummary: "整理了验证方法的表述；仍引用《验证方法》的 v1 内容。",
      },
    ],
  }),
  report({
    ...workA,
    id: "sample-r3",
    title: "验证进展 · 根据用户补充核对",
    publishedAt: "2026-11-08T02:35:00Z",
    group: "revision",
    summary: "供纠正流程使用的固定示例成果；需要先在当前工作保存对应的用户补充，才能采用此候选。",
    findings: [{
      ...progressFinding,
      pointer: "/report/findings/0",
      title: "已完成纸面原型验证，实机验证待进行。",
      summary: "原复盘记录的进展仍被保留；用户补充把“完成”的范围限定为纸面原型。",
      why: "这次核对明确了已有进展和后续实机验证的边界，有助于安排下一轮。",
      condition: "用户补充与复盘原文分别保留；本成果不声明实机验证已经完成。",
      evidence: [progressV1, userCorrection],
      requiresFeedback: SAMPLE_U1,
      resolvesFeedback: true,
      changeSummary: "结合本工作已保存的用户补充，将完成范围修订为纸面原型；实机验证仍待进行。",
    }],
  }),
  report({
    ...workA,
    id: "sample-r4-method-v2",
    title: "验证方法 · 适用版本已补充",
    publishedAt: "2026-11-08T02:50:00Z",
    coverageAsOf: "2026-11-08T02:45:00Z",
    observedAt: "2026-11-08T02:45:00Z",
    group: "revision",
    summary: "供来源版本变化后的显式核对使用；只更新方法发现，不据此删除未再次提及的进展发现。",
    findings: [{
      ...methodFinding,
      title: "验证前还需要确认适用版本。",
      summary: "《验证方法》v2 在输入、预期结果和通过条件之外，补充了适用版本。",
      condition: "只核对了这份方法笔记的变化；没有执行验证，也没有对其他发现重新作出判断。",
      evidence: [methodV2],
      changeSummary: "来源 v1 → v2：新增“适用版本”这一核对项，样本编号与原有三项保持不变。",
    }],
  }),
  report({
    ...workA,
    id: "sample-rb",
    workId: SAMPLE_WORK_B,
    workTitle: "验证方法 · 独立事项",
    title: "另一项工作的验证准备",
    publishedAt: "2026-11-08T01:45:00Z",
    group: "boundary",
    summary: "另一项工作引用相同方法。文字相同不代表归属同一发现，也不继承其他工作的处理状态。",
    findings: [{ ...methodFinding, why: "这份交付归属于另一项已选工作，可在该工作内独立保留与处理。" }],
  }),
  report({
    ...workA,
    id: "sample-r0",
    title: "实机验证情况 · 证据不足",
    publishedAt: "2026-11-08T03:00:00Z",
    status: "insufficientEvidence",
    group: "boundary",
    summary: "已选材料没有实机验证记录，当前回答保留了需要补充的问题。",
    emptyReason: "这份成果的证据不足，且没有可提取的发现。可回原工作查看原回答及需要补充的材料。",
    findings: [],
  }),
  report({
    ...workA,
    id: "sample-native",
    title: "讨论记录 · 下一轮如何开始",
    publishedAt: "2026-11-08T03:05:00Z",
    kind: "native",
    group: "boundary",
    summary: "原回答建议先明确验证目标、准备一份可人工核对的样例，并记录待确认问题。这是一段普通讨论正文。",
    emptyReason: "这份回答是普通正文，没有结构化的发现与引用。原回答仍可阅读，不会自动转换成发现卡片。",
    findings: [],
  }),
  report({
    ...workA,
    id: "sample-rbad",
    title: "引用核对未通过的候选成果",
    publishedAt: "2026-11-08T03:10:00Z",
    group: "boundary",
    summary: "用于验证引用门槛的合成边界样例：一条引文不在原文中，一条来源不可读取。均不能保存为发现。",
    findings: [
      {
        ...methodFinding,
        title: "候选结论：已完成全部实机验证",
        summary: "此候选引用的句子不存在于绑定的《验证方法》v1 中。",
        why: "这是一条故意设置的无效引用，用于检验保存前的核对提示。",
        condition: "无效候选，不得进入发现列表或作为有效结论发布。",
        evidence: [{ ...methodV1, quote: "全部实机验证已完成。", citationValid: false }],
      },
      {
        ...progressFinding,
        title: "候选结论：来源暂不可读取",
        summary: "这条候选依赖一个未获授权的合成来源。",
        why: "原始内容不可读取时，不能以旧摘要代替来源核对。",
        condition: "不可读取的候选只能显示失败原因，不能发布。",
        evidence: [{
          sourceId: "sample-unreadable-source",
          title: "未获授权的示例来源",
          provider: "Hub · 访问边界示例",
          version: 1,
          quote: "不可读取的占位引文",
          location: "不可读取",
          origin: "record",
          relationship: "independent",
          citationValid: false,
        }],
      },
    ],
  }),
  ...INTERACTION_REPORT_FIXTURES,
  ...PUBLIC_CASE_REPORT_FIXTURES,
];

/** Initial chosen examples only; opening the panel does not scan or generate results. */
export const SEED_SELECTIONS: { reportId: string; pointer: string }[] = [
  { reportId: "sample-r1", pointer: "/report/findings/0" },
  { reportId: "sample-r1", pointer: "/report/findings/1" },
  { reportId: "report-dxf-preparation", pointer: "/report/findings/0" },
  { reportId: "report-assembly-conditions", pointer: "/report/findings/0" },
];

export const INTERACTION_HUB_ITEMS: HubItem[] = INTERACTION_DOCUMENTS.map(document => {
  const date = document.eventAt || document.recordedAt.slice(0, 10);
  return {
    id: document.id, title: document.title, kind: document.kind, source: "hub",
    space: document.space, group: date === "2026-11-08" ? "今天" : date === "2026-11-07" ? "昨天" : "本周",
    date, dateLabel: date === "2026-11-08" ? "今天" : date === "2026-11-07" ? "昨天" : date.slice(5).replace("-", " / "),
    tags: document.tags, excerpt: document.content,
    ...(document.kind === "reading" ? { readState: "reading" as const } : {}),
    sections: [
      { type: "callout", text: "预置互动示例。人物、事件、安排和结果均为虚构测试数据，不来自你的真实账号或个人记录。" },
      { type: "h2", text: document.feedback ? "示例补充原话" : "示例正文" },
      { type: "p", text: document.content },
      { type: "h2", text: "核对时保留的条件" },
      { type: "p", text: document.followUp },
      { type: "h2", text: "记录信息" },
      { type: "list", items: [
        ...(document.eventAt ? ["示例事件日期：" + document.eventAt + "。"] : ["未提供实际事件日期；计划不能作为已经发生的事件。"]),
        "示例记录日期：" + document.recordedAt.slice(0, 10) + "。",
        document.feedback ? "反馈的实际保存时间记录在发现的处理历史中，原计划笔记保持原文。" : "当前示例版本：v1。来源更新与发现内容修订分别保留。",
      ] },
    ],
  };
});

export const PUBLIC_CASE_HUB_ITEMS: HubItem[] = PUBLIC_CASE_DOCUMENTS.map(document => ({
  id: document.id, title: document.title, kind: "reading", source: "hub",
  space: "Hub / 公开案例 / 官方资料", group: "今天", date: "2026-11-08", dateLabel: "11 月 8 日核对",
  tags: [...document.tags, "公开资料"], excerpt: document.content, readState: "reading",
  sections: [
    { type: "callout", text: "公开资料 · 中文摘要。以下内容根据官方页面整理，不是官方逐字引文；关联的应用场景不代表你的真实操作或个人经历。" },
    { type: "h2", text: "官方资料摘要" },
    { type: "p", text: document.content },
    { type: "h2", text: "官方来源与核对信息" },
    { type: "list", items: [
      "发布方：" + document.publisher + "。",
      "官方页面：" + document.externalUrl,
      "核对位置：" + document.location + "。",
      "本次核对日期：2026 年 11 月 8 日；不是产品发布日期。",
      document.publishedOn ? "官方页面标注的发布日期：" + document.publishedOn + "。" : "官方页面未提供可确认的发布日期，本原型不补填。",
      "版本 v1 指本站保存的摘要版本，不代表产品版本或持续同步状态。",
    ] },
  ],
}));

/** The source's own event/record timestamps are not report generation timestamps. */
export const REPORT_HUB_ITEMS: HubItem[] = [
  {
    id: SAMPLE_METHOD_SOURCE_ID,
    title: "验证方法",
    kind: "note",
    source: "hub",
    space: "Hub / 原型验证 / 示例材料",
    group: "上周",
    date: "2026-10-28",
    dateLabel: "10 月 28 日",
    tags: ["验证", "方法", "示例"],
    excerpt: D1_V1,
    sections: [
      { type: "callout", text: "INS-SAMPLE-v1 合成材料 D1。用于演示洞察的引用与版本变化，不代表真实项目的验证记录。" },
      { type: "p", text: D1_V1 },
      { type: "h2", text: "记录信息" },
      { type: "list", items: ["事件日期：2026 年 10 月 28 日。", "记录日期：2026 年 10 月 28 日。", "当前示例版本：v1。方法建议不代表验证已经执行。"] },
    ],
  },
  {
    id: SAMPLE_REVIEW_SOURCE_ID,
    title: "项目复盘",
    kind: "journal",
    source: "hub",
    space: "Hub / 原型验证 / 示例日志",
    group: "上周",
    date: "2026-11-01",
    dateLabel: "11 月 1 日",
    tags: ["验证", "复盘", "示例"],
    excerpt: D2_V1,
    sections: [
      { type: "callout", text: "INS-SAMPLE-v1 合成材料 D2。正文保留当时的自述；后续用户补充单独记录，不改写这段原文。" },
      { type: "p", text: D2_V1 },
      { type: "h2", text: "记录信息" },
      { type: "list", items: ["事件日期：2026 年 11 月 1 日。", "补写日期：2026 年 11 月 2 日。", "原文没有区分纸面原型与实机验证，也没有附带业务验收回执。"] },
    ],
  },
  ...INTERACTION_HUB_ITEMS,
  ...PUBLIC_CASE_HUB_ITEMS,
];

/** Reader projection for the current simulated version; old revisions remain in the ledger. */
export function getSourceHubItem(sourceId: string, versionNumber: number): HubItem | undefined {
  const base = REPORT_HUB_ITEMS.find((item) => item.id === sourceId);
  const sourceVersion = getSourceVersion(sourceId, versionNumber);
  if (!base || !sourceVersion) return undefined;
  const interactive = INTERACTION_DOCUMENTS.find(document => document.id === sourceId);
  if (interactive && versionNumber > 1) return {
    ...base,
    excerpt: sourceVersion.content,
    sections: [
      { type: "callout", text: `预置互动示例 · 当前来源 v${versionNumber}。旧引文保留在发现的历史修订中，不替换成当前原文。` },
      { type: "h2", text: "示例正文" },
      { type: "p", text: sourceVersion.content },
      { type: "h2", text: "本次来源变化" },
      { type: "p", text: interactive.nextVersion?.change || "来源内容已更新，需要对照旧引文确认影响。" },
      { type: "p", text: interactive.followUp },
      { type: "list", items: ["原记录日期：" + interactive.recordedAt.slice(0, 10) + "。", "来源修改日期：" + (sourceVersion.modifiedAt?.slice(0, 10) || "未知") + "。", "这是未来安排的版本变化，不是新的出行或生活事件。"] },
    ],
  };
  if (sourceId !== SAMPLE_METHOD_SOURCE_ID || versionNumber === 1) return base;
  return {
    ...base,
    excerpt: sourceVersion.content,
    sections: [
      { type: "callout", text: `INS-SAMPLE-v1 合成材料 D1 · 当前示例 v${versionNumber}。此前 v1 引文保留在发现修订中，不能作为当前原文展示。` },
      { type: "p", text: sourceVersion.content },
      { type: "h2", text: "本次来源变化" },
      { type: "p", text: "方法补充“适用版本”这一核对项，样本编号蓝湾-731 保持不变。此变化只说明方法笔记更新，不代表验证已执行。" },
      { type: "list", items: ["事件日期：2026 年 10 月 28 日。", "来源修改日期：2026 年 11 月 8 日。", "来源修改没有被记为一次新的验证事件。"] },
    ],
  };
}

export function getReportFixture(reportId: string): ReportFixture | undefined {
  return REPORT_FIXTURES.find((entry) => entry.id === reportId);
}

// Readable aliases for callers that present these as a catalogue or selected reports.
export const REPORTS = REPORT_FIXTURES;
export const REPORT_SOURCES = SOURCE_FIXTURES;
export const DEFAULT_REPORT_SELECTIONS = SEED_SELECTIONS;
