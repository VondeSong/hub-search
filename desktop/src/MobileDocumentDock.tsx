import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Layers, PenLine, Sparkles, SquareCheck } from "lucide-react";
import type { SearchResult } from "./SearchTypes";
import { loadComposerDrafts, saveComposerDraft, updateComposerDraft, type ComposerDraft } from "./CloudAgentDrafts";
import { exactPackedMaterialBytes, MAX_MATERIAL_BYTES, outbox, type MaterialSelectionKey, type MaterialSnapshot } from "./CloudAgentMedia";
import { mobileTasks, MobileTaskForm } from "./MobileInsightTasks";

const MAX_DOCK_MATERIALS = 8;
const sameMaterialKey = (a?: MaterialSelectionKey, b?: MaterialSelectionKey) =>
  Boolean(a && b && a.kind === b.kind && a.id === b.id && (a.libraryId ?? "") === (b.libraryId ?? ""));

function mergeDockMaterialDraft(
  existing: ComposerDraft | undefined,
  material: MaterialSnapshot,
  selection: MaterialSelectionKey,
): ComposerDraft {
  const currentMaterials = existing?.materials?.length
    ? existing.materials
    : existing?.material
      ? [existing.material]
      : [];
  const alreadyAdded = currentMaterials.some(item => item.id === material.id || sameMaterialKey(item.key, selection));
  let nextMaterials: MaterialSnapshot[];
  if (!alreadyAdded) {
    if (currentMaterials.length >= MAX_DOCK_MATERIALS) {
      throw new Error(`新对话草稿已达 ${MAX_DOCK_MATERIALS} 份资料上限，请先在助手中处理`);
    }
    if (currentMaterials.some(item => !item.key)) {
      throw new Error("新对话草稿中已有旧版单份材料，请先在助手中处理后再追加");
    }
    nextMaterials = [...currentMaterials, material];
  } else {
    nextMaterials = currentMaterials.map(item =>
      item.id === material.id || sameMaterialKey(item.key, selection) ? material : item,
    );
  }
  const packedBytes = typeof exactPackedMaterialBytes === "function"
    ? exactPackedMaterialBytes(nextMaterials, "manual")
    : nextMaterials.reduce((sum, item) => sum + new TextEncoder().encode(item.text).length, 0);
  if (packedBytes > (MAX_MATERIAL_BYTES || 48_000)) {
    throw new Error("加入此文档后草稿资料将超过 48 KB 上限，请先在助手中精简材料");
  }
  return {
    ...(existing || { text: "", attachments: [], skillVersion: "", skillPaths: [] }),
    material: nextMaterials[0],
    materials: nextMaterials,
    contextMode: "manual",
  };
}

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
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);
  const title = doc.documentTitle || doc.title;
  const source = [doc.libraryName || doc.spaceName, doc.path].filter(Boolean).join(" / ");
  const libraryId = doc.libraryId || doc.spaceId;
  const taskId = "document:" + JSON.stringify([doc.provider, libraryId, doc.documentId]);
  const excerpt = doc.snippet.trim() || body.trim().split(/\n\s*\n/u).find(p => p.trim() && !p.startsWith("#")) || "";
  async function perform(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setNotice("");
    try { await action(); } catch (error) { if (activeRef.current) setNotice(String(error)); }
    finally { lock.current = false; if (activeRef.current) setBusy(false); }
  }
  async function ask() {
    const config = await invoke<{binding:string} | null>("cloud_agents", {action:{op:"config"}});
    if (!activeRef.current) return;
    if (!config?.binding) throw new Error("请先在连接总览配置云端助手");
    const selection: MaterialSelectionKey = { kind: "document", id: doc.documentId, libraryId };
    const fetched = await invoke<MaterialSnapshot>("cloud_agents", {action:{op:"material", selection}});
    if (!activeRef.current) return;
    const material: MaterialSnapshot = { ...fetched, key: fetched.key ?? selection };
    if (typeof updateComposerDraft === "function") {
      await updateComposerDraft(config.binding, "new", ({ draft, hasPendingOutbox }) => {
        if (hasPendingOutbox) throw new Error("助手有待核对的消息，请先处理后再带入材料");
        return mergeDockMaterialDraft(draft, material, selection);
      });
    } else {
      if (await outbox(config.binding)) throw new Error("助手有待核对的消息，请先处理后再带入材料");
      const drafts = await loadComposerDrafts(config.binding);
      const next = mergeDockMaterialDraft(drafts.get("new"), material, selection);
      await saveComposerDraft(config.binding, "new", next);
    }
    if (!activeRef.current) return;
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
