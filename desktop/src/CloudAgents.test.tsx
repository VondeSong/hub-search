// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CloudAgents from "./CloudAgents";
import { imageUpload, outbox } from "./CloudAgentMedia";
import { runtimeCapabilities } from "./RuntimePlatform";
import { loadComposerDrafts, saveComposerDraft } from "./CloudAgentDrafts";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./CloudAgentMedia", async importOriginal => {
  const actual = await importOriginal<typeof import("./CloudAgentMedia")>();
  return { ...actual, outbox: vi.fn(async () => undefined), uploadSize: () => 0, imageUpload: vi.fn(), videoUploads: vi.fn() };
});
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: { mobile: false } }));
vi.mock("./CloudAgentDrafts", () => ({ loadComposerDrafts: vi.fn(async () => new Map()), saveComposerDraft: vi.fn(async () => {}) }));

let node: HTMLDivElement, root: Root;
let entries: { id: string; title: string; archived: boolean; updated: number; preview: string; status: string; matches: boolean }[];
let running = false;
const click = async (label: string) => {
  const element = [...node.querySelectorAll<HTMLElement>("button,summary")].find(el => el.getAttribute("aria-label") === label || el.textContent?.trim() === label);
  expect(element, label).toBeTruthy();
  await act(async () => element!.click());
};
const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const waitSearch = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 280)); }); };
const render = async () => { await act(async () => root.render(<CloudAgents onClose={vi.fn()}/>)); };
beforeEach(() => {
  localStorage.clear();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  runtimeCapabilities.mobile = false; running = false;
  vi.mocked(imageUpload).mockReset();
  vi.mocked(outbox).mockClear();
  vi.mocked(loadComposerDrafts).mockReset().mockResolvedValue(new Map());
  vi.mocked(saveComposerDraft).mockReset().mockResolvedValue();
  window.history.replaceState({ hubMobileRoute: "agents" }, "");
  entries = [
    { id: "one", title: "设计复核", updated: Date.now(), archived: false, preview: "已找到参考依据", status: "completed", matches: true },
    { id: "two", title: "已归档的记录", updated: Date.now() - 86400000, archived: true, preview: "以前的结果", status: "completed", matches: true },
  ];
  invoke.mockReset().mockImplementation(async (_cmd, { action }) => {
    if (action.op === "config") return { endpoint: "https://example.test", binding: "device" };
    if (action.op === "list") return { threads: entries.map(item => ({ ...item, matches: !action.query || item.title.includes(action.query) || (item.id === "one" && action.query === "正文独有词") })), threadManagement: true, account: { state: "ready", model: "model", plan: "plan" } };
    if (action.op === "materials") return { items: [], more: false };
    if (action.op === "recallMaterials") return { items: [], bundle: null, totalBytes: 0, elapsedMs: 5 };
    const summary = entries.find(item => item.id === action.thread)!;
    const thread = () => ({ ...summary, before: null, turns: [{ id: "turn", seq: 1, text: "原问题", answer: "原回答", attachments: [], status: running ? "running" : "completed" }] });
    if (action.op === "read") return { thread: thread(), account: { state: "ready" } };
    if (action.op === "update") {
      if (action.title !== undefined) summary.title = action.title;
      if (action.archived !== undefined) summary.archived = action.archived;
      return { thread: thread() };
    }
    throw new Error("Unexpected action " + action.op);
  });
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); window.history.replaceState(null, ""); });

it("restores an unsent mobile question after remount without sending it", async () => {
  runtimeCapabilities.mobile = true;
  const saved = new Map();
  vi.mocked(loadComposerDrafts).mockImplementation(async () => new Map(saved));
  vi.mocked(saveComposerDraft).mockImplementation(async (_binding, id, value) => { saved.set(id, value); });
  await render(); await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  await type(node.querySelector("textarea")!, "前门线束待核对项有哪些？");
  await act(async () => root.unmount()); root = createRoot(node);
  await render();
  expect(node.querySelector("textarea")?.value).toBe("前门线束待核对项有哪些？");
  expect(invoke.mock.calls.some(([, args]) => args.action.op === "send")).toBe(false);
});

it("does not replace a saved new-chat draft with the initial empty composer", async () => {
  runtimeCapabilities.mobile = true;
  const draft = { text: "请解释报告中的变化", attachments: [], skillVersion: "", skillPaths: [] };
  vi.mocked(loadComposerDrafts).mockResolvedValue(new Map([["new", draft]]));
  await render();
  expect(node.querySelector("textarea")?.value).toBe(draft.text);
  expect(saveComposerDraft).toHaveBeenCalledWith("device", "new", expect.objectContaining({ text: draft.text }));
  expect(invoke.mock.calls.some(([, args]) => args.action.op === "send")).toBe(false);
});

