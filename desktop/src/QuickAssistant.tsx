import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { StandaloneInvestigation } from "./AgentInvestigation";
import "./QuickAssistant.css";

export default function QuickAssistant() {
  const [error, setError] = useState("");
  useEffect(() => {
    document.body.classList.add("quick-assistant-window");
    const focus = () => {
      const active = document.activeElement;
      if (active === document.body || !active?.isConnected) {
        document.querySelector<HTMLTextAreaElement>(".agent-composer textarea")?.focus();
      }
    };
    window.addEventListener("focus", focus);
    const unlisten = listen("hub:quick-assistant-shown", focus);
    return () => {
      document.body.classList.remove("quick-assistant-window");
      window.removeEventListener("focus", focus);
      void unlisten.then(remove => remove()).catch(() => {});
    };
  }, []);
  return <>
    <StandaloneInvestigation initiallyOpen startFresh onDismiss={() => {
      void invoke("dismiss_assistant_window").catch(reason => setError(String(reason)));
    }} />
    {error && <p className="quick-assistant-error" role="alert">{error}</p>}
  </>;
}
