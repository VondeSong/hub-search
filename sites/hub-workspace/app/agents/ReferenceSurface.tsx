/// <reference types="vite/client" />

'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReferenceAgent from './ReferenceAgent';
import AgentsDemos, { type AgentsDemosProps } from './AgentsDemos';
import referenceStyles from './reference.css?inline';
import type { TagReviewModel } from '../tag-assistant';
import type { WorkspaceAgentsContext } from './workspace-context';

export type AgentsWindowMode = 'docked' | 'floating' | 'expanded';

export function ReferenceSurface({ onDismiss, workspaceContext, tagWorkspace, onOpenTagQueue, demo, onOpenDemos, onLayoutChange, layout = "expanded", open = true }: {
  onDismiss?: () => void;
  workspaceContext?: WorkspaceAgentsContext;
  tagWorkspace?: TagReviewModel;
  onOpenTagQueue?: (id: string) => void;
  demo?: Omit<AgentsDemosProps, 'onDismiss'>;
  onOpenDemos?: () => void;
  onLayoutChange?: (mode: AgentsWindowMode) => void;
  layout?: AgentsWindowMode;
  open?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState<ShadowRoot | null>(null);

  useEffect(() => {
    const element = host.current;
    if (element) setSurface(element.shadowRoot ?? element.attachShadow({ mode: 'open' }));
  }, []);

  return <>
    <link
      rel="stylesheet"
      href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
      precedence="default"
    />
    <div ref={host} style={demo ? { height: "100%" } : layout === "expanded" ? undefined : { background: "transparent" }}>{surface && createPortal(
      <>
        <style>{referenceStyles}</style>
        {demo && onDismiss ? <AgentsDemos {...demo} onDismiss={onDismiss} />
          : <ReferenceAgent onDismiss={onDismiss} workspaceContext={workspaceContext} tagWorkspace={tagWorkspace} onOpenTagQueue={onOpenTagQueue} onOpenDemos={onOpenDemos} onLayoutChange={onLayoutChange} initialLayout={layout} open={open} />}
      </>,
      surface,
    )}</div>
  </>;
}
