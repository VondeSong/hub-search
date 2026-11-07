import { Layers3 } from "lucide-react";
import { LibraryIcon } from "./LibraryIcon";
import { providerName } from "./ProviderLabels";
import type { LibrarySummary } from "./SearchTypes";

export function TagLibraryFilter({ libraries, selectedIds, onChange }: {
  libraries: LibrarySummary[];
  selectedIds: string[] | null;
  onChange: (ids: string[] | null) => void;
}) {
  return <div className="tag-library-filter" role="group" aria-label="标签资料库筛选（可多选）">
    <button type="button" aria-label="全部资料库的标签" aria-pressed={selectedIds === null} title="显示全部资料库的标签" onClick={() => onChange(null)}><Layers3 size={16} /><span>全部</span></button>
    {libraries.map((library) => {
      const selected = selectedIds?.includes(library.id) ?? false;
      const label = `${library.name} · ${providerName(library.provider)}`;
      return <button type="button" key={library.id} aria-label={label} aria-pressed={selected} title={`${label}：${selected ? "点击取消" : "点击选择"}，可组合多个资料库`} onClick={() => {
        const current = selectedIds?.filter((id) => libraries.some((item) => item.id === id)) ?? [];
        const next = selected ? current.filter((id) => id !== library.id) : [...current, library.id];
        onChange(next.length ? next : null);
      }}>
        <LibraryIcon provider={library.provider} name={library.name} iconSvg={library.iconSvg} defaultIconUrl={library.defaultIconUrl} compact />
      </button>;
    })}
  </div>;
}
