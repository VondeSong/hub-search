import { canonicalInsightId, getMigratedEvidence, MIGRATED_CHECKLIST_STEPS, MIGRATED_TOPICS, OLD_SOURCES } from "./insight-migration";

export const WORKFLOW_KEY = "hub-proto-insights-v2";
const PREVIOUS_WORKFLOW_KEY = "hub-proto-insights-v1";
const RECORD_LIMIT = 100;
const TOPIC_LIMIT = 50;
const FOLLOW_UP_WINDOW = 7 * 24 * 60 * 60 * 1000;
const DEMO_DRAFTS_VERSION = 1;

export type InsightDraft = {
  id: string;
  insightId: string;
  workId?: string;
  title: string;
  body: string;
  target: string;
  kind: "checklist" | "note" | "task" | "archive";
  time: string;
  createdItemId?: string;
};

export type WorkflowEvent = {
  id: string;
  text: string;
  date: string;
  detail?: string;
  insightId?: string;
};

export type TopicState = {
  id: string;
  title: string;
  question: string;
  trigger: string;
  sourceIds: string[];
  relatedInsightId: string;
  workId: string;
  enabled: boolean;
  remaining: number;
  expiresAt: string;
};

export type WorkflowData = {
  version: 2;
  /** Removing or editing a draft never causes the example pack to be added again. */
  demoDraftsVersion: number;
  states: Record<string, unknown>;
  scope: string[];
  topics: Record<string, TopicState>;
  drafts: InsightDraft[];
  events: WorkflowEvent[];
  sourceVersions: Record<string, number>;
  lastUpdated: string;
};

export const SCOPE_OPTIONS: { id: string; name: string; description: string }[] = [
  ...OLD_SOURCES.map(source => source.id === "craft-car" ? { ...source, name: "笔记与工程资料", description: "汽车工程、设计参考与其他示例笔记" } : source),
  { id: "hub-local", name: "Hub 工作台", description: "本地示例笔记、任务与日志" },
];

const scopeIds = new Set(SCOPE_OPTIONS.map((source) => source.id));
const draftKinds = new Set<InsightDraft["kind"]>(["checklist", "note", "task", "archive"]);
let memoryWorkflow: WorkflowData | undefined;

export function uid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function stamp(): string {
  return new Date().toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && !!value.trim();
}

function validId(value: unknown): value is string {
  return nonempty(value) && !["__proto__", "prototype", "constructor"].includes(value);
}

function sources(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string" && scopeIds.has(id)))]
    : [...fallback];
}

function exampleDrafts(): InsightDraft[] {
  const evidenceText = (ids: string[]) => ids.map(id => {
    const evidence = getMigratedEvidence(id);
    if (!evidence) return "";
    return `• ${evidence.title}\n  ${evidence.quote}`;
  }).filter(Boolean).join("\n\n");
  return [
    {
      id: "example-draft-dxf-v1", insightId: "dxf", workId: "work-dxf-validation",
      title: "DXF 小样例验证清单 · 示例草稿", kind: "checklist", target: "Hub · 我的笔记", time: "11/08 · 示例",
      body: `这是一份可编辑的测试草稿，尚未执行实际验证。\n\n关联工作\nDXF 线表 · 小样例验证\n\n第一轮核对\n${MIGRATED_CHECKLIST_STEPS.map(step => "□ " + step).join("\n")}\n\n完成后保留\n原始文本及位置、字段候选解释、人工核对结果与仍待确认的异常。\n\n适用条件\n字段含义需要结合图纸表头、图例和具体行确认；一个样例通过不代表全部版本适用。\n\n原文依据\n${evidenceText(["dxf-craft", "dxf-reading"])}`,
    },
    {
      id: "example-draft-assembly-v1", insightId: "assembly", workId: "work-assembly-review",
      title: "左前门卡扣版本核对 · 示例任务草稿", kind: "task", target: "Hub · 任务清单", time: "11/08 · 示例",
      body: `这是一份待确认的测试任务草稿，保存后才进入本浏览器的任务清单。\n\n关联工作\n卡扣试装 · 版本复核\n\n需要核对\n□ 确认两份记录是否对应同一车型与左前门位置。\n□ 补齐支架 V2 / V3、饰板方案和卡扣编号的对应关系。\n□ 对照原始照片确认观察方向，再比较安装顺序。\n□ 将核对结果及仍未知的条件写回记录。\n\n当前边界\n顺序不同不足以证明现场操作错误；目前不判定哪一顺序适用于实际车辆。\n\n原文依据\n${evidenceText(["assembly-craft", "assembly-obsidian"])}`,
    },
  ];
}

