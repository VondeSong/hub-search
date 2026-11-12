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
const settings = { provider: "webdav", oss: config, hasSecret: true, deviceId: "device-a", mediaPolicy: "all" };
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent?.includes(text))!;
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  invokeMock.mockReset(); onChanged.mockClear();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_flashcard_cloud_sync_settings") return settings;
    if (command === "get_flashcard_cloud_sync_report") return null;
    throw new Error("迁移时网络已断开");
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<CloudConnectionOptions syncing={false} onChanged={onChanged} />));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
it("requires device coordination and keeps the existing provider after failed migration", async () => {
  await act(async () => button("阿里云 OSS").click());
  expect(button("确认切换到").disabled).toBe(true);
  await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  expect(button("确认切换到").disabled).toBe(false);
  await act(async () => button("确认切换到").click()); await settle();
  expect(invokeMock).toHaveBeenCalledWith("activate_flashcard_cloud_sync", { target: "oss", otherDevicesReady: true });
  expect(container.textContent).toContain("迁移时网络已断开");
  expect(container.textContent).toContain("当前同步服务：WebDAV");
  expect(onChanged).not.toHaveBeenCalled();
  expect(button("确认切换到").disabled).toBe(false);
});
it("keeps credentials out of the settings display and disables edits while syncing", async () => {
  await act(async () => button("阿里云 OSS").click());
  const password = container.querySelector('input[type="password"]') as HTMLInputElement;
  expect(password.value).toBe(""); expect(password.placeholder).toContain("已安全保存");
  await act(async () => root.render(<CloudConnectionOptions syncing={true} onChanged={onChanged} />));
  expect(container.querySelector("fieldset")?.disabled).toBe(true);
  expect(invokeMock.mock.calls.some(([name]) => name === "activate_flashcard_cloud_sync")).toBe(false);
});
it("auto-sync settings reports the active provider after initial load and successful migration", async () => {
  const onProviderChange = vi.fn();
  const fallback = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation(async (command: string) => command === "activate_flashcard_cloud_sync" ? { ...settings, provider: "oss" } : fallback(command));
  await act(async () => root.render(<CloudConnectionOptions syncing={false} onChanged={onChanged} onProviderChange={onProviderChange} />));
  expect(onProviderChange).toHaveBeenLastCalledWith("webdav");
  await act(async () => button("阿里云 OSS").click());
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => button("确认切换到").click());
  await settle();
  expect(onChanged).toHaveBeenCalledOnce();
  expect(onProviderChange).toHaveBeenLastCalledWith("oss");
  expect(onProviderChange.mock.calls.map(([provider]) => provider)).toEqual(["webdav", "oss"]);
});

it("selecting a service reveals only its configuration without activating it", async () => {
  expect(container.querySelector('[aria-label="阿里云 OSS 配置"]')).toBeNull();
  expect(button("WebDAV").getAttribute("aria-pressed")).toBe("true");
  await act(async () => button("阿里云 OSS").click());
  expect(container.querySelector('[aria-label="WebDAV 配置"]')).toBeNull();
  expect(container.textContent).toContain("尚未启用。同步仍使用 WebDAV");
  expect(invokeMock.mock.calls.some(([c]) => c === "activate_flashcard_cloud_sync")).toBe(false);
  await act(async () => button("WebDAV").click());
  expect(container.querySelector('[aria-label="切换云服务"]')).toBeNull();
});
it("reverse switching uses WebDAV instructions and cannot activate unsaved configuration", async () => {
  await act(async () => root.unmount());
  invokeMock.mockImplementation(async command => command === "get_flashcard_cloud_sync_settings" ? { ...settings, provider: "oss" } : null);
  root=createRoot(container);
  await act(async () => root.render(<CloudConnectionOptions syncing={false} onChanged={onChanged} webdavReady webdavDirty />));
  await settle();
  expect(button("阿里云 OSS").getAttribute("aria-pressed")).toBe("true");
  await act(async () => button("WebDAV").click());
  expect(container.textContent).toContain("其它设备配置相同的 WebDAV 位置");
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(button("确认切换到 WebDAV").disabled).toBe(true);
  expect(container.textContent).toContain("当前同步服务：阿里云 OSS");
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

it("reflects the first OSS save as the active connection without a second migration", async () => {
  await act(async () => root.unmount());
  invokeMock.mockImplementation(async command => command === "get_flashcard_cloud_sync_settings"
    ? { ...settings, oss: undefined, hasSecret: false }
    : command === "save_flashcard_oss_config" ? { ...settings, provider: "oss" } : null);
  root = createRoot(container);
  const onProviderChange = vi.fn();
  await act(async () => root.render(<CloudConnectionOptions syncing={false} onChanged={onChanged} onProviderChange={onProviderChange} />));
  await settle();
  await act(async () => button("阿里云 OSS").click());
  for (const [name, value] of [["Bucket 名称", config.bucket], ["AccessKey ID", config.accessKeyId], ["AccessKey Secret", "synthetic-test-secret"]]) {
    const field = [...container.querySelectorAll("label")].find(label => label.textContent?.includes(name))!.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  await act(async () => button("保存 OSS 配置").click()); await settle();
  expect(container.textContent).toContain("当前同步服务：阿里云 OSS");
  expect(container.querySelector('[aria-label="切换云服务"]')).toBeNull();
  expect(container.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  expect(onProviderChange).toHaveBeenLastCalledWith("oss");
  expect(onChanged).toHaveBeenCalledOnce();
  expect(invokeMock.mock.calls.some(([command]) => command === "activate_flashcard_cloud_sync")).toBe(false);
});
