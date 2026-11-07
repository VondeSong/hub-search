import { SerialRefresh } from "./SerialRefresh";

// Navigation and refresh share one owner for accepting data and errors.
export class ViewRequest {
  private key = "";
  private generation = 0;
  private queue = new SerialRefresh();
  select(key: string) { if (key !== this.key) { this.key = key; this.generation++; } }
  invalidate() { this.generation++; }
  guard(key: string) { const generation = this.generation; return () => key === this.key && generation === this.generation; }
  run<T>(key: string, read: (current: () => boolean) => Promise<T>, apply: (value: T) => void, fresh = true): Promise<void> {
    if (key !== this.key) return Promise.resolve();
    if (fresh) this.generation++;
    const generation = this.generation;
    const current = () => key === this.key && generation === this.generation;
    return this.queue.run(key, async () => {
      if (!current()) return;
      try { const value = await read(current); if (current()) apply(value); }
      catch (error) { if (current()) throw error; }
    }, fresh);
  }
}
