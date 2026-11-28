// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createLinkedInsightTask, listInsightTaskLinks, saveInsightTaskLink } from "./InsightActionLinks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(async () => { localStorage.clear(); vi.clearAllMocks(); const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>("node:crypto"); vi.stubGlobal("crypto", webcrypto); });
afterEach(() => vi.unstubAllGlobals());

it("keeps separate library identities and makes repeated linking idempotent", async () => {
  const link = { insightId: "finding-1", libraryId: "work", taskId: "task-1" };
  const second = { ...link, libraryId: "personal" };
  localStorage.setItem("hub.unrelated", "existing preference");
  await Promise.all([saveInsightTaskLink(link), saveInsightTaskLink(second), saveInsightTaskLink(link)]);
  expect(listInsightTaskLinks()).toEqual(expect.arrayContaining([link, second]));
  expect(listInsightTaskLinks()).toHaveLength(2);
  await expect(saveInsightTaskLink({ ...link, taskId: "" })).rejects.toThrow();
  expect(listInsightTaskLinks()).toHaveLength(2);
  expect(localStorage.getItem("hub.unrelated")).toBe("existing preference");
});

it("replays an uncertain creation with the same native identity before linking the confirmed task", async () => {
  const request = { insightId: "finding", libraryId: "work", projectId: "list", title: "Review", priority: 0 as const };
  vi.mocked(invoke).mockResolvedValueOnce({ state: "unknown" }).mockResolvedValueOnce({
    state: "confirmed", libraryId: "work", taskId: "native-id",
  });
  await expect(createLinkedInsightTask(request)).rejects.toThrow("待核对");
  expect(listInsightTaskLinks()).toEqual([]);
  await createLinkedInsightTask(request);
  expect(vi.mocked(invoke).mock.calls[0]).toEqual(vi.mocked(invoke).mock.calls[1]);
  expect(listInsightTaskLinks()).toEqual([{ insightId: "finding", libraryId: "work", taskId: "native-id" }]);
});
