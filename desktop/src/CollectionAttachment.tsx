import { invoke } from "@tauri-apps/api/core";
import { FileText, LoaderCircle, Music } from "lucide-react";
import { useEffect, useState } from "react";
import { PreviewMarkdownMedia } from "./PreviewMarkdown";
import { LifecycleAudio } from "./LifecycleAudio";

export function CollectionAttachment({media,itemKey}:{media:{kind:string;url:string;previewUrl?:string};itemKey:string}) {
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
  if(["photo","video","animated_gif"].includes(media.kind))return <PreviewMarkdownMedia key={revision} src={media.url} collectionKey={itemKey} poster={media.previewUrl} provider="obsidian" spaceId="" documentId={itemKey}/>;
  let name="附件";try{name=decodeURIComponent(new URL(media.url).pathname.split("/").pop()||"附件");}catch{/* Preserve a usable attachment label. */}
  const open=async()=>{setBusy(true);setError("");try{await invoke("open_collection_attachment",{key:itemKey,url:media.url});}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <div className="collection-file"><button type="button" onClick={()=>void open()} disabled={busy}>{busy?<LoaderCircle className="spin" size={18}/>:media.kind==="audio"?<Music size={18}/>:<FileText size={18}/>}<span>{name}</span></button>{source&&<LifecycleAudio controls preload="none" src={source}/>}<small>{error||(!source&&media.kind==="audio"?"正在读取音频…":"点击打开本地附件")}</small></div>;
}
