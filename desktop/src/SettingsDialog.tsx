import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useOperationStatus } from "./useOperationStatus";

export type SettingsCategory = "libraries" | "display" | "behavior" | "codex" | "mcp" | "index" | "cloud";

type SettingsDialogProps = {
  mobile?: boolean;
  externalModalOpen?: boolean;
  canClose: boolean;
  category: SettingsCategory;
  children: ReactNode;
  onCategoryChange: (category: SettingsCategory) => void;
  onClose: () => void;
};

const SETTINGS_CATEGORIES: Array<[SettingsCategory, string]> = [
  ["libraries", "资料库"],
  ["cloud", "云同步"],
  ["display", "显示"],
  ["behavior", "操作"],
  ["codex", "模型与运行"],
  ["mcp", "MCP"],
  ["index", "数据管理"],
];

export function SettingsDialog({
  mobile = false,
  externalModalOpen = false,
  canClose,
  category,
  children,
  onCategoryChange,
  onClose,
}: SettingsDialogProps) {
  const { operationStatus } = useOperationStatus();
  const categories = SETTINGS_CATEGORIES.filter(([value]) => !mobile || (value !== "mcp" && value !== "codex"));
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const canCloseRef = useRef(canClose);
  const onCloseRef = useRef(onClose);
  const externalModalOpenRef = useRef(externalModalOpen);

  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [category]);

  useEffect(() => {
    canCloseRef.current = canClose;
    onCloseRef.current = onClose;
    externalModalOpenRef.current = externalModalOpen;
  }, [canClose, onClose, externalModalOpen]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const overlay = overlayRef.current;
    if (!dialog || !overlay) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const siblings = Array.from(overlay.parentElement?.children ?? []).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== overlay,
    );
    const siblingState = siblings.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    siblings.forEach((element) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });

    const focusableSelector = [
      "button:not([disabled])",
      "[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "summary",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const focusDialog = () => dialog.focus({ preventScroll: true });
    const handleFocusIn = (event: FocusEvent) => {
      if (externalModalOpenRef.current) return;
      if (!dialog.contains(event.target as Node)) focusDialog();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (externalModalOpenRef.current) return;
      if (event.key === "Escape" && canCloseRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
        .filter((element) => {
          for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.hidden || ancestor.getAttribute("aria-hidden") === "true") return false;
            const style = window.getComputedStyle(ancestor);
            if (style.display === "none" || style.visibility === "hidden") return false;
            if (ancestor.tagName === "DETAILS" && !ancestor.hasAttribute("open")
              && !ancestor.querySelector(":scope > summary")?.contains(element)) return false;
          }
          return true;
        });
      if (!focusable.length) {
        event.preventDefault();
        focusDialog();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    focusDialog();
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
      siblingState.forEach(({ element, inert, ariaHidden }) => {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      });
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div ref={overlayRef} className="connection-overlay settings-overlay">
      <section
        ref={dialogRef}
        className="connection-card space-settings"
        data-category={category}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
      >
        <button className="modal-close" onClick={onClose} disabled={!canClose} aria-label="关闭"><X size={18} /></button>
        <div className="settings-brand"><img className="hub-mark" src="/icons/hub.png" srcSet="/icons/hub@2x.png 2x" alt="" /><h2 id="settings-dialog-title">Hub 设置</h2></div>
        <p>管理资料库、软件数据与同步，调整阅读和操作习惯。</p>
        <div className="settings-layout">
          <nav className="settings-category-tabs" aria-label="设置分类">
            {categories.map(([value, label]) => (
              <button
                key={value}
                className={category === value ? "active" : ""}
                aria-current={category === value ? "page" : undefined}
                onClick={() => onCategoryChange(value)}
              >
                {label}
              </button>
            ))}
          </nav>
          <label className="mobile-settings-category-picker">
            <span>设置分类</span>
            <select
              value={category}
              aria-label="设置分类"
              onChange={(event) => onCategoryChange(event.target.value as SettingsCategory)}
            >
              {categories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <div ref={contentRef} className="settings-detail" role="region" aria-label={SETTINGS_CATEGORIES.find(([value]) => value === category)?.[1]} tabIndex={0}>
            {children}
          </div>
        </div>
        <footer className={`settings-operation-status${operationStatus ? ` ${operationStatus.tone}` : ""}`} role={operationStatus?.tone === "error" ? "alert" : "status"} aria-label="操作状态">
          {operationStatus && <span title={operationStatus.text}>{operationStatus.text}</span>}
        </footer>
      </section>
    </div>
  );
}
