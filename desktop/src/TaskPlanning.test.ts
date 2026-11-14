// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
const { invoke, flush, storage, preferences } = vi.hoisted(() => ({ invoke: vi.fn(), flush: vi.fn(), storage: new Map<string, string>(), preferences: { model: { provider: "deepseek", model: "deepseek-chat" } as { provider: string; model: string } | null } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./UserProfileStorage", () => ({ userProfileStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) }, flushUserProfileStorage: flush }));
vi.mock("./AgentPreferences", () => ({ loadAgentPreferences: () => preferences }));
import { analyzeTasks, loadPlanningRecords, planningSuggestions, savePlanningSuggestion, stopPlanningWork, taskIdentity, type PlanningView } from "./TaskPlanning";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
const sample = { id: "one", provider: "dida365", libraryId: "personal", libraryName: "个人", sourceId: "remote-1", documentId: "remote-1", documentTitle: "工程", title: "核对接口", status: "open", completed: false, isProject: false, modifiedAt: 1, dueAt: "2026-11-14", collectionId: "project-a" } as UnifiedTask;
const view = { work: { id: "work-1", state: "completed", report: { summary: "已读取", nextSteps: [{ action: "[T1] 核对当前接口版本", reason: "存在版本差异", citations: [{ evidenceId: "e1", quote: "版本B" }] }] } }, evidence: [], validity: "" } as unknown as PlanningView;
beforeEach(() => { preferences.model = { provider: "deepseek", model: "deepseek-chat" }; storage.clear(); invoke.mockReset(); flush.mockReset(); flush.mockResolvedValue(undefined); });
it("binds only explicit in-scope tokens, never similar titles or invented identifiers", () => {
  const report = structuredClone(view);
  report.work.report!.nextSteps.push({ action: "[T2] 不在范围", reason: "", citations: [] }, { action: "核对接口", reason: "", citations: [] });
  const suggestions = planningSuggestions(report, [sample]);
  expect(suggestions).toHaveLength(1); expect(suggestions[0].task).toBe(sample);
  expect(planningSuggestions({ ...view, validity: "来源已变化" }, [sample])).toEqual([]);
});
it("decodes the actual interactive prose contract and ignores invalid targets", () => {
  const current = structuredClone(view);
  current.work.report!.nextSteps = [];
  current.work.report!.prose = { markdown: '已核对。\n```hub-task-plan\n{"suggestions":[{"task":"T1","text":"核对版本","reason":"交付前核对"},{"task":"T9","text":"外部任务","reason":""}]}\n```', citations: [{ evidenceId: "e1", quote: "宿主核验原文" }] };
  const result = planningSuggestions(current, [sample]);
  expect(result).toHaveLength(1); expect(result[0].citations[0].quote).toBe("宿主核验原文");
  current.work.report!.prose.markdown = '```hub-task-plan\n{broken}\n```'; expect(planningSuggestions(current, [sample])).toEqual([]);
});
it("keeps multiple next steps for one task together instead of overwriting adopted notes", () => {
  const current = structuredClone(view);
  current.work.report!.nextSteps.push({ action: "[T1] 再核对责任方", reason: "避免遗漏", citations: [] });
  const result = planningSuggestions(current, [sample]);
  expect(result).toHaveLength(1); expect(result[0].text).toContain("核对当前接口版本"); expect(result[0].text).toContain("再核对责任方");
});
it("preserves original tasks and merges plan and notes under exact source identity", async () => {
  const before = structuredClone(sample), suggestion = planningSuggestions(view, [sample])[0];
  await savePlanningSuggestion(suggestion, sample, "today", suggestion.text, "2026-11-14");
  await savePlanningSuggestion(suggestion, sample, "project", "先核对版本", "2026-11-14");
  await savePlanningSuggestion(suggestion, sample, "project", "先核对版本", "2026-11-14");
  expect(loadPlanningRecords()).toHaveLength(1); expect(loadPlanningRecords()[0]).toMatchObject({ day: "2026-11-14", note: "先核对版本", identity: taskIdentity(sample) });
  expect(sample).toEqual(before); expect(invoke).not.toHaveBeenCalled(); expect(flush).toHaveBeenCalledTimes(3);
});
it("rejects changed, completed, deleted or replaced tasks before writing", async () => {
  const suggestion = planningSuggestions(view, [sample])[0];
  for (const task of [undefined, { ...sample, modifiedAt: 2 }, { ...sample, completed: true }, { ...sample, libraryId: "other" }]) await expect(savePlanningSuggestion(suggestion, task, "task", "建议", "2026-11-14")).rejects.toThrow();
  expect(storage.size).toBe(0);
});
it("keeps malformed archives and propagates durable-save failure", async () => {
  storage.set("hub.tasks.planning.v1", "broken");
  const s = planningSuggestions(view, [sample])[0];
  await expect(savePlanningSuggestion(s, sample, "today", s.text, "2026-11-14")).rejects.toThrow();
  expect(storage.get("hub.tasks.planning.v1")).toBe("broken"); storage.clear(); flush.mockRejectedValue(Error("磁盘不可用"));
  await expect(savePlanningSuggestion(s, sample, "today", s.text, "2026-11-14")).rejects.toThrow("磁盘不可用");
});
it("uses real agent reports with exact grants and no external-write permissions", async () => {
  invoke.mockResolvedValue(view);
  await analyzeTasks("project", [sample], () => {}, () => false);
  const args = invoke.mock.calls.map(c => c[1].args);
  expect(args.map(a => a.action)).toEqual(["create", "configureAssistant", "message", "respond"]);
  expect(args[0].grant).toEqual({ libraryIds: [], notes: [], readingItemKeys: [], sources: [{ kind: "task", libraryId: sample.libraryId, sourceId: sample.sourceId }] });
  expect(args[1].options).toMatchObject({ researchPolicy: "materials-only", externalMcp: false, autoFlashcardInbox: false, webSearch: "disabled" });
  expect(args[2].text).toContain('"token":"T1"');
});
it("does not start a model after closing or silently truncate a large scope", async () => {
  invoke.mockResolvedValue(view); let closed = false;
  await expect(analyzeTasks("task", [sample], () => { closed = true; }, () => closed)).rejects.toThrow();
  expect(invoke.mock.calls.some(c => c[1].args.action === "respond")).toBe(false);
  invoke.mockClear(); await expect(analyzeTasks("today", Array(33).fill(sample), () => {}, () => false)).rejects.toThrow(); expect(invoke).not.toHaveBeenCalled();
});
it("uses the current default provider when no per-chat model is remembered", async () => {
  preferences.model = null;
  invoke.mockImplementation(async name => name === "model_runtime" ? { settings: { provider: "deepseek", model: "deepseek-reasoner" } } : view);
  await analyzeTasks("task", [sample], () => {}, () => false);
  expect(invoke.mock.calls.find(c => c[1].args.action === "configureAssistant")?.[1].args.options.model.provider).toBe("deepseek");
  expect(invoke.mock.calls.some(c => c[1].args.action === "codexAccounts")).toBe(false);
});
it("closes the admission race before a queued run starts, without stopping finished work", async () => {
  invoke.mockResolvedValue({ ...view, work: { ...view.work, state: "ready", report: null }, lifecycle: { activeRunId: null, controlRevision: 1, workRevision: 2 } });
  await stopPlanningWork("work-1");
  expect(invoke.mock.calls[1][1].args).toMatchObject({ action: "cancel", id: "work-1", expectedRunId: null, expectedControlRevision: 1 });
  invoke.mockReset(); invoke.mockResolvedValue(view); await stopPlanningWork("work-1"); expect(invoke).toHaveBeenCalledTimes(1);
});
