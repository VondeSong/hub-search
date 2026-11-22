// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentConditions } from "./AgentConditions";
let host: HTMLDivElement, root: Root;
const onAction = vi.fn();
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); onAction.mockReset().mockResolvedValue(undefined); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (extra = {}) => { await act(async () => root.render(<AgentConditions disabled={false} active={false} onAction={onAction} {...extra} />)); };
it("defaults off and never delegates from a report or empty form", async () => {
  await render(); expect(onAction).not.toHaveBeenCalled();
  expect(host.querySelectorAll<HTMLInputElement>("input:checked")).toHaveLength(0);
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(onAction).not.toHaveBeenCalled(); expect(host.textContent).toContain("请选择来源变化");
  expect(document.activeElement).toBe(host.querySelector('[name="agentWatchChanges"]'));
});
it("sends the explicit finite delegation separately from any business action", async () => {
  await render();
  await act(async () => host.querySelector<HTMLInputElement>('[name="agentWatchChanges"]')!.click());
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "configureWatch", confirmed: true, onChange: true, dueAt: null, notify: false });
  expect(host.textContent).toContain("最多自动复查 3 轮"); expect(host.textContent).toContain("生成只读报告");
  expect(document.activeElement).toBe(host.querySelector('[role="status"]'));
});
it("keeps pause available during a background run", async () => {
  await render({ active: true, value: { enabled: true, remaining: 2, message: "等待变化", running: "run-1" } });
  const pause = host.querySelector<HTMLButtonElement>("button")!;
  expect(pause.disabled).toBe(false); await act(async () => pause.click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "pauseWatch" });
});
it("preserves an accessible error when the host refuses a stale delegation", async () => {
  onAction.mockRejectedValue("业务回执已变化，请先继续调查"); await render();
  await act(async () => host.querySelector<HTMLInputElement>('[name="agentWatchChanges"]')!.click());
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("业务回执已变化");
});
