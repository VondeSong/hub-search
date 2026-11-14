// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./AgentPreferences", () => ({ loadAgentPreferences: () => ({ model: { provider: "deepseek", model: "deepseek-chat" } }) }));
import { TaskPlanningPanel } from "./TaskPlanningPanel";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import type { PlanningMode } from "./TaskPlanning";
import { isInsideKeyboardDialog } from "./AppKeyboardScope";
let host: HTMLDivElement, root: Root, task: UnifiedTask;
const saved = vi.fn();
const click = async (label: string) => act(async () => { const button = [...host.querySelectorAll('button')].find(b => b.textContent === label)!; expect(button).toBeTruthy(); button.click(); });
const report = { work: { id: "w", state: "completed", report: { summary: "已核对选中任务", nextSteps: [], prose: { markdown: '已核对选中任务。\n```hub-task-plan\n{"suggestions":[{"task":"T1","text":"先确认交付物","reason":"需要明确结果"}]}\n```', citations: [] } } }, evidence: [], validity: "" };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); localStorage.clear(); saved.mockReset();
  task = { id: "one", provider: "obsidian", libraryId: "os", sourceId: "check-1", documentId: "note", title: "核对接口", libraryName: "OS", documentTitle: "工程", completed: false, status: "open", isProject: false, modifiedAt: 1 } as UnifiedTask;
  invoke.mockReset(); invoke.mockImplementation(async (name, p) => name === "list_unified_tasks" ? { tasks: [task] } : name === "task_planning_source" ? p.args.action === "listNotes" ? [] : { receipts: [{ taskId: task.id, provider: task.provider, libraryName: task.libraryName, state: "cached", checkedAt: 1 }], inventoryComplete: false, coverage: "selected-tasks" } : p.args.action === "status" ? { ...report, lifecycle: { activeRunId: null } } : report);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
