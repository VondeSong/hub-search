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

function shouldPersistDraft(draft: ComposerDraft): boolean {
  return Boolean(
    draft.text
    || draft.attachments.length
    || draft.material
    || (draft.materials && draft.materials.length > 0)
    || draft.skillVersion
    || draft.selection
    || (draft.contextMode && draft.contextMode !== "auto-rag"),
  );
}

export function saveComposerDraft(binding: string, thread: string, draft: ComposerDraft): Promise<void> {
  const operation = writes.then(async () => {
    const db = await openCloudAgentLocalStorage();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("pending", "readwrite");
        const store = tx.objectStore("pending");
        if (shouldPersistDraft(draft)) store.put(draft, composerDraftKey(binding, thread));
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

/**
 * Atomically checks pending outbox + reads the latest composer draft + writes
 * the merged draft in a single IndexedDB readwrite transaction so concurrent
 * cross-module "Ask Agent" actions never overwrite each other.
 */
export function updateComposerDraft(
  binding: string,
  thread: string,
  updater: (state: { draft?: ComposerDraft; hasPendingOutbox: boolean }) => ComposerDraft,
): Promise<ComposerDraft> {
  const operation = writes.then(async () => {
    const db = await openCloudAgentLocalStorage();
    try {
      return await new Promise<ComposerDraft>((resolve, reject) => {
        const tx = db.transaction("pending", "readwrite");
        const store = tx.objectStore("pending");
        const outboxReq = store.get(binding);
        const draftReq = store.get(composerDraftKey(binding, thread));
        let outboxReady = false;
        let draftReady = false;
        let hasPendingOutbox = false;
        let existingDraft: ComposerDraft | undefined;
        let resultDraft: ComposerDraft | undefined;
        let userError: unknown = null;

        const finishRead = () => {
          if (!outboxReady || !draftReady) return;
          try {
            resultDraft = updater({ draft: existingDraft, hasPendingOutbox });
            if (shouldPersistDraft(resultDraft)) store.put(resultDraft, composerDraftKey(binding, thread));
            else store.delete(composerDraftKey(binding, thread));
          } catch (error) {
            userError = error;
            tx.abort();
          }
        };

        outboxReq.onsuccess = () => {
          hasPendingOutbox = Boolean(outboxReq.result);
          outboxReady = true;
          finishRead();
        };
        draftReq.onsuccess = () => {
          const val = draftReq.result as ComposerDraft | undefined;
          if (val && typeof val.text === "string" && Array.isArray(val.attachments)) {
            existingDraft = val;
          }
          draftReady = true;
          finishRead();
        };
        tx.oncomplete = () => resolve(resultDraft!);
        tx.onerror = tx.onabort = () => reject(userError ?? tx.error ?? new Error("本机草稿尚未保存。"));
      });
    } finally { db.close(); }
  });
  writes = operation.then(() => undefined, () => undefined);
  return operation;
}
