import { describe, expect, it, vi } from "vitest";
import { createFlashcardReviewSession, FLASHCARD_REVIEW_STORAGE_KEY, loadFlashcardReviewSession, saveFlashcardReviewSession } from "./FlashcardReviewSession";
import type { Flashcard } from "./FlashcardTypes";
const card = (id: string) => ({ id, cardType: "typed_answer", cardData: {}, answer: "答案", repetitions: 0, lapses: 0, dueAt: 1 } as Flashcard);

describe("review continuity", () => {
  it("updates an edited card in place without changing progress or grading it", () => {
    const s = createFlashcardReviewSession();
    s.start([card("1"), card("2")], "今日");
    s.patch({ answerVisible: true, typedResponse: "旧答案" });
    s.updateCard({ ...card("1"), answer: "新答案" });
    expect(s.getSnapshot()).toMatchObject({ reviewing: true, total: 2, answerVisible: false, typedResponse: "", lastRated: null });
    expect(s.getSnapshot().queue.map(c => c.id)).toEqual(["1", "2"]);
    expect(s.getSnapshot().queue[0].answer).toBe("新答案");
    s.updateCard(card("unrelated"));
    expect(s.getSnapshot().queue).toHaveLength(2);
  });
  it("does not reopen a review after navigating away during resume", async () => {
    const s = createFlashcardReviewSession(); s.start([card("1")], "复习"); s.pause();
    let finish!: (cards: Flashcard[]) => void;
    const pending = s.resume(() => new Promise(resolve => { finish = resolve; }));
    s.pause(); finish([card("1")]); await pending;
    expect(s.getSnapshot()).toMatchObject({ reviewing: false, busy: false, queue: [card("1")] });
  });
  it("preserves responses and excludes paused time", async () => {
    let time = 0;
    const s = createFlashcardReviewSession(() => time);
    s.start([card("1")], "今日待复习");
    s.patch({ typedResponse: "输入中", answerVisible: true, selectedChoice: 2, orderingResponse: ["b", "a"] });
    time = 100; s.pause(); time = 10000;
    await s.resume(async () => [card("1")]); time = 10100;
    expect(s.getSnapshot()).toMatchObject({ typedResponse: "输入中", answerVisible: true, selectedChoice: 2, orderingResponse: ["b", "a"] });
    const submit = vi.fn().mockResolvedValue(undefined);
    await s.rate(3, submit);
    expect(submit).toHaveBeenCalledWith("1", 3, 200);
    expect(s.getSnapshot().queue).toHaveLength(0);
  });
  it("commits an in-flight rating after leaving without double submit", async () => {
    const s = createFlashcardReviewSession(); s.start([card("1"), card("2")], "牌组"); s.patch({ answerVisible: true });
    let finish!: () => void;
    const submit = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = s.rate(3, submit); s.pause();
    await s.rate(3, submit); await s.resume(async () => [card("1")]); s.start([card("3")], "新一轮");
    finish(); await pending;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot()).toMatchObject({ reviewing: false, busy: false, queue: [card("2")] });
  });
  it("retains answers on failure and permits retry", async () => {
    const s = createFlashcardReviewSession(); s.start([card("1")], "复习"); s.patch({ answerVisible: true, typedResponse: "答案" });
    await s.rate(2, async () => { throw Error("offline"); });
    expect(s.getSnapshot()).toMatchObject({ busy: false, typedResponse: "答案", answerVisible: true });
    expect(s.getSnapshot().error).toContain("评分未保存");
    await s.rate(2, async () => {}); expect(s.getSnapshot().queue).toHaveLength(0);
  });
  it("removes deleted and externally reviewed cards", async () => {
    const s = createFlashcardReviewSession(); s.start([card("1"), card("2"), card("3")], "复习"); s.pause();
    await s.resume(async () => [{ ...card("2"), repetitions: 1 }, card("3")]);
    expect(s.getSnapshot().queue.map(c => c.id)).toEqual(["3"]);
    expect(s.getSnapshot().total).toBe(1);
  });
  it("clears responses when source card changes", async () => {
    const s = createFlashcardReviewSession(); s.start([card("1")], "复习"); s.patch({ typedResponse: "旧答案", answerVisible: true }); s.pause();
    await s.resume(async () => [{ ...card("1"), answer: "更新答案" }]);
    expect(s.getSnapshot()).toMatchObject({ typedResponse: "", answerVisible: false });
  });
  it("retains paused progress on reload failure", async () => {
    const s = createFlashcardReviewSession(); s.start([card("1")], "复习"); s.pause();
    await s.resume(async () => { throw Error("offline"); });
    expect(s.getSnapshot()).toMatchObject({ reviewing: false, busy: false, queue: [card("1")] });
  });
  it("does not grade unrevealed answers", async () => {
    const s = createFlashcardReviewSession(); s.start([card("1")], "复习");
    const submit = vi.fn(); await s.rate(3, submit); expect(submit).not.toHaveBeenCalled();
  });
  it("moves a postponed card to the end and resets its response", () => {
    const s = createFlashcardReviewSession(); s.start([card("1"), card("2"), card("3")], "复习");
    s.patch({ answerVisible: true, typedResponse: "草稿" });
    expect(s.postpone()).toBe(true);
    expect(s.getSnapshot()).toMatchObject({ answerVisible: false, typedResponse: "" });
    expect(s.getSnapshot().queue.map(c => c.id)).toEqual(["2", "3", "1"]);
  });
  it("undoes the latest rating and puts its restored card first", async () => {
    const s = createFlashcardReviewSession(); s.start([card("1"), card("2")], "复习"); s.patch({ answerVisible: true });
    await s.rate(3, async () => ({ reviewId: "review-1" }));
    const undo = vi.fn(async () => ({ ...card("1"), dueAt: 9 }));
    expect(await s.undo(undo)).toBe(true);
    expect(undo).toHaveBeenCalledWith("1", "review-1");
    expect(s.getSnapshot().queue.map(c => c.id)).toEqual(["1", "2"]);
    expect(s.getSnapshot().lastRated).toBeNull();
  });
  it("persists and restores a paused round without storing full card content", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    const source = createFlashcardReviewSession(() => 42); source.start([card("1"), card("2")], "今日");
    source.patch({ answerVisible: true, typedResponse: "作答" });
    saveFlashcardReviewSession(storage, source.storedSnapshot());
    expect(values.get(FLASHCARD_REVIEW_STORAGE_KEY)).not.toContain("答案");
    const stored = loadFlashcardReviewSession(storage)!;
    const restored = createFlashcardReviewSession();
    expect(restored.restoreStored(stored, [card("1"), card("2")])).toBe(2);
    expect(restored.getSnapshot()).toMatchObject({ reviewing: false, label: "今日", answerVisible: true, typedResponse: "作答" });
  });
  it("drops stale restored cards and clears invalid storage", () => {
    const values = new Map<string, string>([[FLASHCARD_REVIEW_STORAGE_KEY, "bad json"]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
    expect(loadFlashcardReviewSession(storage)).toBeNull();
    expect(values.has(FLASHCARD_REVIEW_STORAGE_KEY)).toBe(false);
    const s = createFlashcardReviewSession(); s.start([card("1"), card("2")], "复习");
    const snapshot = s.storedSnapshot()!; s.discard();
    expect(s.restoreStored(snapshot, [{ ...card("1"), repetitions: 1 }, card("2")])).toBe(1);
    expect(s.getSnapshot().queue.map(c => c.id)).toEqual(["2"]);
  });
  it("drops a card paused on another device before resuming", async () => {
    const s = createFlashcardReviewSession(); s.start([card("1"), card("2")], "复习"); s.pause();
    await s.resume(async () => [{ ...card("1"), status: "suspended" }, card("2")]);
    expect(s.getSnapshot().queue.map(item => item.id)).toEqual(["2"]);
  });
});