for (const mode of ["today", "project", "task"] as PlanningMode[]) it(`${mode}: reads original tasks and adopts only after preview and confirmation`, async () => {
  const onTask = vi.fn(); await act(async () => root.render(<TaskPlanningPanel request={{ id: mode, mode, label: "OS / 工程", tasks: [task] }} onClose={() => {}} onTask={onTask} onSaved={saved}/>));
  await click("读取并分析"); expect(host.textContent).toContain("已核对选中任务");
  expect(localStorage.getItem('hub.tasks.planning.v1')).toBeNull();
  await click(mode === "today" ? "加入今日计划" : "预览并保留建议");
  expect(host.querySelector('[aria-label="建议采纳预览"]')).not.toBeNull(); expect(saved).not.toHaveBeenCalled();
  await click("确认采纳"); expect(saved).toHaveBeenCalledOnce(); expect(host.textContent).toContain("已保存到原任务");
  expect(invoke.mock.calls.every(([name]) => ["agent_investigation", "list_unified_tasks", "task_planning_source"].includes(name))).toBe(true);
  const rows = JSON.parse(localStorage.getItem('hub.tasks.planning.v1')!); expect(rows).toHaveLength(1); expect(rows[0].taskId).toBe(task.id);
  if (mode === "today") expect(rows[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/); else expect(rows[0].note).toBe("先确认交付物");
});
it("refuses stale adoption and leaves a changed original untouched", async () => {
  await act(async () => root.render(<TaskPlanningPanel request={{ id: 'stale', mode: 'task', label: '任务', tasks: [task] }} onClose={() => {}} onTask={() => {}} onSaved={saved}/>));
  await click('读取并分析'); await click('预览并保留建议'); task = { ...task, modifiedAt: 2 }; await click('确认采纳');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('原任务已变化'); expect(saved).not.toHaveBeenCalled(); expect(localStorage.getItem('hub.tasks.planning.v1')).toBeNull();
});
it("never reports model errors as a usable recommendation", async () => {
  invoke.mockImplementation(async (name, p) => name === 'list_unified_tasks' ? { tasks: [task] } : name === 'task_planning_source' ? p.args.action === "listNotes" ? [] : { receipts: [{ taskId: task.id, state: "cached", checkedAt: 1 }] } : p.args.action === 'respond' ? Promise.reject(Error('模型不可用')) : report);
  await act(async () => root.render(<TaskPlanningPanel request={{ id: 'error', mode: 'task', label: '任务', tasks: [task] }} onClose={() => {}} onTask={() => {}} onSaved={saved}/>));
  await click('读取并分析'); expect(host.querySelector('[role=alert]')?.textContent).toContain('模型不可用'); expect(host.querySelector('article')).toBeNull();
});
it("owns Escape so the app does not hide the entire desktop window", async () => {
  const close = vi.fn();
  await act(async () => root.render(<TaskPlanningPanel request={{ id: 'keyboard', mode: 'task', label: '任务', tasks: [task] }} onClose={close} onTask={() => {}} onSaved={saved}/>));
  const heading = host.querySelector('h2')!; expect(isInsideKeyboardDialog(heading)).toBe(true);
  await act(async () => { heading.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  expect(close).toHaveBeenCalledOnce();
});

it("previews a source append, requires confirmation, then reconciles unknown results without resending", async () => {
  task = { ...task, provider: "dida365", contentRevision: "v1", sourceRefs: [{ provider: "dida365", libraryId: "os", sourceId: task.sourceId, documentId: task.documentId }] };
  const action = { id: "source-action", taskId: task.id, sourceId: task.sourceId, libraryName: "滴答", before: "Keep original", after: "Keep original\nHub 建议\n先确认交付物", state: "prepared", updatedAt: 1 };
  invoke.mockImplementation(async (name, p) => {
    if (name === "list_unified_tasks") return { tasks: [task] };
    if (name !== "task_planning_source") return report;
    if (p.args.action === "listNotes") return [];
    if (p.args.action === "refresh") return { receipts: [{ taskId: task.id, state: "confirmed", libraryName: "滴答", checkedAt: 1 }] };
    if (p.args.action === "prepareNote") return action;
    if (p.args.action === "submitNote") return { ...action, state: "unknown", error: "回读超时" };
    if (p.args.action === "inspectNote") return { ...action, state: "confirmed" };
    throw Error("Unexpected source operation");
  });
  await act(async () => root.render(<TaskPlanningPanel request={{ id: "source", mode: "task", label: "任务", tasks: [task] }} onClose={() => {}} onTask={() => {}} onSaved={saved}/>));
  await click("读取并分析"); await click("预览并保留建议");
  await act(async () => { const select = host.querySelector<HTMLSelectElement>('[aria-label="建议保存位置"]')!; select.value = "dida"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await click("准备来源变更预览");
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="来源变更预览"]')?.value).toBe(action.after);
  expect(invoke.mock.calls.some(([_, p]) => p?.args?.action === "submitNote")).toBe(false);
  await click("确认写入滴答"); expect(host.textContent).toContain("写入结果待核对");
  await click("只核对来源结果"); expect(host.textContent).toContain("已回读确认写入滴答");
  expect(document.activeElement).toBe(host.querySelector("h2"));
  expect(invoke.mock.calls.filter(([_, p]) => p?.args?.action === "submitNote")).toHaveLength(1);
  expect(invoke.mock.calls.filter(([_, p]) => p?.args?.action === "inspectNote")).toHaveLength(1);
});

it("keeps failed freshness explicit and aborts analysis on incomplete receipts", async () => {
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (name, p) => name === "task_planning_source" && p.args.action === "refresh" ? { receipts: [] } : base(name, p));
  await act(async () => root.render(<TaskPlanningPanel request={{ id: "coverage", mode: "today", label: "任务", tasks: [task] }} onClose={() => {}} onTask={() => {}} onSaved={saved}/>));
  await click("读取并分析"); expect(host.textContent).toContain("来源核对回执不完整");
  expect(invoke.mock.calls.some(([name, p]) => name === "agent_investigation" && p.args.action === "respond")).toBe(false);
});

it("can read persisted source receipts after the original task is completed without running a model", async () => {
  task = { ...task, completed: true, status: "completed" };
  invoke.mockImplementation(async (name, p) => {
    if (name === "task_planning_source" && p.args.action === "listNotes") return [{ id: "old", taskId: task.id, sourceId: task.sourceId, title: "已完成的原任务", libraryName: "滴答", state: "confirmed", before: "original", after: "original and advice", updatedAt: 1 }];
    throw Error("Read-only history must not call the model or source writer");
  });
  await act(async () => root.render(<TaskPlanningPanel request={{ id: "history", mode: "task", label: "历史", tasks: [task], historyOnly: true }} onClose={() => {}} onTask={() => {}} onSaved={saved}/>));
  expect(host.textContent).toContain("已完成的原任务"); expect(host.textContent).toContain("已回读确认写入滴答");
  expect([...host.querySelectorAll("button")].some(b => b.textContent === "读取并分析")).toBe(false);
  expect(invoke.mock.calls).toHaveLength(1);
});
