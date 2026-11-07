// @vitest-environment jsdom

import { flashcardPageFixture, flashcardReviewPlanFixture } from "./FlashcardQuery.fixture";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Flashcard, FlashcardDeckSummary, FlashcardSyncSettings, FlashcardSyncSummary } from "./FlashcardTypes";

const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
const onStatusMessage = vi.fn<(text: string, tone?: "working" | "success" | "error", duration?: number) => void>();

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { FlashcardsWorkspace } from "./FlashcardsWorkspace";

// The shipped app loads compiled chunks; Vite's first chart transform belongs
// to fixture preparation, outside React act and its interaction timeout.
beforeAll(async () => { await Promise.all([import("./StudyDashboard"), import("./FlashcardInbox"), import("./FlashcardBackup")]); }, 30_000);

const deck: FlashcardDeckSummary = {
  id: "deck-a",
  name: "同步回归牌组",
  cardCount: 1,
  dueCount: 1,
  newCount: 0,
  updatedAt: 100,
};

const card: Flashcard = {
  id: "card-a",
  deckId: deck.id,
  question: "同步时，这张正在复习的卡片应当怎样处理？",
  answer: "保留在当前复习队列中。",
  explanation: "当前会话使用启动时的稳定队列。",
  cardType: "qa",
  cardData: {},
  sourceLibraryId: "library-a",
  sourceDocumentId: "document-a",
  sourceBlockId: "",
  sourceTitle: "同步回归来源",
  sourcePath: "测试/同步",
  sourceHash: "source-hash",
  media: [],
  tags: [],
  evidence: "同步不应清空活动复习队列。",
  confidence: 1,
  customFields: {},
  generation: {},
  createdAt: 10,
  updatedAt: 100,
  dueAt: 1,
  intervalDays: 1,
  ease: 2.5,
  repetitions: 1,
  lapses: 0,
  sourceChanged: false,
};

const syncSettings: FlashcardSyncSettings = {
  url: "https://dav.example.test/HubFlashcards/",
  username: "tester",
  hasPassword: true,
  autoSync: true,
  configured: true,
  lastError: "",
};

