"use client";

import { lazy, Suspense, useEffect, useRef } from "react";
import type { AgentsDocumentContext } from "./ReferenceSurface";

const AgentsSurface = lazy(() => import("./ReferenceSurface").then(module => ({
  default: module.ReferenceSurface,
})));

export default function WorkspaceAgentsDialog({ open, onDismiss, documentContext }: {
  open: boolean;
  onDismiss: () => void;
  documentContext?: AgentsDocumentContext;
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
        <AgentsSurface onDismiss={onDismiss} documentContext={documentContext} open={open} />
      </Suspense>
    </dialog>
  );
}
