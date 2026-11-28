import { invoke } from "@tauri-apps/api/core";

export type UserProfileSnapshot = { contextId: string; initialized: boolean; values: Record<string, string> };
export type UserProfileChange = { key: string; value: string | null };
export type UserProfileStorageStatus = { ready: boolean; saving: boolean; pending: number; error: string };
export type UserProfileTransport = {
  load(): Promise<UserProfileSnapshot>;
  importLegacy(contextId: string, changes: UserProfileChange[]): Promise<UserProfileSnapshot>;
  save(contextId: string, changes: UserProfileChange[]): Promise<void>;
};

const LEGACY_MIGRATION_MARKER = "__hub_user_profile_migrated_v1";
const MAX_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_BYTES = 16 * 1024 * 1024;
export const USER_PROFILE_PREPARE_FLUSH_EVENT = "hub:prepare-user-profile-flush";
export const isUserProfileKey = (key: string) => key.startsWith("hub.") || key.startsWith("hub-") || key.startsWith("craft-search-");
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const describeError = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Synchronous reads keep existing business state initialization deterministic.
 * Only the acknowledged database transaction removes a pending write. */
export class UserProfileStore implements Storage {
  private values = new Map<string, string>();
  private pending = new Map<string, { value: string | null; revision: number }>();
  private invalidValues = new Map<string, string>();
  private revision = 0;
  private contextId = "";
  private initialization?: Promise<void>;
  private writing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  private status: UserProfileStorageStatus = { ready: false, saving: false, pending: 0, error: "" };

  constructor(private transport: UserProfileTransport, private legacyStorage?: Storage) {}
  getStatus = () => this.status;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<UserProfileStorageStatus> = {}) {
    this.status = { ...this.status, ...patch, pending: this.pending.size };
    this.listeners.forEach(listener => listener());
  }
  private requireReady() { if (!this.status.ready) throw new Error("个人数据尚未加载，请稍后重试"); }

  initialize(): Promise<void> {
    if (this.status.ready) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.initialization = Promise.resolve().then(async () => {
      try {
        let snapshot = await this.transport.load();
        if (!snapshot.initialized) {
          const changes: UserProfileChange[] = [];
          if (this.legacyStorage && !this.legacyStorage.getItem(LEGACY_MIGRATION_MARKER)) {
            for (let index = 0; index < this.legacyStorage.length; index++) {
              const key = this.legacyStorage.key(index);
              if (key && isUserProfileKey(key)) {
                const value = this.legacyStorage.getItem(key);
                if (value !== null) changes.push({ key, value });
              }
            }
          }
          snapshot = await this.transport.importLegacy(snapshot.contextId, changes);
        }
        if (!snapshot.initialized || !snapshot.contextId || !snapshot.values || typeof snapshot.values !== "object") {
          throw new Error("个人数据返回无效，未打开资料库");
        }
        const entries = Object.entries(snapshot.values);
        if (entries.some(([key, value]) => !isUserProfileKey(key) || typeof value !== "string")) {
          throw new Error("个人数据格式无效，未打开资料库");
        }
        this.contextId = snapshot.contextId;
        this.values = new Map(entries);
        // The database marker also protects restart if browser storage is unavailable.
        try { this.legacyStorage?.setItem(LEGACY_MIGRATION_MARKER, "1"); } catch { /* No data is stored here after migration. */ }
        this.publish({ ready: true, error: "" });
      } catch (error) { this.publish({ error: describeError(error) }); throw error; }
      finally { this.initialization = undefined; }
    });
    return this.initialization;
  }

  get length() { this.requireReady(); return this.values.size; }
  keys(prefix: string) { this.requireReady(); return [...this.values.keys()].filter(key => key.startsWith(prefix)); }
  key(index: number) { this.requireReady(); return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { this.requireReady(); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    this.requireReady();
    if (!isUserProfileKey(key) || byteLength(key) > 1024) throw new Error("不支持的个人数据键");
    if (byteLength(value) > MAX_VALUE_BYTES) {
      const error = "单项个人数据超过 8 MB，请缩减内容后重试保存";
      this.values.set(key, value); this.invalidValues.set(key, error);
      this.publish({ error }); this.queue(key, value);
      throw new Error(error);
    }
    if (this.invalidValues.delete(key) && !this.invalidValues.size) this.publish({ error: "" });
    if (this.values.get(key) === value) return;
    this.values.set(key, value); this.queue(key, value);
  }
  removeItem(key: string) {
    this.requireReady();
    if (!this.values.has(key)) return;
    if (this.invalidValues.delete(key) && !this.invalidValues.size) this.publish({ error: "" });
    this.values.delete(key); this.queue(key, null);
  }
  clear() { this.requireReady(); for (const key of [...this.values.keys()]) this.removeItem(key); }
  private queue(key: string, value: string | null) {
    this.pending.set(key, { value, revision: ++this.revision }); this.publish();
    if (!this.timer && !this.status.error) this.timer = setTimeout(() => {
      this.timer = undefined; void this.flush().catch(() => { /* Retained and shown until retry succeeds. */ });
    }, 100);
  }

  flush(): Promise<void> {
    this.requireReady();
    clearTimeout(this.timer); this.timer = undefined;
    if (this.invalidValues.size) return Promise.reject(new Error(this.invalidValues.values().next().value));
    if (this.writing) return this.writing;
    if (!this.pending.size) { this.publish({ error: "" }); return Promise.resolve(); }
    this.publish({ saving: true, error: "" });
    this.writing = Promise.resolve().then(async () => {
      try {
        while (this.pending.size) {
          if (this.invalidValues.size) throw new Error(this.invalidValues.values().next().value);
          const batch: Array<[string, { value: string | null; revision: number }]> = [];
          let bytes = 0;
          for (const entry of this.pending) {
            const size = byteLength(entry[0]) + byteLength(entry[1].value ?? "");
            if (batch.length && (batch.length >= 64 || bytes + size > MAX_BATCH_BYTES)) break;
            batch.push(entry); bytes += size;
          }
          await this.transport.save(this.contextId, batch.map(([key, item]) => ({ key, value: item.value })));
          for (const [key, item] of batch) if (this.pending.get(key)?.revision === item.revision) this.pending.delete(key);
          this.publish();
        }
      } catch (error) { this.publish({ error: describeError(error) }); throw error; }
      finally { this.writing = undefined; this.publish({ saving: false }); }
    });
    return this.writing;
  }
}

