import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { publishCodexNotice } from "./CodexSuite";
import { INHERIT_LIBRARY_POLICY, type LibraryContentOverrides, type LibraryContentPolicy, type LibraryPolicySnapshot } from "./LibraryManagement";
import "./LibraryManagement.css";

const FIELDS: { key: keyof LibraryContentPolicy; label: string; hint: string }[] = [
  { key: "imageDownload", label: "下载图片原件", hint: "保存图片供预览；与文字识别独立" },
  { key: "imageOcr", label: "图片文字识别", hint: "识别已下载到 Hub 的图片文字并加入搜索" },
  { key: "pdfDownload", label: "下载 PDF 原件", hint: "保存 PDF 供预览；与文字提取独立" },
  { key: "pdfText", label: "PDF 原生文字", hint: "提取已缓存到 Hub 的 PDF 原生文字并加入搜索" },
  { key: "pdfOcr", label: "PDF 扫描页识别", hint: "识别已缓存到 Hub 的 PDF 扫描页文字" },
  { key: "otherDownload", label: "视频与其他附件下载", hint: "只保存原件，不分析视频" },
  { key: "outgoingAttachments", label: "写入时携带附件", hint: "控制收藏及任务写入此库时的附件，不影响正文" },
];
export function LibraryContentPolicyFields({ value, global, capabilities, globalMode = false, automaticOriginals = false, disabled = false, onChange }: {
  value: LibraryContentOverrides; global?: LibraryContentPolicy; capabilities: LibraryContentPolicy; globalMode?: boolean; automaticOriginals?: boolean; disabled?: boolean;
  onChange: (value: LibraryContentOverrides) => void;
}) {
  return <div className="library-content-policy-fields">{automaticOriginals && <p>图片、PDF、视频和其他附件原件自动保存在当前 Hub 数据目录。</p>}{FIELDS.filter(({ key }) => !automaticOriginals || !["imageDownload", "pdfDownload", "otherDownload"].includes(key)).map(({ key, label, hint }) => <label key={key}>
    <span><strong>{label}</strong><small>{capabilities[key] ? hint : "此来源暂不支持"}</small></span>
    <select aria-label={label} value={value[key] === null ? "inherit" : value[key] ? "enabled" : "disabled"} disabled={disabled || !capabilities[key]} onChange={event => onChange({ ...value, [key]: event.target.value === "inherit" ? null : event.target.value === "enabled" })}>
      {!globalMode && <option value="inherit">沿用全局{global ? `（${global[key] ? "开启" : "关闭"}）` : ""}</option>}
      <option value="enabled">开启</option><option value="disabled">关闭</option>
    </select>
  </label>)}</div>;
}

export function LibraryContentPolicyEditor({ libraryId, onSaved, disabled = false }: { libraryId?: string; onSaved?: () => void | Promise<unknown>; disabled?: boolean }) {
  const [snapshot, setSnapshot] = useState<LibraryPolicySnapshot>();
  const [draft, setDraft] = useState<LibraryContentOverrides>({ ...INHERIT_LIBRARY_POLICY });
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const readRevision = useRef(0);
  const read = async () => {
    const revision = ++readRevision.current;
    setBusy(true);
    try {
      const result = await invoke<LibraryPolicySnapshot>("library_content_policy", { args: { action: "get", libraryId } });
      if (revision !== readRevision.current) return;
      setSnapshot(result); setDraft(libraryId ? result.overrides : result.global); setLoaded(true); setDirty(false);
    } catch (reason) { if (revision === readRevision.current) publishCodexNotice(`读取内容策略失败：${String(reason)}`, "error", 10000); }
    finally { if (revision === readRevision.current) setBusy(false); }
  };
  useEffect(() => { setSnapshot(undefined); setLoaded(false); setDirty(false); void read(); return () => { readRevision.current++; }; }, [libraryId]);
  const save = async () => {
    setBusy(true);
    try {
      const result = await invoke<LibraryPolicySnapshot>("library_content_policy", { args: { action: "save", libraryId, policy: draft } });
      setSnapshot(result); setDraft(libraryId ? result.overrides : result.global); setDirty(false);
      if (!libraryId) window.dispatchEvent(new CustomEvent("hub:library-content-policy-changed"));
      publishCodexNotice("内容策略已保存，后续处理使用新策略", "success");
      await onSaved?.();
    } catch (reason) { publishCodexNotice(`保存内容策略失败：${String(reason)}`, "error", 10000); }
    finally { setBusy(false); }
  };
  const supplement = async () => {
    setBusy(true);
    try {
      const result = await invoke<{ queued: number; notice: string }>("library_content_policy", { args: { action: "supplement", libraryId } });
      publishCodexNotice(result.notice || `已加入 ${result.queued} 项补处理`, "success");
      await onSaved?.();
    } catch (reason) { publishCodexNotice(`补处理未提交：${String(reason)}`, "error", 10000); }
    finally { setBusy(false); }
  };
  return <section className="library-content-policy" aria-label={libraryId ? "资料库内容策略" : "全局内容策略"}>
    <h3>{libraryId ? "内容策略" : "全局下载与识别"}</h3>
    <p>正文始终保留。Craft 和滴答的原件自动保存；文字识别与写入附件分别控制。其他来源使用下方下载策略。</p>
    {snapshot && <LibraryContentPolicyFields value={draft} global={snapshot.global} capabilities={snapshot.capabilities} globalMode={!libraryId} automaticOriginals={snapshot.provider === "craft" || snapshot.provider === "dida365"} disabled={busy || disabled} onChange={value => { setDraft(value); setDirty(true); }} />}
    <div className="library-management-panel-actions">
      {!loaded && <button className="maintenance-button" disabled={busy} onClick={() => void read()}>{busy ? "正在读取…" : "重新读取内容策略"}</button>}
      <button className="maintenance-button" disabled={!loaded || busy || disabled || !dirty} onClick={() => void save()}>{busy && dirty ? "正在保存…" : "保存内容策略"}</button>
      {libraryId && snapshot && Object.values(snapshot.capabilities).some(Boolean) && <button className="maintenance-button" disabled={busy || disabled || dirty} onClick={() => void supplement()}>按当前策略补处理已有内容</button>}
    </div>
  </section>;
}
