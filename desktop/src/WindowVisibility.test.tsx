// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke, listen } = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
import { useDocumentVisible, type WindowVisibility } from "./WindowVisibility";
import { useVisiblePolling } from "./useVisiblePolling";
import { useWindowResumeRefresh } from "./useWindowResumeRefresh";
import { LifecycleVideo } from "./LifecycleVideo";
import { LifecycleAudio } from "./LifecycleAudio";
import { useLibraryManagement, type LibraryRuntime } from "./LibraryManagement";
import { resetCodexSuiteForTests, useCodexSuite, type CodexSnapshot } from "./CodexSuite";

let root: Root; let host: HTMLDivElement;
let deliver: (event: { payload: WindowVisibility }) => void;
const unlisten = vi.fn();
const shown: WindowVisibility = { revision: "1", visible: true, minimized: false, foreground: true };
function Probe() { const visible = useDocumentVisible(); return <output>{visible ? "visible" : "hidden"}</output>; }
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function event(payload: WindowVisibility) { await act(async () => deliver({ payload })); }
beforeEach(() => {
  resetCodexSuiteForTests();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  invoke.mockReset(); listen.mockReset(); unlisten.mockClear();
  invoke.mockResolvedValue(shown);
  listen.mockImplementation(async (_name, handler) => { deliver = handler; return unlisten; });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.useRealTimers();
  resetCodexSuiteForTests();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); Reflect.deleteProperty(document, "hidden");
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("shares one native listener and initial query across all visibility consumers", async () => {
  await act(async () => root.render(<><Probe key="a" /><Probe key="b" /></>)); await settle();
  expect(listen).toHaveBeenCalledTimes(1);
  expect(listen).toHaveBeenCalledWith("hub-window-visibility", expect.any(Function));
  expect(invoke).toHaveBeenCalledExactlyOnceWith("get_window_visibility");
  expect([...host.querySelectorAll("output")].map(item => item.textContent)).toEqual(["visible", "visible"]);
  await act(async () => root.render(<Probe key="a" />));
  expect(unlisten).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  expect(unlisten).toHaveBeenCalledOnce();
});

it("stops polling on host hide and minimize even while document.hidden remains false", async () => {
  vi.useFakeTimers(); const task = vi.fn().mockResolvedValue(undefined);
  function Poller() { useVisiblePolling(task, true, 1000); return <Probe />; }
  await act(async () => root.render(<Poller />)); await settle();
  expect(task).toHaveBeenCalledTimes(1);
  await event({ ...shown, revision: "2", visible: false });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(document.hidden).toBe(false); expect(task).toHaveBeenCalledTimes(1);
  await event({ ...shown, revision: "3" }); await settle();
  expect(task).toHaveBeenCalledTimes(2);
  await event({ ...shown, revision: "4", minimized: true });
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(task).toHaveBeenCalledTimes(2);
});

it("suspends library status polling on native hide while retaining completion events and refreshes once on restore", async () => {
  vi.useFakeTimers(); const removed = vi.fn(); const detachLibrary = vi.fn();
  let libraryEvent!: (event: { payload: LibraryRuntime }) => void;
  const runtime: LibraryRuntime = { libraryId: "main", state: "running", phase: "queued", detail: "", activeOperations: 1, pending: 0, updatedAt: 1 };
  listen.mockImplementation(async (name, handler) => {
    if (name === "hub-window-visibility") { deliver = handler; return unlisten; }
    expect(name).toBe("library-runtime-updated"); libraryEvent = handler; return detachLibrary;
  });
  invoke.mockImplementation(async command => command === "get_window_visibility" ? shown : { libraries: [runtime] });
  function Manager() { const manager = useLibraryManagement(true, removed); return <output>{manager.libraries.main?.state}</output>; }
  await act(async () => root.render(<Manager />)); await settle();
  const statusCalls = () => invoke.mock.calls.filter(([command]) => command === "library_control");
  expect(statusCalls()).toHaveLength(1);
  await event({ ...shown, revision: "2", visible: false });
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(document.hidden).toBe(false); expect(statusCalls()).toHaveLength(1);
  await act(async () => libraryEvent({ payload: { ...runtime, state: "removed", updatedAt: 3 } }));
  expect(removed).toHaveBeenCalledOnce(); expect(host.textContent).toBe("removed");
  await event({ ...shown, revision: "3" }); await settle();
  expect(statusCalls()).toHaveLength(2); expect(host.textContent).toBe("removed");
  await act(async () => root.render(null));
  expect(detachLibrary).toHaveBeenCalledOnce(); expect(unlisten).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(statusCalls()).toHaveLength(2);
});

it("an older initial query cannot overwrite a newer native hidden event", async () => {
  let finish!: (value: WindowVisibility) => void;
  invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<Probe />)); await settle();
  await event({ ...shown, revision: "2", visible: false });
  await act(async () => finish(shown)); await settle();
  expect(host.textContent).toBe("hidden");
  await event({ ...shown, revision: "3" });
  expect(host.textContent).toBe("visible");
  await event({ ...shown, revision: "1", visible: false });
  expect(host.textContent).toBe("visible");
});

