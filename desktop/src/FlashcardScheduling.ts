import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Flashcard } from "./FlashcardTypes";

export type FlashcardSchedulePreview = {
  cardId: string;
  reviewKey: string;
  desiredRetention: number;
  choices: { rating: number; intervalSeconds: number }[];
};

export function formatReviewInterval(seconds: number): string {
  return seconds < 86_400 ? `${Math.round(seconds / 60)} 分钟` : `${Math.round(seconds / 86_400)} 天`;
}

export function useFlashcardSchedulePreview(card: Flashcard | undefined, enabled: boolean) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const cardId = card?.id;
  const identity = enabled && card ? JSON.stringify([card, revision]) : "";
  const [result, setResult] = useState<{ identity: string; preview?: FlashcardSchedulePreview; error?: string }>({ identity: "" });

  useEffect(() => {
    if (!identity || !cardId) return;
    let cancelled = false;
    setResult({ identity: "" });
    void invoke<FlashcardSchedulePreview>("preview_flashcard_review", { cardId, expectedCard: card }).then(preview => {
      if (preview?.cardId !== cardId || !preview.reviewKey || preview.choices.length !== 4
        || ![1, 2, 3, 4].every(rating => preview.choices.some(choice => choice.rating === rating && Number.isFinite(choice.intervalSeconds) && choice.intervalSeconds > 0))) {
        throw new Error("复习间隔未完整加载，请重试");
      }
      if (!cancelled) setResult({ identity, preview });
    }).catch(reason => {
      if (!cancelled) setResult({ identity, error: String(reason) });
    });
    return () => { cancelled = true; };
  }, [identity, cardId]);

  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [enabled, refresh]);

  return {
    preview: identity && result.identity === identity ? result.preview : undefined,
    error: identity && result.identity === identity ? result.error : undefined,
    refresh,
  };
}
