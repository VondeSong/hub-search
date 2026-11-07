// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AgentConversation } from "./AgentDelivery";
import { AgentCharts } from "./AgentCharts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 360, 240));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});

it.runIf(Boolean(import.meta.env.VITE_HUB_ARTIFACT_SOURCE_JSON))("navigates persisted fixed evidence with Unicode offsets and hides late source responses", async () => {
  const saved = JSON.parse(import.meta.env.VITE_HUB_ARTIFACT_REOPEN_JSON);
  const captures = JSON.parse(import.meta.env.VITE_HUB_ARTIFACT_SOURCE_JSON);
  const render = (revoked = false, recordVersion = 1) => act(async () => root.render(
    <AgentCharts workId={saved.view.work.id} recordVersion={recordVersion} items={[saved.historical]} revoked={revoked} />,
  ));
  const open = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "查看固定原文")!;
  await render();
  vi.mocked(invoke).mockResolvedValueOnce(captures.source);
  await act(async () => open().click());
  expect(invoke).toHaveBeenLastCalledWith("agent_investigation", { args: { action: "artifactSource", id: saved.view.work.id, artifactId: saved.historical.artifactId, revision: 1, rowId: "jan1", evidenceIndex: 0 } });
  expect(host.querySelector("mark")?.textContent).toBe(captures.source.evidence.text);
  expect(host.querySelector('[aria-label="固定原文上下文"]')?.textContent).toContain("💤é");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "关闭固定原文")!.click());
  expect(host.querySelector("mark")).toBeNull();
  vi.mocked(invoke).mockRejectedValueOnce("snapshot_expired");
  await act(async () => open().click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("snapshot_expired");
  expect(host.querySelector("mark")).toBeNull();
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => open().click());
  await render(false, 2);
  await act(async () => resolve(captures.source));
  expect(host.querySelector("mark")).toBeNull();
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => open().click());
  await render(true, 2);
  await act(async () => resolve(captures.source));
  expect(host.textContent).toBe("");
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); });

it.runIf(Boolean(import.meta.env.VITE_HUB_ARTIFACT_REOPEN_JSON))("opens the persisted historical sleep revision and drops pending reads on revoke or state refresh", async () => {
  const saved = JSON.parse(import.meta.env.VITE_HUB_ARTIFACT_REOPEN_JSON);
  const render = (revoked = false, recordVersion = 1) => act(async () => root.render(
    <AgentConversation workId={saved.view.work.id} recordVersion={recordVersion} conversation={saved.view.conversation} revoked={revoked} onOpenCitation={() => {}} />,
  ));
  const open = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "查看第 1 版图表")!;
  await render();
  expect(host.querySelector("svg")).toBeNull();
  vi.mocked(invoke).mockResolvedValueOnce(saved.historical);
  await act(async () => open().click());
  expect(invoke).toHaveBeenLastCalledWith("agent_investigation", { args: { action: "artifact", id: saved.view.work.id, artifactId: saved.historical.artifactId, revision: 1 } });
  expect(host.querySelector("svg")).not.toBeNull();
  expect(host.querySelector("tbody")?.textContent).toContain("7.5");
  expect(host.querySelector("tbody")?.textContent).not.toContain("7.25");
  expect(host.textContent).toContain("固定版本");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "关闭历史图表")!.click());
  expect(host.querySelector("svg")).toBeNull();
  vi.mocked(invoke).mockRejectedValueOnce("snapshot_expired");
  await act(async () => open().click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("snapshot_expired");
  expect(host.querySelector("svg")).toBeNull();
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => open().click());
  await render(false, 2);
  await act(async () => resolve(saved.historical));
  expect(host.querySelector("svg")).toBeNull();
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => open().click());
  await render(true, 2);
  await act(async () => resolve(saved.historical));
  expect(host.textContent).toBe("");
});
