import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useJournalDailyData, type JournalDailyTaskEntry } from "./JournalDailyData";
import { journalMonthDays, shiftJournalDay, type JournalViewStore } from "./JournalViews";
import { journalDateKey, journalDateLabel } from "./SearchWorkspacePresentation";
import type { SearchResult } from "./SearchTypes";
import { resolveTaskResult } from "./TaskWorkspaceResult";
import { TaskStatusControl } from "./TaskStatusControl";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import { useJournalPage } from "./useJournalPage";
import { JournalRecordCard } from "./JournalRecordCard";
import { QuickJournalCard } from "./QuickJournal";
import { journalDocumentKey,journalRecordMatches,journalIndexInView,useJournalRecords } from "./JournalRecords";
import { journalDateInRange,journalResultDates,journalUsesResultDays } from "./JournalFilter";
import { useUnifiedTasks } from "./UnifiedTaskData";
import { journalTaskTimestampDate } from "./JournalDailyData";
import "./JournalDaily.css";

/** Continuous civil dates include empty days and safely cross month/DST boundaries. */
export function journalDailyDates(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let day = from; day && day < to && dates.length < 366; day = shiftJournalDay(day, 1)) dates.push(day);
  return dates;
}

function completedTimeLabel(at: string | undefined) {
  if (!at || /^\d{4}-\d{2}-\d{2}$/.test(at)) return "当天完成";
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? `完成于 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date)}` : "当天完成";
}

type Props = {
  store: JournalViewStore; today: string; scope: string[] | null; dataVersion: string;
  selectedKey: string; canCreate: boolean;
  onChoose: (date: string) => void; onPreview: (result: SearchResult) => void;
  onCreate?: (date: string) => void;
  onOpen?: (entry:SearchResult)=>void;
  onTaskCount?:(count:number)=>void;
};