const syncSummary: FlashcardSyncSummary = {
  uploadedCards: 1,
  downloadedCards: 0,
  mergedReviews: 0,
  uploadedMedia: 0,
  downloadedMedia: 0,
  conflictRetries: 0,
  completedAt: 200,
};

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`找不到按钮：${text}`);
  return button;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("FlashcardsWorkspace synchronization", () => {
  let container: HTMLDivElement;
  let root: Root;
  let syncCompleted: boolean;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncCompleted = false;
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    onStatusMessage.mockReset();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      switch (command) {
        case "list_flashcard_decks": return [deck];
        case "list_flashcard_deck_folders": return [];
        case "list_flashcard_drafts": return [];
        case "get_flashcard_dashboard_stats": return { totalCards: 1, dueCards: 1, newCards: 1, learningCards: 0, masteredCards: 0, totalReviews: 0, reviewedToday: 0, retentionRate: 0, ratingCounts: [0, 0, 0, 0], dailyActivity: [] };
        case "get_flashcard_study_settings": return { dailyNewLimit: 10, updatedAt: 0 };
        case "get_flashcard_sync_settings": return syncSettings;
        case "list_flashcards_page": return flashcardPageFixture(syncCompleted ? [] : [card], args);
        case "flashcard_review_plan": return flashcardReviewPlanFixture(syncCompleted ? [] : [card], args);
        case "get_flashcards_by_ids": return syncCompleted ? [] : [card];
        case "sync_flashcards": syncCompleted = true; return syncSummary;
        default: throw new Error(`未处理的 Tauri 命令：${command}`);
      }
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete document.documentElement.dataset.runtimePlatform;
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps the active review queue when synchronization refreshes to an empty due list", async () => {
    await act(async () => {
      root.render(<FlashcardsWorkspace onClose={() => undefined} onStatusMessage={onStatusMessage} />);
    });
    await settle();

    expect(container.querySelector(".flashcards-decks .flashcards-sidebar-search")).not.toBeNull();
    expect(container.querySelector(".flashcards-header .flashcards-global-search")).toBeNull();
    expect([...container.querySelectorAll(".flashcards-workspace kbd")].some((item) => item.textContent?.includes("Ctrl K"))).toBe(false);

    await act(async () => buttonWithText(container, "今日").click());
    await settle();
    await act(async () => buttonWithText(container, "开始复习 1 张").click());

    expect(container.textContent).toContain(card.question);
    expect(container.textContent).toContain("还剩 1 张");

    await act(async () => window.dispatchEvent(new Event("hub:flashcards-sync")));
    await settle();

    expect(syncCompleted).toBe(true);
    expect(container.textContent).toContain(card.question);
    expect(container.textContent).toContain("还剩 1 张");
    expect(container.querySelector(".flashcards-statusbar")).toBeNull();
    expect(onStatusMessage).toHaveBeenLastCalledWith(
      expect.stringContaining("当前复习会话已保留"),
      "success",
      5_000,
    );

    await act(async () => buttonWithText(container, "暂停复习").click());
    expect(container.querySelector(".flashcards-overview-due .flashcards-resume-panel")).not.toBeNull();
    expect(container.querySelector(".flashcards-overview-due .flashcards-start")).toBeNull();
    expect(container.querySelector(".flashcards-main > .flashcards-editor-recovery")).toBeNull();
    for (const view of ["牌库", "收件箱", "统计"]) {
      await act(async () => buttonWithText(container, view).click());
      await settle();
      expect(container.textContent).not.toContain("复习已暂停");
      expect(container.querySelector('[aria-label="未完成的复习"]')).toBeNull();
    }
    await act(async () => buttonWithText(container, "今日").click());
    await settle();
    expect(container.querySelector(".flashcards-resume-panel")).not.toBeNull();
  });

  it.each(["desktop", "android"])("%s refreshes today's progress and badge on a native background sync event", async platform => {
    localStorage.removeItem("hub.flashcards.review-session.v1");
    document.documentElement.dataset.runtimePlatform = platform;
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const original = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "get_flashcard_dashboard_stats") return {
        totalCards: 707, dueCards: 707, newDueCards: 699, newCards: 699, learningCards: 8,
        masteredCards: 0, totalReviews: 49, reviewedToday: syncCompleted ? 16 : 13,
        newStudiedToday: syncCompleted ? 10 : 7, retentionRate: 1, ratingCounts: [0, 0, 49, 0],
        dailyActivity: [],
      };
      if (command === "flashcard_review_plan") return { sessionIds: [], sessionCount: syncCompleted ? 8 : 11, eligibleCount: syncCompleted ? 8 : 11, newAvailable: 0, newWaiting: 699, revision: "1", asOf: 0 };
      return original(command, args);
    });
    const onDueCountChange = vi.fn();
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} onDueCountChange={onDueCountChange} />));
    await settle();
    const pausedRound = [...container.querySelectorAll("button")].find(button => button.textContent === "结束本轮");
    if (pausedRound) {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      await act(async () => pausedRound.click());
      confirm.mockRestore();
    }
    await act(async () => buttonWithText(container, "今日").click());
    await settle();
    expect(container.textContent).toContain("今天还有 11 张");
    expect(container.textContent).toContain("今天已复习 13 次");
    const nativeListener = listenMock.mock.calls.find(([event]) => event === "flashcards-data-changed")?.[1];
    expect(nativeListener).toBeTypeOf("function");
    syncCompleted = true;
    await act(async () => nativeListener({ event: "flashcards-data-changed", payload: null, id: 1 }));
    await settle();
    expect(container.textContent).toContain("今天还有 8 张");
    expect(container.textContent).toContain("今天已复习 16 次");
    expect(container.textContent).toContain("新卡目标已完成");
    expect(container.textContent).toContain("开始复习 8 张");
    expect(onDueCountChange).toHaveBeenLastCalledWith(8);
  });

  it("registers the footer synchronization listener only once across rerenders", async () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    await act(async () => {
      root.render(<FlashcardsWorkspace onClose={() => undefined} onStatusMessage={onStatusMessage} />);
    });
    await settle();
    await act(async () => buttonWithText(container, "今日").click());
    await settle();

    const registrations = addEventListener.mock.calls.filter(([type]) => type === "hub:flashcards-sync");
    expect(registrations).toHaveLength(1);
    addEventListener.mockRestore();
  });

  it("edits the current review card after sync removes it from the due list and returns to the same round", async () => {
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "update_flashcard") return { ...card, answer: args?.answer };
      if (command === "list_flashcard_decks") return [deck];
      if (command === "list_flashcard_deck_folders" || command === "list_flashcard_drafts") return [];
      if (command === "get_flashcard_dashboard_stats") return { newStudiedToday: 0, dailyActivity: [], ratingCounts: [0,0,0,0] };
      if (command === "get_flashcard_study_settings") return { dailyNewLimit: 10 };
      if (command === "get_flashcard_sync_settings") return syncSettings;
      if (command === "list_flashcards_page") return flashcardPageFixture(syncCompleted ? [] : [card], args);
      if (command === "flashcard_review_plan") return flashcardReviewPlanFixture(syncCompleted ? [] : [card], args);
      if (command === "get_flashcards_by_ids") return syncCompleted ? [] : [card];
      if (command === "sync_flashcards") { syncCompleted = true; return syncSummary; }
      throw Error(command);
    });
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} onStatusMessage={onStatusMessage} />));
    await settle();
    await act(async () => buttonWithText(container, "今日").click());
    await settle();
    await act(async () => buttonWithText(container, container.querySelector(".flashcards-resume-panel") ? "继续复习" : "开始复习 1 张").click());
    await settle();
    await act(async () => window.dispatchEvent(new Event("hub:flashcards-sync")));
    await settle();
    await act(async () => buttonWithText(container.querySelector<HTMLElement>(".flashcards-review-actions")!, "编辑").click());
    expect(container.querySelector('[aria-label="编辑闪卡"]')).not.toBeNull();
    expect(container.querySelector(".flashcards-main")?.hasAttribute("inert")).toBe(true);
    const input=container.querySelector<HTMLTextAreaElement>("[data-editor-answer]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,"更新后的答案");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".flashcards-card-modal-save")!.click());
    await settle();
    expect(container.querySelector('[aria-label="编辑闪卡"]')).toBeNull();
    expect(container.textContent).toContain("还剩 1 张");
    expect(container.textContent).toContain(card.question);
    expect(invokeMock.mock.calls.some(([command])=>command==="review_flashcard")).toBe(false);
    expect(invokeMock.mock.calls.find(([command])=>command==="update_flashcard")?.[1]).toMatchObject({ answer:"更新后的答案" });
    await act(async () => buttonWithText(container,"显示答案").click());
    expect(container.textContent).toContain("更新后的答案");
    await act(async () => buttonWithText(container,"暂停复习").click());
  });

  it.each(["desktop", "android"])("%s cloud entry opens global settings without creating another cloud dialog", async platform => {
    if (platform === "android") document.documentElement.dataset.runtimePlatform = "android";
    const open = vi.fn(); window.addEventListener("hub:open-cloud-sync-settings", open);
    await act(async () => root.render(<><span id="flashcards-chrome-actions" /><FlashcardsWorkspace onClose={() => undefined} onStatusMessage={onStatusMessage} /></>));
    await settle();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="云同步设置"]')!.click());
    expect(open).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".flashcards-sync-settings")).toBeNull();
    expect(invokeMock.mock.calls.some(([c]) => c === "get_flashcard_cloud_sync_settings")).toBe(false);
    window.removeEventListener("hub:open-cloud-sync-settings", open);
  });

  it("keeps backup accessible and restores focus without opening cloud settings", async () => {
    const fallback = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((c,args) => c === "list_flashcard_backups" ? Promise.resolve({ items: [], issues: [] }) : fallback(c,args));
    await act(async () => root.render(<><span id="flashcards-chrome-actions" /><FlashcardsWorkspace onClose={() => undefined} onStatusMessage={onStatusMessage} /></>));
    await settle();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="闪卡备份与恢复"]')!;
    trigger.focus();
    await act(async () => trigger.click());
    expect(document.querySelector('[role="dialog"][aria-label="闪卡备份与恢复"]')).not.toBeNull();
    expect(container.querySelector(".flashcards-body")?.hasAttribute("inert")).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="关闭备份与恢复"]')!.click());
    expect(container.querySelector(".flashcards-body")?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("preserves the active review when the global center has merged remote data", async () => {
    localStorage.clear(); sessionStorage.clear();
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} onStatusMessage={onStatusMessage} />));
    await settle();
    await act(async () => buttonWithText(container, "今日").click()); await settle();
    await act(async () => buttonWithText(container, container.querySelector(".flashcards-resume-panel") ? "继续复习" : "开始复习 1 张").click());
    syncCompleted = true;
    await act(async () => window.dispatchEvent(new Event("hub:cloud-data-changed")));
    await settle();
    expect(container.textContent).toContain(card.question);
    expect(container.textContent).toContain("还剩 1 张");
    expect(invokeMock.mock.calls.some(([c]) => c === "sync_flashcards")).toBe(false);
    await act(async () => buttonWithText(container, "暂停复习").click());
    localStorage.clear(); sessionStorage.clear();
  });

  it("separates today's review from the full statistics view", async () => {
    await act(async () => {
      root.render(<FlashcardsWorkspace onClose={() => undefined} onStatusMessage={onStatusMessage} />);
    });
    await settle();
    expect(container.textContent).toContain("今天还有 1 张");
    expect(container.textContent).not.toContain("学习日历");

    await act(async () => buttonWithText(container, "统计").click());
    await settle();
    expect(container.textContent).toContain("学习统计");
    expect(container.textContent).toContain("学习日历");
    expect(container.textContent).toContain("长期复习");
    expect(container.textContent).not.toContain("开始复习 1 张");
  });

  it.each(["desktop", "android"])("%s rates only the displayed backend preview and refreshes a stale plan", async (platform) => {
    localStorage.clear(); sessionStorage.clear();
    if (platform === "android") document.documentElement.dataset.runtimePlatform = "android";
    const fallback = invokeMock.getMockImplementation()!;
    let finishPreview!: (value: unknown) => void;
    let previewCalls = 0, reviewCalls = 0;
    const preview = (reviewKey: string) => ({ cardId: card.id, reviewKey, desiredRetention: .9,
      choices: [600, 4 * 86400, 6 * 86400, 15 * 86400].map((intervalSeconds, index) => ({ rating: index + 1, intervalSeconds })) });
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "preview_flashcard_review") {
        previewCalls++;
        return previewCalls === 1 ? new Promise(resolve => { finishPreview = resolve; }) : preview("fresh-key");
      }
      if (command === "review_flashcard") {
        reviewCalls++;
        if (reviewCalls === 1) throw new Error("复习计划已变化，已刷新间隔，请重新评分");
        return { reviewId: "saved-review" };
      }
      return fallback(command, args);
    });
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} onStatusMessage={onStatusMessage} />));
    await settle();
    await act(async () => buttonWithText(container, "今日").click()); await settle();
    await act(async () => buttonWithText(container, container.querySelector(".flashcards-resume-panel") ? "继续复习" : "开始复习 1 张").click());
    await settle();
    await act(async () => buttonWithText(container, "显示答案").click());
    const good = () => container.querySelector<HTMLButtonElement>(".flashcards-ratings > .rating-3")!;
    expect(good().disabled).toBe(true);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true })));
    expect(reviewCalls).toBe(0);
    await act(async () => finishPreview(preview("initial-key")));
    expect(good().textContent).toContain("6 天"); expect(good().disabled).toBe(false);
    await act(async () => good().click()); await settle();
    expect(container.querySelector(".flashcards-review-card")?.textContent).toContain(card.question);
    expect(container.textContent).toContain("评分未保存");
    expect(previewCalls).toBe(2);
    expect(invokeMock).toHaveBeenCalledWith("review_flashcard", expect.objectContaining({ cardId: card.id, rating: 3, expectedReviewKey: "initial-key" }));
    await act(async () => good().click()); await settle();
    expect(invokeMock).toHaveBeenCalledWith("review_flashcard", expect.objectContaining({ cardId: card.id, rating: 3, expectedReviewKey: "fresh-key" }));
    expect(container.querySelector(".flashcards-ratings")).toBeNull();
    localStorage.clear(); sessionStorage.clear();
  });

  it.each(["desktop", "android"])("%s reloads changed same-timestamp card content after a preview guard conflict before rating", async platform => {
    localStorage.clear(); sessionStorage.clear();
    if (platform === "android") document.documentElement.dataset.runtimePlatform = "android";
    const fallback = invokeMock.getMockImplementation()!;
    const fresh = { ...card, question: "同一秒内修改后的新问题", answer: "修改后的新答案" };
    let finishRecovery!: (value: Flashcard[]) => void;
    let recovering = false;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_flashcards_by_ids") return recovering ? new Promise<Flashcard[]>(resolve => { finishRecovery = resolve; }) : [card];
      if (command === "preview_flashcard_review") {
        const expected = args?.expectedCard as Flashcard;
        if (expected.question !== fresh.question || expected.answer !== fresh.answer) { recovering = true; throw new Error("卡片内容已变化，请重新加载卡片"); }
        return { cardId: fresh.id, reviewKey: "fresh-content-key", desiredRetention: .9,
          choices: [600, 4 * 86400, 6 * 86400, 15 * 86400].map((intervalSeconds, index) => ({ rating: index + 1, intervalSeconds })) };
      }
      if (command === "review_flashcard") return { reviewId: "fresh-content-review" };
      return fallback(command, args);
    });
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} onStatusMessage={onStatusMessage} />));
    await settle();
    await act(async () => buttonWithText(container, "今日").click()); await settle();
    await act(async () => buttonWithText(container, container.querySelector(".flashcards-resume-panel") ? "继续复习" : "开始复习 1 张").click());
    await act(async () => buttonWithText(container, "显示答案").click()); await settle();
    expect(container.querySelector(".flashcards-answer")?.textContent).toContain(card.answer);
    expect(container.textContent).toContain("卡片内容已变化");
    expect(container.querySelector<HTMLButtonElement>(".flashcards-ratings > .rating-3")!.disabled).toBe(true);
    expect(invokeMock.mock.calls.filter(([command]) => command === "preview_flashcard_review")).toHaveLength(1);
    await act(async () => buttonWithText(container, "重新加载卡片").click());
    expect(buttonWithText(container, "重新加载卡片").disabled).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("get_flashcards_by_ids", { cardIds: [card.id] });
    await act(async () => finishRecovery([fresh])); await settle();
    expect(container.querySelector(".flashcards-review-card")?.textContent).toContain(fresh.question);
    expect(container.querySelector(".flashcards-answer")).toBeNull();
    expect(container.querySelector(".flashcards-ratings")).toBeNull();
    expect(invokeMock.mock.calls.filter(([command]) => command === "preview_flashcard_review")).toHaveLength(1);
    await act(async () => buttonWithText(container, "显示答案").click()); await settle();
    expect(container.querySelector(".flashcards-answer")?.textContent).toContain(fresh.answer);
    expect(invokeMock).toHaveBeenLastCalledWith("preview_flashcard_review", expect.objectContaining({ cardId: fresh.id, expectedCard: expect.objectContaining({ question: fresh.question, answer: fresh.answer, updatedAt: card.updatedAt }) }));
    const good = container.querySelector<HTMLButtonElement>(".flashcards-ratings > .rating-3")!;
    expect(good.disabled).toBe(false);
    await act(async () => good.click()); await settle();
    expect(invokeMock).toHaveBeenCalledWith("review_flashcard", expect.objectContaining({ cardId: card.id, rating: 3, expectedReviewKey: "fresh-content-key" }));
    expect(container.querySelector(".flashcards-ratings")).toBeNull();
    localStorage.clear(); sessionStorage.clear();
  });

  it.each(["deleted", "suspended"])("removes a %s card from the review queue when manually recovering a preview conflict", async status => {
    localStorage.clear(); sessionStorage.clear();
    const fallback = invokeMock.getMockImplementation()!;
    let recovering = false;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_flashcards_by_ids") return recovering ? status === "deleted" ? [] : [{ ...card, status: "suspended" }] : [card];
      if (command === "preview_flashcard_review") { recovering = true; throw new Error("卡片已变化，请重新加载卡片"); }
      return fallback(command, args);
    });
    await act(async () => root.render(<FlashcardsWorkspace onClose={() => undefined} onStatusMessage={onStatusMessage} />));
    await settle();
    await act(async () => buttonWithText(container, "今日").click()); await settle();
    await act(async () => buttonWithText(container, container.querySelector(".flashcards-resume-panel") ? "继续复习" : "开始复习 1 张").click());
    await act(async () => buttonWithText(container, "显示答案").click()); await settle();
    await act(async () => buttonWithText(container, "重新加载卡片").click()); await settle();
    expect(container.querySelector(".flashcards-review-complete")).not.toBeNull();
    expect(container.querySelector(".flashcards-review-card")).toBeNull();
    expect(container.querySelector(".flashcards-ratings")).toBeNull();
    expect(invokeMock.mock.calls.some(([command]) => command === "review_flashcard")).toBe(false);
    localStorage.clear(); sessionStorage.clear();
  });

});
