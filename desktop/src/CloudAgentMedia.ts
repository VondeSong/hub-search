export type Upload = { name: string; mime: string; data: string; seconds?: number };
export type CloudSkillPayload = { name: string; version: string; manifestSha256: string; files: Record<string, { text: string; sha256: string }> };
export type MaterialSnapshot={id:string;title:string;source:string;text:string;sha256:string};
export type DraftTurn = { thread: string; turn: string; text: string; attachments: Upload[]; created?: number; skill?: CloudSkillPayload; material?:MaterialSnapshot; selection?: import("./CloudAgentPreferences").ModelSelection };

function encode(blob: Blob, name: string, seconds?: number): Promise<Upload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取附件。"));
    reader.onload = () => resolve({ name, mime: blob.type, data: String(reader.result).split(",", 2)[1], seconds });
    reader.readAsDataURL(blob);
  });
}

export function uploadSize(uploads: Upload[]) {
  return uploads.reduce((sum, file) => sum + Math.floor(file.data.length * 3 / 4) - (file.data.match(/=+$/)?.[0].length ?? 0), 0);
}

export async function imageUpload(file: File): Promise<Upload> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("请选择 JPEG、PNG 或 WebP 图片。");
  if (file.size <= 4 * 1024 * 1024) return encode(file, file.name);
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1800 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前设备无法缩小图片。");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob || blob.size > 4 * 1024 * 1024) throw new Error("无法把图片缩小到 4 MiB 以内。");
    return encode(blob, file.name.replace(/\.[^.]+$/, "") + ".jpg");
  } finally {
    image.close();
  }
}

function mediaEvent(video: HTMLVideoElement, event: "loadeddata" | "seeked", start: () => void) {
  return new Promise<void>((resolve, reject) => {
    const finish = (ok: boolean) => {
      clearTimeout(timeout);
      video.removeEventListener(event, loaded);
      video.removeEventListener("error", failed);
      if (ok) resolve(); else reject(new Error("这段视频无法在当前设备解码或抽帧。"));
    };
    const loaded = () => finish(true);
    const failed = () => finish(false);
    const timeout = setTimeout(failed, 10000);
    video.addEventListener(event, loaded);
    video.addEventListener("error", failed);
    start();
  });
}

export function sampleTimes(duration: number, limit: number) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 30 || limit < 1) return [];
  const count = Math.min(limit, Math.ceil(duration));
  return Array.from({ length: count }, (_, i) => duration * (i + 0.5) / count);
}

function drawVideoFrame(video: HTMLVideoElement, seconds: number, context: CanvasRenderingContext2D, canvas: HTMLCanvasElement) {
  return new Promise<number>((resolve, reject) => {
    if (typeof video.requestVideoFrameCallback !== "function") {
      reject(new Error("当前设备不支持可靠的视频抽帧，请更新系统 WebView 或改为选择图片。"));
      return;
    }
    let callback = 0;
    const failed = () => {
      clearTimeout(timeout);
      video.cancelVideoFrameCallback(callback);
      video.removeEventListener("error", failed);
      reject(new Error("这段视频无法在当前设备解码或抽帧。"));
    };
    const timeout = setTimeout(failed, 10000);
    const draw: VideoFrameRequestCallback = (_, metadata) => {
      if (video.seeking) { callback = video.requestVideoFrameCallback(draw); return; }
      clearTimeout(timeout);
      video.removeEventListener("error", failed);
      // A seeked event can precede the decoded frame on Android WebView.
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve(metadata.mediaTime);
      } catch (error) { reject(error); }
    };
    video.addEventListener("error", failed);
    try {
      callback = video.requestVideoFrameCallback(draw);
      video.currentTime = seconds;
    } catch { failed(); }
  });
}

export async function videoUploads(file: File, limit: number): Promise<Upload[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(file);
  try {
    await mediaEvent(video, "loadeddata", () => { video.src = url; });
    const times = sampleTimes(video.duration, limit);
    if (!times.length || !video.videoWidth || !video.videoHeight) throw new Error("请选择 30 秒以内且可解码的短视频。");
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前设备无法提取视频画面。");
    const frames: Upload[] = [];
    for (const seconds of times) {
      const frameTime = await drawVideoFrame(video, seconds, context, canvas);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.82));
      if (!blob) throw new Error("无法保存视频关键帧。");
      frames.push(await encode(blob, file.name, Number(frameTime.toFixed(2))));
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function outbox(binding: string, draft?: DraftTurn | null, expectedTurn?: string): Promise<DraftTurn | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("hub-cloud-agents-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("pending");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("pending", draft === undefined ? "readonly" : "readwrite");
      const store = transaction.objectStore("pending");
      const existing = store.get(binding);
      let conflict = false;
      existing.onsuccess = () => {
        if (draft === null && (!expectedTurn || existing.result?.turn === expectedTurn)) store.delete(binding);
        if (draft) {
          if (existing.result && existing.result.turn !== draft.turn) {
            conflict = true;
            transaction.abort();
          } else {
            store.put(draft, binding);
          }
        }
      };
      transaction.oncomplete = () => resolve(draft === undefined ? existing.result : undefined);
      transaction.onabort = transaction.onerror = () => reject(conflict ? new Error("另有一条消息待确认，请先核对它。") : transaction.error);
    });
  } finally {
    db.close();
  }
}
