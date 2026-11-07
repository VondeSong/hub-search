type Refresh = { key: string; task: () => Promise<void>; promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void };

// One active read and one coalesced follow-up. Writes request a fresh read;
// ordinary polling joins the current read instead of building a backlog.
export class SerialRefresh {
  private active: Refresh | null = null;
  private queued: Refresh | null = null;

  run(key: string, task: () => Promise<void>, fresh = false): Promise<void> {
    if (this.active?.key === key && !fresh) return this.active.promise;
    if (this.active) {
      if (this.queued) { this.queued.key = key; this.queued.task = task; return this.queued.promise; }
      this.queued = this.create(key, task);
      return this.queued.promise;
    }
    const request = this.create(key, task);
    this.start(request);
    return request.promise;
  }

  private create(key: string, task: () => Promise<void>): Refresh {
    let resolve!: () => void, reject!: (reason: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { key, task, promise, resolve, reject };
  }

  private start(request: Refresh) {
    this.active = request;
    const finish = (failed: boolean, reason?: unknown) => {
      this.active = null;
      const next = this.queued; this.queued = null;
      if (next) this.start(next);
      if (failed) request.reject(reason); else request.resolve();
    };
    void Promise.resolve().then(request.task).then(() => finish(false), error => finish(true, error));
  }
}