it("waits for native subscription before querying when focus arrives during listener setup", async () => {
  let finish!: (dispose: () => void) => void;
  listen.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  invoke.mockResolvedValue({ ...shown, revision: "2", visible: false });
  await act(async () => root.render(<Probe />));
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(host.textContent).toBe("hidden");
  await act(async () => finish(unlisten)); await settle();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("get_window_visibility");
  expect(host.textContent).toBe("hidden");
});

it("disposes a listener that arrives after the last consumer unmounts", async () => {
  let finish!: (dispose: () => void) => void;
  listen.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<Probe />));
  await act(async () => root.render(null));
  await act(async () => finish(unlisten)); await settle();
  expect(unlisten).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalled();
});

it("coalesces host restore and focus while suspended hosts cannot trigger a refresh", async () => {
  vi.useFakeTimers(); const refresh = vi.fn().mockResolvedValue(undefined);
  function Resume() { useWindowResumeRefresh(refresh); return <Probe />; }
  await act(async () => root.render(<Resume />)); await settle();
  await act(async () => vi.advanceTimersByTimeAsync(80)); refresh.mockClear();
  await event({ ...shown, revision: "2", foreground: false });
  window.dispatchEvent(new Event("focus"));
  await act(async () => vi.advanceTimersByTimeAsync(80));
  expect(refresh).not.toHaveBeenCalled();
  invoke.mockResolvedValue({ ...shown, revision: "3" });
  await event({ ...shown, revision: "3" });
  window.dispatchEvent(new Event("focus"));
  await act(async () => vi.advanceTimersByTimeAsync(80));
  expect(refresh).toHaveBeenCalledOnce();
});

it("pauses video and audio on native hide, preserves position on restore, and releases both sources on unmount", async () => {
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const load = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  await act(async () => root.render(<><LifecycleVideo src="video.webm" /><LifecycleAudio src="audio.wav" /></>)); await settle();
  const media = [...host.querySelectorAll<HTMLMediaElement>("video,audio")];
  media.forEach(item => { item.currentTime = 17; }); pause.mockClear();
  await event({ ...shown, revision: "2", visible: false });
  expect(pause).toHaveBeenCalledTimes(2);
  await event({ ...shown, revision: "3" });
  expect(media.map(item => item.currentTime)).toEqual([17,17]);
  expect(play).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  expect(media.every(item => !item.hasAttribute("src"))).toBe(true);
  expect(load).toHaveBeenCalledTimes(2);
});

it("shares one Codex status schedule, pauses it while hidden, and releases the visibility owner after the last consumer", async () => {
  vi.useFakeTimers();
  const suite: CodexSnapshot = { settings: { model: "test", reasoningEffort: "low", fast: false, maxConcurrent: 2 }, jobs: [], revision: 1 };
  invoke.mockImplementation(async command => command === "get_window_visibility" ? shown : suite);
  function Suite() { const value = useCodexSuite(); return <output>{value.settings.model}</output>; }
  const calls = () => invoke.mock.calls.filter(([command]) => command === "model_runtime");
  await act(async () => root.render(<><Suite key="a" /><Suite key="b" /></>)); await settle();
  expect(calls()).toEqual([["model_runtime", { args: { action: "get" } }]]);
  expect(listen).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(1500)); expect(calls()).toHaveLength(2);
  await event({ ...shown, revision: "2", visible: false });
  await act(async () => vi.advanceTimersByTimeAsync(15000)); expect(calls()).toHaveLength(2);
  await event({ ...shown, revision: "3" }); await settle();
  expect(calls()).toHaveLength(3);
  await act(async () => root.render(<Suite key="a" />)); expect(unlisten).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1500)); expect(calls()).toHaveLength(4);
  await act(async () => root.render(null)); expect(unlisten).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(15000)); expect(calls()).toHaveLength(4);
});

it("coalesces repeated Codex restores during an older pending status into one fresh query", async () => {
  vi.useFakeTimers();
  const suite: CodexSnapshot = { settings: { model: "test", reasoningEffort: "low", fast: false, maxConcurrent: 2 }, jobs: [], revision: 1 };
  let finish!: (value: CodexSnapshot) => void; let calls = 0;
  invoke.mockImplementation(command => {
    if (command === "get_window_visibility") return Promise.resolve(shown);
    calls++; return calls === 2 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(suite);
  });
  function Suite() { useCodexSuite(); return null; }
  await act(async () => root.render(<Suite />)); await settle();
  await act(async () => vi.advanceTimersByTimeAsync(1500)); expect(calls).toBe(2);
  await event({ ...shown, revision: "2", visible: false });
  await event({ ...shown, revision: "3" });
  await event({ ...shown, revision: "4", minimized: true });
  await event({ ...shown, revision: "5" });
  await act(async () => vi.advanceTimersByTimeAsync(15000)); expect(calls).toBe(2);
  await act(async () => finish({ ...suite, revision: 2 })); await settle();
  expect(calls).toBe(3);
  await act(async () => vi.advanceTimersByTimeAsync(1499)); expect(calls).toBe(3);
  await act(async () => vi.advanceTimersByTimeAsync(1)); expect(calls).toBe(4);
});
