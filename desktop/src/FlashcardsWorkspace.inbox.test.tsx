// @vitest-environment jsdom

import { flashcardPageFixture, flashcardReviewPlanFixture } from "./FlashcardQuery.fixture";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FlashcardDeckSummary, FlashcardDraft } from "./FlashcardTypes";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const notices = vi.fn();

import { FlashcardsWorkspace } from "./FlashcardsWorkspace";

// Prepare the real lazy reader outside the interaction timer (math/Markdown).
beforeAll(async () => { await import("./FlashcardInbox"); });

const decks: FlashcardDeckSummary[] = [
  { id: "deck-energy", name: "能量链", cardCount: 0, dueCount: 0, newCount: 0, updatedAt: 1 },
  { id: "deck-interior", name: "内饰布置", cardCount: 0, dueCount: 0, newCount: 0, updatedAt: 1 },
];

const firstDraft: FlashcardDraft = {
  id: "draft-energy", batchId: "batch-test", deckName: "能量链",
  question: "沿能量链读电器件，应检查哪些环节？", answer: "供电、转换、回流和保护。",
  explanation: "能量链中的接口应分别核对。", cardType: "qa", cardData: {},
  sourceLibraryId: "library-test", sourceDocumentId: "document-energy", sourceBlockId: "",
  sourceTitle: "电器件资料", sourcePath: "汽车/电器件资料", sourceHash: "source-test",
  media: [], tags: ["电器"], customFields: {}, evidence: "**能量从哪里来？** 找供电、转换、回流和保护。",
  confidence: 0.97, generation: { source: "codex" }, idempotencyKey: "draft-energy", createdAt: 1,
};
const secondDraft: FlashcardDraft = {
  ...firstDraft, id: "draft-wireless", idempotencyKey: "draft-wireless",
  question: "无线充电器为什么需要核对手机位置？", answer: "托盘需要帮助手机与模块线圈对准。",
  explanation: "手机尺寸影响线圈的相对位置。", evidence: "核对托盘与模块线圈的相对位置。",
};
const thirdDraft: FlashcardDraft = {
  ...firstDraft, id: "draft-layout", idempotencyKey: "draft-layout", deckName: "内饰布置",
  question: "低压线束布置需要避让哪些区域？", answer: "识别高压对手件和能量路径。",
  explanation: "布局知识用于辨认避让和协同区域。", cardType: "typed_answer", sourceDocumentId: "document-layout",
  sourceTitle: "布置资料", sourcePath: "汽车/布置资料", tags: ["布置"], evidence: "线束需要避让并协同相关区域。",
};

function button(host: ParentNode, text: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.getAttribute("aria-label") === text || item.textContent?.trim().startsWith(text));
  if (!result) throw new Error(`找不到按钮：${text}`);
  return result;
}

function inputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectValue(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function dragTransfer() {
  const values = new Map<string, string>();
  return {
    effectAllowed: "none", dropEffect: "none",
    get types() { return [...values.keys()]; },
    setData: vi.fn((type: string, value: string) => values.set(type, value)),
    getData: vi.fn((type: string) => values.get(type) ?? ""),
  };
}

function dragEvent(type: string, transfer: ReturnType<typeof dragTransfer>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  return event;
}

function resizePointer(type: string, clientX: number, pointerId = 1, mouseButton = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: mouseButton });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

function cardPointer(type: string, x: number, y: number, options: { id?: number; type?: string; button?: number } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: options.button ?? 0 });
  Object.defineProperties(event, {
    pointerId: { value: options.id ?? 1 }, pointerType: { value: options.type ?? "mouse" }, isPrimary: { value: true },
  });
  return event;
}

const INBOX_WIDTH_KEY = "hub.flashcard-inbox-list-width";

