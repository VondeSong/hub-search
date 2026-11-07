// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Flashcard } from "./FlashcardTypes";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { formatReviewInterval, useFlashcardSchedulePreview, type FlashcardSchedulePreview } from "./FlashcardScheduling";

const card: Flashcard = {
  id: "a", deckId: "deck", question: "Question", answer: "Answer", explanation: "Explanation",
  cardType: "qa", cardData: {}, media: [], tags: [], evidence: "", customFields: {}, generation: {},
  sourceLibraryId: "", sourceDocumentId: "", sourceBlockId: "", sourceTitle: "", sourcePath: "", sourceHash: "",
  createdAt: 1, updatedAt: 1, dueAt: 2, intervalDays: 0, ease: 2.5, repetitions: 0, lapses: 0,
  status: "active", sourceChanged: false,
};
const result = (id: string, key = "key"): FlashcardSchedulePreview => ({
  cardId: id, reviewKey: key, desiredRetention: .9,
  choices: [600, 86400, 172800, 691200].map((intervalSeconds, i) => ({ rating: i + 1, intervalSeconds })),
});
let root: Root, host: HTMLDivElement;
let view: ReturnType<typeof useFlashcardSchedulePreview>;
function Harness({ item = card, enabled = true }: { item?: Flashcard; enabled?: boolean }) {
  view = useFlashcardSchedulePreview(item, enabled);
  return <button disabled={!view.preview} onClick={view.refresh}>{view.preview?.reviewKey ?? view.error ?? "loading"}</button>;
}
const render = async (item = card, enabled = true) => act(async () => root.render(<Harness item={item} enabled={enabled} />));
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  invokeMock.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("uses backend intervals and leaves rating disabled until the preview is ready", async () => {
  let resolve!: (value: FlashcardSchedulePreview) => void;
  invokeMock.mockReturnValue(new Promise(done => { resolve = done; }));
  await render();
  expect(host.querySelector("button")!.disabled).toBe(true);
  await act(async () => resolve(result("a")));
  expect(host.querySelector("button")!.disabled).toBe(false);
  expect(invokeMock).toHaveBeenCalledWith("preview_flashcard_review", { cardId: "a", expectedCard: card });
  expect(view.preview!.choices.map(choice => formatReviewInterval(choice.intervalSeconds))).toEqual(["10 分钟", "1 天", "2 天", "8 天"]);
});

it("ignores a late preview for a previous card", async () => {
  let old!: (value: FlashcardSchedulePreview) => void;
  invokeMock.mockReturnValueOnce(new Promise(done => { old = done; })).mockResolvedValueOnce(result("b", "new"));
  await render(); await render({ ...card, id: "b" });
  await act(async () => old(result("a", "stale")));
  expect(view.preview?.reviewKey).toBe("new");
});

it("reloads the complete presentation when question changes within the same second", async () => {
  let old!: (value: FlashcardSchedulePreview) => void;
  let fresh!: (value: FlashcardSchedulePreview) => void;
  invokeMock.mockReturnValueOnce(new Promise(done => { old = done; }))
    .mockReturnValueOnce(new Promise(done => { fresh = done; }));
  await render();
  const edited = { ...card, question: "Changed question", answer: "Changed answer" };
  await render(edited);
  expect(edited.updatedAt).toBe(card.updatedAt);
  expect(invokeMock).toHaveBeenCalledTimes(2);
  expect(invokeMock).toHaveBeenLastCalledWith("preview_flashcard_review", { cardId: "a", expectedCard: edited });
  await act(async () => old(result("a", "old-content")));
  expect(view.preview).toBeUndefined();
  expect(host.querySelector("button")!.disabled).toBe(true);
  await act(async () => fresh(result("a", "fresh-content")));
  expect(view.preview?.reviewKey).toBe("fresh-content");
});

