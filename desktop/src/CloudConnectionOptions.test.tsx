// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { CloudConnectionOptions } from "./CloudConnectionOptions";

const config = { bucket: "private-bucket", region: "cn-hangzhou", prefix: "hub", accessKeyId: "EXAMPLE" };
let stored: { provider: "none" | "oss"; configured: boolean; name: string; oss?: typeof config; hasSecret: boolean; migrationBlocked: boolean; legacyRetired?: boolean; mediaPolicy: "all"; migration?: { state: string; error: string } };
let host: HTMLDivElement, root: Root, saveError: string, checkError: string;
const changed = vi.fn(async () => {}), busyChanged = vi.fn();
const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent === text)!;
const field = (label: string) => [...host.querySelectorAll("label")].find(l => l.querySelector("span")?.textContent === label)!.querySelector<HTMLInputElement>("input")!;
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const click = async (text: string) => { await act(async () => button(text).click()); await settle(); };
const enter = async (label: string, value: string) => act(async () => {
  const input = field(label);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const mount = async (paused = false) => { await act(async () => root.render(<CloudConnectionOptions syncing={false} transfersAllowed={!paused} onChanged={changed} onBusyChange={busyChanged} />)); await settle(); };
const saves = () => invoke.mock.calls.filter(([command]) => command === "save_cloud_connection");
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  stored = { provider: "oss", configured: true, name: "我的 Hub", oss: { ...config }, hasSecret: true, migrationBlocked: false, mediaPolicy: "all" };
  saveError = ""; checkError = ""; changed.mockReset().mockResolvedValue(); busyChanged.mockClear(); invoke.mockReset();
  invoke.mockImplementation(async (command, args) => {
    if (command === "get_flashcard_cloud_sync_settings") return structuredClone(stored);
    if (command === "test_flashcard_oss_connection") { if (checkError) throw new Error(checkError); return "OSS 列表、上传、下载和读回校验通过；不代表内容已同步"; }
    if (command === "save_cloud_connection") {
      if (saveError) throw new Error(saveError);
      stored = { ...stored, provider: "oss", configured: true, name: args.name || stored.name, oss: args.oss, hasSecret: true, legacyRetired: false };
      return structuredClone(stored);
    }
    throw new Error("Unexpected command: " + command);
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

it("shows the prototype connection summary and reveals credentials only on demand", async () => {
  await mount();
  expect(host.textContent).toContain("管理云空间"); expect(host.textContent).toContain("private-bucket · cn-hangzhou · hub");
  expect(host.querySelector("input")).toBeNull();
  await click("更新凭据");
  expect(host.querySelectorAll("input")).toHaveLength(2);
  expect(field("AccessKey Secret").value).toBe(""); expect(field("AccessKey Secret").placeholder).toContain("已安全保存");
  await enter("AccessKey Secret", "synthetic-secret"); await click("取消");
  expect(host.querySelector("form")).toBeNull(); expect(saves()).toHaveLength(0);
  await click("更新凭据"); expect(field("AccessKey Secret").value).toBe("");
});
it("checks the current connection without submitting a draft or starting content sync", async () => {
  await mount(); await click("检查连接");
  expect(host.querySelector("input")).toBeNull(); await click("开始检查");
  expect(invoke).toHaveBeenCalledWith("test_flashcard_oss_connection"); expect(saves()).toHaveLength(0);
  expect(host.textContent).toContain("不代表内容已同步");
});
it("retains the old connection and the credential draft after a failed candidate check", async () => {
  saveError = "新凭据检查失败"; await mount(); await click("更新凭据");
  await enter("AccessKey ID", "NEWEXAMPLE"); await enter("AccessKey Secret", "synthetic-secret"); await click("检查并保存凭据");
  expect(saves()[0][1]).toEqual({ oss: { ...config, accessKeyId: "NEWEXAMPLE" }, secret: "synthetic-secret", change: "credentials", name: null, otherDevicesReady: false });
  expect(host.textContent).toContain("新凭据检查失败"); expect(field("AccessKey Secret").value).toBe("synthetic-secret");
  expect(stored.oss).toEqual(config); expect(changed).not.toHaveBeenCalled();
  saveError = ""; await click("检查并保存凭据"); expect(host.querySelector("form")).toBeNull(); expect(changed).toHaveBeenCalledOnce();
});
it("updates credentials while paused and leaves module and attachment policies untouched", async () => {
  await mount(true); await click("更新凭据"); await enter("AccessKey Secret", "synthetic-new-secret"); await click("检查并保存凭据");
  expect(saves()[0][1].change).toBe("credentials");
  expect(invoke.mock.calls.some(([name]) => name.startsWith("sync_") || name.includes("attachment_policy") || name === "update_cloud_sync_policy")).toBe(false);
});
it("connects in two steps through one checked command and preserves the paused state", async () => {
  stored = { ...stored, provider: "none", configured: false, oss: undefined, hasSecret: false, legacyRetired: true };
  await mount(true); expect(host.textContent).toContain("旧 WebDAV（含坚果云）同步已停用");
  expect([...host.querySelectorAll("button")].some(b => /WebDAV|坚果云/.test(b.textContent || ""))).toBe(false);
  await click("连接阿里云 OSS"); await enter("连接名称", "学习资料"); await enter("Bucket 名称", "fresh-bucket"); await click("下一步");
  expect(saves()).toHaveLength(0); expect(host.textContent).toContain("本设备已暂停");
  await enter("AccessKey ID", "EXAMPLE"); await enter("AccessKey Secret", "synthetic-secret"); await click("检查并保存连接");
  expect(saves()[0][1]).toMatchObject({ change: "connect", name: "学习资料", otherDevicesReady: false });
  expect(host.textContent).toContain("学习资料"); expect(host.querySelector("form")).toBeNull();
  expect(invoke.mock.calls.some(([name]) => name.startsWith("sync_") || name === "activate_flashcard_cloud_sync" || name === "save_flashcard_oss_config")).toBe(false);
});
it("requires migration coordination and retains both the source summary and target after failure", async () => {
  saveError = "本次迁移未结束，进度已保存"; stored.migration = { state: "partial", error: "待继续" };
  await mount(); await click("更换云空间"); await enter("目录前缀", "NewSpace"); await click("下一步");
  expect(button("开始迁移并核验").disabled).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); await click("开始迁移并核验");
  expect(saves()[0][1]).toMatchObject({ change: "location", oss: { ...config, prefix: "NewSpace" }, otherDevicesReady: true });
  expect(host.textContent).toContain("private-bucket · cn-hangzhou · hub"); expect(host.textContent).toContain("再次执行可继续");
  await click("上一步"); expect(field("目录前缀").value).toBe("NewSpace");
});
it("blocks migration for bound quick notes before any command is sent", async () => {
  stored.migrationBlocked = true; await mount(); await click("更换云空间"); await enter("目录前缀", "NewSpace"); await click("下一步");
  expect(host.textContent).toContain("速记已绑定当前云空间，暂时不能切换"); expect(button("开始迁移并核验").disabled).toBe(true);
  expect(host.querySelector('input[type="checkbox"]')).toBeNull(); expect(saves()).toHaveLength(0);
});
it("blocks a location migration while paused even after acknowledgement", async () => {
  await mount(true); await click("更换云空间"); await enter("目录前缀", "NewSpace"); await click("下一步");
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(button("开始迁移并核验").disabled).toBe(true); expect(saves()).toHaveLength(0);
});
it("normalizes equivalent directory paths and does not ask for a migration for a name change", async () => {
  await mount(); await click("更换云空间"); await enter("连接名称", "工作资料"); await enter("目录前缀", "/hub/"); await click("下一步");
  expect(host.querySelector('input[type="checkbox"]')).toBeNull(); await click("检查并保存连接");
  expect(saves()[0][1]).toMatchObject({ name: "工作资料", change: "location", otherDevicesReady: false });
});
it("does not report a saved connection as unsaved when overview refresh fails", async () => {
  changed.mockRejectedValue(new Error("刷新失败")); await mount(); await click("更新凭据"); await click("检查并保存凭据");
  expect(host.textContent).toContain("连接已保存，但同步状态刷新失败"); expect(host.querySelector("form")).toBeNull(); expect(saves()).toHaveLength(1);
});
it("keeps failed current-connection checks retryable and locks edits while syncing", async () => {
  checkError = "当前离线"; await mount(); await click("检查连接"); await click("开始检查"); expect(host.textContent).toContain("当前离线");
  await act(async () => root.render(<CloudConnectionOptions syncing onChanged={changed} />));
  expect(host.querySelector("fieldset")?.disabled).toBe(true); expect(saves()).toHaveLength(0);
});
it("ignores an older initial settings reply after StrictMode remounts the effect", async () => {
  let first: (value: unknown) => void = () => {}; const base = invoke.getMockImplementation()!;
  invoke.mockImplementationOnce(() => new Promise(resolve => { first = resolve; })).mockImplementation(base);
  await act(async () => root.render(<StrictMode><CloudConnectionOptions syncing={false} onChanged={changed} /></StrictMode>)); await settle();
  expect(host.textContent).toContain("管理云空间");
  await act(async () => first({ ...stored, configured: false, provider: "none", oss: undefined }));
  expect(host.textContent).toContain("管理云空间");
});
