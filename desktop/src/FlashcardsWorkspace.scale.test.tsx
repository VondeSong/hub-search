// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Flashcard } from "./FlashcardTypes";
import { flashcardPageFixture, flashcardReviewPlanFixture } from "./FlashcardQuery.fixture";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { FlashcardsWorkspace } from "./FlashcardsWorkspace";
let root: Root, host: HTMLDivElement, cards: Flashcard[];
let intersections: Array<() => void>;
const deck = { id: "large", name: "Large deck", cardCount: 1201, dueCount: 1201, newCount: 0, updatedAt: 1 };
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
function button(text: string) { const element = [...host.querySelectorAll("button")].find(button => button.textContent?.includes(text)); if (!element) throw new Error(`Missing ${text}`); return element; }
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear(); invokeMock.mockReset();
  intersections = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { intersections.push(() => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
    observe() {} disconnect() {} unobserve() {}
  });
  cards = Array.from({ length: 1201 }, (_, index): Flashcard => ({ id: `card-${index}`, deckId: deck.id, question: `Question ${index}`, answer: `Answer ${index}`, explanation: "", cardType: "qa", cardData: {}, sourceLibraryId: "", sourceDocumentId: "", sourceBlockId: "", sourceTitle: "", sourcePath: "", sourceHash: "", media: [], tags: index === 1200 ? ["tail-tag"] : [], customFields: index === 1200 ? { "tail-field": "tail-value" } : {}, generation: {}, evidence: "", createdAt: 1, updatedAt: 1, dueAt: 1, intervalDays: 1, ease: 2.5, repetitions: 1, lapses: 0, sourceChanged: false }));
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "list_flashcard_decks") return [deck];
    if (command === "list_flashcard_deck_folders" || command === "list_flashcard_drafts") return [];
    if (command === "get_flashcard_dashboard_stats") return { totalCards: 1201, dueCards: 1201, newCards: 0, newDueCards: 0, newStudiedToday: 0, learningCards: 1201, masteredCards: 0, totalReviews: 0, reviewedToday: 0, retentionRate: 0, ratingCounts: [0,0,0,0], dailyActivity: [] };
    if (command === "get_flashcard_study_settings") return { dailyNewLimit: 10 };
    if (command === "get_flashcard_sync_settings") return { configured: false, autoSync: false, hasPassword: false, url: "", username: "", lastError: "" };
    if (command === "list_flashcards_page") return flashcardPageFixture(cards, args);
    if (command === "flashcard_review_plan") return flashcardReviewPlanFixture(cards, args);
    if (command === "get_flashcards_by_ids") return cards.filter(card => args.cardIds.includes(card.id));
    if (command === "list_flashcard_selection_ids") { const matches = flashcardPageFixture(cards, { ...args, offset: 0, limit: 2000 }); return { ids: matches.items.map(card => card.id), total: matches.total }; }
    if (command === "bulk_update_flashcards") return args.cardIds.length;
    if (command === "preview_flashcard_review") return { cardId: args.cardId, reviewKey: "key", desiredRetention: .9, choices: [600,4*86400,6*86400,15*86400].map((intervalSeconds,index) => ({ rating: index+1, intervalSeconds })) };
    if (command === "review_flashcard") return { reviewId: "review" };
    throw new Error(command);
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  if (host.querySelector(".workspace-filter-summary")) { await act(async () => button("清除筛选").click()); await settle(); }
  await act(async () => root.unmount()); host.remove(); localStorage.clear(); sessionStorage.clear();
  vi.unstubAllGlobals();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function openDeck() {
  await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />)); await settle();
  await act(async () => button("今日").click()); await settle();
  invokeMock.mockClear();
  await act(async () => button(deck.name).click()); await settle();
}

it("opens a large deck with one 60-card body page while retaining counts and tail-only field columns", async () => {
  await openDeck();
  expect(invokeMock.mock.calls.filter(([command]) => command === "list_flashcards_page")).toHaveLength(1);
  expect(host.querySelectorAll(".flashcards-database-table tbody tr")).toHaveLength(60);
  expect(host.textContent).toContain("1201 张卡片"); expect(host.textContent).toContain("tail-field");
  expect(host.textContent).not.toContain("Question 1200");
  await act(async () => intersections[intersections.length - 1]()); await settle();
  expect(invokeMock.mock.calls.filter(([command]) => command === "list_flashcards_page")).toHaveLength(2);
  expect(host.querySelectorAll(".flashcards-database-table tbody tr")).toHaveLength(120);
});

it("finds a matching card beyond the first 1000 through a new backend query", async () => {
  await openDeck();
  await act(async () => (host.querySelector('[aria-label="搜索卡片"]') as HTMLButtonElement).click());
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('.flashcards-toolbar-search input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"tail-value"); input.dispatchEvent(new Event("input",{bubbles:true}));
  }); await settle();
  expect(invokeMock).toHaveBeenLastCalledWith("list_flashcards_page",expect.objectContaining({ query: expect.objectContaining({ search: "tail-value" }) }));
  expect(host.textContent).toContain("Question 1200"); expect(host.querySelectorAll(".flashcards-database-table tbody tr")).toHaveLength(1);
});

it("selects and submits all 1201 IDs in one atomic bulk request without loading their bodies", async () => {
  await openDeck();
  await act(async () => (host.querySelector('[aria-label="全选当前卡片"]') as HTMLInputElement).click()); await settle();
  expect(host.textContent).toContain("已选 1201 张");
  expect(invokeMock.mock.calls.filter(([command]) => command === "list_flashcards_page")).toHaveLength(1);
  await act(async () => button("批量编辑").click());
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('.flashcards-batch-editor input[placeholder="用逗号分隔多个标签"]') ?? [...host.querySelectorAll<HTMLInputElement>('.flashcards-batch-editor input')].find(input => input.placeholder.includes("标签"))!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"bulk"); input.dispatchEvent(new Event("input",{bubbles:true}));
  });
  await act(async () => button("应用修改").click()); await settle();
  const request = invokeMock.mock.calls.find(([command]) => command === "bulk_update_flashcards")!;
  expect(request[1].cardIds).toHaveLength(1201); expect(request[1].cardIds).toContain("card-1200");
}, 15_000);

it("rates a review without rereading the hidden browser bodies", async () => {
  await openDeck();
  await act(async () => button("开始复习 20 张").click()); await settle();
  const before = invokeMock.mock.calls.filter(([command]) => command === "list_flashcards_page").length;
  await act(async () => button("显示答案").click()); await settle();
  await act(async () => (host.querySelector('.flashcards-ratings > .rating-3') as HTMLButtonElement).click()); await settle();
  expect(invokeMock).toHaveBeenCalledWith("review_flashcard",expect.objectContaining({ cardId: "card-0", expectedReviewKey: "key" }));
  expect(invokeMock.mock.calls.filter(([command]) => command === "list_flashcards_page")).toHaveLength(before);
  expect(host.querySelector(".flashcards-review-card")?.textContent).toContain("Question 1");
});
