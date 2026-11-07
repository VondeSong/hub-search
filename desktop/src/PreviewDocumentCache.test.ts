import { describe, expect, it, vi } from "vitest";
import { PreviewDocumentCache } from "./PreviewDocumentCache";

describe("PreviewDocumentCache", () => {
  it("bounds retained string bytes and returns oversized documents without caching them", async () => {
    const cache = new PreviewDocumentCache(24, { maxBytes: 6 });
    await cache.load("a", async () => "ab");
    await cache.load("b", async () => "cd");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("cd");
    expect(cache.retainedBytes).toBe(4);
    await expect(cache.load("large", async () => "1234")).resolves.toBe("1234");
    expect(cache.get("large")).toBeUndefined();
    expect(cache.retainedBytes).toBeLessThanOrEqual(6);
  });

  it("limits concurrent reads and prioritizes selected previews over queued prefetch", async () => {
    const cache = new PreviewDocumentCache(24, { maxActive: 1 });
    let finish!: (value: string) => void;
    const order: string[] = [];
    const active = cache.load("active", () => { order.push("active"); return new Promise(resolve => { finish = resolve; }); });
    const prefetch = cache.load("neighbor", async () => { order.push("neighbor"); return "neighbor"; }, "prefetch");
    const selected = cache.load("selected", async () => { order.push("selected"); return "selected"; });
    expect(order).toEqual(["active"]);
    finish("active"); await Promise.all([active, prefetch, selected]);
    expect(order).toEqual(["active", "selected", "neighbor"]);
  });

  it("removes a cancelled queued preview before its reader starts", async () => {
    const cache = new PreviewDocumentCache(24, { maxActive: 1, maxQueued: 1 });
    let finish!: (value: string) => void;
    const active = cache.load("active", () => new Promise(resolve => { finish = resolve; }));
    const cancelledReader = vi.fn(async () => "old"); const abort = new AbortController();
    const obsolete = cache.load("old", cancelledReader, "foreground", abort.signal);
    const rejection = expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    abort.abort(); await rejection;
    const latest = cache.load("latest", async () => "latest");
    finish("active"); await active; await expect(latest).resolves.toBe("latest");
    expect(cancelledReader).not.toHaveBeenCalled(); expect(cache.pendingCount).toBe(0);
  });
  it("deduplicates requests that are already in flight", async () => {
    const cache = new PreviewDocumentCache();
    let resolveRequest!: (value: string) => void;
    const loader = vi.fn(() => new Promise<string>((resolve) => { resolveRequest = resolve; }));

    const first = cache.load("page", loader);
    const second = cache.load("page", loader);
    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.pendingCount).toBe(1);

    resolveRequest("正文");
    await expect(first).resolves.toBe("正文");
    expect(cache.pendingCount).toBe(0);
    await expect(cache.load("page", loader)).resolves.toBe("正文");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("keeps a bounded least-recently-used cache", async () => {
    const cache = new PreviewDocumentCache(2);
    const loader = vi.fn(async (value: string) => value);

    await cache.load("a", () => loader("A"));
    await cache.load("b", () => loader("B"));
    expect(cache.get("a")).toBe("A");
    await cache.load("c", () => loader("C"));

    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBe("A");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe("C");
  });

  it("removes failed requests so a later retry can succeed", async () => {
    const cache = new PreviewDocumentCache();
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce("已恢复");

    await expect(cache.load("page", loader)).rejects.toThrow("temporary");
    expect(cache.pendingCount).toBe(0);
    await expect(cache.load("page", loader)).resolves.toBe("已恢复");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
