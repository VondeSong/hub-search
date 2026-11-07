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
import { CollectionsWorkspace } from "../src/CollectionsWorkspace";
import { CollectionViewsProvider, defaultCollectionView, COLLECTION_VIEWS_KEY } from "../src/CollectionViews";
import { MobileAppEntry } from "../src/MobileAppEntry";
import { DesktopAppEntry } from "../src/DesktopAppEntry";
import { MobileNavigation } from "../src/MobileNavigation";
import { runtimeCapabilities } from "../src/RuntimePlatform";
import { WorkspaceHeaderContext, WorkspaceModeControl } from "../src/WorkspaceChrome";
import { WorkspaceRail } from "../src/WorkspaceRail";

// This entry point never connects to Tauri, accounts, or external services.
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const mediaUrl = "https://fixture.invalid/attachments/reading-diagram.png";
const fileUrl = "https://fixture.invalid/attachments/reading-notes-long-file-name-for-mobile.pdf";
const calls: { command: string; args: Record<string, unknown> }[] = [];
const copies = [{ device: "fixture-windows", deviceLabel: "示例桌面设备", local: !runtimeCapabilities.mobile, observedAt: 1791456000, copies: [{ id: "craft-copy", provider: "craft", name: "示例学习资料库", state: "partial" }] }];
const attachmentStates = [
  { url: mediaUrl, local: true, canUpload: true, state: "ready", size: 10240, mime: "image/png", error: "", canPin: true, pinned: true, hash: "fixture-image" },
  { url: fileUrl, local: false, canUpload: false, state: "ready", size: 524288, mime: "application/pdf", error: "", canPin: true, pinned: false, hash: "fixture-document" },
];
const basePost = (index: number, source = "bookmarks") => ({
  id: `${10000 + index}`, source,
  text: `示例 ${String(index + 1).padStart(2, "0")} · ${source === "dida" ? "滴答稍后读：" : "X 阅读笔记："}为什么复杂界面需要把阅读与管理操作分开\n\n这是一份仅用于界面检查的样例正文。手机上应优先显示内容，并保留明确的返回入口。\n\n${Array.from({ length: 6 }, (_, n) => `第 ${n + 1} 段：保持长篇文章的可读性，检查滚动容器、图片、附件和回复。这里不包含任何真实账号或账户内容。`).join("\n\n")}\n\n[示例引用链接](https://fixture.invalid/reference)`,
  authorName: source === "dida" ? "示例滴答清单" : "界面研究示例作者",
  authorHandle: source === "dida" ? "" : "reading_fixture",
  publishedAt: "2026-10-08T08:00:00Z", url: `https://fixture.invalid/${source}/${10000 + index}`,
  quotedText: "", contentStatus: "complete", links: [],
  media: [{ kind: "photo", url: mediaUrl }, { kind: "document", url: fileUrl }],
  replyCount: source === "dida" ? 0 : 2, threadFormat: 2, threadStatus: "complete",
});
const items = Array.from({ length: 48 }, (_, index) => {
  const source = index % 7 === 6 ? "dida" : index % 5 === 4 ? "telegram" : "bookmarks";
  const post = basePost(index, source);
  return {
    key: `${source === "dida" ? "dida" : source}:${post.id}`, collectedAt: 1791456000000 - index * 1000,
    read: index % 6 === 0, status: index % 6 === 0 ? "read" : "unread", lifecycle: "active", tags: ["界面样例", "阅读"], savedMedia: [mediaUrl],
    destinationId: "craft", destinationIds: ["craft"], storageLocations: [{ kind: "craft", libraryId: "craft", name: "示例学习资料库", path: "阅读/示例文章", copyState: "saved" }],
    post: { ...post, thread: source === "bookmarks" ? [
      { ...basePost(100 + index), text: "示例回复一：阅读区域应当能够完整显示正文。", media: [], id: `${20000 + index}`, replyToId: post.id, replyToHandle: post.authorHandle },
      { ...basePost(200 + index), text: "示例回复二：把离线附件与副本记录放入按需打开的本文管理。", media: [], id: `${30000 + index}`, replyToId: `${20000 + index}`, replyToHandle: "reading_fixture" },
    ] : [] },
  };
});
const libraries = [
  { id: "craft", provider: "craft", name: "示例学习资料库", connected: true, documentCount: 48, excludedPaths: [] },
  { id: "dida", provider: "dida365", name: "示例滴答清单", connected: true, documentCount: 7, excludedPaths: [] },
];
const sources = ["bookmarks", "likes", "telegram", "dida"].map(id => ({ id, count: items.filter(item => item.post.source === id).length, connected: true, canResume: false, status: "界面检查样例", lastSuccess: 1791456000 }));
const offlinePlan = { token: "fixture-plan", postHash: "fixture-post", total: 2, available: 1, retained: 1, downloadBytes: 524288, actionable: 1, complete: false, warnings: [], previous: "", items: attachmentStates.map(item => ({ url: item.url, state: item.local ? "available" : "download", bytes: item.size, reason: item.local ? "本机已校验" : "可以下载" })) };
const fixture = {
  calls, copied: "", external: [] as string[], unknown: [] as string[],
  async invoke(command: string, args: Record<string, unknown> = {}) {
    calls.push({ command, args });
    if (command === "list_collection_items") {
      const filtered = items.filter(item => (!args.source || args.source === "all" || item.post.source === args.source) && (!args.query || item.post.text.includes(String(args.query))) && (!args.status || args.status === "all" || item.status === args.status));
      return { items: filtered.slice(Number(args.offset) || 0, (Number(args.offset) || 0) + 60), total: items.length, unread: 40, matched: filtered.length, availableTags: ["界面样例", "阅读"], sources, connected: true, running: false, canResume: false, status: "隔离界面检查", navigationCounts: { all: 48, unread: 40, inProgress: 0, read: 8, archived: 0, abandoned: 0, needsAttention: 0, savedCopies: [{ libraryId: "craft", count: 48 }] } };
    }
    if (command === "get_collection_storage") return { config: { mode: "database", vaultPath: "", downloadMedia: true, autoSyncMinutes: 30 }, running: false, status: "隔离样例", telegramRunning: false, didaRunning: false };
    if (command === "list_libraries") return libraries;
    if (command === "collection_library_operations") return [];
    if (command === "get_dida_reading_login_status") return { connected: true, accountMatched: true, checkedAt: 1791456000, loginWindowOpen: false, state: "verified", message: "隔离样例：滴答网页登录与资料库账号绑定核验通过。" };
    if (command === "open_dida_attachment_login") return "隔离样例：已请求打开登录窗口";
    if (command === "collection_media_preview" || command === "markdown_media_preview") return { source: image, mediaType: "image", mimeType: "image/png" };
    if (command === "reading_attachment_status") return attachmentStates;
    if (command === "reading_copy_status") return copies;
    if (command === "preview_reading_offline") return offlinePlan;
    if (command === "download_reading_offline") return { succeeded: 1, failures: [], plan: { ...offlinePlan, complete: true, actionable: 0, available: 2, retained: 2 } };
    if (command === "preview_reading_recovery") return { ...offlinePlan, actionable: true, checkedAt: 1791456000 };
    if (command === "check_reading_recovery") return { plan: { ...offlinePlan, actionable: true, checkedAt: 1791456000 }, bodyVerified: true, verified: 2, complete: true, checkedAt: 1791456000, failures: [] };
    if (command === "preview_reading_source_recovery") return { token: "fixture-source-plan", downloadBytes: 524288, sourceBytes: 2048, cleanupEnabled: false, recovery: { total: 2, actionable: true, warnings: [] } };
    if (command === "check_reading_source_recovery") return { complete: true, checkedAt: 1791456000, verified: 2, total: 2, failures: [] };
    if (command === "open_external_url") { fixture.external.push(String(args.url)); return; }
    if (command === "set_collection_read" || command === "set_collection_properties") {
      const item = items.find(item => item.key === args.key);
      if (item) { item.read = command === "set_collection_read" ? Boolean(args.read) : args.status === "read"; item.status = String(args.status || (item.read ? "read" : "unread")); }
      return "样例状态已保存";
    }
    if (["open_collection_attachment", "transfer_reading_attachment", "pin_reading_attachment", "unpin_reading_attachment", "refresh_collection_content", "sync_x_bookmarks"].includes(command)) return "仅处理界面样例";
    fixture.unknown.push(command);
    throw new Error(`隔离样例未实现 IPC：${command}`);
  },
};
Object.assign(window, { __READING_FIXTURE__: fixture, __TAURI_INTERNALS__: { invoke: fixture.invoke, convertFileSrc: (path: string) => path, transformCallback: () => 0, unregisterCallback: () => {} } });
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { fixture.copied = value; } } });

