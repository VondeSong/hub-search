import { invoke } from "@tauri-apps/api/core";
import { FileText, Image, LoaderCircle, Music, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { PreviewMarkdownMedia } from "./PreviewMarkdown";
import { LifecycleAudio } from "./LifecycleAudio";

export type CollectionAttachmentMedia = { kind: string; url: string; previewUrl?: string };

function attachmentName(url: string) {
  try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || "附件"); }
  catch { return "附件"; }
}

export function CollectionAttachment({media,itemKey,previewLabel,compact=false}:{media:CollectionAttachmentMedia;itemKey:string;previewLabel?:string;compact?:boolean}) {
  const [source,setSource]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{const refresh=(event:Event)=>{if((event as CustomEvent<string>).detail===itemKey)setRevision(v=>v+1);};window.addEventListener("hub:reading-attachment-ready",refresh);return()=>window.removeEventListener("hub:reading-attachment-ready",refresh);},[itemKey]);
  useEffect(()=>{
    let cancelled=false;setSource("");setError("");
    if(media.kind==="audio")void invoke<{source:string}>("collection_media_preview",{key:itemKey,url:media.url}).then(v=>{if(!cancelled)setSource(v.source);}).catch(e=>{if(!cancelled)setError(String(e));});
    return()=>{cancelled=true;};
  },[itemKey,media.url,media.kind,revision]);
  if(["photo","video","animated_gif"].includes(media.kind))return <PreviewMarkdownMedia key={revision} src={media.url} alt={previewLabel} collectionKey={itemKey} poster={media.previewUrl} provider="obsidian" spaceId="" documentId={itemKey}/>;
  const name = attachmentName(media.url);
  const open=async()=>{setBusy(true);setError("");try{await invoke("open_collection_attachment",{key:itemKey,url:media.url});}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <div className="collection-file"><button type="button" onClick={()=>void open()} disabled={busy}>{busy?<LoaderCircle className="spin" size={18}/>:media.kind==="audio"?<Music size={18}/>:<FileText size={18}/>}<span>{name}</span></button>{source&&<LifecycleAudio controls preload="none" src={source}/>}{(error||!compact)&&<small>{error||(!source&&media.kind==="audio"?"正在读取音频…":"点击打开本地附件")}</small>}</div>;
}

export function InlineReadingAttachment({ media, itemKey, local, size, onInspect }: {
  media: CollectionAttachmentMedia;
  itemKey: string;
  local: boolean;
  size?: number;
  onInspect?: () => void;
}) {
  const [downloaded, setDownloaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = local || downloaded;
  useEffect(() => { if (local) setDownloaded(false); }, [local]);
  const name = attachmentName(media.url);
  const video = media.kind === "video";
  const picture = ["photo", "animated_gif"].includes(media.kind);
  const sizeLabel = size && size > 0 ? (size / 1048576).toFixed(1) + " MB" : "";
  const status = [sizeLabel, ready ? "本机可用" : "未下载"].filter(Boolean).join(" · ");
  const download = async () => {
    setBusy(true);
    setError("");
    try {
      await invoke("transfer_reading_attachment", { key: itemKey, url: media.url, upload: false });
      setDownloaded(true);
      window.dispatchEvent(new CustomEvent("hub:reading-attachment-ready", { detail: itemKey }));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const actions = <><button type="button" className="reading-inline-download" disabled={busy} onClick={() => void download()}>
    {busy ? "正在下载…" : video ? "下载原视频" : picture ? "下载原图" : "下载"}
  </button>{error && <span className="reading-inline-error" role="status">{error}{onInspect && <button type="button" onClick={onInspect}>本文管理与核验</button>}</span>}</>;
  if (!video && !picture) {
    return <div className="reading-inline-file">
      {ready ? <div className="reading-inline-file-local"><CollectionAttachment media={media} itemKey={itemKey} compact/><small>{status}</small></div> :
        <><FileText size={17}/><div><strong>{name}</strong><small>{status}</small></div>{actions}</>}
    </div>;
  }
  const Icon = video ? Play : Image;
  return <figure className={"reading-inline-media" + (video ? " reading-inline-video" : "")}>
    {ready ? <CollectionAttachment media={media} itemKey={itemKey} previewLabel={video ? "原视频已就绪，点击播放" : name}/> :
      <div className="reading-inline-poster">
        {media.previewUrl && media.previewUrl !== media.url && <div className="reading-inline-thumbnail" inert><PreviewMarkdownMedia src={media.previewUrl} collectionKey={itemKey} alt="缩略图" provider="obsidian" spaceId="" documentId={itemKey}/></div>}
        <div className="reading-inline-poster-content"><Icon size={20}/><span>{video ? (media.previewUrl ? "缩略图预览 · 原视频未下载" : "原视频未下载") : "原图尚未下载到本机"}</span>{actions}</div>
      </div>}
    <figcaption><span>{name}</span><span>{status}</span></figcaption>
  </figure>;
}
