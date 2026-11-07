// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { CodexAccountBadge, CodexAccountsSettings } from "./CodexAccountsSettings";
import { getCodexAccountSnapshot, refreshCodexAccounts, resetCodexAccountsForTests, selectCodexAccount, type CodexAccountSnapshot } from "./CodexAccounts";
const { invoke, openUrl } = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("./WindowVisibility", () => ({ isWindowVisible: () => true, subscribeWindowVisibility: () => () => {} }));
let root: Root, host: HTMLDivElement, snapshot: CodexAccountSnapshot;
const a = { label: "a***@example.invalid", scopeId: "a".repeat(64), plan: "plus", kind: "chatgpt" };
const b = { label: "b***@example.invalid", scopeId: "b".repeat(64), plan: "pro", kind: "chatgpt" };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); resetCodexAccountsForTests();
  snapshot = { selected: "desktop", current: a, accounts: [{ id: "profile-b", ...b }] };
  invoke.mockReset().mockImplementation(async (_command, { args }) => {
    if (args.action === "codexAccounts") return structuredClone(snapshot);
    if (args.action === "selectCodexAccount") { snapshot = { ...snapshot, selected: args.id, current: args.id === "desktop" ? a : b }; return { selected: args.id }; }
    if (args.action === "startCodexLogin") return { id: "login-1", state: "pending", authUrl: "https://auth.openai.com/oauth/authorize?state=synthetic" };
    if (args.action === "cancelCodexLogin") { snapshot = { ...snapshot, login: { id: args.id, state: "cancelled" } }; return { requested: true }; }
    return {};
  });
  openUrl.mockReset().mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetCodexAccountsForTests(); vi.useRealTimers(); });
