// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExistingWorkInvestigation, PersistentSourceInvestigation, StandaloneInvestigation } from "./AgentInvestigation";
import { resetCodexAccountsForTests } from "./CodexAccounts";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import type { WorkSummary } from "./AgentConversationHistory";
import { loadCodexSuiteModels, type ModelProvider } from "./CodexSuite";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: { desktop: true, localVault: true } }));
vi.mock("./WindowVisibility", () => ({ useDocumentVisible: () => true, isWindowVisible: () => true, subscribeWindowVisibility: () => () => {} }));
vi.mock("./CodexSuite", async importOriginal => ({
  ...await importOriginal<object>(),
  loadCodexSuiteModels: vi.fn(async () => []),
  cachedCodexSuiteModels: () => [],
  useCodexSuite: () => ({ loaded: true, loading: false, settings: { model: "fixture-model", provider: "codex", reasoningEffort: "medium", fast: false, maxConcurrent: 2 } }),
}));

type Grant = { libraryIds: string[]; notes?: unknown[]; readingItemKeys?: string[] };
type Request = { action: string; goal?: string; anchor?: unknown; grant?: Grant; setLibraryIds?: string[]; query?: string; archived?: boolean };
type Page = { works: WorkSummary[]; nextCursor: null };
const libraries: LibrarySummary[] = [
  { id: "library-a", name: "资料库 A", provider: "obsidian", connected: true, documentCount: 12, excludedPaths: [] },
  { id: "library-b", name: "资料库 B", provider: "craft", connected: false, documentCount: 8, excludedPaths: [] },
];
const source: SearchResult = {
  id: "hit-a", entityKey: "page:library-a:note-a", provider: "obsidian", libraryId: "library-a", libraryName: "资料库 A",
  spaceId: "library-a", spaceName: "资料库 A", documentId: "note-a", contentType: "markdown", sourceType: "note",
  title: "当前页面", path: "当前页面.md", snippet: "", matchTerms: [], matchField: "", matchCount: 0, subMatches: [],
};
function makeView(goal = "新的普通对话", grant: Grant = { libraryIds: [], notes: [], readingItemKeys: [] }, anchor: unknown = null) {
  return {
    work: { id: "new-work", goal, anchor, grant, revision: 1, authorizationVersion: 1, state: "ready", report: null },
    evidence: [], decisions: [], run: null, validity: "", runActive: false, actionActive: false,
  };
}

let host: HTMLDivElement, root: Root, current: ReturnType<typeof makeView>;
let list: (args: Request) => Promise<Page>;

// Only native I/O is mocked: the host, scope controls, menus and focus handling
// below are the actual production React components.
async function native(command: string, payload?: { args: Request }) {
  if (command === "list_libraries") return libraries;
  const args = payload?.args;
  if (command === "model_runtime" && args?.action === "codexAccounts") {
    return { selected: "desktop", accounts: [], current: { label: "fixture@example.invalid", scopeId: "a".repeat(64), kind: "chatgpt", plan: "plus" } };
  }
  if (command !== "agent_investigation" || !args) throw new Error(`Unexpected native command: ${command}`);
  switch (args.action) {
    case "list": return list(args);
    case "create": current = makeView(args.goal, args.grant, args.anchor); return current;
    case "message":
      current = { ...current, work: { ...current.work, revision: current.work.revision + 1, grant: { ...current.work.grant, libraryIds: args.setLibraryIds ?? current.work.grant.libraryIds } } };
      return current;
    case "respond": current = { ...current, work: { ...current.work, state: "completed" } }; return current;
    case "status":
    case "configureAssistant": return current;
    case "materials": return { notes: [], total: 0, nextOffset: null, snapshot: "fixture" };
    case "topicList": return { topics: [], nextOffset: null };
    case "skills": return {
      skills: [{ name: "hub-research", title: "资料分析与核对", description: "核对材料中的事实与出处", origin: "builtin", version: "1", available: true, allowImplicitInvocation: true, unavailableReasons: [] }],
      diagnostics: [], directory: "/fixture/skills",
    };
    case "skillSourceFile": return { path: "/fixture/skills/hub-research/SKILL.md" };
    case "uiTimingClock": return { hostEpochMs: Date.now() };
    case "uiTiming": return null;
    default: throw new Error(`Unexpected agent request: ${args.action}`);
  }
}

beforeEach(() => {
  resetCodexAccountsForTests();
  localStorage.clear(); sessionStorage.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  current = makeView(); list = async () => ({ works: [], nextCursor: null });
  invoke.mockReset().mockImplementation(native);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.mocked(loadCodexSuiteModels).mockResolvedValue([]);
  resetCodexAccountsForTests(); host.remove();
});