/** One additive migration for existing browsers; the marker survives draft removal. */
function addExampleDrafts(value: WorkflowData): WorkflowData {
  if (value.demoDraftsVersion >= DEMO_DRAFTS_VERSION) return value;
  const existingIds = new Set(value.drafts.map(draft => draft.id));
  const additions = exampleDrafts().filter(draft => !existingIds.has(draft.id));
  return {
    ...value,
    demoDraftsVersion: DEMO_DRAFTS_VERSION,
    drafts: [...value.drafts, ...additions].slice(0, RECORD_LIMIT),
  };
}

/** A fresh browser workflow gets one shared expiry, anchored when first saved. */
export function defaultWorkflow(): WorkflowData {
  const expiresAt = new Date(Date.now() + FOLLOW_UP_WINDOW).toISOString();
  return {
    version: 2,
    demoDraftsVersion: DEMO_DRAFTS_VERSION,
    states: {},
    scope: SCOPE_OPTIONS.map((source) => source.id),
    topics: Object.fromEntries(MIGRATED_TOPICS.map((topic) => [topic.id, {
      id: topic.id,
      title: topic.title,
      question: topic.question,
      trigger: topic.trigger,
      sourceIds: [...topic.sourceIds],
      relatedInsightId: canonicalInsightId(topic.relatedInsightId),
      workId: topic.workId,
      enabled: topic.enabled && topic.remaining > 0,
      remaining: Math.max(0, Math.min(3, Math.trunc(topic.remaining))),
      expiresAt,
    }])),
    drafts: exampleDrafts(),
    events: [],
    sourceVersions: {},
    lastUpdated: "10:45",
  };
}

function states(value: unknown): Record<string, unknown> {
  if (!record(value)) return {};
  const result: Record<string, unknown> = {};
  // Canonical entries win on collisions; unrelated state fields stay intact.
  const entries = Object.entries(value).filter(([id, state]) => validId(id) && record(state));
  entries.sort(([a], [b]) => Number(canonicalInsightId(a) === a) - Number(canonicalInsightId(b) === b));
  for (const [id, state] of entries) {
    const canonical = canonicalInsightId(id);
    if (!validId(canonical)) continue;
    result[canonical] = { ...(record(result[canonical]) ? result[canonical] : {}), ...(state as Record<string, unknown>) };
  }
  return result;
}

function topicState(value: unknown, fallback: TopicState, currentTime: number): TopicState {
  if (!record(value)) return { ...fallback, sourceIds: [...fallback.sourceIds] };
  const remaining = typeof value.remaining === "number" && Number.isFinite(value.remaining)
    ? Math.max(0, Math.min(3, Math.trunc(value.remaining))) : fallback.remaining;
  const parsedExpiry = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
  const expiresAt = Number.isFinite(parsedExpiry) ? new Date(parsedExpiry).toISOString() : fallback.expiresAt;
  const sourceIds = sources(value.sourceIds, fallback.sourceIds);
  return {
    id: fallback.id,
    title: nonempty(value.title) ? value.title : fallback.title,
    question: nonempty(value.question) ? value.question : fallback.question,
    trigger: nonempty(value.trigger) ? value.trigger : fallback.trigger,
    sourceIds,
    relatedInsightId: validId(value.relatedInsightId) ? canonicalInsightId(value.relatedInsightId) : fallback.relatedInsightId,
    workId: validId(value.workId) ? value.workId : fallback.workId,
    enabled: (typeof value.enabled === "boolean" ? value.enabled : fallback.enabled)
      && remaining > 0 && sourceIds.length > 0 && Date.parse(expiresAt) > currentTime,
    remaining,
    expiresAt,
  };
}

