import { ArrowUpRight, Check, Link2, X } from "lucide-react";
import type { MouseEventHandler, ReactNode, Ref } from "react";
export { PreviewTitle } from "./PreviewTitle";

/** Shared reading surface for search, tasks, and collected items. */
export function PreviewFrame({ children, className = "", label, cardRef, onMouseDown, empty }: {
  children?: ReactNode;
  className?: string;
  label?: string;
  cardRef?: Ref<HTMLElement>;
  onMouseDown?: MouseEventHandler<HTMLElement>;
  empty?: ReactNode;
}) {
  return <aside className={`preview-pane ${className}`} aria-label={label} onMouseDown={onMouseDown}>
    {empty ?? <article className="preview-card" ref={cardRef}>{children}</article>}
  </aside>;
}

export function PreviewHeading({ source, actions, children, provider = "" }: {
  source: ReactNode; actions: ReactNode; children: ReactNode; provider?: string;
}) {
  return <div className={`preview-heading ${provider}`}>
    <div className="preview-heading-top">
      <div className="preview-source-row">{source}</div>
      {actions}
    </div>
    {children}
  </div>;
}

export function PreviewToolbar({ children, copied, onCopy, onOpen, openTitle, openDisabled, hideOpen = false, onClose, closeLabel = "关闭预览" }: {
  children?: ReactNode;
  copied?: boolean;
  onCopy: () => void | Promise<void>;
  onOpen: () => void;
  openTitle: string;
  openDisabled?: boolean;
  hideOpen?: boolean;
  onClose?: () => void;
  closeLabel?: string;
}) {
  return <div className="preview-actions" role="group" aria-label="预览操作">
    {children}
    <button type="button" className="preview-copy-action" title={copied ? "已复制" : "复制结果链接"} aria-label={copied ? "已复制" : "复制结果链接"} onClick={() => void onCopy()}>{copied ? <Check size={18} /> : <Link2 size={18} />}</button>
    {!hideOpen && <button type="button" className="preview-open-action" title={openTitle} aria-label={openTitle} disabled={openDisabled} onClick={onOpen}><ArrowUpRight size={19} /></button>}
    {onClose && <button type="button" title={closeLabel} aria-label={closeLabel} onClick={onClose}><X size={17} /></button>}
  </div>;
}
