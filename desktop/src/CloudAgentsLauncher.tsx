import { Cloud } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./CloudAgents.css";

const CloudAgents = lazy(() => import("./CloudAgents"));

export function CloudAgentsLauncher() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open && dialog.current && !dialog.current.open) dialog.current.showModal(); }, [open]);
  return <>
    <button className="icon-button agent-launcher" type="button" aria-label="云端 Agents" title="云端 Agents" onClick={() => setOpen(true)}><Cloud size={17} /></button>
    {open && createPortal(<dialog className="cloud-agents-dialog" ref={dialog} aria-label="云端 Agents" onClose={() => setOpen(false)}>
      <Suspense fallback={<p role="status">正在打开云端 Agents…</p>}><CloudAgents onClose={() => dialog.current?.close()} /></Suspense>
    </dialog>, document.body)}
  </>;
}
