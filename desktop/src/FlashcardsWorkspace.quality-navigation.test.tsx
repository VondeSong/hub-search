// @vitest-environment jsdom

import { flashcardPageFixture, flashcardReviewPlanFixture } from "./FlashcardQuery.fixture";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Flashcard, FlashcardDeckSummary } from "./FlashcardTypes";
import { editorValuesForCard } from "./FlashcardEditorState";
import { FLASHCARD_EDITOR_DRAFT_KEY, saveFlashcardEditorDraft } from "./EditorDraftStorage";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { FlashcardsWorkspace } from "./FlashcardsWorkspace";

const decks: FlashcardDeckSummary[] = [
  { id: "deck-due", name: "今日牌组", cardCount: 2, dueCount: 1, newCount: 0, updatedAt: 100 },
  { id: "deck-other", name: "其他牌组", cardCount: 1, dueCount: 0, newCount: 0, updatedAt: 100 },
];
const dueCard: Flashcard = {
  id: "card-due", deckId: decks[0].id, question: "今日待复习的问题", answer: "今日答案", explanation: "",
  cardType: "qa", cardData: {}, sourceLibraryId: "library-test", sourceDocumentId: "document-test",
  sourceBlockId: "", sourceTitle: "测试来源", sourcePath: "测试/质量", sourceHash: "hash-test",
  media: [], tags: [], evidence: "测试原卡导航", confidence: 1, customFields: {}, generation: {},
  createdAt: 10, updatedAt: 100, dueAt: 1, intervalDays: 1, ease: 2.5, repetitions: 1,
  lapses: 0, sourceChanged: false,
};
let target: Flashcard;
let allCards: Flashcard[];
let container: HTMLDivElement;
let root: Root;
let originalShowModal: PropertyDescriptor | undefined;
const notices = vi.fn();

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const result = [...host.querySelectorAll("button")].find(item => item.textContent?.includes(text));
  if (!result) throw new Error(`找不到按钮：${text}`);
  return result;
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); sessionStorage.clear();
  notices.mockReset(); invokeMock.mockReset();
  originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  target = { ...dueCard, id: "card-feedback", deckId: decks[1].id, question: "原卡最新问题", answer: "原卡最新答案", status: "suspended" };
  allCards = [dueCard, target];
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "list_flashcard_decks") return decks;
    if (command === "list_flashcard_deck_folders" || command === "list_flashcard_drafts") return [];
    if (command === "get_flashcard_dashboard_stats") return { totalCards: 2, dueCards: 1, newCards: 0, learningCards: 0, masteredCards: 1, totalReviews: 0, reviewedToday: 0, retentionRate: 0, ratingCounts: [0, 0, 0, 0], dailyActivity: [] };
    if (command === "get_flashcard_study_settings") return { dailyNewLimit: 10, updatedAt: 0 };
    if (command === "get_flashcard_sync_settings") return { url: "", username: "", hasPassword: false, autoSync: false, configured: false, lastError: "" };
    if (command === "list_flashcards_page") return flashcardPageFixture(allCards, args);
    if (command === "flashcard_review_plan") return flashcardReviewPlanFixture(allCards, args);
    if (command === "get_flashcards_by_ids") return allCards.filter(card => (args?.cardIds as string[]).includes(card.id));
    if (command === "sync_flashcard_quality_if_enabled") return { state: "local" };
    if (command === "get_flashcard_quality") return {
      records: [{ id: "feedback-test", kind: "feedback", updatedAt: 100, cardId: target.id, draft: false,
        reason: "low-value", comment: "测试质量反馈", action: "pause", status: "open", excludeTarget: false,
        snapshot: { ...target, question: "反馈中的旧快照" } }],
      document: "", revision: "revision-test", sync: { enabled: false, pending: false, error: "" },
    };
    throw new Error(`未处理的 Tauri 命令：${command}`);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear();
  delete document.documentElement.dataset.runtimePlatform;
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function openQualityFromToday() {
  await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} onStatusMessage={notices} />));
  await settle();
  await act(async () => button(container, "今日").click());
  await settle();
  expect(container.querySelector(document.documentElement.dataset.runtimePlatform === "android" ? ".mobile-flashcard-today" : ".flashcards-overview-due")).not.toBeNull();
  if (document.documentElement.dataset.runtimePlatform === "android") {
    await act(async () => button(container.querySelector<HTMLElement>(".mobile-flashcard-tabs")!, "牌库").click());
    expect(container.querySelector(".flashcards-workspace")?.classList.contains("mobile-page-library")).toBe(true);
  }
  await act(async () => button(container, "质量与制卡偏好").click());
  await settle();
  await act(async () => { await vi.dynamicImportSettled(); });
  const quality = container.querySelector<HTMLDialogElement>("dialog.flashcard-quality")!;
  expect(quality.open).toBe(true);
  expect(quality.textContent).toContain("反馈中的旧快照");
  return quality;
}

it("opens the exact search card from another deck without starting a review",async()=>{
 const handled=vi.fn();
 await act(async()=>root.render(<FlashcardsWorkspace onClose={()=>undefined} initialCardId={target.id} onSearchTargetHandled={handled}/>));
 await settle();
 expect(invokeMock).toHaveBeenCalledWith("get_flashcards_by_ids",{cardIds:[target.id]});
 expect(handled).toHaveBeenCalledOnce();
 expect(container.querySelector('[role="dialog"][aria-label="编辑闪卡"]')).not.toBeNull();
 expect(invokeMock.mock.calls.some(([command])=>/review_flashcard|submit_flashcard_review/.test(command))).toBe(false);
});

