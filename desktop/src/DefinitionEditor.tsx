import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** Keep the entire definition visible, including after generation and width changes. */
export function DefinitionEditor(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resize = () => {
      element.style.height = "auto";
      element.style.height = `${Math.max(36, element.scrollHeight + 2)}px`;
    };
    resize();
    let width = element.getBoundingClientRect().width;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      const next = element.getBoundingClientRect().width;
      if (next !== width) { width = next; resize(); }
    });
    observer?.observe(element);
    window.addEventListener("resize", resize);
    return () => { observer?.disconnect(); window.removeEventListener("resize", resize); };
  }, [props.value]);
  return <textarea {...props} ref={ref} rows={1} className="tag-definition-editor" />;
}
