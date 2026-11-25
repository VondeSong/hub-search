import { invoke } from "@tauri-apps/api/core";
import { QUICK_JOURNAL_UPDATED } from "./QuickJournalEvents";
import { todayKey } from "./ActionEvidence";

export async function archiveAction(subject: string, text: string, date = todayKey()) {
  const bytes = new TextEncoder().encode(JSON.stringify(["axis-task-progress", subject, date, text]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const id = Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  const receipt = await invoke<{ id: string; warning?: string }>("capture_quick_journal", {
    record: { version: 1, id, date, text, attachments: [] },
  });
  if (receipt?.id !== id) throw Error("日志回执未确认，可重试同一份进展。");
  window.dispatchEvent(new Event(QUICK_JOURNAL_UPDATED));
  return receipt.warning ? "已记入本地日志，同步提醒：" + receipt.warning : "已记入今日日志";
}
