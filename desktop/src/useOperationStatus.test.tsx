// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearOperationStatus, useOperationStatus } from "./useOperationStatus";
import { SettingsDialog } from "./SettingsDialog";

let root: Root;
let container: HTMLDivElement;
let api: ReturnType<typeof useOperationStatus>;
const Probe = () => { api = useOperationStatus(); return <span data-main-status>{api.operationStatus?.text}</span>; };
beforeEach(() => { vi.useFakeTimers(); clearOperationStatus(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); clearOperationStatus(); }); container.remove(); vi.useRealTimers(); });

it("shows direct application notices inside settings and retains the current notice when the dialog opens", async () => {
  await act(async () => root.render(<Probe />));
  await act(async () => api.showOperationStatus("连接失败，请重试", "error", 5000));
  await act(async () => root.render(<><Probe /><SettingsDialog canClose category="libraries" onCategoryChange={() => undefined} onClose={() => undefined}><div>库设置</div></SettingsDialog></>));
  expect(container.querySelector(".settings-operation-status")?.textContent).toBe("连接失败，请重试");
  expect(container.querySelector(".settings-operation-status")?.getAttribute("role")).toBe("alert");
  await act(async () => vi.advanceTimersByTime(5000));
  expect(container.querySelector(".settings-operation-status")?.textContent).toBe("");
  expect(container.querySelector("[data-main-status]")?.textContent).toBe("");
});
it("receives external notices once without recursively publishing them", async () => {
  await act(async () => root.render(<Probe />));
  const listener = vi.fn(); window.addEventListener("hub:operation-status", listener);
  await act(async () => window.dispatchEvent(new CustomEvent("hub:operation-status", { detail: { text: "同步已受理", tone: "success", duration: 0 } })));
  expect(api.operationStatus).toEqual({ text: "同步已受理", tone: "success" });
  expect(listener).toHaveBeenCalledOnce();
  await act(async () => window.dispatchEvent(new CustomEvent("hub:operation-status", { detail: { text: "无效反馈", tone: "unknown" } })));
  expect(api.operationStatus?.text).toBe("同步已受理");
  window.removeEventListener("hub:operation-status", listener);
});
it("closing a settings subscriber does not clear the application notice or reset its expiry", async () => {
  await act(async () => root.render(<><Probe /><SettingsDialog canClose category="libraries" onCategoryChange={() => undefined} onClose={() => undefined}><div /></SettingsDialog></>));
  await act(async () => api.showOperationStatus("已暂停", "success", 2000));
  await act(async () => vi.advanceTimersByTime(1000));
  await act(async () => root.render(<Probe />));
  expect(container.textContent).toBe("已暂停");
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.textContent).toBe("");
});
