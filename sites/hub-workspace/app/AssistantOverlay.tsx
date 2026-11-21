"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { ArrowLeft, X } from 'lucide-react';

type Props = {
  title: string;
  className?: string;
  bodyClassName?: string;
  bodyRef?: Ref<HTMLDivElement>;
  children: ReactNode;
  toolbar?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  onBack?: () => void;
  backLabel?: string;
  closeDisabled?: boolean;
  initialFocus?: string;
  trapFocus?: boolean;
  composerAnchored?: boolean;
  onEscape?: (root: HTMLElement) => void;
};

/** Shared presentation and keyboard contract; domain state stays in each panel. */
export function AssistantOverlay({ title, className = '', bodyClassName = '', bodyRef, children, toolbar, footer, onClose, onBack, backLabel = '返回上一层', closeDisabled = false, initialFocus, trapFocus = false, composerAnchored = false, onEscape }: Props) {
  const root = useRef<HTMLElement>(null);
  const titleId = useId();
  const initialSelector = useRef(initialFocus);
  const [placement, setPlacement] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!composerAnchored || !root.current) return;
    const element = root.current;
    const owner = element.closest<HTMLElement>('.ha-panel');
    const anchor = element.offsetParent instanceof HTMLElement ? element.offsetParent : null;
    const header = owner?.querySelector<HTMLElement>(':scope > .ha-header');
    if (!owner || !anchor) return;
    const measure = () => {
      const panelBox = owner.getBoundingClientRect(), anchorBox = anchor.getBoundingClientRect();
      const safeTop = Math.max(panelBox.top + 12, (header?.getBoundingClientRect().bottom || panelBox.top) + 8);
      const fullHeight = Math.max(0, panelBox.bottom - safeTop - 12);
      const above = Math.max(0, anchorBox.top - 5 - safeTop);
      // A growing composer reduces the space above it. If that becomes too
      // small, keep the picker within its own panel and cover the composer.
      const compactSpace = above < Math.min(220, fullHeight * .65);
      const next: CSSProperties = compactSpace
        ? { maxHeight: Math.min(590, fullHeight), top: safeTop - anchorBox.top, bottom: 'auto' }
        : { maxHeight: Math.min(590, above) };
      setPlacement(previous => previous.maxHeight === next.maxHeight && previous.top === next.top && previous.bottom === next.bottom ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(owner); observer.observe(anchor);
    if (header) observer.observe(header);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [composerAnchored]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const owner = element.closest('.ha-panel');
    const available = (field: HTMLElement | null): field is HTMLElement => !!field && !field.matches(':disabled') && !field.closest('[inert]') && field.getClientRects().length > 0;
    const target = initialSelector.current ? element.querySelector<HTMLElement>(initialSelector.current) : null;
    const autofocus = element.querySelector<HTMLElement>('[data-overlay-autofocus]');
    const fields = Array.from(element.querySelectorAll<HTMLElement>('.ha-overlay-body input:not([disabled]), .ha-overlay-body select:not([disabled]), .ha-overlay-body button:not([disabled]), .ha-overlay-body summary'));
    const first = available(target) ? target : available(autofocus) ? autofocus : fields.find(available) || element.querySelector<HTMLElement>('[data-overlay-close]');
    first?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement instanceof Element ? document.activeElement : null;
      // Closing one assistant's panel must not steal focus from the other one.
      if (active?.closest('.ha-panel') && active.closest('.ha-panel') !== owner) return;
      // A deliberate outside click already chose its own focus destination.
      if (active && active !== document.body && active !== opener && !element.contains(active)) return;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  function keys(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || !root.current) return;
    const owner = event.target instanceof Element ? event.target.closest('[data-assistant-overlay]') : null;
    if (owner !== root.current) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (onEscape) onEscape(root.current);
      else if (!closeDisabled) onClose();
      return;
    }
    if (event.key !== 'Tab' || !trapFocus) return;
    const fields = Array.from(root.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, a[href], [tabindex="0"]')).filter(field => field.getClientRects().length > 0);
    const first = fields[0], last = fields.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <section ref={root} data-assistant-overlay className={'ha-menu ha-overlay ' + className} style={placement} role="dialog" aria-labelledby={titleId} onKeyDown={keys}>
    <header className="ha-overlay-header ha-menu-heading">
      {onBack && <button type="button" className="ha-icon" aria-label={backLabel} onClick={onBack}><ArrowLeft size={17}/></button>}
      <h3 id={titleId}>{title}</h3>
      <button data-overlay-close type="button" className="ha-icon" aria-label={'关闭' + title} disabled={closeDisabled} onClick={onClose}><X size={18}/></button>
    </header>
    {toolbar && <div className="ha-overlay-toolbar">{toolbar}</div>}
    <div ref={bodyRef} className={'ha-overlay-body ' + bodyClassName}>{children}</div>
    {footer && <footer className="ha-overlay-footer">{footer}</footer>}
  </section>;
}
