import { X } from "lucide-react";
export function WorkspaceFilterSummary({ filters, onReset }: {
  filters: { label: string; clear: () => void }[]; onReset: () => void;
}) {
  if (!filters.length) return null;
  return <div className="workspace-filter-summary" aria-label="当前筛选条件"><span>已筛选</span>{filters.map(filter => <button key={filter.label} onClick={filter.clear} aria-label={`移除筛选：${filter.label}`}>{filter.label}<X size={12} /></button>)}<button onClick={onReset}>清除筛选</button></div>;
}
