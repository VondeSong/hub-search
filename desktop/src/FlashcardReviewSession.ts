import { useEffect, useSyncExternalStore } from "react";
import type { Flashcard } from "./FlashcardTypes";

export const FLASHCARD_REVIEW_STORAGE_KEY = "hub.flashcards.review-session.v1";

type ReviewResponse = {
  answerVisible: boolean;
  selectedChoice: number | null;
  typedResponse: string;
  orderingResponse: string[];
};

type RatedReview = { card: Flashcard; reviewId: string };

export type StoredFlashcardReviewSession = {
  version: 1;
  savedAt: number;
  total: number;
  label: string;
  queue: Array<Pick<Flashcard, "id" | "repetitions" | "lapses" | "dueAt">>;
  response: ReviewResponse;
};

type ReviewStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const responseFor = (card?: Flashcard): ReviewResponse => {
  const items = card?.cardType === "ordering"
    ? [...(card.cardData.items?.length ? card.cardData.items : card.answer.split("\n").map(s => s.trim()).filter(Boolean))] : [];
  for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  return { answerVisible: false, selectedChoice: null, typedResponse: "", orderingResponse: items };
};

const validStoredSession = (value: unknown): value is StoredFlashcardReviewSession => {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredFlashcardReviewSession>;
  return item.version === 1
    && typeof item.savedAt === "number"
    && typeof item.total === "number"
    && typeof item.label === "string"
    && Array.isArray(item.queue)
    && item.queue.every(card => card && typeof card.id === "string" && typeof card.repetitions === "number" && typeof card.lapses === "number" && typeof card.dueAt === "number")
    && !!item.response
    && typeof item.response.answerVisible === "boolean"
    && (item.response.selectedChoice === null || typeof item.response.selectedChoice === "number")
    && typeof item.response.typedResponse === "string"
    && Array.isArray(item.response.orderingResponse);
};

