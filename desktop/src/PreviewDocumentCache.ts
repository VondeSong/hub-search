type Priority = "foreground" | "prefetch";
type Request = { key: string; loader: () => Promise<string>; priority: Priority; promise: Promise<string>; resolve: (value: string) => void; reject: (reason: unknown) => void; signal?: AbortSignal; cancel?: () => void; started: boolean };

export class PreviewDocumentCache {
  private readonly values = new Map<string, string>();
  private readonly pending = new Map<string, Request>();
  private readonly queue: Request[] = [];
  private active = 0;
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxActive: number;
  private readonly maxQueued: number;

  constructor(private readonly limit = 24, options: { maxBytes?: number; maxActive?: number; maxQueued?: number } = {}) {
    this.maxBytes = Math.max(0, options.maxBytes ?? 8 * 1024 * 1024);
    this.maxActive = Math.max(1, options.maxActive ?? 2);
    this.maxQueued = Math.max(0, options.maxQueued ?? 24);
  }

  // JavaScript retains up to two bytes per UTF-16 code unit. This budget bounds
  // document strings, independently of the entry limit; content is never cut.
  get retainedBytes(): number { return this.bytes; }

  get size(): number {
    return this.values.size;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get(key: string): string | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  prefetch(key: string, loader: () => Promise<string>): void {
    if (this.pending.size >= this.maxActive) return;
    void this.load(key, loader, "prefetch").catch(() => undefined);
  }

  load(key: string, loader: () => Promise<string>, priority: Priority = "foreground", signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new DOMException("Preview cancelled", "AbortError"));
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inFlight = this.pending.get(key);
    if (inFlight) { if (priority === "foreground") inFlight.priority = priority; return inFlight.promise; }
    if (this.active >= this.maxActive && this.queue.length >= this.maxQueued) return Promise.reject(new Error("预览读取队列已满，请稍后重试"));

    let resolve!: (value: string) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    const request: Request = { key, loader, priority, promise, resolve, reject, signal, started: false };
    request.cancel = () => {
      if (request.started) return; // IPC already in progress retains its slot until it settles.
      const index = this.queue.indexOf(request); if (index !== -1) this.queue.splice(index, 1);
      this.pending.delete(key); signal?.removeEventListener("abort", request.cancel!);
      reject(new DOMException("Preview cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", request.cancel, { once: true });
    this.pending.set(key, request);
    this.queue.push(request); this.drain();
    return promise;
  }

  private drain() {
    while (this.active < this.maxActive && this.queue.length) {
      const foreground = this.queue.findIndex(request => request.priority === "foreground");
      const request = this.queue.splice(foreground === -1 ? 0 : foreground, 1)[0];
      request.started = true; this.active++;
      let loaded: Promise<string>;
      try { loaded = request.loader(); } catch (error) { loaded = Promise.reject(error); }
      void loaded.then(value => {
        const size = value.length * 2;
        if (size <= this.maxBytes && this.limit > 0) {
          this.values.set(request.key, value); this.bytes += size;
          while (this.values.size > this.limit || this.bytes > this.maxBytes) {
            const oldest = this.values.keys().next().value; if (oldest === undefined) break;
            this.bytes -= this.values.get(oldest)!.length * 2; this.values.delete(oldest);
          }
        }
        this.finish(request); request.resolve(value);
      }, error => { this.finish(request); request.reject(error); });
    }
  }

  private finish(request: Request) {
    request.signal?.removeEventListener("abort", request.cancel!);
    this.pending.delete(request.key); this.active--; this.drain();
  }
}
