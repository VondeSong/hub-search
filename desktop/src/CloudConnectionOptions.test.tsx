// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { CloudConnectionOptions } from "./CloudConnectionOptions";

let container: HTMLDivElement;
let root: Root;
const onChanged = vi.fn(async () => {});
const config = { bucket: "private-bucket", region: "cn-hangzhou", prefix: "HubFlashcards", accessKeyId: "EXAMPLE" };
const settings = { provider: "none", legacyRetired: true, oss: config, hasSecret: true, deviceId: "device-a", mediaPolicy: "all" };
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.includes(text))!;
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  invokeMock.mockReset(); onChanged.mockClear();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_flashcard_cloud_sync_settings") return settings;
    if (command === "get_flashcard_cloud_sync_report") return null;
    throw new Error("配置暂时无法保存");
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<CloudConnectionOptions syncing={false} onChanged={onChanged} />));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
it("keeps the connection inactive and retryable after configuration activation fails", async () => {
  expect(button("连接 OSS 云空间").disabled).toBe(false);
  await act(async () => button("连接 OSS 云空间").click()); await settle();
  expect(invokeMock).toHaveBeenCalledWith("activate_flashcard_cloud_sync", { target: "oss" });
  expect(container.textContent).toContain("配置暂时无法保存");
  expect(container.textContent).toContain("当前同步服务：尚未连接");
  expect(onChanged).not.toHaveBeenCalled();
  expect(button("连接 OSS 云空间").disabled).toBe(false);
});
it("keeps credentials out of the settings display and disables edits while syncing", async () => {
  const password = container.querySelector('input[type="password"]') as HTMLInputElement;
  expect(password.value).toBe(""); expect(password.placeholder).toContain("已安全保存");
  await act(async () => root.render(<CloudConnectionOptions syncing={true} onChanged={onChanged} />));
  expect(container.querySelector("fieldset")?.disabled).toBe(true);
  expect(invokeMock.mock.calls.some(([name]) => name === "activate_flashcard_cloud_sync")).toBe(false);
});
it("reports OSS only after the saved connection has been enabled", async () => {
  const onProviderChange = vi.fn();
  const fallback = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation(async (command: string) => command === "activate_flashcard_cloud_sync" ? { ...settings, provider: "oss" } : fallback(command));
  await act(async () => root.render(<CloudConnectionOptions syncing={false} onChanged={onChanged} onProviderChange={onProviderChange} />));
  expect(onProviderChange).toHaveBeenLastCalledWith("none");
  await act(async () => button("连接 OSS 云空间").click());
  await settle();
  expect(onChanged).toHaveBeenCalledOnce();
  expect(onProviderChange).toHaveBeenLastCalledWith("oss");
  expect(onProviderChange.mock.calls.map(([provider]) => provider)).toEqual(["none", "oss"]);
});

it("retired connections offer no editing, service picker or reverse migration", () => {
  expect(container.textContent).toContain("仅存在旧云端的内容，请先用旧版取回");
  expect(container.querySelector('[aria-label="选择要配置的云服务"]')).toBeNull();
  expect(container.querySelector('[aria-label="WebDAV 配置"]')).toBeNull();
  expect([...container.querySelectorAll("button")].some(b => /WebDAV|坚果云/.test(b.textContent || ""))).toBe(false);
});
it("allows configuration while paused without starting content synchronization", async () => {
  await act(async () => root.render(<CloudConnectionOptions syncing={false} transfersAllowed={false} onChanged={onChanged} />));
  expect(button("连接 OSS 云空间").disabled).toBe(false);
  expect(container.textContent).toContain("启用连接后仍不会开始同步");
  expect(invokeMock.mock.calls.some(([name]) => ["sync_flashcards", "sync_reading", "sync_quick_journal"].includes(name))).toBe(false);
});

it("requires coordination before moving the active OSS location and preserves edits after failure", async () => {
  await act(async () => root.unmount());
  invokeMock.mockImplementation(async command => command === "get_flashcard_cloud_sync_settings" ? { ...settings, provider: "oss" } : command === "get_flashcard_cloud_sync_report" ? null : Promise.reject(new Error("本批迁移未结束")));
  root = createRoot(container);
  await act(async () => root.render(<CloudConnectionOptions syncing={false} onChanged={onChanged} />)); await settle();
  const prefix = [...container.querySelectorAll("label")].find(label => label.textContent?.includes("同步目录"))!.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(prefix, "NewReadingSpace");
    prefix.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button("迁移并保存 OSS 配置").disabled).toBe(true);
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(button("迁移并保存 OSS 配置").disabled).toBe(false);
  await act(async () => button("迁移并保存 OSS 配置").click()); await settle();
  expect(invokeMock).toHaveBeenCalledWith("save_flashcard_oss_config", expect.objectContaining({ oss: { ...config, prefix: "NewReadingSpace" }, otherDevicesReady: true }));
  expect(prefix.value).toBe("NewReadingSpace");
  expect(container.textContent).toContain("本批迁移未结束");
  expect(onChanged).not.toHaveBeenCalled();
});