it("keeps the selected deck when a prior deck's read finishes later and sends one read per navigation", async () => {
  await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
  await settle();
  const original = invokeMock.getMockImplementation()!;
  let finish!: (value: unknown) => void;
  invokeMock.mockImplementation((command, args) => command === "list_flashcards_page" && args?.deckId === decks[0].id
    ? new Promise(resolve => { finish = resolve; }) : original(command, args));
  invokeMock.mockClear();
  await act(async () => button(container, decks[0].name).click());
  await act(async () => button(container, decks[1].name).click());
  expect(invokeMock.mock.calls.filter(([command, args]) => command === "list_flashcards_page" && args?.deckId === decks[0].id)).toHaveLength(1);
  await act(async () => { finish({ items: [dueCard], total: 1, revision: "1", asOf: 1 }); await Promise.resolve(); });
  await settle();
  expect(invokeMock.mock.calls.filter(([command, args]) => command === "list_flashcards_page" && args?.deckId === decks[1].id)).toHaveLength(1);
  expect(container.querySelector(".flashcards-main h1")?.textContent).toBe(decks[1].name);
  expect(container.querySelector(".flashcards-main")?.textContent).toContain(target.question);
  expect(container.querySelector(".flashcards-main")?.textContent).not.toContain(dueCard.question);
});

it.each([
  ["paused card absent from Today", false, "suspended", 1, decks[0].id],
  ["future card in another deck", false, "active", 4102444800, decks[1].id],
  ["Android card in another deck", true, "suspended", 1, decks[1].id],
] as const)("quality navigation opens the original editor for %s", async (_scenario, android, status, dueAt, deckId) => {
  if (android) document.documentElement.dataset.runtimePlatform = "android";
  target = { ...target, status, dueAt, deckId }; allCards = [dueCard, target];
  const quality = await openQualityFromToday();
  await act(async () => button(quality, "查看原卡").click());
  await settle();
  expect(container.querySelector("dialog.flashcard-quality")).toBeNull();
  const editor = container.querySelector<HTMLElement>('[role="dialog"][aria-label="编辑闪卡"]');
  expect(editor).not.toBeNull();
  expect(editor!.querySelector<HTMLTextAreaElement>("[data-editor-question]")!.value).toBe(target.question);
  expect(editor!.querySelector<HTMLTextAreaElement>("[data-editor-answer]")!.value).toBe(target.answer);
  expect(container.querySelector(".flashcards-main h1")?.textContent).toBe(decks.find(deck => deck.id === deckId)!.name);
  if (android) {
    expect(container.querySelector(".flashcards-workspace")?.classList.contains("mobile-page-deck")).toBe(true);
    expect(container.querySelector(".flashcards-mobile-topbar strong")?.textContent).toBe(decks[1].name);
  }
  expect(invokeMock.mock.calls.some(([name]) => ["update_flashcard", "delete_flashcard", "create_flashcard_draft"].includes(name))).toBe(false);
  await act(async () => button(editor!, "取消").click());
  expect(container.querySelector('[aria-label="编辑闪卡"]')).toBeNull();
  expect(container.querySelector(".flashcards-main")?.hasAttribute("inert")).toBe(false);
  if (android) await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="返回牌库"]')!.click());
  const todayNavigation = android ? container.querySelector<HTMLElement>(".mobile-flashcard-tabs")! : container;
  await act(async () => button(todayNavigation, "今日").click());
  await settle();
  expect(container.querySelector(android ? ".mobile-flashcard-today" : ".flashcards-overview-due")).not.toBeNull();
  if (android) expect(container.querySelector(".flashcards-workspace")?.classList.contains("mobile-page-review")).toBe(true);
  expect(container.querySelector(".flashcards-main")?.textContent).not.toContain(target.question);
});

it("quality navigation keeps the feedback snapshot and reports a deleted original without an invisible editor", async () => {
  allCards = [dueCard];
  const quality = await openQualityFromToday();
  await act(async () => button(quality, "查看原卡").click());
  await settle();
  expect(notices).toHaveBeenCalledWith("原卡片已删除，质量记录中的快照仍保留", "error", 8_000);
  expect(quality.isConnected).toBe(true); expect(quality.open).toBe(true);
  expect(quality.textContent).toContain("反馈中的旧快照");
  expect(container.querySelector('[aria-label="编辑闪卡"]')).toBeNull();
  expect(container.querySelector(".flashcards-main")?.hasAttribute("inert")).toBe(false);
});

it("quality navigation preserves the existing draft, feedback panel and Today list when replacement is cancelled", async () => {
  expect(saveFlashcardEditorDraft(localStorage, { version: 1, target: { kind: "edit", cardId: dueCard.id }, values: { ...editorValuesForCard(dueCard), question: "尚未保存的本机问题" }, updatedAt: 200 })).toBe(true);
  const stored = localStorage.getItem(FLASHCARD_EDITOR_DRAFT_KEY);
  const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
  const quality = await openQualityFromToday();
  const today = container.querySelector(".flashcards-main")!.innerHTML;
  await act(async () => button(quality, "查看原卡").click());
  await settle();
  expect(confirmation).toHaveBeenCalledOnce();
  expect(localStorage.getItem(FLASHCARD_EDITOR_DRAFT_KEY)).toBe(stored);
  expect(quality.isConnected).toBe(true); expect(quality.open).toBe(true);
  expect(container.querySelector('[aria-label="编辑闪卡"]')).toBeNull();
  expect(container.querySelector(".flashcards-main")?.hasAttribute("inert")).toBe(false);
  expect(container.querySelector(".flashcards-main")!.innerHTML).toBe(today);
  expect(container.querySelector(".flashcards-overview-due")).not.toBeNull();
});
