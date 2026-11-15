// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsConnectionsSection } from "./SettingsConnectionsSection";
import { runtimeCapabilities } from "./RuntimePlatform";
import { INHERIT_LIBRARY_POLICY } from "./LibraryManagement";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let root: Root;
let container: HTMLDivElement;
let props: ComponentProps<typeof SettingsConnectionsSection>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); invoke.mockReset();
  invoke.mockResolvedValue({ global: { imageDownload: true, imageOcr: true, pdfDownload: true, pdfText: true, pdfOcr: false, otherDownload: false, outgoingAttachments: true } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  props = { runtimeCapabilities: { ...runtimeCapabilities, nativeOcr: true, localVault: true }, spaces: [], feishuAuthorization: null, feishuAppId: "", feishuAppSecret: "", selectedFeishuSpaceIds: [], feishuBitableSourceId: "", feishuBitableUrl: "", obsidianPath: "", mcpUrl: "", craftApiUrl: "", craftApiKey: "", connectingAction: null, connectionError: "", connectionErrorProvider: "general", setFeishuAuthorization: vi.fn(), setFeishuAppId: vi.fn(), setFeishuAppSecret: vi.fn(), setSelectedFeishuSpaceIds: vi.fn(), setFeishuBitableSourceId: vi.fn(), setFeishuBitableUrl: vi.fn(), setObsidianPath: vi.fn(), setMcpUrl: vi.fn(), setCraftApiUrl: vi.fn(), setCraftApiKey: vi.fn(), connectFeishu: vi.fn(), addSelectedFeishuSpaces: vi.fn(), addFeishuBitable: vi.fn(), connectDida365: vi.fn(), addObsidian: vi.fn(), connect: vi.fn(), saveCraftApiConnection: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it("explains mobile offline availability and keeps the two real authorization actions separate", async () => {
  props.runtimeCapabilities = { ...runtimeCapabilities, mobile: true, nativeOcr: false, localVault: false };
  await act(async () => root.render(<SettingsConnectionsSection {...props} />));
  const craft = container.querySelector('[data-provider="craft"]')!;
  const feishu = container.querySelector('[data-provider="feishu"]')!;
  expect(craft.textContent).toContain("保存在本机后可离线搜索和阅读");
  expect(feishu.textContent).toContain("已缓存的图片可离线查看");
  expect(feishu.textContent).toContain("这台手机的浏览器");
  expect(feishu.textContent).not.toContain("Windows 凭据管理器");
  await act(async () => [...feishu.querySelectorAll("button")].find(button => button.textContent === "登录并读取文档来源")!.click());
  expect(props.connectFeishu).toHaveBeenCalledOnce();
  expect(props.connect).not.toHaveBeenCalled();
  expect(invoke.mock.calls.some(([command]) => command.includes("sync"))).toBe(false);
});
it("passes staged independent policies and start-later intent through the Craft connection", async () => {
  await act(async () => root.render(<SettingsConnectionsSection {...props} />));
  const card = container.querySelector('[data-provider="craft"]')!;
  const set = async (label: string, value: string) => { const select = card.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }); };
  expect(card.querySelector('[aria-label="下载图片原件"]')).toBeNull();
  expect(card.textContent).toContain("原件自动保存在当前 Hub 数据目录");
  await set("图片文字识别", "disabled");
  await act(async () => [...card.querySelectorAll("button")].find(button => button.textContent?.endsWith("稍后处理"))!.click());
  expect(props.connect).toHaveBeenCalledWith({ startNow: false, contentPolicy: { ...INHERIT_LIBRARY_POLICY, imageOcr: false } });
  expect(props.connectDida365).not.toHaveBeenCalled();
});
it("stages Feishu only after authorization and keeps unsupported attachment features disabled", async () => {
  props.feishuAuthorization = { authorizationId: "test", spaces: [{ spaceId: "docs", name: "测试文档", description: "" }] }; props.selectedFeishuSpaceIds = ["docs"];
  await act(async () => root.render(<SettingsConnectionsSection {...props} />));
  const card = container.querySelector('[data-provider="feishu"]')!;
  expect([...card.querySelectorAll<HTMLSelectElement>(".library-add-policy select")].every(select => select.disabled)).toBe(true);
  await act(async () => [...card.querySelectorAll("button")].find(button => button.textContent?.startsWith("添加所选来源") && button.textContent.endsWith("稍后处理"))!.click());
  expect(props.addSelectedFeishuSpaces).toHaveBeenCalledWith({ startNow: false, contentPolicy: INHERIT_LIBRARY_POLICY });
  expect(props.connectFeishu).not.toHaveBeenCalled();
});
it("refreshes inherited global labels after a saved global policy without replacing staged overrides", async () => {
  await act(async () => root.render(<SettingsConnectionsSection {...props} />));
  const card = container.querySelector('[data-provider="obsidian"]')!;
  const select = card.querySelector<HTMLSelectElement>('[aria-label="图片文字识别"]')!;
  expect(select.options[0].text).toBe("沿用全局（开启）");
  const download = card.querySelector<HTMLSelectElement>('[aria-label="下载图片原件"]')!;
  await act(async () => { download.value = "disabled"; download.dispatchEvent(new Event("change", { bubbles: true })); });
  invoke.mockResolvedValue({ global: { imageDownload: true, imageOcr: false, pdfDownload: true, pdfText: true, pdfOcr: false, otherDownload: false, outgoingAttachments: true } });
  await act(async () => window.dispatchEvent(new CustomEvent("hub:library-content-policy-changed")));
  expect(select.options[0].text).toBe("沿用全局（关闭）");
  expect(download.value).toBe("disabled");
  expect(invoke.mock.calls.filter(([command])=>command==="library_content_policy")).toHaveLength(2);
});

it("keeps the local-file entry hidden unless the native build explicitly enables it", async () => {
  await act(async () => root.render(<SettingsConnectionsSection {...props} />));
  expect(container.querySelector('[data-provider="files"]')).toBeNull();
  expect(invoke).toHaveBeenCalledWith("local_file_sources", { args: { action: "capabilities" } });
  expect(invoke.mock.calls.some(([,args])=>args?.args?.action==="add")).toBe(false);
});