export function JournalDailyStream({ store, today, scope, dataVersion, selectedKey, canCreate, onChoose, onPreview, onCreate, onOpen, onTaskCount }: Props) {
  const { view } = store;
  const records=useJournalRecords();
  const sharedTasks=useUnifiedTasks();
  const resultMode=journalUsesResultDays(view);
  const [resultLimit,setResultLimit]=useState(35);
  useEffect(()=>setResultLimit(35),[view.query,view.period,view.day,view.month,view.recordFilter,JSON.stringify(view.libraries),JSON.stringify(scope)]);
  const quick=records.items.filter(item=>{const meta={id:item.record.id,date:item.record.date,libraryId:item.libraryId,hasAttachments:item.record.attachments.length>0,hasTags:/(?:^|\s)#[^\s#]+/u.test(item.body)};return journalIndexInView(meta,view,scope)&&journalRecordMatches(meta,view.recordFilter||"all",records.pins)&&`${item.body} ${item.record.attachments.map(a=>a.name).join(" ")}`.toLowerCase().includes(view.query.trim().toLowerCase());});
  const singleDay = view.period === "day";
  const requested = singleDay ? view.day : (store.anchor.startsWith(view.month+"-") ? store.anchor : "") || (view.month === today.slice(0, 7) ? today : `${view.month}-01`);
  const context = `${view.month}:${view.period}:${view.day}:${store.activeId}`;
  const [window, setWindow] = useState({ context, anchor: store.anchor, from: requested, to: shiftJournalDay(requested, singleDay ? 1 : 7) });
  const reset = window.context !== context || (window.anchor !== store.anchor && !!store.anchor && (store.anchor < window.from || store.anchor >= window.to));
  const monthDays=journalMonthDays(view.month);
  const pendingRange = reset ? { context, anchor: store.anchor, from: requested, to: shiftJournalDay(requested, singleDay ? 1 : 7) } : { ...window, anchor: store.anchor };
  const range=view.period==="month"?{...pendingRange,from:pendingRange.from<monthDays[0]?monthDays[0]:pendingRange.from,to:pendingRange.to>shiftJournalDay(monthDays[monthDays.length-1],1)?shiftJournalDay(monthDays[monthDays.length-1],1):pendingRange.to}:pendingRange;
  useEffect(() => {
    if (window.context !== range.context || window.anchor !== range.anchor || window.from !== range.from) setWindow(range);
  }, [range.context, range.anchor, range.from, range.to]);
  const toInclusive = shiftJournalDay(range.to, -1);
  const page = useJournalPage(view, scope, dataVersion, true, resultMode?undefined:{ from: range.from, to: toInclusive });
  const selectedScope = scope === null ? view.libraries : view.libraries === null ? scope : scope.filter(id => view.libraries!.includes(id));
  const taskRange=useMemo(()=>{
    if(!resultMode)return {from:range.from,to:range.to};
    if(view.period==="day")return {from:view.day,to:shiftJournalDay(view.day,1)};
    if(view.period==="month")return {from:monthDays[0],to:shiftJournalDay(monthDays[monthDays.length-1],1)};
    const dates=sharedTasks.dashboard.tasks.flatMap(task=>[
      ...[task.scheduledAt,task.startAt,task.dueAt].map(at=>journalTaskTimestampDate(at,task.isAllDay,task.timeZone)),
      ...[task.createdAt,task.completedAt,...(task.reminderAt||[]),...(task.completionHistory||[]).map(event=>event.at)].map(at=>journalTaskTimestampDate(at)),
    ]).filter(Boolean).sort();
    return {from:dates[0]||today,to:shiftJournalDay(dates[dates.length-1]||today,1)};
  },[resultMode,view.period,view.day,view.month,range.from,range.to,sharedTasks.dashboard.tasks,today]);
  const daily = useJournalDailyData({ ...taskRange, scope: (view.recordFilter||"all")==="all"?selectedScope:[], query: view.query, enabled: true, dataVersion });
  // A continuous calendar advances from its anchor toward the future. Saved
  // list/table sort preferences must not put upcoming days above today.
  const grouped = useMemo(() => {
    const groups = new Map<string, SearchResult[]>();
    for (const entry of page.items) {
      const meta=records.index.find(item=>item.id===journalDocumentKey(entry.libraryId,entry.documentId));
      if(meta?.representedByQuick||meta?.matchesQuery===false)continue;
      if(view.recordFilter&&view.recordFilter!=="all"&&(!meta||!journalRecordMatches(meta,view.recordFilter,records.pins)))continue;
      const date = journalDateKey(entry);
      if (resultMode ? journalDateInRange(date,view) : date >= range.from && date < range.to) groups.set(date, [...(groups.get(date) || []), entry]);
    }
    return groups;
  }, [page.items, range.from, range.to,view.recordFilter,view.period,view.day,view.month,resultMode,records.index,records.pins]);
  const [previewError, setPreviewError] = useState(""), [openingTask, setOpeningTask] = useState("");
  const [completedDate, setCompletedDate] = useState("");
  const completedDialog = useRef<HTMLDialogElement>(null), completedTrigger = useRef<HTMLButtonElement | null>(null);
  const completedTitle = useId();
  const closeCompleted = () => {
    openGeneration.current++;
    previewPending.current = "";
    setOpeningTask("");
    if (completedDialog.current?.open) completedDialog.current.close();
    setCompletedDate("");
    completedTrigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!completedDate) return;
    const dialog = completedDialog.current;
    dialog?.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [completedDate]);
  const openGeneration = useRef(0);
  const previewPending = useRef("");
  useEffect(() => () => { openGeneration.current++; }, []);
  useEffect(() => { openGeneration.current++; previewPending.current = ""; setOpeningTask(""); setPreviewError(""); setCompletedDate(""); }, [range.from, range.to, view.query, JSON.stringify(selectedScope)]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const previewTask = async (task: UnifiedTask) => {
    if (previewPending.current === task.id) return;
    void daily.refreshSources?.([task.id]);
    previewPending.current = task.id;
    const current = ++openGeneration.current;
    setOpeningTask(task.id); setPreviewError("");
    try { const result = await resolveTaskResult(task); if (openGeneration.current === current) { if (completedDate) closeCompleted(); onPreview(result); } }
    catch (error) { if (openGeneration.current === current) setPreviewError(`任务打开失败：${String(error)}`); }
    finally { if (openGeneration.current === current) { previewPending.current = ""; setOpeningTask(""); } }
  };
  const completeTask = async (task: UnifiedTask, completed: boolean) => {
    const control = document.activeElement instanceof HTMLElement && document.activeElement.matches(".task-status-control") ? document.activeElement : undefined;
    const day = control?.closest<HTMLElement>(".journal-daily-day");
    const saved = await daily.setTaskCompleted(task, completed);
    if (!saved || !control || !mounted.current) return;
    requestAnimationFrame(() => {
      if (!mounted.current || (document.activeElement !== control && !(document.activeElement === document.body && !control.isConnected))) return;
      if (completed) day?.querySelector<HTMLElement>(".journal-daily-completed-trigger")?.focus();
      else [...(day?.querySelectorAll<HTMLElement>("[data-task-id]") || [])].find(row => row.dataset.taskId === task.id)?.querySelector<HTMLButtonElement>(".task-status-control")?.focus();
    });
  };
  const taskRow = (entry: JournalDailyTaskEntry, bucket: "scheduled" | "completed" | "created", date = "") => {
    const { task } = entry;
    const busy = daily.taskBusyIds.has(task.id);
    const collection = task.collectionName || task.libraryName;
    const context = entry.reasons.join(" · ");
    return <div key={task.id} data-task-id={task.id} className={`journal-daily-task ${task.completed ? "is-completed" : ""}`}>
      <TaskStatusControl task={task} busy={busy} pendingStatus={daily.taskStatusTargets?.get(task.id)} onChange={(task, completed) => void completeTask(task, completed)} />
      <button onClick={() => void previewTask(task)} aria-busy={openingTask === task.id} title={`${task.libraryName}${context ? ` · ${context}` : ""}${bucket === "completed" ? ` · ${completedTimeLabel(entry.completedAt)}` : ""}`} aria-label={`查看任务：${task.title} · ${collection}${context ? ` · ${context}` : ""}`}>
        {bucket === "completed" && <span className="journal-completed-date">{Number(date.slice(5, 7))}月{Number(date.slice(8))}日</span>}
        <span className="task-title">{task.title}</span>{bucket !== "completed" && <span className="task-library">{collection}</span>}
        {bucket === "completed" && <span className="journal-daily-task-history">{completedTimeLabel(entry.completedAt)}{entry.completedSource === "hub" ? " · Hub 记录" : ""}{task.syncState === "conflict" ? " · 状态待核对" : task.status === "abandoned" ? " · 后来已放弃" : entry.reopened ? " · 完成后重开" : ""}</span>}
      </button>
      {task.statusMutation?.state === "failed" && <button type="button" className="journal-task-retry" title={task.statusMutation.error}
        aria-label={`重试状态同步：${task.title}`} disabled={busy}
        onClick={() => void daily.setTaskCompleted(task, task.statusMutation?.targetStatus === "completed")}>重试同步</button>}
    </div>;
  };
  const matchingDates=journalResultDates([...grouped.keys(),...quick.map(item=>item.record.date),...daily.tasksByDate.keys()],view);
  const dates=resultMode?matchingDates.slice(0,resultLimit):journalDailyDates(range.from,range.to);
  const taskCount=new Set([...daily.tasksByDate.values()].flatMap(groups=>[...groups.scheduled,...groups.created,...groups.completed].map(entry=>entry.task.id))).size;
  useEffect(()=>{onTaskCount?.(daily.tasksLoading||daily.tasksError?0:taskCount);},[taskCount,daily.tasksLoading,daily.tasksError,onTaskCount]);
  const canExtend = dates.length < 359;
  const completedTasks = daily.tasksByDate.get(completedDate)?.completed || [];
  useEffect(() => {
    if (completedDate && !daily.tasksLoading && !completedTasks.length) closeCompleted();
  }, [completedDate, completedTasks.length, daily.tasksLoading]);
  return <div className="journal-daily-stream" aria-busy={page.loading || daily.tasksLoading}>
    {!resultMode&&!singleDay && <button className="journal-daily-previous" disabled={!canExtend||(view.period==="month"&&range.from<=monthDays[0])} onClick={() => setWindow({ ...range, from: shiftJournalDay(range.from, -7) })}><ArrowUp size={15}/>显示前几天</button>}
    <p className="journal-daily-status journal-daily-loading" role="status">{page.loading || daily.tasksLoading ? "正在读取当天记录…" : ""}</p>
    {page.error && <p className="journal-daily-status" role="alert">日志读取失败：{page.error} <button onClick={page.retry}>重试日志</button></p>}
    {daily.tasksError && <div className="journal-daily-status" role="alert"><p>任务读取或保存失败：{daily.tasksError}</p><button onClick={daily.retry}>重新读取任务</button></div>}
    {previewError && <p className="journal-daily-status" role="alert">{previewError}</p>}
    {dates.map(date => {
      const weekday = "日一二三四五六"[new Date(`${date}T12:00:00`).getDay()];
      const relative = date === today ? "今天" : date === shiftJournalDay(today, 1) ? "明天" : date === shiftJournalDay(today, -1) ? "昨天" : "";
      const entries = grouped.get(date) || [], tasks = daily.tasksByDate.get(date) || { scheduled: [], completed: [], created: [] };
      const hasTasks = tasks.scheduled.length + tasks.completed.length + tasks.created.length > 0;
      return <section key={date} className={`journal-daily-day ${date === today ? "is-today" : ""}`} data-journal-day={date} aria-label={journalDateLabel(date)}>
        <button className="journal-daily-date" aria-label={`选择 ${journalDateLabel(date)}`} aria-pressed={store.anchor === date} onClick={() => onChoose(date)}><span className="date-title">{Number(date.slice(5, 7))}月{Number(date.slice(8))}日</span>{relative && <span className="relative-day">{relative}</span>}<span className="weekday">星期{weekday}</span></button>
        <div className="journal-daily-content">
          {(entries.length>0||quick.some(item=>item.record.date===date))&&<div className="journal-daily-records memo-embedded" aria-label="当天日志">{entries.map(entry=><JournalRecordCard key={entry.entityKey} entry={entry} summary={view.summary} source={view.source} onPreview={onPreview} onOpen={onOpen} selected={entry.entityKey===selectedKey} disabled={page.loading}/>)}{quick.filter(item=>item.record.date===date).map(item=><QuickJournalCard key={item.record.id} item={item} mobile={false} onPreview={onPreview} onTag={tag=>store.update({query:"#"+tag})}/>)}</div>}
          {hasTasks && <div className="journal-daily-tasks" aria-label="当天任务">
            {tasks.scheduled.map(entry => taskRow(entry, "scheduled"))}
            {!!tasks.created.length && <details className="journal-daily-created" open><summary><b>{tasks.created.length}</b>当天新建</summary>{tasks.created.map(entry => taskRow(entry, "created"))}</details>}
            {tasks.completed.length > 0 && <button type="button" className="journal-daily-completed-trigger" aria-haspopup="dialog" aria-expanded={completedDate === date} aria-label={`${tasks.completed.length} 已完成的任务 · ${journalDateLabel(date)}`} onClick={event => { completedTrigger.current = event.currentTarget; setCompletedDate(date); }}><b>{tasks.completed.length}</b><span>已完成的任务</span></button>}
          </div>}
          {canCreate && onCreate && <div className="journal-daily-actions"><button className="journal-daily-add" onClick={() => onCreate(date)}><Plus size={13}/>新建</button></div>}
        </div>
      </section>;
    })}
    {!resultMode&&!singleDay && <button className="journal-daily-next" disabled={!canExtend||(view.period==="month"&&toInclusive>=monthDays[monthDays.length-1])} onClick={() => setWindow({ ...range, to: shiftJournalDay(range.to, 7) })}><ArrowDown size={15}/>显示后几天</button>}
    {resultMode&&!dates.length&&!page.loading&&!records.loading&&!daily.tasksLoading&&!page.error&&!records.error&&!daily.tasksError&&<div className="journal-search-empty"><h2>没有符合筛选的记录</h2><p>可以调整日期、资料库或内容类型。</p><button onClick={()=>store.update({query:"",period:"all",day:"",libraries:null,recordFilter:"all"})}>清除搜索和筛选</button></div>}
    {resultMode&&dates.length<matchingDates.length&&<button className="journal-daily-next" onClick={()=>setResultLimit(n=>n+35)}>继续显示（{dates.length} / {matchingDates.length} 天）</button>}
    {completedDate && createPortal(<dialog ref={completedDialog} className="journal-completed-dialog" aria-labelledby={completedTitle} onCancel={event => { event.preventDefault(); closeCompleted(); }} onClose={() => setCompletedDate("")} onClick={event => { if (event.target !== event.currentTarget) return; const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeCompleted(); }}>
      <span className="journal-completed-handle" aria-hidden="true" />
      <header><h2 id={completedTitle}>日志 · 星期{"日一二三四五六"[new Date(`${completedDate}T12:00:00`).getDay()]}</h2><button type="button" autoFocus aria-label="关闭已完成任务" onClick={closeCompleted}><X size={15} /></button></header>
      <div className="journal-completed-list">{completedTasks.length ? completedTasks.map(entry => taskRow(entry, "completed", completedDate)) : <p className="journal-completed-empty">这一天暂无完成记录</p>}</div>
      {previewError && <p role="alert">{previewError}</p>}
    </dialog>, document.body)}
  </div>;
}