function nativeHost() {
  const host = typeof window === "undefined" ? undefined
    : (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  return typeof host?.invoke === "function";
}
let store: UserProfileStore | undefined;
let browserStatus: UserProfileStorageStatus = { ready: false, saving: false, pending: 0, error: "" };
const listeners = new Set<() => void>();
const publish = () => listeners.forEach(listener => listener());

function activeStorage(): Storage {
  if (store) return store;
  if (nativeHost()) throw new Error("个人数据尚未加载，请稍后重试");
  // Explicit adapter for the Vite browser preview; native runs never fall back here.
  return window.localStorage;
}

export function userProfileKeys(prefix: string): string[] {
  if (store) return store.keys(prefix);
  const storage = activeStorage();
  return Object.keys(storage).filter(key => key.startsWith(prefix));
}

export const userProfileStorage: Storage = {
  get length() { return activeStorage().length; },
  key: index => activeStorage().key(index),
  getItem: key => activeStorage().getItem(key),
  setItem: (key, value) => { activeStorage().setItem(key, value); if (!store) publish(); },
  removeItem: key => { activeStorage().removeItem(key); if (!store) publish(); },
  clear: () => {
    const storage = activeStorage();
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    keys.forEach(key => { if (key && isUserProfileKey(key)) storage.removeItem(key); });
    if (!store) publish();
  },
};
export const getUserProfileStorageStatus = () => store?.getStatus() ?? browserStatus;
export const subscribeUserProfileStorage = (listener: () => void) => {
  listeners.add(listener); return () => { listeners.delete(listener); };
};

export async function initializeUserProfileStorage() {
  if (!nativeHost()) { browserStatus = { ...browserStatus, ready: true }; publish(); return; }
  if (!store) {
    store = new UserProfileStore({
      load: () => invoke<UserProfileSnapshot>("load_user_profile"),
      importLegacy: (contextId, changes) => invoke<UserProfileSnapshot>("import_legacy_user_profile", { contextId, changes }),
      save: (contextId, changes) => invoke("save_user_profile_changes", { contextId, changes }),
    }, window.localStorage);
    store.subscribe(publish);
  }
  await store.initialize();
}

export async function flushUserProfileStorage() {
  window.dispatchEvent(new Event(USER_PROFILE_PREPARE_FLUSH_EVENT));
  if (store) await store.flush();
  else if (nativeHost()) throw new Error("个人数据尚未加载，请稍后重试");
}
export async function retryUserProfileStorage() {
  await initializeUserProfileStorage(); await flushUserProfileStorage();
}