it("preserves unreadable local drafts and prevents editing over them", async () => {
  runtimeCapabilities.mobile = true;
  vi.mocked(loadComposerDrafts).mockRejectedValue(new Error("unreadable"));
  await render(); await click("新对话");
  expect(node.textContent).toContain("原数据已保留");
  expect(node.querySelector("textarea")).toBeNull();
  expect(saveComposerDraft).not.toHaveBeenCalled();
});

it("opens the real conversation list with summaries, dates and archive counts", async () => {
  await render();
  expect(node.querySelector("textarea")).toBeNull();
  expect(node.textContent).toContain("已找到参考依据");
  expect(node.querySelectorAll("time")).toHaveLength(1);
  expect(node.textContent).toContain("当前 1");
  await click("已归档 1");
  expect(node.textContent).toContain("已归档的记录");
  expect(node.textContent).not.toContain("已找到参考依据");
});
it("opens connection settings directly without restoring a chat or submitting credentials",async()=>{
 const close=vi.fn();await act(async()=>root.render(<CloudAgents initialSettings onClose={close}/>));
 expect(node.querySelector('input[type="url"]')?.getAttribute("type")).toBe("url");
 expect(node.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe("https://example.test");
 expect(node.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
 expect(node.textContent).toContain("设备密钥");expect(outbox).not.toHaveBeenCalled();
 expect(invoke.mock.calls.some(c=>["connect","send"].includes(c[1].action.op))).toBe(false);
 await click("返回语音速记");expect(close).toHaveBeenCalledOnce();expect(node.querySelector(".cloud-agents-home")).toBeNull();
});

it("searches real message matches and preserves query, scroll and chat drafts on return", async () => {
  await render();
  await type(node.querySelector('input[type="search"]')!, "正文独有词"); await waitSearch();
  expect(invoke.mock.calls.some(([, args]) => args.action.op === "list" && args.action.query === "正文独有词")).toBe(true);
  expect(node.querySelector(".cloud-agents-thread")?.textContent).toContain("设计复核");
  const home = node.querySelector<HTMLDivElement>(".cloud-agents-home")!;
  home.scrollTop = 120; await act(async () => home.dispatchEvent(new Event("scroll", { bubbles: true })));
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  expect(node.textContent).toContain("原回答");
  await type(node.querySelector("textarea")!, "尚未发送的内容");
  await click("对话列表");
  expect(node.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("正文独有词");
  expect(node.querySelector<HTMLDivElement>(".cloud-agents-home")?.scrollTop).toBe(120);
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  expect(node.querySelector("textarea")?.value).toBe("尚未发送的内容");
  expect(invoke.mock.calls.some(([, args]) => args.action.op === "send")).toBe(false);
});

it("renames and archives on the server, and restores before allowing follow-up", async () => {
  await render();
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  await click("会话选项"); await click("重命名");
  await type(node.querySelector('.cloud-agents-rename input')!, "新的名称"); await click("保存名称");
  expect(entries[0].title).toBe("新的名称");
  await click("归档会话");
  expect(entries[0].archived).toBe(true);
  expect(node.querySelector(".cloud-agents-home")).not.toBeNull();
  await click("已归档 2");
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  expect(node.querySelector("textarea")?.disabled).toBe(true);
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-archived button")!.click());
  expect(node.querySelector("textarea")?.disabled).toBe(false);
  expect(entries[0].archived).toBe(false);
});

it("keeps original messages and the rename input when the server rejects an update", async () => {
  const handler = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd, args) => args.action.op === "update" ? Promise.reject(new Error("云端暂时不可用")) : handler(cmd, args));
  await render(); await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  await click("会话选项"); await click("重命名"); await type(node.querySelector('.cloud-agents-rename input')!, "保留待重试名称"); await click("保存名称");
  expect(node.textContent).toContain("云端暂时不可用");
  expect(node.querySelector<HTMLInputElement>('.cloud-agents-rename input')?.value).toBe("保留待重试名称");
  expect(node.textContent).toContain("原回答"); expect(entries[0].title).toBe("设计复核");
});

it("returns to the list on Android back without leaving the Agents route", async () => {
  runtimeCapabilities.mobile = true;
  await render(); await click("新对话");
  expect(window.history.state.hubCloudAgentChat).toBe(true);
  await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(node.querySelector(".cloud-agents-home")).not.toBeNull();
  expect(window.history.state.hubMobileRoute).toBe("agents");
});

it("keeps the mobile chat-close action separate from leaving the Agents page", async () => {
  runtimeCapabilities.mobile = true;
  const onClose = vi.fn();
  await act(async () => root.render(<CloudAgents onClose={onClose} />));
  const returnToList = async () => {
    const popped = new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true }));
    await click("会话选项");
    await click("会话列表");
    await act(async () => { await popped; });
  };
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  await type(node.querySelector("textarea")!, "保留这条尚未发送的草稿");
  await returnToList();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  expect(node.querySelector("textarea")?.value).toBe("保留这条尚未发送的草稿");
  await returnToList(); await click("关闭云端助手");
  expect(onClose).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.some(([, args]) => args.action.op === "send")).toBe(false);
});

