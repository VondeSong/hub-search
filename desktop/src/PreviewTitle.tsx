import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { writeClipboardText } from "./usePreviewController";
import "./PreviewTitle.css";

/** Keep the title selectable; copying is a separate action from opening a title link. */
export function PreviewTitle({ text, children, className, agentSource }: {
  text: string;
  agentSource?: object;
  children?: ReactNode;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "error">("idle");
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setState("idle");
    return () => { generation.current++; clearTimeout(timer.current); };
  }, [text]);
  const copy = async () => {
    const current = ++generation.current;
    clearTimeout(timer.current);
    setState("copying");
    try {
      await writeClipboardText(text);
      if (current !== generation.current) return;
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), 1800);
    } catch {
      if (current === generation.current) setState("error");
    }
  };
  const label = state === "copied" ? "已复制标题" : state === "error" ? "重试复制标题" : "复制标题";
  return <div className="preview-title" data-copy-state={state}>
    <div className="preview-title-row">
      <h1 className={className} data-selectable="true" draggable={!!agentSource} onDragStart={event=>{if(agentSource){event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData("application/x-hub-agent-source",JSON.stringify(agentSource));}}}>{children ?? text}</h1>
      <button type="button" className="preview-title-copy" title={label} aria-label={label}
        disabled={!text.trim() || state === "copying"} onClick={() => void copy()}>
        {state === "copied" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
      </button>
    </div>
    <span className="preview-title-feedback" role="status" aria-live="polite">
      {state === "copied" ? "标题已复制" : state === "error" ? "复制失败，请重试或选中标题复制。" : ""}
    </span>
  </div>;
}
