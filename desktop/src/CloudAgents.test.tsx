// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CloudAgents from "./CloudAgents";
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
