import { ArrowRight, ChevronRight, Plus } from "lucide-react";
import type { SidebarTagSummary } from "./DesktopSidebarPresentation";
import { providerName } from "./ProviderLabels";
import { formatDate, resultDisplayTitle } from "./SearchResultPresentation";
import type { SearchResult } from "./SearchTypes";
import type { TagTaxonomySummary } from "./TagTaxonomy";

export type TopicRelation = { tag: SidebarTagSummary; label: string; kind: "parent" | "child" | "confirmed" | "cooccur" | "manual" | "candidate" };

export function topicRelations(topic: SidebarTagSummary, tags: ReadonlyMap<string, SidebarTagSummary>, taxonomy: TagTaxonomySummary | null | undefined, related: SidebarTagSummary[]): TopicRelation[] {
  const visited = new Set([topic.normalizedName]);
  const relations: TopicRelation[] = [];
  function add(tag: SidebarTagSummary | undefined, label: string, kind: TopicRelation["kind"]) {
    if (!tag || visited.has(tag.normalizedName)) return;
    visited.add(tag.normalizedName);
    relations.push({ tag, label, kind });
  }
  const lookup = (id: string) => tags.get(id) ?? { name: id, normalizedName: id, count: 0 };
  taxonomy?.parents.slice(0, 2).forEach(id => add(lookup(id), "上位标签", "parent"));
  taxonomy?.children.slice(0, 2).forEach(id => add(lookup(id), "下位标签", "child"));
  [taxonomy?.canonicalTagId, ...(taxonomy?.aliases ?? []), ...(taxonomy?.mergedSources ?? [])].filter((id): id is string => Boolean(id)).slice(0, 3)
    .forEach(id => add(lookup(id), "已确认归并", "confirmed"));
  related.forEach(tag => add(tags.get(tag.normalizedName) ?? tag, `共现 ${tag.count}`, "cooccur"));
  return relations;
}

const neighborSlots = [[18, 38], [82, 38], [18, 63], [82, 63]];

type Props = {
  topic: SidebarTagSummary;
  description: string;
  group: string;
  meta: string;
  notes: SearchResult[];
  busy: boolean;
  relations: TopicRelation[];
  trail: SidebarTagSummary[];
  descriptions: Record<string, { description?: string }>;
  onVisit: (topic: SidebarTagSummary) => void;
  onRewind: (index: number) => void;
  onRead: (note?: SearchResult) => void;
  onAsk?: () => void;
  showCandidates: boolean;
  onToggleCandidates: () => void;
  onLink: () => void;
};

