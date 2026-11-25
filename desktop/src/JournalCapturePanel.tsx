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
  desktop?: boolean;
  topDay?: string;
  children?: (inlineEditor: ReactNode, topEditor?: ReactNode) => ReactNode;
};

export function JournalCapturePanel({ libraries, day, placement = "floating", onDay, dataVersion, scope, view, children, desktop, topDay }: CapturePanelProps) {
  const [days, setDays] = useState(readDays);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const panel = useRef<HTMLElement>(null);
  const activeDay = useRef(day);
  const currentDays = useRef(days);
  activeDay.current = day;
  currentDays.current = days;
  const floating = placement === "floating";

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

  const renderEditor = (date: string, location: NonNullable<CapturePanelProps["placement"]>) => date && <section ref={location==="floating"?panel:undefined} className={location==="floating" ? "journal-floating-editor" : `journal-inline-editor journal-inline-editor-${location}`}
    data-hub-keyboard-scope="journal-capture" aria-label={location==="day" ? `补记至 ${date}` : "新建日志"}
    onBlur={event => {
      if (location==="floating" && event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) onDay("");
    }}
    onKeyDown={event => {
      if (location !== "top" && event.key === "Escape" && !event.nativeEvent.isComposing && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        onDay("");
      }
    }}>
    {location==="floating" && <header><div><h2>新建日志</h2><time>{date}</time></div><button type="button" aria-label="收起日志草稿" onClick={() => onDay("")}><X size={18} /></button></header>}
    {location==="day" && <header>补记至 <time dateTime={date}>{date}</time></header>}
    <QuickJournal key={date} mode="calendar" captureDate={date} libraries={libraries} scope={scope} view={view} dataVersion={dataVersion}
      desktopComposer={desktop && location === "top"}
      inlineCapture={location==="floating" ? undefined : location}
      onCancelCapture={location==="day" ? () => onDay("") : undefined}
      onDraftEdited={() => { if (!currentDays.current.includes(date)) remember([...currentDays.current, date]); }}
      onSaved={saved => {
        setNotice(saved.notice + ((view.query || view.libraries !== null || (view.recordFilter && view.recordFilter !== "all")) ? " 当前有筛选；若未显示，可调整筛选查看。" : ""));
        remember(currentDays.current.filter(value => value !== date));
        if (location !== "top" && activeDay.current === date) onDay("");
      }}
    />
  </section>;
  const editor = renderEditor(day, placement);

  return <>
    {error && <p role="alert">{error}</p>}
    {notice && <div className="journal-capture-notice" role="status">{notice}<button type="button" aria-label="关闭日志保存提示" onClick={() => setNotice("")}><X size={14} /></button></div>}
    {floating && editor}
    {children?.(floating || topDay && placement==="top" ? null : editor, topDay ? renderEditor(topDay, "top") : undefined)}
    <div className="journal-draft-dock" aria-label="日志草稿">{days.filter(value => value !== day && value !== topDay).map(value => <button type="button" key={value} onClick={() => onDay(value)} aria-label={`继续编辑 ${value} 的日志草稿`}><Pencil size={14} />{Number(value.slice(5, 7))}月{Number(value.slice(8))}日 · 继续编辑</button>)}</div>
  </>;
}
