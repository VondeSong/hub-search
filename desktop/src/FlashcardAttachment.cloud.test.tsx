// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import tauriConfigText from "../src-tauri/tauri.conf.json?raw";
const { invokeMock, saveMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), saveMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));
import { FlashcardAttachment } from "./FlashcardAttachment";
let container: HTMLDivElement;
let root: Root;
const item = { title: "证据.txt", mimeType: "text/plain", url: `http://craft-media.localhost/${"a".repeat(64)}` };
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.includes(text))!;
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  invokeMock.mockReset(); saveMock.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<FlashcardAttachment item={item} />));
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  delete document.documentElement.dataset.runtimePlatform;
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
it("starts a durable native Android save only after verified attachment download", async () => {
  document.documentElement.dataset.runtimePlatform = "android";
  let finish!: () => void;
  invokeMock.mockImplementation((name: string) => name === "ensure_flashcard_cloud_attachment" ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve());
  await act(async () => button("保存").click());
  expect(saveMock).not.toHaveBeenCalled();
  expect(invokeMock.mock.calls.map(([name]) => name)).toEqual(["ensure_flashcard_cloud_attachment"]);
  await act(async () => finish());
  expect(invokeMock).toHaveBeenLastCalledWith("save_flashcard_attachment", { url: item.url, destination: "", fileName: item.title, mimeType: item.mimeType });
  expect(container.textContent).toContain("请在系统对话框中完成保存");
  expect(container.textContent).not.toContain("附件已保存");
  invokeMock.mockReset(); invokeMock.mockRejectedValue(new Error("附件完整性校验失败"));
  await act(async () => button("保存").click());
  expect(invokeMock.mock.calls.map(([name]) => name)).toEqual(["ensure_flashcard_cloud_attachment"]);
  expect(container.textContent).toContain("附件完整性校验失败");
});
it("waits for a verified cloud download before opening and stops on a failed download", async () => {
  let finish!: () => void;
  invokeMock.mockImplementation((name: string) => name === "ensure_flashcard_cloud_attachment" ? new Promise<void>(r => { finish = r; }) : Promise.resolve());
  await act(async () => button("打开").click());
  expect(invokeMock).toHaveBeenCalledTimes(1); expect(button("打开").disabled).toBe(true);
  await act(async () => finish());
  expect(invokeMock.mock.calls.map(([name]) => name)).toEqual(["ensure_flashcard_cloud_attachment", "open_flashcard_attachment"]);
  invokeMock.mockReset(); invokeMock.mockRejectedValue(new Error("附件完整性校验失败"));
  await act(async () => button("打开").click());
  expect(invokeMock).toHaveBeenCalledTimes(1); expect(container.textContent).toContain("附件完整性校验失败");
});
it("does not download after save cancellation and verifies before exporting", async () => {
  saveMock.mockResolvedValue(null);
  await act(async () => button("保存").click()); expect(invokeMock).not.toHaveBeenCalled();
  saveMock.mockResolvedValue("D:/test-output/证据.txt"); invokeMock.mockResolvedValue(undefined);
  await act(async () => button("保存").click());
  expect(invokeMock.mock.calls.map(([name]) => name)).toEqual(["ensure_flashcard_cloud_attachment", "save_flashcard_attachment"]);
  expect(invokeMock).toHaveBeenLastCalledWith("save_flashcard_attachment", { url: item.url, destination: "D:/test-output/证据.txt" });
});
it.each([
  { platform: "windows", entry: "打开" },
  { platform: "windows", entry: "保存" },
  { platform: "android", entry: "保存" },
  { platform: "android", entry: "下载并离线保留" },
])("refreshes a failed local image after $platform / $entry verification", async ({ platform, entry }) => {
  document.documentElement.dataset.runtimePlatform = platform;
  const imageItem = { ...item, title: "证据.png", mimeType: "image/png" };
  await act(async () => root.render(<FlashcardAttachment item={imageItem} />));
  await act(async () => container.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(button("下载并离线保留")).toBeDefined();
  let finish!: () => void;
  invokeMock.mockImplementation((name: string) => name === "ensure_flashcard_cloud_attachment" ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve());
  saveMock.mockResolvedValue("D:/test-output/证据.png");
  await act(async () => button(entry).click());
  expect(container.querySelector("img")!.getAttribute("src")).toBe(item.url);
  expect(container.textContent).toContain("下载并校验中…");
  await act(async () => finish());
  expect(container.querySelector("img")!.getAttribute("src")).toBe(`${item.url}?download=1`);
  expect(button("下载并离线保留")).toBeUndefined();
});
it("allows the registered local image origin without allowing every HTTP origin", () => {
  const config = JSON.parse(tauriConfigText);
  const sources = config.app.security.csp["img-src"].split(/\s+/);
  expect(sources).toContain(new URL(item.url).origin);
  expect(sources).toContain("craft-media:");
  expect(sources).not.toContain("http:");
  expect(sources).not.toContain("*");
});
