import { useEffect, useRef, type RefObject } from "react";

type ModalFocusOptions = {
  active: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  suspended?: boolean;
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => {
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hidden || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true" || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
        if (node instanceof HTMLDetailsElement && !node.open && !node.querySelector("summary")?.contains(element)) return false;
        if (node === container) break;
      }
      return true;
    });
}

const modalStack: HTMLElement[] = [];
const isolation = new Map<HTMLElement, { owners: number; originallyInert: boolean }>();
function isolateBackground(container: HTMLElement) {
  const isolated: HTMLElement[] = [];
  for (let branch: HTMLElement | null = container; branch?.parentElement; branch = branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (!(sibling instanceof HTMLElement) || sibling === branch || ["SCRIPT", "STYLE"].includes(sibling.tagName)) continue;
      const state = isolation.get(sibling) ?? { owners: 0, originallyInert: sibling.hasAttribute("inert") };
      state.owners++; isolation.set(sibling, state); sibling.setAttribute("inert", ""); isolated.push(sibling);
    }
    if (branch.parentElement === document.body) break;
  }
  return () => { for (const element of isolated) {
    const state = isolation.get(element); if (!state) continue;
    if (--state.owners === 0) { if (!state.originallyInert) element.removeAttribute("inert"); isolation.delete(element); }
  } };
}

export function useModalFocus({ active, containerRef, onDismiss, suspended = false }: ModalFocusOptions) {
  const dismissRef = useRef(onDismiss);
  const suspendedRef = useRef(suspended);

  useEffect(() => { dismissRef.current = onDismiss; }, [onDismiss]);
  useEffect(() => { suspendedRef.current = suspended; }, [suspended]);

  useEffect(() => {
    if (!active) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = containerRef.current;
    if (!container) return;
    const restoreBackground = isolateBackground(container);
    modalStack.push(container);

    const initialFocus = container.querySelector<HTMLElement>("[data-modal-initial-focus]")
      ?? focusableElements(container)[0]
      ?? container;
    initialFocus.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (suspendedRef.current || modalStack[modalStack.length - 1] !== container) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !container.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !container.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    const nativeBack = (event: Event) => {
      if (suspendedRef.current || modalStack[modalStack.length - 1] !== container) return;
      const nativeDialogs = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
      const topDialog = nativeDialogs[nativeDialogs.length - 1];
      if (topDialog && !topDialog.contains(container)) return;
      event.preventDefault(); dismissRef.current();
    };
    window.addEventListener("hub:native-back", nativeBack);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("hub:native-back", nativeBack);
      const index = modalStack.lastIndexOf(container); if (index !== -1) modalStack.splice(index, 1);
      restoreBackground();
      // Nested dialogs may unmount together. Restore after every owner releases
      // its background isolation, without moving focus out of a new top dialog.
      queueMicrotask(() => {
        const top = modalStack[modalStack.length - 1];
        if (previousFocus?.isConnected && !previousFocus.closest("[inert]") && (!top || top.contains(previousFocus))) previousFocus.focus();
      });
    };
  }, [active, containerRef]);
}
