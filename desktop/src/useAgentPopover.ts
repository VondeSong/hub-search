import { useEffect, useRef } from "react";

/** Native details keeps disclosure semantics; dismissal never submits a form. */
export function useAgentPopover() {
  const ref = useRef<HTMLDetailsElement>(null);
  function close(restoreFocus = false) {
    const element = ref.current;
    if (!element?.open) return;
    element.open = false;
    if (restoreFocus) element.querySelector("summary")?.focus();
  }
  useEffect(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented || !ref.current?.open ||
          !(event.target instanceof Node) || !ref.current.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    const blur=()=>close();
    window.addEventListener("blur",blur);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    const element = ref.current;
    const controls = element?.closest(".agent-composer-controls");
    const body = element?.closest(".agent-body");
    const fit = () => {
      if (!element?.open || !controls || !body) return;
      // The scroll clip starts below the panel header, not at the viewport edge.
      const panel = element.closest(".agent-panel");
      if (panel) element.style.setProperty("--agent-skill-height", `${Math.floor(panel.getBoundingClientRect().height / 2)}px`);
      const available = controls.getBoundingClientRect().top - Math.max(8, body.getBoundingClientRect().top) - 8;
      element.style.setProperty("--agent-popover-room", `${Math.max(0, Math.floor(available))}px`);
    };
    element?.addEventListener("toggle", fit);
    window.addEventListener("resize", fit);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    if (controls && body) {
      resize?.observe(body);
      const composer = controls.closest(".agent-composer");
      if (composer) resize?.observe(composer);
    }
    fit();
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur",blur);
      element?.removeEventListener("toggle", fit);
      window.removeEventListener("resize", fit);
      resize?.disconnect();
    };
  }, []);
  return { ref, close };
}