describe("FlashcardsWorkspace inbox", () => {
  let root: Root;
  let host: HTMLDivElement;
  let availableDrafts: FlashcardDraft[];
  let availableDecks: FlashcardDeckSummary[];
  let failedResolutions: number;
  let originalShowModal: PropertyDescriptor | undefined;
  let originalElementFromPoint: PropertyDescriptor | undefined;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear(); sessionStorage.clear();
    failedResolutions = 0;
    availableDrafts = [firstDraft, secondDraft, thirdDraft];
    availableDecks = [...decks];
    originalElementFromPoint = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true, value() { this.setAttribute("open", ""); },
    });
    invokeMock.mockReset(); notices.mockReset();
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case "list_flashcard_decks": return [...availableDecks];
        case "list_flashcard_deck_folders": return [];
        case "list_flashcard_drafts": return [...availableDrafts];
        case "list_flashcards_page": return flashcardPageFixture([], args);
        case "flashcard_review_plan": return flashcardReviewPlanFixture([], args);
        case "get_flashcards_by_ids": return [];
        case "get_flashcard_dashboard_stats": return {
          totalCards: 0, dueCards: 0, newCards: 0, learningCards: 0, masteredCards: 0,
          totalReviews: 0, reviewedToday: 0, retentionRate: 0, ratingCounts: [0, 0, 0, 0], dailyActivity: [],
        };
        case "get_flashcard_study_settings": return { dailyNewLimit: 10, updatedAt: 0 };
        case "get_flashcard_sync_settings": return {
          url: "", username: "", hasPassword: false, autoSync: false, configured: false, lastError: "",
        };
        case "resolve_flashcard_drafts": {
          if (failedResolutions > 0) { failedResolutions -= 1; throw new Error("目标牌组暂时不可写"); }
          const ids = args?.draftIds as string[];
          const count = availableDrafts.filter((draft) => ids.includes(draft.id)).length;
          availableDrafts = availableDrafts.filter((draft) => !ids.includes(draft.id));
          return { accepted: args?.accept ? count : 0, rejected: args?.accept ? 0 : count, skipped: 0, deckIds: args?.targetDeckId ? [args.targetDeckId] : [] };
        }
        case "submit_flashcard_feedback": return null;
        case "open_result": return null;
        default: throw new Error(`未处理的 Tauri 命令：${command}`);
      }
    });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount()); host.remove();
    if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    if (originalElementFromPoint) Object.defineProperty(document, "elementFromPoint", originalElementFromPoint);
    else Reflect.deleteProperty(document, "elementFromPoint");
    vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear();
    delete document.documentElement.dataset.runtimePlatform;
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function openInbox() {
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} onStatusMessage={notices} />));
    await settle();
    const navigation = [...host.querySelectorAll<HTMLButtonElement>(".flashcards-nav-item")]
      .find((item) => item.querySelector("span")?.textContent === "收件箱")!;
    await act(async () => navigation.click());
    await settle();
    await act(async () => { await vi.dynamicImportSettled(); });
  }

  function checkbox(draft: FlashcardDraft) {
    return [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((item) => item.getAttribute("aria-label") === `选择卡片：${draft.question}`)!;
  }

  function preview(draft: FlashcardDraft) {
    return [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.getAttribute("aria-label") === `预览卡片：${draft.question}`)!;
  }

  function row(draft: FlashcardDraft) { return preview(draft).closest<HTMLElement>(".flashcard-inbox-row")!; }

  function hitDeck(deck: FlashcardDeckSummary) {
    const target = host.querySelector<HTMLButtonElement>(`[data-inbox-drop-deck="${deck.id}"]`)!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target.querySelector("span")) });
    return target;
  }

  async function doubleClick(target: HTMLElement) {
    await act(async () => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));
    await act(async () => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 2 })));
    await act(async () => target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 })));
  }

  function detail() { return host.querySelector<HTMLElement>(".flashcard-inbox-document")!; }
  function resolutionCalls() { return invokeMock.mock.calls.filter(([command]) => command === "resolve_flashcard_drafts"); }

  function resizeHandle() {
    return host.querySelector<HTMLElement>('.flashcard-inbox [role="separator"][aria-orientation="vertical"]');
  }

  function measuredInbox(initialWidth = 1_000) {
    let width = initialWidth;
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("flashcard-inbox-workbench")
        ? { x: 40, y: 80, left: 40, top: 80, right: 40 + width, bottom: 780, width, height: 700, toJSON: () => ({}) } as DOMRect
        : original.call(this);
    });
    return async (next: number) => {
      width = next;
      await act(async () => window.dispatchEvent(new Event("resize")));
    };
  }

  async function openMoveChooser() {
    await act(async () => button(host, "移入牌组").click());
    const chooser = host.querySelector<HTMLElement>('[role="dialog"][aria-label="选择目标牌组"]');
    expect(chooser).not.toBeNull();
    return chooser!;
  }

  async function moveToDeck(deck: FlashcardDeckSummary) {
    const chooser = await openMoveChooser();
    await act(async () => button(chooser, deck.name).click());
    await settle();
  }

  it("keeps previewing a card independent from selecting cards for a batch", async () => {
    await openInbox();
    expect(host.querySelectorAll(".flashcard-inbox-row")).toHaveLength(3);
    expect(detail().textContent).toContain(firstDraft.question);
    expect(detail().textContent).toContain(firstDraft.explanation);

    await act(async () => checkbox(secondDraft).click());
    expect(checkbox(secondDraft).checked).toBe(true);
    expect(detail().textContent).toContain(firstDraft.question);
    expect(detail().textContent).not.toContain(secondDraft.explanation);

    await act(async () => preview(thirdDraft).click());
    expect(detail().textContent).toContain(thirdDraft.question);
    expect(detail().textContent).toContain(thirdDraft.explanation);
    expect(checkbox(secondDraft).checked).toBe(true);
    expect(checkbox(thirdDraft).checked).toBe(false);
    expect(preview(thirdDraft).getAttribute("aria-current")).toBe("true");
    expect(preview(firstDraft).hasAttribute("aria-current")).toBe(false);
    expect(host.querySelector(".flashcard-inbox-current-icon")).toBeNull();
    expect(resolutionCalls()).toHaveLength(0);
  });

  it("double-clicks a card to toggle only its batch selection while keeping a single click for preview", async () => {
    await openInbox();
    await act(async () => checkbox(firstDraft).click());
    await act(async () => preview(secondDraft).click());
    expect(detail().textContent).toContain(secondDraft.question);
    expect(checkbox(secondDraft).checked).toBe(false);
    await doubleClick(preview(secondDraft));
    expect(checkbox(firstDraft).checked).toBe(true);
    expect(checkbox(secondDraft).checked).toBe(true);
    expect(checkbox(thirdDraft).checked).toBe(false);
    expect(host.querySelector(".flashcard-inbox-queue-bar")?.textContent).toContain("已选 2 张");
    await doubleClick(preview(secondDraft));
    expect(checkbox(firstDraft).checked).toBe(true);
    expect(checkbox(secondDraft).checked).toBe(false);
    expect(detail().textContent).toContain(secondDraft.question);
    expect(resolutionCalls()).toHaveLength(0);
  });

  it("does not add a row-selection toggle when the checkbox itself is double-clicked", async () => {
    await openInbox();
    await act(async () => checkbox(secondDraft).click());
    await doubleClick(checkbox(thirdDraft));
    expect(checkbox(thirdDraft).checked).toBe(false);
    expect(checkbox(secondDraft).checked).toBe(true);
    expect(checkbox(firstDraft).checked).toBe(false);
    expect(detail().textContent).toContain(firstDraft.question);
    await act(async () => checkbox(thirdDraft).click());
    expect(checkbox(thirdDraft).checked).toBe(true);
    await doubleClick(checkbox(thirdDraft));
    expect(checkbox(thirdDraft).checked).toBe(true);
    expect(checkbox(secondDraft).checked).toBe(true);
    expect(detail().textContent).toContain(firstDraft.question);
    expect(resolutionCalls()).toHaveLength(0);
  });

  it("restores the inbox split, adjusts it by keyboard, and resets without changing selected cards", async () => {
    measuredInbox();
    localStorage.setItem(INBOX_WIDTH_KEY, "420");
    await openInbox();
    await act(async () => checkbox(secondDraft).click());
    const handle = resizeHandle()!;
    expect(handle.getAttribute("aria-label")).toBe("调整收件箱列表宽度");
    expect(handle.getAttribute("aria-valuenow")).toBe("420");
    expect(handle.getAttribute("aria-valuemin")).toBe("260");
    expect(handle.getAttribute("aria-valuemax")).toBe("480");
    expect(handle.tabIndex).toBe(0);
    expect(host.querySelector(`#${handle.getAttribute("aria-controls")}`)).toBe(host.querySelector(".flashcard-inbox-queue"));
    handle.focus();
    const key = async (value: string, shiftKey = false) => {
      const event = new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true });
      await act(async () => handle.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    };
    await key("ArrowLeft");
    expect(handle.getAttribute("aria-valuenow")).toBe("404");
    expect(localStorage.getItem(INBOX_WIDTH_KEY)).toBe("404");
    await key("ArrowRight", true);
    expect(handle.getAttribute("aria-valuenow")).toBe("444");
    await key("Home");
    expect(handle.getAttribute("aria-valuenow")).toBe("260");
    await key("ArrowLeft");
    expect(handle.getAttribute("aria-valuenow")).toBe("260");
    await key("End");
    expect(handle.getAttribute("aria-valuenow")).toBe("480");
    await key("ArrowRight");
    expect(handle.getAttribute("aria-valuenow")).toBe("480");
    await key("Enter");
    expect(handle.getAttribute("aria-valuenow")).toBe("340");
    await key("ArrowRight");
    expect(handle.getAttribute("aria-valuenow")).toBe("356");
    await act(async () => handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })));
    expect(handle.getAttribute("aria-valuenow")).toBe("340");
    expect(localStorage.getItem(INBOX_WIDTH_KEY)).toBe("340");
    expect(document.activeElement).toBe(handle);
    expect(checkbox(secondDraft).checked).toBe(true);
    expect(detail().textContent).toContain(firstDraft.question);
    expect(resolutionCalls()).toHaveLength(0);
  });

  it("drags only with the primary pointer and keeps the final bounded split", async () => {
    measuredInbox();
    await openInbox();
    const handle = resizeHandle()!;
    Object.defineProperty(handle, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(handle, "hasPointerCapture", { configurable: true, value: vi.fn(() => true) });
    Object.defineProperty(handle, "releasePointerCapture", { configurable: true, value: vi.fn() });
    await act(async () => handle.dispatchEvent(resizePointer("pointerdown", 380, 1, 2)));
    expect(handle.setPointerCapture).not.toHaveBeenCalled();
    await act(async () => handle.dispatchEvent(resizePointer("pointerdown", 380)));
    expect(handle.setPointerCapture).toHaveBeenCalledWith(1);
    await act(async () => window.dispatchEvent(resizePointer("pointermove", 620, 99)));
    expect(handle.getAttribute("aria-valuenow")).toBe("340");
    await act(async () => window.dispatchEvent(resizePointer("pointermove", 448)));
    expect(handle.getAttribute("aria-valuenow")).toBe("408");
    await act(async () => window.dispatchEvent(resizePointer("pointerup", 448)));
    expect(localStorage.getItem(INBOX_WIDTH_KEY)).toBe("408");
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
    await act(async () => handle.dispatchEvent(resizePointer("pointerdown", 448)));
    await act(async () => window.dispatchEvent(resizePointer("pointermove", 5_000)));
    await act(async () => window.dispatchEvent(resizePointer("pointerup", 5_000)));
    expect(handle.getAttribute("aria-valuenow")).toBe("480");
    expect(localStorage.getItem(INBOX_WIDTH_KEY)).toBe("480");
    await act(async () => window.dispatchEvent(resizePointer("pointermove", 100)));
    expect(handle.getAttribute("aria-valuenow")).toBe("480");
    expect(resolutionCalls()).toHaveLength(0);
  });

  it("keeps the last drag position on cancellation and removes pending drag listeners on unmount", async () => {
    measuredInbox();
    await openInbox();
    const handle = resizeHandle()!;
    await act(async () => handle.dispatchEvent(resizePointer("pointerdown", 380)));
    await act(async () => window.dispatchEvent(resizePointer("pointermove", 440)));
    await act(async () => window.dispatchEvent(resizePointer("pointercancel", 0)));
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    expect(localStorage.getItem(INBOX_WIDTH_KEY)).toBe("400");
    await act(async () => window.dispatchEvent(resizePointer("pointermove", 600)));
    expect(handle.getAttribute("aria-valuenow")).toBe("400");
    await act(async () => handle.dispatchEvent(resizePointer("pointerdown", 440)));
    await act(async () => root.render(null));
    const savedWidth = localStorage.getItem(INBOX_WIDTH_KEY);
    await act(async () => {
      window.dispatchEvent(resizePointer("pointermove", 600));
      window.dispatchEvent(resizePointer("pointerup", 600));
    });
    expect(localStorage.getItem(INBOX_WIDTH_KEY)).toBe(savedWidth);
  });

  it("preserves the preferred split while constraining the reader and hides the divider at narrow widths", async () => {
    const resize = measuredInbox();
    localStorage.setItem(INBOX_WIDTH_KEY, "480");
    await openInbox();
    const handle = resizeHandle()!;
    expect(handle.getAttribute("aria-valuenow")).toBe("480");
    await resize(760);
    expect(handle.getAttribute("aria-valuemax")).toBe("432");
    expect(handle.getAttribute("aria-valuenow")).toBe("432");
    expect(localStorage.getItem(INBOX_WIDTH_KEY)).toBe("480");
    await resize(650);
    expect(host.querySelector(".flashcard-inbox-workbench")?.classList.contains("is-compact")).toBe(true);
    expect(handle.hidden).toBe(true);
    expect(handle.tabIndex).toBe(-1);
    await resize(1_000);
    expect(handle.hidden).toBe(false);
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-valuenow")).toBe("480");
    expect(localStorage.getItem(INBOX_WIDTH_KEY)).toBe("480");
    await resize(660);
    expect(handle.getAttribute("aria-valuenow")).toBe("332");
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(localStorage.getItem(INBOX_WIDTH_KEY)).toBe("340");
    expect(handle.getAttribute("aria-valuenow")).toBe("332");
    await resize(1_000);
    expect(handle.getAttribute("aria-valuenow")).toBe("340");
    expect(localStorage.getItem(INBOX_WIDTH_KEY)).toBe("340");
  });

  it("ends an active resize when the available container changes", async () => {
    const resize = measuredInbox();
    await openInbox();
    const handle = resizeHandle()!;
    await act(async () => handle.dispatchEvent(resizePointer("pointerdown", 380)));
    await act(async () => window.dispatchEvent(resizePointer("pointermove", 460)));
    await resize(650);
    const currentWidth = handle.getAttribute("aria-valuenow");
    const savedWidth = localStorage.getItem(INBOX_WIDTH_KEY);
    await act(async () => {
      window.dispatchEvent(resizePointer("pointermove", 600));
      window.dispatchEvent(resizePointer("pointerup", 600));
    });
    expect(handle.getAttribute("aria-valuenow")).toBe(currentWidth);
    expect(localStorage.getItem(INBOX_WIDTH_KEY)).toBe(savedWidth);
    expect(handle.hidden).toBe(true);
  });

  it("keeps the inbox divider hidden and outside keyboard navigation on Android", async () => {
    measuredInbox();
    document.documentElement.dataset.runtimePlatform = "android";
    await openInbox();
    expect(host.querySelector(".flashcard-inbox-workbench")?.classList.contains("is-compact")).toBe(true);
    expect(resizeHandle()!.hidden).toBe(true);
    expect(resizeHandle()!.tabIndex).toBe(-1);
    expect(detail().textContent).toContain(firstDraft.question);
  });

  it("shows mobile draft cards and accepts only the chosen card after selecting a real target deck", async () => {
    document.documentElement.dataset.runtimePlatform = "android";
    await openInbox();
    const cards = host.querySelectorAll<HTMLElement>(".mobile-flashcard-inbox-cards > article");
    expect(cards).toHaveLength(3);
    expect(cards[0].textContent).toContain(firstDraft.answer);
    await act(async () => button(cards[0], "加入牌库").click());
    await settle();
    expect(resolutionCalls()).toHaveLength(0);
    expect(host.querySelector('[aria-label="选择目标牌组"]')).not.toBeNull();
    await act(async () => button(host.querySelector('[aria-label="选择目标牌组"]')!, decks[1].name).click());
    await settle();
    expect(resolutionCalls()).toEqual([["resolve_flashcard_drafts", {
      draftIds: [firstDraft.id], accept: true, targetDeckId: decks[1].id,
    }]]);
    expect(host.querySelectorAll(".mobile-flashcard-inbox-cards > article")).toHaveLength(2);
  });

  it("renders one mobile empty inbox and keeps creation available in advanced management", async () => {
    availableDrafts = [];
    document.documentElement.dataset.runtimePlatform = "android";
    await openInbox();
    expect(host.querySelector(".mobile-flashcard-inbox-cards")?.textContent).toContain("收件箱已处理完");
    expect(host.querySelector(".flashcard-inbox-empty")).toBeNull();
    await act(async () => button(host, "筛选与批量整理").click());
    expect(host.querySelector(".flashcard-inbox-empty")?.textContent).toContain("新建卡片");
  });

  it("opens the full mobile draft reader and returns without resolving or changing the draft", async () => {
    document.documentElement.dataset.runtimePlatform = "android";
    await openInbox();
    const card = host.querySelector<HTMLElement>(".mobile-flashcard-inbox-cards > article")!;
    await act(async () => button(card, "查看详情").click());
    expect(host.querySelector(".mobile-inbox-mode-detail")).not.toBeNull();
    expect(detail().textContent).toContain(firstDraft.evidence.replace(/\*/g, ""));
    await act(async () => button(host, "返回草稿卡片").click());
    expect(host.querySelector(".mobile-inbox-mode-cards")).not.toBeNull();
    expect(resolutionCalls()).toHaveLength(0);
  });

  it("selects only visible search results and moves exactly those drafts into the chosen deck", async () => {
    await openInbox();
    const search = host.querySelector<HTMLInputElement>('[aria-label="搜索收件箱"]')!;
    await act(async () => inputValue(search, "电器"));
    expect(host.querySelectorAll(".flashcard-inbox-row")).toHaveLength(2);
    expect(checkbox(thirdDraft)).toBeUndefined();

    const selectVisible = host.querySelector<HTMLInputElement>('[aria-label="选择当前显示的卡片"]')!;
    await act(async () => selectVisible.click());
    expect(checkbox(firstDraft).checked).toBe(true);
    expect(checkbox(secondDraft).checked).toBe(true);
    expect(button(host, "移入牌组").disabled).toBe(false);
    expect(resolutionCalls()).toHaveLength(0);

    await act(async () => inputValue(search, ""));
    expect(checkbox(thirdDraft).checked).toBe(false);
    expect(selectVisible.checked).toBe(false);
    expect(selectVisible.indeterminate).toBe(true);
    await moveToDeck(decks[1]);

    expect(resolutionCalls()).toEqual([["resolve_flashcard_drafts", {
      draftIds: [firstDraft.id, secondDraft.id], accept: true, targetDeckId: decks[1].id,
    }]]);
    expect(host.querySelectorAll(".flashcard-inbox-row")).toHaveLength(1);
    expect(preview(thirdDraft)).toBeTruthy();
    expect(checkbox(thirdDraft).checked).toBe(false);
    expect(host.textContent).not.toContain("已选 2 张");
  });

  it("preserves the selection after a failed move so the same batch can be retried", async () => {
    await openInbox(); failedResolutions = 1;
    await act(async () => { checkbox(firstDraft).click(); checkbox(secondDraft).click(); });
    await moveToDeck(decks[0]);

    expect(notices).toHaveBeenCalledWith("Error: 目标牌组暂时不可写", "error", 8_000);
    expect(checkbox(firstDraft).checked).toBe(true);
    expect(checkbox(secondDraft).checked).toBe(true);
    expect(host.querySelector('[role="dialog"][aria-label="选择目标牌组"]')).toBeNull();
    expect(host.querySelector(".flashcard-inbox-queue-bar")?.textContent).toContain("已选 2 张");
    expect(button(host, "移入牌组").disabled).toBe(false);

    await moveToDeck(decks[0]);
    expect(resolutionCalls()).toHaveLength(2);
    expect(resolutionCalls()[1][1]).toEqual(resolutionCalls()[0][1]);
    expect(availableDrafts.map((draft) => draft.id)).toEqual([thirdDraft.id]);
  });

  it("finds a target deck by name before moving the selected cards", async () => {
    await openInbox();
    await act(async () => checkbox(secondDraft).click());
    const chooser = await openMoveChooser();
    await act(async () => inputValue(chooser.querySelector<HTMLInputElement>('[aria-label="搜索目标牌组"]')!, "内饰"));
    const options = [...chooser.querySelectorAll<HTMLButtonElement>(".flashcard-inbox-deck-options button")];
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain(decks[1].name);
    expect(resolutionCalls()).toHaveLength(0);
    await act(async () => options[0].click());
    await settle();
    expect(resolutionCalls()).toEqual([["resolve_flashcard_drafts", {
      draftIds: [secondDraft.id], accept: true, targetDeckId: decks[1].id,
    }]]);
    expect(host.querySelector('[role="dialog"][aria-label="选择目标牌组"]')).toBeNull();
    expect(availableDrafts.map((draft) => draft.id)).toEqual([firstDraft.id, thirdDraft.id]);
  });

  it("focuses deck search on opening and restores the move trigger when Escape closes it", async () => {
    await openInbox();
    await act(async () => checkbox(firstDraft).click());
    const trigger = button(host, "移入牌组");
    const chooser = await openMoveChooser();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(chooser.id);
    expect(document.activeElement).toBe(chooser.querySelector('[aria-label="搜索目标牌组"]'));
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(host.querySelector('[role="dialog"][aria-label="选择目标牌组"]')).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
    expect(checkbox(firstDraft).checked).toBe(true);
    expect(resolutionCalls()).toHaveLength(0);
  });

  it("shows an unmatched deck search without starting a move", async () => {
    await openInbox();
    const chooser = await openMoveChooser();
    await act(async () => inputValue(chooser.querySelector<HTMLInputElement>('[aria-label="搜索目标牌组"]')!, "不存在的牌组"));
    expect(chooser.querySelectorAll(".flashcard-inbox-deck-options button")).toHaveLength(0);
    expect(chooser.textContent).toContain("没有匹配的牌组");
    expect(resolutionCalls()).toHaveLength(0);
    await act(async () => button(chooser, "关闭牌组选择").click());
    expect(document.activeElement).toBe(button(host, "移入牌组"));
    expect(availableDrafts).toHaveLength(3);
  });

  it("warns that selected cards outside the current filter are included in the move", async () => {
    await openInbox();
    await act(async () => { checkbox(firstDraft).click(); checkbox(secondDraft).click(); });
    await act(async () => selectValue(host.querySelector<HTMLSelectElement>('[aria-label="筛选卡片类型"]')!, "typed_answer"));
    expect(host.querySelectorAll(".flashcard-inbox-row")).toHaveLength(1);
    expect(checkbox(thirdDraft).checked).toBe(false);
    const chooser = await openMoveChooser();
    expect(chooser.textContent).toContain("移动 2 张卡片");
    expect(chooser.querySelector(".flashcard-inbox-popover-note")?.textContent).toBe("包含 2 张筛选外的卡片");
    await act(async () => button(chooser, decks[0].name).click());
    await settle();
    expect(resolutionCalls()).toEqual([["resolve_flashcard_drafts", {
      draftIds: [firstDraft.id, secondDraft.id], accept: true, targetDeckId: decks[0].id,
    }]]);
    expect(availableDrafts.map((draft) => draft.id)).toEqual([thirdDraft.id]);
    expect(checkbox(thirdDraft).checked).toBe(false);
  });

  it("closes the deck chooser when a live refresh removes its selected batch without moving the remaining card", async () => {
    await openInbox();
    await act(async () => { checkbox(firstDraft).click(); checkbox(secondDraft).click(); });
    const chooser = await openMoveChooser();
    expect(chooser.textContent).toContain("移动 2 张卡片");
    availableDrafts = [thirdDraft];
    await act(async () => { window.dispatchEvent(new Event("hub:cloud-data-changed")); });
    await settle();

    expect(host.querySelector('[role="dialog"][aria-label="选择目标牌组"]')).toBeNull();
    expect(document.activeElement).toBe(button(host, "移入牌组"));
    expect(resolutionCalls()).toHaveLength(0);
    expect(availableDrafts.map((draft) => draft.id)).toEqual([thirdDraft.id]);
    expect(checkbox(thirdDraft).checked).toBe(false);
    expect(detail().textContent).toContain(thirdDraft.question);

    const reopened = await openMoveChooser();
    expect(reopened.textContent).toContain("移动当前卡片");
    await act(async () => button(reopened, decks[1].name).click());
    await settle();
    expect(resolutionCalls()).toEqual([["resolve_flashcard_drafts", {
      draftIds: [thirdDraft.id], accept: true, targetDeckId: decks[1].id,
    }]]);
    expect(availableDrafts).toHaveLength(0);
    expect(host.textContent).toContain("收件箱已整理完毕");
  });

  it("ignores an older inbox refresh that finishes after the moved drafts have been refreshed", async () => {
    await openInbox();
    const oldDrafts = [...availableDrafts];
    const previous = invokeMock.getMockImplementation()!;
    let resolveOldRead: ((drafts: FlashcardDraft[]) => void) | undefined;
    let deferRead = true;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "list_flashcard_drafts" && deferRead) {
        deferRead = false;
        return new Promise<FlashcardDraft[]>((resolve) => { resolveOldRead = resolve; });
      }
      return previous(command, args);
    });
    await act(async () => { window.dispatchEvent(new Event("hub:cloud-data-changed")); });
    expect(resolveOldRead).toBeTypeOf("function");
    await act(async () => { checkbox(firstDraft).click(); checkbox(secondDraft).click(); });
    await moveToDeck(decks[0]);
    expect(host.querySelectorAll(".flashcard-inbox-row")).toHaveLength(1);

    await act(async () => { resolveOldRead!(oldDrafts); });
    await settle();
    expect(host.querySelectorAll(".flashcard-inbox-row")).toHaveLength(1);
    expect(preview(firstDraft)).toBeUndefined();
    expect(preview(secondDraft)).toBeUndefined();
    expect(preview(thirdDraft)).toBeTruthy();
  });

  it("keeps supported Craft and Obsidian source links usable in rendered evidence", async () => {
    availableDrafts = [{
      ...firstDraft,
      evidence: "参考 [Craft 原文](craftdocs://open?blockId=source-block) 和 [Obsidian 原文](obsidian://open?vault=notes&file=Power)。",
    }];
    await openInbox();
    const links = [...detail().querySelectorAll<HTMLAnchorElement>('[aria-label="卡片依据"] a')];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "craftdocs://open?blockId=source-block", "obsidian://open?vault=notes&file=Power",
    ]);
  });

  it("renders the screenshot's loosely spaced bold evidence without changing its saved text", async () => {
    const evidence = "**能量从哪里来？ ** 找供电、转换、回流和保护；USB、12V 插座、无线充电的对外供电形式不同，不能把三者看成相同接口。";
    availableDrafts = [{ ...firstDraft, evidence }];
    await openInbox();
    const callout = detail().querySelector<HTMLElement>('[aria-label="卡片依据"]')!;
    expect(callout.querySelector(".flashcard-inbox-markdown strong")?.textContent).toBe("能量从哪里来？");
    expect(callout.textContent).not.toContain("**");
    expect(callout.textContent).toContain("找供电、转换、回流和保护");
    expect(availableDrafts[0].evidence).toBe(evidence);
  });

  it("prunes cards removed by a live refresh from the selection before the next move", async () => {
    await openInbox();
    await act(async () => { checkbox(firstDraft).click(); checkbox(secondDraft).click(); });
    availableDrafts = [secondDraft, thirdDraft];
    await act(async () => { window.dispatchEvent(new Event("hub:cloud-data-changed")); });
    await settle();
    expect(preview(firstDraft)).toBeUndefined();
    expect(checkbox(secondDraft).checked).toBe(true);
    expect(host.querySelector(".flashcard-inbox-queue-bar")?.textContent).toContain("已选 1 张");
    await moveToDeck(decks[0]);
    expect(resolutionCalls()[0][1]).toEqual({ draftIds: [secondDraft.id], accept: true, targetDeckId: decks[0].id });
    expect(availableDrafts.map((draft) => draft.id)).toEqual([thirdDraft.id]);
  });

  it("opens the previewed card's source using its own library and document identifiers", async () => {
    await openInbox();
    await act(async () => preview(thirdDraft).click());
    await act(async () => button(detail(), "查看卡片来源").click());
    await settle();
    expect(invokeMock).toHaveBeenCalledWith("open_result", {
      libraryId: thirdDraft.sourceLibraryId, documentId: thirdDraft.sourceDocumentId,
      blockId: thirdDraft.sourceDocumentId, resultId: null, openMode: "client", matchField: "content", matchTerms: [],
    });
  });

  it("supports selecting a contiguous range while previewing its last card", async () => {
    await openInbox();
    await act(async () => checkbox(firstDraft).click());
    await act(async () => preview(thirdDraft).dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(checkbox(firstDraft).checked).toBe(true);
    expect(checkbox(secondDraft).checked).toBe(true);
    expect(checkbox(thirdDraft).checked).toBe(true);
    expect(detail().textContent).toContain(thirdDraft.question);
    expect(host.querySelector(".flashcard-inbox-queue-bar")?.textContent).toContain("已选 3 张");
    await moveToDeck(decks[0]);
    expect(resolutionCalls()[0][1]).toEqual({
      draftIds: [firstDraft.id, secondDraft.id, thirdDraft.id], accept: true, targetDeckId: decks[0].id,
    });
    expect(host.querySelectorAll(".flashcard-inbox-row")).toHaveLength(0);
    expect(host.textContent).toContain("收件箱已整理完毕");
  });

  it("loads drafts beyond the first hundred and selects only rows currently displayed", async () => {
    availableDrafts = Array.from({ length: 121 }, (_, index) => ({
      ...firstDraft, id: `draft-page-${index}`, idempotencyKey: `draft-page-${index}`,
      question: `分页中的第 ${index + 1} 张卡片`,
    }));
    const allDrafts = [...availableDrafts];
    await openInbox();
    const displayedInitially = host.querySelectorAll(".flashcard-inbox-row").length;
    expect(displayedInitially).toBeGreaterThan(0);
    expect(displayedInitially).toBeLessThan(100);
    const selectVisible = host.querySelector<HTMLInputElement>('[aria-label="选择当前显示的卡片"]')!;
    await act(async () => selectVisible.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".flashcard-inbox-more")!.click());
    const displayedAfterExpansion = host.querySelectorAll(".flashcard-inbox-row").length;
    expect(displayedAfterExpansion).toBeGreaterThan(100);
    expect(displayedAfterExpansion).toBeLessThan(allDrafts.length);
    expect(selectVisible.indeterminate).toBe(true);
    expect(checkbox(allDrafts[displayedInitially]).checked).toBe(false);
    await act(async () => selectVisible.click());
    await act(async () => host.querySelector<HTMLButtonElement>(".flashcard-inbox-more")!.click());
    expect(host.querySelectorAll(".flashcard-inbox-row")).toHaveLength(allDrafts.length);
    expect(checkbox(allDrafts[120]).checked).toBe(false);
    await moveToDeck(decks[0]);
    expect(resolutionCalls()[0][1]).toEqual({
      draftIds: allDrafts.slice(0, displayedAfterExpansion).map((draft) => draft.id), accept: true, targetDeckId: decks[0].id,
    });
    expect(availableDrafts.map((draft) => draft.id)).toEqual([allDrafts[120].id]);
    expect(host.querySelectorAll(".flashcard-inbox-row")).toHaveLength(1);
  });

  it.each(["row", "preview"])("moves selected drafts together from the %s to the deck under the pointer", async (origin) => {
    await openInbox();
    await act(async () => { checkbox(firstDraft).click(); checkbox(secondDraft).click(); });
    const draggedDraft = origin === "row" ? secondDraft : firstDraft;
    expect(row(draggedDraft).draggable).toBe(false);
    expect(row(draggedDraft).dataset.draggable).toBe("true");
    const handle = origin === "row" ? row(draggedDraft) : preview(draggedDraft);
    const target = hitDeck(decks[1]);
    await act(async () => handle.dispatchEvent(cardPointer("pointerdown", 460, 200)));
    await act(async () => window.dispatchEvent(cardPointer("pointermove", 100, 385)));
    expect(target.classList.contains("inbox-drop-target")).toBe(true);
    expect(document.querySelector(".flashcard-inbox-drag-preview")?.textContent).toContain("2 张卡片");
    expect(document.querySelector(".flashcard-inbox-drag-preview")?.textContent).toContain(`移入 ${decks[1].name}`);
    await act(async () => window.dispatchEvent(cardPointer("pointerup", 100, 385)));
    await settle();

    expect(resolutionCalls()).toEqual([["resolve_flashcard_drafts", {
      draftIds: [firstDraft.id, secondDraft.id], accept: true, targetDeckId: decks[1].id,
    }]]);
    expect(availableDrafts.map((draft) => draft.id)).toEqual([thirdDraft.id]);
    expect(document.querySelector(".flashcard-inbox-drag-preview")).toBeNull();
    expect(target.classList.contains("inbox-drop-target")).toBe(false);
  });

  it.each(["row", "preview"])("drags an unselected card from the %s alone without adding the selected cards to the move", async (origin) => {
    await openInbox();
    await act(async () => { checkbox(firstDraft).click(); checkbox(secondDraft).click(); });
    expect(row(thirdDraft).draggable).toBe(false);
    const handle = origin === "row" ? row(thirdDraft) : preview(thirdDraft);
    hitDeck(decks[1]);
    await act(async () => handle.dispatchEvent(cardPointer("pointerdown", 460, 200)));
    await act(async () => window.dispatchEvent(cardPointer("pointermove", 100, 385)));
    expect(document.querySelector(".flashcard-inbox-drag-preview")?.textContent).toContain("1 张卡片");
    await act(async () => window.dispatchEvent(cardPointer("pointerup", 100, 385)));
    await settle();

    expect(resolutionCalls()[0][1]).toEqual({ draftIds: [thirdDraft.id], accept: true, targetDeckId: decks[1].id });
    expect(checkbox(firstDraft).checked).toBe(true);
    expect(checkbox(secondDraft).checked).toBe(true);
    expect(availableDrafts.map((draft) => draft.id)).toEqual([firstDraft.id, secondDraft.id]);
  });

  it("keeps selected cards hidden by a search in a batch dragged from the visible row", async () => {
    await openInbox();
    await act(async () => { checkbox(firstDraft).click(); checkbox(secondDraft).click(); });
    const search = host.querySelector<HTMLInputElement>('[aria-label="搜索收件箱"]')!;
    await act(async () => inputValue(search, "沿能量链"));
    expect(host.querySelectorAll(".flashcard-inbox-row")).toHaveLength(1);
    expect(checkbox(secondDraft)).toBeUndefined();
    hitDeck(decks[1]);
    await act(async () => row(firstDraft).dispatchEvent(cardPointer("pointerdown", 460, 200)));
    await act(async () => window.dispatchEvent(cardPointer("pointermove", 100, 385)));
    expect(document.querySelector(".flashcard-inbox-drag-preview")?.textContent).toContain("2 张卡片");
    await act(async () => window.dispatchEvent(cardPointer("pointerup", 100, 385)));
    await settle();
    expect(resolutionCalls()).toEqual([["resolve_flashcard_drafts", {
      draftIds: [firstDraft.id, secondDraft.id], accept: true, targetDeckId: decks[1].id,
    }]]);
    expect(availableDrafts.map((draft) => draft.id)).toEqual([thirdDraft.id]);
  });

  it("continues to accept a legacy single-card HTML drop on a deck", async () => {
    await openInbox();
    const target = hitDeck(decks[1]);
    const transfer = dragTransfer();
    transfer.setData("application/x-hub-flashcard-draft", secondDraft.id);
    const over = dragEvent("dragover", transfer);
    await act(async () => target.dispatchEvent(over));
    expect(over.defaultPrevented).toBe(true);
    await act(async () => target.dispatchEvent(dragEvent("drop", transfer)));
    await settle();
    expect(resolutionCalls()[0][1]).toEqual({ draftIds: [secondDraft.id], accept: true, targetDeckId: decks[1].id });
  });

  it("waits for the drag threshold and ignores other pointer identifiers", async () => {
    await openInbox();
    hitDeck(decks[0]);
    const source = row(firstDraft);
    Object.defineProperty(source, "setPointerCapture", { configurable: true, value: vi.fn() });
    await act(async () => source.dispatchEvent(cardPointer("pointerdown", 460, 200)));
    expect(source.setPointerCapture).toHaveBeenCalledWith(1);
    await act(async () => window.dispatchEvent(cardPointer("pointermove", 464, 201)));
    expect(document.querySelector(".flashcard-inbox-drag-preview")).toBeNull();
    await act(async () => {
      window.dispatchEvent(cardPointer("pointermove", 100, 385, { id: 99 }));
      window.dispatchEvent(cardPointer("pointerup", 100, 385, { id: 99 }));
    });
    expect(resolutionCalls()).toHaveLength(0);
    expect(document.querySelector(".flashcard-inbox-drag-preview")).toBeNull();
    await act(async () => window.dispatchEvent(cardPointer("pointermove", 100, 385)));
    expect(document.querySelector(".flashcard-inbox-drag-preview")).toBeTruthy();
    await act(async () => window.dispatchEvent(cardPointer("pointerup", 100, 385)));
    await settle();
    expect(resolutionCalls()[0][1]).toEqual({ draftIds: [firstDraft.id], accept: true, targetDeckId: decks[0].id });
  });

  it.each(["checkbox", "touch", "right-button", "android"])("does not start an internal card drag from %s input", async (input) => {
    if (input === "android") document.documentElement.dataset.runtimePlatform = "android";
    await openInbox();
    hitDeck(decks[0]);
    const source = input === "checkbox" ? checkbox(thirdDraft) : preview(thirdDraft);
    await act(async () => source.dispatchEvent(cardPointer("pointerdown", 460, 200, { type: input === "touch" ? "touch" : "mouse", button: input === "right-button" ? 2 : 0 })));
    await act(async () => {
      window.dispatchEvent(cardPointer("pointermove", 100, 385));
      window.dispatchEvent(cardPointer("pointerup", 100, 385));
    });
    expect(document.querySelector(".flashcard-inbox-drag-preview")).toBeNull();
    expect(resolutionCalls()).toHaveLength(0);
    expect(checkbox(thirdDraft).checked).toBe(false);
  });

  it.each(["pointercancel", "Escape", "blur", "lostcapture", "unmount"])("cancels an internal card drag on %s without moving cards", async (reason) => {
    await openInbox();
    const target = hitDeck(decks[1]);
    const source = row(firstDraft);
    Object.defineProperty(source, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(source, "hasPointerCapture", { configurable: true, value: vi.fn(() => true) });
    Object.defineProperty(source, "releasePointerCapture", { configurable: true, value: vi.fn() });
    await act(async () => source.dispatchEvent(cardPointer("pointerdown", 460, 200)));
    await act(async () => window.dispatchEvent(cardPointer("pointermove", 100, 385)));
    expect(document.querySelector(".flashcard-inbox-drag-preview")).toBeTruthy();
    if (reason === "unmount") await act(async () => root.render(null));
    else await act(async () => {
      if (reason === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      else if (reason === "blur") window.dispatchEvent(new Event("blur"));
      else if (reason === "lostcapture") source.dispatchEvent(cardPointer("lostpointercapture", 100, 385));
      else window.dispatchEvent(cardPointer("pointercancel", 100, 385));
    });
    expect(document.querySelector(".flashcard-inbox-drag-preview")).toBeNull();
    expect(source.releasePointerCapture).toHaveBeenCalledWith(1);
    if (reason !== "unmount") expect(target.classList.contains("inbox-drop-target")).toBe(false);
    await act(async () => window.dispatchEvent(cardPointer("pointerup", 100, 385)));
    expect(resolutionCalls()).toHaveLength(0);
    expect(availableDrafts).toHaveLength(3);
  });

  it("suppresses only the compatibility clicks after a drag and allows the next preview click", async () => {
    await openInbox();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => null) });
    const source = row(thirdDraft);
    await act(async () => source.dispatchEvent(cardPointer("pointerdown", 460, 200)));
    await act(async () => window.dispatchEvent(cardPointer("pointermove", 100, 385)));
    await act(async () => {
      window.dispatchEvent(cardPointer("pointerup", 100, 385));
      preview(thirdDraft).click();
      source.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
    });
    expect(detail().textContent).toContain(firstDraft.question);
    expect(checkbox(thirdDraft).checked).toBe(false);
    expect(resolutionCalls()).toHaveLength(0);
    await settle();
    await act(async () => preview(thirdDraft).click());
    expect(detail().textContent).toContain(thirdDraft.question);
    expect(checkbox(thirdDraft).checked).toBe(false);
  });

  it("filters removed drafts from an active pointer batch before the drop resolves", async () => {
    await openInbox();
    await act(async () => { checkbox(firstDraft).click(); checkbox(secondDraft).click(); });
    hitDeck(decks[1]);
    await act(async () => row(firstDraft).dispatchEvent(cardPointer("pointerdown", 460, 200)));
    await act(async () => window.dispatchEvent(cardPointer("pointermove", 100, 385)));
    availableDrafts = [firstDraft, thirdDraft];
    await act(async () => window.dispatchEvent(new Event("hub:cloud-data-changed")));
    await settle();
    await act(async () => window.dispatchEvent(cardPointer("pointerup", 100, 385)));
    await settle();
    expect(resolutionCalls()).toEqual([["resolve_flashcard_drafts", {
      draftIds: [firstDraft.id], accept: true, targetDeckId: decks[1].id,
    }]]);
  });

  it("does not drop onto a target deck removed during a pointer gesture", async () => {
    await openInbox();
    hitDeck(decks[1]);
    await act(async () => row(firstDraft).dispatchEvent(cardPointer("pointerdown", 460, 200)));
    await act(async () => window.dispatchEvent(cardPointer("pointermove", 100, 385)));
    availableDecks = [];
    await act(async () => window.dispatchEvent(new Event("hub:cloud-data-changed")));
    await settle();
    await act(async () => window.dispatchEvent(cardPointer("pointerup", 100, 385)));
    expect(resolutionCalls()).toHaveLength(0);
    expect(document.querySelector(".flashcard-inbox-drag-preview")).toBeNull();
  });

  it("rejects a malformed batch drag and filters duplicate, stale and non-string identifiers", async () => {
    await openInbox();
    const target = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((item) => item.textContent?.includes(decks[1].name))!;
    const malformed = dragTransfer();
    malformed.setData("application/x-hub-flashcard-drafts", "{invalid JSON");
    malformed.setData("application/x-hub-flashcard-draft", firstDraft.id);
    await act(async () => target.dispatchEvent(dragEvent("drop", malformed)));
    expect(resolutionCalls()).toHaveLength(0);

    const valid = dragTransfer();
    valid.setData("application/x-hub-flashcard-drafts", JSON.stringify([
      firstDraft.id, firstDraft.id, "draft-no-longer-pending", 12, null, { id: secondDraft.id }, thirdDraft.id,
    ]));
    await act(async () => target.dispatchEvent(dragEvent("drop", valid)));
    await settle();
    expect(resolutionCalls()).toEqual([["resolve_flashcard_drafts", {
      draftIds: [firstDraft.id, thirdDraft.id], accept: true, targetDeckId: decks[1].id,
    }]]);
    expect(availableDrafts.map((draft) => draft.id)).toEqual([secondDraft.id]);
  });

  it("confirms removal of the selected batch and preserves it when removal is cancelled", async () => {
    await openInbox();
    await act(async () => { checkbox(firstDraft).click(); checkbox(secondDraft).click(); });
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => button(host, "移除所选卡片").click());
    expect(confirmation).toHaveBeenCalledOnce();
    expect(resolutionCalls()).toHaveLength(0);
    expect(checkbox(firstDraft).checked).toBe(true);
    expect(checkbox(secondDraft).checked).toBe(true);

    confirmation.mockReturnValue(true);
    await act(async () => button(host, "移除所选卡片").click());
    await settle();
    expect(resolutionCalls()).toEqual([["resolve_flashcard_drafts", {
      draftIds: [firstDraft.id, secondDraft.id], accept: false, targetDeckId: undefined,
    }]]);
    expect(availableDrafts.map((draft) => draft.id)).toEqual([thirdDraft.id]);
    expect(host.textContent).not.toContain("已选 2 张");
  });

  it("keeps feedback and single-card removal attached to the previewed draft", async () => {
    await openInbox();
    await act(async () => { checkbox(firstDraft).click(); preview(secondDraft).click(); });
    await act(async () => button(detail(), "反馈").click());
    await act(async () => { await vi.dynamicImportSettled(); });
    const quality = host.querySelector<HTMLDialogElement>("dialog.flashcard-quality")!;
    expect(quality.open).toBe(true);
    expect(quality.querySelector(".quality-card-title")?.textContent).toBe(secondDraft.question);
    await act(async () => button(quality, "记录并继续").click());
    await settle();
    expect(invokeMock).toHaveBeenCalledWith("submit_flashcard_feedback", {
      input: { cardId: secondDraft.id, draft: true, reason: "low-value", comment: "", action: "record", excludeTarget: false },
    });
    expect(host.querySelector("dialog.flashcard-quality")).toBeNull();
    await act(async () => button(detail(), "移除").click());
    await settle();

    expect(resolutionCalls()).toEqual([["resolve_flashcard_drafts", {
      draftIds: [secondDraft.id], accept: false, targetDeckId: undefined,
    }]]);
    expect(checkbox(firstDraft).checked).toBe(true);
    expect(availableDrafts.map((draft) => draft.id)).toEqual([firstDraft.id, thirdDraft.id]);
  });
});