it.each(["live", "cached", "disabled"] as const)("restores Codex search after a DeepSeek round trip (%s)", async webSearch => {
  const model = { provider: "codex", model: "codex-search-test", reasoningEffort: "medium", fast: false, maxConcurrent: 2 };
  localStorage.setItem("hub.agent.preferences.v1", JSON.stringify({ model, webSearch, researchPolicy: "materials-only" }));
  vi.mocked(loadCodexSuiteModels).mockImplementation(async (provider = "codex") => [{ id: provider + "-search-test", name: provider, reasoningLevels: ["medium"], defaultReasoning: "medium" }]);
  await render(<StandaloneInvestigation initiallyOpen/>);
  async function choose(provider: ModelProvider) {
    await activate(select<HTMLElement>(".agent-option-model > summary"));
    await activate(select<HTMLButtonElement>(`.agent-model-list button[title="${provider}-search-test"]`));
  }
  await choose("deepseek");
  const deepseekSaved = JSON.parse(localStorage.getItem("hub.agent.preferences.v1")!);
  expect(deepseekSaved.webSearch).toBe("disabled");
  await act(async () => root.unmount()); root = createRoot(host);
  await render(<StandaloneInvestigation initiallyOpen/>);
  await choose("codex");
  await submit("联网偏好切换回归");
  const configured = invoke.mock.calls.find(([command, payload]) => command === "agent_investigation" && payload?.args?.action === "configureAssistant")![1].args.options;
  expect(configured.webSearch).toBe(webSearch);
  expect(configured.researchPolicy).toBe("material-first");
  expect(configured.model.provider).toBe("codex");
});

it("keeps pinned skills in the skill library and hides the policy with empty scope",async()=>{
  await render(<StandaloneInvestigation initiallyOpen/>);
  await activate(select<HTMLButtonElement>('.agent-skill-shortcut'));
  await activate(select<HTMLButtonElement>('[aria-label="置顶技能 资料分析与核对"]'));
  expect(select<HTMLElement>('.agent-skill-group').getAttribute('aria-label')).toBe('置顶');
  await activate(select<HTMLButtonElement>('[aria-label="关闭添加菜单"]'));
  await activate(select<HTMLElement>('.agent-task-mode>summary'));
  expect(select<HTMLElement>('.agent-mode-menu').textContent).not.toContain('置顶技能');
  await activate(select<HTMLButtonElement>('[aria-label="关闭任务模式"]'));
  await activate(select<HTMLButtonElement>('.agent-scope-trigger'));
  const panel=select<HTMLElement>('.agent-add-materials');
  expect([...panel.querySelectorAll('.agent-scope-overview>button strong,.agent-scope-overview>details>summary strong')].map(e=>e.textContent)).toEqual(['核心材料','可检索的资料库']);
  expect(panel.querySelector('.agent-popover-header')?.textContent).toBe('资料范围');
  expect(panel.querySelector('[aria-label="返回资料范围"]')).toBeNull();
  expect(panel.querySelector('.agent-scope-extra')).toBeNull();
  expect(panel.querySelector('.agent-scope-footer')?.textContent).toContain('保存为专题');
  expect(panel.querySelector('.agent-scope-done')?.textContent).toBe('完成');
  await activate([...panel.querySelectorAll<HTMLButtonElement>('.agent-scope-overview>button')][0]);
  expect(panel.querySelector('[aria-label="返回资料范围"]')).not.toBeNull();
  expect(panel.querySelector('.agent-material-footer')).toBeNull();
  expect(panel.querySelector('.agent-scope-done')?.textContent).toBe('完成选择');
  await activate(select<HTMLButtonElement>('.agent-scope-done'));
  expect(panel.querySelector('.agent-popover-header')?.textContent).toBe('资料范围');
  await activate(select<HTMLButtonElement>('.agent-scope-done'));
  expect(document.activeElement).toBe(select<HTMLTextAreaElement>('[name="investigationGoal"]'));
  expect(calls('create')).toHaveLength(0);
});

it("blocks an empty materials-only scope until the user switches to ordinary chat", async () => {
  localStorage.setItem("hub.agent.preferences.v1", JSON.stringify({ webSearch: "cached" }));
  await render(<StandaloneInvestigation initiallyOpen startFresh />);
  await activate(select<HTMLButtonElement>(".agent-scope-trigger"));
  const library = select<HTMLInputElement>('input[aria-label="允许查找 资料库 A"]');
  await activate(library);
  const policy = select<HTMLDetailsElement>(".agent-scope-overview details:has(.agent-research-policies)");
  expect(policy.querySelector("summary")?.textContent).toContain("怎样使用资料");
  await activate([...policy.querySelectorAll("button")].find(button => button.textContent?.startsWith("只用所选资料"))!);
  await activate(library);
  expect(document.body.textContent).toContain("请添加资料，或切换为普通提问");
  await submit("保留这条提问");
  expect(calls("create")).toHaveLength(0);
  expect(select<HTMLTextAreaElement>('[name="investigationGoal"]').value).toBe("保留这条提问");
  await activate(select<HTMLButtonElement>(".agent-scope-recovery button"));
  expect(document.querySelector(".agent-scope-recovery")).toBeNull();
  await submit("保留这条提问");
  expect(calls("create")).toHaveLength(1);
  expect(invoke.mock.calls.find(([,payload]) => payload?.args?.action === "configureAssistant")?.[1].args.options)
    .toMatchObject({ researchPolicy: "material-first", webSearch: "cached" });
});