export function loadFlashcardReviewSession(storage: ReviewStorage): StoredFlashcardReviewSession | null {
  try {
    const raw = storage.getItem(FLASHCARD_REVIEW_STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (validStoredSession(value) && value.queue.length > 0) return value;
  } catch { /* Corrupt browser state must never block the flashcard screen. */ }
  storage.removeItem(FLASHCARD_REVIEW_STORAGE_KEY);
  return null;
}

export function saveFlashcardReviewSession(storage: ReviewStorage, session: StoredFlashcardReviewSession | null) {
  if (!session || session.queue.length === 0) storage.removeItem(FLASHCARD_REVIEW_STORAGE_KEY);
  else storage.setItem(FLASHCARD_REVIEW_STORAGE_KEY, JSON.stringify(session));
}

export function createFlashcardReviewSession(now = Date.now) {
  let state = {
    queue: [] as Flashcard[], total: 0, reviewing: false, busy: false, label: "", error: "",
    lastRated: null as RatedReview | null, ...responseFor(),
  };
  let elapsed = 0, startedAt: number | null = null, navigation = 0;
  const listeners = new Set<() => void>();
  const patch = (next: Partial<typeof state>) => { state = { ...state, ...next }; listeners.forEach(fn => fn()); };
  const pause = () => {
    navigation++;
    if (startedAt !== null) elapsed += now() - startedAt;
    startedAt = null;
    patch({ reviewing: false });
  };
  return {
    getSnapshot: () => state,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    patch,
    pause,
    suspendTiming() { if(startedAt!==null)elapsed+=now()-startedAt;startedAt=null; },
    resumeTiming() { if(state.reviewing && startedAt===null)startedAt=now(); },
    removeCard(id:string) {
      if(state.busy)return;
      const current=state.queue[0]?.id===id;
      const queue=state.queue.filter(card=>card.id!==id);
      if(current){elapsed=0;startedAt=state.reviewing?now():null;}
      patch({queue,total:Math.max(queue.length,state.total-(state.queue.length-queue.length)),...(current?responseFor(queue[0]):{}),...(queue.length?{}:{reviewing:false})});
    },
    updateCard(card: Flashcard) {
      if (!state.queue.some(item => item.id === card.id)) return;
      const current = state.queue[0]?.id === card.id;
      const queue = state.queue.map(item => item.id === card.id ? card : item);
      if (current) { elapsed = 0; startedAt = state.reviewing ? now() : null; }
      patch({ queue, ...(current ? responseFor(card) : {}) });
    },
    start(queue: Flashcard[], label: string) {
      if (state.busy) return;
      elapsed = 0; startedAt = now();
      patch({ queue, total: queue.length, label, reviewing: true, error: "", lastRated: null, ...responseFor(queue[0]) });
    },
    restoreStored(stored: StoredFlashcardReviewSession, available: Flashcard[]) {
      if (state.busy || state.queue.length > 0) return 0;
      const latest = new Map(available.map(card => [card.id, card]));
      const queue = stored.queue.flatMap(saved => {
        const fresh = latest.get(saved.id);
        return fresh && fresh.status !== "suspended" && fresh.repetitions === saved.repetitions && fresh.lapses === saved.lapses && fresh.dueAt === saved.dueAt ? [fresh] : [];
      });
      const firstWasRestored = queue[0]?.id === stored.queue[0]?.id;
      elapsed = 0; startedAt = null;
      patch({
        queue,
        total: Math.max(queue.length, stored.total - (stored.queue.length - queue.length)),
        label: stored.label,
        reviewing: false,
        error: "",
        lastRated: null,
        ...(firstWasRestored ? stored.response : responseFor(queue[0])),
      });
      return queue.length;
    },
    storedSnapshot(): StoredFlashcardReviewSession | null {
      if (state.queue.length === 0) return null;
      return {
        version: 1,
        savedAt: now(),
        total: state.total,
        label: state.label,
        queue: state.queue.map(({ id, repetitions, lapses, dueAt }) => ({ id, repetitions, lapses, dueAt })),
        response: {
          answerVisible: state.answerVisible,
          selectedChoice: state.selectedChoice,
          typedResponse: state.typedResponse,
          orderingResponse: state.orderingResponse,
        },
      };
    },
    discard() { if (!state.busy) { pause(); patch({ queue: [], total: 0, error: "", lastRated: null, ...responseFor() }); } },
    postpone() {
      if (state.busy || !state.reviewing || state.queue.length < 2) return false;
      const queue = [...state.queue.slice(1), state.queue[0]];
      elapsed = 0; startedAt = now();
      patch({ queue, error: "", ...responseFor(queue[0]) });
      return true;
    },
    async resume(load: () => Promise<Flashcard[]>) {
      if (state.busy) return;
      const requestNavigation = navigation;
      patch({ busy: true, error: "" });
      try {
        const latest = new Map((await load()).map(card => [card.id, card]));
        if (navigation !== requestNavigation) return;
        const previous = state.queue[0];
        const queue = state.queue.flatMap(card => {
          const fresh = latest.get(card.id);
          return fresh && fresh.status !== "suspended" && fresh.repetitions === card.repetitions && fresh.lapses === card.lapses && fresh.dueAt === card.dueAt ? [fresh] : [];
        });
        const unchanged = previous && JSON.stringify(previous) === JSON.stringify(queue[0]);
        if (!unchanged) elapsed = 0;
        startedAt = now();
        patch({ queue, total: state.total - (state.queue.length - queue.length), reviewing: true, ...(!unchanged ? responseFor(queue[0]) : {}) });
      } catch (e) { patch({ error: `暂时无法恢复复习：${String(e)}` }); }
      finally { patch({ busy: false }); }
    },
    async rate(rating: number, submit: (cardId: string, rating: number, elapsedMs: number) => Promise<{ reviewId: string } | void>) {
      const card = state.queue[0];
      if (!card || !state.reviewing || !state.answerVisible || state.busy) return false;
      const elapsedMs = elapsed + (startedAt === null ? 0 : now() - startedAt);
      patch({ busy: true, error: "" });
      try {
        const result = await submit(card.id, rating, elapsedMs);
        const queue = state.queue.slice(1);
        elapsed = 0; startedAt = state.reviewing ? now() : null;
        patch({ queue, lastRated: result?.reviewId ? { card, reviewId: result.reviewId } : null, ...responseFor(queue[0]) });
        return true;
      } catch (e) { patch({ error: `评分未保存，请重试：${String(e)}` }); return false; }
      finally { patch({ busy: false }); }
    },
    async undo(submit: (cardId: string, reviewId: string) => Promise<Flashcard>) {
      const rated = state.lastRated;
      if (!rated || state.busy) return false;
      patch({ busy: true, error: "" });
      try {
        const restored = await submit(rated.card.id, rated.reviewId);
        const queue = [restored, ...state.queue.filter(card => card.id !== restored.id)];
        elapsed = 0; startedAt = state.reviewing ? now() : null;
        patch({ queue, lastRated: null, ...responseFor(queue[0]) });
        return true;
      } catch (e) { patch({ error: `无法撤销上一次评分：${String(e)}` }); return false; }
      finally { patch({ busy: false }); }
    },
  };
}

const session = createFlashcardReviewSession();
export function useFlashcardReviewSession() {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => () => session.pause(), []);
  return { ...state, session };
}
