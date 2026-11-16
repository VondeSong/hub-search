// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CloudAgents from "./CloudAgents";
import { imageUpload, outbox } from "./CloudAgentMedia";
import { runtimeCapabilities } from "./RuntimePlatform";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./CloudAgentMedia", () => ({ outbox: vi.fn(async () => undefined), uploadSize: () => 0, imageUpload: vi.fn(), videoUploads: vi.fn() }));
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: { mobile: false } }));

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
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  runtimeCapabilities.mobile = false; running = false;
  vi.mocked(imageUpload).mockReset();
  vi.mocked(outbox).mockClear();
  window.history.replaceState({ hubMobileRoute: "agents" }, "");
  entries = [
    { id: "one", title: "设计复核", updated: Date.now(), archived: false, preview: "已找到参考依据", status: "completed", matches: true },
    { id: "two", title: "已归档的记录", updated: Date.now() - 86400000, archived: true, preview: "以前的结果", status: "completed", matches: true },
  ];
  invoke.mockReset().mockImplementation(async (_cmd, { action }) => {
    if (action.op === "config") return { endpoint: "https://example.test", binding: "device" };
    if (action.op === "list") return { threads: entries.map(item => ({ ...item, matches: !action.query || item.title.includes(action.query) || (item.id === "one" && action.query === "正文独有词") })), threadManagement: true, account: { state: "ready", model: "model", plan: "plan" } };
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
    await act(async () => { node.querySelector<HTMLButtonElement>('button[aria-label="返回会话列表"]')!.click(); await popped; });
  };
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  await type(node.querySelector("textarea")!, "保留这条尚未发送的草稿");
  await returnToList();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => node.querySelector<HTMLButtonElement>(".cloud-agents-thread")!.click());
  expect(node.querySelector("textarea")?.value).toBe("保留这条尚未发送的草稿");
  await returnToList(); await click("关闭云端 Agents");
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

it("shows real cloud materials, completed results and the public process in the mobile views", async () => {
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
  await click("查看运行过程");
  const dialog = node.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("已读取用户选定的图片。");
  expect(dialog.textContent).toContain("模型公开摘要");
  expect(dialog.textContent).toContain("核对图片中的日期。");
  expect(dialog.textContent).toContain("3 秒");
  const back = new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true, capture: true }));
  await click("关闭");
  await act(async () => back);
  await click("材料");
  expect(node.querySelector('[aria-label="会话材料"]')?.textContent).toContain("截图.jpg");
  expect(node.querySelector(".cloud-agents-compose")).toBeNull();
  await click("成果");
  expect(node.querySelector('[aria-label="会话成果"]')?.textContent).toContain("从照片得出的回答");
  await click("对话");
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
  await click("返回会话列表");
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
  expect(node.querySelector(".cloud-agents-home")).not.toBeNull();
  expect(node.querySelector("textarea")).toBeNull();
});
