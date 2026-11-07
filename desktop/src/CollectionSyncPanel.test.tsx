// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionSyncPanel, type CollectionSyncSource } from "./CollectionSyncPanel";
import { consumeCloudSyncSettingsSection } from "./CloudSyncEvents";
import { didaRetentionExplanation } from "./DidaReadingStatus";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
const closed = vi.fn(), sync = vi.fn();
const source = (): CollectionSyncSource => ({ id: "dida", count: 40, connected: true, canResume: false,
  status: "滴答稍后读：0 项迁移核验完成；32 项来源保留，等待重试", lastCheckedAt: 100,
  didaCleanup: { mode: "cloud-preserve", pending: 32, verified: 28, deleted: 8, authRequired: false,
    reasons: [{ count: 28, message: "阅读云同步已启用：来源清理未开启，滴答原项已保留" }, { count: 4, message: "滴答来源的附件清单未知，来源保留" }] } });
const mount = async (data = source()) => act(async () => root.render(<div className="collections-workspace"><CollectionSyncPanel
  sources={[data]} operations={[]} itemTitles={{}} autoSyncMinutes={30} storageLabel="本机" storageStatus="" pendingCancellations={0}
  jobRunning={false} jobVisible={false} sourceBusy={() => false} sourceActive={() => false}
  onClose={closed} onSettings={vi.fn()} onSync={sync} onPause={vi.fn()} onStore={vi.fn()} onConnect={vi.fn()} onOpenUrl={vi.fn()}
  onDidaLogin={vi.fn()} onReview={vi.fn()} onRetry={vi.fn()} onContinueCopy={vi.fn()}>{null}</CollectionSyncPanel></div>));
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  closed.mockReset(); sync.mockReset(); invoke.mockReset(); consumeCloudSyncSettingsSection();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); consumeCloudSyncSettingsSection(); });

it("separates Hub reading counts from retained Dida originals and explains a disabled delete setting", async () => {
  await mount();
  expect(host.querySelector(".collection-sync-source-meta")?.textContent).toContain("Hub 阅读：40 条");
  const summary = host.querySelector('[aria-label="滴答原内容处理"]')!;
  expect(summary.textContent).toContain("滴答里的原内容：保留 32 条");
  expect(summary.textContent).toContain("同步后删除：未开启");
  expect(summary.textContent).not.toMatch(/等待重试|同步失败|迁移核验/);
  expect(host.querySelector('[aria-label="滴答原内容保留原因"]')?.textContent).toContain("28 条 · 删除开关未开启");
  expect(host.querySelector(".collection-source-detail")?.textContent).toContain("上次检查：本机已确认保存完整 28 条 · 之前已从滴答删除 8 条");
  expect(host.querySelector(".collection-source-technical")?.hasAttribute("open")).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
});

it("distinguishes an unavailable attachment list from attachments not saved completely", async () => {
  const data = source(); data.didaCleanup!.reasons.push({ count: 1, kind: "attachment-incomplete", message: "文件错误" });
  await mount(data);
  const explanations = host.querySelector('[aria-label="滴答原内容保留原因"]')!.textContent;
  expect(explanations).toContain("4 条 · 滴答没有返回附件列表，暂时无法确认有无附件");
  expect(explanations).toContain("这不代表附件已丢失");
  expect(explanations).toContain("附件还没全部保存并检查通过");
  const help = host.querySelector(".collection-dida-attachment-help")!;
  expect(help.hasAttribute("open")).toBe(false);
  expect(help.textContent).toContain("只有滴答明确返回空列表，且正文和说明里没有附件引用");
});

it("opens the delete setting directly without changing policy or deleting or syncing anything", async () => {
  const opened = vi.fn(); window.addEventListener("hub:open-cloud-sync-settings", opened);
  try {
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>(".collection-dida-cleanup-settings")!.click());
    expect(closed).toHaveBeenCalledTimes(1); expect(opened).toHaveBeenCalledTimes(1);
    expect(consumeCloudSyncSettingsSection()).toBe("dida-cleanup");
    expect(sync).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  } finally { window.removeEventListener("hub:open-cloud-sync-settings", opened); }
});

