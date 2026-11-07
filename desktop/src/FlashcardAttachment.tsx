import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { FileText, Download, ExternalLink } from "lucide-react";
import { DeferredVideo } from "./DeferredVideo";
import { LifecycleAudio } from "./LifecycleAudio";
import type { FlashcardMedia } from "./FlashcardTypes";
import "./FlashcardAttachment.css";

export function FlashcardAttachment({ item }: { item: FlashcardMedia }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [downloaded, setDownloaded] = useState(0);
  const [notice, setNotice] = useState("");
  const local = /^(http:\/\/craft-media\.localhost\/|(?:craft|hub)-media:\/\/localhost\/)[a-f0-9]{64}$/i.test(item.url);
  const ensureAvailable = async () => {
    await invoke("ensure_flashcard_cloud_attachment", { url: item.url });
    setMissing(false);
    setDownloaded(n => n + 1);
  };
  const act = async (download: boolean) => {
    setError(""); setNotice(""); setBusy(true);
    try {
      if (!local) {
        if (!/^https?:\/\//i.test(item.url)) throw new Error("该附件地址无法打开");
        await openUrl(item.url);
      } else if (download) {
        if (document.documentElement.dataset.runtimePlatform === "android") {
          await ensureAvailable();
          await invoke("save_flashcard_attachment", { url: item.url, destination: "", fileName: item.title || "附件", mimeType: item.mimeType });
          setNotice("请在系统对话框中完成保存");
          return;
        }
        const destination = await save({ defaultPath: item.title || "附件" });
        if (destination) {
          await ensureAvailable();
          await invoke("save_flashcard_attachment", { url: item.url, destination });
        }
      } else {
        await ensureAvailable();
        await invoke("open_flashcard_attachment", { url: item.url, fileName: item.title || "附件" });
      }
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  return <section className="flashcard-attachment" onClick={e=>e.stopPropagation()}>
    {item.mimeType.startsWith("image/") && <img key={downloaded} src={downloaded ? `${item.url}?download=${downloaded}` : item.url} alt={item.title} loading="lazy" onError={() => { if (local) setMissing(true); }} />}
    {item.mimeType.startsWith("video/") && <DeferredVideo key={downloaded} src={item.url} title={item.title || "视频附件"} />}
    {item.mimeType.startsWith("audio/") && <LifecycleAudio key={downloaded} controls preload="metadata" src={item.url} aria-label={item.title || "音频附件"} onError={() => { if (local) setMissing(true); }} />}
    {local && (missing || item.mimeType.startsWith("video/")) && <button type="button" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { await ensureAvailable(); }
      catch (e) { setError(String(e)); } finally { setBusy(false); }
    }}>{busy ? "下载并校验中…" : "下载并离线保留"}</button>}
    <div className="flashcard-attachment-actions"><FileText size={16}/><span title={item.title}>{item.title || "附件"}{item.byteSize ? <small>{item.byteSize >= 1048576 ? `${(item.byteSize / 1048576).toFixed(1)} MB` : `${Math.ceil(item.byteSize / 1024)} KB`}</small> : null}</span><button type="button" disabled={busy} onClick={()=>void act(false)} title="打开附件"><ExternalLink size={14}/>打开</button>{local && <button type="button" disabled={busy} onClick={()=>void act(true)} title="另存为"><Download size={14}/>保存</button>}</div>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