function topics(value: unknown, defaults: Record<string, TopicState>, currentTime: number): Record<string, TopicState> {
  const incoming = record(value) ? value : {};
  const result = Object.fromEntries(Object.entries(defaults).map(([id, fallback]) => [id, topicState(incoming[id], fallback, currentTime)]));
  let count = Object.keys(result).length;
  for (const [id, candidate] of Object.entries(incoming)) {
    if (count >= TOPIC_LIMIT) break;
    if (!validId(id) || Object.prototype.hasOwnProperty.call(result, id) || !record(candidate)
      || candidate.id !== id || !nonempty(candidate.title) || !nonempty(candidate.question)
      || !nonempty(candidate.trigger) || !validId(candidate.relatedInsightId) || !validId(candidate.workId)
      || !Array.isArray(candidate.sourceIds) || typeof candidate.remaining !== "number"
      || !Number.isFinite(candidate.remaining) || typeof candidate.expiresAt !== "string"
      || !Number.isFinite(Date.parse(candidate.expiresAt))) continue;
    // Work created in the existing five discoveries can have its own bounded topic.
    // Never renew an imported custom topic merely because it is being read again.
    const fallback: TopicState = {
      id, title: candidate.title, question: candidate.question, trigger: candidate.trigger,
      sourceIds: [], relatedInsightId: canonicalInsightId(candidate.relatedInsightId), workId: candidate.workId,
      enabled: false, remaining: 0, expiresAt: candidate.expiresAt,
    };
    result[id] = topicState(candidate, fallback, currentTime);
    count += 1;
  }
  return result;
}

function drafts(value: unknown): InsightDraft[] {
  if (!Array.isArray(value)) return [];
  const result: InsightDraft[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!record(candidate) || !validId(candidate.id) || seen.has(candidate.id)
      || !validId(candidate.insightId) || !nonempty(candidate.title) || !nonempty(candidate.body)
      || !nonempty(candidate.target) || !nonempty(candidate.time)
      || typeof candidate.kind !== "string" || !draftKinds.has(candidate.kind as InsightDraft["kind"])) continue;
    seen.add(candidate.id);
    result.push({
      id: candidate.id,
      insightId: canonicalInsightId(candidate.insightId),
      ...(validId(candidate.workId) ? { workId: candidate.workId } : {}),
      title: candidate.title,
      body: candidate.body,
      target: candidate.target,
      kind: candidate.kind as InsightDraft["kind"],
      time: candidate.time,
      ...(validId(candidate.createdItemId) ? { createdItemId: candidate.createdItemId } : {}),
    });
    if (result.length === RECORD_LIMIT) break;
  }
  return result;
}

function events(value: unknown): WorkflowEvent[] {
  if (!Array.isArray(value)) return [];
  const result: WorkflowEvent[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!record(candidate) || !validId(candidate.id) || seen.has(candidate.id)
      || !nonempty(candidate.text) || !nonempty(candidate.date)) continue;
    seen.add(candidate.id);
    result.push({
      id: candidate.id,
      text: candidate.text,
      date: candidate.date,
      ...(typeof candidate.detail === "string" ? { detail: candidate.detail } : {}),
      ...(validId(candidate.insightId) ? { insightId: canonicalInsightId(candidate.insightId) } : {}),
    });
    if (result.length === RECORD_LIMIT) break;
  }
  return result;
}