it("invalidates a ready key for same-second media and question-type changes", async () => {
  invokeMock.mockResolvedValueOnce(result("a", "original"));
  await render();
  const withMedia: Flashcard = { ...card, media: [{ title: "Synthetic image", mimeType: "image/png", url: "blob:synthetic", placement: "question" }] };
  let media!: (value: FlashcardSchedulePreview) => void;
  invokeMock.mockReturnValueOnce(new Promise(done => { media = done; }));
  await render(withMedia);
  expect(view.preview).toBeUndefined();
  expect(invokeMock).toHaveBeenLastCalledWith("preview_flashcard_review", { cardId: "a", expectedCard: withMedia });
  await act(async () => media(result("a", "with-media")));
  expect(view.preview?.reviewKey).toBe("with-media");

  const choice: Flashcard = { ...withMedia, cardType: "multiple_choice", cardData: { options: ["A", "B"], correctIndex: 1 } };
  let typed!: (value: FlashcardSchedulePreview) => void;
  invokeMock.mockReturnValueOnce(new Promise(done => { typed = done; }));
  await render(choice);
  expect(choice.updatedAt).toBe(card.updatedAt);
  expect(view.preview).toBeUndefined();
  expect(invokeMock).toHaveBeenCalledTimes(3);
  expect(invokeMock).toHaveBeenLastCalledWith("preview_flashcard_review", { cardId: "a", expectedCard: choice });
  await act(async () => typed(result("a", "choice")));
  expect(view.preview?.reviewKey).toBe("choice");
});

it("recovers from a rejected presentation and ignores a late error for old content", async () => {
  invokeMock.mockRejectedValueOnce(new Error("卡片内容或复习状态已变化，请重新加载卡片后再作答"));
  await render();
  expect(view.error).toContain("卡片内容或复习状态已变化");
  expect(view.preview).toBeUndefined();
  expect(host.querySelector("button")!.disabled).toBe(true);
  const edited = { ...card, question: "Reloaded question" };
  invokeMock.mockResolvedValueOnce(result("a", "reloaded"));
  await render(edited);
  expect(view.preview?.reviewKey).toBe("reloaded");
  expect(view.error).toBeUndefined();

  let reject!: (reason: Error) => void;
  invokeMock.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  await act(async () => view.refresh());
  expect(view.preview).toBeUndefined();
  invokeMock.mockResolvedValueOnce(result("a", "newest"));
  await render({ ...edited, explanation: "Reloaded explanation" });
  await act(async () => reject(new Error("late stale presentation")));
  expect(view.preview?.reviewKey).toBe("newest");
  expect(view.error).toBeUndefined();
});

it("invalidates the key while retrying a failed or stale preview", async () => {
  invokeMock.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(result("a"));
  await render();
  expect(view.error).toContain("offline"); expect(view.preview).toBeUndefined();
  await act(async () => view.refresh());
  expect(view.preview?.reviewKey).toBe("key");
  let resolve!: (value: FlashcardSchedulePreview) => void;
  invokeMock.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await act(async () => view.refresh());
  expect(view.preview).toBeUndefined();
  await act(async () => resolve(result("a", "refreshed")));
  expect(view.preview?.reviewKey).toBe("refreshed");
});

it("reloads changed cards and focus, and does not fetch for a hidden answer", async () => {
  invokeMock.mockResolvedValue(result("a"));
  await render(card, false); expect(invokeMock).not.toHaveBeenCalled();
  await render(); expect(invokeMock).toHaveBeenCalledTimes(1);
  await render({ ...card, dueAt: 500 }); expect(invokeMock).toHaveBeenCalledTimes(2);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(invokeMock).toHaveBeenCalledTimes(3);
  await render(card, false); expect(view.preview).toBeUndefined();
  let resolve!: (value: FlashcardSchedulePreview) => void;
  invokeMock.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await render(); expect(view.preview).toBeUndefined();
  await act(async () => resolve(result("a", "resumed")));
  expect(view.preview?.reviewKey).toBe("resumed");
});

it("does not enable rating with a malformed backend preview", async () => {
  invokeMock.mockResolvedValue({ ...result("a"), choices: [] });
  await render();
  expect(view.preview).toBeUndefined(); expect(view.error).toContain("未完整加载");
});
