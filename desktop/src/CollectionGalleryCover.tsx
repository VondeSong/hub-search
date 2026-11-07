import { invoke } from "@tauri-apps/api/core";
import { FileText, Film, ImageOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LifecycleVideo } from "./LifecycleVideo";

type CoverSource = { source: string; mediaType: string; mimeType: string };
const imageMime = (mime: string) => ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime);

export function CollectionGalleryCover({itemKey, media, saved, cloudPreview = false, text = ""}: {
  itemKey: string;
  media?: {url: string; kind: string; previewUrl?:string};
  saved: boolean;
  cloudPreview?: boolean;
  text?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<CoverSource | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const url = media?.previewUrl || media?.url;
  const isPreview = !!media?.previewUrl;
  const available = saved || (cloudPreview && isPreview);
  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<string>).detail === itemKey) setRevision(value => value + 1);
    };
    window.addEventListener("hub:reading-attachment-ready", refresh);
    return () => window.removeEventListener("hub:reading-attachment-ready", refresh);
  }, [itemKey]);
  useEffect(() => {
    setSource(null); setFailed(false);
    const element = ref.current;
    if (!element || !url || !available || (!isPreview && !["photo","video","animated_gif"].includes(media?.kind || ""))) return;
    let cancelled = false;
    let started = false;
    const observer = new IntersectionObserver(entries => {
      if (started || !entries.some(entry => entry.isIntersecting)) return;
      started = true;
      observer.disconnect();
      void invoke<CoverSource>("collection_media_preview", {key:itemKey, url})
        .then(value => {
          if (cancelled) return;
          const image = value.mediaType === "image" && value.mimeType.startsWith("image/");
          const video = value.mediaType === "video" && value.mimeType.startsWith("video/");
          if (!value.source || ((isPreview || cloudPreview) ? !image || !imageMime(value.mimeType) : !image && !video)) {
            setFailed(true);
            return;
          }
          setSource(value);
        })
        .catch(() => {if (!cancelled) setFailed(true);});
    }, {root:element.closest(".collection-database"),rootMargin:"120px"});
    observer.observe(element);
    return () => {cancelled=true;observer.disconnect();};
  }, [itemKey, url, media?.kind, available, isPreview, cloudPreview, revision]);
  const textOnly = !media && !!text.trim();
  return <div ref={ref} className={`collection-gallery-cover${textOnly ? " collection-gallery-cover-text" : ""}`} aria-hidden={!textOnly}>
    {textOnly ? <div className="collection-gallery-text">{text}</div> : source&&!failed ? source.mediaType === "image"
      ? <img src={source.source} alt="" loading="lazy" decoding="async" onError={()=>setFailed(true)}/>
      : <LifecycleVideo src={source.source} preload="metadata" muted playsInline onError={()=>setFailed(true)}/>
      : <span>{failed?<ImageOff size={26}/>:media&&["video","animated_gif"].includes(media.kind)?<Film size={26}/>:<FileText size={26}/>}<small>{failed?"封面不可用":!media?"文字":available&&isPreview?"正在载入缩略图":media.kind==="document"?"文件":media.kind==="audio"?"音频":!available?"附件未下载":media.kind==="photo"?"正在载入图片":"视频"}</small></span>}
    {media&&["video","animated_gif"].includes(media.kind)&&<span className="collection-gallery-video" title="视频"><Film size={13}/></span>}
  </div>;
}