const select = <T extends Element>(selector: string, within: ParentNode = document): T => {
  const element = within.querySelector<T>(selector);
  expect(element, `Missing production control: ${selector}`).not.toBeNull();
  return element!;
};
const calls = (action: string): Request[] => invoke.mock.calls.flatMap(([command, payload]) => command === "agent_investigation" && payload?.args?.action === action ? [payload.args] : []);
const historyTitles = () => [...document.querySelectorAll(".agent-history-title")].map(element => element.textContent);
// Native <details> dispatches its toggle event in the next task. Flush that
// browser event after a real summary/button activation, never set open in tests.
const flushToggle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
async function render(node: ReactNode) { await act(async () => root.render(node)); await flushToggle(); }
async function activate(element: HTMLElement) { await act(async () => { element.focus(); element.click(); }); await flushToggle(); }
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    element.focus();
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit(goal: string) {
  await type(select<HTMLTextAreaElement>('[name="investigationGoal"]'), goal);
  await act(async () => select<HTMLFormElement>(".agent-composer form").requestSubmit());
  await flushToggle();
}
async function openHistory() { await activate(select<HTMLElement>('summary[aria-label="对话历史"]')); }
async function escape() {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await flushToggle();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("assistant refinement integration", () => {
  it("closes history immediately and keeps old output hidden while opening another chat", async () => {
    const pending = deferred<ReturnType<typeof makeView>>();
    list = async () => ({works:[{id:current.work.id,goal:current.work.goal,state:"ready"},{id:"other",goal:"另一段对话",state:"ready"}],nextCursor:null});
    const base = native;
    invoke.mockImplementation((command,payload) => payload?.args?.action === "status" && payload.args.id === "other" ? pending.promise : base(command,payload));
    await render(<StandaloneInvestigation initiallyOpen/>);
    await openHistory();
    await activate(select<HTMLButtonElement>('[data-work-id="other"]'));
    expect(select<HTMLDetailsElement>('.agent-dialogue-details').open).toBe(false);
    expect(select<HTMLTextAreaElement>('[name="investigationGoal"]').disabled).toBe(true);
    expect(select<HTMLElement>('.agent-conversation').hidden).toBe(true);
    expect(select('.agent-conversation-loading').getAttribute('role')).toBe('status');
    expect(document.body.textContent).not.toContain("正在恢复对话");
    await act(async () => pending.resolve({...makeView("另一段对话"),work:{...makeView().work,id:"other",goal:"另一段对话"}}));
    expect(select<HTMLTextAreaElement>('[name="investigationGoal"]').disabled).toBe(false);
    expect(select('.agent-task-mode').textContent).toContain("另一段对话");
  });
  it("returns to the original conversation when another conversation cannot be read", async () => {
    list = async () => ({works:[{id:current.work.id,goal:current.work.goal,state:"ready"},{id:"unavailable",goal:"无法读取的对话",state:"ready"}],nextCursor:null});
    invoke.mockImplementation((command,payload) => payload?.args?.action === "status" && payload.args.id === "unavailable" ? Promise.reject(new Error("暂时无法读取所选对话")) : native(command,payload));
    await render(<StandaloneInvestigation initiallyOpen/>);
    await openHistory();await activate(select<HTMLButtonElement>('[data-work-id="unavailable"]'));
    expect(select('.agent-task-mode').textContent).toContain(current.work.goal);
    expect(select<HTMLElement>('.agent-conversation').hidden).toBe(false);
    expect(select<HTMLTextAreaElement>('[name="investigationGoal"]').disabled).toBe(false);
    expect(document.body.textContent).toContain("暂时无法读取所选对话");
  });
  it("finishes deletion and offers undo without waiting for a history refresh", async () => {
    const pending = deferred<Page>();
    list = async () => ({works:[{id:current.work.id,goal:current.work.goal,state:"ready"}],nextCursor:null});
    invoke.mockImplementation((command,payload) => payload?.args?.action === "setHistoryPreference" ? Promise.resolve({}) : native(command,payload));
    await render(<StandaloneInvestigation initiallyOpen/>);
    await openHistory();
    list = () => pending.promise;
    await activate(select<HTMLButtonElement>('.agent-history-actions button'));
    await activate(select<HTMLButtonElement>('.agent-history-delete'));
    expect(document.querySelector('[data-work-id="new-work"]')).toBeNull();
    const undo = select<HTMLButtonElement>('.agent-history-undo button');
    expect(undo.disabled).toBe(false);
    expect(select<HTMLTextAreaElement>('[name="investigationGoal"]').disabled).toBe(false);
    expect(select('.agent-task-mode').textContent).toContain("新聊天");
    await act(async () => pending.resolve({works:[],nextCursor:null}));
  });
  it("waits for the admitted run before enabling stop and refreshes its control identity before cancelling",async()=>{
    const pending=deferred<ReturnType<typeof makeView>>();
    const lifecycle=(activeRunId:string|null,controlRevision:number,state="running")=>({schemaVersion:1,controlRevision,workRevision:current.work.revision,activeRunId,state,requiresExplicitResume:false,canResume:false,recoveryMode:"fresh",runsUsed:1,runLimit:null,unresolvedActions:0,reason:"",recordedUsage:{}});
    Object.assign(current,{lifecycle:lifecycle(null,1,"ready")});
    list=async()=>({works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}],nextCursor:null});
    invoke.mockImplementation(async(command,payload)=>{
      const args=payload?.args;
      if(args?.action==="respond")return pending.promise;
      if(args?.action==="cancel"){
        expect(args).toMatchObject({expectedControlRevision:3,expectedRunId:"admitted-run",expectedWorkRevision:current.work.revision});
        Object.assign(current,{work:{...current.work,state:"paused"},runActive:false,lifecycle:{...lifecycle(null,4,"paused"),requiresExplicitResume:true,canResume:true}});
        return current;
      }
      const value=await native(command,payload);
      if(args?.action==="message")Object.assign(current,{lifecycle:lifecycle(null,1,"ready")});
      return value;
    });
    await render(<StandaloneInvestigation initiallyOpen/>);
    await submit("开始后立即停止的回归");
    expect(select<HTMLButtonElement>('[aria-label="停止本轮"]').disabled).toBe(true);
    current=Object.assign({...current},{work:{...current.work,state:"investigating"},runActive:true,lifecycle:lifecycle("admitted-run",2)});
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1600));});
    const stop=select<HTMLButtonElement>('[aria-label="停止本轮"]');expect(stop.disabled).toBe(false);
    current=Object.assign({...current},{lifecycle:lifecycle("admitted-run",3)});
    await activate(stop);
    expect(calls("cancel")).toHaveLength(1);
    await act(async()=>pending.resolve(current));
    expect(document.body.textContent).toContain("本轮已停止");
  });
  it("does not cancel a different run that replaced the one shown when stop was clicked",async()=>{
    const lifecycle=(activeRunId:string,controlRevision:number)=>({schemaVersion:1,controlRevision,workRevision:current.work.revision,activeRunId,state:"running",requiresExplicitResume:false,canResume:false,recoveryMode:"fresh",runsUsed:1,runLimit:null,unresolvedActions:0,reason:"",recordedUsage:{}});
    Object.assign(current,{work:{...current.work,state:"investigating"},runActive:true,lifecycle:lifecycle("shown-run",1)});
    list=async()=>({works:[{id:current.work.id,goal:current.work.goal,state:current.work.state}],nextCursor:null});
    await render(<StandaloneInvestigation initiallyOpen/>);
    current=Object.assign({...current},{lifecycle:lifecycle("replacement-run",2)});
    await activate(select<HTMLButtonElement>('[aria-label="停止本轮"]'));
    expect(calls("cancel")).toHaveLength(0);
    expect(document.body.textContent).toContain("运行已改变");
  });
  it.each([false, true])("lets a fresh chat send while history is pending and ignores late restoration (contextual=%s)", async contextual => {
    const history = deferred<Page>();
    list = () => history.promise;
    await render(contextual ? <PersistentSourceInvestigation result={source} initiallyOpen startFresh/> : <StandaloneInvestigation initiallyOpen startFresh/>);
    const input = select<HTMLTextAreaElement>('[name="investigationGoal"]');
    expect(input.disabled).toBe(false);
    expect(document.body.textContent).not.toContain("正在恢复对话");
    await submit("历史没返回也能发送");
    expect(calls("create")).toHaveLength(1);
    expect(calls("respond")).toHaveLength(1);
    await type(input, "保留下一条草稿");
    await act(async () => history.resolve({works:[{id:"old-work",goal:"不应自动恢复的旧对话",state:"completed"}],nextCursor:null}));
    expect(current.work.goal).toBe("历史没返回也能发送");
    expect(input.value).toBe("保留下一条草稿");
    expect(invoke.mock.calls.some(([,payload])=>payload?.args?.action==="status" && payload.args.id==="old-work")).toBe(false);
  });
  it("keeps history errors in the history menu without blocking a fresh chat", async () => {
    list = async () => { throw new Error("历史列表暂时不可用"); };
    await render(<StandaloneInvestigation initiallyOpen startFresh/>);
    expect(select<HTMLTextAreaElement>('[name="investigationGoal"]').disabled).toBe(false);
    expect(select(".agent-status").textContent).toBe("");
    await submit("列表失败仍可提问");
    expect(calls("create")).toHaveLength(1);
    await openHistory();
    expect(select(".agent-conversations").textContent).toContain("历史列表暂时不可用");
  });
  it("opens an explicitly chosen conversation without waiting for the history list", async () => {
    const history = deferred<Page>();
    list = () => history.promise;
    current = makeView("明确选中的对话");
    await render(<ExistingWorkInvestigation workId="new-work"/>);
    expect(calls("status").length).toBeGreaterThanOrEqual(2);
    expect(select<HTMLTextAreaElement>('[name="investigationGoal"]').disabled).toBe(false);
    expect(document.body.textContent).toContain("明确选中的对话");
    await act(async () => history.resolve({works:[],nextCursor:null}));
  });
  it("restores the current page conversation independently of the global history list", async () => {
    const history = deferred<Page>();
    list = args => args.anchor ? Promise.resolve({works:[{id:"new-work",goal:"当前页的对话",state:"ready"}],nextCursor:null}) : history.promise;
    current = makeView("当前页的对话", {libraryIds:[],notes:[],readingItemKeys:[]}, {kind:"note",libraryId:"library-a",documentId:"note-a",pageId:null});
    await render(<PersistentSourceInvestigation result={source} initiallyOpen/>);
    expect(calls("status")).toHaveLength(1);
    expect(select<HTMLTextAreaElement>('[name="investigationGoal"]').disabled).toBe(false);
    expect(document.body.textContent).toContain("当前页的对话");
    await act(async () => history.resolve({works:[],nextCursor:null}));
  });
  it.each([false, true])("keeps library checkboxes, the inline scope and sent IDs consistent when legacy current-library selection is removed=%s", async removeCurrent => {
    await render(<PersistentSourceInvestigation result={source} initiallyOpen startFresh />);
    await activate(select<HTMLButtonElement>(".agent-scope-trigger"));
    const a = select<HTMLInputElement>('input[aria-label="允许查找 资料库 A"]');
    const b = select<HTMLInputElement>('input[aria-label="允许查找 资料库 B"]');
    const legacy = select<HTMLInputElement>('.agent-grant input[type="checkbox"]');

    // B is offline with an indexed cache and remains an explicit selectable ID.
    expect(b.disabled).toBe(false);
    await activate(b);
    expect(a.checked).toBe(false); expect(b.checked).toBe(true); expect(legacy.checked).toBe(false);
    await activate(legacy);
    expect(a.checked).toBe(true); expect(b.checked).toBe(true); expect(legacy.checked).toBe(true);
    expect(select<HTMLButtonElement>(".agent-scope-trigger").title).toContain("资料库 A");
    expect(select<HTMLButtonElement>(".agent-scope-trigger").title).toContain("资料库 B");
    expect(select(".agent-scope-trigger-label").textContent).toBe("全部资料库 · 2");

    if (removeCurrent) {
      await activate(legacy);
      expect(a.checked).toBe(false); expect(b.checked).toBe(true); expect(legacy.checked).toBe(false);
      expect(select(".agent-scope-trigger-label").textContent).toBe("资料库 B");
    }
    expect(calls("message")).toHaveLength(0);
    expect(calls("respond")).toHaveLength(0);
    await submit("核对本次选中的资料");

    const updates = calls("message");
    expect(updates).toHaveLength(1);
    expect([...(updates[0].setLibraryIds ?? [])].sort()).toEqual(removeCurrent ? ["library-b"] : ["library-a", "library-b"]);
    // Granting a whole library must not silently remove the explicit page.
    expect(calls("create")[0].grant?.notes).toEqual([{ kind: "note", libraryId: "library-a", documentId: "note-a", pageId: null }]);
    expect(current.work.grant.libraryIds.sort()).toEqual(removeCurrent ? ["library-b"] : ["library-a", "library-b"]);
  });

  it("keeps the newest title search when earlier native responses arrive late", async () => {
    const earlier = deferred<Page>(), latest = deferred<Page>();
    list = args => args.query === "项目" ? earlier.promise : args.query === "项目复盘" ? latest.promise : Promise.resolve({ works: [], nextCursor: null });
    await render(<StandaloneInvestigation initiallyOpen startFresh />);
    await openHistory();
    await activate(select<HTMLButtonElement>('button[aria-label="搜索对话标题和提问"]'));
    const search = select<HTMLInputElement>('input[aria-label="搜索对话标题和提问"]');
    await type(search, "项目");
    await type(search, "项目复盘");
    expect(calls("list").slice(-2).map(request => request.query)).toEqual(["项目", "项目复盘"]);

    await act(async () => latest.resolve({ works: [{ id: "latest", goal: "项目复盘最终稿", state: "completed" }], nextCursor: null }));
    expect(historyTitles()).toEqual(["项目复盘最终稿"]);
    await act(async () => earlier.resolve({ works: [{ id: "stale", goal: "项目的过时结果", state: "completed" }], nextCursor: null }));
    expect(historyTitles()).toEqual(["项目复盘最终稿"]);
    expect(search.value).toBe("项目复盘");
    expect(select(".agent-conversations").getAttribute("aria-busy")).toBe("false");
  });

  it("clears history search on the first Escape and closes its parent menu only on the second", async () => {
    await render(<StandaloneInvestigation initiallyOpen startFresh />);
    await openHistory();
    const menu = select<HTMLDetailsElement>(".agent-dialogue-details");
    const searchButton = select<HTMLButtonElement>('button[aria-label="搜索对话标题和提问"]');
    await activate(searchButton);
    await type(select<HTMLInputElement>('input[aria-label="搜索对话标题和提问"]'), "待清除的标题");

    await escape();
    expect(menu.open).toBe(true);
    expect(document.querySelector('input[aria-label="搜索对话标题和提问"]')).toBeNull();
    expect(calls("list").slice(-1)[0]?.query).toBe("");
    expect(document.activeElement).toBe(searchButton);

    await escape();
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(select('summary[aria-label="对话历史"]'));
    expect(document.querySelector('[aria-label="Hub 助手"]')).not.toBeNull();
  });

  it("closes only the row action menu on the first Escape before closing history on the second", async () => {
    list = async () => ({ works: [{ id: "saved", goal: "保留的对话", state: "completed" }], nextCursor: null });
    await render(<StandaloneInvestigation initiallyOpen startFresh />);
    await openHistory();
    const menu = select<HTMLDetailsElement>(".agent-dialogue-details");
    const more = select<HTMLButtonElement>('button[aria-label="更多对话操作 保留的对话"]');
    await activate(more);
    expect(select('[role="menu"]').contains(document.activeElement)).toBe(true);

    await escape();
    expect(menu.open).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(calls("setHistoryPreference")).toHaveLength(0);

    await escape();
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(select('summary[aria-label="对话历史"]'));
  });

  it("reloads the current archive filter after creating a normal conversation", async () => {
    const archived: WorkSummary = { id: "archived-work", goal: "已归档的旧讨论", state: "completed", archived: true };
    list = async args => ({ works: args.archived ? [archived] : [], nextCursor: null });
    await render(<StandaloneInvestigation initiallyOpen startFresh />);
    await openHistory();
    await activate(select<HTMLButtonElement>(".agent-history-footer button"));
    expect(historyTitles()).toEqual([archived.goal]);
    expect(select(".agent-conversations").getAttribute("aria-label")).toBe("已归档的对话");

    const beforeCreate = calls("list").length;
    await submit("不属于归档列表的新对话");
    expect(calls("create")).toHaveLength(1);
    expect(calls("list").slice(beforeCreate)).toContainEqual(expect.objectContaining({ archived: true, query: "" }));
    await openHistory();
    expect(select(".agent-conversations").getAttribute("aria-label")).toBe("已归档的对话");
    expect(historyTitles()).toEqual([archived.goal]);
    expect(historyTitles()).not.toContain("不属于归档列表的新对话");
  });

  it.each(["close button", "Escape"])("enters the details with keyboard focus and restores the actual trigger on %s", async closeWith => {
    await render(<StandaloneInvestigation initiallyOpen startFresh />);
    const trigger = select<HTMLButtonElement>('button[aria-label="对话详情"]');
    await activate(trigger);
    const menu = select<HTMLDetailsElement>(".agent-dialogue-details");
    const details = select<HTMLElement>(".agent-details-sections");
    expect(menu.open).toBe(true);
    expect(details.hidden).toBe(false);
    expect(details.contains(document.activeElement)).toBe(true);

    if (closeWith === "Escape") await escape();
    else await activate(select<HTMLButtonElement>('button[aria-label="关闭对话详情"]', details));
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('[aria-label="Hub 助手"]')).not.toBeNull();
  });

  it("closes the nested topics menu before its parent details and then restores the details trigger", async () => {
    await render(<PersistentSourceInvestigation result={source} initiallyOpen startFresh />);
    const trigger = select<HTMLButtonElement>('button[aria-label="对话详情"]');
    await activate(trigger);
    const details = select<HTMLDetailsElement>(".agent-dialogue-details");
    const topics = select<HTMLDetailsElement>(".agent-details-sections .agent-topics");
    const topicsTrigger = select<HTMLElement>("summary", topics);
    await activate(topicsTrigger);
    expect(details.open).toBe(true);
    expect(topics.open).toBe(true);
    expect(calls("topicList")).toHaveLength(1);
    await act(async () => select<HTMLButtonElement>('button[aria-label="关闭专题"]', topics).focus());

    await escape();
    expect(topics.open).toBe(false);
    expect(details.open).toBe(true);
    expect(document.activeElement).toBe(topicsTrigger);

    await escape();
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector('[aria-label="Hub 助手"]')).not.toBeNull();
  });

  it("opens the existing scope picker from details and returns focus to the details trigger on completion", async () => {
    await render(<StandaloneInvestigation initiallyOpen startFresh />);
    const trigger = select<HTMLButtonElement>('button[aria-label="对话详情"]');
    await activate(trigger);
    await activate(select<HTMLButtonElement>(".agent-detail-scope-link"));

    expect(select<HTMLDetailsElement>(".agent-dialogue-details").open).toBe(false);
    expect(select<HTMLDetailsElement>(".agent-add-menu").open).toBe(true);
    expect(select(".agent-scope-overview").textContent).toContain("核心材料");
    await activate(select<HTMLButtonElement>(".agent-scope-done"));
    expect(select<HTMLDetailsElement>(".agent-add-menu").open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("returns from memory to the same expanded details and restores its row focus on Escape", async () => {
    await render(<StandaloneInvestigation initiallyOpen startFresh />);
    await activate(select<HTMLButtonElement>('button[aria-label="对话详情"]'));
    const menu = select<HTMLDetailsElement>(".agent-dialogue-details");
    const advanced = select<HTMLDetailsElement>(".agent-connection-advanced", menu);
    await activate(select(".agent-connection-settings", menu).parentElement!.querySelector("summary")!);
    await activate(select("summary", advanced));
    const row = select<HTMLButtonElement>(".agent-detail-memory-link", menu);
    await activate(row);

    expect(menu.open).toBe(false);
    expect(select('[aria-label="返回对话详情"]')).toBeTruthy();
    await escape();
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });

    expect(menu.open).toBe(true);
    expect(advanced.open).toBe(true);
    expect(document.activeElement).toBe(row);
  });

  it("reaches skills through the bottom toolbar and applies the selected skill to the next message", async () => {
    await render(<StandaloneInvestigation initiallyOpen startFresh />);
    await activate(select<HTMLButtonElement>('button[aria-label="添加技能"]'));
    expect(calls("skills")).toHaveLength(1);
    await activate(select<HTMLButtonElement>('button[aria-label="查看技能 资料分析与核对"]'));
    const add = [...select(".agent-skill-actions").querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "添加到本次对话");
    expect(add).toBeDefined();
    await activate(add!);
    expect(select(".agent-selected-skills").textContent).toContain("资料分析与核对");
    expect(select<HTMLDetailsElement>(".agent-add-menu").open).toBe(false);
    expect(document.activeElement).toBe(select('[name="investigationGoal"]'));

    await submit("请比较这两项观点");
    expect(calls("create")[0].goal).toBe("$hub-research 请比较这两项观点");
  });
});


