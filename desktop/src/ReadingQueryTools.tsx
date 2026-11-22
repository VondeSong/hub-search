import { ArrowDown, ArrowUp, ArrowUpDown, ListFilter, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CollectionView } from "./CollectionViews";
import type { CollectionSortRule } from "./CollectionSort";
import "./ReadingTools.css";

const dateChoices = [["any", "不限"], ["7", "近 7 天"], ["30", "近 30 天"], ["90", "近 90 天"]] as const;
const mediaChoices = [["all", "全部"], ["photo", "有图片"], ["video", "有视频"], ["links", "有外链"]] as const;
const mediaTags = { photo: "含图片", video: "含视频", links: "含外链" };
const sortChoices = [["collected", "收集时间"], ["published", "发布时间"], ["title", "标题"], ["media", "附件数量"]] as const;

function ReadingPopover({ label, width, active, icon, children }: {
  label: string;
  width: number;
  active: boolean;
  icon: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const anchor = trigger.current;
    const popup = panel.current;
    const place = () => {
      const bounds = anchor.getBoundingClientRect();
      const available = Math.min(width, Math.max(0, window.innerWidth - 24));
      popup.style.width = available + "px";
      popup.style.left = Math.max(12, Math.min(bounds.left, window.innerWidth - available - 12)) + "px";
      popup.style.top = Math.max(12, Math.min(bounds.bottom + 6, window.innerHeight - popup.offsetHeight - 12)) + "px";
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchor.contains(target) && !popup.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    place();
    (popup.querySelector<HTMLElement>('button[aria-pressed="true"]') || popup.querySelector("button"))?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open, width]);
  return <>
    <button ref={trigger} type="button" title={label} aria-label={label} aria-haspopup="dialog"
      aria-expanded={open} className={open || active ? "active" : ""} onClick={() => setOpen(!open)}>{icon}</button>
    {open && createPortal(<div ref={panel} className="reading-reference-popover" role="dialog" aria-label={label} onBlur={event => {
      if (event.relatedTarget && event.relatedTarget !== trigger.current && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>{children(close)}</div>, document.body)}
  </>;
}

type QueryProps = {
  view: CollectionView;
  onChange: (patch: Partial<CollectionView>) => void;
};

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return <div className="reading-reference-filter-group" role="group" aria-label={title}>
    <div className="reading-reference-popover-label">{title}</div>
    <div>{children}</div>
  </div>;
}

export function ReadingFilterTools({ view, tags, onChange }: QueryProps & { tags: string[] }) {
  const active = view.dateFilter !== "any" || view.media !== "all" || view.tags.length > 0;
  const availableTags = [...new Set([...tags, ...view.tags])];
  return <ReadingPopover label="筛选" width={276} active={active} icon={<ListFilter size={14}/>}>
    {close => {
      const pick = (patch: Partial<CollectionView>) => { onChange(patch); close(); };
      return <>
        <FilterGroup title="收集时间">{dateChoices.map(([value, label]) =>
          <button key={value} type="button" aria-pressed={view.dateFilter === value} onClick={() => pick({ dateFilter: value })}>{label}</button>
        )}</FilterGroup>
        <FilterGroup title="内容类型">{mediaChoices.map(([value, label]) =>
          <button key={value} type="button" aria-pressed={view.media === value} onClick={() => pick({ media: value })}>{label}</button>
        )}</FilterGroup>
        {availableTags.length > 0 && <FilterGroup title="多标签（同时满足）">{availableTags.map(tag =>
          <button key={tag} type="button" aria-pressed={view.tags.includes(tag)}
            onClick={() => pick({ tags: view.tags.includes(tag) ? view.tags.filter(value => value !== tag) : [...view.tags, tag] })}>#{tag}</button>
        )}</FilterGroup>}
      </>;
    }}
  </ReadingPopover>;
}

export function ReadingSortTools({ rule, onChange }: { rule?: CollectionSortRule; onChange: (rules: CollectionSortRule[]) => void }) {
  return <ReadingPopover label="排序" width={190} active={!!rule} icon={<ArrowUpDown size={14}/>}>
    {close => <>
      <div className="reading-reference-popover-label reading-reference-sort-label">排序方式</div>
      {sortChoices.map(([field, label]) => {
        const selected = rule?.field === field;
        return <button key={field} type="button" className="reading-reference-sort-option" aria-pressed={selected}
          aria-label={selected ? label + (rule.ascending ? "，升序" : "，降序") : label} onClick={() => {
            onChange([{ id: selected ? rule.id : "reading-" + field, field, ascending: selected && !rule.ascending }]);
            close();
          }}>{label}{selected && (rule.ascending ? <ArrowUp size={12}/> : <ArrowDown size={12}/>)}</button>;
      })}
    </>}
  </ReadingPopover>;
}

export function ReadingActiveFilters({ view, onChange, onClear, onClearQuery }: QueryProps & { onClear: () => void; onClearQuery: () => void }) {
  const filters = [
    ...(view.dateFilter !== "any" ? [{ label: "近 " + view.dateFilter + " 天", clear: () => onChange({ dateFilter: "any" }) }] : []),
    ...(view.media !== "all" ? [{ label: mediaTags[view.media], clear: () => onChange({ media: "all" }) }] : []),
    ...view.tags.map(tag => ({ label: "#" + tag, clear: () => onChange({ tags: view.tags.filter(value => value !== tag) }) })),
    ...(view.query ? [{ label: "“" + view.query + "”", clear: onClearQuery }] : []),
  ];
  if (!filters.length) return null;
  return <div className="reading-reference-filter-strip" aria-label="当前筛选条件">
    {filters.map(({ label, clear }) => <button type="button" key={label} aria-label={"移除筛选：" + label}
      onClick={clear}>{label}<X size={11}/></button>)}
    <button type="button" className="reading-reference-clear" onClick={onClear}>清除</button>
  </div>;
}
