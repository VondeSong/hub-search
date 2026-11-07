import React, { createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/App.css";
import "../src/PreviewContent.css";
import "../src/DisplayPreferences.css";
import { PreviewPane } from "../src/PreviewPane";
import { RecentResultList } from "../src/RecentResultList";
import { TaskStatusStyleProvider } from "../src/TaskCompletionIcon";
import { UnifiedTaskProvider, useUnifiedTasks } from "../src/UnifiedTaskData";
import { usePreviewController } from "../src/usePreviewController";
import type { UnifiedTask } from "../src/TaskWorkspacePresentation";
import type { SearchResult } from "../src/SearchTypes";

let task: UnifiedTask = {
  id: "qa-owned-task", provider: "dida365", libraryId: "qa-library", libraryName: "滴答清单", sourceId: "qa-source",
  documentId: "qa-source", documentTitle: "收件箱", title: "资料库显示优化", status: "open", completed: false,
  parentTaskId: "", parentPageId: "", isAllDay: false, path: "收件箱", depth: 0, isProject: false,
  linkedProviders: ["dida365"], syncState: "unlinked",
};
const result: SearchResult = {
  id: "dida_task:qa-library:qa-source", entityKey: "document:qa-library:qa-source", provider: "dida365", libraryId: "qa-library",
  libraryName: "滴答清单", spaceId: "qa-library", spaceName: "滴答清单", documentId: "qa-source", blockId: "qa-source",
  contentType: "dida_task", sourceType: "dida_task", title: task.title, documentTitle: task.title, path: "收件箱",
  taskStatus: 0, snippet: "搜索任务预览可以直接切换状态。", matchTerms: [], matchField: "", matchCount: 0, subMatches: [],
};
const completedResult = { ...result, id: "qa-completed", entityKey: "document:qa-completed", documentId: "qa-completed", taskStatus: 2, title: "已完成的搜索任务" };
const calls: Array<{ command: string; status?: string }> = [];
let callbackId = 0;
Object.assign(window, {
  __TAURI_INTERNALS__: {
    transformCallback: () => ++callbackId,
    invoke: async (command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, status: typeof args.status === "string" ? args.status : undefined });
      if (command === "plugin:event|listen") return ++callbackId;
      if (command === "plugin:event|unlisten" || command === "refresh_unified_task_sources") return undefined;
      if (command === "get_window_visibility") return { revision: String(++callbackId), visible: true, minimized: false, foreground: true };
      if (command === "list_unified_tasks") return { tasks: [task], syncReviews: [], total: 1, open: task.completed ? 0 : 1, completed: task.completed ? 1 : 0 };
      if (command === "local_document") return `# ${task.title}\n\n**状态：** ${task.completed ? "已完成" : "未完成"}\n\n这是本地模拟任务，点击标题左侧图标可以改变状态。同步有三秒延迟，期间可以再次点击，以最后一次操作为准。`;
      if (command === "set_unified_task_status") {
        await new Promise(resolve => setTimeout(resolve, 3000));
        task = { ...task, status: args.status as "open" | "completed", completed: args.status === "completed",
          modifiedAt: Date.now(), statusMutation: { operationId: Date.now(), state: "confirmed", targetStatus: args.status as "open" | "completed" } };
        return task;
      }
      throw new Error(`Unexpected fixture command: ${command}`);
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
  __SEARCH_TASK_STATUS_FIXTURE__: { calls, getTask: () => task },
});
const previewCard = createRef<HTMLElement>();

function Fixture() {
  const [style, setStyle] = useState<"filled" | "outline">("filled");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const shared = useUnifiedTasks();
  const current = shared.dashboard.tasks[0];
  const preview = usePreviewController({ selected: result, results: [result], selectedIndex: 0, selectedMatchTerms: [], showPreviewPane: true, showOperationStatus: () => undefined });
  const currentResult = { ...result, taskStatus: current?.completed ? 2 : 0 };
  return <TaskStatusStyleProvider style={style}><div className="app-shell desktop-app-shell" style={{ display: "grid", gridTemplateRows: "auto 1fr", width: "100%", height: "100vh", padding: 20, background: "#f5f5f7", gap: 16 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 18 }}><strong>搜索任务预览</strong>
      <label>完成图标 <select aria-label="完成图标样式" value={style} onChange={event => setStyle(event.target.value as "filled" | "outline")}><option value="filled">实心圆勾</option><option value="outline">圆圈勾</option></select></label>
      <span style={{ color: "#6e6e73" }}>点击后同步延迟 3 秒，可连续反转</span>
      <output data-confirmed-status style={{ marginLeft: "auto" }}>已确认：{current?.status || "loading"}</output>
    </div>
    <div className="desktop-workspace" style={{ display: "grid", gridTemplateColumns: "minmax(300px, 1fr) minmax(440px, 1fr)", gap: 20, minHeight: 0 }}>
      <div style={{ background: "white", border: "1px solid #e5e5e8", borderRadius: 14, padding: 15 }}>
        <RecentResultList recentGroups={[{ key: "recent", label: "任务", entries: [{ result: currentResult, index: 0 }, { result: completedResult, index: 1 }] }]}
          selectedIndex={selectedIndex} isMobileLayout={false} semanticRecentDates={false} onHoverResult={() => undefined}
          onSelectResult={setSelectedIndex} onOpenResult={() => undefined} onContextResult={() => undefined}
          onPrepareResultLink={() => undefined} onDragResult={() => undefined}
          renderLibraryIcon={() => <img src="/icons/library/dida365.svg" width="24" height="24" alt="滴答清单"/>}/>
      </div>
      <PreviewPane selected={result} canGoBack={false} canGoForward={false} previewPinned={false} onNavigatePreviewHistory={() => undefined}
        onTogglePreviewPinned={() => undefined} selectedMatchTerms={[]} previewMatchCount={0} previewMatchIndex={0} copiedResultId=""
        spaces={[]} pdfPreview={null} ocrImagePreview={null} previewLoading={preview.previewLoading} previewMarkdown={preview.preview}
        renderedPreviewMarkdown={<div><p>搜索和任务页共用同一个状态按钮。</p><p>未同步时目标图标透明度减半；再次点击，最终状态以最后一次操作为准。</p><pre>{preview.preview}</pre></div>}
        onOpenLink={() => undefined} previewCard={previewCard} startWindowDrag={() => undefined} onCloseMobilePreview={() => undefined}
        setPdfPreviewPage={() => undefined} navigatePreviewMatch={() => undefined} copySelectedLink={() => undefined}
        openSelectedResult={() => undefined} providerName={() => "滴答清单"}/>
    </div>
  </div></TaskStatusStyleProvider>;
}
createRoot(document.getElementById("root")!).render(<UnifiedTaskProvider><Fixture/></UnifiedTaskProvider>);