describe("site v71 assistant controls",()=>{
  it("opens task status as its own panel and restores the mode trigger on Escape",async()=>{
    await render(<StandaloneInvestigation initiallyOpen startFresh/>);
    const trigger=select<HTMLElement>('.agent-task-mode>summary');await activate(trigger);
    await activate([...document.querySelectorAll<HTMLButtonElement>('.agent-mode-menu button')].find(b=>b.textContent==="查看任务状态")!);
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
    expect(select<HTMLElement>('.agent-detail-materials').hidden).toBe(true);
    const close=select<HTMLButtonElement>('button[aria-label="关闭任务状态"]');expect(document.activeElement).toBe(close);
    await act(async()=>close.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
    expect(select<HTMLDetailsElement>('.agent-dialogue-details').open).toBe(false);expect(document.activeElement).toBe(trigger);
    expect(calls('create')).toHaveLength(0);expect(calls('respond')).toHaveLength(0);
  });
  it("shows the effective topic scope without advertising a retained manual library",async()=>{
    const topic={id:"page-only",revision:1,title:"单页核对",pinned:false,grant:{libraryIds:[],notes:[{kind:"note",libraryId:"library-b",documentId:"topic-page",pageId:null}],readingItemKeys:[]},policy:"materials-only",skills:[],versions:[]};
    current=makeView("已有真实工作",{libraryIds:["library-a"],notes:[],readingItemKeys:[]});
    invoke.mockImplementation(async(command,payload)=>{
      if(payload?.args?.action==="researchTopics")return {topics:[topic]};
      if(payload?.args?.action==="checkResearchTopic")return {grant:topic.grant,unavailable:[],changed:[],versions:[]};
      return native(command,payload);
    });
    await render(<ExistingWorkInvestigation workId="new-work"/>);
    const scope=()=>select<HTMLButtonElement>(".agent-scope-trigger").getAttribute("aria-label");
    expect(scope()).toBe("搜索范围：资料库 A");
    await type(select<HTMLTextAreaElement>('[name="investigationGoal"]'),"保留手写草稿");
    await activate(select<HTMLElement>('.agent-task-mode>summary'));
    await activate([...document.querySelectorAll<HTMLButtonElement>('.agent-mode-menu button')].find(b=>b.textContent?.includes("全部专题"))!);
    await activate([...document.querySelectorAll<HTMLButtonElement>('.agent-topic-list button')].find(b=>b.textContent?.includes(topic.title))!);
    await activate([...document.querySelectorAll<HTMLButtonElement>('.agent-research-topics button')].find(b=>b.textContent==="应用到当前对话")!);
    expect(scope()).toContain("1 份资料");expect(scope()).not.toContain("资料库 A");
    await activate(select<HTMLInputElement>('.agent-topic-selection>label input'));
    expect(scope()).toContain("资料库 A");
    await activate(select<HTMLButtonElement>('[aria-label="取消当前专题"]'));
    expect(scope()).toContain("搜索范围：资料库 A");
    expect(select<HTMLTextAreaElement>('[name="investigationGoal"]').value).toBe("保留手写草稿");
    expect(calls("create")).toHaveLength(0);expect(calls("respond")).toHaveLength(0);
  });
  it("creates an empty new chat and explicitly applies its topic scope before the first model request",async()=>{
    const topic={id:"new-topic",revision:1,title:"首次专题",pinned:false,grant:{libraryIds:[],notes:[{kind:"note",libraryId:"library-a",documentId:"note-a",pageId:null}],readingItemKeys:[]},policy:"materials-only",skills:[],versions:[]};
    invoke.mockImplementation(async(command,payload)=>{
      const args=payload?.args;
      if(args?.action==="researchTopics")return {topics:[topic]};
      if(args?.action==="checkResearchTopic")return {grant:topic.grant,unavailable:[],changed:[],versions:[]};
      if(args?.action==="create"&&args.anchor==null&&args.grant.notes.length)throw Error("无来源对话须从空资料授权开始");
      if(args?.action==="replaceResearchScope"){
        current={...current,work:{...current.work,grant:args.grant,revision:current.work.revision+1,authorizationVersion:current.work.authorizationVersion+1}};
        return current;
      }
      return native(command,payload);
    });
    await render(<StandaloneInvestigation initiallyOpen startFresh/>);
    await activate(select<HTMLElement>('.agent-task-mode>summary'));
    await activate([...document.querySelectorAll<HTMLButtonElement>('.agent-mode-menu button')].find(b=>b.textContent?.includes("全部专题"))!);
    await activate([...document.querySelectorAll<HTMLButtonElement>('.agent-topic-list button')].find(b=>b.textContent?.includes(topic.title))!);
    expect(calls("create")).toHaveLength(0);
    await activate([...document.querySelectorAll<HTMLButtonElement>('.agent-research-topics button')].find(b=>b.textContent==="应用到当前对话")!);
    await submit("从这个专题开始核对");
    expect(calls("create")).toHaveLength(1);expect(calls("create")[0].grant).toEqual({libraryIds:[],notes:[],readingItemKeys:[]});
    expect(calls("replaceResearchScope")).toHaveLength(1);expect(calls("replaceResearchScope")[0].grant).toEqual({...topic.grant,sources:[]});
    expect(calls("respond")).toHaveLength(1);
    const order=invoke.mock.calls.map(([,p])=>p?.args?.action);expect(order.indexOf("replaceResearchScope")).toBeLessThan(order.indexOf("respond"));
  });
  it("offers a tag task preparation without sending the typed request or discarding it",async()=>{
    await render(<StandaloneInvestigation initiallyOpen startFresh/>);
    await type(select<HTMLTextAreaElement>('[name="investigationGoal"]'),"帮我起草标签定义，保留补充要求");
    await activate([...document.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="准备标签任务 · 起草定义")!);
    expect(select<HTMLTextAreaElement>('[name="investigationGoal"]').value).toBe("帮我起草标签定义，保留补充要求");
    expect(select('.agent-tag-workspace').textContent).toContain("起草标签定义");
    expect(calls("create")).toHaveLength(0);expect(calls("respond")).toHaveLength(0);
  });
  it("rechecks an active topic before sending and retains the draft when a core source changes",async()=>{
    const topic={id:"live-topic",revision:1,title:"已核对的专题",pinned:true,grant:{libraryIds:[],notes:[{kind:"note",libraryId:"library-a",documentId:"note-a",pageId:null}],readingItemKeys:[]},policy:"material-first",skills:[],versions:[]};
    let changed=false;
    invoke.mockImplementation(async(command,payload)=>{
      const action=payload?.args?.action;
      if(action==="researchTopics")return {topics:[topic]};
      if(action==="checkResearchTopic")return {grant:topic.grant,unavailable:[],changed:changed?[{reason:"核心材料已更新"}]:[],versions:[]};
      return native(command,payload);
    });
    await render(<StandaloneInvestigation initiallyOpen startFresh/>);
    await activate(select<HTMLElement>('.agent-task-mode>summary'));
    await activate([...document.querySelectorAll<HTMLButtonElement>('.agent-mode-menu button')].find(b=>b.textContent?.includes("全部专题"))!);
    await activate([...document.querySelectorAll<HTMLButtonElement>('.agent-topic-list button')].find(b=>b.textContent?.includes(topic.title))!);
    await activate([...document.querySelectorAll<HTMLButtonElement>('.agent-research-topics button')].find(b=>b.textContent==="应用到当前对话")!);
    changed=true;
    await submit("保留这个问题，先核对更新");
    expect(calls("create")).toHaveLength(0);expect(calls("respond")).toHaveLength(0);
    expect(select<HTMLTextAreaElement>('[name="investigationGoal"]').value).toBe("保留这个问题，先核对更新");
    expect(document.body.textContent).toContain("确认使用更新后的资料");
  });
  it("switches task modes without clearing the current input or dispatching a model",async()=>{
    await render(<StandaloneInvestigation initiallyOpen startFresh/>);
    const input=select<HTMLTextAreaElement>('[name="investigationGoal"]');await type(input,"保留这段手写草稿");
    await activate(select<HTMLElement>('.agent-task-mode>summary'));
    const choice=(name:string)=>[...document.querySelectorAll<HTMLButtonElement>('.agent-mode-menu button')].find(button=>button.querySelector('strong')?.textContent===name)!;
    await activate(choice("标签助手"));expect(input.value).toBe("保留这段手写草稿");expect(select('.agent-tag-workspace')).not.toBeNull();
    await activate(select<HTMLElement>('.agent-task-mode>summary'));await activate(choice("通用助手"));
    expect(input.value).toBe("保留这段手写草稿");expect(document.querySelector('.agent-tag-workspace')).toBeNull();
    expect(calls("create")).toHaveLength(0);expect(calls("respond")).toHaveLength(0);
  });
  it("toggles the layout directly and keeps layout choices out of conversation details",async()=>{
    await render(<StandaloneInvestigation initiallyOpen startFresh/>);
    const panel=select<HTMLElement>('.agent-panel');const wasDocked=panel.dataset.agentDocked;
    await activate(select<HTMLButtonElement>('.agent-header-end>button:first-child'));
    expect(panel.dataset.agentDocked).not.toBe(wasDocked);
    await activate(select<HTMLButtonElement>('button[aria-label="对话详情"]'));
    expect(select('.agent-display-controls').textContent).not.toContain('浮窗');expect(select('.agent-display-controls').textContent).not.toContain('侧边栏');
    expect(document.querySelector('.agent-provider-budget')).toBeNull();expect(document.querySelector('.agent-followup-mode')).toBeNull();
  });
});
