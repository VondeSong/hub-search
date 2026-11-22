import { FlaskConical } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import previewImage from "../../sites/hub-workspace/public/hub-workspace-preview.jpg?url";
import githubIcon from "../../sites/hub-workspace/public/agent-icons/github.svg?url";
import notionIcon from "../../sites/hub-workspace/public/agent-icons/notion.svg?url";

const AgentsDemos = lazy(() => import("../../sites/hub-workspace/app/agents/AgentsDemos"));
const processAssets = { previewImage, githubIcon, notionIcon };

function DesktopAgentsDemoDialog({ onDismiss }: { onDismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);

  useEffect(() => {
    const element = dialog.current;
    const container = host.current;
    if (!element || !container) return;
    if (!element.open) element.showModal();
    setShadow(container.shadowRoot ?? container.attachShadow({ mode: "open" }));
    return () => { if (element.open) element.close(); };
  }, []);

  return createPortal(
    <dialog ref={dialog} aria-label="Agents 演示"
      onCancel={event => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onDismiss();
      }}
      style={{ position: "fixed", inset: 0, margin: 0, padding: 0, border: 0,
        width: "100%", maxWidth: "none", height: "100dvh", maxHeight: "none", background: "#f3f3f1" }}>
      <div ref={host} style={{ height: "100%" }} />
      {shadow && createPortal(
        <Suspense fallback={<p role="status">正在打开 Agents 演示…</p>}>
          <AgentsDemos initialMode="ui-demo" onDismiss={onDismiss} processAssets={processAssets} />
        </Suspense>, shadow)}
    </dialog>, document.body);
}

export default function DesktopAgentsDemos() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="workspace-rail-navigation-item" aria-label="Agents 演示"
      title="Agents 演示 · 开发版" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <FlaskConical size={17} aria-hidden="true" />
    </button>
    {open && <DesktopAgentsDemoDialog onDismiss={() => setOpen(false)} />}
  </>;
}
