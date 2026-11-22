/// <reference types="vite/client" />

'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReferenceAgent from './ReferenceAgent';
import referenceStyles from './reference.css?inline';

export type AgentsDocumentContext = {
  id: string;
  name: string;
  path: string;
  text: string;
};

export function ReferenceSurface({ onDismiss, documentContext, open = true }: {
  onDismiss?: () => void;
  documentContext?: AgentsDocumentContext;
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
        <ReferenceAgent onDismiss={onDismiss} documentContext={documentContext} open={open} />
      </>,
      surface,
    )}</div>
  </>;
}
