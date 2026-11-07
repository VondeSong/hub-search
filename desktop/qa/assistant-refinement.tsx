/** Visual replay with synthetic data. This page does not contact a model or user libraries. */
import { createRoot } from "react-dom/client";
import { PersistentSourceInvestigation } from "../src/AgentInvestigation";
import type { SearchResult } from "../src/SearchTypes";
import "../src/App.css";

const params = new URLSearchParams(location.search);
const width = Number(params.get("width")) || 520;
const dark = params.get("theme") === "dark";
localStorage.setItem("hub.agent.panel.width.v1", String(width));
sessionStorage.setItem("hub-agent-docked", "true");
if (dark) Object.entries({
  "--hub-content-surface": "#232426", "--hub-text-primary": "#ededee", "--hub-text-secondary": "#a4a5aa",
  "--hub-text-tertiary": "#777980", "--hub-separator": "#ffffff1c", "--hub-control-fill": "#ffffff0c",
  "--hub-accent": "#75a8ee", "--hub-accent-soft": "#75a8ee20",
}).forEach(([name, value]) => document.documentElement.style.setProperty(name, value));

const now = Date.now(), day = 86_400_000;
const histories = [
  { id: "qa-pinned", goal: "整理线束设计评审的检查清单", state: "completed", pinned: true, updatedAt: now - 2 * day, messageCount: 8 },
  { id: "qa-today", goal: "这份资料有哪些需要继续核对的地方？", state: "completed", updatedAt: now - 2 * 3_600_000, messageCount: 4 },
  { id: "qa-week", goal: "知识库的资料组织方法", state: "completed", updatedAt: now - 5 * day, messageCount: 6 },
  { id: "qa-month", goal: "从阅读笔记中提取行动项", state: "completed", updatedAt: now - 18 * day, messageCount: 3 },
  { id: "qa-old", goal: "整理项目交付前的待确认事项", state: "completed", updatedAt: now - 45 * day, messageCount: 5 },
  { id: "qa-archive", goal: "已经完成的资料整理讨论", state: "completed", updatedAt: now - 50 * day, messageCount: 2, archived: true },
] as Array<{ id: string; goal: string; state: string; updatedAt: number; messageCount: number; pinned?: boolean; archived?: boolean; deleted?: boolean }>;
const libraries = [
  { id: "qa-craft-main", provider: "craft", name: "main", connected: true, documentCount: 128, excludedPaths: [] },
  { id: "qa-craft-car", provider: "craft", name: "car", connected: true, documentCount: 64, excludedPaths: [] },
  { id: "qa-obsidian", provider: "obsidian", name: "工作笔记", connected: true, documentCount: 86, excludedPaths: [] },
  { id: "qa-reference", provider: "obsidian", name: "参考资料", connected: false, documentCount: 32, excludedPaths: [] },
];
const anchor = { kind: "note", libraryId: "qa-craft-main", documentId: "qa-page", pageId: "qa-page" };
const settings = { provider: "codex", model: "gpt-6.1-sol", reasoningEffort: "medium", fast: false, maxConcurrent: 2 };
const views = new Map<string, any>();
function getView(id: string) {
  if (!views.has(id)) {
    const item = histories.find(item => item.id === id)!;
    const report = { status: "completed", summary: "可以从 **来源、主题和下一步行动** 三个方面整理。先保留原文依据，再归纳观点，最后把需要继续处理的内容单独列出。\n\n### 建议的整理方式\n\n- 保留资料来源，方便随时回到原文。\n- 将相同主题的笔记放在一起，减少重复。\n- 区分已经确认的结论与需要继续核对的问题。", findings: [], nextSteps: [], questions: [], limitations: [], waitCondition: "" };
    views.set(id, { work: { id, goal: item.goal, state: "completed", revision: 1, authorizationVersion: 1, anchor, grant: { libraryIds: ["qa-craft-main"], notes: [anchor] }, report }, assistantOptions: { model: settings, autoFlashcardInbox: false }, evidence: [], decisions: [], run: null, validity: "", runActive: false, conversation: { messages: [{ id: `${id}-u`, role: "user", text: item.goal, revision: 1, createdAt: item.updatedAt - 60_000 }, { id: `${id}-a`, role: "assistant", report, evidence: [], revision: 1, createdAt: item.updatedAt }], hasEarlier: false } });
  }
  return structuredClone(views.get(id));
}

