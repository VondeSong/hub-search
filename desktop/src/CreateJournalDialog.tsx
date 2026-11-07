import { Check, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useModalFocus } from "./useModalFocus";
import { LibraryIcon } from "./LibraryIcon";
import type { LibrarySummary } from "./SearchTypes";

export function CreateJournalDialog({
  date,
  spaces,
  creating,
  onClose,
  onCreate,
}: {
  date: string;
  spaces: LibrarySummary[];
  creating: boolean;
  onClose: () => void;
  onCreate: (libraryIds: string[]) => void;
}) {
  const supported = useMemo(
    () => spaces.filter((space) => space.connected && (space.provider === "craft" || space.provider === "obsidian")),
    [spaces],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const modalRef = useRef<HTMLElement>(null);
  useModalFocus({ active: true, containerRef: modalRef, onDismiss: () => { if (!creating) onClose(); } });

  useEffect(() => {
    setSelected(supported.map((space) => space.id));
  }, [date, supported]);

  const toggle = (id: string) => {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  return <div className="create-journal-overlay" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !creating) onClose();
  }}>
    <section ref={modalRef} tabIndex={-1} className="create-journal-dialog" role="dialog" aria-modal="true" aria-labelledby="create-journal-title">
      <header>
        <span className="create-journal-mark"><Plus size={18} /></span>
        <span><h2 id="create-journal-title">新建日志</h2><small>{date}</small></span>
        <button onClick={onClose} disabled={creating} aria-label="关闭"><X size={17} /></button>
      </header>
      <p>选择要在哪些资料库中创建这一天的日志。</p>
      <div className="create-journal-libraries">
        {supported.map((space) => {
          const active = selected.includes(space.id);
          return <button key={space.id} className={active ? "active" : ""} onClick={() => toggle(space.id)} disabled={creating}>
            <LibraryIcon provider={space.provider} name={space.name} iconSvg={space.iconSvg} defaultIconUrl={space.defaultIconUrl} compact />
            <span className="create-journal-library-copy"><strong>{space.name}</strong><small>{space.provider === "craft" ? "Craft" : "Obsidian · Journals"}</small></span>
            <i>{active && <Check size={14} />}</i>
          </button>;
        })}
        {!supported.length && <div className="create-journal-empty">没有已连接且支持新建日志的资料库</div>}
      </div>
      <footer>
        <button onClick={onClose} disabled={creating}>取消</button>
        <button className="primary" onClick={() => onCreate(selected)} disabled={creating || !selected.length}>
          {creating ? "正在创建…" : `创建到 ${selected.length} 个资料库`}
        </button>
      </footer>
    </section>
  </div>;
}
