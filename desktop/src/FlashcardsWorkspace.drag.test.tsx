// @vitest-environment jsdom

import { flashcardPageFixture, flashcardReviewPlanFixture } from "./FlashcardQuery.fixture";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Flashcard, FlashcardDeckSummary, FlashcardSyncSettings } from "./FlashcardTypes";
import { editorValuesForCard } from "./FlashcardEditorState";
import { FLASHCARD_EDITOR_DRAFT_KEY, saveFlashcardEditorDraft } from "./EditorDraftStorage";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { FlashcardsWorkspace } from "./FlashcardsWorkspace";

const folder = { id: "folder-a", name: "新建文件夹", sortOrder: 0, updatedAt: 1 };
const baseDeck: FlashcardDeckSummary = { id: "deck-a", name: "待移动牌组", folderId: "", sortOrder: 0, cardCount: 0, dueCount: 0, newCount: 0, updatedAt: 1 };
const syncSettings: FlashcardSyncSettings = { url: "", username: "", hasPassword: false, autoSync: false, configured: false, lastError: "" };
const baseCard: Flashcard = {
  id: "card-a", deckId: baseDeck.id, question: "可拖拽的看板卡片", answer: "答案", explanation: "", cardType: "qa", cardData: {},
  sourceLibraryId: "", sourceDocumentId: "", sourceBlockId: "", sourceTitle: "来源", sourcePath: "", sourceHash: "", media: [], tags: [], evidence: "",
  customFields: {}, generation: {}, createdAt: 1, updatedAt: 1, dueAt: 1, intervalDays: 0, ease: 2.5, repetitions: 0, lapses: 0, sourceChanged: false,
};

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function pointerEvent(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 }, pointerId: { value: 1 }, pointerType: { value: "mouse" },
    clientX: { value: x }, clientY: { value: y }, ctrlKey: { value: false },
  });
  return event;
}