it("disables archive while a real turn is still running", async () => {
  running = true;
  await render(); await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  await click("会话选项");
  expect([...node.querySelectorAll("button")].find(el => el.textContent === "归档会话")?.disabled).toBe(true);
});

it("keeps a new draft separate from the selected historical conversation", async () => {
  await render(); await click("新对话"); await type(node.querySelector("textarea")!, "新会话草稿");
  await click("对话列表"); await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  expect(node.querySelector("textarea")?.value).toBe("");
  await click("对话列表"); await click("新对话");
  expect(node.querySelector("textarea")?.value).toBe("新会话草稿");
});

it("ignores an older search result that arrives after the new query", async () => {
  const handler = invoke.getMockImplementation()!;
  let resolveOld: (value: unknown) => void = () => {};
  invoke.mockImplementation((cmd, args) => args.action.op === "list" && args.action.query === "旧查询" ? new Promise(resolve => { resolveOld = resolve; }) : handler(cmd, args));
  await render(); await type(node.querySelector('input[type="search"]')!, "旧查询"); await waitSearch();
  await type(node.querySelector('input[type="search"]')!, "正文独有词"); await waitSearch();
  await act(async () => resolveOld({ threads: [], threadManagement: true, account: { state: "ready" } }));
  expect(node.querySelector(".cloud-agents-thread")?.textContent).toContain("设计复核");
});

