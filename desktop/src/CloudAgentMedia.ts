import { openCloudAgentLocalStorage } from "./CloudAgentLocalStorage";
import { composerDraftKey, flushComposerDrafts } from "./CloudAgentDrafts";

export type Upload = { name: string; mime: string; data: string; seconds?: number };
export type CloudSkillPayload = { name: string; version: string; manifestSha256: string; files: Record<string, { text: string; sha256: string }> };
export type MaterialSelectionKey = { kind: "document" | "journal" | string; id: string; libraryId: string | null };
export type MaterialSnapshot = { id: string; title: string; source: string; text: string; sha256: string; key?: MaterialSelectionKey };
export type AgentContextMode = "auto-rag" | "manual" | "cloud-only";
export type RecallMaterialsResult = { items: MaterialSnapshot[]; bundle: MaterialSnapshot | null; totalBytes: number; elapsedMs: number };
export type PrepareMaterialsResult = { bundle: MaterialSnapshot; items: MaterialSnapshot[]; totalBytes: number };
export type DraftTurn = {
  thread: string;
  turn: string;
  text: string;
  attachments: Upload[];
  created?: number;
  skill?: CloudSkillPayload;
  material?: MaterialSnapshot;
  sourceMaterials?: MaterialSnapshot[];
  selection?: import("./CloudAgentPreferences").ModelSelection;
  contextMode?: AgentContextMode;
};

export const MAX_MATERIAL_BYTES = 48_000;

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

export function formatMaterialKb(bytes: number): string {
  return (bytes / 1000).toFixed(1);
}

function sanitizeInlineMeta(input: string): string {
  return input.replace(/[\r\n]/g, " ").trim().split(/\s+/).filter(Boolean).join(" ");
}

function clipUtf8WithEllipsis(input: string, maxBytes: number): string {
  const trimmed = input.trim();
  if (utf8ByteLength(trimmed) <= maxBytes) return trimmed;
  const suffix = "…";
  const suffixBytes = utf8ByteLength(suffix);
  if (maxBytes <= suffixBytes) return "";
  let used = 0;
  let result = "";
  for (const ch of trimmed) {
    const len = utf8ByteLength(ch);
    if (used + len > maxBytes - suffixBytes) break;
    result += ch;
    used += len;
  }
  return result.trimEnd() + suffix;
}

/**
 * Exact byte length matching Rust `materials::pack_bundle` serialization so the
 * picker budget bar and server 48,000-byte limit never disagree.
 */
export function exactPackedMaterialBytes(
  items: { title: string; source: string; text: string }[],
  mode: "manual" | "auto-rag" = "manual",
): number {
  if (items.length === 0) return 0;
  if (items.length === 1 && mode === "manual") return utf8ByteLength(items[0].text);
  const headerTag = mode === "auto-rag"
    ? `【本机自动召回 · ${items.length} 份资料】\n\n`
    : `【手动指定 · ${items.length} 份资料】\n\n`;
  const sections = items.map((item, idx) => {
    const cleanTitle = clipUtf8WithEllipsis(sanitizeInlineMeta(item.title), 120) || "未命名资料";
    const cleanSource = clipUtf8WithEllipsis(sanitizeInlineMeta(item.source), 80) || "本机资料";
    return `### [资料${idx + 1}] ${cleanTitle}（${cleanSource}）\n${item.text.trim()}`;
  });
  return utf8ByteLength(`${headerTag}${sections.join("\n\n---\n\n")}`);
}

export function stripMaterialKey(item: MaterialSnapshot): MaterialSnapshot {
  return { id: item.id, title: item.title, source: item.source, text: item.text, sha256: item.sha256 };
}

export type ParsedMaterialBundle = {
  mode: "auto-rag" | "manual";
  items: { title: string; source: string; text: string }[];
  totalBytes: number;
};

export function parseMaterialBundle(material?: MaterialSnapshot): ParsedMaterialBundle | null {
  if (!material) return null;
  const totalBytes = utf8ByteLength(material.text);
  // Require matching bundle source metadata AND header banner so ordinary single
  // Markdown notes containing `---` or `### [资料2]` are never misparsed as bundles.
  const sourceMeta = /^(本机自动召回|手动指定)\s*·\s*(\d+)\s*份\s*·\s*/.exec(material.source);
  if (!sourceMeta) {
    return {
      mode: "manual",
      items: [{ title: material.title, source: material.source, text: material.text }],
      totalBytes,
    };
  }
  const mode: "auto-rag" | "manual" = sourceMeta[1] === "本机自动召回" ? "auto-rag" : "manual";
  const expectedCount = Number(sourceMeta[2]);
  const expectedBanner = mode === "auto-rag"
    ? `【本机自动召回 · ${expectedCount} 份资料】`
    : `【手动指定 · ${expectedCount} 份资料】`;
  if (!material.text.startsWith(expectedBanner)) {
    return {
      mode,
      items: [{ title: material.title, source: material.source, text: material.text }],
      totalBytes,
    };
  }
  const rest = material.text.slice(expectedBanner.length).replace(/^\n+/, "");
  const items: { title: string; source: string; text: string }[] = [];
  let cursor = 0;
  for (let i = 1; i <= expectedCount; i++) {
    const startMarker = `### [资料${i}] `;
    if (!rest.startsWith(startMarker, cursor)) break;
    const nextMarker = i < expectedCount ? `\n\n---\n\n### [资料${i + 1}] ` : "";
    const nextPos = nextMarker ? rest.indexOf(nextMarker, cursor + startMarker.length) : -1;
    const chunk = nextPos === -1 ? rest.slice(cursor) : rest.slice(cursor, nextPos);
    const firstBreak = chunk.indexOf("\n");
    const heading = (firstBreak === -1 ? chunk : chunk.slice(0, firstBreak)).trim();
    const body = firstBreak === -1 ? "" : chunk.slice(firstBreak + 1).trim();
    const match = /^### \[资料\d+\]\s+(.+)（([^）]+)）$/.exec(heading);
    if (match) items.push({ title: match[1].trim(), source: match[2].trim(), text: body });
    else items.push({ title: heading.replace(/^###\s*/, "") || material.title, source: material.source, text: body || chunk });
    if (nextPos === -1) break;
    cursor = nextPos + "\n\n---\n\n".length;
  }
  return {
    mode,
    items: items.length === expectedCount ? items : [{ title: material.title, source: material.source, text: material.text }],
    totalBytes,
  };
}

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

export async function outbox(binding: string, draft?: DraftTurn | null, expectedTurn?: string, composerThread?: string): Promise<DraftTurn | undefined> {
  await flushComposerDrafts();
  const db = await openCloudAgentLocalStorage();
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
            if (composerThread !== undefined) store.delete(composerDraftKey(binding, composerThread));
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
