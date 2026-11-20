type FileBridge = EventTarget & {
  postMessageWithAdditionalObjects(message: string, files: File[]): void;
};

export async function attachmentFolders(files: File[]): Promise<string[][]> {
  const fallback = files.map(file => (file.webkitRelativePath || "").split("/").slice(-3, -1));
  const bridge = (window as Window & {chrome?: {webview?: FileBridge}}).chrome?.webview;
  if (!files.length || !bridge?.postMessageWithAdditionalObjects) return fallback;
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    const finish = (folders: string[][]) => {
      clearTimeout(timer);
      bridge.removeEventListener("message", receive);
      resolve(folders);
    };
    const receive = (event: Event) => {
      const reply = (event as MessageEvent).data;
      if (reply?.attachmentFoldersId !== id || !Array.isArray(reply.folders)) return;
      finish(fallback.map((names, i) => reply.folders[i]?.length ? reply.folders[i] : names));
    };
    const timer = setTimeout(() => finish(fallback), 1500);
    bridge.addEventListener("message", receive);
    try { bridge.postMessageWithAdditionalObjects("hub-attachment-folders:" + id, files); }
    catch { finish(fallback); }
  });
}
