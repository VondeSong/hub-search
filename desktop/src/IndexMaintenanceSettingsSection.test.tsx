// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IndexMaintenanceSettingsSection } from "./IndexMaintenanceSettingsSection";
import { runtimeCapabilities } from "./RuntimePlatform";
vi.mock("./LibraryContentPolicyEditor", () => ({ LibraryContentPolicyEditor: () => <div>下载与识别</div> }));
let host: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
it("requires explicit confirmation for the existing orphan cleanup and keeps its cancellation reversible", async () => {
  const cleanup = vi.fn(), confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => root.render(<IndexMaintenanceSettingsSection runtimeCapabilities={runtimeCapabilities} indexStatus={null} cleaning={false} retryingOcr={false} syncPhaseLabel={() => "空闲"} reloadAppSettings={vi.fn()} cleanupLocalData={cleanup} retryFailedOcr={vi.fn()} />));
  const button = [...host.querySelectorAll("button")].find(item => item.textContent === "清理孤立缓存…")!;
  await act(async () => button.click()); expect(cleanup).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("此操作不能撤销"));
  confirm.mockReturnValue(true); await act(async () => button.click()); expect(cleanup).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[aria-label="数据库空间整理"]')).toBeNull();
});
