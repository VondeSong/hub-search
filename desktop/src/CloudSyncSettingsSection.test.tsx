// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudSyncSettingsSection, type CloudSyncPolicy } from "./CloudSyncSettingsSection";
import { openDidaReadingCleanupSettings } from "./CloudSyncEvents";
import { runtimeCapabilities } from "./RuntimePlatform";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
let root: Root, host: HTMLDivElement, policy: CloudSyncPolicy;
const status = { url: "", username: "", hasPassword: false, autoSync: false, configured: true, lastError: "" };
const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.includes(text))!;
const checkbox = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const render = async () => { await act(async () => root.render(<CloudSyncSettingsSection />)); };

it("pauses all cloud category polling while inactive or hidden and keeps a policy draft", async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  const reads = () => invokeMock.mock.calls.filter(([command]) => ["get_reading_sync_status", "get_reading_media_policy", "get_reading_network_policy"].includes(command)).length;
  try {
    policy = { ...policy, reading: true };
    await act(async () => root.render(<CloudSyncSettingsSection active={false} />));
    const initial = reads();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(reads()).toBe(initial);
    await act(async () => root.render(<CloudSyncSettingsSection active />));
    await act(async () => checkbox("同步阅读附件").click());
    const input = host.querySelector<HTMLInputElement>('[aria-label="单张图片上限"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "17");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reads()).toBe(initial + 3); expect(input.value).toBe("17");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(20000); });
    expect(reads()).toBe(initial + 3);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(reads()).toBe(initial + 6); expect(input.value).toBe("17");
  } finally { vi.useRealTimers(); Reflect.deleteProperty(document, "hidden"); }
});
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  policy = { enabled: true, autoSync: false, flashcards: true, reading: false };
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "get_reading_source_cleanup") return false;
    if (command === "get_cloud_maintenance_status") return { supported:true,currentDevice:"isolated",devices:[],plan:null,confirmedCheckpoint:"" };
    if (command === "get_reading_network_policy") return { mode: "any", network: { supported: true, connected: true, kind: "wifi", metered: false, restricted: false }, allowed: true, reason: "" };
    if (command === "get_reading_cache_status") return { bytes: 0, pinnedBytes: 0, removableBytes: 0, removableCount: 0, otherCount: 0, pins: [], token: "empty" };
    if (command === "get_reading_media_policy") return { policy: { enabled: false, download: "onDemand", imageMb: 10, documentMb: 20, batchMb: 64, dailyMb: 256, cacheMb: 512 }, reservedBytes: 0, day: "" };
    if (command === "get_reading_sync_status") return { supported: true, running: false, lastError: "", report: null };
    if (command === "sync_reading") return { uploaded: 1, downloaded: 2, pending: 1, completedAt: 1 };
    if (command === "get_cloud_sync_policy") return { ...policy };
    if (command === "update_cloud_sync_policy") { policy = args?.settings as CloudSyncPolicy; return { ...policy }; }
    if (command === "get_flashcard_sync_settings") return status;
    if (command === "get_flashcard_cloud_sync_settings") return { provider: "oss", hasSecret: true, deviceId: "original-device", mediaPolicy: "all", oss: { bucket: "existing-bucket", region: "cn-hangzhou", prefix: "HubFlashcards", accessKeyId: "test-key" } };
    if (command === "get_flashcard_cloud_sync_report") return null;
    if (command === "list_flashcard_sync_history") return [];
    if (command === "sync_flashcards") return { downloadedCards: 2, mergedReviews: 3 };
    if (command === "update_flashcard_sync_settings") return { ...status, url: args?.url, username: args?.username };
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("saves automatic preference independently of WebDAV and restores it on reopen", async () => {
  await render();
  await act(async () => checkbox("自动同步").click());
  expect(invokeMock).toHaveBeenCalledWith("update_cloud_sync_policy", { settings: { enabled: true, autoSync: true, flashcards: true, reading: false } });
  expect(invokeMock.mock.calls.some(([c]) => c === "update_flashcard_sync_settings")).toBe(false);
  await act(async () => root.unmount()); root = createRoot(host); await render();
  expect(checkbox("自动同步").checked).toBe(true);
});

it("preserves module and auto choices when the master switch is off and blocks manual sync", async () => {
  policy.autoSync = true;
  await render();
  await act(async () => checkbox("启用云同步").click());
  expect(policy).toEqual({ enabled: false, flashcards: true, autoSync: true, reading: false });
  expect(checkbox("自动同步").disabled).toBe(true);
  expect(checkbox("同步闪卡").checked).toBe(true);
  expect(button("立即同步").disabled).toBe(true);
  await act(async () => button("立即同步").click());
  expect(invokeMock.mock.calls.some(([c]) => c === "sync_flashcards")).toBe(false);
  await act(async () => checkbox("启用云同步").click());
  expect(button("立即同步").disabled).toBe(false);
});

