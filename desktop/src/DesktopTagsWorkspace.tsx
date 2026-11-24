import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, List, Network, PanelLeft, Plus, Rows3, Search, X } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type FormEvent, type ReactNode, type RefObject } from "react";
import { splitTagPath, tagCleanupReason, type SidebarTagGroup, type SidebarTagSummary } from "./DesktopSidebarPresentation";
import type { PreviewPane } from "./PreviewPane";
import { providerName } from "./ProviderLabels";
import { formatDate, resultDisplayTitle } from "./SearchResultPresentation";
import type { SearchResultsPane } from "./SearchResultsPane";
import type { SearchResult } from "./SearchTypes";
import { AgentPanelContext, AgentTagRequestContext } from "./StandaloneAgentLauncher";
import { TagAssignmentInbox } from "./TagAssignmentInbox";
import { TagGovernanceInbox, type Recommendation } from "./TagGovernanceInbox";
import { TagLibraryFilter } from "./TagLibraryFilter";
import { defaultTagColor, type TagUserPropertyMap } from "./TagProperties";
import { TagPropertiesCard } from "./TagPropertiesCard";
import { TopicRelationView, topicRelations, type TopicRelation } from "./TopicRelationView";
import { userProfileStorage } from "./UserProfileStorage";
import "./DesktopTagsWorkspace.css";

export type DesktopTopicCatalog = {
  tags: SidebarTagSummary[];
  groups: SidebarTagGroup[];
  properties: TagUserPropertyMap;
  favorites: string[];
  recent: string[];
  cleanupCount: number;
  onCloseCleanup: () => void;
  onSearch: (name: string) => void;
  onCreate: (name: string, groupId: string, description: string) => SidebarTagSummary | null;
};

type Props = {
  workspaceRef: RefObject<HTMLElement | null>;
  data: ComponentProps<typeof SearchResultsPane>;
  preview: ComponentProps<typeof PreviewPane>;
  catalog: DesktopTopicCatalog;
};

type View = "browse" | "graph";
type Filter = "all" | "pinned" | "discovered";
type Overlay = "tidy" | "new" | "assignment" | "link" | "relations" | "evidence";
type Suggestion = { proposalId: string; tag: string; proposal: { title: string; decision: string; rationale: string } };
type TopicLink = { source: string; target: string; label: string };
const PAGE_SIZE = 5;
const LINK_STORAGE_KEY = "hub-desktop-topic-links-v1";

function readTopicLinks(): TopicLink[] {
  try {
    const items: unknown = JSON.parse(userProfileStorage.getItem(LINK_STORAGE_KEY) ?? "[]");
    return Array.isArray(items) ? items.filter((item): item is TopicLink => item && typeof item.source === "string" && typeof item.target === "string" && typeof item.label === "string") : [];
  } catch {
    return [];
  }
}

export function isTopicFormattingArtifact(tag: SidebarTagSummary): boolean {
  return /^(?:\^|\\|[+#_-]*BEGIN_|[+#_-]*END_)/i.test(tag.name.trim()) || /<br\s*\/?>/i.test(tag.name);
}

function useTopicSuggestions() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const result: Suggestion[] = [];
      let cursor = "";
      do {
        const page: { proposals: Suggestion[]; nextCursor: string | null } = await invoke("tag_assignment", { args: { action: "list", tag: "", status: "pending", limit: 100, cursor } });
        if (cancelled) return;
        result.push(...page.proposals.filter(item => item.proposal.decision === "recommend_add" || item.proposal.decision === "related_only"));
        cursor = page.nextCursor ?? "";
      } while (cursor);
      setSuggestions(result);
    }
    void load().catch(() => { if (!cancelled) setSuggestions([]); });
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("hub-tag-scan-updated", refresh);
    return () => { cancelled = true; window.removeEventListener("hub-tag-scan-updated", refresh); };
  }, [revision]);
  return { suggestions, refreshSuggestions: () => setRevision(value => value + 1) };
}

function TopicDialog({ label, drawer, onClose, children }: { label: string; drawer?: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className={`topic-dialog${drawer ? " topic-drawer" : ""}`} aria-label={label} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section>
      <header><div><h2>{label}</h2>{label === "顺手整理" && <span>审核建议与查看自动过滤的排版杂项</span>}</div><button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}><X size={16} /></button></header>
      {children}
    </section>
  </dialog>;
}

