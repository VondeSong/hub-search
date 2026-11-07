import { LoaderCircle, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { LifecycleVideo } from "./LifecycleVideo";

type DeferredVideoProps = {
  src: string;
  title?: string;
};

type VideoPhase = "idle" | "loading" | "ready" | "error";

export function DeferredVideo({ src, title = "闪卡视频" }: DeferredVideoProps) {
  const [phase, setPhase] = useState<VideoPhase>("idle");

  useEffect(() => setPhase("idle"), [src]);

  if (phase === "idle" || phase === "error") {
    return <button
      type="button"
      className={`flashcards-deferred-video-trigger${phase === "error" ? " error" : ""}`}
      onClick={() => setPhase("loading")}
      aria-label={phase === "error" ? `重新加载视频：${title}` : `加载视频：${title}`}
    >
      <span><Play size={20} fill="currentColor" /></span>
      <strong>{phase === "error" ? "视频加载失败" : title}</strong>
      <small>{phase === "error" ? "点击重试" : "点击后才会读取视频"}</small>
    </button>;
  }

  return <div className="flashcards-deferred-video">
    <LifecycleVideo key={src}
      controls
      autoPlay
      preload="metadata"
      src={src}
      aria-label={title}
      onCanPlay={() => setPhase("ready")}
      onError={() => setPhase("error")}
    />
    {phase === "loading" && <span className="flashcards-deferred-video-status" role="status" aria-live="polite"><LoaderCircle className="spin" size={15} />正在加载视频…</span>}
  </div>;
}