export function TopicRelationView({ topic, description, group, meta, notes, busy, relations, trail, descriptions, onVisit, onRewind, onRead, onAsk, showCandidates, onToggleCandidates, onLink }: Props) {
  const parents = relations.filter(item => item.kind === "parent").slice(0, 2);
  const children = relations.filter(item => item.kind === "child").slice(0, 2);
  const neighbors = relations.filter(item => item.kind !== "parent" && item.kind !== "child").slice(0, neighborSlots.length);
  const nodes = [
    ...parents.map((relation, index) => ({ relation, x: parents.length === 1 ? 50 : 33 + index * 34, y: 14 })),
    ...neighbors.map((relation, index) => ({ relation, x: neighborSlots[index][0], y: neighborSlots[index][1] })),
    ...children.map((relation, index) => ({ relation, x: children.length === 1 ? 50 : 32 + index * 36, y: 86 })),
  ];
  const showGroup = parents.length === 0 && group !== "未分组";

  return <div className="graph-stage" aria-label="主题关系视角">
    <section className="graph-canvas-paper" aria-label={`${topic.name} 关系图`}>
      <div className="graph-crumb-bar">
        <nav className="crumb-trail" aria-label="漫游路径">
          <span>漫游路径</span>
          {trail.map((entry, index) => <span className="crumb-step" key={`${index}:${entry.normalizedName}`}>
            {index > 0 && <ChevronRight size={12} aria-hidden="true" />}
            <button type="button" className={`crumb-btn${index === trail.length - 1 ? " current" : ""}`} aria-current={index === trail.length - 1 ? "location" : undefined} onClick={() => onRewind(index)}>{entry.name}</button>
          </span>)}
        </nav>
        <div className="topic-actions">
          <button type="button" className={`btn-ghost small-action${showCandidates ? " active" : ""}`} aria-pressed={showCandidates} onClick={onToggleCandidates}>AI 潜在线</button>
          <button type="button" className="btn-ghost small-action" onClick={onLink}><Plus size={13} />手动连线</button>
        </div>
      </div>
      <div className="graph-viewport">
        <svg className="graph-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {showGroup && <path d="M 50 14 L 50 50" />}
          {nodes.map(({ relation, x, y }) => <path key={relation.tag.normalizedName} className={relation.kind} d={`M 50 50 Q ${x} 50 ${x} ${y}`} />)}
        </svg>
        {(showGroup || parents.length > 0) && <span className="graph-layer-label graph-parent-label">上位领域</span>}
        {children.length > 0 && <span className="graph-layer-label graph-child-label">子脉络与锚点</span>}
        <span className="graph-layer-label graph-help">点相邻节点漫游 · 点中心卡回到主题详读</span>
        {showGroup && <span className="g-node parent-node" style={{ left: "50%", top: "14%" }}>{group}</span>}
        {nodes.map(({ relation, x, y }) => <div key={relation.tag.normalizedName}>
          <span className={`g-edge-pill ${relation.kind}`} style={{ left: `${(x + 50) / 2}%`, top: `${(y + 50) / 2}%` }}>{relation.label}</span>
          <button type="button" className={`g-node ${relation.kind}`} style={{ left: `${x}%`, top: `${y}%` }} onClick={() => onVisit(relation.tag)}>
            <span className="g-node-title"><span>{relation.tag.name}</span><small className="mono">{relation.tag.count}</small></span>
            {descriptions[relation.tag.normalizedName]?.description && <span className="g-node-sub">{descriptions[relation.tag.normalizedName].description}</span>}
          </button>
        </div>)}
        <button type="button" className="g-node center" style={{ left: "50%", top: "50%" }} onClick={() => onRead()}>
          <span className="g-node-title"><span>{topic.name}</span><small className="mono">{topic.count} 篇</small></span>
          <span className="g-node-sub">{description || "尚未填写主题说明"}</span>
          <span className="g-center-foot"><span>{relations.length ? `${relations.length} 条关联` : "暂无已索引关联"}</span><span>在主题浏览中精读 →</span></span>
        </button>
      </div>
    </section>
    <aside className="graph-preview-card" aria-label="主题预览">
      <div className="preview-body">
        <div><h2>{topic.name}</h2><div className="dossier-meta">{meta}</div></div>
        <div className="ai-brief-card"><div className="ai-brief-head">✦ 主题说明</div><div className="ai-brief-text">{description || "尚未填写主题说明"}</div></div>
        <section aria-label="代表笔记">
          <div className="section-cap"><span>代表笔记</span><span className="mono">{busy ? "" : `${notes.length} 篇`}</span></div>
          <div className="inset-group" aria-busy={busy}>
            {notes.slice(0, 2).map(note => <button type="button" className="doc-row" key={note.entityKey || note.id} onClick={() => onRead(note)}>
              <span className="doc-title">{resultDisplayTitle(note)}</span>
              <span className="doc-meta mono">{providerName(note.provider)} · {formatDate(note.modifiedAt)}</span>
            </button>)}
            {!notes.length && <p className="topic-empty">{busy ? "正在读取笔记…" : "当前范围内暂无笔记"}</p>}
          </div>
        </section>
      </div>
      <div className="preview-foot">
        <button type="button" className="btn-primary" onClick={() => onRead()}>在主题浏览中精读 <ArrowRight size={14} /></button>
        {onAsk && <button type="button" className="btn-ghost" onClick={onAsk}>问助手</button>}
      </div>
    </aside>
  </div>;
}
