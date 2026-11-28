const entry = "hub.reading.entry";
const stages = ["entry-to-first-row", "entry-to-empty", "retained-page-ready",
  "database-page-ready", "entry-to-request", "list-request", "response-to-row"];

export function markReadingEntry() {
  performance.clearMarks?.(entry);
  performance.mark?.(entry);
}

export function startReadingTiming() {
  for (const stage of stages) performance.clearMeasures?.("hub.reading." + stage);
  const mounted = performance.now();
  const navigation = performance.getEntriesByName?.(entry, "mark")[0]?.startTime;
  performance.clearMarks?.(entry);
  const started = navigation !== undefined && mounted - navigation < 30_000 ? navigation : mounted;
  let requested: number | undefined;
  let received: number | undefined;
  let finished = false;
  const measure = (name: string, start: number, end: number) => {
    const key = "hub.reading." + name;
    performance.clearMeasures?.(key);
    performance.measure?.(key, { start, end });
  };
  return {
    request() {
      if (!finished) {
        requested = performance.now();
        received = undefined;
      }
    },
    response() {
      if (!finished) received = performance.now();
    },
    ready(source: "retained" | "database", empty: boolean) {
      if (finished) return;
      finished = true;
      const ready = performance.now();
      measure(empty ? "entry-to-empty" : "entry-to-first-row", started, ready);
      measure(source === "retained" ? "retained-page-ready" : "database-page-ready", mounted, ready);
      if (source === "database" && requested !== undefined && received !== undefined) {
        measure("entry-to-request", started, requested);
        measure("list-request", requested, received);
        measure("response-to-row", received, ready);
      }
    },
  };
}
