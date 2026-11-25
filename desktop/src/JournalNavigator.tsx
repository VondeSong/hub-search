import {calendarDateKey,calendarPeriodKey} from "./JournalCalendarPeriod";
import {journalHeatLevel} from "./JournalRecords";
import {useJournalDailyData} from "./JournalDailyData";
import { CalendarDays, ChevronLeft, ChevronRight, CircleDot, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

function localDateKey(date = new Date()) {
  return calendarDateKey(date);
}

function dateFromKey(value: string) {
  const [year, month, day = 1] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function shiftMonth(value: string, amount: number) {
  const date = dateFromKey(value);
  const target=new Date(date.getFullYear(), date.getMonth()+amount,1);
  return calendarPeriodKey(target.getFullYear(),target.getMonth()+1)||value.slice(0,7);
}

export function JournalNavigator({ availableDates, selectedDate, onSelectDate, desktop = false, taskScope = null }: {
  availableDates: Array<{ date: string; sources: number;count?:number }>;
  selectedDate: string;
  onSelectDate: (date: string) => void;
  desktop?: boolean;
  taskScope?: string[] | null;
}) {
  const today = localDateKey();
  const [visibleMonth, setVisibleMonth] = useState(() => (selectedDate || today).slice(0, 7));
  const [focusedDate, setFocusedDate] = useState(selectedDate.length === 10 ? selectedDate : today);
  const [pickerOpen,setPickerOpen]=useState(false),[pickerYear,setPickerYear]=useState(visibleMonth.slice(0,4));
  const yearInput=useRef<HTMLInputElement>(null),periodTrigger=useRef<HTMLButtonElement>(null);
  const periodPopover=useRef<HTMLFormElement>(null);
  const calendarRef = useRef<HTMLElement>(null);
  const pendingFocus = useRef(false);
  useEffect(()=>{if(pickerOpen){yearInput.current?.focus({preventScroll:true});yearInput.current?.select();}},[pickerOpen]);
  const dates = useMemo(() => new Map(availableDates.map(item => [item.date, item])), [availableDates]);

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
  const taskActivity = useJournalDailyData({from: visibleMonth + "-01", to: shiftMonth(visibleMonth, 1) + "-01", scope: taskScope, query: "", enabled: desktop, dataVersion: ""});
  const recordedDays = new Set([
    ...availableDates.filter(entry => entry.date.startsWith(visibleMonth) && (entry.count ?? entry.sources) > 0).map(entry=>entry.date),
    ...taskActivity.tasksByDate.keys(),
  ]).size;
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const weeks = desktop ? Math.ceil((firstWeekday + new Date(year, month, 0).getDate()) / 7) : 6;
  const cells = Array.from({ length: weeks * 7 }, (_, index) => {
    const value = new Date(year, month - 1, 1 - firstWeekday + index);
    return { date: localDateKey(value), day: value.getDate(), inMonth: value.getMonth() === month - 1, inRange:calendarPeriodKey(value.getFullYear(),value.getMonth()+1)!==null };
  });
  const tabDate = focusedDate.startsWith(visibleMonth) ? focusedDate : `${visibleMonth}-01`;
  const monthNames = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];
  const monthLabel = `${year}年${month}月`;
  const validPickerYear=calendarPeriodKey(Number(pickerYear),month)!==null;
  function positionPicker(){const panel=periodPopover.current,trigger=periodTrigger.current;if(!panel||!trigger)return;const rect=trigger.getBoundingClientRect(),width=Math.min(Math.max(calendarRef.current?.clientWidth||240,240),360,window.innerWidth-24);panel.style.width=`${width}px`;panel.style.maxHeight=`${window.innerHeight-24}px`;panel.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-width-12))}px`;panel.style.top=`${Math.max(12,Math.min(rect.bottom+8,window.innerHeight-panel.offsetHeight-12))}px`;}
  useEffect(()=>{if(!pickerOpen)return;const closeOnScroll=(event:Event)=>{if(!periodPopover.current?.contains(event.target as Node))periodPopover.current?.hidePopover?.();};window.addEventListener("resize",positionPicker);window.addEventListener("scroll",closeOnScroll,true);return()=>{window.removeEventListener("resize",positionPicker);window.removeEventListener("scroll",closeOnScroll,true);};},[pickerOpen]);
  function closePicker(){periodPopover.current?.hidePopover?.();setPickerOpen(false);periodTrigger.current?.focus();}
  function chooseMonth(value:number){const key=calendarPeriodKey(Number(pickerYear),value);if(!key)return;setVisibleMonth(key);setFocusedDate(key+"-01");onSelectDate(key);closePicker();}
  function stepYear(by:number){const base=validPickerYear?Number(pickerYear):year;setPickerYear(String(Math.max(100,Math.min(9999,base+by))));}

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
    if(!calendarPeriodKey(target.getFullYear(),target.getMonth()+1))return;
    const key = localDateKey(target);
    pendingFocus.current = true;
    setVisibleMonth(key.slice(0, 7));
    setFocusedDate(key);
  }

  return <div className="journal-navigator">
    <section ref={calendarRef} className="journal-calendar journal-calendar-compact" aria-label="日志日历">
      <header>
        <button ref={periodTrigger} className={`journal-month-label ${!desktop && selectedDate === visibleMonth ? "selected" : ""}`}
          aria-label={`切换日历年月，当前${monthLabel}`} aria-expanded={pickerOpen}
          popoverTarget="journal-period-picker" title="快速切换年份和月份" onClick={() => {if(!pickerOpen)setPickerYear(String(year));}}>
          {!desktop&&<CalendarDays size={15} aria-hidden="true" />}<strong>{desktop ? `${year} 年 ${month} 月` : monthLabel}</strong>{!desktop&&<ChevronDown size={12} aria-hidden="true"/>}
        </button>
        <div className="journal-month-actions">
          <button onClick={() => {setPickerOpen(false);setVisibleMonth(value => shiftMonth(value, -1));}} aria-label="上个月" title="上个月"><ChevronLeft size={16} /></button>
          <button className="journal-today-button" onClick={() => { setPickerOpen(false);setVisibleMonth(today.slice(0, 7)); setFocusedDate(today); onSelectDate(desktop ? today.slice(0, 7) : today); }} aria-label="回到今天" title="回到今天"><CircleDot size={16} /></button>
          <button onClick={() => {setPickerOpen(false);setVisibleMonth(value => shiftMonth(value, 1));}} aria-label="下个月" title="下个月"><ChevronRight size={16} /></button>
        </div>
        {desktop&&<small className="journal-recorded-days">{recordedDays} 天有记</small>}
      </header>
      <form id="journal-period-picker" ref={periodPopover} popover="auto" className="journal-period-picker" aria-label="选择年份和月份" onToggle={event=>{const open=event.currentTarget.matches(":popover-open");if(open)positionPicker();setPickerOpen(open);}} onSubmit={event=>{event.preventDefault();chooseMonth(month);}} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();closePicker();}}}>
        <div className="journal-year-row"><button type="button" aria-label="上一年" disabled={Number(pickerYear)<=100} onClick={()=>stepYear(-1)}><ChevronLeft size={15}/></button><label><span>年份</span><input ref={yearInput} type="number" aria-label="日历年份" min={100} max={9999} step={1} required value={pickerYear} onChange={event=>setPickerYear(event.target.value)}/></label><button type="button" aria-label="下一年" disabled={Number(pickerYear)>=9999} onClick={()=>stepYear(1)}><ChevronRight size={15}/></button></div>
        <div className="journal-picker-months" role="group" aria-label="选择月份">{monthNames.map((label,index)=><button type="button" key={label} disabled={!validPickerYear} aria-pressed={year===Number(pickerYear)&&month===index+1} onClick={()=>chooseMonth(index+1)}>{label}</button>)}</div>
        <footer><button type="submit" disabled={!validPickerYear}>查看整月</button><button type="button" onClick={closePicker}>收起</button></footer>
      </form>
      <div className="journal-date-grid" role="grid" aria-label={`${year}年${month}月`}>
        <div className="journal-week-row" role="row">{["日", "一", "二", "三", "四", "五", "六"].map(day => <span role="columnheader" key={day}>{day}</span>)}</div>
        {Array.from({ length: weeks }, (_, week) => <div className="journal-week-row" role="row" key={week}>
          {cells.slice(week * 7, week * 7 + 7).map(cell => {
            const activity=dates.get(cell.date),sources=activity?.sources??0,count=activity?.count??sources;
            const selected = cell.date === selectedDate;
            const tasks = taskActivity.tasksByDate.get(cell.date);
            const pending = (tasks?.created.length ?? 0) + (tasks?.scheduled.length ?? 0);
            const done = tasks?.completed.length ?? 0;
            const taskLabel = pending || done ? `，${pending}项待办，${done}项已完成` : "";
            if (desktop && !cell.inMonth) return <div role="gridcell" key={cell.date} />;
            return <div role="gridcell" aria-selected={selected} key={cell.date}>
              <button data-heat={journalHeatLevel(count)} data-count={count} data-tasks={pending + done} data-date={cell.date} disabled={!cell.inRange} tabIndex={cell.inRange&&cell.date === tabDate ? 0 : -1}
                className={`journal-date ${cell.inMonth ? "" : "outside-month"} ${cell.date === today ? "today" : ""} ${selected ? "selected" : ""} ${sources ? "has-journal" : ""}`}
                aria-current={cell.date === today ? "date" : undefined}
                aria-label={`${cell.date}${cell.date === today ? "，今天" : ""}，${count}条记录${sources?`，${sources}个资料库`:""}${taskLabel}`}
                title={`${cell.date} · ${count} 条记录${desktop ? taskLabel : "（不含任务）"}${sources?` · ${sources} 个资料库`:""}`}
                onFocus={() => setFocusedDate(cell.date)} onKeyDown={event => handleDateKey(event, cell.date)}
                onClick={() => { setPickerOpen(false);setFocusedDate(cell.date); setVisibleMonth(cell.date.slice(0, 7)); onSelectDate(cell.date); }}>
                <span>{cell.day}</span>
                {desktop&&<span className="journal-date-dots" aria-hidden="true">{count>0&&<i className="notes"/>}{(pending>0||done>0)&&<i className={pending>0?"pending":"done"}/>}</span>}
              </button>
            </div>;
          })}
        </div>)}
      </div>
      {!desktop&&<div className="journal-heat-legend" aria-label="记录热力图图例：0条、1条、2条、3到4条、5条及以上"><span>记录条数</span><span>少</span>{[0,1,2,3,4].map(level=><i key={level} data-heat={level} aria-hidden="true"/>)}<span>多</span><small>0 · 1 · 2 · 3–4 · 5+ 条，不含任务</small></div>}
    </section>
  </div>;
}
