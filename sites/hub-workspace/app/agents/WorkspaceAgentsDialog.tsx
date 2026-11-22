"use client";

import { lazy, Suspense, useEffect, useRef } from "react";

const AgentsSurface = lazy(() => import("./ReferenceSurface").then(module => ({
  default: module.ReferenceSurface,
})));

export default function WorkspaceAgentsDialog({ open, onDismiss }: {
  open: boolean;
  onDismiss: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element || element.open === open) return;
    if (open) element.showModal();
    else element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="workspace-agents-dialog"
      aria-label="Hub 助手"
      onCancel={event => {
        event.preventDefault();
        onDismiss();
      }}
    >
      <Suspense fallback={<p role="status" className="workspace-agents-loading">正在打开助手…</p>}>
        <AgentsSurface onDismiss={onDismiss} />
      </Suspense>
    </dialog>
  );
}