function sanitizeWorkflow(value: unknown, base = defaultWorkflow()): WorkflowData {
  if (!record(value)) return base;
  const currentTime = Date.now();
  const sourceVersions: Record<string, number> = {};
  if (record(value.sourceVersions)) {
    for (const [id, version] of Object.entries(value.sourceVersions)) {
      if (validId(id) && typeof version === "number" && Number.isSafeInteger(version) && version >= 1) sourceVersions[id] = version;
    }
  }
  return {
    version: 2,
    demoDraftsVersion: typeof value.demoDraftsVersion === "number" && Number.isSafeInteger(value.demoDraftsVersion) && value.demoDraftsVersion >= 0 ? value.demoDraftsVersion : 0,
    states: states(value.states),
    scope: sources(value.scope, base.scope),
    topics: topics(value.topics, base.topics, currentTime),
    drafts: drafts(value.drafts),
    events: events(value.events),
    sourceVersions,
    lastUpdated: nonempty(value.lastUpdated) ? value.lastUpdated : base.lastUpdated,
  };
}

function saveWorkflow(value: WorkflowData): void {
  memoryWorkflow = value;
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(WORKFLOW_KEY, JSON.stringify(value)); } catch { /* Keep this session usable if storage is unavailable or full. */ }
}

/** Reads only this workspace's storage; no source-site browser data is imported. */
export function readWorkflow(): WorkflowData {
  if (typeof window === "undefined") return defaultWorkflow();
  try {
    const raw = window.localStorage.getItem(WORKFLOW_KEY);
    if (raw !== null) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      const next = addExampleDrafts(sanitizeWorkflow(parsed));
      memoryWorkflow = next;
      // Persist repaired fields and an expired topic's disabled state, without renewing its expiry.
      if (JSON.stringify(next) !== raw) saveWorkflow(next);
      return next;
    }
    const next = defaultWorkflow();
    const previous = window.localStorage.getItem(PREVIOUS_WORKFLOW_KEY);
    if (previous !== null) {
      try { next.states = states(JSON.parse(previous)); } catch { /* An invalid old record does not prevent a fresh workflow. */ }
    }
    saveWorkflow(next);
    return next;
  } catch {
    if (!memoryWorkflow) memoryWorkflow = defaultWorkflow();
    memoryWorkflow = addExampleDrafts(sanitizeWorkflow(memoryWorkflow, memoryWorkflow));
    return memoryWorkflow;
  }
}

/** Connect a confirmed assistant-created local item back to its originating discovery. */
export function recordAssistantDraft(input: {
  insightId: string;
  workId?: string;
  title: string;
  body: string;
  kind: "note" | "task";
  createdItemId: string;
}): void {
  if (typeof window === "undefined" || !validId(input.insightId) || !validId(input.createdItemId)
    || !nonempty(input.title) || !nonempty(input.body) || !["note", "task"].includes(input.kind)) return;
  const current = readWorkflow();
  const insightId = canonicalInsightId(input.insightId);
  const existing = current.drafts.find((draft) => draft.createdItemId === input.createdItemId && draft.insightId === insightId);
  if (existing) {
    window.dispatchEvent(new CustomEvent<InsightDraft>("hub-insight-draft", { detail: existing }));
    return;
  }
  const time = stamp();
  const draft: InsightDraft = {
    id: uid(), insightId,
    ...(validId(input.workId) ? { workId: input.workId } : {}),
    title: input.title.trim(),
    body: input.body.trim(),
    target: input.kind === "task" ? "Hub · 任务" : "Hub · 笔记",
    kind: input.kind,
    time,
    createdItemId: input.createdItemId,
  };
  const event: WorkflowEvent = {
    id: uid(), insightId, date: time,
    text: input.kind === "task" ? "助手草稿已保存到工作台任务" : "助手草稿已保存到工作台笔记",
    detail: `${draft.title} · ${draft.target} · 本地示例`,
  };
  saveWorkflow({ ...current, drafts: [draft, ...current.drafts].slice(0, RECORD_LIMIT), events: [event, ...current.events].slice(0, RECORD_LIMIT) });
  window.dispatchEvent(new CustomEvent<InsightDraft>("hub-insight-draft", { detail: draft }));
}
