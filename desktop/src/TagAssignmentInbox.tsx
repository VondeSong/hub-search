import { userProfileStorage } from "./UserProfileStorage";
import { invoke } from "@tauri-apps/api/core";
import { isWindowVisible, subscribeWindowVisibility } from "./WindowVisibility";
import { useCallback, useEffect, useRef, useState } from "react";
import { proposalEvidenceSearchResult, type ProposalEvidence } from "./TagGovernanceInbox";
import type { SearchResult } from "./SearchTypes";
import "./TagAssignmentInbox.css";
import { TagAssignmentExclusion } from "./TagAssignmentExclusion";
import { TagAssignmentExclusionList } from "./TagAssignmentExclusionList";
import { TagSourceWriteback } from "./TagSourceWriteback";
import { BookOpen } from "lucide-react";
import { providerName } from "./ProviderLabels";
import { CodexDefinitionModel } from "./CodexDefinitionModel";
import { publishCodexNotice, useCodexSuite } from "./CodexSuite";

import { CodexContentScan } from "./CodexContentScan";
import { TagContentScanPanel } from "./TagContentScanPanel";
import { TagTaskActivity } from "./ModelJobActivity";
import { DefinitionEditor } from "./DefinitionEditor";

type Definition = { description: string; include: string; exclude: string; libraryIds: string[] };
type DefinitionResponse = {
  draft?: { id: number; baseVersion: number; definition: Omit<Definition, "libraryIds"> } | null;
  definition: { tag: string; version: number; definition: Definition } | null;
  libraries: Array<{ libraryId: string; name: string; provider: string }>;
};
type Status = "pending" | "accepted" | "rejected" | "withdrawn";
type QuoteContext = { heading: string | null; startChar: number; endChar: number; occurrences: number; before: string; after: string };
type Proposal = { proposalId: string; tag: string; status: Status; version: number; sourceInfo?: ProposalEvidence; proposal: {
  title: string; decision: string; quote: string; rationale: string; risks: string; confidence: number;
  definitionVersion: number; definition: Definition; reconsiderationReason?: string;
} };
type Preview = { exclusionPreference?: { excluded: boolean; version: number }; reviewToken: string; stale: boolean; reviewBlocked: boolean; reviewBlockers: string[]; rejectionHistory?: { items: { proposalId: string; rejectedAt: number; reviewNote: string; definitionVersion: number | null; sameSourceHash: boolean; decision: string }[]; hasMore: boolean }; evidence: (ProposalEvidence & { sourceTags?: string[]; internalTags?: string[] }) | null };
const labels: Record<Status, string> = { pending: "待审核", accepted: "已批准", rejected: "已驳回", withdrawn: "已撤销" };
const decisions: Record<string, string> = { recommend_add: "建议补标", related_only: "仅相关", out_of_scope: "不适用", insufficient_evidence: "证据不足" };
const call = <T,>(args: Record<string, unknown>) => invoke<T>("tag_assignment", { args });

const LIBRARY_SELECTION_KEY = "hub.tag-assignment.libraries.v1";
function initialLibraries(tag: string, available: string[], confirmed?: string[]) {
  try {
    const prefs = JSON.parse(userProfileStorage.getItem(LIBRARY_SELECTION_KEY) ?? "{}");
    const saved = prefs.tags?.[tag] ?? confirmed ?? prefs.last;
    if (Array.isArray(saved)) return available.filter(id => saved.includes(id));
  } catch { /* Use the confirmed scope or first-use default. */ }
  return confirmed ? available.filter(id => confirmed.includes(id)) : available;
}
function rememberLibraries(tag: string, ids: string[]) {
  try {
    const prefs = JSON.parse(userProfileStorage.getItem(LIBRARY_SELECTION_KEY) ?? "{}");
    userProfileStorage.setItem(LIBRARY_SELECTION_KEY, JSON.stringify({last: ids, tags: {...prefs.tags, [tag]: ids}}));
  } catch { /* Storage can be unavailable. */ }
}