Object.assign(window, {
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  __TAURI_INTERNALS__: {
    transformCallback: () => 1, unregisterCallback: () => {},
    invoke: async (command: string, payload: any = {}) => {
      const args = payload.args || {};
      if (command === "plugin:event|listen") return 1;
      if (command === "plugin:event|unlisten") return;
      if (command === "get_window_visibility") return { revision: "1", visible: true, foreground: true, minimized: false };
      if (command === "list_libraries") return libraries;
      if (command === "shared_memory") return { configured: false, projects: [], entries: [], selection: { enabled: false, projectId: "" } };
      if (command === "model_runtime") {
        if (args.action === "models") return { models: args.provider === "deepseek"
          ? [{ id: "deepseek-flash", name: "DeepSeek Flash", reasoningLevels: ["none", "low", "high", "max"], defaultReasoning: "high" }]
          : [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], defaultReasoning: "medium", fastDescription: "使用该模型支持的 Fast 服务档位。实际速度以提供方运行情况为准。" }, { id: "gpt-6-astra", name: "GPT-6 Astra", reasoningLevels: ["low", "medium", "high", "xhigh", "max"], defaultReasoning: "medium" }] };
        return { settings, jobs: [], revision: 1 };
      }
      if (command === "agent_materials") return { documents: [], items: [] };
      if (command !== "agent_investigation") return [];
      if (args.action === "list") return { works: histories.filter(item => !item.deleted && !!item.archived === !!args.archived && item.goal.includes(args.query || "")).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt), nextCursor: null };
      if (args.action === "setHistoryPreference") {
        const item = histories.find(item => item.id === args.id);
        if (item) for (const key of ["pinned", "archived", "deleted"] as const) if (typeof args[key] === "boolean") item[key] = args[key];
        return { saved: true };
      }
      if (args.action === "skills") return { skills: [], warnings: [], userDirectory: "示例目录" };
      if (args.action === "create") {
        const id = `qa-created-${Date.now()}`;
        histories.unshift({ id, goal: args.goal, state: "ready", updatedAt: Date.now(), messageCount: 1 });
        const view = getView(id); view.work.grant = args.grant; view.work.report = null; view.work.state = "ready"; view.conversation.messages = view.conversation.messages.slice(0, 1); views.set(id, view); return view;
      }
      if (args.action === "configureAssistant") { const view = getView(args.id); view.assistantOptions = args.options; views.set(args.id, view); return view; }
      if (args.action === "message") { const view = getView(args.id); if (args.setLibraryIds) view.work.grant.libraryIds = args.setLibraryIds; views.set(args.id, view); return view; }
      if (args.id && histories.some(item => item.id === args.id)) return getView(args.id);
      return { items: [], works: [] };
    },
  },
});

const page: SearchResult = { id: "qa-page", entityKey: "page:qa-craft-main:qa-page", provider: "craft", libraryId: "qa-craft-main", libraryName: "main", spaceId: "qa-craft-main", spaceName: "main", documentId: "qa-page", pageId: "qa-page", title: "资料组织方法", documentTitle: "资料组织方法", contentType: "markdown", sourceType: "note", path: "知识管理/资料组织方法", snippet: "", matchTerms: [], matchField: "", matchCount: 0, subMatches: [] };
function App() {
  return <main style={{ minHeight: "100dvh", background: dark ? "#1a1b1d" : "#f4f4f2", padding: "28px 36px", color: "var(--hub-text-primary)" }}>
    <nav style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 12, color: "var(--hub-text-secondary)" }}><strong>Hub</strong><span>正式组件交互预览 · 示例数据</span><a href={`?width=320&theme=${dark ? "dark" : "light"}`}>320px</a><a href={`?width=520&theme=${dark ? "dark" : "light"}`}>520px</a><a href={`?width=${width}&theme=${dark ? "light" : "dark"}`}>{dark ? "浅色" : "深色"}</a></nav>
    <article style={{ maxWidth: 550, padding: "64px 18px", fontSize: 15, lineHeight: 1.9 }}><p style={{ fontSize: 12, color: "var(--hub-text-secondary)" }}>main / 知识管理</p><h1 style={{ fontSize: 30, fontWeight: 600, marginBottom: 20 }}>资料组织方法</h1><p>让资料保持清楚，也让下一次查找更轻松。</p><h2 style={{ fontSize: 18, marginTop: 36 }}>从来源开始</h2><p>保留原文和上下文，再按主题整理。每一条结论都应当能够回到它的依据。</p><h2 style={{ fontSize: 18, marginTop: 28 }}>给下一步留下线索</h2><p>把已经确认的内容、待核对的问题和可以执行的行动分别记录，方便继续。</p></article>
    <PersistentSourceInvestigation result={page} initiallyOpen startFresh />
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
