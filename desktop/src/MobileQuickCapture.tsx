import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useMobileViewport } from "./useMobileViewport";
import { defaultJournalView } from "./JournalViews";
import { QuickJournal, type QuickJournalSaved } from "./QuickJournal";

export function MobileQuickCapture({ citation, onClose, onSaved, onSyncSettings }: {
  citation?: string;
  onClose: () => void;
  onSaved: (record: QuickJournalSaved) => void;
  onSyncSettings: () => void;
}) {
  const { height, keyboardOpen } = useMobileViewport();
  const dialog = useRef<HTMLDialogElement>(null);
  function dismissKeyboard() {
    const active = document.activeElement;
    if (!dialog.current?.contains(active) || !(active instanceof HTMLElement)) return;
    (navigator as Navigator & {virtualKeyboard?: {hide(): void}}).virtualKeyboard?.hide();
    active.blur();
  }
  function closeCapture() { dismissKeyboard(); onClose(); }
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => {
      dismissKeyboard();
      void invoke("focus_quick_journal_editor", {visible: false}).catch(() => {});
      element?.close(); if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={dialog} className={`mobile-quick-capture ${keyboardOpen ? "keyboard-open" : ""}`} style={{ "--capture-viewport-height": `${height}px`, "--capture-keyboard-inset": `${Math.max(0, window.innerHeight - height)}px` } as CSSProperties} aria-label="速记"
    onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); closeCapture(); }} onClick={event => {
      if (event.target !== dialog.current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeCapture();
    }}>
    <div className="mobile-capture-grabber" aria-hidden="true" />
    <div className="mobile-capture-heading"><h2>速记</h2><button type="button" aria-label="关闭速记" onPointerDown={e => e.preventDefault()} onClick={closeCapture}>收起</button></div>
    <QuickJournal libraries={[]} scope={null} view={defaultJournalView()} dataVersion="capture" mode="compose" citation={citation} onSaved={onSaved} onSyncSettings={onSyncSettings} />
  </dialog>, document.body);
}
