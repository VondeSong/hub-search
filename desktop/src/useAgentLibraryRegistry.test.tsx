// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySummary } from "./SearchTypes";
import { agentLibraryScopeSummary, resolveAgentLibraries, useAgentLibraryRegistry, type AgentLibraryRegistry } from "./useAgentLibraryRegistry";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), handlers: new Set<() => void>(), stop: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

const library = (id: string, name = id): LibrarySummary => ({ id, name, provider: "craft", connected: true, documentCount: 12, excludedPaths: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("assistant library registry", () => {
  let host: HTMLDivElement, root: Root, registry: AgentLibraryRegistry;
  function Harness({ enabled = true }: { enabled?: boolean }) { registry = useAgentLibraryRegistry(enabled); return null; }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    native.invoke.mockReset().mockResolvedValue([library("one", "原库名")]);
    native.listen.mockReset().mockImplementation(async (_event: string, handler: () => void) => {
      native.handlers.add(handler);
      return () => { native.handlers.delete(handler); native.stop(); };
    });
    native.stop.mockClear(); native.handlers.clear();
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  it("reads the real registry and refreshes renamed/added libraries without restoring connections", async () => {
    await act(async () => root.render(<Harness />));
    expect(registry!.libraries.map(item => item.name)).toEqual(["原库名"]);
    expect(registry!.loaded).toBe(true);
    expect(native.listen).toHaveBeenCalledWith("library-registry-updated", expect.any(Function));
    native.invoke.mockResolvedValueOnce([library("one", "新库名"), library("two", "新增库")]);
    await act(async () => native.handlers.forEach(handler => handler()));
    expect(registry!.libraries.map(item => item.name)).toEqual(["新库名", "新增库"]);
    expect(native.invoke.mock.calls.every(call => call[0] === "list_libraries")).toBe(true);
  });

  it("does not let a slower refresh replace a newer registry snapshot", async () => {
    await act(async () => root.render(<Harness />));
    const older = deferred<LibrarySummary[]>(), newer = deferred<LibrarySummary[]>();
    native.invoke.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    await act(async () => { void registry!.reload(); void registry!.reload(); });
    await act(async () => newer.resolve([library("one", "最新库名")]));
    await act(async () => older.resolve([library("one", "旧快照")]));
    expect(registry!.libraries[0].name).toBe("最新库名");
    expect(registry!.loading).toBe(false);
  });

  it("supports retry and keeps the last successful snapshot on a refresh error", async () => {
    native.invoke.mockRejectedValueOnce(new Error("读取失败"));
    await act(async () => root.render(<Harness />));
    expect(registry!.loaded).toBe(false);
    expect(registry!.error).toContain("读取失败");
    await act(async () => registry!.reload());
    expect(registry!.loaded).toBe(true);
    expect(registry!.error).toBe("");
    native.invoke.mockRejectedValueOnce(new Error("刷新失败"));
    await act(async () => registry!.reload());
    expect(registry!.libraries.map(item => item.id)).toEqual(["one"]);
    expect(registry!.loaded).toBe(true);
    expect(registry!.error).toContain("刷新失败");
  });

  it("stays inactive when disabled and ignores a pending read after disabling", async () => {
    await act(async () => root.render(<Harness enabled={false} />));
    expect(native.invoke).not.toHaveBeenCalled();
    expect(native.listen).not.toHaveBeenCalled();
    const pending = deferred<LibrarySummary[]>(); native.invoke.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(<Harness enabled={false} />));
    await act(async () => pending.resolve([library("late", "迟到快照")]));
    expect(registry!.libraries).toEqual([]);
    expect(registry!.loading).toBe(false);
    expect(native.handlers.size).toBe(0);
    expect(native.stop).toHaveBeenCalledTimes(1);
  });

  it("cleans up a listener that finishes subscribing after the hook is disabled", async () => {
    const pending = deferred<() => void>(); native.listen.mockReturnValueOnce(pending.promise);
    await act(async () => root.render(<Harness />));
    await act(async () => root.render(<Harness enabled={false} />));
    const stop = vi.fn(); await act(async () => pending.resolve(stop));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("still loads the list if event subscription fails and explains manual refresh", async () => {
    native.listen.mockRejectedValueOnce(new Error("事件不可用"));
    await act(async () => root.render(<Harness />));
    expect(registry!.libraries.map(item => item.id)).toEqual(["one"]);
    expect(registry!.watchError).toContain("可点击刷新");
  });
});

describe("library scope display identity", () => {
  it("resolves current names, retains unavailable identities and never shows a raw ID as a name", () => {
    const registry = { libraries: [library("one", "重命名后的库")], loaded: true };
    expect(resolveAgentLibraries([{ id: "one", name: "旧名称" }, { id: "gone", name: "归档资料" }, { id: "internal-id", name: "internal-id" }], registry)).toEqual([
      { id: "one", name: "重命名后的库" }, { id: "gone", name: "归档资料" }, { id: "internal-id", name: "资料库不可用" },
    ]);
    expect(resolveAgentLibraries([{ id: "one", name: "one" }], { libraries: [], loaded: false })).toEqual([{ id: "one", name: "已选资料库" }]);
  });

  it("describes an explicit current all-library selection without authorizing later additions", () => {
    const selected = [{ id: "one", name: "一" }, { id: "two", name: "二" }];
    const registry = { libraries: [library("one", "库一"), library("two", "库二")], loaded: true };
    expect(agentLibraryScopeSummary(selected, registry).label).toBe("全部资料库 · 2");
    expect(agentLibraryScopeSummary(selected, { ...registry, libraries: [...registry.libraries, library("new")] }).label).toBe("2 个资料库");
    expect(agentLibraryScopeSummary(selected, { ...registry, libraries: registry.libraries.slice(0, 1) }).unavailableCount).toBe(1);
    expect(agentLibraryScopeSummary([], registry, "当前页面").label).toBe("当前页面");
    expect(selected).toEqual([{ id: "one", name: "一" }, { id: "two", name: "二" }]);
  });
});
