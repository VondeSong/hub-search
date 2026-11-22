import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Native details keeps disclosure semantics; dismissal never submits a form. */
export function useAgentPopover(options: { deferEscapeSelector?: string; onEscape?: () => boolean; triggerRef?: RefObject<HTMLElement | null>; returnFocusRef?: RefObject<HTMLElement | null>; aboveComposer?: boolean; anchorToSummary?: boolean } = {}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [element, setElement] = useState<HTMLDetailsElement | null>(null);
  const deferredEscape = useRef(options.deferEscapeSelector);
  const handleEscape = useRef(options.onEscape);
  const trigger = options.triggerRef;
  const returnFocus = options.returnFocusRef;
  const aboveComposer = options.aboveComposer;
  const anchorToSummary = options.anchorToSummary;
  deferredEscape.current = options.deferEscapeSelector;
  handleEscape.current = options.onEscape;
  // The assistant's disclosures mount after its launcher is first opened.
  useLayoutEffect(() => { if (ref.current !== element) setElement(ref.current); });
  function close(restoreFocus = false) {
    const element = ref.current;
    if (!element?.open) return;
    element.open = false;
    if (restoreFocus) (returnFocus ? returnFocus.current ?? element.querySelector("summary") : trigger?.current ?? element.querySelector("summary"))?.focus();
  }
  useEffect(() => {
    if (!element) return;
    // Padding clicks keep a focus owner inside the disclosure for Escape.
    if (!element.hasAttribute("tabindex")) element.tabIndex = -1;
    // A native picker owns focus temporarily; keep its caller mounted for the result.
    const nativeDialogOpen = () => !!element.querySelector("[data-agent-native-dialog]");
    const outside = (event: Event) => {
      if (nativeDialogOpen() || !(event.target instanceof Node) || element.contains(event.target) || trigger?.current?.contains(event.target)) return;
      const owner=element.closest(".agent-panel");
      const target=event.target instanceof Element ? event.target.closest(".agent-panel") : null;
      if(owner&&target&&owner!==target)return;
      close();
    };
    const escape = (event: KeyboardEvent) => {
      if (nativeDialogOpen() || event.key !== "Escape" || event.isComposing || event.defaultPrevented || !element.open) return;
      const retargeted = event.target === document.body && element.matches('details[data-hub-keyboard-scope]:not([hidden] *)');
      if (!retargeted && (!(event.target instanceof Node) || !element.contains(event.target))) return;
      // Let a nested search field or action menu consume its first Escape.
      if (deferredEscape.current && event.target instanceof Element && event.target.closest(deferredEscape.current)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!handleEscape.current?.()) close(true);
    };
    const blur=()=>{if(!nativeDialogOpen())close();};
    window.addEventListener("blur",blur);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    const controls = element?.closest(".agent-composer-controls");
    const body = element?.closest(".agent-body");
    const composer = controls?.closest(".agent-composer");
    const header = element?.closest(".agent-panel-header");
    const panel = element?.closest(".agent-panel");
    const fit = () => {
      if (!element?.open) return;
      if (header && panel) {
        const available = panel.getBoundingClientRect().bottom - header.getBoundingClientRect().bottom - 8;
        element.style.setProperty("--agent-header-popover-room", `${Math.max(0, Math.floor(available))}px`);
      }
      if (!controls || !body) return;
      // The scroll clip starts below the panel header, not at the viewport edge.
      if (panel) element.style.setProperty("--agent-skill-height", `${Math.floor(panel.getBoundingClientRect().height / 2)}px`);
      const controlRect = controls.getBoundingClientRect();
      const controlTop = controlRect.top;
      if (anchorToSummary) {
        const summary = element.querySelector("summary");
        if (summary) element.style.setProperty("--agent-popover-anchor", `${summary.getBoundingClientRect().left - controlRect.left}px`);
      }
      const top = aboveComposer && composer ? composer.getBoundingClientRect().top : controlTop;
      if (aboveComposer) element.style.setProperty("--agent-popover-offset", `${Math.max(0, controlTop-top)}px`);
      const available = top - Math.max(8, body.getBoundingClientRect().top) - 8;
      element.style.setProperty("--agent-popover-room", `${Math.max(0, Math.floor(available))}px`);
    };
    element?.addEventListener("toggle", fit);
    window.addEventListener("resize", fit);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    if (controls && body) {
      resize?.observe(body);
      if (composer) resize?.observe(composer);
    }
    if (header && panel) {
      resize?.observe(header);
      resize?.observe(panel);
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
  }, [element, trigger, returnFocus, aboveComposer, anchorToSummary]);
  return { ref, close };
}
