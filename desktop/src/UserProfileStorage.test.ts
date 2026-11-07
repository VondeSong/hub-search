import { describe, expect, it, vi } from "vitest";
import { UserProfileStore, type UserProfileChange, type UserProfileTransport } from "./UserProfileStorage";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
  };
}

function server(initialized = true, initial: Record<string, string> = {}) {
  let values = { ...initial };
  const calls: UserProfileChange[][] = [];
  const snapshot = () => ({ contextId: "profile-a", initialized, values: { ...values } });
  const transport: UserProfileTransport = {
    load: vi.fn(async () => snapshot()),
    importLegacy: vi.fn(async (_contextId, changes) => {
      if (!initialized) {
        for (const { key, value } of changes) if (!(key in values) && value !== null) values[key] = value;
        initialized = true;
      }
      return snapshot();
    }),
    save: vi.fn(async (contextId, changes) => {
      if (contextId !== "profile-a") throw new Error("wrong profile");
      calls.push(changes);
      for (const { key, value } of changes) {
        if (value === null) delete values[key]; else values[key] = value;
      }
    }),
  };
  return { transport, calls, snapshot };
}

describe("portable personal data", () => {
  it("hydrates before reads, imports owned legacy keys once and preserves existing target values", async () => {
    const legacy = memoryStorage({ "hub.favorite": "old", "craft-search-history-v1": "[1]", "other.application": "private" });
    const backend = server(false, { "hub.favorite": "target" });
    const store = new UserProfileStore(backend.transport, legacy);
    expect(() => store.getItem("hub.favorite")).toThrow("尚未加载");
    await store.initialize();
    expect(store.getItem("hub.favorite")).toBe("target");
    expect(store.getItem("craft-search-history-v1")).toBe("[1]");
    expect(store.getItem("other.application")).toBeNull();
    const reopened = new UserProfileStore(backend.transport, legacy);
    await reopened.initialize();
    expect(backend.transport.importLegacy).toHaveBeenCalledTimes(1);
    expect(legacy.getItem("hub.favorite")).toBe("old");
  });

  it("does not inject the old machine state into an existing or switched library", async () => {
    const legacy = memoryStorage({ "hub.favorite": "old-machine" });
    const first = new UserProfileStore(server(false).transport, legacy);
    await first.initialize();
    const anotherBackend = server(false);
    const another = new UserProfileStore(anotherBackend.transport, legacy);
    await another.initialize();
    expect(anotherBackend.transport.importLegacy).toHaveBeenCalledWith("profile-a", []);
    expect(another.getItem("hub.favorite")).toBeNull();
    const sealedBackend = server(true);
    const sealed = new UserProfileStore(sealedBackend.transport, memoryStorage({ "hub.favorite": "old-machine" }));
    await sealed.initialize();
    expect(sealedBackend.transport.importLegacy).not.toHaveBeenCalled();
    expect(sealed.getItem("hub.favorite")).toBeNull();
  });

  it("retains legacy state and blocks consumers when migration fails, then retries", async () => {
    const backend = server(false);
    const importOnce = backend.transport.importLegacy;
    backend.transport.importLegacy = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockImplementation(importOnce);
    const legacy = memoryStorage({ "hub.favorite": "old" });
    const store = new UserProfileStore(backend.transport, legacy);
    await expect(store.initialize()).rejects.toThrow("disk full");
    expect(store.getStatus()).toMatchObject({ ready: false, error: "disk full" });
    expect(legacy.length).toBe(1);
    await store.initialize();
    expect(store.getItem("hub.favorite")).toBe("old");
  });

  it("serializes in-flight saves and flushes mutations made before the first acknowledgement", async () => {
    const backend = server();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const save = backend.transport.save;
    backend.transport.save = vi.fn(async (contextId, changes) => {
      if (changes[0].value === "one") await gate;
      await save(contextId, changes);
    });
    const store = new UserProfileStore(backend.transport);
    await store.initialize();
    store.setItem("hub.favorite", "one");
    const flush = store.flush();
    await Promise.resolve();
    store.setItem("hub.favorite", "two");
    store.setItem("hub.draft", "unsaved edit");
    expect(store.getItem("hub.favorite")).toBe("two");
    expect(backend.transport.save).toHaveBeenCalledTimes(1);
    release(); await flush;
    expect(backend.calls).toEqual([
      [{ key: "hub.favorite", value: "one" }],
      [{ key: "hub.favorite", value: "two" }, { key: "hub.draft", value: "unsaved edit" }],
    ]);
    expect(store.getStatus()).toMatchObject({ pending: 0, saving: false, error: "" });
    const reopened = new UserProfileStore(backend.transport);
    await reopened.initialize();
    expect(reopened.getItem("hub.favorite")).toBe("two");
    expect(reopened.getItem("hub.draft")).toBe("unsaved edit");
  });

  it("keeps failed writes visible and retryable, including deletion", async () => {
    const backend = server(true, { "hub.remove": "old" });
    const save = backend.transport.save;
    backend.transport.save = vi.fn().mockRejectedValueOnce(new Error("database busy")).mockImplementation(save);
    const store = new UserProfileStore(backend.transport);
    await store.initialize();
    store.removeItem("hub.remove");
    store.setItem("hub.draft", "new draft");
    await expect(store.flush()).rejects.toThrow("database busy");
    expect(store.getStatus()).toMatchObject({ pending: 2, error: "database busy", saving: false });
    expect(store.getItem("hub.draft")).toBe("new draft");
    expect(backend.snapshot().values).toEqual({ "hub.remove": "old" });
    await store.flush();
    expect(backend.snapshot().values).toEqual({ "hub.draft": "new draft" });
    expect(store.getStatus().pending).toBe(0);
  });

  it("coalesces unstarted writes and prevents unsupported or oversized data", async () => {
    const backend = server(); const store = new UserProfileStore(backend.transport);
    await store.initialize();
    store.setItem("hub.view", "one"); store.setItem("hub.view", "two");
    expect(() => store.setItem("other.app", "x")).toThrow();
    expect(() => store.setItem("hub.large", "x".repeat(8 * 1024 * 1024 + 1))).toThrow("8 MB");
    await expect(store.flush()).rejects.toThrow("8 MB");
    expect(backend.calls).toHaveLength(0);
    store.removeItem("hub.large");
    await store.flush();
    expect(backend.calls).toEqual([[{ key: "hub.view", value: "two" }, { key: "hub.large", value: null }]]);
    expect(store.length).toBe(1);
  });
});