export function TagAssignmentInbox({ tagId, userDescription = "", onOpenEvidence, onChanged, onDescriptionSaved, assistantOnly=false, proposalIds,initialLibraryIds }: { initialLibraryIds?:string[];assistantOnly?:boolean;proposalIds?:string[];
  tagId?: string; userDescription?: string; onOpenEvidence?: (r: SearchResult) => void;
  onChanged?: () => void; onDescriptionSaved?: (description: string) => void;
}) {
  const [scanBusy, setScanBusy] = useState(false);
  const [checkMode, setCheckMode] = useState<"quick" | "full">("quick");
  const [status, setStatus] = useState<Status>("pending");
  const [items, setItems] = useState<Proposal[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [expanded, setExpanded] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [approvedNotice, setApprovedNotice] = useState(false);
  const reviewNav = useRef<HTMLElement>(null);
  const [definition, setDefinition] = useState<Definition>({ description: userDescription, include: "", exclude: "", libraryIds: [] });
  const [version, setVersion] = useState<number | null>(null);
  const [libraries, setLibraries] = useState<DefinitionResponse["libraries"]>([]);
  const [saving, setSaving] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [finding, setFinding] = useState(false);
  const findingRef = useRef(false);
  const [discovery, setDiscovery] = useState<{stale?: boolean; nextOffset?: number; remainingCount?: number; processedCount?: number; retrievalRounds?: {queries: string[]; counts: {retrievedHits: number}}[]; retryError?: string | null; counts: {retrievedHits: number; returnedCandidates: number}; readEntities: number; charsRead: number; coverage: string; queries: string[]; libraryIds: string[]; submitted: {proposalId: string; title?: string; decision: string; preview: {stale: boolean; reviewBlocked: boolean; reviewBlockers: string[]} | null; previewError?: string}[]; unjudged: {title?: string; source: {documentId: string}; reason: string}[]} | null>(null);
  const [generating, setGenerating] = useState(false);
  const suite = useCodexSuite();
  const { model, reasoningEffort, fast } = suite.settings;
  const modelAvailable = suite.loaded && !suite.error;
  const generatingRef = useRef(false);
  const editRevision = useRef(0);
  const [draft, setDraft] = useState<DefinitionResponse["draft"]>(null);
  const dirty = useRef(false);
  const seenDraft = useRef(0);
  const definitionTag = useRef(tagId);
  const definitionEpoch = useRef(0);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => { if (error) publishCodexNotice(error, "error", 6000); }, [error]);
  useEffect(() => { if (notice) publishCodexNotice(notice, notice.startsWith("模型正在") ? "working" : "success", 5000); }, [notice]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);

  const load = useCallback(async (after?: string) => {
    const request = ++generation.current;
    setLoading(true); setError(""); setPreviews({}); setExpanded("");
    if (!after) setItems([]);
    try {
      const result = await call<{ proposals: Proposal[]; nextCursor: string | null }>({ action: "list", tag: tagId ?? "", status, limit: 20, cursor: after ?? "",...(proposalIds?{proposalIds}:{}) });
      if (request !== generation.current) return;
      setItems(current => after ? [...current, ...result.proposals.filter(p => !current.some(old => old.proposalId === p.proposalId))] : result.proposals);
      setCursor(result.nextCursor);
    } catch (e) { if (request === generation.current) setError(String(e)); }
    finally { if (request === generation.current) setLoading(false); }
  }, [tagId, status, JSON.stringify(proposalIds)]);

  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  useEffect(() => { const refresh = () => { void load(); }; window.addEventListener("hub-tag-scan-updated", refresh); return () => window.removeEventListener("hub-tag-scan-updated", refresh); }, [load]);
  useEffect(() => {
    if (!tagId) return;
    let cancelled = false;
    definitionTag.current = tagId;
    definitionEpoch.current++;
    generatingRef.current = false; setGenerating(false);
    dirty.current = false; seenDraft.current = 0;
    setVersion(null); setDraft(null); setDiscovery(null); setApprovedNotice(false);
    setDefinition({ description: userDescription, include: "", exclude: "", libraryIds: [] });
    void call<NonNullable<typeof discovery> | null>({action:"discovery_status",tag:tagId}).then(result=>{if(!cancelled && !findingRef.current) setDiscovery(result);}).catch(()=>{});
    let first = true;
    let reading = false;
    const refresh = async () => {
      if (!isWindowVisible() || reading || generatingRef.current) return;
      reading = true;
      const epoch = definitionEpoch.current;
      try {
      const result = await call<DefinitionResponse>({ action: "definition", tag: tagId });
      if (cancelled || generatingRef.current || epoch !== definitionEpoch.current) return;
      const availableLibraries = result.libraries.filter(l => ["craft", "obsidian", "dida365"].includes(l.provider));
      setLibraries(availableLibraries);
      const savedVersion = result.definition?.version ?? 0;
      if (first) {
        setVersion(savedVersion);
        setDefinition(d => ({ ...(result.definition?.definition ?? d), libraryIds: assistantOnly&&!result.definition?availableLibraries.filter(l=>initialLibraryIds?.includes(l.libraryId)).map(l=>l.libraryId):initialLibraries(tagId, availableLibraries.map(l => l.libraryId), result.definition?.definition.libraryIds) }));
        first = false;
      }
      const incoming = result.draft;
      if (incoming && incoming.baseVersion === savedVersion && incoming.id !== seenDraft.current) {
        seenDraft.current = incoming.id;
        if (!dirty.current && !result.definition) {
          setDefinition(d => ({ ...d, ...incoming.definition }));
          setNotice("模型草稿已回填，可修改后选择资料库并确认保存。");
        } else setDraft(incoming);
      }
      } catch (e) { if (!cancelled) setError(String(e)); }
      finally { reading = false; }
    };
    let timer = 0;
    const visibilityChanged = () => {
      window.clearInterval(timer);
      if (isWindowVisible()) { void refresh(); timer = window.setInterval(() => void refresh(), 5000); }
    };
    const unsubscribe = subscribeWindowVisibility(visibilityChanged);
    visibilityChanged();
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.clearInterval(timer); unsubscribe(); window.removeEventListener("focus", refresh); };
  }, [tagId]);

  const generateDefinition = async () => {
    if (version === null || generatingRef.current || !modelAvailable) return;
    if (!definition.libraryIds.length) { setError("请至少选择一个分析资料库后再生成定义。"); return; }
    const tag = tagId;
    const epoch = ++definitionEpoch.current;
    const revision = editRevision.current;
    generatingRef.current = true; setGenerating(true); setError("");
    setNotice("模型正在根据标签用法生成定义，完成后会自动回填…");
    try {
      const result = await call<DefinitionResponse>({ action: "generate_definition", tag, expectedVersion: version, currentInput: definition, model, reasoningEffort, fast });
      if (!alive.current || definitionTag.current !== tag || definitionEpoch.current !== epoch) return;
      const incoming = result.draft;
      if (!incoming) throw new Error("未收到生成的定义，请重试。");
      seenDraft.current = incoming.id;
      if (revision === editRevision.current) {
        dirty.current = true; setDefinition(d => ({ ...d, ...incoming.definition })); setDraft(null);
        setNotice("定义已生成并回填。你可以修改后确认保存。");
      } else { setDraft(incoming); setNotice("定义已生成；你刚才的修改已保留，请查看新草稿。"); }
    } catch (e) {
      if (alive.current && definitionEpoch.current === epoch) { setError(String(e)); setNotice(""); }
    } finally {
      if (alive.current && definitionEpoch.current === epoch) { generatingRef.current = false; setGenerating(false); }
    }
  };

  const findAssignments = async (resume = false) => {
    if (findingRef.current || generating || saving || !modelAvailable) return;
    if (!version) { setError("请先确认并保存定义和资料库范围。"); return; }
    const tag = tagId;
    findingRef.current = true; setFinding(true); setError(""); if (!resume) setDiscovery(null);
    setNotice("模型正在检索候选并核对原文，完成后建议将进入待审核…");
    try {
      const result = await call<NonNullable<typeof discovery>>({action: "discover_assignments", resume, tag, expectedVersion: version, currentInput: definition, model, reasoningEffort, fast});
      if (!alive.current || definitionTag.current !== tag) return;
      await load(); setDiscovery(result); setStatus("pending"); setNotice(result.readEntities === 0 ? "本轮未读取正文，不能据此判断是否需要补标。" : "本批检查已结束，结果和续查位置已保存。");
    } catch (e) { if (alive.current && definitionTag.current === tag) { setError(String(e)); setNotice(""); } }
    finally { findingRef.current = false; if (alive.current) setFinding(false); }
  };

  const save = async () => {
    if (version === null) return;
    const savedTag = tagId;
    definitionEpoch.current++;
    setSaving(true); setError(""); setNotice("");
    try {
      const result = await call<DefinitionResponse>({ action: "save_definition", tag: tagId, definition, expectedVersion: version });
      if (!alive.current || definitionTag.current !== savedTag) return;
      dirty.current = false; setDraft(null);
      setVersion(result.definition!.version); setDefinition(result.definition!.definition);
      setPreviews({}); setExpanded("");
      onDescriptionSaved?.(result.definition!.definition.description);
      setNotice("定义与范围已保存，可以开始查找补标建议或逐篇检查。");
    } catch (e) { if (alive.current) setError(String(e)); }
    finally { if (alive.current) setSaving(false); }
  };

  const inspect = async (id: string) => {
    const request = generation.current;
    setBusy(id); setError("");
    try {
      const p = await call<Preview>({ action: "preview", proposalId: id });
      if (request !== generation.current) return;
      setPreviews(current => ({ ...current, [id]: p })); setExpanded(id);
    } catch (e) { if (request === generation.current) setError(String(e)); }
    finally { if (alive.current) setBusy(""); }
  };
  const resolve = async (id: string, resolution: "accept" | "reject" | "withdraw") => {
    const preview = previews[id]; if (!preview) return;
    setBusy(id); setError(""); setNotice(""); setApprovedNotice(false);
    try {
      const result = await call<{ internalTagsChanged: boolean; indexWarning?: string }>({ action: "resolve", proposalId: id, resolution, reviewToken: preview.reviewToken, note: "用户在 Hub 内容补标收件箱审核" });
      if (!alive.current) return;
      if (result.internalTagsChanged) onChanged?.();
      await load();
      setApprovedNotice(resolution === "accept");
      setNotice((resolution === "accept" ? "已批准并添加到 Hub。要更新原笔记，请继续预览并确认写回来源。" : resolution === "withdraw" ? "已撤销 Hub 内部标签。" : "已驳回建议。") + (result.indexWarning ? `搜索索引等待更新：${result.indexWarning}` : ""));
    } catch (e) { if (alive.current) { setPreviews({}); setExpanded(""); setError(String(e)); } }
    finally { if (alive.current) setBusy(""); }
  };
  const scopedItems=proposalIds?items.filter(item=>proposalIds.includes(item.proposalId)):items;
  const visibleItems = status === "pending" && !showAnalysis ? scopedItems.filter(item => item.proposal.decision === "recommend_add") : scopedItems;
  const tally = (decision: string) => discovery?.submitted.filter(item => item.decision === decision).length ?? 0;
  const remaining = discovery?.remainingCount ?? 0;
  const goToReview = (next: Status) => {
    setStatus(next); setShowAnalysis(false);
    reviewNav.current?.scrollIntoView?.({ block: "start" });
    reviewNav.current?.querySelector<HTMLButtonElement>(`[data-status="${next}"]`)?.focus({ preventScroll: true });
  };
  return <section className="tag-assignment-inbox" aria-label="内容补标">
    <header><strong>内容补标</strong><button type="button" disabled={loading || !!busy} onClick={() => void load()}>刷新建议</button></header>
    <p className="tag-assignment-hint">查看建议并批准到 Hub，再按需确认写回 Craft / Obsidian 原笔记。</p>
    {tagId && <TagTaskActivity tag={tagId} workflows={["tag-definition", "tag-assignment-discovery"]}/>}
    {!assistantOnly&&tagId && <div className="tag-definition-toolbar"><CodexDefinitionModel /></div>}
    {tagId && <details className="tag-assignment-definition" open={assistantOnly||version === 0 ? true : undefined}><summary>定义与范围 · {version ? `已确认 · 版本 ${version} · ${definition.libraryIds.length} 个资料库` : "请先确认"}</summary>
      <div className="tag-definition-toolbar" hidden={assistantOnly}>
      <button type="button" disabled={version === null || saving || generating || finding || scanBusy || !modelAvailable} onClick={() => void generateDefinition()}>{generating ? "模型正在生成…" : version ? "用模型 优化定义" : "用模型 生成定义"}</button></div>
      <p className="tag-assignment-hint">生成后可点击正文修改，确认保存后用于内容补标。</p>
      {draft && <div role="status"><p>模型新草稿已到达，当前输入已保留。</p>
        <p>标签定义：{draft.definition.description}</p><p>纳入：{draft.definition.include}</p><p>排除：{draft.definition.exclude}</p>
        <button type="button" disabled={saving || generating || draft.baseVersion !== version} onClick={() => { dirty.current = true; editRevision.current++; setDefinition(d => ({ ...d, ...draft.definition })); setDraft(null); }}>将此草稿填入表单</button>
        <button type="button" onClick={() => setDraft(null)}>保留当前输入</button>
      </div>}
      <fieldset disabled={saving || finding || scanBusy || !!busy || version === null} onChange={() => { dirty.current = true; editRevision.current++; }}>
        <label>标签定义<DefinitionEditor placeholder="点击填写定义" value={definition.description} maxLength={2000} onChange={e => setDefinition(d => ({ ...d, description: e.target.value }))} /></label>
        <label>纳入条件<DefinitionEditor placeholder="填写纳入条件" value={definition.include} maxLength={2000} onChange={e => setDefinition(d => ({ ...d, include: e.target.value }))} /></label>
        <label>排除条件<DefinitionEditor placeholder="填写排除条件（可选）" value={definition.exclude} maxLength={2000} onChange={e => setDefinition(d => ({ ...d, exclude: e.target.value }))} /></label>
        <div className="tag-assignment-libraries"><span>分析资料库 · 已选 {definition.libraryIds.length}/{libraries.length}</span>{libraries.map(l => <label key={l.libraryId}><input type="checkbox" checked={definition.libraryIds.includes(l.libraryId)} onChange={e => { const ids = e.target.checked ? [...definition.libraryIds, l.libraryId] : definition.libraryIds.filter(id => id !== l.libraryId); rememberLibraries(tagId!, ids); setDefinition(d => ({ ...d, libraryIds: ids })); }} />{l.name} · {l.provider}</label>)}</div>
        {!definition.libraryIds.length && <p className="tag-assignment-scope-hint" role="status">请至少选择一个分析资料库后再生成定义。</p>}
        <button type="button" disabled={saving || generating || !definition.description.trim() || !definition.include.trim() || !definition.libraryIds.length} onClick={() => void save()}>{saving ? "保存中…" : "确认并保存定义"}</button>
      </fieldset>
    </details>}
    {!assistantOnly&&tagId && <nav className="tag-check-modes" aria-label="检查方式"><button disabled={scanBusy || finding || generating} aria-pressed={checkMode === "quick"} onClick={() => setCheckMode("quick")}>查找可能漏标</button><button disabled={scanBusy || finding || generating} aria-pressed={checkMode === "full"} onClick={() => setCheckMode("full")}>逐篇检查</button></nav>}
    {!assistantOnly&&tagId && <div hidden={checkMode !== "full"}><p className="tag-assignment-hint">按已保存的定义逐篇核对正文，达到预算后暂停，进度可续跑。</p>{(!version || dirty.current) && <p role="status">请先在上方确认并保存定义与范围，再开始逐篇检查。</p>}<CodexContentScan tagId={tagId} disabled={!version || dirty.current || generating || saving || finding} onRunningChange={setScanBusy} /><TagContentScanPanel tagId={tagId} /></div>}
    {!assistantOnly&&tagId && <div hidden={checkMode !== "quick"} className="tag-assignment-discover">
      <button type="button" disabled={finding || generating || saving || version === null || !modelAvailable} onClick={() => void findAssignments(remaining > 0 && !discovery?.stale)}>{finding ? "模型正在检查…" : remaining > 0 && !discovery?.stale ? `继续检查剩余 ${remaining} 项` : "用模型 查找补标建议"}</button>
      <p className="tag-assignment-hint">使用已保存的定义与范围，每批最多检查 5 项，进度自动保存。只有批准后才添加标签。</p>
    </div>}
    {checkMode === "quick" && discovery && <section className="tag-assignment-discovery-result" aria-label="补标检查进度">
      <strong>{discovery.counts.returnedCandidates === 0 ? "未找到候选 · 尚未分析正文" : discovery.unjudged.length ? `已保存 ${discovery.submitted.length} 项判断，${discovery.unjudged.length} 项跳过或未判断，剩余 ${remaining} 项` : `已检查 ${discovery.processedCount ?? discovery.readEntities} 项，剩余 ${remaining} 项待检查`}</strong>
      <div className="tag-assignment-result-counts">
        <span><b>{tally("recommend_add")}</b>建议补标</span>
        <span><b>{tally("insufficient_evidence")}</b>需进一步核对</span>
        <span><b>{tally("out_of_scope") + tally("related_only")}</b>暂不补标</span>
      </div>
      {discovery.submitted.length > 0 && tally("recommend_add") === 0 && <p>目前没有可批准的补标建议。已保存的判断记录不等于已添加标签。</p>}
      <div className="tag-assignment-next-step">
        <div><strong>下一步：审核补标建议</strong><p>{tally("recommend_add") > 0 ? "已生成的建议可以先审核，不用等剩余内容检查完。" : "仅「建议补标」可以批准；需进一步核对和暂不补标的记录不会添加标签。"}</p></div>
        <button type="button" className="tag-assignment-primary" disabled={!!busy || loading} onClick={() => goToReview("pending")}>查看待审核建议</button>
      </div>
      {discovery.stale ? <p role="alert">定义已改变，请重新查找候选。</p> : remaining === 0 && discovery.counts.returnedCandidates > 0 && <p>这份候选清单已处理完；需核对与未判断的内容仍未完成分析，也不代表整个资料库已分析完。</p>}
      {discovery.counts.returnedCandidates === 0 && <p>零候选不代表资料库中没有可补标内容，可核对资料库范围后重新查找。</p>}
      <details><summary>查看检查记录与范围</summary>
        <p>检索命中 {discovery.counts.retrievedHits} · 候选 {discovery.counts.returnedCandidates} · 实际读证 {discovery.readEntities} 篇 / {discovery.charsRead} 字符</p>
        <p>资料库：{discovery.libraryIds.map(id=>libraries.find(l=>l.libraryId===id)?.name??id).join("、")}；查询：{discovery.queries.join("、")}</p>
        <p>{discovery.coverage}</p>
        {discovery.retrievalRounds && discovery.retrievalRounds.length > 1 && <p>首次零命中，已自动改用更短检索词重试。</p>}
        {discovery.retryError && <p role="alert">检索重试未完成：{discovery.retryError}</p>}
        {discovery.submitted.map(item=><div className="tag-assignment-result-row" key={item.proposalId}><span>{item.title || "已检查内容"}</span><span>{item.decision==="insufficient_evidence" ? "需进一步核对" : decisions[item.decision]}</span>
          {(item.preview?.stale || (item.decision==="recommend_add" && item.preview?.reviewBlocked) || item.previewError) && <small>{item.previewError || item.preview?.reviewBlockers.join("；")}</small>}
        </div>)}
        {!!discovery.unjudged.length && <details><summary>跳过或未能判断 {discovery.unjudged.length} 项</summary><ul>{discovery.unjudged.map((item,i)=><li key={i}>{item.title || "未命名内容"}：{item.reason}</li>)}</ul></details>}
      </details>
    </section>}
    <nav ref={reviewNav} className="tag-assignment-review-nav" aria-label="补标审核状态">{(Object.keys(labels) as Status[]).map(s => <button type="button" key={s} data-status={s} disabled={!!busy} aria-pressed={s === status} onClick={() => { setStatus(s); setApprovedNotice(false); }}>{labels[s]}</button>)}</nav>
    {error && /请至少|请先|预演.*过期|定义.*变化|范围.*变化/.test(error) && <p role="alert">{error}</p>}
    {approvedNotice && status === "pending" && <button type="button" className="tag-assignment-primary" disabled={!!busy || loading} onClick={() => { setApprovedNotice(false); goToReview("accepted"); }}>前往已批准并写回</button>}
    {status === "pending" && visibleItems.length > 0 && <p className="tag-assignment-hint">点击「查看并批准」核对原文，在详情中确认批准到 Hub。</p>}
    {status === "accepted" && visibleItems.length > 0 && <p className="tag-assignment-hint">这些建议已添加到 Hub。点击「查看并写回」，预览变更后确认更新原笔记。</p>}
    {loading && <p role="status">正在读取建议…</p>}
    {status === "pending" && items.some(item=>item.proposal.decision!=="recommend_add") && <button className="tag-assignment-analysis-toggle" type="button" onClick={()=>setShowAnalysis(v=>!v)}>{showAnalysis ? "只看建议补标" : "查看需核对与不适用的记录"}</button>}
    {!loading && !visibleItems.length && <div className="tag-assignment-empty"><strong>{cursor ? "当前已加载的记录中没有匹配的建议。" : status === "pending" ? "暂无可批准的补标建议。" : `暂无${labels[status]}的内容补标建议。`}</strong><span>{cursor ? "点击下方「加载更多建议」继续查看。" : status === "pending" ? "符合补标条件的建议会显示在这里，由你核对后批准。" : "该状态的审核记录会显示在这里。"}</span></div>}
    {visibleItems.map(item => {
      const p = item.proposal, preview = previews[item.proposalId];
      const sourceInfo = preview?.evidence ?? item.sourceInfo;
      const evidence = sourceInfo && (!preview || preview.evidence) ? proposalEvidenceSearchResult(sourceInfo) : null;
      const sourceLabel = sourceInfo?.provider ? `${providerName(sourceInfo.provider)} · ${sourceInfo.libraryName || sourceInfo.libraryId || "未知资料库"}` : "来源信息不可用";
      return <article key={item.proposalId}>
        <div className="tag-assignment-card-header">
        <div className="tag-assignment-card-copy">
          <button type="button" className="tag-assignment-summary" disabled={!!busy || loading || saving || (!!onOpenEvidence && !evidence)} onClick={() => evidence && onOpenEvidence ? onOpenEvidence(evidence) : void inspect(item.proposalId)} title={evidence && onOpenEvidence ? "打开原文预览" : undefined}>
            <strong>{sourceInfo?.title || p.title}</strong>
          </button>
          <div className="tag-assignment-source"><span className="tag-assignment-source-badge">{sourceLabel}</span>{sourceInfo?.path && <span className="tag-assignment-source-path" title={sourceInfo.path}>{sourceInfo.path}</span>}{sourceInfo && !sourceInfo.available && <span>来源已不可用</span>}</div>
          <p className="tag-assignment-card-tags">#{item.tag} · {decisions[p.decision] ?? p.decision}</p>
        </div>
        {onOpenEvidence && <button type="button" className="tag-assignment-open" disabled={!evidence || !!busy || loading || saving} title={evidence ? `打开查看：${evidence.title}` : "来源已不存在或资料库未启用"} onClick={() => evidence && onOpenEvidence(evidence)}><BookOpen size={15} aria-hidden="true" />打开查看</button>}
        <button type="button" className={item.status === "pending" && p.decision === "recommend_add" ? "tag-assignment-primary" : ""} disabled={!!busy || loading || saving} aria-expanded={expanded === item.proposalId} onClick={() => expanded === item.proposalId ? setExpanded("") : void inspect(item.proposalId)}>{busy === item.proposalId ? "正在读取…" : expanded === item.proposalId ? "收起详情" : item.status === "pending" && p.decision === "recommend_add" ? "查看并批准" : item.status === "accepted" ? "查看并写回" : "查看详情"}</button>
        </div>
        {expanded === item.proposalId && preview && <div className="tag-assignment-detail">
          <strong>原文证据片段</strong>
          <blockquote>{p.quote}</blockquote>
          <p className="tag-assignment-hint">标签作用于这篇笔记或页面，不代表其中每个段落都符合定义。</p>
          {(() => {
            const context = (preview.evidence as (ProposalEvidence & { quoteContext?: QuoteContext }) | null)?.quoteContext;
            return context ? <details>
              <summary>查看证据上下文{context.heading ? ` · ${context.heading.replace(/^#+\s*/, "")}` : ""}</summary>
              <p className="tag-assignment-hint">字符位置 {context.startChar + 1}–{context.endChar}（从 1 计数）{context.occurrences > 1 ? ` · 原文出现 ${context.occurrences} 次，展示首次位置` : ""}{preview.stale ? " · 来源已变化，请重新核对" : ""}</p>
              <blockquote>{context.before}<mark>{p.quote}</mark>{context.after}</blockquote>
            </details> : <p className="tag-assignment-hint">当前无法定位上下文，请打开来源核对。</p>;
          })()}
          <p>{p.rationale}</p>
          {preview.evidence && <p className="tag-assignment-hint">来源标签：{preview.evidence.sourceTags?.join("、") || "无"} · Hub 内部标签：{preview.evidence.internalTags?.join("、") || "无"}</p>}
          <p className="tag-assignment-hint">依据定义版本 {p.definitionVersion} · 模型置信度 {Math.round(p.confidence * 100)}%</p>
          <p>标签定义：{p.definition.description}</p><p>纳入条件：{p.definition.include}</p>
          {p.definition.exclude && <p>排除条件：{p.definition.exclude}</p>}{p.risks && <p>风险与限制：{p.risks}</p>}
          {!!preview.rejectionHistory?.items.length && <details>
            <summary>此内容有历史驳回记录（{preview.rejectionHistory.items.length}{preview.rejectionHistory.hasMore ? "+" : ""} 条）</summary>
            <p>历史驳回不等于永久排除。以下是审核事实，不是模型结论；正文版本相同也不代表定义或标签上下文相同。</p>
            <p>本次重新考虑依据：{p.reconsiderationReason || "旧建议未提供，请结合历史记录谨慎复核。"}</p>
            <ul>{preview.rejectionHistory.items.map(h => <li key={h.proposalId}>
              {new Date(h.rejectedAt * 1000).toLocaleString("zh-CN")} · 定义版本 {h.definitionVersion ?? "未知"} · {h.sameSourceHash ? "正文证据版本相同" : "正文证据版本不同"} · 原结论：{decisions[h.decision] ?? h.decision}
              <p>审核备注：{h.reviewNote || "未填写具体原因"}</p><p style={{ overflowWrap: "anywhere" }}>建议编号：{h.proposalId}</p>
            </li>)}</ul>
            {preview.rejectionHistory.hasMore && <p>仅展示最近 5 条，更多记录可在已驳回列表查看。</p>}
          </details>}
          {preview.reviewBlockers.length > 0 && <ul>{preview.reviewBlockers.map(b => <li key={b}>{b}</li>)}</ul>}
          {item.status === "rejected" && <TagAssignmentExclusion key={`${item.proposalId}:${preview.exclusionPreference?.version ?? 0}`} proposalId={item.proposalId} excluded={preview.exclusionPreference?.excluded ?? false} disabled={!!busy || saving} onChanged={() => void inspect(item.proposalId)} />}
          <div className="tag-assignment-actions">
            {evidence && onOpenEvidence && <button type="button" onClick={() => onOpenEvidence(evidence)}>打开来源</button>}
            {item.status === "pending" && <><button type="button" className="tag-assignment-primary" disabled={!!busy || preview.reviewBlocked || saving} onClick={() => void resolve(item.proposalId, "accept")}>批准到 Hub</button><button type="button" disabled={!!busy || saving} onClick={() => void resolve(item.proposalId, "reject")}>驳回</button></>}
            {item.status === "accepted" && <button type="button" disabled={!!busy || saving} onClick={() => void resolve(item.proposalId, "withdraw")}>撤销 Hub 标签</button>}
          </div>
          {(item.status === "accepted" || item.status === "withdrawn") && <TagSourceWriteback proposalId={item.proposalId} kind="assignment" allowWrite={item.status === "accepted"} disabled={!!busy || saving} onWritten={onChanged} />}
        </div>}
      </article>;
    })}
    {cursor && <button type="button" disabled={loading || !!busy} onClick={() => void load(cursor)}>加载更多建议</button>}
    <section className="tag-assignment-management" aria-label="复核与排除管理">
      <header><strong>复核与排除管理</strong><span>管理暂不补标的内容</span></header>
      <TagAssignmentExclusionList key={tagId??"all-tags"} tagId={tagId} onChanged={()=>{setPreviews({});setExpanded("");}} />
    </section>
  </section>;
}
