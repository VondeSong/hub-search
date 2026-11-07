import React from "react";
import { createRoot } from "react-dom/client";
import "../src/MobileExperience.css";
import "../src/MobileDesign.css";
import "../src/MobileGlass.css";
import "../src/MobileNavigationDesign.css";
import { studyDateKey } from "../src/StudyChartData";
import { FlashcardsWorkspace } from "../src/FlashcardsWorkspace";

const params = new URLSearchParams(location.search);
if (params.has("mobile")) document.documentElement.dataset.runtimePlatform = "android";
let synced = !params.has("stale");
let mode = params.get("state") ?? "normal";
const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Map<number, { event: string; handler: number }>();
let serial = 0;
const today = new Date();
const activity = [0, 0, 2, 0, 0, 33, 16].map((count, index) => {
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  date.setDate(date.getDate() - 6 + index);
  return { date: studyDateKey(date), count: mode === "empty" ? 0 : count };
});
const decks = [{ id: "qa", name: "学习笔记", cardCount: 707, dueCount: 707, newCount: 699, updatedAt: 1 }];
const stats = () => ({ totalCards: mode === "empty" ? 0 : 707, dueCards: mode === "empty" || mode === "complete" ? 0 : 707, newDueCards: mode === "empty" || mode === "complete" ? 0 : 699, newCards: 699, learningCards: 8, masteredCards: 0, totalReviews: 51, reviewedToday: mode === "empty" ? 0 : synced ? 16 : 13, newStudiedToday: mode === "empty" ? 0 : synced ? 10 : 7, retentionRate: .94, ratingCounts: [1, 2, 44, 4], dailyActivity: activity });
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++serial, callback); return serial; },
  unregisterCallback: (id: number) => callbacks.delete(id),
  invoke: async (command: string, args: any) => {
    if (command === "plugin:event|listen") { listeners.set(++serial, args); return serial; }
    if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return; }
    if (command === "get_window_visibility") return { revision: "1", visible: true, minimized: false, foreground: true };
    if (command === "list_flashcard_decks") return mode === "empty" ? [] : decks;
    if (command === "list_flashcard_deck_folders" || command === "list_flashcard_drafts" || command === "get_flashcards_by_ids") return [];
    if (command === "get_flashcard_dashboard_stats") return stats();
    if (command === "get_flashcard_study_settings") return { dailyNewLimit: 10, updatedAt: 0 };
    if (command === "flashcard_review_plan") return { sessionIds: [], sessionCount: mode === "empty" || mode === "complete" ? 0 : synced ? 8 : 11, eligibleCount: 8, newAvailable: 0, newWaiting: mode === "empty" || mode === "complete" ? 0 : 699, revision: "1", asOf: 1 };
    if (command === "list_flashcards_page") return { items: [], total: 0, matchedTotal: 0, scopeTotal: 707, revision: "1", asOf: 1, tags: [], customFieldKeys: [], stageCounts: {} };
    if (command === "sync_flashcards") { synced = true; return { uploadedCards: 707, downloadedCards: 3, mergedReviews: 3, uploadedMedia: 0, downloadedMedia: 0, conflictRetries: 0, completedAt: 1 }; }
    if (command === "get_flashcard_sync_settings") return { configured: true };
    throw new Error(`Preview command: ${command}`);
  },
};
function notify() {
  for (const [, listener] of listeners) if (listener.event === "flashcards-data-changed") callbacks.get(listener.handler)?.({ event: listener.event, id: 1, payload: null });
}
createRoot(document.getElementById("root")!).render(<><nav className="qa-actions" aria-label="预览验证"><span>示例数据</span><button onClick={() => { synced = true; notify(); }}>模拟后台同步</button><button onClick={() => { mode = "complete"; notify(); }}>已完成</button><button onClick={() => { mode = "empty"; activity.forEach(day => day.count = 0); notify(); }}>空牌库</button></nav><div className="qa-content"><FlashcardsWorkspace onClose={() => undefined} /></div></>);
