import { openCloudAgentLocalStorage } from "./CloudAgentLocalStorage";
import type { AgentContextMode, Upload, MaterialSnapshot } from "./CloudAgentMedia";
import type { ModelSelection } from "./CloudAgentPreferences";

export type ComposerDraft = {
  text: string;
  attachments: Upload[];
  material?: MaterialSnapshot;
  materials?: MaterialSnapshot[];
  contextMode?: AgentContextMode;
  skillVersion: string;
  skillPaths: string[];
  selection?: ModelSelection;
};
const prefix = (binding: string) => `composer-v1:${binding}:`;
export const composerDraftKey = (binding: string, thread: string) => prefix(binding) + thread;
let writes: Promise<void> = Promise.resolve();
export const flushComposerDrafts = () => writes;

export async function loadComposerDrafts(binding: string): Promise<Map<string, ComposerDraft>> {
  await writes;
  const db = await openCloudAgentLocalStorage();
  try {
    return await new Promise((resolve, reject) => {
      const result = new Map<string, ComposerDraft>();
      const tx = db.transaction("pending", "readonly");
      const cursor = tx.objectStore("pending").openCursor(IDBKeyRange.bound(prefix(binding), prefix(binding) + "\uffff"));
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        const value = row.value as ComposerDraft;
        if (typeof value?.text !== "string" || !Array.isArray(value.attachments) || typeof value.skillVersion !== "string" || !Array.isArray(value.skillPaths)) {
          tx.abort(); return;
        }
        result.set(String(row.key).slice(prefix(binding).length), value);
        row.continue();
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("本机草稿不可读，原数据已保留。"));
    });
  } finally { db.close(); }
}

export function saveComposerDraft(binding: string, thread: string, draft: ComposerDraft): Promise<void> {
  const operation = writes.then(async () => {
    const db = await openCloudAgentLocalStorage();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("pending", "readwrite");
        const store = tx.objectStore("pending");
        if (draft.text || draft.attachments.length || draft.material || (draft.materials && draft.materials.length > 0) || draft.skillVersion || draft.selection || (draft.contextMode && draft.contextMode !== "auto-rag")) store.put(draft, composerDraftKey(binding, thread));
        else store.delete(composerDraftKey(binding, thread));
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error || new Error("本机草稿尚未保存。"));
      });
    } finally { db.close(); }
  });
  // A failed save stays visible to its caller but must not block a later repair/send.
  writes = operation.catch(() => {});
  return operation;
}
