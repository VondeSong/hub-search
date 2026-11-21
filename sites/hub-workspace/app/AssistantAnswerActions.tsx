"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, FilePlus2, ListPlus, MoreHorizontal, PencilLine } from 'lucide-react';

export function AssistantAnswerActions({ copied, onCopy, onInsert, onNote, onTask }: { copied: boolean; onCopy: () => void; onInsert?: () => void; onNote: () => void; onTask: () => void }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12, width: 232, maxHeight: 260 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const host = trigger.current?.closest<HTMLElement>('.ha-panel') || null;
  const menuId = useId();
  const close = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };

  useLayoutEffect(() => {
    if (!open || !host || !trigger.current) return;
    function place() {
      if (!host || !trigger.current) return;
      const panel = host.getBoundingClientRect(), button = trigger.current.getBoundingClientRect();
      const width = Math.min(232, panel.width - 24);
      const height = menu.current?.offsetHeight || 174;
      const below = panel.bottom - button.bottom - 14, above = button.top - panel.top - 14;
      const upward = below < height && above > below;
      setPosition({ left: Math.max(12, Math.min(button.left - panel.left, panel.width - width - 12)), top: upward ? Math.max(12, button.top - panel.top - height - 6) : button.bottom - panel.top + 6, width, maxHeight: Math.max(100, upward ? above : below) });
    }
    place();
    const observer = new ResizeObserver(place);
    observer.observe(host);
    if (menu.current) observer.observe(menu.current);
    const id = requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }));
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) close(false); };
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const owner = event.target.closest('.ha-panel');
      if (owner && owner !== host) return;
      if (!menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(false);
    };
    host.addEventListener('scroll', scroll, true);
    document.addEventListener('pointerdown', outside);
    return () => { observer.disconnect(); cancelAnimationFrame(id); host.removeEventListener('scroll', scroll, true); document.removeEventListener('pointerdown', outside); };
  }, [open, host]);

  useEffect(() => {
    if (!open || !host) return;
    const otherMenu = () => close(false);
    host.addEventListener('ha-answer-menu-close', otherMenu);
    return () => host.removeEventListener('ha-answer-menu-close', otherMenu);
  }, [open, host]);

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const choices = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || []);
    const index = choices.indexOf(document.activeElement as HTMLButtonElement);
    choices[event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length]?.focus();
  }

  const choose = (action: () => void) => { close(); action(); };
  return <div className="ha-answer-actions" aria-label="回答操作">
    <button type="button" aria-label={copied ? '已复制回答' : '复制回答'} title={copied ? '已复制' : '复制回答'} onClick={onCopy}>{copied ? <Check size={16}/> : <Copy size={16}/>}<span>{copied ? '已复制' : '复制'}</span></button>
    <button ref={trigger} type="button" aria-label="更多回答操作" title="更多回答操作" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => { if (!open) trigger.current?.closest('.ha-panel')?.dispatchEvent(new Event('ha-answer-menu-close')); setOpen(!open); }}><MoreHorizontal size={17}/><span>更多</span></button>
    {open && host && createPortal(<div id={menuId} ref={menu} className="ha-menu ha-answer-menu" role="menu" aria-label="更多回答操作" style={position} onKeyDown={keys}>
      {onInsert && <button type="button" role="menuitem" onClick={() => choose(onInsert)}><FilePlus2 size={17}/><span>插入页面<small>选择位置并预览</small></span></button>}
      <button type="button" role="menuitem" onClick={() => choose(onNote)}><PencilLine size={17}/><span>新建笔记<small>先查看并修改草稿</small></span></button>
      <button type="button" role="menuitem" onClick={() => choose(onTask)}><ListPlus size={17}/><span>创建任务<small>整理为可编辑的待办</small></span></button>
    </div>, host)}
  </div>;
}
