import { useEffect, useRef, useState, type ReactNode } from "react";
import { useModalFocus } from "./useModalFocus";

/** One live spring owns both drag and disclosure, so reversals never restart the sheet. */
export function MobileFilterSheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const backdrop = useRef<HTMLButtonElement>(null);
  const motion = useRef({ y: 0, velocity: 0, target: 0, frame: 0, last: 0, height: 600, dragging: false });
  const gesture = useRef({ id: -1, start: 0, offset: 0, lastY: 0, lastTime: 0 });
  const openRef = useRef(open);
  openRef.current = open;
  const [present, setPresent] = useState(open);
  useModalFocus({ active: open, containerRef: panel, onDismiss: onClose });

  function paint() {
    const m = motion.current;
    if (panel.current) panel.current.style.transform = `translateY(${m.y}px)`;
    if (backdrop.current) backdrop.current.style.opacity = String(Math.max(0, 1 - m.y / m.height));
  }
  function settle(target: number) {
    const m = motion.current;
    cancelAnimationFrame(m.frame);
    m.target = target;
    m.last = 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      m.y = target; m.velocity = 0; paint();
      if (!openRef.current) setPresent(false);
      return;
    }
    const tick = (time: number) => {
      const dt = Math.min((time - (m.last || time - 16)) / 1000, .032);
      m.last = time;
      // Critically damped spring: retain presentation position and release velocity.
      m.velocity += ((m.target - m.y) * 400 - m.velocity * 40) * dt;
      m.y += m.velocity * dt;
      paint();
      if (Math.abs(m.target - m.y) < .5 && Math.abs(m.velocity) < 5) {
        m.y = m.target; m.velocity = 0; paint();
        if (!openRef.current) setPresent(false);
      } else m.frame = requestAnimationFrame(tick);
    };
    m.frame = requestAnimationFrame(tick);
  }
  useEffect(() => {
    const m = motion.current;
    m.height = panel.current?.getBoundingClientRect().height || 600;
    if (open) {
      if (!present) { m.y = m.height; m.velocity = 0; paint(); }
      setPresent(true);
    }
    settle(open ? 0 : m.height);
    return () => cancelAnimationFrame(m.frame);
    // Disclosure owns the target; gesture handlers retarget the same spring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return <div className="mobile-filter-layer" hidden={!present && !open} inert={!open} aria-hidden={!open}>
    <button ref={backdrop} type="button" className="mobile-filter-scrim" aria-label="关闭筛选面板" tabIndex={-1} onClick={onClose} />
    <section ref={panel} className="mobile-filter-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-filter-title" tabIndex={-1}>
      <div className="mobile-filter-grabber" aria-hidden="true"
        onPointerDown={event => {
          if (event.button !== 0) return;
          cancelAnimationFrame(motion.current.frame);
          motion.current.height = panel.current?.getBoundingClientRect().height || motion.current.height;
          motion.current.dragging = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          gesture.current = { id: event.pointerId, start: event.clientY, offset: motion.current.y, lastY: event.clientY, lastTime: event.timeStamp };
        }}
        onPointerMove={event => {
          if (!motion.current.dragging || gesture.current.id !== event.pointerId) return;
          const g = gesture.current;
          const delta = event.clientY - g.start + g.offset;
          motion.current.y = delta < 0 ? delta * .15 : delta;
          const elapsed = event.timeStamp - g.lastTime;
          if (elapsed > 0) motion.current.velocity = (event.clientY - g.lastY) / elapsed * 1000;
          g.lastY = event.clientY; g.lastTime = event.timeStamp;
          paint();
        }}
        onPointerUp={event => {
          if (!motion.current.dragging || gesture.current.id !== event.pointerId) return;
          motion.current.dragging = false;
          if (event.timeStamp - gesture.current.lastTime > 100) motion.current.velocity = 0;
          if (motion.current.y + motion.current.velocity * .18 > motion.current.height * .28) onClose();
          else settle(0);
        }}
        onPointerCancel={() => { motion.current.dragging = false; settle(openRef.current ? 0 : motion.current.height); }}
      ><span /></div>
      <header className="mobile-filter-heading"><h2 id="mobile-filter-title">搜索筛选</h2><button type="button" data-modal-initial-focus onClick={onClose}>完成</button></header>
      <p className="mobile-filter-description">选择后即生效</p>
      {children}
    </section>
  </div>;
}
