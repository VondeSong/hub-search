/// <reference types="vite/client" />

'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReferenceAgent from './ReferenceAgent';
import referenceStyles from './reference.css?inline';
import type { TagReviewModel } from '../tag-assistant';
import type { WorkspaceAgentsContext } from './workspace-context';

export function ReferenceSurface({ onDismiss, workspaceContext, tagWorkspace, onOpenTagQueue, open = true }: {
  onDismiss?: () => void;
  workspaceContext?: WorkspaceAgentsContext;
  tagWorkspace?: TagReviewModel;
  onOpenTagQueue?: (id: string) => void;
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
    <div ref={host}>{surface && createPortal(
      <>
        <style>{referenceStyles}</style>
        <ReferenceAgent onDismiss={onDismiss} workspaceContext={workspaceContext} tagWorkspace={tagWorkspace} onOpenTagQueue={onOpenTagQueue} open={open} />
      </>,
      surface,
    )}</div>
  </>;
}