it("keeps the photo visible and reconciles a lost upload receipt even before the thread reaches the list", async () => {
  runtimeCapabilities.mobile = true;
  const handler = invoke.getMockImplementation()!;
  let submitted: { thread: string; turn: string } | undefined;
  let delivered = false;
  invoke.mockImplementation((cmd, args) => {
    const { action } = args;
    if (action.op === "send") {
      submitted = action;
      return Promise.reject(new Error("无法连接 VPS"));
    }
    if (action.op === "read" && action.thread === submitted?.thread) {
      if (!delivered) return Promise.resolve({ thread: null });
      return Promise.resolve({ thread: {
        id: submitted?.thread, title: "附件对话", before: null,
        turns: [{ id: submitted?.turn, text: "", answer: "原图片已收到", status: "completed", attachments: [{ id: "photo", name: "截图.jpg" }] }],
      } });
    }
    return handler(cmd, args);
  });
  vi.mocked(imageUpload).mockResolvedValue({ name: "截图.jpg", mime: "image/jpeg", data: "/9j/" });

  await render();
  await click("新对话");
  await click("添加照片或资料");
  const input = node.querySelector<HTMLInputElement>('input[aria-label="选择图片"]')!;
  Object.defineProperty(input, "files", { value: [new File(["fixture"], "截图.jpg", { type: "image/jpeg" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(node.querySelector(".cloud-agents-compose .cloud-agent-thumbnail")).not.toBeNull();
  await click("发送");
  expect(node.querySelector(".is-pending .cloud-agent-thumbnail")).not.toBeNull();
  expect(node.textContent).toContain("正在确认是否送达");
  expect(node.textContent).not.toContain("无法连接 VPS");

  delivered = true;
  await click("查询原结果");
  expect(node.textContent).toContain("原图片已收到");
  expect(node.querySelector(".is-pending")).toBeNull();
  expect(node.textContent).not.toContain("正在确认是否送达");
  expect(invoke.mock.calls.filter(([, args]) => args.action.op === "send")).toHaveLength(1);
  expect(outbox).toHaveBeenCalledWith("device", null, submitted?.turn);
});

it("shows inline collapsible process, single model trigger, and secondary materials/results views on mobile", async () => {
  runtimeCapabilities.mobile = true;
  const handler = invoke.getMockImplementation()!;
  invoke.mockImplementation((cmd, args) => args.action.op === "read" ? Promise.resolve({ thread: {
    ...entries[0], before: null, turns: [{
      id: "turn", seq: 1, text: "原问题", answer: "从照片得出的回答", status: "completed",
      progress: { startedAt: 1000, finishedAt: 4000, summary: ["核对图片中的日期。"], updates: ["已读取用户选定的图片。"] },
      attachments: [{ id: "photo", name: "截图.jpg" }],
    }],
  } }) : handler(cmd, args));
  await render();
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  // Only one model trigger exists in the mobile chat view (no duplicate in composer).
  expect(node.querySelectorAll('button[aria-label="选择模型"]')).toHaveLength(1);
  // Collapsible process expands in place without a modal dialog.
  await click("查看运行过程");
  expect(node.querySelector('[role="dialog"]')).toBeNull();
  expect(node.textContent).toContain("已读取用户选定的图片。");
  expect(node.textContent).toContain("模型公开摘要");
  expect(node.textContent).toContain("核对图片中的日期。");
  expect(node.textContent).toContain("3 秒");
  await click("查看运行过程");
  expect(node.textContent).not.toContain("已读取用户选定的图片。");
  // Secondary materials/results views remain reachable from the session menu.
  await click("会话选项");
  await click("查看会话材料");
  expect(node.querySelector('[aria-label="会话材料"]')?.textContent).toContain("截图.jpg");
  expect(node.querySelector(".cloud-agents-compose")).toBeNull();
  await click("会话选项");
  await click("查看会话成果");
  expect(node.querySelector('[aria-label="会话成果"]')?.textContent).toContain("从照片得出的回答");
  await click("返回对话");
  expect(node.querySelector(".cloud-agents-compose")).not.toBeNull();
  expect(invoke.mock.calls.some(([, args]) => args.action.op === "send")).toBe(false);
});


it("persists the chosen model in the outbox and reuses it with the original turn on retry", async () => {
  runtimeCapabilities.mobile = true;
  const previous = invoke.getMockImplementation()!;
  const catalog = [{model:"gpt-test",displayName:"Test",isDefault:true,defaultReasoningEffort:"low",supportedReasoningEfforts:[{reasoningEffort:"low"}]},{model:"gpt-other",displayName:"Other",defaultReasoningEffort:"high",supportedReasoningEfforts:[{reasoningEffort:"high"}]}];
  invoke.mockImplementation(async (command,args) => {
    const action=args.action;
    if(action.op==="list") return {threads:[],account:{state:"ready"},modelSelection:true,modelCatalog:{state:"ready",models:catalog}};
    if(action.op==="read") return {thread:null};
    if(action.op==="send") return {delivery:"unknown"};
    return previous(command,args);
  });
  await render(); await click("新对话");
  await type(node.querySelector("textarea")!,"Retain this pending message");
  await click("选择模型"); await click("GPT-other");
  expect(node.querySelector("textarea")?.value).toBe("Retain this pending message");
  expect(invoke.mock.calls.some(([,args])=>args.action.op==="send")).toBe(false);
  await click("发送");
  const first=invoke.mock.calls.find(([,args])=>args.action.op==="send")![1].action;
  expect(first.message.selection).toEqual({model:"gpt-other",effort:"high"});
  expect(vi.mocked(outbox).mock.calls.some(([,draft])=>draft && draft.turn===first.turn && draft.selection?.model==="gpt-other")).toBe(true);
  await click("用原编号重试");
  const sent=invoke.mock.calls.filter(([,args])=>args.action.op==="send").map(([,args])=>args.action);
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
});

it("keeps a draft unsent if the gateway no longer accepts model selections", async () => {
  runtimeCapabilities.mobile = true;
  const previous=invoke.getMockImplementation()!; let compatible=true;
  invoke.mockImplementation(async (command,args)=> args.action.op==="list" ? {threads:[],account:{state:"ready"},modelSelection:compatible,modelCatalog:{state:"ready",models:[{model:"gpt-test",displayName:"Test",isDefault:true,defaultReasoningEffort:"low",supportedReasoningEfforts:[{reasoningEffort:"low"}]}]}} : previous(command,args));
  await render(); await click("新对话"); await type(node.querySelector("textarea")!,"Unsent after service change");
  compatible=false; await click("发送");
  expect(node.querySelector("textarea")?.value).toBe("Unsent after service change");
  expect(node.textContent).toContain("当前云端不支持模型切换");
  expect(invoke.mock.calls.some(([,args])=>args.action.op==="send")).toBe(false);
  expect(vi.mocked(outbox).mock.calls.some(([,draft])=>Boolean(draft))).toBe(false);
});

it("returns to the list on the first attempt when another visit left stale chat history flags", async () => {
  runtimeCapabilities.mobile=true;
  window.history.replaceState({hubMobileRoute:"browse",hubCloudAgentChat:true},"");
  window.history.pushState({hubMobileRoute:"agents",hubCloudAgentChat:true},"");
  await render();
  await act(async()=>node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  expect(node.querySelector("textarea")).not.toBeNull();
  await click("会话选项");
  await click("会话列表");
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
  expect(node.querySelector(".cloud-agents-home")).not.toBeNull();
  expect(node.querySelector("textarea")).toBeNull();
});

it("places mobile connection status in the assistant header and opens real settings", async () => {
  runtimeCapabilities.mobile = true;
  await render();
  expect(node.querySelector(".cloud-agents-header h1")?.textContent).toBe("云端助手");
  expect(node.querySelector(".cloud-agents-connection-card")).toBeNull();
  const connection=node.querySelector<HTMLButtonElement>(".cloud-agents-home-connection")!;
  expect(connection.textContent).toContain("个人云端");
  await act(async()=>connection.click());
  expect(node.querySelector("input[type=url]")).not.toBeNull();
  await click("返回并重新读取");
  expect(node.querySelector(".cloud-agents-home")).not.toBeNull();
});

it("restores the last mobile report view from disk as an expanded inline handoff without starting a model",async()=>{
 runtimeCapabilities.mobile=true;
 localStorage.setItem("hub-cloud-last:device",JSON.stringify({thread:"one",view:"results"}));
 const handler=invoke.getMockImplementation()!;
 const handoff={id:"one",thread:"one",state:"published",createdAt:1000,publishedAt:2000,manifest:{version:1,title:"桌面两版比较",origin:{workId:"work-one",artifactId:"artifact-one",executionId:"analysis-one",revision:2,generatedAt:"2026-11-18T01:00:00Z",inputs:[{title:"原表.xlsx",sha256:"a".repeat(64)}]},files:[],report:{name:"报告.md",sha256:"b".repeat(64),text:"桌面报告：新增7项，需核对备注。"}}};
 invoke.mockImplementation(async(cmd,args)=>args.action.op==="read"?{thread:{...entries[0],turns:[],before:null,handoff},cached:true,cachedAt:1794963600000,account:{state:"ready"}}:handler(cmd,args));
 await render();
 expect(node.querySelector('.bw-handoff-toggle')?.getAttribute("aria-expanded")).toBe("true");
 expect(node.textContent).toContain("桌面报告：新增7项");expect(node.textContent).toContain("显示本机缓存");
 expect(node.textContent).not.toContain("正在读取对话");expect(JSON.parse(localStorage.getItem("hub-cloud-last:device")!).view).toBe("results");
 expect(invoke.mock.calls.some(([,a])=>a.action.op==="send")).toBe(false);
});

it("supports auto-rag recall, aborts safely on recall failure, and reuses frozen bundle on retry", async () => {
  runtimeCapabilities.mobile = true;
  const previous = invoke.getMockImplementation()!;
  let failRecall = true;
  const bundle = {
    id: "bundle-rag-1",
    title: "自动关联 1 份资料：混合检索方案",
    source: "本机自动召回 · 1 份 · 0.1 KB",
    text: "【本机自动召回 · 1 份资料】\n\n### [资料1] 混合检索方案（Car）\nP99 延迟 14ms",
    sha256: "sha-rag-1",
  };
  invoke.mockImplementation(async (cmd, args) => {
    const { action } = args;
    if (action.op === "recallMaterials") {
      if (failRecall) throw new Error("索引正忙");
      return { items: [bundle], bundle, totalBytes: 80, elapsedMs: 11 };
    }
    if (action.op === "read") return { thread: null };
    if (action.op === "send") return { delivery: "unknown" };
    return previous(cmd, args);
  });
  await render();
  await click("新对话");
  await type(node.querySelector("textarea")!, "延迟是多少？");
  await click("发送");
  expect(node.textContent).toContain("本机资料检索失败");
  expect(node.querySelector("textarea")?.value).toBe("延迟是多少？");
  expect(invoke.mock.calls.some(([, a]) => a.action.op === "send")).toBe(false);

  failRecall = false;
  await click("发送");
  const sends1 = invoke.mock.calls.filter(([, a]) => a.action.op === "send").map(([, a]) => a.action);
  expect(sends1).toHaveLength(1);
  expect(sends1[0].message.material).toEqual(bundle);
  expect(node.textContent).toContain("本机自动召回 1 篇");

  // Retry must reuse frozen bundle without re-running recallMaterials.
  const recallCountBeforeRetry = invoke.mock.calls.filter(([, a]) => a.action.op === "recallMaterials").length;
  await click("用原编号重试");
  expect(invoke.mock.calls.filter(([, a]) => a.action.op === "recallMaterials")).toHaveLength(recallCountBeforeRetry);
  const sends2 = invoke.mock.calls.filter(([, a]) => a.action.op === "send").map(([, a]) => a.action);
  expect(sends2).toHaveLength(2);
  expect(sends2[1]).toEqual(sends2[0]);
});

it("supports manual multi-material selection with hash verification, cloud-only mode, and rejected draft recovery", async () => {
  runtimeCapabilities.mobile = true;
  const previous = invoke.getMockImplementation()!;
  const docA = { id: "id-a", title: "方案A", source: "Car", text: "内容A", sha256: "sha-a" };
  const docB = { id: "id-b", title: "方案B", source: "Car", text: "内容B", sha256: "sha-b" };
  const packed = {
    id: "bundle-ab",
    title: "已选 2 份资料：方案A、方案B",
    source: "手动指定 · 2 份 · 0.1 KB",
    text: "【手动指定 · 2 份资料】\n\n### [资料1] 方案A（Car）\n内容A\n\n---\n\n### [资料2] 方案B（Car）\n内容B",
    sha256: "sha-ab",
  };
  let rejectNextSend = true;
  invoke.mockImplementation(async (cmd, args) => {
    const { action } = args;
    if (action.op === "materials") {
      return {
        items: [
          { key: { kind: "document", id: "a", libraryId: "car" }, title: "方案A", source: "Car", chars: 3, bytes: 9, preview: "内容A" },
          { key: { kind: "document", id: "b", libraryId: "car" }, title: "方案B", source: "Car", chars: 3, bytes: 9, preview: "内容B" },
        ],
        more: false,
      };
    }
    if (action.op === "material") return action.selection.id === "a" ? docA : docB;
    if (action.op === "prepareMaterials") return { bundle: packed, items: [docA, docB], totalBytes: 120 };
    if (action.op === "read") return { thread: null };
    if (action.op === "send") {
      if (rejectNextSend) { rejectNextSend = false; return { delivery: "rejected", error: "服务端暂时拒绝" }; }
      return { delivery: "accepted", id: action.turn };
    }
    return previous(cmd, args);
  });
  await render();
  await click("新对话");
  await act(async () => {
    [...node.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.includes("手动指定"))!.click();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  const checkboxes = [...node.querySelectorAll<HTMLInputElement>('.bw-multi-material-row input[type="checkbox"]')];
  expect(checkboxes).toHaveLength(2);
  await act(async () => checkboxes[0].click());
  await act(async () => checkboxes[1].click());
  expect(node.textContent).toContain("完成 (2)");
  await click("完成 (2)");
  // Material-only send with empty text and no photo must be disabled (matches server.py).
  expect(node.querySelector<HTMLButtonElement>('button[aria-label="发送"]')?.disabled).toBe(true);
  await type(node.querySelector("textarea")!, "对比这两篇");
  await click("发送");
  const prepareCall = invoke.mock.calls.find(([, a]) => a.action.op === "prepareMaterials")![1].action;
  expect(prepareCall.expectedSha256).toEqual(["sha-a", "sha-b"]);
  const sentManual = invoke.mock.calls.find(([, a]) => a.action.op === "send")![1].action;
  expect(sentManual.message.material).toEqual(packed);
  expect(sentManual.message.sourceMaterials).toBeUndefined();

  // Rejected multi-material turn restores individual editable materials with keys.
  await click("放回输入框");
  expect(node.querySelector("textarea")?.value).toBe("对比这两篇");
  expect(node.querySelectorAll(".bw-draft-chip")).toHaveLength(2);

  // Switching to cloud-only sends without calling recallMaterials and without attaching material.
  const recallBeforeCloudOnly = invoke.mock.calls.filter(([, a]) => a.action.op === "recallMaterials").length;
  await act(async () => {
    [...node.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.includes("纯云端"))!.click();
  });
  await click("发送");
  expect(invoke.mock.calls.filter(([, a]) => a.action.op === "recallMaterials")).toHaveLength(recallBeforeCloudOnly);
  const cloudOnlySend = invoke.mock.calls.filter(([, a]) => a.action.op === "send")[1][1].action;
  expect(cloudOnlySend.message.material).toBeUndefined();
});

it("exits cleanly to list from session sheet, preserves draft on handoff follow-up, and shows each turn's own model", async () => {
  runtimeCapabilities.mobile = true;
  const previous = invoke.getMockImplementation()!;
  const handoff = { id: "one", thread: "one", state: "published", createdAt: 1000, publishedAt: 2000, manifest: { version: 1, title: "桌面压测报告", origin: { workId: "w", artifactId: "a", executionId: "e", revision: 1, generatedAt: "2026-11-27T00:00:00Z", inputs: [] }, files: [], report: { name: "报告.md", sha256: "b".repeat(64), text: "报告正文" } } };
  invoke.mockImplementation(async (cmd, args) => {
    if (args.action.op === "read") {
      return {
        thread: {
          ...entries[0], before: null, handoff,
          turns: [{ id: "t1", seq: 1, text: "旧问题", answer: "旧回答", status: "completed", attachments: [], selection: { model: "gpt-old-sol", effort: "low" } }],
        },
        account: { state: "ready" },
      };
    }
    return previous(cmd, args);
  });
  await render();
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  expect(node.querySelector(".bw-answer-brand")?.textContent).toContain("GPT-old Sol");

  // Handoff quick follow-up must NOT overwrite existing unsent user draft.
  await type(node.querySelector("textarea")!, "我自己的问题草稿");
  await click("展开报告 ↓");
  await click("针对此报告追问");
  expect(node.querySelector("textarea")?.value).toBe("我自己的问题草稿");

  // Session sheet -> "全部会话与搜索" cleanly pops both sheet and chat back to list.
  await click("切换或管理会话");
  expect(node.querySelector('[role="dialog"]')).not.toBeNull();
  await click("返回会话列表");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
  expect(node.querySelector(".cloud-agents-home")).not.toBeNull();
  expect(node.querySelector("textarea")).toBeNull();
});

it("prevents late material picker toggle and in-flight outbox write from polluting another session", async () => {
  runtimeCapabilities.mobile = true;
  const previous = invoke.getMockImplementation()!;
  let releaseMaterial!: (value: unknown) => void;
  invoke.mockImplementation(async (cmd, args) => {
    const { action } = args;
    if (action.op === "materials") {
      return { items: [{ key: { kind: "document", id: "slow", libraryId: "car" }, title: "慢资料", source: "Car", chars: 4, bytes: 12, preview: "慢内容" }], more: false };
    }
    if (action.op === "material") return new Promise(resolve => { releaseMaterial = resolve; });
    return previous(cmd, args);
  });
  await render();
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  await act(async () => {
    [...node.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.includes("手动指定"))!.click();
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  await act(async () => node.querySelector<HTMLInputElement>('.bw-multi-material-row input[type="checkbox"]')!.click());
  // Close picker and switch to a fresh thread before the slow material response arrives.
  await click("完成 (0)");
  await click("会话选项");
  await click("新对话");
  await act(async () => releaseMaterial({ id: "slow-id", title: "慢资料", source: "Car", text: "慢内容", sha256: "sha-slow" }));
  expect(node.querySelectorAll(".bw-draft-chip")).toHaveLength(0);
});

it("respects selectedLibraryIds in auto-rag, blocks zero-library recall without falling back, and opens scope selector", async () => {
  runtimeCapabilities.mobile = true;
  const previous = invoke.getMockImplementation()!;
  const recallCalls: Record<string, unknown>[] = [];
  invoke.mockImplementation(async (cmd, args) => {
    const { action } = args;
    if (action.op === "recallMaterials") {
      recallCalls.push(action);
      return { bundle: null, items: [], totalBytes: 0, elapsedMs: 5 };
    }
    return previous(cmd, args);
  });
  const openScope = vi.fn();
  // 1) Explicit empty library scope ([]) must block recall rather than searching all libraries.
  await act(async () => root.render(
    <CloudAgents selectedLibraryIds={[]} scopeLabel="未选资料库 (0/2)" onOpenScope={openScope} />,
  ));
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  const scopeBtn = node.querySelector<HTMLButtonElement>(".bw-composer-scope-btn")!;
  expect(scopeBtn.textContent).toContain("未选资料库 (0/2)");
  await act(async () => scopeBtn.click());
  expect(openScope).toHaveBeenCalledOnce();
  await type(node.querySelector("textarea")!, "请查一下架构笔记");
  await click("发送");
  expect(recallCalls).toHaveLength(0);
  expect(node.textContent).toContain("0 个资料库");
  expect(node.querySelector("textarea")?.value).toBe("请查一下架构笔记");

  // 2) Subset scope passes spaceIds to recallMaterials.
  await act(async () => root.render(
    <CloudAgents selectedLibraryIds={["craft-1"]} scopeLabel="Craft" onOpenScope={openScope} />,
  ));
  await click("发送");
  expect(recallCalls).toHaveLength(1);
  expect(recallCalls[0].spaceIds).toEqual(["craft-1"]);
});

it("aborts auto-rag send if library scope changes mid-recall and avoids duplicate history entry on return from tasks", async () => {
  runtimeCapabilities.mobile = true;
  const previous = invoke.getMockImplementation()!;
  let releaseRecall!: (value: unknown) => void;
  invoke.mockImplementation(async (cmd, args) => {
    const { action } = args;
    if (action.op === "recallMaterials") {
      return new Promise(resolve => { releaseRecall = resolve; });
    }
    return previous(cmd, args);
  });
  await act(async () => root.render(<CloudAgents selectedLibraryIds={null} scopeLabel="全部资料库" />));
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  await type(node.querySelector("textarea")!, "范围变更边界测试");
  await act(async () => {
    [...node.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === "发送")!.click();
  });
  await act(async () => { await Promise.resolve(); });
  // Narrow scope while recallMaterials is still in flight.
  await act(async () => root.render(<CloudAgents selectedLibraryIds={["craft-1"]} scopeLabel="Craft" />));
  await act(async () => releaseRecall({
    items: [{ id: "old", title: "旧库笔记", source: "Other", text: "旧内容", sha256: "h" }],
    bundle: { id: "old", title: "旧库笔记", source: "本机自动召回 · 1 份 · 0.1 KB", text: "旧内容", sha256: "h" },
    totalBytes: 12,
    elapsedMs: 4,
  }));
  expect(invoke.mock.calls.some(([, a]) => a.action.op === "send")).toBe(false);
  expect(node.textContent).toContain("资料库范围已变更");
  expect(node.querySelector("textarea")?.value).toBe("范围变更边界测试");

  // Returning to an already-owned chat history entry must NOT push a duplicate chat entry.
  const owner = window.history.state?.hubCloudAgentOwner;
  expect(typeof owner).toBe("string");
  const pushSpy = vi.spyOn(window.history, "pushState");
  try {
    await act(async () => root.render(<CloudAgents key="remount-return" selectedLibraryIds={["craft-1"]} scopeLabel="Craft" />));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(pushSpy).not.toHaveBeenCalled();
    expect(node.querySelector("textarea")).not.toBeNull();
  } finally {
    pushSpy.mockRestore();
    window.history.replaceState({}, "");
  }
});

it("clears already visible cloud content when device access is rejected",async()=>{
 await render();await act(async()=>node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());expect(node.textContent).toContain("原回答");
 const handler=invoke.getMockImplementation()!;invoke.mockImplementation(async(cmd,args)=>args.action.op==="read"?{thread:null,accessDenied:true,error:"设备密钥已被撤销"}:handler(cmd,args));
 await act(async()=>window.dispatchEvent(new Event("online")));
 expect(node.textContent).not.toContain("原回答");expect(node.querySelector(".cloud-agents-home")).not.toBeNull();
});
it("renders cloud answer tables with actual header and value cells",async()=>{
 const handler=invoke.getMockImplementation()!;
 invoke.mockImplementation(async(cmd,args)=>args.action.op==="read"?{thread:{...entries[0],before:null,turns:[{id:"turn",seq:1,text:"数量和变化",answer:"| 变化 | 数量 |\n|---|---:|\n| 新增 | 7 |\n| 删除 | 0 |",attachments:[],status:"completed"}]},account:{state:"ready"}}:handler(cmd,args));
 await render();await act(async()=>node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
 const region=node.querySelector<HTMLElement>('[role="region"][aria-label="表格，可横向滚动"]');
 expect(region?.tabIndex).toBe(0);expect(region?.querySelectorAll('thead th')).toHaveLength(2);
 expect([...region!.querySelectorAll('tbody td')].map(cell=>cell.textContent)).toEqual(["新增","7","删除","0"]);
});
