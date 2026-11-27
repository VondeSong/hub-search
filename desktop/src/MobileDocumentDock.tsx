import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Layers, PenLine, Sparkles, SquareCheck } from "lucide-react";
import type { SearchResult } from "./SearchTypes";
import { loadComposerDrafts, saveComposerDraft } from "./CloudAgentDrafts";
import { outbox, type MaterialSnapshot } from "./CloudAgentMedia";
import { mobileTasks, MobileTaskForm } from "./MobileInsightTasks";

type Props = {
  document: SearchResult;
  body: string;
  onAgents: () => void;
  onCapture: (citation: string) => void;
  onTask: (id: string) => void;
};

export function MobileDocumentDock({document: doc, body, onAgents, onCapture, onTask}: Props) {
  const [compose, setCompose] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [cardCreated,setCardCreated] = useState(false);
  const lock = useRef(false);
  const title = doc.documentTitle || doc.title;
  const source = [doc.libraryName || doc.spaceName, doc.path].filter(Boolean).join(" / ");
  const libraryId = doc.libraryId || doc.spaceId;
  const taskId = "document:" + JSON.stringify([doc.provider, libraryId, doc.documentId]);
  const excerpt = doc.snippet.trim() || body.trim().split(/\n\s*\n/u).find(p => p.trim() && !p.startsWith("#")) || "";
  async function perform(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setNotice("");
    try { await action(); } catch (error) { setNotice(String(error)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function ask() {
    const config = await invoke<{binding:string} | null>("cloud_agents", {action:{op:"config"}});
    if (!config?.binding) throw new Error("请先在连接总览配置云端助手");
    if (await outbox(config.binding)) throw new Error("助手有待核对的消息，请先处理后再带入材料");
    const drafts = await loadComposerDrafts(config.binding);
    const existing = drafts.get("new");
    const material = await invoke<MaterialSnapshot>("cloud_agents", {action:{op:"material", selection:{kind:"document", id:doc.documentId, libraryId}}});
    if (existing?.material && existing.material.id !== material.id)
      throw new Error("新对话草稿中已有另一份材料，请先在助手中处理");
    await saveComposerDraft(config.binding, "new", {...(existing || {text:"",attachments:[],skillVersion:"",skillPaths:[]}), material});
    localStorage.setItem("hub-cloud-last:" + config.binding, JSON.stringify({view:"new"}));
    onAgents();
  }
  async function makeCard() {
    if (!excerpt) throw new Error("正文中暂无可提炼的段落");
    await invoke("create_flashcard_draft", {question:`《${title}》的核心要点是什么？`,answer:excerpt,explanation:"",cardType:"qa",sourceTitle:title,sourcePath:source});
    setCardCreated(true);
    setNotice("已加入闪卡收件箱");
  }
  return <div className="bw-doc-actions">
    {notice && <p role="status">{notice}</p>}
    <nav aria-label="文档操作">
      <button disabled={busy} onClick={() => void perform(ask)}><Sparkles/>问助手</button>
      <button onClick={() => onCapture(["《"+title+"》",source,excerpt].filter(Boolean).join("\n"))}><PenLine/>记想法</button>
      <button onClick={() => mobileTasks().some(task => task.id === taskId) ? onTask(taskId) : setCompose(true)}><SquareCheck/>转任务</button>
      <button disabled={busy || !excerpt || cardCreated} onClick={() => void perform(makeCard)}><Layers/>提炼卡</button>
    </nav>
    {compose && <MobileTaskForm origin={{id:taskId,title,source,note:excerpt}} onCancel={() => setCompose(false)} onSave={task => {setCompose(false);onTask(task.id);}}/>}
  </div>;
}
