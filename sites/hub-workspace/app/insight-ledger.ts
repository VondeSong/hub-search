import {
  computeReportHash, getEvidenceIssue, SOURCE_FIXTURES,
  INTERACTION_DEMO_VERSION, INTERACTION_DEMO_SELECTIONS, INTERACTION_REPORT_FIXTURES, INTERACTION_SOURCE_FIXTURES,
  PUBLIC_CASE_VERSION, PUBLIC_CASE_SELECTIONS, PUBLIC_CASE_REPORT_FIXTURES, PUBLIC_CASE_SOURCE_FIXTURES,
  type ReportEvidence, type ReportFinding, type ReportFixture,
} from "./insight-reports";

/** Browser-only interaction model. This is separate from the desktop Hub database. */
export const LEDGER_KEY = "hub-insights-selected-results-v1";
const LEDGER_EVENT = "hub-insights-ledger-change";
const LOCK_NAME = "hub-insights-selected-results-write";

export type InsightStatus = "active" | "later" | "done";
export type InsightValidity = "available" | "review" | "unavailable";
export type FeedbackKind = "fact" | "association" | "context";

export type LedgerSource = {
  id: string;
  title?: string;
  provider?: string;
  sourceItemId?: string;
  version: number;
  available: boolean;
  updatedAt: string;
  note?: string;
  accessRevision: number;
};

export type LedgerFeedback = {
  id: string;
  kind: FeedbackKind;
  text: string;
  targetRevision: number;
  createdAt: string;
  /** Current coverage, not a permanent pardon; historical acknowledgements live on revisions. */
  resolvedInRevision?: number;
};

export type LedgerRevision = {
  revision: number;
  previousRevision?: number;
  reportId: string;
  reportTitle: string;
  pointer: string;
  deliveryHash: string;
  generatedAt: string;
  savedAt: string;
  coverageAsOf: string;
  finding: ReportFinding;
  changeSummary: string;
  acknowledgedFeedbackIds: string[];
};

export type LedgerInsight = {
  id: string;
  ownerWorkId: string;
  workTitle: string;
  headRevision: number;
  rowRevision: number;
  status: InsightStatus;
  validity: InsightValidity;
  snoozeUntil?: string;
  muted: boolean;
  starred: boolean;
  createdAt: string;
  updatedAt: string;
  revisions: LedgerRevision[];
  feedback: LedgerFeedback[];
  /** An access check is not a content revision or a successful model update. */
  accessChecks: Record<string, number>;
  lastUpdateOutcome?: { outcome: "failed" | "stopped" | "unknown"; createdAt: string };
};

export type LedgerOrigin = {
  insightId: string;
  revision: number;
  workId: string;
  reportId: string;
  findingPointer: string;
  deliveryHash: string;
  role: "create" | "update";
};

export type LedgerEvent = {
  id: string;
  operationId: string;
  insightId?: string;
  sourceId?: string;
  type: "import" | "update" | "status" | "feedback" | "mute" | "star" | "source" | "check" | "undo" | "update-outcome" | "snooze-expired" | "receipt";
  text: string;
  detail?: string;
  createdAt: string;
  targetRevision?: number;
  rowRevision?: number;
  previousStatus?: InsightStatus;
  previousSnoozeUntil?: string;
  undoesEventId?: string;
  createdItemId?: string;
};

type OperationReceipt = {
  request: string;
  insightId?: string;
  eventId?: string;
  message: string;
};

export type LedgerState = {
  schema: 1;
  revision: number;
  initialized: boolean;
  insights: LedgerInsight[];
  sources: Record<string, LedgerSource>;
  origins: Record<string, LedgerOrigin>;
  events: LedgerEvent[];
  operations: Record<string, OperationReceipt>;
  /** If parsing/storage fails, mutations stop; the original browser value is left intact. */
  storageError?: string;
};

type InsightMutation = { insightId: string; expectedRowRevision: number; operationId: string };
export type LedgerCommand =
  | { type: "import"; report: ReportFixture; findingPointer: string; operationId: string }
  | (InsightMutation & { type: "update"; report: ReportFixture; findingPointer: string; acknowledgedFeedbackIds?: string[] })
  | (InsightMutation & { type: "status"; status: InsightStatus; snoozeUntil?: string })
  | (InsightMutation & { type: "feedback"; kind: FeedbackKind; text: string })
  | (InsightMutation & { type: "mute" | "star"; value: boolean })
  | { type: "source"; sourceId: string; version?: number; available?: boolean; note?: string; operationId: string }
  | (InsightMutation & { type: "undo"; eventId: string })
  | { type: "check"; operationId: string }
  | (InsightMutation & { type: "update-outcome"; outcome: "failed" | "stopped" | "unknown" })
  | { type: "receipt"; insightId: string; expectedRowRevision?: number; targetRevision?: number; originSourceIds?: string[]; kind: "note" | "task"; createdItemId: string; title: string; operationId: string };

export type LedgerResult =
  | { ok: true; state: LedgerState; insightId?: string; eventId?: string; duplicate?: boolean; message: string }
  | { ok: false; state: LedgerState; code: string; message: string };

export type SeedSource = { id: string; title?: string; provider?: string; sourceItemId?: string; version: number; available: boolean };
export type SeedSelection = { reportId: string; pointer: string };

