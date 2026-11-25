import { useEffect, useRef, useState } from "react";

export function useJournalDesktopRecording(onFile: (file: File) => void, onError: (error: string) => void) {
  const [state, setState] = useState<"idle" | "opening" | "recording" | "finishing">("idle");
  const active = useRef<MediaRecorder | null>(null);
  const generation = useRef(0);

  function release() {
    generation.current++;
    active.current?.stream.getTracks().forEach(track => track.stop());
    active.current = null;
  }
  useEffect(() => release, []);

  function cancel() {
    release();
    setState("idle");
  }

  async function start() {
    if (state !== "idle") return;
    const request = ++generation.current;
    setState("opening");
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (request !== generation.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const recorder = active.current = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      let size = 0;
      recorder.ondataavailable = event => {
        if (request !== generation.current) return;
        size += event.data.size;
        if (size > 20 * 1024 * 1024) {
          cancel();
          onError("录音超过单个附件的 20 MB 限制");
        } else if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (request !== generation.current) return;
        cancel();
        onError("录音中断，请检查麦克风");
      };
      recorder.onstop = () => {
        recorder.stream.getTracks().forEach(track => track.stop());
        if (request !== generation.current) return;
        active.current = null;
        setState("idle");
        if (!size) return;
        const type = recorder.mimeType;
        const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        onFile(new File(chunks, `语音-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, { type }));
      };
      recorder.start(1000);
      setState("recording");
    } catch {
      stream?.getTracks().forEach(track => track.stop());
      if (request !== generation.current) return;
      active.current = null;
      setState("idle");
      onError("无法启动录音，请检查麦克风和访问权限");
    }
  }

  function finish() {
    if (active.current?.state !== "recording") return;
    setState("finishing");
    active.current.stop();
  }

  return { state, start, cancel, finish };
}
