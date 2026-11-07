import { useEffect, useState } from "react";
import { TaskStatusStyleProvider } from "../src/TaskCompletionIcon";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../src/AppSettings";
import { useAppSettings } from "../src/useAppSettings";
import { DisplaySettingsSection } from "../src/DisplaySettingsSection";
import { RecentResultList } from "../src/RecentResultList";
import { createRoot } from "react-dom/client";
import { JournalDailyStream } from "../src/JournalDailyStream";
import { defaultJournalView, type JournalViewStore } from "../src/JournalViews";
import { UnifiedTaskProvider } from "../src/UnifiedTaskData";
import { SharedTaskPreviewStatus } from "../src/SharedTaskPreviewStatus";
import { taskSearchResult } from "../src/TaskWorkspaceResult";
import type { UnifiedTask } from "../src/TaskWorkspacePresentation";
import "../src/App.css";
import "../src/WorkspaceRefresh.css";
import "../src/JournalWorkspace.css";
import "../src/DisplayPreferences.css";

const today = "2026-10-14";
let task: UnifiedTask = { id: "qa-status", provider: "dida365", libraryId: "dida", libraryName: "滴答清单", sourceId: "qa-status", documentId: "qa-status", documentTitle: "收件箱", collectionName: "收件箱", title: "核对端子数模和接口方案", completed: false, status: "open", dueAt: today, isAllDay: true, parentTaskId: "", parentPageId: "", path: "", depth: 0, isProject: false, linkedProviders: [], syncState: "unlinked" };
const result = taskSearchResult(task), noop = () => {};
const store: JournalViewStore = { view: { ...defaultJournalView(), month: "2026-10" }, saved: [], activeId: "", anchor: today, active: undefined, modified: false, update: noop, navigate: noop, select: noop, reset: noop, save: noop, updateSaved: noop, rename: noop, hide: noop, remove: noop, move: noop };
let finish: (() => void) | undefined, signal = noop;
let settings: AppSettings = { ...DEFAULT_APP_SETTINGS };
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: noop }, __TAURI_INTERNALS__: {
  transformCallback: () => 1, unregisterCallback: noop,
  invoke: async (command: string, args: any) => {
    if (command === "get_settings") return settings;
    if (command === "update_settings") { settings = { ...settings, ...args }; return settings; }
    if (command === "journal_page") return { items: [], total: 0, days: 0, libraries: 0, revision: "qa" };
    if (command === "list_unified_tasks") return { tasks: [task], syncReviews: [] };
    if (command === "refresh_unified_task_sources" || command === "plugin:event|unlisten") return;
    if (command === "plugin:event|listen") return 1;
    if (command === "resolve_unified_task_search_result") return { resultId: task.id, documentId: task.documentId, blockId: task.sourceId, matchField: "task" };
    if (command === "set_unified_task_status") return new Promise(resolve => {
      finish = () => {
        const completed = args.status === "completed", at = new Date().toISOString();
        task = { ...task, status: args.status, completed, completedAt: completed ? at : undefined,
          completedTimeSource: completed ? "hub" : undefined,
          completionHistory: completed ? [...(task.completionHistory || []), { at, source: "hub", reopened: false }]
            : (task.completionHistory || []).map(event => ({ ...event, reopened: true })),
          statusMutation: { operationId: 1, state: "confirmed", targetStatus: args.status } };
        finish = undefined; signal(); resolve(task);
      };
      signal();
    });
    throw new Error(command);
  },
} });
function QA() {
  const [, setTick] = useState(0);
  const { appSettings, loadAppSettings, saveSettings } = useAppSettings(noop);
  useEffect(() => { void loadAppSettings(); }, [loadAppSettings]);
  signal = () => setTick(value => value + 1);
  return <TaskStatusStyleProvider style={appSettings.taskStatusStyle}><UnifiedTaskProvider><div style={{height:"100dvh",display:"flex",fontFamily:"Segoe UI,Microsoft YaHei,sans-serif",background:"#fff"}}>
    <main style={{flex:1,minWidth:0,overflow:"auto",padding:24}}><h2>首页搜索</h2>
      <RecentResultList recentGroups={[{key:"today",label:"",entries:[{result:{...result,title:"资料库显示优化",taskStatus:2},index:0}]}]} selectedIndex={0} isMobileLayout={false} semanticRecentDates={false} onHoverResult={noop} onSelectResult={noop} onOpenResult={noop} onContextResult={noop} onPrepareResultLink={noop} onDragResult={noop} renderLibraryIcon={() => null}/>
      <h2>日历</h2><JournalDailyStream store={store} today={today} scope={null} dataVersion="qa" selectedKey={result.entityKey!} canCreate={false} onChoose={noop} onPreview={noop}/></main>
    <aside data-sidebar style={{width:430,padding:28,borderLeft:"1px solid #e8ebef",overflow:"auto"}}><small>滴答清单 / 收件箱</small><div style={{display:"flex",alignItems:"center",gap:8,marginTop:20,fontSize:18}}><SharedTaskPreviewStatus result={result}/><span>收件箱</span></div><h2 style={{marginTop:32,fontSize:20}}>{task.title}</h2><button disabled={!finish} onClick={() => finish?.()}>完成模拟同步</button>
      <h2>显示设置</h2><DisplaySettingsSection mobile appSettings={appSettings} saveSettings={saveSettings} changeRecentGroupingSetting={noop} desktopSidebarEnabled changeDesktopSidebarSetting={noop}/>
    </aside>
  </div></UnifiedTaskProvider></TaskStatusStyleProvider>;
}
const root = createRoot(document.getElementById("root")!); root.render(<QA/>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
