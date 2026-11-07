import { useEffect, useState } from "react";
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
import { CollectionNavigation } from "../src/CollectionNavigation";
import { CollectionViewsProvider, useCollectionViews } from "../src/CollectionViews";

// Isolated interaction QA: all IPC uses generated local fixtures. No real
// accounts, libraries, reading database or external content are accessed.
const sources = [
  { id: "bookmarks", count: 753, connected: true, canResume: false, status: "" },
  { id: "likes", count: 19, connected: true, canResume: false, status: "" },
  { id: "telegram", count: 2, connected: true, canResume: false, status: "" },
  { id: "dida", count: 40, connected: true, canResume: false, status: "" },
];
const titles = ["还得是韩国综艺好看啊，大大方方了", "迭代近一年，做好一个小插件。", "《阿燊的情书》击中的就是一种集体无意识", "老哥们，又冒出来个把我整得直呼邪门的开源神器", "资治通鉴里有一个规律"];
const items = Array.from({ length: 814 }, (_, index) => {
  const source = index < 753 ? "bookmarks" : index < 772 ? "likes" : index < 774 ? "telegram" : "dida";
  return { key: `${source}:fixture:${index}`, collectedAt: 1791763200000 - index * 3600000, read: false, status: index === 0 ? "in_progress" : "unread", lifecycle: "active", tags: [], post: { id: `fixture-${index}`, source, text: titles[index % titles.length] + ` · 阅读样例 ${index + 1}`, authorName: ["智囊神", "枯白啃设计", "知白", "Gk"][index % 4], authorHandle: "fixture", url: `https://fixture.invalid/reading/${index}`, publishedAt: "2026-10-12", links: [], media: [], quotedText: "", contentStatus: "complete" } };
});
const storage = { config: { mode: "database", vaultPath: "", downloadMedia: true, autoSyncMinutes: 30 }, running: false, status: "" };
const callbacks = new Set<() => void>();
const auxiliaryWaiters: (() => void)[] = [];
const notify = () => callbacks.forEach(callback => callback());
const fixture = {
  auxiliaryReleased: false,
  pageDelayMs: 180,
  calls: [] as { command: string; source?: unknown; offset?: unknown; startedAt: number }[],
  releaseAuxiliary() { fixture.auxiliaryReleased = true; auxiliaryWaiters.splice(0).forEach(resolve => resolve()); notify(); },
  async invoke(command: string, args: Record<string, unknown> = {}) {
    fixture.calls.push({ command, source: args.source, offset: args.offset, startedAt: performance.now() }); notify();
    if (command === "get_window_visibility") return { revision: "1", visible: true, minimized: false, foreground: true };
    if (command === "list_collection_items") {
      await new Promise(resolve => setTimeout(resolve, fixture.pageDelayMs));
      const selected = items.filter(item => (args.source === "all" || !args.source || item.post.source === args.source) && (args.status === "all" || !args.status || item.status === args.status));
      const offset = Number(args.offset) || 0;
      return { items: selected.slice(offset, offset + 60), total: 814, unread: 813, matched: selected.length, connected: true, running: false, canResume: false, status: "", sources, navigationCounts: { all: selected.length, unread: selected.filter(item => item.status === "unread").length, inProgress: selected.filter(item => item.status === "in_progress").length, read: 0, archived: 0, abandoned: 0, needsAttention: 0, savedCopies: [] } };
    }
    if (["get_collection_storage", "list_libraries", "collection_library_operations"].includes(command)) {
      if (!fixture.auxiliaryReleased) await new Promise<void>(resolve => auxiliaryWaiters.push(resolve));
      return command === "get_collection_storage" ? storage : [];
    }
    // Native-only listeners are inert in this browser fixture.
    if (command === "plugin:event|listen") return 0;
    if (command === "plugin:event|unlisten") return;
    if (["reading_attachment_status", "reading_copy_devices", "collection_delete_preview"].includes(command)) return [];
    if (command === "open_external_url") return;
    throw new Error(`隔离样例尚未实现此操作：${command}`);
  },
};
Object.assign(window, { __READING_TRANSITION_FIXTURE__: fixture, __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} }, __TAURI_INTERNALS__: { invoke: fixture.invoke, convertFileSrc: (path: string) => path, transformCallback: () => 0, unregisterCallback: () => {} } });

function Route() {
  const [reading, setReading] = useState(true), [, redraw] = useState(0);
  const { updateView } = useCollectionViews();
  useEffect(() => { updateView({ layout: "table", source: "bookmarks", status: "all", query: "", tags: [], media: "all", dateFilter: "any", destinationId: "", attentionOnly: false }); }, [updateView]);
  useEffect(() => { const changed = () => redraw(value => value + 1); callbacks.add(changed); return () => { callbacks.delete(changed); }; }, []);
  return <div style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "#fff" }}>
    <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", borderBottom: "1px solid #e6e8ed", fontSize: 13 }}>
      <button onClick={() => setReading(!reading)}>{reading ? "离开阅读" : "返回阅读"}</button>
      <button disabled={fixture.auxiliaryReleased} onClick={() => fixture.releaseAuxiliary()}>释放辅助状态</button>
      <span role="status">正文请求 {fixture.calls.filter(call => call.command === "list_collection_items").length} 次 · 辅助状态{fixture.auxiliaryReleased ? "已释放" : "等待手动释放"} · 样例总计 814 条，每页 60 条</span>
    </div>
    <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <aside style={{ width: 200, flexShrink: 0, padding: "14px 10px", display: "flex", borderRight: "1px solid #e6e8ed" }}><CollectionNavigation /></aside>
      {reading ? <CollectionsWorkspace /> : <div style={{ flex: 1, display: "grid", placeItems: "center", color: "#68707a" }}>阅读已关闭，点击“返回阅读”检查页面恢复。</div>}
    </div>
  </div>;
}
document.body.style.margin = "0";
const qaRoot = createRoot(document.getElementById("root")!);
qaRoot.render(<CollectionViewsProvider><Route /></CollectionViewsProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => { qaRoot.unmount(); callbacks.clear(); fixture.releaseAuxiliary(); });
