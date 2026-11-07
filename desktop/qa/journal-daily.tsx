import { useState } from "react";
import { createRoot } from "react-dom/client";
import { X } from "lucide-react";
import { JournalWorkspace } from "../src/JournalWorkspace";
import { JournalNavigation } from "../src/JournalNavigation";
import { JournalViewsContext, localJournalDate, shiftJournalDay, useJournalViewStore } from "../src/JournalViews";
import type { SearchResult, LibrarySummary } from "../src/SearchTypes";
import type { UnifiedTask } from "../src/TaskWorkspacePresentation";
import { TaskWorkspace } from "../src/TaskWorkspace";
import { UnifiedTaskProvider, useUnifiedTasks } from "../src/UnifiedTaskData";
import "../src/App.css";
import "../src/WorkspaceRefresh.css";
import "../src/JournalWorkspace.css";
import "../src/JournalDatabase.css";

const today = localJournalDate(), tomorrow = shiftJournalDay(today, 1);
const libraries: LibrarySummary[] = ["Private", "Car", "Archive"].map(name => ({ id: name, name, provider: "craft", connected: true, documentCount: 2, excludedPaths: [] }));
const entries: SearchResult[] = ["今天", "明天", "星期四"].map((title, i) => ({
  id: String(i), entityKey: `document:Private:${i}`, documentId: String(i), contentType: "document", sourceType: "craft_page", provider: "craft", spaceId: "Private", libraryId: "Private", libraryName: "Private", spaceName: "Private", title, documentTitle: title, journalDate: shiftJournalDay(today, i), path: "日记", snippet: ["复盘今天的设计与学习，整理接下来要推进的事项。", "梳理评审材料和资料来源。核对任务进展，留下可以继续推进的下一步。", "整理这一周的记录，把阅读中的想法转成可以实践的行动。"][i], matchTerms: [], matchField: "", matchCount: 0, subMatches: [], modifiedAt: Date.now(),
}));
const dateAt = (day: string, time: string) => `${day}T${time}:00+08:00`;
const makeTask = (id: string, title: string, patch: Partial<UnifiedTask> = {}): UnifiedTask => ({ id, title, provider: "craft", libraryId: "Private", libraryName: "Private", sourceId: id, parentTaskId: "", parentPageId: "0", documentId: "0", documentTitle: "今天", completed: false, status: "open", isAllDay: true, dueAt: today, path: "未归档", depth: 0, isProject: false, linkedProviders: [], syncState: "unlinked", ...patch });
let tasks: UnifiedTask[] = [
  makeTask("design", "完善日历界面", { scheduledAt: shiftJournalDay(today, -2), startAt: shiftJournalDay(today, -2), dueAt: shiftJournalDay(today, 3), collectionName: "产品设计", linkedLibraryIds: ["Private", "dida"], linkedProviders: ["craft", "dida365"], syncState: "linked" }),
  makeTask("review", "核对方案评审材料", { libraryId: "Car", libraryName: "Car" }),
  makeTask("reminder", "下午提醒：补充参考来源", { provider: "dida365", libraryId: "dida", libraryName: "滴答清单", collectionName: "工作清单", dueAt: shiftJournalDay(today, 3), reminderAt: [dateAt(today, "16:00")] }),
  makeTask("done-yesterday", "昨天到期、今天完成的任务", { provider: "dida365", dueAt: shiftJournalDay(today, -1), completed: true, status: "completed", completedAt: dateAt(today, "10:30"), completedTimeSource: "source" }),
  makeTask("done-hub", "整理资料", { completed: true, status: "completed", dueAt: tomorrow, completedAt: dateAt(today, "09:10"), completedTimeSource: "hub", completionHistory: [{ at: dateAt(today, "09:10"), source: "hub", reopened: false }] }),
  makeTask("created-future", "下周评审准备", { provider: "dida365", libraryId: "dida", libraryName: "滴答清单", collectionName: "工作清单", dueAt: shiftJournalDay(today, 7), createdAt: dateAt(today, "12:20"), createdTimeSource: "source" }),
  makeTask("created-unscheduled", "新想法待整理", { provider: "obsidian", dueAt: undefined, createdAt: today, createdTimeSource: "source" }),
  makeTask("tomorrow", "整理明天的评审记录", { dueAt: tomorrow }),
  makeTask("old-done-unknown", "历史完成时间未知", { completed: true, status: "completed", modifiedAt: Date.now() }),
];
let taskReads = 0;
const transport = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args: any) => Promise<unknown>; transformCallback: (callback: unknown) => number; unregisterCallback: (id: number) => void } };
(window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => void } }).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
transport.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback: () => {}, invoke: async (command, args) => {
  if (command === "journal_page") {
    const o = args.options;
    const scoped = entries.filter(e => (args.spaceIds === null || args.spaceIds.includes(e.libraryId)) && (!o.from || e.journalDate! >= o.from) && (!o.to || e.journalDate! <= o.to) && (!o.query || (e.snippet + " " + e.libraryName).toLowerCase().includes(o.query.toLowerCase()))).sort((a, b) => o.ascending ? a.journalDate!.localeCompare(b.journalDate!) : b.journalDate!.localeCompare(a.journalDate!));
    return { items: scoped.slice(o.offset, o.offset + o.limit), total: scoped.length, days: new Set(scoped.map(e => e.journalDate)).size, libraries: new Set(scoped.map(e => e.libraryId)).size, revision: "daily-fixture-v1" };
  }
  if (command === "list_unified_tasks") {
    taskReads++;
    return { tasks, total: tasks.length, open: tasks.filter(task => task.status === "open").length, completed: tasks.filter(task => task.status === "completed").length, craft: tasks.filter(task => task.provider === "craft").length, dida365: tasks.filter(task => task.provider === "dida365").length, obsidian: tasks.filter(task => task.provider === "obsidian").length, linked: 0, syncEnabled: false, backgroundSyncIntervalMinutes: 15, lastSyncFailed: 0, syncReviews: [] };
  }
  if (command === "set_unified_task_status") {
    const task = tasks.find(task => task.id === args.taskId)!;
    if (task.status !== args.expectedStatus) throw new Error("来源任务已经改变");
    const at = new Date().toISOString();
    const completed = args.status === "completed";
    const history = [...(task.completionHistory || [])].map(event => completed ? event : { ...event, reopened: true });
    if (completed) history.push({ at, source: "hub", reopened: false });
    const saved = { ...task, status: args.status, completed, completedAt: completed ? at : undefined, completedTimeSource: completed ? "hub" : undefined, completionHistory: history } as UnifiedTask;
    tasks = tasks.map(item => item.id === saved.id ? saved : item); return saved;
  }
  if (command === "resolve_unified_task_search_result") return { resultId: `task:Private:${args.sourceId}`, documentId: args.documentId, blockId: args.sourceId, matchField: "task" };
  if (command === "plugin:event|listen") return 1;
  if (command === "plugin:event|unlisten") return undefined;
  if (command === "local_document") return "# 任务清单\n\n正式客户端会显示任务所在文档的完整正文。";
  throw new Error(command);
} };
function QAContent() {
  const store = useJournalViewStore(), [selectedDate, setSelectedDate] = useState(""), [preview, setPreview] = useState<SearchResult | null>(null), [createDate, setCreateDate] = useState(""), [panel, setPanel] = useState<"journals" | "tasks">("journals");
  const taskData = useUnifiedTasks({enabled:false});
  return <JournalViewsContext.Provider value={store}><div className="journal-daily-qa"><style>{`.journal-daily-qa{display:grid;grid-template-columns:216px minmax(0,1fr);height:100dvh;background:var(--hub-content-surface,#fff);font-family:Segoe UI,Microsoft YaHei,sans-serif}.journal-daily-qa>aside{overflow:auto;padding:20px 12px;border-right:1px solid #e5e7eb;background:var(--hub-sidebar-surface,#f7f8fa)}.journal-daily-qa>main{display:flex;min-width:0;min-height:0;overflow:hidden}.journal-daily-qa .qa-preview{width:32%;min-width:240px;flex-shrink:0;overflow:auto;border-left:1px solid #e5e7eb;padding:24px}.journal-daily-qa h2{font-size:20px}.journal-daily-qa .qa-preview button{float:right}.journal-daily-qa aside>small{display:block;margin:18px 8px;color:#626b77}@media(max-width:700px){.journal-daily-qa{grid-template-columns:160px minmax(0,1fr)}.journal-daily-qa .qa-preview{position:absolute;inset:0 0 0 160px;width:auto;background:#fff;z-index:30}}@media(max-width:500px){.journal-daily-qa{display:flex}.journal-daily-qa>aside{display:none}.journal-daily-qa>main{flex:1}.journal-daily-qa .qa-preview{left:0}}`}</style><aside><h2>Hub</h2><nav className="journal-navigation"><button onClick={()=>setPanel("journals")}>日志</button><button onClick={()=>setPanel("tasks")}>任务 · {taskData.dashboard.open}</button></nav><JournalNavigation dates={[{ date: today, sources: 1 }, { date: tomorrow, sources: 1 }]} selectedDate={selectedDate} onSelectDate={setSelectedDate}/><small>示例数据 · 实际界面组件</small></aside><main>{panel==="tasks"?<TaskWorkspace desktopSidebarVisible onOpenResult={setPreview}/>:<JournalWorkspace libraries={libraries} scope={null} dataVersion="daily-fixture-v1" selectedDate={selectedDate} selectedKey={preview?.entityKey} onNavigateDate={setSelectedDate} onPreview={setPreview} onOpen={setPreview} onCreate={setCreateDate} renderIcon={result => <span className="library-icon">{result.libraryName[0]}</span>}/>}<output data-testid="shared-task-loads" hidden>{taskReads}</output>{(preview || createDate) && <aside className="qa-preview"><button aria-label="关闭预览" onClick={() => { setPreview(null); setCreateDate(""); }}><X size={18}/></button><small>{preview?.journalDate || createDate}</small><h2>{preview?.title || "新建日志"}</h2><p>{preview?.snippet || "正式客户端会打开资料库选择与创建窗口。"}</p></aside>}</main></div></JournalViewsContext.Provider>;
}
function QA(){return <UnifiedTaskProvider dataVersion="qa-session"><QAContent/></UnifiedTaskProvider>;}
const root = createRoot(document.getElementById("root")!); root.render(<QA/>); if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
