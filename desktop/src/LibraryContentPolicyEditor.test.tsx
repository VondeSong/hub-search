// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryContentPolicyEditor } from "./LibraryContentPolicyEditor";
import { INHERIT_LIBRARY_POLICY, type LibraryContentPolicy, type LibraryPolicySnapshot } from "./LibraryManagement";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const globalPolicy: LibraryContentPolicy = { imageDownload: true, imageOcr: true, pdfDownload: true, pdfText: true, pdfOcr: false, otherDownload: false, outgoingAttachments: true };
const capabilities = { imageDownload: true, imageOcr: true, pdfDownload: true, pdfText: true, pdfOcr: true, otherDownload: true, outgoingAttachments: true };
const snapshot = (libraryId?: string): LibraryPolicySnapshot => ({ libraryId: libraryId || null, provider: libraryId ? "craft" : "global", global: globalPolicy, effective: globalPolicy, overrides: { ...INHERIT_LIBRARY_POLICY }, capabilities });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { mocks.invoke.mockReset(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const change = async (label: string, value: string) => { const field = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; await act(async () => { field.value = value; field.dispatchEvent(new Event("change", { bubbles: true })); }); };
const click = async (text: string) => { await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === text)!.click()); };

it("saves OCR independently from downloads and refreshes legacy settings without automatically supplementing", async () => {
  const saved = vi.fn();
  mocks.invoke.mockImplementation(async (_command, payload) => payload.args.action === "save" ? { ...snapshot(), global: payload.args.policy } : snapshot());
  await act(async () => root.render(<LibraryContentPolicyEditor onSaved={saved} />));
  await change("图片文字识别", "disabled"); await click("保存内容策略");
  expect(mocks.invoke).toHaveBeenCalledWith("library_content_policy", { args: { action: "save", libraryId: undefined, policy: { ...globalPolicy, imageOcr: false } } });
  expect(saved).toHaveBeenCalledOnce();
  expect(mocks.invoke.mock.calls.some(([, payload]) => payload.args.action === "supplement")).toBe(false);
  expect(container.querySelector<HTMLSelectElement>('[aria-label="下载图片原件"]')?.value).toBe("enabled");
});
it("persists inherit as null and only supplements after an explicit separate action", async () => {
  mocks.invoke.mockImplementation(async (_command, payload) => payload.args.action === "supplement" ? { queued: 4, notice: "已排队" } : payload.args.action === "save" ? { ...snapshot("main"), overrides: payload.args.policy } : snapshot("main"));
  await act(async () => root.render(<LibraryContentPolicyEditor libraryId="main" />));
  await change("PDF 原生文字", "disabled");
  expect([...container.querySelectorAll("button")].find(button => button.textContent === "按当前策略补处理已有内容")?.disabled).toBe(true);
  await click("保存内容策略");
  expect(mocks.invoke).toHaveBeenCalledWith("library_content_policy", { args: { action: "save", libraryId: "main", policy: { ...INHERIT_LIBRARY_POLICY, pdfText: false } } });
  await click("按当前策略补处理已有内容");
  expect(mocks.invoke).toHaveBeenCalledWith("library_content_policy", { args: { action: "supplement", libraryId: "main" } });
});
it("does not present unsupported Feishu capabilities as usable controls", async () => {
  mocks.invoke.mockResolvedValue({ ...snapshot("feishu"), provider: "feishu", capabilities: Object.fromEntries(Object.keys(capabilities).map(key => [key, false])) });
  await act(async () => root.render(<LibraryContentPolicyEditor libraryId="feishu" />));
  expect([...container.querySelectorAll("select")].every(field => field.disabled)).toBe(true);
  expect(container.textContent).toContain("此来源暂不支持");
  expect(container.textContent).not.toContain("按当前策略补处理已有内容");
});
it("reports failed reads through the bottom notice channel and allows a retry", async () => {
  const notice = vi.fn(); window.addEventListener("hub:operation-status", notice);
  mocks.invoke.mockRejectedValueOnce(Error("连接暂时不可用")).mockResolvedValue(snapshot());
  await act(async () => root.render(<LibraryContentPolicyEditor />));
  expect((notice.mock.calls[0][0] as CustomEvent).detail.text).toContain("连接暂时不可用");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await click("重新读取内容策略"); expect(container.querySelectorAll("select")).toHaveLength(7);
  window.removeEventListener("hub:operation-status", notice);
});
it("shows automatic originals for Craft while keeping OCR separately editable", async () => {
  mocks.invoke.mockResolvedValue(snapshot("craft"));
  await act(async () => root.render(<LibraryContentPolicyEditor libraryId="craft" />));
  expect(container.textContent).toContain("原件自动保存在当前 Hub 数据目录");
  expect(container.querySelector('[aria-label="下载图片原件"]')).toBeNull();
  expect(container.querySelector('[aria-label="下载 PDF 原件"]')).toBeNull();
  expect(container.querySelector('[aria-label="视频与其他附件下载"]')).toBeNull();
  expect(container.querySelector<HTMLSelectElement>('[aria-label="图片文字识别"]')?.disabled).toBe(false);
});