it("keeps reading opt-in and permits configuring while paused", async () => {
  policy.enabled = false;
  await render();
  expect(checkbox("同步阅读").checked).toBe(false);
  expect(checkbox("同步阅读").disabled).toBe(true);
  expect(button("测试 OSS 连接").disabled).toBe(false);
  await act(async () => button("WebDAV").click());
  expect(button("确认切换到").disabled).toBe(true);
  expect(host.textContent).toContain("请先开启本设备云同步");
});

it("does not submit hidden WebDAV edits when changing automatic policy", async () => {
  await render();
  await act(async () => button("WebDAV").click());
  const username = host.querySelector<HTMLInputElement>('input[autocomplete="username"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(username, "unsaved-user");
    username.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => checkbox("自动同步").click());
  expect(username.value).toBe("unsaved-user");
  expect(invokeMock.mock.calls.some(([c]) => c === "update_flashcard_sync_settings")).toBe(false);
});

it("waits for confirmation from the service before showing a paused state", async () => {
  const fallback = invokeMock.getMockImplementation()!;
  let finish!: (p: CloudSyncPolicy) => void;
  invokeMock.mockImplementation((c, args) => c === "update_cloud_sync_policy" ? new Promise(resolve => { finish = resolve; }) : fallback(c, args));
  await render();
  await act(async () => checkbox("启用云同步").click());
  expect(checkbox("启用云同步").checked).toBe(true);
  expect(checkbox("启用云同步").disabled).toBe(true);
  expect(host.textContent).toContain("等待本次结束");
  await act(async () => finish({ enabled: false, autoSync: false, flashcards: true, reading: false }));
  expect(checkbox("启用云同步").checked).toBe(false);
});

it("refreshes consumers after a partial sync failure and keeps the failure visible", async () => {
  const changed = vi.fn();
  window.addEventListener("hub:cloud-data-changed", changed);
  const fallback = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((c, args) => c === "sync_flashcards" ? Promise.reject("附件传输失败") : fallback(c, args));
  await render();
  await act(async () => button("立即同步").click());
  expect(changed).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("附件传输失败");
  expect(button("立即同步").disabled).toBe(false);
  window.removeEventListener("hub:cloud-data-changed", changed);
});

it("failed policy writes do not change the saved switch state", async () => {
  const fallback = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((c, args) => c === "update_cloud_sync_policy" ? Promise.reject("无法写入设置") : fallback(c, args));
  await render();
  await act(async () => checkbox("同步闪卡").click());
  expect(checkbox("同步闪卡").checked).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("无法写入设置");
});

it("syncs reading independently from flashcards and reports pending records", async () => {
  policy.flashcards = false;
  await render();
  await act(async () => checkbox("同步阅读").click());
  expect(policy.reading).toBe(true);
  expect(host.textContent).toContain("默认保留滴答里的原内容");
  expect(host.textContent).toContain("云同步暂停");
  expect(button("立即同步").disabled).toBe(true);
  const changed = vi.fn(); window.addEventListener("hub:reading-data-changed", changed);
  await act(async () => button("同步阅读").click());
  expect(invokeMock).toHaveBeenCalledWith("sync_reading");
  expect(changed).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("还有 1 条待同步");
  window.removeEventListener("hub:reading-data-changed", changed);
});

it("blocks enabling reading on unsupported providers", async () => {
  const fallback = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((c, args) => c === "get_reading_sync_status" ? Promise.resolve({ supported: false, running: false, lastError: "", report: null }) : fallback(c, args));
  await render();
  expect(checkbox("同步阅读").disabled).toBe(true);
  expect(button("同步阅读").disabled).toBe(true);
});
it("opens and focuses the Dida delete setting without enabling it or running a sync", async () => {
  openDidaReadingCleanupSettings();
  await render();
  const card = host.querySelector<HTMLElement>('[aria-label="滴答来源清理"]')!;
  expect(card).toBeTruthy(); expect(document.activeElement).toBe(card);
  const input = checkbox("保存完整后，删除滴答里的原内容");
  expect(input.disabled).toBe(true); expect(input.checked).toBe(false);
  expect(card.textContent).toContain("请先开启本设备的云同步和阅读云同步");
  expect(invokeMock.mock.calls.some(([command]) => command === "set_reading_source_cleanup" || command === "sync_reading")).toBe(false);
});
it("directs mobile readers to the computer's delete setting without presenting a nonexistent switch", async () => {
  const original = { mobile: runtimeCapabilities.mobile, desktop: runtimeCapabilities.desktop };
  runtimeCapabilities.mobile = true; runtimeCapabilities.desktop = false; policy.reading = true;
  try {
    await render();
    const notice = [...host.querySelectorAll("p")].find(p => p.textContent?.includes("同步到 Hub 后，默认保留滴答里的原内容"))!;
    expect(notice.textContent).toContain("电脑端的 设置→云同步→滴答来源清理 中开启");
    expect(notice.textContent).not.toContain("下面");
    expect(host.querySelector('[aria-label="滴答来源清理"]')).toBeNull();
    expect(invokeMock.mock.calls.some(([command]) => command === "set_reading_source_cleanup" || command === "sync_reading")).toBe(false);
  } finally { Object.assign(runtimeCapabilities, original); }
});
