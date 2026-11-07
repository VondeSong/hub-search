import { CalendarDays, ChevronLeft, ChevronRight, CircleDot } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateFromKey(value: string) {
  const [year, month, day = 1] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function shiftMonth(value: string, amount: number) {
  const date = dateFromKey(value);
  return localDateKey(new Date(date.getFullYear(), date.getMonth() + amount, 1)).slice(0, 7);
}

export function JournalNavigator({ availableDates, selectedDate, onSelectDate }: {
  availableDates: Array<{ date: string; sources: number }>;
  selectedDate: string;
  onSelectDate: (date: string) => void;
}) {
  const today = localDateKey();
  const [visibleMonth, setVisibleMonth] = useState(() => (selectedDate || today).slice(0, 7));
  const [focusedDate, setFocusedDate] = useState(selectedDate.length === 10 ? selectedDate : today);
  const calendarRef = useRef<HTMLElement>(null);
  const pendingFocus = useRef(false);
  const dates = useMemo(() => new Map(availableDates.map(item => [item.date, item.sources])), [availableDates]);

  useEffect(() => {
    if (!selectedDate) return;
    setVisibleMonth(selectedDate.slice(0, 7));
    setFocusedDate(selectedDate.length === 10 ? selectedDate : `${selectedDate}-01`);
  }, [selectedDate]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    calendarRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedDate}"]`)?.focus();
    pendingFocus.current = false;
  }, [focusedDate, visibleMonth]);

  const [year, month] = visibleMonth.split("-").map(Number);
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const cells = Array.from({ length: 42 }, (_, index) => {
    const value = new Date(year, month - 1, 1 - firstWeekday + index);
    return { date: localDateKey(value), day: value.getDate(), inMonth: value.getMonth() === month - 1 };
  });
  const tabDate = focusedDate.startsWith(visibleMonth) ? focusedDate : `${visibleMonth}-01`;
  const monthNames = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
  const monthLabel = year === new Date().getFullYear() ? monthNames[month - 1] : `${year}年 ${monthNames[month - 1]}`;

  function handleDateKey(event: KeyboardEvent<HTMLButtonElement>, dateKey: string) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const date = dateFromKey(dateKey);
    let target: Date;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    if (step !== undefined) target = new Date(date.getFullYear(), date.getMonth(), date.getDate() + step);
    else if (event.key === "Home" || event.key === "End") {
      target = new Date(date.getFullYear(), date.getMonth(), date.getDate() + (event.key === "Home" ? -date.getDay() : 6 - date.getDay()));
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      const next = dateFromKey(shiftMonth(dateKey, event.key === "PageUp" ? -1 : 1));
      target = new Date(next.getFullYear(), next.getMonth(), Math.min(date.getDate(), new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
    } else return;
    event.preventDefault();
    event.stopPropagation();
    const key = localDateKey(target);
    pendingFocus.current = true;
    setVisibleMonth(key.slice(0, 7));
    setFocusedDate(key);
  }

  return <div className="journal-navigator">
    <section ref={calendarRef} className="journal-calendar journal-calendar-compact" aria-label="日志日历">
      <header>
        <button className={`journal-month-label ${selectedDate === visibleMonth ? "selected" : ""}`}
          aria-label={`查看 ${year}年${month}月的日志`} aria-pressed={selectedDate === visibleMonth}
          title={`筛选 ${year} 年 ${month} 月的日志`} onClick={() => onSelectDate(visibleMonth)}>
          <CalendarDays size={15} aria-hidden="true" /><strong>{monthLabel}</strong>
        </button>
        <div className="journal-month-actions">
          <button onClick={() => setVisibleMonth(value => shiftMonth(value, -1))} aria-label="上个月" title="上个月"><ChevronLeft size={16} /></button>
          <button className="journal-today-button" onClick={() => { setVisibleMonth(today.slice(0, 7)); setFocusedDate(today); onSelectDate(today); }} aria-label="回到今天" title="回到今天"><CircleDot size={16} /></button>
          <button onClick={() => setVisibleMonth(value => shiftMonth(value, 1))} aria-label="下个月" title="下个月"><ChevronRight size={16} /></button>
        </div>
      </header>
      <div className="journal-date-grid" role="grid" aria-label={`${year}年${month}月`}>
        <div className="journal-week-row" role="row">{["日", "一", "二", "三", "四", "五", "六"].map(day => <span role="columnheader" key={day}>{day}</span>)}</div>
        {Array.from({ length: 6 }, (_, week) => <div className="journal-week-row" role="row" key={week}>
          {cells.slice(week * 7, week * 7 + 7).map(cell => {
            const sources = dates.get(cell.date) ?? 0;
            const selected = cell.date === selectedDate;
            return <div role="gridcell" aria-selected={selected} key={cell.date}>
              <button data-date={cell.date} tabIndex={cell.date === tabDate ? 0 : -1}
                className={`journal-date ${cell.inMonth ? "" : "outside-month"} ${cell.date === today ? "today" : ""} ${selected ? "selected" : ""} ${sources ? "has-journal" : ""}`}
                aria-current={cell.date === today ? "date" : undefined}
                aria-label={`${cell.date}${cell.date === today ? "，今天" : ""}，${sources ? `${sources} 个资料库有日志` : "没有日志"}`}
                title={`${cell.date} · ${sources ? `${sources} 个资料库有日志` : "没有日志"}`}
                onFocus={() => setFocusedDate(cell.date)} onKeyDown={event => handleDateKey(event, cell.date)}
                onClick={() => { setFocusedDate(cell.date); setVisibleMonth(cell.date.slice(0, 7)); onSelectDate(cell.date); }}>
                <span>{cell.day}</span>
              </button>
            </div>;
          })}
        </div>)}
      </div>
    </section>
  </div>;
}
