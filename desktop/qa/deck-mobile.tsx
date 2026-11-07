import React from "react";
import { createRoot } from "react-dom/client";
import "../src/App.css";
import "../src/WorkspaceRefresh.css";
import "../src/InterfaceSelection.css";
import "../src/LiquidWorkspace.css";
import "../src/DisplayPreferences.css";
import "../src/MobileExperience.css";
import "../src/MobileDesign.css";
import "../src/MobileGlass.css";
import "../src/MobileNavigationDesign.css";
import { FlashcardsWorkspace } from "../src/FlashcardsWorkspace";
import { MobileAppEntry } from "../src/MobileAppEntry";
import { runtimeCapabilities } from "../src/RuntimePlatform";

// Sample-only fixture: rejects unknown IPC and never accesses accounts or data.
const decks = [
  { id: "sample-1", name: "示例牌组 · 三维设计配置梳理", cardCount: 62, dueCount: 12, newCount: 0, updatedAt: 100 },
  { id: "sample-2", name: "示例牌组 · 插件、连接与电气逻辑", cardCount: 83, dueCount: 8, newCount: 0, updatedAt: 100 },
  { id: "sample-3", name: "示例牌组 · 设计标准与校核", cardCount: 186, dueCount: 14, newCount: 0, updatedAt: 100 },
];
const fixture = {
  unknown: [] as string[], cloudSettingsEvents: 0,
  async invoke(command: string) {
    if (command === "list_flashcard_decks") return decks;
    if (["list_flashcard_deck_folders", "list_flashcard_drafts", "get_flashcards_by_ids", "list_flashcard_backups"].includes(command)) return [];
    if (command === "list_flashcards_page") return { items: [], total: 0, revision: "sample", asOf: 1 };
    if (command === "get_flashcard_dashboard_stats") return { totalCards: 331, dueCards: 34, newCards: 0, learningCards: 0, masteredCards: 297, totalReviews: 0, reviewedToday: 0, retentionRate: 0, ratingCounts: [0, 0, 0, 0], dailyActivity: [] };
    if (command === "get_flashcard_study_settings") return { dailyNewLimit: 10, updatedAt: 0 };
    if (command === "get_flashcard_sync_settings") return { url: "", username: "", hasPassword: false, autoSync: false, configured: false, lastError: "" };
    fixture.unknown.push(command);
    throw new Error(`隔离牌库未实现 IPC：${command}`);
  },
};
Object.assign(window, { __DECK_FIXTURE__: fixture, __TAURI_INTERNALS__: { invoke: fixture.invoke, convertFileSrc: (path: string) => path, transformCallback: () => 0, unregisterCallback: () => {} } });
window.addEventListener("hub:open-cloud-sync-settings", () => { fixture.cloudSettingsEvents += 1; });
const content = <FlashcardsWorkspace onClose={() => {}} />;
createRoot(document.getElementById("root")!).render(runtimeCapabilities.mobile
  ? <MobileAppEntry filtersOpen={false} previewOpen={false} style={{ "--interface-font-size": "14px" } as React.CSSProperties}><div className="main-content-override">{content}</div></MobileAppEntry>
  : <div className="app-shell" style={{ height: "100dvh", display: "flex" }}><main style={{ width: "100%", minWidth: 0 }}>{content}</main></div>);
