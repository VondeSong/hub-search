import { ArrowUpRight, ClipboardCopy, FileText, FolderSearch, Link2, Quote, Text } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import "./ResultContextMenu.css";
import type { CSSProperties } from "react";
import { providerName } from "./ProviderLabels";
import { resultSummary } from "./ResultActions";
import type { SearchResult } from "./SearchTypes";

export type ResultContextMenuState = { result: SearchResult; x: number; y: number };

type Props = {
  state: ResultContextMenuState;
  canReveal: boolean;
  onClose: () => void;
  onOpen: (result: SearchResult) => void;
  onCopyLink: (result: SearchResult) => void | Promise<void>;
  onCopyMarkdown: (result: SearchResult) => void | Promise<void>;
  onCopyTitle: (result: SearchResult) => void | Promise<void>;
  onCopySummary: (result: SearchResult) => void | Promise<void>;
  onReveal: (result: SearchResult) => void | Promise<void>;
  snippetSaved?: boolean;
  onToggleSnippetFavorite?: (result: SearchResult) => void;
};

export function ResultContextMenu({ state, canReveal, onClose, onOpen, onCopyLink, onCopyMarkdown, onCopyTitle, onCopySummary, onReveal, snippetSaved, onToggleSnippetFavorite }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    window.addEventListener("hub-close-result-context-menu", onClose);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("hub-close-result-context-menu", onClose);
    };
  }, [onClose]);
  const run = (action: () => void | Promise<void>) => { onClose(); void action(); };
  const style = {
    left: Math.max(8, Math.min(state.x, window.innerWidth - 252)),
    top: Math.max(8, Math.min(state.y, window.innerHeight - 380)),
  } as CSSProperties;
  return createPortal(<div ref={menuRef} className="result-context-menu" role="menu" style={style} onContextMenu={(event) => event.preventDefault()}>
    <div className="result-context-heading"><strong>{state.result.title}</strong><small>{providerName(state.result.provider)}</small></div>
    <button role="menuitem" onClick={() => run(() => onOpen(state.result))}><ArrowUpRight size={15} /><span>在来源中打开</span></button>
    {onToggleSnippetFavorite && state.result.snippet.trim() && <button role="menuitem" onClick={() => run(() => onToggleSnippetFavorite(state.result))}><Quote size={15} /><span>{snippetSaved ? "取消收藏此片段" : "收藏此片段"}</span></button>}
    <button role="menuitem" onClick={() => run(() => onCopyLink(state.result))}><Link2 size={15} /><span>复制深链接</span></button>
    <button role="menuitem" onClick={() => run(() => onCopyMarkdown(state.result))}><FileText size={15} /><span>复制为 Markdown 链接</span></button>
    <i className="result-context-separator" />
    <button role="menuitem" onClick={() => run(() => onCopyTitle(state.result))}><Text size={15} /><span>复制标题</span></button>
    <button role="menuitem" disabled={!resultSummary(state.result)} onClick={() => run(() => onCopySummary(state.result))}><Quote size={15} /><span>复制正文摘要</span></button>
    <button role="menuitem" disabled={!canReveal} title={canReveal ? "" : "仅本地 Obsidian 文件可定位"} onClick={() => run(() => onReveal(state.result))}><FolderSearch size={15} /><span>在文件管理器中定位</span></button>
    <div className="result-context-tip"><ClipboardCopy size={12} />也可将结果拖入其他应用</div>
  </div>, document.body);
}
