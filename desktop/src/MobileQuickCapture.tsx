import { useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useMobileViewport } from "./useMobileViewport";
import { defaultJournalView } from "./JournalViews";
import { QuickJournal, type QuickJournalSaved } from "./QuickJournal";

export function MobileQuickCapture({ onClose, onSaved, onSyncSettings }: {
  onClose: () => void;
  onSaved: (record: QuickJournalSaved) => void;
  onSyncSettings: () => void;
}) {
  const { height, keyboardOpen } = useMobileViewport();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={dialog} className={`mobile-quick-capture ${keyboardOpen ? "keyboard-open" : ""}`} style={{ "--capture-viewport-height": `${height}px`, "--capture-keyboard-inset": `${Math.max(0, window.innerHeight - height)}px` } as CSSProperties} aria-label="速记"
    onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
      if (event.target !== dialog.current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <div className="mobile-capture-grabber" aria-hidden="true" />
    <div className="mobile-capture-heading"><h2 className="sr-only">速记</h2><button type="button" aria-label="关闭速记" onClick={onClose}><X size={21} /></button></div>
    <QuickJournal libraries={[]} scope={null} view={defaultJournalView()} dataVersion="capture" mode="compose" onSaved={onSaved} onSyncSettings={onSyncSettings} />
  </dialog>, document.body);
}