it("keeps cloud completeness separate from local saved checks when automatic deletion is enabled", async () => {
  const data = source(); data.didaCleanup!.mode = "cloud-verified";
  data.didaCleanup!.reasons = [{ count: 32, kind: "cloud-verification", message: "云端恢复检查未通过" }];
  await mount(data);
  expect(host.querySelector('[aria-label="滴答原内容处理"]')?.textContent).toContain("本机、云端都检查通过后才删除");
  expect(host.querySelector('[aria-label="滴答原内容保留原因"]')?.textContent).toContain("云端副本还没完整确认");
  expect(host.querySelector(".collection-source-detail")?.textContent).toContain("上次检查：本机已确认保存完整 28 条");
  expect(host.querySelector(".collection-source-detail")?.textContent).not.toContain("云端已确认 28 条");
});

it.each(["滴答没有返回附件列表，暂时保留原内容", "滴答返回的附件列表格式异常，暂时保留原内容"])("keeps new inventory errors understandable: %s", message => {
  expect(didaRetentionExplanation({ message, count: 1 })).toContain("不代表附件已丢失");
  expect(didaRetentionExplanation({ message, count: 1 })).not.toContain("附件还没全部保存");
});

it("explains a retained receipt from a previously disabled delete policy using the current setting after it changes", async () => {
  const data = source();
  await mount(data);
  expect(host.querySelector('[aria-label="滴答原内容保留原因"]')?.textContent).toContain("删除开关未开启");
  await mount({ ...data, didaCleanup: { ...data.didaCleanup!, mode: "cloud-verified", cleanupEnabled: true, cloudReading: true } });
  const summary = host.querySelector('[aria-label="滴答原内容处理"]')!.textContent;
  const reasons = host.querySelector('[aria-label="滴答原内容保留原因"]')!.textContent;
  expect(summary).toContain("同步后删除：已开启");
  expect(reasons).toContain("上次同步时未开启删除；当前已开启，下次同步会继续检查");
  expect(reasons).not.toContain("删除开关未开启");
  expect(sync).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
});

it("does not treat an old cloud-preserve receipt as the current local cleanup policy", async () => {
  const data = source(); data.didaCleanup!.mode = "local";
  data.didaCleanup!.cleanupEnabled = false; data.didaCleanup!.cloudReading = false;
  await mount(data);
  expect(host.querySelector('[aria-label="滴答原内容处理"]')?.textContent).toContain("本机确认正文和全部附件保存完整后");
  expect(host.querySelector('[aria-label="滴答原内容保留原因"]')?.textContent).toContain("上次同步因设置保留原内容；下次同步按当前设置重新检查");
  expect(host.querySelector('[aria-label="滴答原内容保留原因"]')?.textContent).not.toContain("删除开关未开启");
});

it("recognizes unavailable attachment inventories from legacy records", () => {
  expect(didaRetentionExplanation({ count: 1, message: "滴答来源附件库存未知，原项保留" })).toContain("暂时无法确认有无附件");
  expect(didaRetentionExplanation({ count: 1, kind: "other", message: "滴答来源附件库存未知，原项保留" })).toContain("暂时无法确认有无附件");
});

it.each(["云端原附件清单与滴答来源原件不一致，原项保留", "云端附件下载失败，滴答原项已保留"])("distinguishes a cloud verification error from an incomplete local save: %s", message => {
  expect(didaRetentionExplanation({ count: 1, message })).toContain("云端副本还没完整确认");
  expect(didaRetentionExplanation({ count: 1, message })).not.toContain("附件还没全部保存");
});

it("overrides legacy broad classifications for quota and source version errors", () => {
  expect(didaRetentionExplanation({count:28,kind:"cloud-verification",message:"来源云端恢复检查未完整通过：正文：今日附件额度不足"})).toContain("云端传输额度不足");
  expect(didaRetentionExplanation({count:3,kind:"attachment-incomplete",message:"滴答任务与附件会话的正文版本不一致，来源保留"})).toContain("处理保留的原内容");
});