const click = async (text: string) => { const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === text)!; await act(async () => button.click()); };
const mount = async () => { await act(async () => root.render(<CodexAccountsSettings />)); };
const choose = async () => { const select = host.querySelector("select")!; await act(async () => { select.value = "profile-b"; select.dispatchEvent(new Event("change", { bubbles: true })); }); };
it("shows the masked active identity and separates choosing from applying an account", async () => {
  await mount(); expect(host.textContent).toContain(a.label);
  await choose();
  expect(invoke.mock.calls.some(([,p]) => p.args.action === "selectCodexAccount")).toBe(false);
  expect(host.querySelector<HTMLInputElement>('input[type="radio"]')?.checked).toBe(false);
  const changed = vi.fn(); window.addEventListener("hub:agent-account-changed", changed);
  try { await click("切换账号"); expect(getCodexAccountSnapshot().selected).toBe("profile-b"); expect(changed.mock.calls[0][0].detail).toMatchObject({ newConversation: false, fromScopeId: a.scopeId, scopeId: b.scopeId }); }
  finally { window.removeEventListener("hub:agent-account-changed", changed); }
  expect(invoke.mock.calls.some(([,p]) => ["create","respond","resume"].includes(p.args.action))).toBe(false);
});
it("still allows an explicit independent chat instead of the shared-history default", async () => {
  await mount(); await choose();
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0].click());
  const changed = vi.fn(); window.addEventListener("hub:agent-account-changed", changed);
  try { await click("切换账号"); expect(changed.mock.calls[0][0].detail.newConversation).toBe(true); }
  finally { window.removeEventListener("hub:agent-account-changed", changed); }
});
it("opens official login, supports cancellation, and never activates a newly added account automatically", async () => {
  await mount(); await click("添加账号");
  expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://auth.openai.com/oauth/authorize?state=synthetic");
  expect(getCodexAccountSnapshot().selected).toBe("desktop");
  expect(host.textContent).toContain("不会自动切换");
  await click("取消登录");
  expect(invoke).toHaveBeenCalledWith("model_runtime", { args: { action: "cancelCodexLogin", id: "login-1" } });
  expect(getCodexAccountSnapshot().selected).toBe("desktop");
});
it("rejects an unexpected login destination without opening it", async () => {
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command,p) => p.args.action === "startCodexLogin" ? Promise.resolve({ id: "login-1", state: "pending", authUrl: "https://evil.invalid/login" }) : original(command,p));
  await mount(); await click("添加账号");
  expect(openUrl).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')?.textContent).toContain("官方地址");
});
it("an older account refresh cannot overwrite a newer explicit selection", async () => {
  await mount();
  let release!: (v: CodexAccountSnapshot) => void;
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockImplementation(original);
  let old!: Promise<void>;
  await act(async () => { old = refreshCodexAccounts(); });
  await act(async () => selectCodexAccount("profile-b", true));
  await act(async () => { release({ selected: "desktop", current: a, accounts: snapshot.accounts }); await old; });
  expect(getCodexAccountSnapshot().selected).toBe("profile-b"); expect(getCodexAccountSnapshot().current?.scopeId).toBe(b.scopeId);
});
it("an account change in follow mode continues the current chat with necessary history", async () => {
  await mount(); const changed = vi.fn(); window.addEventListener("hub:agent-account-changed", changed);
  try { snapshot = { ...snapshot, current: b }; await act(async () => refreshCodexAccounts()); expect(changed.mock.calls[0][0].detail).toMatchObject({ newConversation: false, fromScopeId: a.scopeId, scopeId: b.scopeId }); }
  finally { window.removeEventListener("hub:agent-account-changed", changed); }
});
it("stops account polling when the last account widget unmounts", async () => {
  vi.useFakeTimers(); await mount(); await act(async () => root.render(null));
  const count = invoke.mock.calls.length; await act(async () => vi.advanceTimersByTimeAsync(90000));
  expect(invoke).toHaveBeenCalledTimes(count);
});
it("a failed refresh after saving selection never retains the old account identity", async () => {
  await mount(); const original = invoke.getMockImplementation()!;
  invoke.mockImplementation((command,p) => p.args.action === "codexAccounts" ? Promise.reject(Error("临时离线")) : original(command,p));
  await act(async () => selectCodexAccount("profile-b", true));
  expect(getCodexAccountSnapshot().selected).toBe("profile-b"); expect(getCodexAccountSnapshot().current).toBeNull();
  expect(getCodexAccountSnapshot().requestError).toContain("临时离线");
});
it("shows no account notice on initial load or ordinary account refresh",async()=>{
 await act(async()=>root.render(<CodexAccountBadge/>));expect(host.textContent).toBe("");
 snapshot={...snapshot,current:{...a,plan:"pro"}};await act(async()=>refreshCodexAccounts());
 expect(host.textContent).toBe("");expect(getCodexAccountSnapshot().accountNotice).toBeNull();
});
it("announces a verified account change and keeps a dismissed notice hidden across refresh and remount",async()=>{
 await act(async()=>root.render(<div className="agent-composer"><CodexAccountBadge/><textarea aria-label="消息"/></div>));
 await act(async()=>selectCodexAccount("profile-b",false));expect(host.textContent).toContain(`已切换账号：${b.label}`);
 await click("隐藏");expect(host.querySelector('.agent-account-status')).toBeNull();expect(document.activeElement).toBe(host.querySelector('textarea'));
 await act(async()=>refreshCodexAccounts());expect(host.querySelector('.agent-account-status')).toBeNull();
 await act(async()=>root.render(null));await act(async()=>root.render(<CodexAccountBadge/>));expect(host.textContent).toBe("");
 await act(async()=>selectCodexAccount("desktop",false));expect(host.textContent).toContain(a.label);
});
it("changing login sources without changing the actual principal does not announce a switch",async()=>{
 await act(async()=>root.render(<CodexAccountBadge/>));
 const original=invoke.getMockImplementation()!;
 invoke.mockImplementation((command,p)=>{if(p.args.action==="selectCodexAccount"){snapshot={...snapshot,selected:p.args.id,current:a};return Promise.resolve({selected:p.args.id});}return original(command,p);});
 await act(async()=>selectCodexAccount("profile-b",false));expect(host.textContent).toBe("");
});
it("a desktop account change is announced, while signing back into the same account is silent",async()=>{
 await act(async()=>root.render(<CodexAccountBadge/>));snapshot={...snapshot,current:null};await act(async()=>refreshCodexAccounts());
 snapshot={...snapshot,current:a};await act(async()=>refreshCodexAccounts());expect(host.textContent).toBe("");
 snapshot={...snapshot,current:b};await act(async()=>refreshCodexAccounts());expect(host.textContent).toContain(b.label);
});
it("history authorization stays available when the optional switch notice is hidden",async()=>{
 await act(async()=>root.render(<CodexAccountBadge workId="work-a" boundScopeId={b.scopeId} needsAuthorization/>));
 expect(host.textContent).toContain("允许当前账号读取本对话历史");expect(host.textContent).not.toContain("已切换账号");
});