export function ledgerId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function emptyLedger(): LedgerState {
  return { schema: 1, revision: 0, initialized: false, insights: [], sources: {}, origins: {}, events: [], operations: {} };
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function dictionary(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function safeKey(value: unknown): value is string { return nonempty(value) && !["__proto__", "prototype", "constructor"].includes(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function own<T>(record: Record<string, T>, key: string): T | undefined { return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (dictionary(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function originKey(report: Pick<ReportFixture, "workId" | "id">, pointer: string): string {
  return JSON.stringify([report.workId, report.id, pointer]);
}

export function headRevision(insight: LedgerInsight): LedgerRevision {
  return insight.revisions[insight.headRevision - 1];
}

function sourceFor(state: LedgerState, id: string): LedgerSource | undefined {
  return own(state.sources, id) ?? Object.values(state.sources).find(source => source.sourceItemId === id);
}

export function isSourceAccessible(sourceId: string, state: LedgerState = getLedger()): boolean {
  if (state.storageError && SOURCE_FIXTURES.some(source => source.id === sourceId || source.sourceItemId === sourceId)) return false;
  return sourceFor(state, sourceId)?.available !== false;
}

function revisionAccessible(state: LedgerState, revision: LedgerRevision): boolean {
  return revision.finding.evidence.every(evidence => own(state.sources, evidence.sourceId)?.available === true);
}

export function isInsightAccessible(insightId: string, state: LedgerState = getLedger()): boolean {
  const insight = state.insights.find(item => item.id === insightId);
  if (state.storageError && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(insightId)) return false;
  return insight ? revisionAccessible(state, headRevision(insight)) : true;
}

/** Returns no text at all when any dependency of the requested revision is unavailable. */
export function getVisibleFinding(state: LedgerState, insight: LedgerInsight, revision = insight.headRevision): ReportFinding | null {
  const entry = insight.revisions.find(item => item.revision === revision);
  return entry && revisionAccessible(state, entry) ? entry.finding : null;
}

export function getInsightValidity(state: LedgerState, insight: LedgerInsight): InsightValidity {
  const head = headRevision(insight);
  if (!head || !revisionAccessible(state, head)) return "unavailable";
  if (head.finding.evidence.some(evidence => {
    const source = own(state.sources, evidence.sourceId)!;
    return source.version !== evidence.version || (own(insight.accessChecks, source.id) ?? -1) !== source.accessRevision;
  }) || insight.feedback.some(feedback => !feedback.resolvedInRevision)) return "review";
  return "available";
}

export function validityReasons(state: LedgerState, insight: LedgerInsight): string[] {
  const reasons: string[] = [];
  for (const evidence of headRevision(insight).finding.evidence) {
    const source = own(state.sources, evidence.sourceId);
    if (!source?.available) reasons.push(`${evidence.title}：来源当前不可用`);
    else if (source.version !== evidence.version) reasons.push(`${evidence.title}：引用 v${evidence.version}，当前 v${source.version}`);
    else if ((own(insight.accessChecks, source.id) ?? -1) !== source.accessRevision) reasons.push(`${evidence.title}：访问恢复后需要核对`);
  }
  if (insight.feedback.some(feedback => !feedback.resolvedInRevision)) reasons.push("有尚未被新成果核对的用户反馈");
  return reasons;
}

function findingFor(report: ReportFixture, pointer: string): ReportFinding | undefined {
  return report.findings.find(finding => finding.pointer === pointer);
}

function addressesFeedback(finding: ReportFinding, feedback: LedgerFeedback): boolean {
  return !!finding.resolvesFeedback && (finding.requiresFeedback?.trim() === feedback.text.trim()
    || finding.evidence.some(evidence => evidence.origin === "user" && evidence.quote.trim() === feedback.text.trim()));
}

function originMatches(state: LedgerState, report: ReportFixture, finding: ReportFinding, origin: LedgerOrigin): boolean {
  const insight = state.insights.find(item => item.id === origin.insightId);
  const revision = insight?.revisions.find(item => item.revision === origin.revision);
  return origin.deliveryHash === report.deliveryHash && !!revision && canonical(revision.finding) === canonical(finding);
}

export function candidateAvailability(state: LedgerState, report: ReportFixture, finding: ReportFinding): { eligible: boolean; reason?: string; existingInsightId?: string } {
  if (computeReportHash(report) !== report.deliveryHash) return { eligible: false, reason: "固定交付的内容与校验值不一致，请重新核对原报告。" };
  if (report.status !== "published" || report.kind !== "structured") return { eligible: false, reason: report.kind === "native" ? "这份回答只有正文，没有可提取的结构化发现。" : report.status === "insufficientEvidence" ? "这份成果的依据不足，当前没有可保存的发现。" : "原成果当前不可用。" };
  if (!nonempty(finding.title) || !nonempty(finding.summary) || !nonempty(finding.why) || !finding.evidence.length) return { eligible: false, reason: "发现缺少结论、当前关联或有效引用。" };
  const origin = own(state.origins, originKey(report, finding.pointer));
  if (origin && !originMatches(state, report, finding, origin)) return { eligible: false, reason: "这份固定交付的内容与已绑定快照不一致，请核对原报告。" };
  for (const evidence of finding.evidence) {
    const issue = getEvidenceIssue(evidence);
    if (issue) return { eligible: false, reason: issue, ...(origin ? { existingInsightId: origin.insightId } : {}) };
    const source = own(state.sources, evidence.sourceId);
    if (!source?.available) return { eligible: false, reason: `${evidence.title}当前不可用，请先核对来源访问。`, ...(origin ? { existingInsightId: origin.insightId } : {}) };
    if (source.version !== evidence.version) return { eligible: false, reason: `${evidence.title}的成果引用为 v${evidence.version}，当前来源为 v${source.version}；需选择依据对应当前版本的成果。`, ...(origin ? { existingInsightId: origin.insightId } : {}) };
  }
  if (finding.requiresFeedback && !state.insights.some(insight => insight.ownerWorkId === report.workId && insight.feedback.some(feedback => feedback.text.trim() === finding.requiresFeedback!.trim()))) return { eligible: false, reason: "这份修订依赖用户补充，请先在原发现中保存对应反馈。" };
  return { eligible: true, ...(origin ? { existingInsightId: origin.insightId } : {}) };
}

function fail(state: LedgerState, code: string, message: string): LedgerResult { return { ok: false, state, code, message }; }
function statusLabel(status: InsightStatus): string { return status === "active" ? "待关注" : status === "later" ? "稍后" : "已处理"; }

function makeRevision(report: ReportFixture, finding: ReportFinding, revision: number, now: string, acknowledgedFeedbackIds: string[] = []): LedgerRevision {
  return {
    revision, ...(revision > 1 ? { previousRevision: revision - 1 } : {}), reportId: report.id,
    reportTitle: report.title, pointer: finding.pointer, deliveryHash: report.deliveryHash,
    generatedAt: report.publishedAt, savedAt: now, coverageAsOf: report.coverageAsOf,
    finding: clone(finding), changeSummary: finding.changeSummary || (revision === 1 ? "从所选成果保存发现" : "已选择同一工作中的新成果，核对后更新本发现"), acknowledgedFeedbackIds,
  };
}

function addEvent(state: LedgerState, event: Omit<LedgerEvent, "id">): LedgerEvent {
  const saved = { ...event, id: ledgerId() };
  state.events.unshift(saved);
  return saved;
}

/** Deterministic expiry logic; no timer, notification or model execution is resumed. */
export function expireSnoozes(input: LedgerState, now: string): LedgerState {
  let state = input;
  for (const original of input.insights) {
    if (original.status !== "later" || !original.snoozeUntil || Date.parse(original.snoozeUntil) > Date.parse(now)) continue;
    if (state === input) state = clone(input);
    const insight = state.insights.find(item => item.id === original.id)!;
    const until = insight.snoozeUntil!;
    const eventId = `expiry:${insight.id}:${until}`;
    insight.status = "active";
    delete insight.snoozeUntil;
    insight.rowRevision += 1;
    insight.updatedAt = now;
    insight.validity = getInsightValidity(state, insight);
    if (!state.events.some(event => event.id === eventId)) state.events.unshift({ id: eventId, operationId: eventId, insightId: insight.id, type: "snooze-expired", text: "稍后时间已到，回到待关注", detail: "保留当前结论有效性；未启动模型或后台提醒。", createdAt: until, targetRevision: insight.headRevision, rowRevision: insight.rowRevision });
    state.revision += 1;
  }
  return state;
}

/** Pure reducer for the prototype's identity, revisions and user-intent invariants. */
export function reduceLedger(input: LedgerState, command: LedgerCommand, now = new Date().toISOString()): LedgerResult {
  if (input.storageError) return fail(input, "storage", input.storageError);
  if (!safeKey(command.operationId)) return fail(input, "operation", "本次操作缺少有效标识，请重试。");
  if (!validDate(now)) return fail(input, "clock", "当前时间不可用，尚未保存。");
  const { operationId: _operationId, ...request } = command;
  // Keep the selected candidate and delivery binding, not a copy of the whole report.
  // Exact canonical input prevents reusing an operation ID for a different action.
  const requestText = canonical("report" in command ? {
    ...request,
    report: { id: command.report.id, workId: command.report.workId, deliveryHash: command.report.deliveryHash, computedHash: computeReportHash(command.report), finding: findingFor(command.report, command.findingPointer) },
  } : request);
  const previousOperation = own(input.operations, command.operationId);
  if (previousOperation) {
    if (previousOperation.request !== requestText) return fail(input, "operation-conflict", "同一操作标识对应的内容发生变化，请重新确认后提交。");
    return { ok: true, state: input, insightId: previousOperation.insightId, eventId: previousOperation.eventId, duplicate: true, message: previousOperation.message };
  }

  const state = clone(input);
  let insightId: string | undefined;
  let eventId: string | undefined;
  let duplicate = false;
  let message = "已保存";
  let event: LedgerEvent | undefined;
  const finish = (): LedgerResult => {
    state.operations[command.operationId] = { request: requestText, ...(insightId ? { insightId } : {}), ...(eventId ? { eventId } : {}), message };
    state.revision += 1;
    return { ok: true, state, ...(insightId ? { insightId } : {}), ...(eventId ? { eventId } : {}), ...(duplicate ? { duplicate } : {}), message };
  };

  if (command.type === "import" || command.type === "update") {
    const report = command.report;
    const finding = findingFor(report, command.findingPointer);
    if (!safeKey(report.id) || !safeKey(report.workId) || !nonempty(report.deliveryHash) || !finding) return fail(input, "candidate", "找不到这条成果发现，请重新选择。");
    if (computeReportHash(report) !== report.deliveryHash) return fail(input, "delivery-mismatch", "固定交付的内容与校验值不一致，尚未保存。");
    const key = originKey(report, finding.pointer);
    const bound = own(state.origins, key);
    if (bound) {
      if (!originMatches(state, report, finding, bound)) return fail(input, "delivery-mismatch", "固定交付的校验值或内容已变化，不能替换已保存历史。");
      if (command.type === "update" && command.insightId !== bound.insightId) return fail(input, "origin-bound", "这条候选已经保存为另一条发现，不能重新分配其身份。");
      insightId = bound.insightId;
      duplicate = true;
      message = "这条候选已经保存，已返回原发现；未新增条目或修订。";
      return finish();
    }
    const eligibility = candidateAvailability(state, report, finding);
    if (!eligibility.eligible) return fail(input, "ineligible", eligibility.reason || "当前候选不能保存。");
    if (command.type === "import") {
      const revision = makeRevision(report, finding, 1, now);
      const insight: LedgerInsight = {
        id: ledgerId(), ownerWorkId: report.workId, workTitle: report.workTitle, headRevision: 1, rowRevision: 1,
        status: "active", validity: "available", muted: false, starred: false, createdAt: now, updatedAt: now,
        revisions: [revision], feedback: [], accessChecks: Object.fromEntries(finding.evidence.map(evidence => [evidence.sourceId, state.sources[evidence.sourceId].accessRevision])),
      };
      state.insights.unshift(insight);
      insightId = insight.id;
      state.origins[key] = { insightId, revision: 1, workId: report.workId, reportId: report.id, findingPointer: finding.pointer, deliveryHash: report.deliveryHash, role: "create" };
      event = addEvent(state, { operationId: command.operationId, insightId, type: "import", text: "从已有成果保存发现", detail: report.title, createdAt: now, targetRevision: 1, rowRevision: 1 });
      eventId = event.id;
      message = "发现已保存，原成果与引用保持关联。";
      return finish();
    }
  }

  if (command.type === "source") {
    const source = own(state.sources, command.sourceId);
    if (!source) return fail(input, "source", "找不到对应的示例来源。");
    if (command.version !== undefined && (!positive(command.version) || command.version < source.version)) return fail(input, "source-version", "来源版本不能回退，请选择当前或更新版本。");
    const nextVersion = command.version ?? source.version;
    const nextAccess = command.available ?? source.available;
    if (nextVersion === source.version && nextAccess === source.available) { message = "来源没有实质变化，未新增内容修订。"; return finish(); }
    const previousVersion = source.version;
    const previousAccess = source.available;
    source.version = nextVersion;
    source.available = nextAccess;
    source.updatedAt = now;
    source.note = command.note?.trim() || (nextAccess ? previousAccess ? "示例来源内容已变化" : "示例访问已恢复，仍需核对" : "示例来源访问已撤回");
    if (previousAccess !== nextAccess) source.accessRevision += 1;
    for (const insight of state.insights) {
      if (!headRevision(insight).finding.evidence.some(evidence => evidence.sourceId === source.id)) continue;
      insight.validity = getInsightValidity(state, insight);
      insight.rowRevision += 1;
      insight.updatedAt = now;
      addEvent(state, { operationId: command.operationId, insightId: insight.id, sourceId: source.id, type: "source", text: !nextAccess ? "相关来源不可用，已隐藏依赖内容" : !previousAccess ? "来源访问已恢复，等待核对" : "来源变化，结论待复核", detail: !nextAccess ? "保留处理状态与允许显示的操作记录；旧引文和派生内容不可发布。" : !previousAccess ? "访问恢复不会自动确认旧结论。" : `${source.title || "来源"} v${previousVersion} → v${nextVersion}；旧引用仍绑定保存时的版本。`, createdAt: now, targetRevision: insight.headRevision, rowRevision: insight.rowRevision });
    }
    message = !nextAccess ? "来源访问已撤回，相关发现和旧内容已隐藏。" : !previousAccess ? "来源访问已恢复，请核对依赖后继续。" : "已标记受影响发现待复核；处理状态保持原样。";
    return finish();
  }

  if (command.type === "check") {
    let changed = 0;
    for (const insight of state.insights) {
      const before = getInsightValidity(state, insight);
      let accessChecked = false;
      for (const evidence of headRevision(insight).finding.evidence) {
        const source = own(state.sources, evidence.sourceId);
        if (source?.available && source.version === evidence.version && own(insight.accessChecks, source.id) !== source.accessRevision) {
          insight.accessChecks[source.id] = source.accessRevision;
          accessChecked = true;
        }
      }
      insight.validity = getInsightValidity(state, insight);
      if (accessChecked || before !== insight.validity) {
        insight.rowRevision += 1;
        insight.updatedAt = now;
        addEvent(state, { operationId: command.operationId, insightId: insight.id, type: "check", text: "已核对恢复后的来源访问", detail: insight.validity === "available" ? "引用版本一致，沿用已有修订；未重新生成结论。" : "访问已核对；内容变化或用户反馈仍需通过新成果更新。", createdAt: now, targetRevision: insight.headRevision, rowRevision: insight.rowRevision });
        changed += 1;
      }
    }
    const reviewCount = state.insights.filter(insight => getInsightValidity(state, insight) === "review").length;
    message = changed ? `已核对 ${changed} 条发现的来源访问${reviewCount ? `，仍有 ${reviewCount} 条待复核` : ""}。` : reviewCount ? `依赖核对完成，${reviewCount} 条发现仍需选择新成果更新；未生成新修订。` : "依赖没有新变化；沿用已保存结果，未调用模型。";
    return finish();
  }

  const insight = state.insights.find(item => item.id === command.insightId);
  if (!insight) return fail(input, "missing", "这条发现不存在，请重新选择。");
  insightId = insight.id;
  if (command.expectedRowRevision !== undefined && command.expectedRowRevision !== insight.rowRevision) return fail(input, "conflict", "这条发现已在另一处更新。已保留最新反馈，请重新核对当前版本后提交。");

  if (command.type === "update") {
    if (command.report.workId !== insight.ownerWorkId) return fail(input, "work-mismatch", "只能用同一工作中的新成果更新这条发现。");
    if (Date.parse(command.report.publishedAt) < Date.parse(headRevision(insight).generatedAt)) return fail(input, "older-delivery", "这份成果早于当前修订，不能用它覆盖较新的核对结果。可在修订历史中查看旧内容。");
    if (!isInsightAccessible(insight.id, state)) return fail(input, "unavailable", "原发现的来源当前不可用，暂不能发布更新。");
    const finding = findingFor(command.report, command.findingPointer)!;
    const acknowledged = [...new Set(command.acknowledgedFeedbackIds ?? [])];
    if (finding.resolvesFeedback && finding.requiresFeedback && insight.feedback.some(feedback => !feedback.resolvedInRevision && feedback.text.trim() === finding.requiresFeedback!.trim() && !acknowledged.includes(feedback.id))) return fail(input, "feedback-confirmation", "请先确认新成果如何处理了这条用户补充，再发布修订。");
    for (const id of acknowledged) {
      const feedback = insight.feedback.find(item => item.id === id);
      if (!feedback || feedback.resolvedInRevision) return fail(input, "feedback-target", "待核对的用户反馈已变化，请重新确认。");
      if (!addressesFeedback(finding, feedback)) return fail(input, "feedback-unresolved", "所选成果尚未引用这条用户补充，不能将它标记为已核对。");
    }
    const revisionNumber = insight.headRevision + 1;
    insight.revisions.push(makeRevision(command.report, finding, revisionNumber, now, acknowledged));
    insight.headRevision = revisionNumber;
    insight.accessChecks = Object.fromEntries(finding.evidence.map(evidence => [evidence.sourceId, state.sources[evidence.sourceId].accessRevision]));
    for (const feedback of insight.feedback) {
      if (acknowledged.includes(feedback.id)) feedback.resolvedInRevision = revisionNumber;
      else if (feedback.resolvedInRevision && !addressesFeedback(finding, feedback)) delete feedback.resolvedInRevision;
    }
    insight.validity = getInsightValidity(state, insight);
    delete insight.lastUpdateOutcome;
    const key = originKey(command.report, finding.pointer);
    state.origins[key] = { insightId, revision: revisionNumber, workId: command.report.workId, reportId: command.report.id, findingPointer: finding.pointer, deliveryHash: command.report.deliveryHash, role: "update" };
    message = `已发布修订 ${revisionNumber}，保留“${statusLabel(insight.status)}”状态与反馈历史${insight.validity === "review" ? "；仍有待核对反馈" : ""}。`;
    event = addEvent(state, { operationId: command.operationId, insightId, type: "update", text: `已显式更新到修订 ${revisionNumber}`, detail: finding.changeSummary || command.report.title, createdAt: now, targetRevision: revisionNumber, rowRevision: insight.rowRevision + 1 });
  } else if (command.type === "status") {
    if (!["active", "later", "done"].includes(command.status)) return fail(input, "status", "请选择有效的处理状态。");
    if (command.status === "later" && (!validDate(command.snoozeUntil) || Date.parse(command.snoozeUntil) <= Date.parse(now))) return fail(input, "snooze", "请为“稍后”选择一个明确的未来时间。");
    event = addEvent(state, { operationId: command.operationId, insightId, type: "status", text: `已移至${statusLabel(command.status)}`, ...(command.status === "later" ? { detail: `稍后至 ${command.snoozeUntil}；只控制面板内出现。` } : {}), createdAt: now, targetRevision: insight.headRevision, rowRevision: insight.rowRevision + 1, previousStatus: insight.status, ...(insight.snoozeUntil ? { previousSnoozeUntil: insight.snoozeUntil } : {}) });
    insight.status = command.status;
    if (command.status === "later") insight.snoozeUntil = command.snoozeUntil;
    else delete insight.snoozeUntil;
    message = `已移至${statusLabel(insight.status)}，来源任务和结论有效性保持原样。`;
  } else if (command.type === "feedback") {
    if (!isInsightAccessible(insight.id, state)) return fail(input, "unavailable", "来源不可用时无法新增内容反馈，请先核对来源访问。");
    if (!["fact", "association", "context"].includes(command.kind) || !command.text.trim()) return fail(input, "feedback", "请填写要纠正的事实、关联或补充背景。");
    if (command.text.trim().length > 6000) return fail(input, "feedback-length", "请将单条反馈控制在 6000 字以内。");
    insight.feedback.push({ id: ledgerId(), kind: command.kind, text: command.text.trim(), targetRevision: insight.headRevision, createdAt: now });
    insight.validity = getInsightValidity(state, insight);
    event = addEvent(state, { operationId: command.operationId, insightId, type: "feedback", text: command.kind === "fact" ? "已保存事实纠正" : command.kind === "association" ? "已保存关联纠正" : "已保存补充背景", detail: "反馈关联当前内容修订；结论仍待复核，尚未自动改写来源或加入长期记忆。", createdAt: now, targetRevision: insight.headRevision, rowRevision: insight.rowRevision + 1 });
    message = "反馈已保存，结论待复核。可以沿原工作继续讨论。";
  } else if (command.type === "mute" || command.type === "star") {
    if (command.type === "mute") insight.muted = command.value;
    else insight.starred = command.value;
    event = addEvent(state, { operationId: command.operationId, insightId, type: command.type, text: command.type === "mute" ? command.value ? "不再关注本发现" : "恢复关注本发现" : command.value ? "已收藏本发现" : "已取消收藏", detail: command.type === "mute" ? "仅改变本发现的出现偏好，不修改来源、任务或全局兴趣。" : undefined, createdAt: now, targetRevision: insight.headRevision, rowRevision: insight.rowRevision + 1 });
    message = event.text;
  } else if (command.type === "undo") {
    const original = state.events.find(item => item.id === command.eventId && item.insightId === insight.id);
    if (!original || original.type !== "status" || !original.previousStatus) return fail(input, "undo", "这条操作不能撤销处理状态。");
    if (state.events.some(item => item.undoesEventId === original.id)) return fail(input, "undo-used", "这条处理操作已经撤销。");
    const laterState = state.events.some(item => item.insightId === insight.id && ["status", "undo", "snooze-expired"].includes(item.type) && (item.rowRevision ?? 0) > (original.rowRevision ?? 0));
    if (laterState) return fail(input, "undo-conflict", "此后已有新的处理操作，不能用旧撤销覆盖当前状态。");
    insight.status = original.previousStatus;
    if (insight.status === "later" && original.previousSnoozeUntil && Date.parse(original.previousSnoozeUntil) > Date.parse(now)) insight.snoozeUntil = original.previousSnoozeUntil;
    else {
      if (insight.status === "later") insight.status = "active";
      delete insight.snoozeUntil;
    }
    insight.validity = getInsightValidity(state, insight);
    event = addEvent(state, { operationId: command.operationId, insightId, type: "undo", text: `撤销处理，恢复${statusLabel(insight.status)}`, detail: "结论仍按当前来源与反馈判断；没有恢复过期证据或撤销外部操作。", createdAt: now, targetRevision: insight.headRevision, rowRevision: insight.rowRevision + 1, undoesEventId: original.id });
    message = event.text;
  } else if (command.type === "update-outcome") {
    insight.lastUpdateOutcome = { outcome: command.outcome, createdAt: now };
    event = addEvent(state, { operationId: command.operationId, insightId, type: "update-outcome", text: command.outcome === "failed" ? "本次更新未成功" : command.outcome === "stopped" ? "已停止本次更新" : "本次更新结果待确认", detail: "保留原修订、反馈和当前有效性；没有发布新的成功结果。", createdAt: now, targetRevision: insight.headRevision, rowRevision: insight.rowRevision + 1 });
    message = event.text;
  } else if (command.type === "receipt") {
    const revision = insight.revisions.find(item => item.revision === (command.targetRevision ?? insight.headRevision));
    if (!revision || !revisionAccessible(state, revision) || command.originSourceIds?.some(sourceId => !isSourceAccessible(sourceId, state))) return fail(input, "unavailable", "这份草稿依赖的来源不可用，保存已停止。");
    if (!safeKey(command.createdItemId) || !command.title.trim()) return fail(input, "receipt", "尚未收到有效的本地保存结果。");
    const existing = state.events.find(item => item.type === "receipt" && item.insightId === insight.id && item.createdItemId === command.createdItemId);
    if (existing) { eventId = existing.id; duplicate = true; message = "已保留这次本地保存记录。"; return finish(); }
    event = addEvent(state, { operationId: command.operationId, insightId, type: "receipt", text: command.kind === "task" ? "已保存为 Hub 示例任务" : "已保存为 Hub 示例笔记", detail: command.title, createdAt: now, targetRevision: revision.revision, rowRevision: insight.rowRevision + 1, createdItemId: command.createdItemId });
    message = event.text;
  }
  insight.rowRevision += 1;
  insight.updatedAt = now;
  insight.validity = getInsightValidity(state, insight);
  eventId = event?.id;
  return finish();
}

function validEvidence(value: unknown): value is ReportEvidence {
  if (!dictionary(value) || !safeKey(value.sourceId) || !nonempty(value.title) || !nonempty(value.provider) || !positive(value.version) || !nonempty(value.quote) || !nonempty(value.location) || !["record", "user"].includes(value.origin as string) || !["independent", "retelling", "user-correction"].includes(value.relationship as string)) return false;
  if (value.externalUrl === undefined && value.publisher === undefined && value.checkedAt === undefined && value.excerptKind === undefined) return true;
  if (!nonempty(value.externalUrl) || !nonempty(value.publisher) || !validDate(value.checkedAt) || value.excerptKind !== "summary") return false;
  try { return new URL(value.externalUrl).protocol === "https:"; } catch { return false; }
}

function validFinding(value: unknown): value is ReportFinding {
  if (!dictionary(value) || !nonempty(value.pointer) || !nonempty(value.title) || !nonempty(value.summary) || !nonempty(value.why) || typeof value.condition !== "string" || !["knowledge", "life", "decision"].includes(value.category as string) || !Array.isArray(value.evidence) || value.evidence.length === 0 || !value.evidence.every(validEvidence)) return false;
  if (value.caseStudy === undefined) return true;
  return dictionary(value.caseStudy) && nonempty(value.caseStudy.scenario) && nonempty(value.caseStudy.learning) && nonempty(value.caseStudy.actionTitle) && Array.isArray(value.caseStudy.actionSteps) && value.caseStudy.actionSteps.length > 0 && value.caseStudy.actionSteps.every(nonempty);
}

/** Strict structural verification avoids resetting corrupt data into an empty successful save. */
export function parseLedger(raw: string): LedgerState {
  const value: unknown = JSON.parse(raw);
  if (!dictionary(value) || value.schema !== 1 || !nonnegative(value.revision) || typeof value.initialized !== "boolean" || !Array.isArray(value.insights) || !dictionary(value.sources) || !dictionary(value.origins) || !dictionary(value.operations) || !Array.isArray(value.events)) throw new Error("保存结构不可识别");
  const ids = new Set<string>();
  for (const entry of value.insights) {
    if (!dictionary(entry) || !safeKey(entry.id) || ids.has(entry.id) || !safeKey(entry.ownerWorkId) || !nonempty(entry.workTitle) || !positive(entry.headRevision) || !positive(entry.rowRevision) || !["active", "later", "done"].includes(entry.status as string) || !["available", "review", "unavailable"].includes(entry.validity as string) || typeof entry.muted !== "boolean" || typeof entry.starred !== "boolean" || !validDate(entry.createdAt) || !validDate(entry.updatedAt) || !Array.isArray(entry.revisions) || entry.revisions.length !== entry.headRevision || !Array.isArray(entry.feedback) || !dictionary(entry.accessChecks) || (entry.status === "later" && !validDate(entry.snoozeUntil))) throw new Error("发现记录不完整");
    ids.add(entry.id);
    for (let index = 0; index < entry.revisions.length; index += 1) {
      const revision = entry.revisions[index];
      if (!dictionary(revision) || revision.revision !== index + 1 || !safeKey(revision.reportId) || !nonempty(revision.reportTitle) || !nonempty(revision.pointer) || !nonempty(revision.deliveryHash) || !validDate(revision.savedAt) || !validDate(revision.generatedAt) || typeof revision.coverageAsOf !== "string" || !validFinding(revision.finding) || !Array.isArray(revision.acknowledgedFeedbackIds)) throw new Error("内容修订不完整");
    }
    for (const feedback of entry.feedback) if (!dictionary(feedback) || !safeKey(feedback.id) || !["fact", "association", "context"].includes(feedback.kind as string) || !nonempty(feedback.text) || !positive(feedback.targetRevision) || feedback.targetRevision > entry.headRevision || !validDate(feedback.createdAt) || (feedback.resolvedInRevision !== undefined && (!positive(feedback.resolvedInRevision) || feedback.resolvedInRevision > entry.headRevision))) throw new Error("反馈记录不完整");
    for (const [id, revision] of Object.entries(entry.accessChecks)) if (!safeKey(id) || !nonnegative(revision)) throw new Error("访问核对记录不可识别");
  }
  for (const [id, source] of Object.entries(value.sources)) if (!safeKey(id) || !dictionary(source) || source.id !== id || !positive(source.version) || typeof source.available !== "boolean" || !nonnegative(source.accessRevision) || !validDate(source.updatedAt)) throw new Error("来源状态不完整");
  for (const [key, origin] of Object.entries(value.origins)) {
    if (!dictionary(origin) || !safeKey(origin.insightId) || !ids.has(origin.insightId) || !positive(origin.revision) || !safeKey(origin.workId) || !safeKey(origin.reportId) || !nonempty(origin.findingPointer) || !nonempty(origin.deliveryHash) || !["create", "update"].includes(origin.role as string) || key !== JSON.stringify([origin.workId, origin.reportId, origin.findingPointer])) throw new Error("出处关系不完整");
    const owner = value.insights.find(item => (item as LedgerInsight).id === origin.insightId) as LedgerInsight;
    const revision = owner.revisions[origin.revision - 1];
    if (owner.ownerWorkId !== origin.workId || !revision || revision.reportId !== origin.reportId || revision.pointer !== origin.findingPointer || revision.deliveryHash !== origin.deliveryHash) throw new Error("出处与修订不一致");
  }
  for (const item of value.insights as LedgerInsight[]) for (const revision of item.revisions) {
    const origin = value.origins[JSON.stringify([item.ownerWorkId, revision.reportId, revision.pointer])];
    if (!dictionary(origin) || origin.insightId !== item.id || origin.revision !== revision.revision) throw new Error("内容修订缺少绑定出处");
  }
  for (const event of value.events) if (!dictionary(event) || !safeKey(event.id) || !safeKey(event.operationId) || !nonempty(event.text) || !validDate(event.createdAt) || (event.insightId !== undefined && (!safeKey(event.insightId) || !ids.has(event.insightId)))) throw new Error("操作记录不完整");
  for (const [id, operation] of Object.entries(value.operations)) if (!safeKey(id) || !dictionary(operation) || typeof operation.request !== "string" || typeof operation.message !== "string" || (operation.insightId !== undefined && (!safeKey(operation.insightId) || !ids.has(operation.insightId)))) throw new Error("操作回执不完整");
  const state = value as LedgerState;
  for (const insight of state.insights) insight.validity = getInsightValidity(state, insight);
  return state;
}

function readStored(): { state: LedgerState; raw: string | null } {
  if (typeof window === "undefined") return { state: emptyLedger(), raw: null };
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(LEDGER_KEY);
    return { state: raw === null ? emptyLedger() : parseLedger(raw), raw };
  } catch {
    return { state: { ...emptyLedger(), storageError: raw === null ? "当前浏览器无法读取保存空间，尚未写入更改。" : "当前浏览器中的洞察记录无法完整读取，已保留原始内容，未覆盖或重置。" }, raw };
  }
}

export function getLedger(): LedgerState {
  const { state } = readStored();
  return state.storageError ? state : expireSnoozes(state, new Date().toISOString());
}
export const readLedger = getLedger;

function publishChange(): void {
  window.dispatchEvent(new CustomEvent(LEDGER_EVENT));
}

function commitSnapshot(result: LedgerResult, originalRaw: string | null): LedgerResult {
  if (!result.ok || typeof window === "undefined") return result;
  try {
    if (window.localStorage.getItem(LEDGER_KEY) !== originalRaw) return fail(getLedger(), "conflict", "保存期间另一窗口更新了记录，请核对最新状态后重试。");
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(result.state));
  } catch {
    return fail(getLedger(), "storage", "浏览器未能保存本次更改，原记录保持不变。请检查可用存储空间后重试。");
  }
  publishChange();
  return result;
}

async function withWriteLock<T>(operation: () => T): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks?.request) return navigator.locks.request(LOCK_NAME, { mode: "exclusive" }, operation);
  // In older browsers the final raw-value comparison still rejects observed conflicting writes.
  return operation();
}

export async function executeLedger(command: LedgerCommand): Promise<LedgerResult> {
  if (typeof window === "undefined") return fail(emptyLedger(), "browser", "请在浏览器中进行此操作。");
  return withWriteLock(() => {
    const { state, raw } = readStored();
    const current = state.storageError ? state : expireSnoozes(state, new Date().toISOString());
    const result = reduceLedger(current, command);
    return commitSnapshot(result, raw);
  });
}

export async function ensureLedgerSeed(reports: ReportFixture[], selections: SeedSelection[], sources?: SeedSource[]): Promise<LedgerResult> {
  if (typeof window === "undefined") return { ok: true, state: emptyLedger(), message: "等待浏览器载入" };
  return withWriteLock(() => {
    const existing = readStored();
    if (existing.state.storageError) return fail(existing.state, "storage", existing.state.storageError);
    const now = new Date().toISOString();
    if (existing.state.initialized) {
      const expired = expireSnoozes(existing.state, now);
      if (expired !== existing.state) return commitSnapshot({ ok: true, state: expired, message: "已恢复保存的发现与当前处理状态。" }, existing.raw);
      return { ok: true, state: existing.state, message: "已读取保存的发现。" };
    }
    let state = emptyLedger();
    const inferred = new Map<string, SeedSource>();
    for (const report of reports) for (const finding of report.findings) for (const evidence of finding.evidence) {
      const previous = inferred.get(evidence.sourceId);
      if (!previous || evidence.version < previous.version) inferred.set(evidence.sourceId, { id: evidence.sourceId, title: evidence.title, provider: evidence.provider, sourceItemId: evidence.sourceItemId, version: evidence.version, available: true });
    }
    for (const source of sources ?? [...inferred.values()]) {
      if (!safeKey(source.id) || !positive(source.version)) continue;
      state.sources[source.id] = { id: source.id, title: source.title, provider: source.provider, sourceItemId: source.sourceItemId, version: source.version, available: source.available, updatedAt: now, accessRevision: 0 };
    }
    for (const selection of [...selections].reverse()) {
      const report = reports.find(candidate => candidate.id === selection.reportId);
      if (!report) return fail(existing.state, "seed", "示例成果未完整载入，未写入部分记录。");
      const result = reduceLedger(state, { type: "import", report, findingPointer: selection.pointer, operationId: `seed:${originKey(report, selection.pointer)}` }, now);
      if (!result.ok) return fail(existing.state, "seed", `示例发现未保存：${result.message}`);
      state = result.state;
    }
    state.initialized = true;
    return commitSnapshot({ ok: true, state, message: "已载入预先选好的示例成果；之后只保存你明确选择的发现。" }, existing.raw);
  });
}

/**
 * Adds one explicit prototype fixture pack after the original seed, in one commit.
 * The completion receipt is retained independently of the records: later user
 * edits, changed source access and future record removal must never be undone by
 * loading the panel again. Existing origins are not restaged into demo statuses.
 */
export async function ensureInteractionDemo(): Promise<LedgerResult | null> {
  if (typeof window === "undefined") return null;
  return withWriteLock(() => {
    const existing = readStored();
    if (existing.state.storageError) return fail(existing.state, "storage", existing.state.storageError);
    if (!existing.state.initialized) return fail(existing.state, "seed", "请先载入初始发现，再补充互动示例。");
    const now = new Date().toISOString();
    const marker = `seed-pack:${INTERACTION_DEMO_VERSION}`;
    if (own(existing.state.operations, marker)) {
      const expired = expireSnoozes(existing.state, now);
      return expired === existing.state ? null : commitSnapshot({ ok: true, state: expired, message: "已保留你的示例操作，稍后到期的发现已恢复。" }, existing.raw);
    }

    let state = clone(expireSnoozes(existing.state, now));
    for (const source of INTERACTION_SOURCE_FIXTURES) {
      // An existing access denial/version belongs to the user and is never reset.
      if (own(state.sources, source.id)) continue;
      state.sources[source.id] = {
        id: source.id, title: source.title, provider: source.provider, sourceItemId: source.sourceItemId,
        version: source.version, available: source.available, updatedAt: now, accessRevision: 0,
      };
    }

    let added = 0;
    let skipped = 0;
    const stage = (command: LedgerCommand): LedgerResult => {
      const result = reduceLedger(state, command, now);
      if (result.ok) {
        state = result.state;
        for (const event of state.events.filter(item => item.operationId === command.operationId)) {
          event.detail = "预置互动示例" + (event.detail ? " · " + event.detail : "；用于体验状态与历史，不是你的真实操作记录。");
        }
      }
      return result;
    };
    for (const selection of [...INTERACTION_DEMO_SELECTIONS].reverse()) {
      const report = INTERACTION_REPORT_FIXTURES.find(item => item.id === selection.reportId);
      const finding = report?.findings.find(item => item.pointer === selection.pointer);
      if (!report || !finding) return fail(existing.state, "seed", "互动示例未完整载入，未写入部分记录。");
      const key = originKey(report, selection.pointer);
      if (own(state.origins, key)) continue;
      // A user may have selected/restricted these sources before the pack was
      // offered. Do not reveal content or roll versions backwards to seed it.
      if (finding.evidence.some(evidence => !own(state.sources, evidence.sourceId)?.available || state.sources[evidence.sourceId].version !== evidence.version)) {
        skipped += 1;
        continue;
      }
      const prefix = `${marker}:${report.id}:${selection.pointer}`;
      const imported = stage({ type: "import", report, findingPointer: selection.pointer, operationId: prefix + ":import" });
      if (!imported.ok || !imported.insightId) return fail(existing.state, "seed", imported.ok ? "互动示例缺少保存身份，未写入部分记录。" : imported.message);
      const insightId = imported.insightId;
      const current = () => state.insights.find(item => item.id === insightId)!;
      added += 1;

      if (selection.status !== "active") {
        const result = stage({
          type: "status", insightId, expectedRowRevision: current().rowRevision, status: selection.status,
          ...(selection.status === "later" ? { snoozeUntil: new Date(Date.parse(now) + (selection.snoozeHours || 24) * 3_600_000).toISOString() } : {}),
          operationId: prefix + ":status",
        });
        if (!result.ok) return fail(existing.state, "seed", result.message);
      }
      if (selection.starred) {
        const result = stage({ type: "star", insightId, expectedRowRevision: current().rowRevision, value: true, operationId: prefix + ":star" });
        if (!result.ok) return fail(existing.state, "seed", result.message);
      }
      if (selection.feedback) {
        const result = stage({ type: "feedback", insightId, expectedRowRevision: current().rowRevision, ...selection.feedback, operationId: prefix + ":feedback" });
        if (!result.ok) return fail(existing.state, "seed", result.message);
      }
      if (selection.sourceAdvance) {
        const source = own(state.sources, selection.sourceAdvance.sourceId);
        if (source?.available && source.version < selection.sourceAdvance.version) {
          const result = stage({ type: "source", ...selection.sourceAdvance, operationId: prefix + ":source" });
          if (!result.ok) return fail(existing.state, "seed", result.message);
        }
      }
    }
    const message = added ? `已补充 ${added} 条互动示例；原有发现与操作保持不变。` : "互动示例已核对，现有记录与操作保持不变。";
    state.operations[marker] = {
      request: canonical({ type: "interaction-demo-pack", version: INTERACTION_DEMO_VERSION }),
      message: message + (skipped ? ` 有 ${skipped} 条候选受当前来源状态限制，可之后手动选择。` : ""),
    };
    state.revision += 1;
    return commitSnapshot({ ok: true, state, message: state.operations[marker].message }, existing.raw);
  });
}

/** Add the curated public-document cases once without changing existing records. */
export async function ensurePublicCaseDemo(): Promise<LedgerResult | null> {
  if (typeof window === "undefined") return null;
  return withWriteLock(() => {
    const existing = readStored();
    if (existing.state.storageError) return fail(existing.state, "storage", existing.state.storageError);
    if (!existing.state.initialized) return fail(existing.state, "seed", "请先载入已有发现，再补充公开资料案例。");
    const now = new Date().toISOString();
    const marker = `seed-pack:${PUBLIC_CASE_VERSION}`;
    if (own(existing.state.operations, marker)) {
      const expired = expireSnoozes(existing.state, now);
      return expired === existing.state ? null : commitSnapshot({ ok: true, state: expired, message: "已保留案例操作，稍后到期的发现已恢复。" }, existing.raw);
    }

    let state = clone(expireSnoozes(existing.state, now));
    for (const source of PUBLIC_CASE_SOURCE_FIXTURES) {
      if (own(state.sources, source.id)) continue;
      state.sources[source.id] = {
        id: source.id, title: source.title, provider: source.provider, sourceItemId: source.sourceItemId,
        version: source.version, available: source.available, updatedAt: now, accessRevision: 0,
      };
    }

    let added = 0;
    let skipped = 0;
    for (const selection of [...PUBLIC_CASE_SELECTIONS].reverse()) {
      const candidate = PUBLIC_CASE_REPORT_FIXTURES.find(item => item.id === selection.reportId);
      const finding = candidate?.findings.find(item => item.pointer === selection.pointer);
      if (!candidate || !finding) return fail(existing.state, "seed", "公开资料案例不完整，未写入部分记录。");
      if (own(state.origins, originKey(candidate, selection.pointer))) continue;
      if (finding.evidence.some(evidence => !own(state.sources, evidence.sourceId)?.available || state.sources[evidence.sourceId].version !== evidence.version)) {
        skipped += 1;
        continue;
      }
      const operationId = `${marker}:${candidate.id}:${selection.pointer}:import`;
      const result = reduceLedger(state, { type: "import", report: candidate, findingPointer: selection.pointer, operationId }, now);
      if (!result.ok) return fail(existing.state, "seed", result.message);
      state = result.state;
      for (const event of state.events.filter(item => item.operationId === operationId)) {
        event.detail = "公开资料案例 · 依据官方页面整理，应用场景为说明性示例，不是你的实际操作记录。";
      }
      added += 1;
    }
    const message = added ? `已补充 ${added} 条公开资料案例。` : "公开资料案例已核对，原有记录已保留。";
    state.operations[marker] = {
      request: canonical({ type: "public-case-pack", version: PUBLIC_CASE_VERSION }),
      message: message + (skipped ? ` ${skipped} 条候选受现有来源状态限制，未自动加入。` : ""),
    };
    state.revision += 1;
    return commitSnapshot({ ok: true, state, message: state.operations[marker].message }, existing.raw);
  });
}

export function subscribeLedger(listener: (state: LedgerState) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const notify = () => listener(getLedger());
  const storage = (event: StorageEvent) => { if (event.key === LEDGER_KEY || event.key === null) notify(); };
  const visible = () => { if (document.visibilityState === "visible") notify(); };
  window.addEventListener(LEDGER_EVENT, notify);
  window.addEventListener("storage", storage);
  document.addEventListener("visibilitychange", visible);
  const timer = window.setInterval(notify, 30_000);
  return () => {
    window.removeEventListener(LEDGER_EVENT, notify);
    window.removeEventListener("storage", storage);
    document.removeEventListener("visibilitychange", visible);
    window.clearInterval(timer);
  };
}
