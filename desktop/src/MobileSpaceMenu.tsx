import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Cloud, FolderOpen, Palette, Plus, Settings, X } from "lucide-react";
import { useModalFocus } from "./useModalFocus";
import { openQuickJournalCapture } from "./QuickJournalEvents";

export type MobileSpaceActions = {
  onLibraries: () => void;
  onConnections: () => void;
  onAppearance: () => void;
};

export function MobileSpaceMenu({ onClose, onSettings, onLibraries, onConnections, onAppearance }: MobileSpaceActions & { onClose: () => void; onSettings: () => void }) {
  const panel = useRef<HTMLElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useModalFocus({ active: true, containerRef: panel, onDismiss: onClose });
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const actions = [
    { label: "快速速记", icon: Plus, run: openQuickJournalCapture },
    { label: "资料库", icon: FolderOpen, run: onLibraries },
    { label: "连接总览", icon: Cloud, run: onConnections },
    { label: "外观与阅读", icon: Palette, run: onAppearance },
    { label: "设置", icon: Settings, run: onSettings },
  ];
  return createPortal(<dialog ref={dialog} className="mobile-space-layer" role="dialog" aria-modal="true" aria-label="空间与设置" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} className="mobile-space-menu" tabIndex={-1}>
      <header><h2>Hub</h2><button type="button" aria-label="关闭空间菜单" onClick={onClose}><X size={20}/></button></header>
      <p>找回内容、记下想法，接着处理手头的事。</p>
      <nav aria-label="空间快捷入口">{actions.map(({ label, icon: Icon, run }) => <button type="button" key={label} onClick={() => { onClose(); run(); }}><Icon size={20}/><span>{label}</span><ChevronRight size={16}/></button>)}</nav>
    </section>
  </dialog>, document.body);
}