function NewTopicForm({ groups, onCreate, onClose }: { groups: SidebarTagGroup[]; onCreate: DesktopTopicCatalog["onCreate"]; onClose: () => void }) {
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    if (!onCreate(String(values.get("name")), String(values.get("group")), String(values.get("description")))) setError("主题名称为空或已存在");
  }
  return <form className="topic-form" onSubmit={submit}>
    <label>你想持续关注什么主题？<input name="name" placeholder="例如：晚间复盘、电池热管理、表达清晰度" required maxLength={100} /></label>
    <label>放在哪个领域下？<select name="group"><option value="">未分组</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
    <label>一句话说明<input name="description" placeholder="可留空，之后再补充主题说明" maxLength={240} /></label>
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" className="btn-ghost" onClick={onClose}>取消</button><button type="submit" className="btn-primary">创建主题</button></footer>
  </form>;
}

export function DesktopTagsWorkspace({ workspaceRef, data, preview, catalog }: Props) {
  const [view, setView] = useState<View>("browse");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [list, setList] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [trail, setTrail] = useState<SidebarTagSummary[]>([]);
  const [links, setLinks] = useState(readTopicLinks);
  const [showCandidates, setShowCandidates] = useState(true);
  const [candidateSnapshot, setCandidateSnapshot] = useState<{ topic: string; targets: string[] }>();
  const [relationRevision, setRelationRevision] = useState(0);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [reviewOverlay, setReviewOverlay] = useState<Overlay | null>(null);
  const [pendingProposal, setPendingProposal] = useState<string | null>(null);
  const proposalIds = useMemo(() => pendingProposal ? [pendingProposal] : undefined, [pendingProposal]);
  const [showNoise, setShowNoise] = useState(false);
  const [noteLimit, setNoteLimit] = useState(PAGE_SIZE);
  const [serif, setSerif] = useState(false);
  const [noteRequest, setNoteRequest] = useState<{ id: string } | null>(null);
  const reader = useRef<HTMLElement>(null);
  const dossier = useRef<HTMLDivElement>(null);
  const selectedCard = useRef<HTMLButtonElement>(null);
  const assistant = useContext(AgentPanelContext);
  const assistantRequest = useContext(AgentTagRequestContext);
  const { suggestions, refreshSuggestions } = useTopicSuggestions();
  const pending = useMemo(() => {
    const byTag = new Map<string, Suggestion[]>();
    for (const item of suggestions) byTag.set(item.tag, [...(byTag.get(item.tag) ?? []), item]);
    return byTag;
  }, [suggestions]);
  const { tags, properties, favorites, recent } = catalog;
  const topic = data.selectedCollectionTag;
  const topicId = topic?.normalizedName;
  const tagsById = useMemo(() => new Map(tags.map(tag => [tag.normalizedName, tag])), [tags]);
  const hiddenTags = useMemo(() => tags.filter(isTopicFormattingArtifact), [tags]);
  const grouped = useMemo(() => {
    const pinned = new Set(favorites);
    const custom = new Map(catalog.groups.flatMap(group => group.tagIds.map(id => [id, group.name] as const)));
    const matches = tags.filter(tag => {
      const id = tag.normalizedName;
      return !isTopicFormattingArtifact(tag) && (filter !== "pinned" || pinned.has(id)) && (filter !== "discovered" || pending.has(id))
        && `${tag.name} ${properties[id]?.description ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    });
    const byGroup = new Map<string, SidebarTagSummary[]>();
    for (const tag of matches.sort((a, b) => Number(pinned.has(b.normalizedName)) - Number(pinned.has(a.normalizedName)) || b.count - a.count || a.name.localeCompare(b.name, "zh-CN"))) {
      const group = custom.get(tag.normalizedName) ?? splitTagPath(tag)?.group ?? "未分组";
      const items = byGroup.get(group);
      if (items) items.push(tag); else byGroup.set(group, [tag]);
    }
    return [...byGroup];
  }, [catalog.groups, favorites, filter, pending, properties, query, tags]);
  const shown = useMemo(() => grouped.flatMap(([, items]) => items), [grouped]);
  const defaultTopic = recent.map(id => tagsById.get(id)).find(tag => tag && !isTopicFormattingArtifact(tag)) ?? shown[0];
  const choose = data.onSelectCollectionTag;
  useEffect(() => {
    if (!topicId || view !== "graph" || !showCandidates) return;
    let cancelled = false;
    void invoke<{ proposals: { proposal: { recommendations?: Recommendation[] } }[] }>("list_tag_governance_proposals", { tag: topicId, status: "pending", limit: 50 }).then(({ proposals }) => {
      if (cancelled) return;
      const targets = new Set<string>();
      for (const { proposal } of proposals) for (const item of proposal.recommendations ?? []) {
        if (!item.targetTagId || !["related", "alias", "merge", "parent_child"].includes(item.type)) continue;
        if (item.targetTagId === topicId) item.sourceTagIds.forEach(id => { if (id !== topicId) targets.add(id); });
        else if (item.sourceTagIds.includes(topicId)) targets.add(item.targetTagId);
      }
      setCandidateSnapshot({ topic: topicId, targets: [...targets] });
    }).catch(() => { if (!cancelled) setCandidateSnapshot(undefined); });
    return () => { cancelled = true; };
  }, [topicId, view, showCandidates, relationRevision]);
  useEffect(() => { if (!topic && defaultTopic && !data.tagsLoading) choose?.(defaultTopic); }, [choose, data.tagsLoading, defaultTopic, topic]);
  useEffect(() => {
    setNoteLimit(PAGE_SIZE);
    setNoteRequest(null);
    if (dossier.current) dossier.current.scrollTop = 0;
  }, [topic?.normalizedName]);
  useEffect(() => { if (noteRequest) reader.current?.scrollIntoView?.({ block: "nearest" }); }, [noteRequest, view]);
  useEffect(() => { selectedCard.current?.scrollIntoView?.({ block: "nearest" }); }, [topic?.normalizedName, view, filter, collapsed]);

  const cleanupFromSidebar = data.tagOverviewMode === "cleanup";
  const activeOverlay = overlay ?? (cleanupFromSidebar ? "tidy" : null);
  const closeOverlay = () => {
    if (overlay === "evidence" && reviewOverlay) {
      setOverlay(reviewOverlay);
      setReviewOverlay(null);
      return;
    }
    setOverlay(null);
    setPendingProposal(null);
    if (cleanupFromSidebar) catalog.onCloseCleanup();
  };
  const ready = data.contextReady !== false;
  const notes = useMemo(() => {
    if (!ready) return [];
    const pages = new Map<string, SearchResult>();
    for (const result of data.results) {
      const page = JSON.stringify([result.provider, result.libraryId, result.spaceId, result.documentId || result.id, result.provider === "craft" ? result.pageId : ""]);
      if (!pages.has(page)) pages.set(page, result);
    }
    return [...pages.values()];
  }, [data.results, ready]);
  const note = notes.find(item => item.id === preview.selected?.id) ?? notes.find(item => item.id === data.results[data.selectedIndex]?.id) ?? notes[0];
  const description = data.selectedTagDescription?.trim() ?? "";
  const group = data.selectedTagGroup ?? "未分组";
  const sources = [...new Set(notes.map(item => providerName(item.provider)))].join(" / ");
  const meta = [group, ready ? `${notes.length} 篇已归入` : "正在读取…", sources, ready && data.selectedTagLastUpdated !== "暂无" ? data.selectedTagLastUpdated : ""].filter(Boolean);
  const manual: TopicRelation[] = links.flatMap(link => {
    const id = link.source === topicId ? link.target : link.target === topicId ? link.source : "";
    const tag = tagsById.get(id);
    return tag ? [{ tag, label: link.label || "手动关联", kind: "manual" }] : [];
  });
  const indexed = topic ? topicRelations(topic, tagsById, data.selectedTagTaxonomy, data.selectedTagRelated ?? []) : [];
  const linkedIds = new Set(manual.map(item => item.tag.normalizedName));
  const relations = [...manual, ...indexed.filter(item => !linkedIds.has(item.tag.normalizedName))];
  const connectedIds = new Set(relations.map(item => item.tag.normalizedName));
  const candidates: TopicRelation[] = showCandidates && candidateSnapshot && candidateSnapshot.topic === topicId ? candidateSnapshot.targets.flatMap(id => {
    const tag = tagsById.get(id);
    return tag && !connectedIds.has(id) ? [{ tag, label: "AI 建议 · 待审核", kind: "candidate" }] : [];
  }) : [];
  const graphRelations = [...relations, ...candidates];
  const topicSuggestions = (topic && pending.get(topic.normalizedName)) || [];
  const currentTrail = topic && trail[trail.length - 1]?.normalizedName !== topic.normalizedName ? [...trail, topic] : trail;
  const setMode = (next: View) => { setView(next); if (next === "graph" && view !== "graph") setTrail(topic ? [topic] : []); };
  const selectTopic = (next: SidebarTagSummary) => { if (next.normalizedName !== topic?.normalizedName) choose?.(next); };
  const ask = topic && assistant && assistantRequest ? () => {
    assistantRequest.setPending({ tagId: topic.normalizedName, label: topic.name, task: view === "graph" ? "relations" : "definition" });
    assistant(null);
  } : undefined;
  function readNote(result: SearchResult) {
    if (data.onPreviewEvidence) data.onPreviewEvidence(result);
    else data.onSelectResult(data.results.indexOf(result));
    setNoteRequest({ id: result.id });
  }
  const showEvidence = (result: SearchResult) => {
    data.onPreviewEvidence?.(result);
    setReviewOverlay(activeOverlay);
    setOverlay("evidence");
  };
  const noteMeta = (result: SearchResult) => `${providerName(result.provider)} · ${formatDate(result.modifiedAt)}`;
  function saveLinks(next: TopicLink[]) {
    userProfileStorage.setItem(LINK_STORAGE_KEY, JSON.stringify(next));
    setLinks(next);
  }

  return <section ref={workspaceRef} className="hub-tags-workspace" aria-label="标签与主题">
    <header className="top-bar">
      {view === "browse" && <button type="button" className={`icon-btn${collapsed ? "" : " active"}`} aria-label="切换主题栏" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}><PanelLeft size={15} /></button>}
      <div className="mode-switch" role="group" aria-label="视角切换">
        <button type="button" className={`mode-btn${view === "browse" ? " active" : ""}`} aria-pressed={view === "browse"} onClick={() => setMode("browse")}><PanelLeft size={14} />主题浏览</button>
        <button type="button" className={`mode-btn${view === "graph" ? " active" : ""}`} aria-pressed={view === "graph"} onClick={() => setMode("graph")}><Network size={14} />关系视角</button>
      </div>
      <label className="search-pill"><Search size={14} /><input aria-label="查找主题" value={query} placeholder="找一个主题或想法…" onChange={event => { setQuery(event.target.value); setCollapsed(false); if (view === "graph") setView("browse"); }} /></label>
      <div className="spacer" />
      <button type="button" className="btn-ghost" onClick={() => setOverlay("tidy")}>{catalog.cleanupCount ? <span className="dot-blue" /> : null}整理{catalog.cleanupCount ? <span className="mono topic-accent">{catalog.cleanupCount}</span> : null}</button>
      <button type="button" className="btn-primary" onClick={() => setOverlay("new")}><Plus size={13} />新建主题</button>
    </header>

    {view === "browse" && <div className="split-stage">
      <aside className={`master-pane${list ? " compact-width" : ""}${collapsed ? " collapsed" : ""}`} aria-label="主题列表" inert={collapsed}>
        <header className="master-head">
          <div className="master-filters" role="group" aria-label="主题筛选">
            {([["all", "全部"], ["pinned", "置顶"], ["discovered", "新发现"]] as const).map(([value, label]) => <button type="button" className={`filter-pill${filter === value ? " active" : ""}`} aria-pressed={filter === value} key={value} onClick={() => setFilter(value)}>{label}{value === "discovered" && pending.size > 0 ? ` ${pending.size}` : ""}</button>)}
          </div>
          <div className="master-style-switch" role="group" aria-label="主题列表样式">
            <button type="button" aria-label="卡片视图" className={`density-button${!list ? " active" : ""}`} aria-pressed={!list} onClick={() => setList(false)}><Rows3 size={14} /></button>
            <button type="button" aria-label="列表视图" className={`density-button${list ? " active" : ""}`} aria-pressed={list} onClick={() => setList(true)}><List size={14} /></button>
          </div>
        </header>
        <div className="master-scroll" aria-busy={data.tagsLoading} onKeyDown={event => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          const index = shown.findIndex(tag => tag.normalizedName === topic?.normalizedName);
          const next = shown[index + (event.key === "ArrowUp" ? -1 : 1)];
          if (!next) return;
          event.preventDefault();
          selectTopic(next);
          [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-topic]")].find(button => button.dataset.topic === next.normalizedName)?.focus();
        }}>
          {grouped.map(([label, items]) => <section key={label}>
            <div className="master-group-label"><span>{label}</span><span className="mono">{items.length}</span></div>
            <div className={list ? "master-compact-list" : "master-card-list"}>{items.map(item => {
              const id = item.normalizedName;
              const selected = topic?.normalizedName === id;
              const pinned = favorites.includes(id);
              const found = pending.get(id)?.length;
              return <button type="button" key={id} ref={selected ? selectedCard : undefined} data-topic={id} className={`${list ? "m-row" : "m-card"}${selected ? " selected" : ""}`} aria-current={selected ? "true" : undefined} onClick={() => selectTopic(item)} draggable onDragStart={event => {
                event.dataTransfer.setData("application/x-hub-tag", JSON.stringify({ tagId: id, label: item.name })); event.dataTransfer.effectAllowed = "copy";
              }}>
                <span className="m-card-top"><span className="m-card-title"><span>{item.name}</span>{pinned && <span className="topic-accent" title="已置顶">★</span>}</span><small className="mono">{item.count}</small></span>
                {!list && <><span className="m-card-brief">{properties[id]?.description || "尚未填写主题说明"}</span><span className="m-card-foot"><span className="m-card-rel">{selected && relations.length ? `↔ ${relations.slice(0, 2).map(item => item.tag.name).join(" · ")}` : label}</span>{found ? <span className="topic-accent">+{found} 相关</span> : null}</span></>}
              </button>;
            })}</div>
          </section>)}
          {!shown.length && <p className="topic-empty">{data.tagsLoading ? "正在读取主题…" : "没有匹配的主题"}</p>}
        </div>
      </aside>
      <main className="detail-wrap">
        <div className="detail-paper">
          {topic ? <>
            <div className="mini-orbit-bar">
              <div className="orbit-flow"><span className="orbit-pill parent">{group}</span><span className="orbit-arrow">›</span><span className="orbit-pill current">{topic.name}</span>
                {relations.length > 0 && <span className="orbit-arrow">↔</span>}{relations.slice(0, 3).map(relation => <button type="button" className="orbit-pill" key={relation.tag.normalizedName} onClick={() => selectTopic(relation.tag)}>{relation.tag.name}<small> · {relation.label}</small></button>)}
                <button type="button" className="orbit-pill topic-link-pill" onClick={() => setOverlay("link")}>+ 连线</button>
              </div>
              <button type="button" className="btn-link" onClick={() => setMode("graph")}>关系视角 <ArrowUpRight size={13} /></button>
            </div>
            <div className="dossier-scroll" ref={dossier}>
              <div className="dossier-inner">
                <header className="dossier-head">
                  <div><h1 className="dossier-title">{topic.name}</h1><div className="dossier-meta">{meta.map((value, index) => <span key={index}>{index > 0 && <span aria-hidden="true">· </span>}{value}</span>)}</div></div>
                  <div className="topic-actions">
                    <button type="button" className={`btn-ghost small-action${data.selectedTagFavorite ? " active" : ""}`} onClick={data.onToggleSelectedTagFavorite}>{data.selectedTagFavorite ? "★ 已置顶" : "☆ 置顶"}</button>
                    <button type="button" className="btn-ghost small-action" onClick={() => catalog.onSearch(topic.name)}>在搜索中看</button>
                    {ask && <button type="button" className="btn-primary small-action" onClick={ask}>问助手</button>}
                  </div>
                </header>
                <div className="ai-brief-card"><div className="ai-brief-head"><span>✦ 主题说明</span><button type="button" className="btn-link" onClick={() => setOverlay("assignment")}>编辑说明</button></div><div className="ai-brief-text">{description || "尚未填写主题说明"}</div></div>
                {topicSuggestions.length > 0 && <section aria-label="AI 发现的相关笔记">
                  <div className="section-cap"><span className="topic-accent">✦ AI 发现的相关笔记</span><span className="mono">{topicSuggestions.length} 篇</span></div>
                  <div className="inset-group">{topicSuggestions.slice(0, 3).map(item => <div className="doc-row" key={item.proposalId}>
                    <div className="doc-title">{item.proposal.title}</div><div className="doc-excerpt">{item.proposal.rationale}</div>
                    <button type="button" className="btn-ghost small-action" onClick={() => { setPendingProposal(item.proposalId); setOverlay("assignment"); }}>查看建议</button>
                  </div>)}</div>
                </section>}
                <div className="section-cap"><span>已归入本主题的笔记</span><button type="button" className="btn-link" onClick={() => setOverlay("assignment")}>内容补标</button><span className="mono">{ready ? `${notes.length} 篇` : ""}</span></div>
                <div className="inset-group" aria-busy={!ready}>
                  {notes.slice(0, noteLimit).map(result => <button type="button" className={`doc-row${result.id === note?.id ? " selected" : ""}`} aria-current={result.id === note?.id ? "true" : undefined} key={result.entityKey || result.id} onClick={() => readNote(result)} onDoubleClick={() => data.onOpenResult(result)}>
                    <span className="doc-row-head"><span className="doc-title">{resultDisplayTitle(result)}</span><span className="doc-meta mono">{noteMeta(result)}</span></span>
                    {result.snippet && <span className="doc-excerpt">{result.snippet}</span>}
                  </button>)}
                  {notes.length > noteLimit && <button type="button" className="btn-link topic-more" onClick={() => setNoteLimit(limit => limit + PAGE_SIZE)}>显示更多笔记</button>}
                  {!notes.length && <p role="status" className="topic-empty">{data.error || (!ready ? "正在读取笔记…" : "当前范围内暂无笔记")}</p>}
                </div>
                {note && <article className="reader-box" ref={reader}>
                  <header className="reader-head"><div><strong>{resultDisplayTitle(note)}</strong><div className="doc-meta mono">{noteMeta(note)}</div></div><div className="topic-actions">
                    <button type="button" aria-pressed={serif} className={`btn-ghost small-action${serif ? " active" : ""}`} onClick={() => setSerif(value => !value)}>衬线阅读</button>
                    <button type="button" className="btn-link" onClick={() => data.onOpenResult(note)}>定位原文 <ArrowUpRight size={13} /></button>
                  </div></header>
                  <div className={`reader-prose${serif ? " serif" : ""}`}>{preview.selected?.id === note.id && !preview.previewLoading && preview.renderedPreviewMarkdown ? preview.renderedPreviewMarkdown : <p>{note.snippet || "可打开原文阅读完整内容。"}</p>}</div>
                </article>}
              </div>
            </div>
          </> : <p className="topic-empty">{data.tagsLoading ? "正在读取主题…" : "暂无主题"}</p>}
        </div>
      </main>
    </div>}

    {view === "graph" && (topic ? <TopicRelationView topic={topic} description={description} group={group} meta={meta.join(" · ")} notes={notes} busy={!ready} relations={graphRelations} trail={currentTrail} descriptions={properties}
      onVisit={next => { setTrail([...currentTrail, next]); selectTopic(next); }} onRewind={index => { setTrail(currentTrail.slice(0, index + 1)); selectTopic(currentTrail[index]); }}
      onRead={result => { setMode("browse"); if (result) readNote(result); }} onAsk={ask} showCandidates={showCandidates} onToggleCandidates={() => setShowCandidates(value => !value)} onLink={() => setOverlay("link")} /> : <p className="topic-empty">暂无主题</p>)}

    {activeOverlay === "new" && <TopicDialog label="新建一个主题" onClose={closeOverlay}><NewTopicForm groups={catalog.groups} onClose={closeOverlay} onCreate={(name, groupId, summary) => {
      const next = catalog.onCreate(name, groupId, summary);
      if (next) { setFilter("all"); setQuery(""); setCollapsed(false); setMode("browse"); selectTopic(next); closeOverlay(); }
      return next;
    }} /></TopicDialog>}
    {activeOverlay === "tidy" && <TopicDialog label="顺手整理" drawer onClose={closeOverlay}>
      <div className="topic-dialog-body">
        {data.tagLibraries && data.onChangeTagLibraries && <TagLibraryFilter libraries={data.tagLibraries} selectedIds={data.selectedTagLibraryIds ?? null} onChange={data.onChangeTagLibraries} />}
        <TagGovernanceInbox onOpenEvidence={showEvidence} onTaxonomyChanged={data.onSelectedTagTaxonomyChanged} />
        <TagAssignmentInbox onOpenEvidence={showEvidence} onChanged={refreshSuggestions} />
        <div className="section-cap"><span>系统已隐藏的排版杂项</span><button className="btn-link" type="button" onClick={() => setShowNoise(value => !value)}>{showNoise ? "收起" : `查看 ${hiddenTags.length} 项`}</button></div>
        {showNoise && <ul className="topic-noise-list">{hiddenTags.map(tag => <li key={tag.normalizedName}>{tag.name} · {tagCleanupReason(tag) ?? "排版标记"}</li>)}</ul>}
      </div>
    </TopicDialog>}
    {activeOverlay === "assignment" && topic && <TopicDialog label="主题说明与内容补标" drawer onClose={closeOverlay}><div className="topic-dialog-body">
      {!proposalIds && <TagPropertiesCard tag={topic} color={data.selectedTagColor ?? defaultTagColor(topic.normalizedName)} description={description} parent={data.selectedTagParent} aliases={data.selectedTagAliases}
        taxonomy={data.selectedTagTaxonomy} groupLabel={group} libraryCount={data.selectedTagLibraryCount ?? 0} lastUpdatedLabel={data.selectedTagLastUpdated ?? "暂无"} relatedTags={data.selectedTagRelated ?? []} favorite={data.selectedTagFavorite ?? false}
        onChangeColor={color => data.onChangeSelectedTagColor?.(color)} onChangeDescription={value => data.onChangeSelectedTagDescription?.(value)} onToggleFavorite={() => data.onToggleSelectedTagFavorite?.()} onSelectRelatedTag={selectTopic} />}
      <TagAssignmentInbox key={topic.normalizedName} tagId={topic.normalizedName} proposalIds={proposalIds} userDescription={description} onOpenEvidence={showEvidence} onChanged={() => { data.onSelectedTagTaxonomyChanged?.(); refreshSuggestions(); }} onDescriptionSaved={data.onChangeSelectedTagDescription} />
    </div></TopicDialog>}
    {activeOverlay === "link" && topic && <TopicDialog label="手动连接主题" onClose={closeOverlay}>
      <form className="topic-form" onSubmit={event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const target = String(form.get("target"));
        if (!tagsById.has(target) || connectedIds.has(target) || target === topic.normalizedName) return;
        saveLinks([...links, { source: topic.normalizedName, target, label: String(form.get("label")).trim() }]);
        closeOverlay();
      }}>
        <label>从「{topic.name}」连接到<select name="target" required defaultValue=""><option value="" disabled>选择一个主题</option>{tags.filter(tag => !isTopicFormattingArtifact(tag) && tag.normalizedName !== topicId && !connectedIds.has(tag.normalizedName)).map(tag => <option value={tag.normalizedName} key={tag.normalizedName}>{tag.name}</option>)}</select></label>
        <label>连接说明<input name="label" placeholder="例如：进一步阅读" maxLength={32} /></label>
        {manual.map(item => <div className="reader-head" key={item.tag.normalizedName}><span>{item.tag.name} · {item.label}</span><button className="btn-link" type="button" onClick={() => saveLinks(links.filter(link => !((link.source === topicId && link.target === item.tag.normalizedName) || (link.target === topicId && link.source === item.tag.normalizedName))))}>移除</button></div>)}
        <footer><button className="btn-link" type="button" onClick={() => setOverlay("relations")}>查看关系建议</button><button className="btn-ghost" type="button" onClick={closeOverlay}>取消</button><button className="btn-primary" type="submit">建立连接</button></footer>
      </form>
    </TopicDialog>}
    {activeOverlay === "relations" && topic && <TopicDialog label="主题关系整理" drawer onClose={closeOverlay}><div className="topic-dialog-body"><TagGovernanceInbox tagId={topic.normalizedName} onOpenEvidence={showEvidence} onTaxonomyChanged={() => { data.onSelectedTagTaxonomyChanged?.(); setRelationRevision(value => value + 1); }} /></div></TopicDialog>}
    {activeOverlay === "evidence" && <TopicDialog label="原文证据" drawer onClose={closeOverlay}><div className="topic-dialog-body reader-prose">{preview.selected && <div className="reader-head"><strong>{preview.selected.title}</strong><button type="button" className="btn-link" onClick={() => data.onOpenResult(preview.selected!)}>定位原文 <ArrowUpRight size={13} /></button></div>}{preview.previewLoading ? <p role="status">正在读取笔记…</p> : preview.renderedPreviewMarkdown}</div></TopicDialog>}
  </section>;
}
