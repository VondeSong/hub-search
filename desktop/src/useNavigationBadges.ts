import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FlashcardDashboardStats } from "./FlashcardTypes";
import { todayFlashcardDueCount } from "./FlashcardStudyPlan";
import { useWindowResumeRefresh } from "./useWindowResumeRefresh";
import { useFlashcardDataRefresh } from "./useFlashcardDataRefresh";

export function useNavigationBadges({ ready, flashcardsActive }: { ready: boolean; flashcardsActive: boolean }) {
  const active = useRef(true), revision = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; revision.current++; }; }, []);
const [flashcardDueCount, setFlashcardDueCount] = useState(0);

const [taskOpenCount, setTaskOpenCount] = useState(0);

const refreshTodayReviewCount = useCallback(async () => {
    if (!ready) return;
    const requested = ++revision.current;
    const [stats, settings] = await Promise.all([
      invoke<FlashcardDashboardStats>("get_flashcard_dashboard_stats"),
      invoke<{ dailyNewLimit: number }>("get_flashcard_study_settings"),
    ]);
    if (active.current && requested === revision.current) setFlashcardDueCount(todayFlashcardDueCount(stats, settings.dailyNewLimit));
  }, [ready]);

useEffect(() => { void refreshTodayReviewCount().catch(() => undefined); }, [refreshTodayReviewCount, flashcardsActive]);

useWindowResumeRefresh(refreshTodayReviewCount);
useFlashcardDataRefresh(refreshTodayReviewCount);

const updateFlashcardDueCount = useCallback((count: number) => { revision.current++; setFlashcardDueCount(count); }, []);
const updateTaskOpenCount = useCallback((count: number) => setTaskOpenCount(count), []);
return { flashcardDueCount, taskOpenCount, refreshTodayReviewCount, updateFlashcardDueCount, updateTaskOpenCount };
}
