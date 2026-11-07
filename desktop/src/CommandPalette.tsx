import {
  BookOpen,
  Check,
  ChevronRight,
  Command,
  FileText,
  Keyboard,
  LibraryBig,
  ListFilter,
  Search,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useModalFocus } from "./useModalFocus";
import {
  filterCommandItems,
  type CommandCategory,
  type CommandPaletteItem,
  type CommandPaletteMode,
  type ShortcutHelpGroup,
} from "./CommandPaletteTypes";

type CommandPaletteProps = {
  open: boolean;
  mode: CommandPaletteMode;
  commands: CommandPaletteItem[];
  shortcutGroups: ShortcutHelpGroup[];
  onModeChange: (mode: CommandPaletteMode) => void;
  onClose: () => void;
};

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  navigation: "导航",
  library: "资料库",
  search: "搜索与索引",
  result: "当前结果",
  view: "显示",
};

function CategoryIcon({ category }: { category: CommandCategory }) {
  if (category === "library") return <LibraryBig size={16} />;
  if (category === "search") return <ListFilter size={16} />;
  if (category === "result") return <FileText size={16} />;
  if (category === "view") return <BookOpen size={16} />;
  return <Command size={16} />;
}

export function CommandPalette({
  open,
  mode,
  commands,
  shortcutGroups,
  onModeChange,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  useModalFocus({ active: open, containerRef: modalRef, onDismiss: onClose });
  const visibleCommands = useMemo(() => filterCommandItems(commands, query), [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [mode, open]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(visibleCommands.length - 1, 0)));
  }, [visibleCommands.length]);

  if (!open) return null;

  const execute = (command: CommandPaletteItem) => {
    if (command.disabled) return;
    onClose();
    void command.run();
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (mode !== "commands") return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((current) => visibleCommands.length
        ? (current + direction + visibleCommands.length) % visibleCommands.length
        : 0);
      return;
    }
    if (event.key === "Enter" && visibleCommands[selectedIndex]) {
      event.preventDefault();
      execute(visibleCommands[selectedIndex]);
    }
  };

  return (
    <div className="command-palette-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={modalRef} tabIndex={-1} className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板" onKeyDown={onKeyDown}>
        <header className="command-palette-header">
          <div className="command-palette-tabs" role="tablist" aria-label="命令面板视图">
            <button className={mode === "commands" ? "active" : ""} role="tab" aria-selected={mode === "commands"} onClick={() => onModeChange("commands")}><Command size={15} />命令</button>
            <button className={mode === "shortcuts" ? "active" : ""} role="tab" aria-selected={mode === "shortcuts"} onClick={() => onModeChange("shortcuts")}><Keyboard size={15} />快捷键</button>
          </div>
          <button className="command-palette-close" onClick={onClose} aria-label="关闭命令面板"><X size={17} /></button>
        </header>

        {mode === "commands" ? <>
          <label className="command-search">
            <Search size={18} />
            <input ref={inputRef} data-modal-initial-focus value={query} onChange={(event) => { setQuery(event.target.value); setSelectedIndex(0); }} placeholder="搜索命令、资料库或操作…" aria-label="搜索命令" />
            <kbd>Esc</kbd>
          </label>
          <div className="command-list" role="listbox">
            {visibleCommands.map((command, index) => {
              const previous = visibleCommands[index - 1];
              const showCategory = !previous || previous.category !== command.category;
              return <div className="command-entry-wrap" key={command.id}>
                {showCategory && <div className="command-category">{CATEGORY_LABELS[command.category]}</div>}
                <button
                  className={`command-entry ${index === selectedIndex ? "selected" : ""}`}
                  role="option"
                  aria-selected={index === selectedIndex}
                  disabled={command.disabled}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => execute(command)}
                >
                  <span className="command-entry-icon"><CategoryIcon category={command.category} /></span>
                  <span className="command-entry-copy"><strong>{command.label}</strong><small>{command.description}</small></span>
                  {command.shortcut && <kbd>{command.shortcut}</kbd>}
                  {index === selectedIndex && !command.disabled ? <ChevronRight size={15} /> : command.disabled ? null : <span className="command-entry-spacer" />}
                </button>
              </div>;
            })}
            {visibleCommands.length === 0 && <div className="command-empty"><Search size={24} /><strong>没有匹配命令</strong><span>尝试搜索“资料库”“同步”或“预览”</span></div>}
          </div>
          <footer className="command-palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>Enter</kbd>执行</span><button onClick={() => onModeChange("shortcuts")}><Keyboard size={13} />查看全部快捷键</button></footer>
        </> : <div className="shortcut-help">
          <div className="shortcut-help-title"><Keyboard size={20} /><span><strong>快捷键帮助</strong><small>无需离开键盘即可完成常用操作</small></span></div>
          {shortcutGroups.map((group) => <section key={group.title}>
            <h3>{group.title}</h3>
            {group.items.map((item) => <div className="shortcut-row" key={`${group.title}:${item.label}`}>
              <span>{item.label}</span>
              <span>{item.keys.map((key) => <kbd key={key}>{key}</kbd>)}</span>
            </div>)}
          </section>)}
          <div className="shortcut-help-note"><Check size={14} />按 <kbd>?</kbd> 可随时打开此帮助</div>
        </div>}
      </section>
    </div>
  );
}
