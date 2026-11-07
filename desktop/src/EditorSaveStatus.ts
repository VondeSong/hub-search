export function editorSaveErrorDetail(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : String(reason ?? "");
  const detail = raw.replace(/^Error:\s*/i, "").trim();
  return detail && detail !== "[object Object]" ? detail : "发生未知错误，请稍后重试";
}
