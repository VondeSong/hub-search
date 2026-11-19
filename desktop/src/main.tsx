import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  flushUserProfileStorage, getUserProfileStorageStatus, initializeUserProfileStorage,
  retryUserProfileStorage, subscribeUserProfileStorage,
} from "./UserProfileStorage";

const quickAssistant = "__TAURI_INTERNALS__" in window && getCurrentWindow().label === "quick-assistant";
const QuickAssistant = React.lazy(() => import("./QuickAssistant"));
const rootElement = document.getElementById("root") as HTMLElement;
const root = ReactDOM.createRoot(rootElement);
let exitRequestId: string | undefined;
let exitInFlight = false;
let exitError = "";

async function finishRequestedExit() {
  if (!exitRequestId || exitInFlight) return;
  exitInFlight = true;
  rootElement.inert = true;
  const requestId = exitRequestId;
  let confirmed = false;
  try {
    // Before hydration the app has not rendered and cannot own pending edits.
    if (getUserProfileStorageStatus().ready) await flushUserProfileStorage();
    await invoke("confirm_user_profile_exit", { requestId });
    confirmed = true;
    exitError = "";
  } catch (error) {
    exitError = `退出已暂停：${String(error)}。个人数据保存成功后才能退出。`;
    renderApplication();
  } finally { exitInFlight = false; if (!confirmed) rootElement.inert = false; }
}

function PersonalDataStatus() {
  const status = React.useSyncExternalStore(subscribeUserProfileStorage, getUserProfileStorageStatus);
  const [retrying, setRetrying] = React.useState(false);
  if (!status.error && !status.pending && !exitError) return null;
  const failed = Boolean(status.error || exitError);
  return <div role={failed ? "alert" : "status"} aria-live={failed ? "assertive" : "polite"}
    style={{ position: "fixed", left: "50%", bottom: 16, transform: "translateX(-50%)", zIndex: 10000, maxWidth: "min(680px, 90vw)", padding: "10px 16px", borderRadius: 10, background: "var(--surface, #fff)", color: "var(--text, #242424)", border: "1px solid var(--border, #d7d7d7)", boxShadow: "0 4px 24px #0002", fontSize: 13 }}>
    {failed ? (exitError || `个人数据尚未保存：${status.error}。请保留应用并重试。`) : "正在保存个人数据…"}
    {failed && <button type="button" disabled={retrying} style={{ marginLeft: 12 }} onClick={() => {
      setRetrying(true);
      void retryUserProfileStorage().then(async () => {
        exitError = ""; await finishRequestedExit();
      }).catch(() => { /* The store keeps the error and pending values visible. */ }).finally(() => setRetrying(false));
    }}>{retrying ? "正在重试…" : "重试保存"}</button>}
  </div>;
}

function renderApplication() {
  if (!getUserProfileStorageStatus().ready) return;
  root.render(<React.StrictMode>{quickAssistant
    ? <React.Suspense fallback={<p role="status">正在打开助手…</p>}><QuickAssistant /></React.Suspense>
    : <App />}
    <PersonalDataStatus />
  </React.StrictMode>);
}

let lifecycleReady = false;
async function start() {
  root.render(<p role="status" style={{ padding: 24 }}>正在打开个人数据…</p>);
  try {
    if ("__TAURI_INTERNALS__" in window && !lifecycleReady) {
      const requestedExit = (requestId: unknown) => {
        if (typeof requestId !== "string") return;
        exitRequestId = requestId;
        void finishRequestedExit();
      };
      await listen<{ requestId: string }>("hub:flush-user-profile-before-exit", event => requestedExit(event.payload?.requestId));
      lifecycleReady = true;
    }
    if ("__TAURI_INTERNALS__" in window) {
      const pending = await invoke<{ requestId: string | null }>("user_profile_exit_ready");
      if (pending.requestId) { exitRequestId = pending.requestId; void finishRequestedExit(); }
    }
    await initializeUserProfileStorage();
    renderApplication();
  } catch (error) {
    root.render(<div role="alert" style={{ padding: 24 }}><p>个人数据未能打开，已保留原有数据。</p><p>{String(error)}</p><button type="button" onClick={() => void start()}>重试打开</button></div>);
  }
}
void start();