function setTextareaValue(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("FlashcardsWorkspace deck folders", () => {
  let root: Root;
  let container: HTMLDivElement;
  let movedFolderId = "";
  let cardStageValue: "new" | "due" | "learning" | "mastered" = "new";
  let includeCards = false;
  let updateFailuresRemaining = 0;
  let deferNextUpdate = false;
  let resolveDeferredUpdate: ((card: Flashcard) => void) | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem("hub.flashcards.deck-folder-expansion", "[]");
    movedFolderId = "";
    cardStageValue = "new";
    includeCards = false;
    updateFailuresRemaining = 0;
    deferNextUpdate = false;
    resolveDeferredUpdate = null;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, args?: { folderId?: string; stage?: typeof cardStageValue }) => {
      if (command === "list_flashcard_decks") return [{ ...baseDeck, folderId: movedFolderId }];
      if (command === "list_flashcard_deck_folders") return [folder];
      if (command === "list_flashcard_drafts") return [];
      if (command === "list_flashcards_page") return flashcardPageFixture(includeCards ? [{ ...baseCard, repetitions: cardStageValue === "new" ? 0 : cardStageValue === "mastered" ? 3 : 1, intervalDays: cardStageValue === "mastered" ? 30 : cardStageValue === "learning" ? 1 : 0, dueAt: cardStageValue === "learning" || cardStageValue === "mastered" ? 4_000_000_000 : 1 }] : [], args);
      if (command === "flashcard_review_plan") return flashcardReviewPlanFixture(includeCards ? [baseCard] : [], args);
      if (command === "get_flashcards_by_ids") return includeCards ? [baseCard] : [];
      if (command === "get_flashcard_dashboard_stats") return { totalCards: 1, dueCards: 1, newCards: 1, learningCards: 0, masteredCards: 0, totalReviews: 0, reviewedToday: 0, retentionRate: 0, ratingCounts: [0,0,0,0], dailyActivity: [] };
      if (command === "get_flashcard_study_settings") return { dailyNewLimit: 10, updatedAt: 0 };
      if (command === "get_flashcard_sync_settings") return syncSettings;
      if (command === "update_flashcard") {
        if (updateFailuresRemaining > 0) {
          updateFailuresRemaining -= 1;
          throw new Error("磁盘暂时不可写");
        }
        if (deferNextUpdate) {
          deferNextUpdate = false;
          return new Promise<Flashcard>((resolve) => { resolveDeferredUpdate = resolve; });
        }
        return baseCard;
      }
      if (command === "move_flashcard_deck") { movedFolderId = args?.folderId ?? ""; return null; }
      if (command === "set_flashcard_stage") { cardStageValue = args?.stage ?? "new"; return baseCard; }
      throw new Error(`未处理的 Tauri 命令：${command}`);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("creates an independent deck and opens it without creating a folder", async () => {
    const previous = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "create_flashcard_deck") return baseDeck.id;
      return previous(command, args);
    });
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
    await settle();
    await act(async () => (container.querySelector('[aria-label="新建牌组"]') as HTMLButtonElement).click());
    const input = container.querySelector('[aria-label="牌组名称"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  独立测试  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => (container.querySelector('[aria-label="创建牌组"]') as HTMLButtonElement).click());
    await settle();
    expect(invokeMock).toHaveBeenCalledWith("create_flashcard_deck", { name: "独立测试" });
    expect(invokeMock).not.toHaveBeenCalledWith("create_flashcard_deck_folder", expect.anything());
    expect(invokeMock).toHaveBeenCalledWith("list_flashcards_page", expect.objectContaining({ deckId: baseDeck.id, dueOnly: false, offset: 0 }));
    expect(container.querySelector('[aria-label="牌组名称"]')).toBeNull();
  });

  it("moves a deck onto a folder row and expands that folder", async () => {
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
    await settle();

    const deckButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(baseDeck.name));
    const folderButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(folder.name));
    expect(deckButton).toBeTruthy();
    expect(folderButton?.getAttribute("aria-expanded")).toBe("false");

    Object.defineProperty(deckButton, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => folderButton) });
    await act(async () => {
      deckButton!.dispatchEvent(pointerEvent("pointerdown", 10, 10));
      deckButton!.dispatchEvent(pointerEvent("pointermove", 30, 30));
      deckButton!.dispatchEvent(pointerEvent("pointerup", 30, 30));
    });
    await settle();

    expect(movedFolderId).toBe(folder.id);
    expect(folderButton?.getAttribute("aria-expanded")).toBe("true");
    expect(localStorage.getItem("hub.flashcards.deck-folder-expansion")).toContain(folder.id);
  });

  it("resizes, persists, and keyboard-resets the deck sidebar", async () => {
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
    await settle();

    const body = container.querySelector<HTMLElement>(".flashcards-body")!;
    const resizer = container.querySelector<HTMLElement>('.flashcards-decks-resizer[role="separator"]')!;
    expect(resizer.getAttribute("aria-valuenow")).toBe("264");
    Object.defineProperty(body, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON: () => ({}) }),
    });
    Object.defineProperty(resizer, "setPointerCapture", { value: vi.fn() });

    await act(async () => {
      resizer.dispatchEvent(pointerEvent("pointerdown", 264, 20));
      window.dispatchEvent(pointerEvent("pointermove", 332, 20));
      window.dispatchEvent(pointerEvent("pointerup", 332, 20));
    });

    expect(resizer.getAttribute("aria-valuenow")).toBe("332");
    expect(localStorage.getItem("hub.flashcards.deck-sidebar-width-v1")).toBe("332");
    expect(document.body.classList.contains("resizing-flashcard-decks")).toBe(false);

    await act(async () => resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(resizer.getAttribute("aria-valuenow")).toBe("264");
    expect(localStorage.getItem("hub.flashcards.deck-sidebar-width-v1")).toBe("264");
  });

  it("switches the active view type, renames it, and closes the settings popover", async () => {
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
    await settle();

    const deckButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(baseDeck.name));
    await act(async () => deckButton!.click());
    await settle();

    const activeViewButton = container.querySelector<HTMLButtonElement>('[title="配置当前视图"]');
    await act(async () => activeViewButton!.click());
    expect(container.querySelector('[aria-label="配置当前视图"]')).toBeTruthy();

    const galleryButton = [...container.querySelectorAll<HTMLButtonElement>(".flashcards-view-type-list button")]
      .find((button) => button.textContent?.trim().startsWith("画廊"));
    await act(async () => galleryButton!.click());

    expect(container.querySelector('[aria-label="配置当前视图"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[title="配置当前视图"]')?.textContent).toContain("画廊");
    expect(container.querySelector<HTMLButtonElement>('[title="配置当前视图"]')?.textContent).not.toContain("画廊视图");
    expect(localStorage.getItem("hub.flashcards.saved-deck-views-v1")).toContain('"type":"grid"');
    const sizeButton = (label: string) => container.querySelector<HTMLButtonElement>(`.flashcards-density-toolbar [aria-label="${label}卡片"]`)!;
    expect(sizeButton("中").getAttribute("aria-pressed")).toBe("true");
    await act(async () => sizeButton("大").click());
    expect(sizeButton("大").getAttribute("aria-pressed")).toBe("true");
    expect(sizeButton("中").getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem("hub.flashcards.saved-deck-views-v1")).toContain('"cardLayout":"spacious"');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="卡片配置"]')!.click());
    const layoutButton = [...container.querySelectorAll<HTMLButtonElement>(".flashcards-card-config-menu button")].find(button => button.textContent?.startsWith("布局"))!;
    await act(async () => layoutButton.click());
    expect(container.querySelector(".flashcards-card-layout-options .selected")?.textContent).toBe("大");
    const small = [...container.querySelectorAll<HTMLButtonElement>(".flashcards-card-layout-options button")].find(button => button.textContent === "小")!;
    await act(async () => small.click());
    expect(sizeButton("小").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("hub.flashcards.saved-deck-views-v1")).toContain('"cardLayout":"compact"');

  });

  it("closes the view settings when focus moves outside", async () => {
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
    await settle();
    const deckButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(baseDeck.name));
    await act(async () => deckButton!.click());
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[title="配置当前视图"]')!.click());
    expect(container.querySelector('[aria-label="配置当前视图"]')).toBeTruthy();

    await act(async () => document.body.dispatchEvent(new Event("focusin", { bubbles: true })));
    expect(container.querySelector('[aria-label="配置当前视图"]')).toBeNull();
  });

  it("moves a board card to another learning stage", async () => {
    includeCards = true;
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
    await settle();
    const deckButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(baseDeck.name));
    await act(async () => deckButton!.click());
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[title="配置当前视图"]')!.click());
    const boardButton = [...container.querySelectorAll<HTMLButtonElement>(".flashcards-view-type-list button")].find((button) => button.textContent?.includes("看板"));
    await act(async () => boardButton!.click());

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="卡片配置"]')!.click());
    const boardSettings = [...container.querySelectorAll<HTMLButtonElement>(".flashcards-card-config-menu button")].find((button) => button.textContent?.includes("看板设置"));
    expect(boardSettings).toBeTruthy();
    await act(async () => boardSettings!.click());
    for (const option of ["完整显示标题", "属性内容换行显示", "隐藏属性名"]) {
      const label = [...container.querySelectorAll<HTMLLabelElement>(".flashcards-gallery-config label")].find((item) => item.textContent?.includes(option));
      await act(async () => label!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    }
    const board = container.querySelector<HTMLElement>(".flashcards-database-columns")!;
    expect(board.classList.contains("gallery-title-expanded")).toBe(true);
    expect(board.classList.contains("gallery-wrap-content")).toBe(true);
    expect(board.querySelector(".flashcards-gallery-properties")?.classList.contains("hide-property-names")).toBe(true);

    const card = container.querySelector<HTMLElement>('.flashcards-column.stage-new article')!;
    const target = container.querySelector<HTMLElement>(".flashcards-column.stage-mastered")!;
    Object.defineProperty(card, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });
    await act(async () => {
      card.dispatchEvent(pointerEvent("pointerdown", 10, 10));
      card.dispatchEvent(pointerEvent("pointermove", 30, 30));
      card.dispatchEvent(pointerEvent("pointerup", 30, 30));
    });
    await settle();

    expect(cardStageValue).toBe("mastered");
  });

  it("opens a focused board card with the keyboard", async () => {
    includeCards = true;
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
    await settle();
    const deckButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(baseDeck.name));
    await act(async () => deckButton!.click());
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[title="配置当前视图"]')!.click());
    const boardButton = [...container.querySelectorAll<HTMLButtonElement>(".flashcards-view-type-list button")].find((button) => button.textContent?.includes("看板"));
    await act(async () => boardButton!.click());

    const card = container.querySelector<HTMLElement>('.flashcards-column.stage-new article')!;
    expect(card.getAttribute("role")).toBe("button");
    expect(card.tabIndex).toBe(0);
    expect(card.getAttribute("aria-label")).toContain(baseCard.question);
    card.focus();
    await act(async () => card.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));

    expect(container.querySelector('[role="dialog"][aria-label="编辑闪卡"]')).toBeTruthy();
    expect(document.activeElement?.getAttribute("data-modal-initial-focus")).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="dialog"][aria-label="编辑闪卡"]')).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it("protects unsaved modal edits and restores focus after an explicit discard", async () => {
    includeCards = true;
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
    await settle();
    const deckButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(baseDeck.name));
    await act(async () => deckButton!.click());
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[title="配置当前视图"]')!.click());
    const boardButton = [...container.querySelectorAll<HTMLButtonElement>(".flashcards-view-type-list button")].find((button) => button.textContent?.includes("看板"));
    await act(async () => boardButton!.click());
    const card = container.querySelector<HTMLElement>('.flashcards-column.stage-new article')!;
    card.focus();
    await act(async () => card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));

    const question = container.querySelector<HTMLTextAreaElement>("textarea[data-modal-initial-focus]")!;
    await act(async () => setTextareaValue(question, "尚未保存的新问题"));
    const unload = new Event("beforeunload", { cancelable: true });
    await act(async () => window.dispatchEvent(unload));
    expect(unload.defaultPrevented).toBe(true);
    expect(localStorage.getItem(FLASHCARD_EDITOR_DRAFT_KEY)).toContain("尚未保存的新问题");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alertdialog"]')).toBeTruthy();
    expect(container.querySelector('[role="dialog"][aria-label="编辑闪卡"]')).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("继续编辑");

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement?.getAttribute("data-modal-initial-focus")).not.toBeNull();
    expect((document.activeElement as HTMLTextAreaElement).value).toBe("尚未保存的新问题");

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    const discard = [...container.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((button) => button.textContent === "放弃更改")!;
    await act(async () => discard.click());
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(container.querySelector('[role="dialog"][aria-label="编辑闪卡"]')).toBeNull();
    expect(document.activeElement).toBe(card);
    expect(localStorage.getItem(FLASHCARD_EDITOR_DRAFT_KEY)).toBeNull();
  });

  it("offers to restore a matching editor draft without overwriting the saved card", async () => {
    includeCards = true;
    saveFlashcardEditorDraft(localStorage, {
      version: 1,
      target: { kind: "edit", cardId: baseCard.id },
      values: { ...editorValuesForCard(baseCard), question: "异常退出前保留的问题" },
      updatedAt: 1_700_000_000_000,
    });
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
    await settle();
    const deckButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(baseDeck.name));
    await act(async () => deckButton!.click());
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[title="配置当前视图"]')!.click());
    const boardButton = [...container.querySelectorAll<HTMLButtonElement>(".flashcards-view-type-list button")].find((button) => button.textContent?.includes("看板"));
    await act(async () => boardButton!.click());
    const card = container.querySelector<HTMLElement>('.flashcards-column.stage-new article')!;
    await act(async () => card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));

    expect(container.querySelector(".flashcards-editor-recovery")?.textContent).toContain("上次未保存的草稿");
    expect(container.querySelector<HTMLTextAreaElement>("[data-editor-question]")?.value).toBe(baseCard.question);
    expect(container.querySelector<HTMLButtonElement>(".flashcards-card-editor-actions .primary")?.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>("[data-editor-restore-draft]")!.click());

    expect(container.querySelector(".flashcards-editor-recovery")).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>("[data-editor-question]")?.value).toBe("异常退出前保留的问题");
    expect(container.querySelector(".flashcards-card-modal header i")?.textContent).toBe("未保存");
  });

  it("shares inline validation between mouse save and Ctrl+S", async () => {
    includeCards = true;
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
    await settle();
    const deckButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(baseDeck.name));
    await act(async () => deckButton!.click());
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[title="配置当前视图"]')!.click());
    const boardButton = [...container.querySelectorAll<HTMLButtonElement>(".flashcards-view-type-list button")].find((button) => button.textContent?.includes("看板"));
    await act(async () => boardButton!.click());
    const card = container.querySelector<HTMLElement>('.flashcards-column.stage-new article')!;
    await act(async () => card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    const question = container.querySelector<HTMLTextAreaElement>("[data-editor-question]")!;

    await act(async () => setTextareaValue(question, ""));
    const saveButton = container.querySelector<HTMLButtonElement>(".flashcards-card-editor-actions .primary")!;
    expect(saveButton.disabled).toBe(false);
    await act(async () => saveButton.click());
    expect(document.activeElement?.getAttribute("data-editor-question")).not.toBeNull();
    expect(container.querySelector(".flashcards-editor-validation")?.textContent).toBe("请先填写闪卡问题");
    expect(container.querySelector("[data-editor-question]")?.getAttribute("aria-invalid")).toBe("true");
    expect(invokeMock.mock.calls.some(([command]) => command === "update_flashcard")).toBe(false);

    const currentQuestion = container.querySelector<HTMLTextAreaElement>("[data-editor-question]")!;
    await act(async () => setTextareaValue(currentQuestion, "快捷键保存后的问题"));
    expect(container.querySelector(".flashcards-editor-validation")).toBeNull();
    expect(container.querySelector(".flashcards-card-modal header i")?.textContent).toBe("未保存");
    const validSave = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => document.dispatchEvent(validSave));
    await settle();

    expect(validSave.defaultPrevented).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("update_flashcard", expect.objectContaining({ question: "快捷键保存后的问题" }));
    expect(container.querySelector('[role="dialog"][aria-label="编辑闪卡"]')).toBeNull();
  });

  it("keeps unsaved content visible after a write failure and supports inline retry", async () => {
    includeCards = true;
    updateFailuresRemaining = 1;
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
    await settle();
    const deckButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(baseDeck.name));
    await act(async () => deckButton!.click());
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[title="配置当前视图"]')!.click());
    const boardButton = [...container.querySelectorAll<HTMLButtonElement>(".flashcards-view-type-list button")].find((button) => button.textContent?.includes("看板"));
    await act(async () => boardButton!.click());
    const card = container.querySelector<HTMLElement>('.flashcards-column.stage-new article')!;
    await act(async () => card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    const question = container.querySelector<HTMLTextAreaElement>("[data-editor-question]")!;
    await act(async () => setTextareaValue(question, "保存失败后仍保留的问题"));

    await act(async () => container.querySelector<HTMLButtonElement>(".flashcards-card-editor-actions .primary")!.click());
    await settle();

    expect(container.querySelector('[role="dialog"][aria-label="编辑闪卡"]')).toBeTruthy();
    expect(container.querySelector<HTMLTextAreaElement>("[data-editor-question]")?.value).toBe("保存失败后仍保留的问题");
    expect(container.querySelector(".flashcards-editor-save-error")?.textContent).toContain("磁盘暂时不可写");
    expect(container.querySelector(".flashcards-card-modal header i.error")?.textContent).toBe("保存失败");
    const retry = [...container.querySelectorAll<HTMLButtonElement>(".flashcards-editor-save-error button")].find((button) => button.textContent === "重试")!;
    await act(async () => retry.click());
    await settle();

    expect(invokeMock.mock.calls.filter(([command]) => command === "update_flashcard")).toHaveLength(2);
    expect(container.querySelector('[role="dialog"][aria-label="编辑闪卡"]')).toBeNull();
  });

  it("keeps edits made during an in-flight save and asks to save the latest version", async () => {
    includeCards = true;
    deferNextUpdate = true;
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} />));
    await settle();
    const deckButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(baseDeck.name));
    await act(async () => deckButton!.click());
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[title="配置当前视图"]')!.click());
    const boardButton = [...container.querySelectorAll<HTMLButtonElement>(".flashcards-view-type-list button")].find((button) => button.textContent?.includes("看板"));
    await act(async () => boardButton!.click());
    const card = container.querySelector<HTMLElement>('.flashcards-column.stage-new article')!;
    await act(async () => card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    const question = container.querySelector<HTMLTextAreaElement>("[data-editor-question]")!;
    await act(async () => setTextareaValue(question, "提交时的版本"));
    await act(async () => container.querySelector<HTMLButtonElement>(".flashcards-card-editor-actions .primary")!.click());
    expect(container.querySelector(".flashcards-card-modal header i.saving")?.textContent).toBe("正在保存");

    await act(async () => setTextareaValue(container.querySelector<HTMLTextAreaElement>("[data-editor-question]")!, "保存期间继续编辑的版本"));
    await act(async () => { resolveDeferredUpdate?.(baseCard); });
    await settle();

    expect(container.querySelector('[role="dialog"][aria-label="编辑闪卡"]')).toBeTruthy();
    expect(container.querySelector<HTMLTextAreaElement>("[data-editor-question]")?.value).toBe("保存期间继续编辑的版本");
    expect(container.querySelector(".flashcards-editor-save-notice")?.textContent).toContain("新更改仍未保存");
    expect(container.querySelector(".flashcards-card-modal header i.attention")?.textContent).toBe("有新更改");

    await act(async () => container.querySelector<HTMLButtonElement>(".flashcards-editor-save-notice button")!.click());
    await settle();
    const updateCalls = invokeMock.mock.calls.filter(([command]) => command === "update_flashcard");
    expect(updateCalls).toHaveLength(2);
    expect(updateCalls[0]?.[1]).toEqual(expect.objectContaining({ question: "提交时的版本" }));
    expect(updateCalls[1]?.[1]).toEqual(expect.objectContaining({ question: "保存期间继续编辑的版本" }));
    expect(container.querySelector('[role="dialog"][aria-label="编辑闪卡"]')).toBeNull();
  });
});
