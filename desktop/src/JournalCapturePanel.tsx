import { Pencil, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { QuickJournal } from "./QuickJournal";
import { userProfileStorage } from "./UserProfileStorage";
import type { JournalViewConfig } from "./JournalViews";
import type { LibrarySummary } from "./SearchTypes";

const KEY="hub.journal.calendar-drafts.v1";
function readDays(){try{const value=JSON.parse(userProfileStorage.getItem(KEY)||"[]");return Array.isArray(value)?value.filter((day):day is string=>typeof day==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(day)):[];}catch{return [];}}
type CapturePanelProps = {
  libraries: LibrarySummary[];
  day: string;
  placement?: "top" | "day" | "floating";
  onDay: (day: string) => void;
  dataVersion: string;
  scope: string[] | null;
  view: JournalViewConfig;
  children?: (inlineEditor: ReactNode) => ReactNode;
};

export function JournalCapturePanel({ libraries, day, placement = "floating", onDay, dataVersion, scope, view, children }: CapturePanelProps) {
  const [days, setDays] = useState(readDays);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const panel = useRef<HTMLElement>(null);
  const activeDay = useRef(day);
  const currentDays = useRef(days);
  activeDay.current = day;
  currentDays.current = days;
  const floating = placement === "floating";
  const backfill = placement === "day";

  function remember(next: string[]) {
    try {
      userProfileStorage.setItem(KEY, JSON.stringify(next));
      currentDays.current = next;
      setDays(next);
    } catch (e) {
      setError(`草稿入口保存失败：${String(e)}`);
    }
  }

  useEffect(() => {
    if (!day || !floating) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && panel.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".journal-draft-dock,.journal-daily-add,.journal-toolbar-create")) return;
      onDay("");
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [day, floating, onDay]);

  const editor = day && <section ref={panel} className={floating ? "journal-floating-editor" : `journal-inline-editor journal-inline-editor-${placement}`}
    data-hub-keyboard-scope="journal-capture" aria-label={backfill ? `补记至 ${day}` : "新建日志"}
    onBlur={event => {
      if (floating && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) onDay("");
    }}
    onKeyDown={event => {
      if (placement !== "top" && event.key === "Escape" && !event.nativeEvent.isComposing && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        onDay("");
      }
    }}>
    {floating && <header><div><h2>新建日志</h2><time>{day}</time></div><button type="button" aria-label="收起日志草稿" onClick={() => onDay("")}><X size={18} /></button></header>}
    {backfill && <header>补记至 <time dateTime={day}>{day}</time></header>}
    <QuickJournal key={day} mode="calendar" captureDate={day} libraries={libraries} scope={scope} view={view} dataVersion={dataVersion}
      inlineCapture={floating ? undefined : placement}
      onCancelCapture={backfill ? () => onDay("") : undefined}
      onDraftEdited={() => { if (!currentDays.current.includes(day)) remember([...currentDays.current, day]); }}
      onSaved={saved => {
        setNotice(saved.notice + ((view.query || view.libraries !== null || (view.recordFilter && view.recordFilter !== "all")) ? " 当前有筛选；若未显示，可调整筛选查看。" : ""));
        remember(currentDays.current.filter(value => value !== day));
        if (placement !== "top" && activeDay.current === day) onDay("");
      }}
    />
  </section>;

  return <>
    {error && <p role="alert">{error}</p>}
    {notice && <div className="journal-capture-notice" role="status">{notice}<button type="button" aria-label="关闭日志保存提示" onClick={() => setNotice("")}><X size={14} /></button></div>}
    {floating && editor}
    {children?.(floating ? null : editor)}
    <div className="journal-draft-dock" aria-label="日志草稿">{days.filter(value => value !== day).map(value => <button type="button" key={value} onClick={() => onDay(value)} aria-label={`继续编辑 ${value} 的日志草稿`}><Pencil size={14} />{Number(value.slice(5, 7))}月{Number(value.slice(8))}日 · 继续编辑</button>)}</div>
  </>;
}