const view = defaultCollectionView(new URLSearchParams(location.search).get("layout") === "gallery" ? "gallery" : "list");
localStorage.setItem(COLLECTION_VIEWS_KEY, JSON.stringify({ version: 2, view, views: [], activeEntry: { kind: "builtin", id: "all" }, layoutPreferences: {}, librariesCollapsed: false }));

const content = <div className="main-content-override"><WorkspaceHeaderContext.Provider value={runtimeCapabilities.mobile ? null : { actions: <WorkspaceModeControl mode="focus" onModeChange={() => {}} />, onMouseDown: () => {} }}><CollectionsWorkspace onToggleDesktopSidebar={runtimeCapabilities.mobile ? undefined : () => {}} /></WorkspaceHeaderContext.Provider></div>;
const rail = <WorkspaceRail onTogglePanel={() => {}} panelExpanded={false} activeView="collections" spaces={libraries} selectedLibraryIds={null} renderLibraryIcon={() => null} favoriteCount={0} taskOpenCount={0} journalCount={0} historyCount={0} tagCount={0} flashcardDueCount={0} onSelectView={() => {}} onSelectAllLibraries={() => {}} onSelectLibrary={() => {}} onToggleLibrary={() => {}} onManageLibraries={() => {}} />;
createRoot(document.getElementById("root")!).render(<CollectionViewsProvider>
  {runtimeCapabilities.mobile ? <MobileAppEntry filtersOpen={false} previewOpen={false} style={{ "--interface-font-size": "14px", "--preview-title-font-size": "20px", "--preview-title-weight": 600 } as React.CSSProperties}><div className="drag-strip" />{content}<footer className="footer-bar mobile-navigation-footer"><MobileNavigation active="browse" dueCount={0} onSelect={() => {}} /></footer></MobileAppEntry> : <DesktopAppEntry filtersOpen={false} previewOpen={false} style={{}} sidebarEnabled sidebarMode="focus" workspaceView="collections"><div className="drag-strip" />{rail}<div className="desktop-main-layout">{content}<footer className="footer-bar">隔离界面检查 · 仅使用样例</footer></div></DesktopAppEntry>}
</CollectionViewsProvider>);
