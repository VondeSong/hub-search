import { invoke } from "@tauri-apps/api/core";
import {
  FileText,
  Film,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Play,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Provider } from "./ProviderLabels";
import { formatFileSize } from "./FileFormatting";
import { LifecycleVideo } from "./LifecycleVideo";
import { useModalFocus } from "./useModalFocus";

type MarkdownMediaPreview = {
  source: string;
  mimeType: string;
  mediaType: "image" | "video";
};

type MarkdownResourceInfo = {
  title: string;
  mimeType: string;
  resourceType: "image" | "video" | "file";
  size?: number;
};

function usePreviewNearViewport<T extends HTMLElement>() {
  const elementRef = useRef<T>(null);
  const [nearViewport, setNearViewport] = useState(false);
  useEffect(() => {
    const element = elementRef.current;
    if (!element || nearViewport) return;
    const root = element.closest(".preview-content");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { root, rootMargin: "320px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [nearViewport]);
  return [elementRef, nearViewport] as const;
}

export function PreviewMarkdownMedia({
  src,
  alt,
  provider,
  spaceId,
  documentId,
  collectionKey,
  poster,
}: {
  src?: string;
  alt?: string;
  provider: Provider;
  spaceId: string;
  documentId: string;
  collectionKey?: string;
  poster?: string;
}) {
  const [viewportRef, nearViewport] = usePreviewNearViewport<HTMLSpanElement>();
  const [info, setInfo] = useState<MarkdownResourceInfo | undefined>();
  const [media, setMedia] = useState<MarkdownMediaPreview | undefined>(
    src?.startsWith("data:") ? { source: src, mimeType: "image/png", mediaType: "image" } : undefined,
  );
  const [videoCover,setVideoCover]=useState<string>();
  const [posterSource,setPosterSource]=useState<string>();
  const [videoActivated, setVideoActivated] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  const [imageExpanded, setImageExpanded] = useState(false);
  const [failed, setFailed] = useState("");
  const videoGeneration = useRef(0);
  const imageModalRef = useRef<HTMLDivElement>(null);
  useModalFocus({ active: imageExpanded, containerRef: imageModalRef, onDismiss: () => setImageExpanded(false) });

  useEffect(()=>{
    let cancelled=false;setPosterSource(undefined);
    if(nearViewport&&collectionKey&&poster)void invoke<MarkdownMediaPreview>("collection_media_preview",{key:collectionKey,url:poster}).then(value=>{if(!cancelled&&value.mediaType==="image")setPosterSource(value.source);}).catch(()=>{});
    return()=>{cancelled=true;};
  },[nearViewport,collectionKey,poster]);

  useEffect(() => {
    videoGeneration.current++;
    if (!nearViewport) return;
    let cancelled = false;
    const cancel = () => { cancelled = true; videoGeneration.current++; };
    setFailed("");
    setVideoCover(undefined);
    setInfo(undefined);
    setVideoActivated(false);
    setVideoLoading(false);
    setImageExpanded(false);
    if (!src || src.startsWith("data:")) {
      setMedia(src ? { source: src, mimeType: "image/png", mediaType: "image" } : undefined);
      return cancel;
    }
    setMedia(undefined);
    if (collectionKey) {
      void invoke<MarkdownMediaPreview>("collection_media_preview", {key: collectionKey, url: src})
        .then(value => {
          if (cancelled) return;
          setInfo({ title: "播放视频", mimeType: value.mimeType, resourceType: value.mediaType });
          if (value.mediaType === "image") setMedia(value); else setVideoCover(value.source);
        }).catch(reason => { if (!cancelled) setFailed(String(reason)); });
      return cancel;
    }
    const arguments_ = {
      provider,
      spaceId,
      documentId,
      source: src,
    };
    void invoke<MarkdownResourceInfo>("local_markdown_resource_info", arguments_)
      .then(value => value, () => undefined)
      .then((resolvedInfo) => {
        if (cancelled) return;
        if (resolvedInfo) setInfo(resolvedInfo);
        if (resolvedInfo?.resourceType === "video") return;
        return invoke<MarkdownMediaPreview>("local_markdown_image", arguments_)
          .then((resolvedMedia) => {
            if (!cancelled) setMedia(resolvedMedia);
          });
      }).catch((reason) => {
      if (cancelled) return;
      if (String(reason).includes("VIDEO_REQUIRES_ACTIVATION")) {
        setInfo({ title: alt || "播放视频", mimeType: "video/mp4", resourceType: "video" });
        return;
      }
      if (/^https?:\/\//i.test(src) && provider === "obsidian") {
        setMedia({ source: src, mimeType: "image/*", mediaType: "image" });
      } else {
        setFailed(String(reason).replace(/^Error:\s*/, "") || "媒体暂时无法加载");
      }
    });
    return cancel;
  }, [collectionKey, documentId, nearViewport, provider, spaceId, src]);

  const activateVideo = () => {
    if (!src || videoActivated || videoLoading) return;
    const generation = videoGeneration.current;
    setVideoActivated(true);
    setVideoLoading(true);
    void (collectionKey
      ? invoke<MarkdownMediaPreview>("collection_media_preview", {key: collectionKey, url: src})
      : invoke<MarkdownMediaPreview>("local_markdown_image", {provider, spaceId, documentId, source: src, allowVideo: true})
    ).then(value => { if (videoGeneration.current === generation) setMedia(value); }).catch((reason) => {
      if (videoGeneration.current !== generation) return;
      setVideoActivated(false);
      setFailed(String(reason).replace(/^Error:\s*/, "") || "媒体暂时无法加载");
    }).finally(() => { if (videoGeneration.current === generation) setVideoLoading(false); });
  };

  if (!nearViewport) {
    return <span ref={viewportRef} className="preview-media-deferred">
      <ImagePlus size={18} />
      滚动到此处加载媒体
    </span>;
  }
  if (failed) return <span className="preview-image-error">{posterSource?<img src={posterSource} alt="视频封面" style={{maxWidth:"100%",borderRadius:8}}/>:<ImagePlus size={16} />}<span>{failed}</span></span>;
  if (info?.resourceType === "video" && !media) {
    return <button type="button" className="preview-video-poster" onClick={activateVideo}>
      <span className="preview-video-cover" style={posterSource||videoCover?{position:"absolute",inset:0,opacity:1,transform:"none"}:undefined}>{posterSource?<img src={posterSource} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:videoCover?<LifecycleVideo src={`${videoCover}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" style={{width:"100%",height:"100%",objectFit:"cover"}}/>:<Film size={34} />}</span>
      <span className={`preview-video-play${videoLoading ? " loading" : ""}`}>
        {videoLoading ? <LoaderCircle className="spin" size={24} /> : <Play size={22} fill="currentColor" />}
      </span>
      <span className="preview-video-label">{videoLoading ? "正在准备视频…" : alt || info.title || "播放视频"}</span>
    </button>;
  }
  if (!media) return <span className="preview-image-loading"><LoaderCircle className="spin" size={16} />正在读取媒体…</span>;
  if (media.mediaType === "video") {
    return <LifecycleVideo key={media.source} className="preview-video" controls autoPlay preload="metadata" onError={() => setFailed("视频文件无法播放")}>
      <source src={media.source} type={media.mimeType} />
      当前系统无法播放此视频。
    </LifecycleVideo>;
  }
  return <>
    <button type="button" className="preview-image-zoom" onClick={() => setImageExpanded(true)} title="查看大图">
      <img src={media.source} alt={alt || "图片"} loading="lazy" decoding="async" onError={() => setFailed("图片数据无法解码")} />
      <span><Maximize2 size={15} />查看大图</span>
    </button>
    {imageExpanded && <div ref={imageModalRef} tabIndex={-1} className="preview-image-lightbox" role="dialog" aria-modal="true" aria-label={alt || "图片预览"} onMouseDown={(event) => {
      if (event.target === event.currentTarget) setImageExpanded(false);
    }}>
      <button type="button" className="preview-image-lightbox-close" onClick={() => setImageExpanded(false)} aria-label="关闭图片预览"><X size={22} /></button>
      <img src={media.source} alt={alt || "图片"} />
      {alt && <p>{alt}</p>}
    </div>}
  </>;
}

export const ATTACHMENT_EXTENSIONS = new Set([
  "xlsx", "xls", "docx", "doc", "pptx", "ppt", "pdf", "md", "txt", "log", "zip",
  "mp4", "m4v", "mov", "webm", "mp3", "m4a", "wav", "ogg",
]);

export function markdownNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(markdownNodeText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return markdownNodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

export function attachmentExtension(value: string): string {
  const raw = value.split(/[?#]/)[0] ?? "";
  let clean = raw;
  try {
    clean = decodeURIComponent(raw);
  } catch {
    // Keep the original label when a file name contains a stray percent sign.
  }
  clean = clean.trim();
  return clean.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ?? "";
}

export function PreviewAttachmentLink({
  href,
  label,
  provider,
  spaceId,
  documentId,
  onOpen,
}: {
  href: string;
  label: string;
  provider: Provider;
  spaceId: string;
  documentId: string;
  onOpen: (href?: string) => void;
}) {
  const [viewportRef, nearViewport] = usePreviewNearViewport<HTMLAnchorElement>();
  const [info, setInfo] = useState<MarkdownResourceInfo | undefined>();
  const [openError, setOpenError] = useState("");
  useEffect(() => {
    if (!nearViewport) return;
    let cancelled = false;
    void invoke<MarkdownResourceInfo>("local_markdown_resource_info", {
      provider,
      spaceId,
      documentId,
      source: href,
    }).then((value) => {
      if (!cancelled) setInfo(value);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [documentId, href, nearViewport, provider, spaceId]);
  const title = info?.title || label;
  const extension = attachmentExtension(title) || attachmentExtension(label) || "file";
  const typeLabel = extension === "md" || extension === "txt" || extension === "log"
    ? "Text File"
    : `${extension.toUpperCase()} ${extension === "pdf" ? "Document" : "File"}`;
  return <a
    ref={viewportRef}
    className="preview-attachment-card"
    href={href}
    onClick={(event) => {
      event.preventDefault();
      setOpenError("");
      if (provider === "craft") {
        void invoke<boolean>("open_craft_attachment", { spaceId, documentId, source: href })
          .then(opened => { if (!opened) onOpen(href); })
          .catch(reason => setOpenError(String(reason)));
      } else onOpen(href);
    }}
  >
    <span className="preview-file-icon" data-extension={extension}>
      <FileText size={37} strokeWidth={1.35} />
      <small>{extension.toUpperCase()}</small>
    </span>
    <span className="preview-file-details">
      <strong>{title}</strong>
      <span>{typeLabel}</span>
      {info?.size !== undefined && <span>{formatFileSize(info.size)}</span>}
      {openError && <span role="alert">{openError}</span>}
    </span>
  </a>;
}
