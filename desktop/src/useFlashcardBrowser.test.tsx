// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Flashcard } from "./FlashcardTypes";
import type { FlashcardScope } from "./FlashcardQueries";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { useFlashcardBrowser } from "./useFlashcardBrowser";

let root: Root, host: HTMLDivElement;
let browser: ReturnType<typeof useFlashcardBrowser>;
let scope: FlashcardScope;
const errors = vi.fn();
const cards = (offset: number, length: number) => Array.from({ length }, (_, index) => ({ id: `card-${offset + index}` } as Flashcard));
const result = (offset = 0, length = 60) => ({ items: cards(offset, length), total: 1201, matchedTotal: 1201, revision: "42", asOf: 100, scopeTotal: 1300, tags: ["tail-tag"], customFieldKeys: ["tail-field"], stageCounts: { new: 1201, due: 0, learning: 0, mastered: 0, suspended: 0 } });
function Harness({ layout = "linear", enabled = true }: { layout?: "linear" | "grid" | "column"; enabled?: boolean }) {
  browser = useFlashcardBrowser(scope, layout, enabled, errors); return null;
}
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  scope = { deckId: "deck", dueOnly: false, query: { search: "", cardType: "all", stage: "all", sort: "updated", ascending: false, includeMastered: true } };
  errors.mockReset(); invokeMock.mockReset();
  invokeMock.mockImplementation(async (_command, args) => result(args.offset, Math.min(args.limit, 1201 - args.offset)));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("loads one body page with complete remote facets and loads the next page only on demand", async () => {
  await act(async () => root.render(<Harness />));
  expect(invokeMock).toHaveBeenCalledOnce(); expect(browser.page.items).toHaveLength(60);
  expect(browser.page.total).toBe(1201); expect(browser.page.tags).toEqual(["tail-tag"]); expect(browser.page.customFieldKeys).toEqual(["tail-field"]);
  await act(async () => browser.more());
  expect(invokeMock).toHaveBeenLastCalledWith("list_flashcards_page", expect.objectContaining({ offset: 60, limit: 60, revision: "42", asOf: 100, includeMetadata: false }));
  expect(browser.page.items).toHaveLength(120); expect(browser.page.items[119].id).toBe("card-119");
});

it("keeps gallery first body transfer at 12 cards and coalesces concurrent load-more calls", async () => {
  await act(async () => root.render(<Harness layout="grid" />));
  expect(browser.page.items).toHaveLength(12);
  let finish!: (value: unknown) => void;
  invokeMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = browser.more(); void browser.more(); });
  expect(invokeMock).toHaveBeenCalledTimes(2);
  await act(async () => { finish(result(12, 12)); await pending; });
  expect(browser.page.items).toHaveLength(24);
});

it("changes remote search without applying it only to the already loaded first page", async () => {
  await act(async () => root.render(<Harness />));
  scope = { ...scope, query: { ...scope.query, search: "tail" } };
  invokeMock.mockResolvedValue({ ...result(1200, 1), total: 1, matchedTotal: 1 });
  await act(async () => root.render(<Harness />));
  expect(invokeMock).toHaveBeenLastCalledWith("list_flashcards_page", expect.objectContaining({ query: expect.objectContaining({ search: "tail" }), offset: 0, revision: null, includeMetadata: true }));
  expect(browser.page.items.map(card => card.id)).toEqual(["card-1200"]);
});

it("discards a prior scope's late page and stops requesting pages while review hides the browser", async () => {
  let finish!: (value: unknown) => void;
  invokeMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<Harness />));
  scope = { ...scope, deckId: "new" };
  invokeMock.mockResolvedValue({ ...result(1200, 1), total: 1, matchedTotal: 1 });
  await act(async () => root.render(<Harness />));
  await act(async () => { finish(result()); });
  expect(browser.page.items.map(card => card.id)).toEqual(["card-1200"]);
  await act(async () => root.render(<Harness enabled={false} />));
  const calls = invokeMock.mock.calls.length;
  await act(async () => { await browser.refresh(); await browser.more(); });
  expect(invokeMock).toHaveBeenCalledTimes(calls);
  expect(browser.page.items).toEqual([]);
});

it("reads five complete stage projections with independent offsets on the same snapshot", async () => {
  invokeMock.mockImplementation(async (_command, args) => {
    const stage = args.query.columnStage ?? "metadata";
    return { ...result(args.offset, Math.min(args.limit, 70 - args.offset)), items: cards(args.offset, Math.min(args.limit, 70 - args.offset)).map(card => ({ ...card, id: `${stage}-${card.id}` })), total: 70, matchedTotal: 350, stageCounts: { new: 70, due: 70, learning: 70, mastered: 70, suspended: 70 } };
  });
  await act(async () => root.render(<Harness layout="column" />));
  expect(invokeMock).toHaveBeenCalledTimes(6);
  for (const stage of ["new", "due", "learning", "mastered", "suspended"] as const) expect(browser.columns[stage]?.items).toHaveLength(24);
  await act(async () => browser.more("due"));
  expect(browser.columns.due?.items).toHaveLength(48); expect(browser.columns.new?.items).toHaveLength(24);
  expect(invokeMock).toHaveBeenLastCalledWith("list_flashcards_page", expect.objectContaining({ offset: 24, revision: "42", asOf: 100, query: expect.objectContaining({ columnStage: "due" }) }));
});

it("restarts a changed snapshot once and never combines old and new bodies", async () => {
  await act(async () => root.render(<Harness />));
  invokeMock.mockRejectedValueOnce("FLASHCARD_LIST_CHANGED").mockResolvedValueOnce({ ...result(1200, 1), total: 1, matchedTotal: 1, revision: "43" });
  await act(async () => browser.more());
  expect(browser.page.items.map(card => card.id)).toEqual(["card-1200"]); expect(browser.page.revision).toBe("43");
  expect(errors).not.toHaveBeenCalled();
});

it("selects all matching IDs without reading any additional body page", async () => {
  await act(async () => root.render(<Harness />));
  invokeMock.mockResolvedValue({ ids: Array.from({ length: 1201 }, (_, index) => `card-${index}`), total: 1201 });
  let selected: string[] | null = null;
  await act(async () => { selected = await browser.selectAll(); });
  expect(selected).toHaveLength(1201);
  expect(invokeMock).toHaveBeenCalledTimes(2);
  expect(invokeMock).toHaveBeenLastCalledWith("list_flashcard_selection_ids", expect.objectContaining({ revision: "42", asOf: 100, limit: 2000 }));
});

it("bounds repeated revision failures and leaves a recoverable error", async () => {
  invokeMock.mockRejectedValue("FLASHCARD_LIST_CHANGED");
  await act(async () => root.render(<Harness />)); await settle();
  expect(invokeMock).toHaveBeenCalledTimes(2); expect(errors).toHaveBeenCalledOnce(); expect(browser.busy).toBe(false);
});
