import { describe, expect, it } from "vitest";
import type { LibrarySyncHealth } from "./IndexStatusTypes";
import { isLibraryActionRequired, isLibraryAwaitingRetry, librarySyncState } from "./SyncHealthPresentation";

const health = (overrides: Partial<LibrarySyncHealth> = {}): LibrarySyncHealth => ({
  libraryId: "library-a",
  provider: "craft",
  name: "Main",
  documentCount: 10,
  pendingJobs: 0,
  failedJobs: 0,
  consecutiveFailures: 0,
  ...overrides,
});

describe("sync health presentation", () => {
  it("keeps transient synchronization failures quiet while automatic retry is pending", () => {
    const value = health({ syncPhase: "partial", consecutiveFailures: 1, lastError: "temporary" });
    expect(isLibraryAwaitingRetry(value)).toBe(true);
    expect(isLibraryActionRequired(value)).toBe(false);
    expect(librarySyncState(value, true)).toEqual({ tone: "waiting", label: "等待自动重试" });
  });

  it("raises persistent failures after the third consecutive failure", () => {
    const value = health({ syncPhase: "failed", consecutiveFailures: 3, lastError: "still failing" });
    expect(isLibraryAwaitingRetry(value)).toBe(false);
    expect(isLibraryActionRequired(value)).toBe(true);
    expect(librarySyncState(value, true)).toEqual({ tone: "failed", label: "已停止自动重试 · 3 次失败" });
  });

  it("always surfaces exhausted background jobs", () => {
    const value = health({ failedJobs: 1, consecutiveFailures: 1, lastError: "download failed" });
    expect(isLibraryActionRequired(value)).toBe(true);
  });
});

it("distinguishes queued jobs from executing workers", () => {
  expect(librarySyncState(health({pendingJobs:1,runningJobs:0}),true)).toEqual({tone:"waiting",label:"等待处理 1"});
  expect(librarySyncState(health({pendingJobs:2,runningJobs:1}),true)).toEqual({tone:"working",label:"处理中 1"});
});
