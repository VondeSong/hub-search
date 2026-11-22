"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { TagReviewModel } from "../tag-assistant";
import type { WorkspaceAgentsContext } from "./workspace-context";
import type { AgentsDemosProps } from "./AgentsDemos";
import type { AgentsWindowMode } from "./ReferenceSurface";

const AgentsSurface = lazy(() => import("./ReferenceSurface").then(module => ({
  default: module.ReferenceSurface,
})));

export default function WorkspaceAgentsDialog({ open, onDismiss, workspaceContext, tagWorkspace, onOpenTagQueue, demo, onOpenDemos }: {
  open: boolean;
  onDismiss: () => void;
  workspaceContext?: WorkspaceAgentsContext;
  tagWorkspace?: TagReviewModel;
  onOpenTagQueue?: (id: string) => void;
  demo?: Omit<AgentsDemosProps, "onDismiss">;
  onOpenDemos?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [layout, setLayout] = useState<AgentsWindowMode>("expanded");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const modal = layout === "expanded";
    if (element.open && (!open || element.matches(":modal") !== modal)) element.close();
    if (open && !element.open) {
      if (modal) element.showModal();
      else element.show();
    }
  }, [open, layout]);

  return (
    <dialog
      ref={dialog}
      className="workspace-agents-dialog"
      data-window-mode={layout}
      aria-label="Hub 助手"
      onCancel={event => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onDismiss();
      }}
    >
      <Suspense fallback={<p role="status" className="workspace-agents-loading">正在打开助手…</p>}>
        <AgentsSurface onDismiss={onDismiss} workspaceContext={workspaceContext} tagWorkspace={tagWorkspace} onOpenTagQueue={onOpenTagQueue} demo={demo} onOpenDemos={onOpenDemos} onLayoutChange={setLayout} layout={layout} open={open} />
      </Suspense>
    </dialog>
  );
}
