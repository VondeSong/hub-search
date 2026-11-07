// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Flashcard } from "./FlashcardTypes";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { loadFlashcardPage, loadFlashcardSelection, loadFlashcardReviewPlan, loadFlashcardsByIds, type FlashcardScope } from "./FlashcardQueries";
import { useFlashcardBrowser } from "./useFlashcardBrowser";
beforeEach(() => { invokeMock.mockReset(); });
const scope: FlashcardScope = { deckId: "deck", dueOnly: false, query: { search: "tail", cardType: "qa", stage: "all", sort: "question", ascending: true, includeMastered: false } };

it("passes complete filters and one requested body page instead of scanning the collection", async () => {
  invokeMock.mockResolvedValue({ items: [{ id: "card-1200" }], total: 1, matchedTotal: 1, revision: "42", asOf: 100, scopeTotal: 1201, tags: ["tail-tag"], customFieldKeys: ["tail-field"] });
  expect((await loadFlashcardPage(scope, 0, 60, null, null, true)).items[0].id).toBe("card-1200");
  expect(invokeMock).toHaveBeenCalledOnce();
  expect(invokeMock).toHaveBeenCalledWith("list_flashcards_page", { ...scope, offset: 0, limit: 60, revision: null, asOf: null, includeMetadata: true });
});

it("selects every matching ID beyond 2000 with fixed revision and time without loading bodies", async () => {
  const ids = Array.from({ length: 2501 }, (_, index) => `card-${index}`);
  invokeMock.mockImplementation(async (command, args) => {
    expect(command).toBe("list_flashcard_selection_ids");
    expect(args.revision).toBe("42"); expect(args.asOf).toBe(100);
    return { ids: ids.slice(args.offset, args.offset + args.limit), total: ids.length };
  });
  expect(await loadFlashcardSelection(scope, "42", 100)).toEqual(ids);
  expect(invokeMock).toHaveBeenCalledTimes(2);
});

it("stops ID selection when navigation supersedes the view", async () => {
  let current = true;
  invokeMock.mockImplementation(async () => { current = false; return { ids: ["old"], total: 2501 }; });
  expect(await loadFlashcardSelection(scope, "1", 1, () => current)).toEqual([]);
  expect(invokeMock).toHaveBeenCalledOnce();
});

it("rejects incomplete ID selection rather than silently treating it as all cards", async () => {
  invokeMock.mockResolvedValue({ ids: [], total: 2501 });
  await expect(loadFlashcardSelection(scope, "1", 1)).rejects.toThrow("分页未完成");
});

it("restores explicit IDs outside the first 1000 and preserves review order across unordered SQL results", async () => {
  const ids = Array.from({ length: 401 }, (_, index) => `card-${index}`);
  invokeMock.mockImplementation(async (command, args) => {
    expect(command).toBe("get_flashcards_by_ids");
    return [...args.cardIds].reverse().map((id: string) => ({ id } as Flashcard));
  });
  const result = await loadFlashcardsByIds([...ids, "card-0"]);
  expect(result.map(card => card.id)).toEqual(ids);
  expect(invokeMock).toHaveBeenCalledTimes(3);
});

it("requests review eligibility independently of browser filters and never caps an unlimited session", async () => {
  invokeMock.mockResolvedValue({ sessionIds: ["card-1200"], eligibleCount: 1201, newAvailable: 1200, newWaiting: 0, revision: "2", asOf: 100 });
  expect((await loadFlashcardReviewPlan(null, 0)).eligibleCount).toBe(1201);
  expect(invokeMock).toHaveBeenCalledWith("flashcard_review_plan", { deckId: null, sessionLimit: 0 });
});

// Preserve the original regression identities against the new page owner.
// Body pages now load on demand; revision/time and late-response protection
// remain requirements even though the old eager collection helper is gone.
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
let browser: ReturnType<typeof useFlashcardBrowser>;
const viewError = vi.fn();
function Harness({ value, enabled = true }: { value: FlashcardScope; enabled?: boolean }) {
  browser = useFlashcardBrowser(value, "linear", enabled, viewError);
  return null;
}
function page(items: Flashcard[], total: number, revision: string) {
  return { items, total, matchedTotal: total, scopeTotal: total, revision, asOf: 100, tags: [], customFieldKeys: [] };
}
async function mount(value: FlashcardScope, enabled = true) {
  if (!root) {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div"); document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(createElement(Harness, { value, enabled })));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined; host = undefined; viewError.mockReset();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("reads cards beyond 1000 with a stable revision and due-time boundary", async () => {
  const cards = Array.from({ length: 1201 }, (_, id) => ({ id: `card-${id}` } as Flashcard));
  const dueScope = { ...scope, dueOnly: true };
  invokeMock.mockImplementation(async (command, args) => {
    expect(command).toBe("list_flashcards_page");
    expect(args.deckId).toBe("deck"); expect(args.dueOnly).toBe(true);
    if (args.offset) { expect(args.revision).toBe("42"); expect(args.asOf).toBe(100); }
    return page(cards.slice(args.offset, args.offset + args.limit), cards.length, "42");
  });
  await mount(dueScope);
  expect(browser.page.items).toHaveLength(60);
  while (browser.page.items.length < browser.page.total) await act(async () => browser.more());
  expect(browser.page.items).toEqual(cards);
  expect(browser.page.items[browser.page.items.length - 1]?.id).toBe("card-1200");
  expect(invokeMock).toHaveBeenCalledTimes(21);
  expect(viewError).not.toHaveBeenCalled();
});

it("restores only saved IDs and retains a card outside the first 1000", async () => {
  invokeMock.mockResolvedValue([{ id: "card-1200" }]);
  expect(await loadFlashcardsByIds(["card-1200", "card-1200", "deleted"])).toEqual([{ id: "card-1200" }]);
  expect(invokeMock).toHaveBeenCalledOnce();
  expect(invokeMock).toHaveBeenCalledWith("get_flashcards_by_ids", { cardIds: ["card-1200", "deleted"] });
});

it("stops fetching pages once navigation has superseded the view", async () => {
  let finish!: (value: unknown) => void;
  invokeMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await mount(scope);
  await mount(scope, false);
  await act(async () => { finish(page([{ id: "old" } as Flashcard], 1201, "1")); });
  await act(async () => browser.more());
  expect(browser.page.items).toEqual([]);
  expect(invokeMock).toHaveBeenCalledOnce();
  expect(viewError).not.toHaveBeenCalled();
});

it("retries a changed revision once instead of joining incompatible pages", async () => {
  invokeMock.mockResolvedValueOnce(page([{ id: "old" } as Flashcard], 2, "1"))
    .mockRejectedValueOnce("FLASHCARD_LIST_CHANGED")
    .mockResolvedValueOnce(page([{ id: "new" } as Flashcard], 1, "2"));
  await mount(scope);
  await act(async () => browser.more());
  expect(browser.page.items).toEqual([{ id: "new" }]);
  expect(browser.page.revision).toBe("2");
  expect(invokeMock).toHaveBeenCalledTimes(3);
  expect(invokeMock.mock.calls[2][1]).toMatchObject({ offset: 0, revision: null, asOf: null });
  expect(viewError).not.toHaveBeenCalled();
});
