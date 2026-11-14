import { useEffect, useRef, useState } from "react";
import { AgentLibraryScope } from "./AgentLibraryScope";
import { AgentMaterials, materialKey, type AgentMaterial } from "./AgentMaterials";
import type { ResearchTopic } from "./AgentResearch";
import type { AgentLibraryRegistry } from "./useAgentLibraryRegistry";

export function AgentTopicScopeEditor({ topic, registry, disabled, onSave, onCancel }: {
  topic: ResearchTopic; registry: AgentLibraryRegistry; disabled: boolean;
  onSave: (topic: ResearchTopic) => Promise<void>; onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(topic));
  const [pages, setPages] = useState<AgentMaterial[]>(() => topic.grant.notes.map(locator => ({
    locator,
    title: topic.versions?.find(v => v.locator.kind === "note" && materialKey(v.locator) === materialKey(locator))?.title || locator.documentId,
    path: "", libraryName: registry.libraries.find(l => l.id === locator.libraryId)?.name || locator.libraryId,
  })));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => { content.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus(); }, []);
  const saving = useRef(false);
  const blocked = disabled || busy;
  const empty = !pages.length && !draft.grant.libraryIds.length && !draft.grant.sources?.length && !draft.grant.readingItemKeys.length;
  async function save() {
    if (blocked || empty || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      const { images: _, ...grant } = draft.grant;
      await onSave({ ...draft, grant: { ...grant, notes: pages.map(p => p.locator) }, versions: [] });
    } catch (reason) { setError(String(reason)); }
    finally { saving.current = false; setBusy(false); }
  }
  return <div ref={content} aria-label="编辑专题资料">
    <button type="button" disabled={blocked} onClick={onCancel}>返回专题核对</button>
    <h3>{topic.title}</h3>
    <p className="agent-note">这里只编辑专题配置。保存后重新核对，确认应用才改变当前对话的下一轮范围。</p>
    <details className="agent-run-details" open><summary>核心材料 · {pages.length}</summary>
      <AgentMaterials embedded hideFooter selected={pages} disabled={blocked} onChange={setPages}
        description="搜索并选择专题的核心页面；手选资料、技能和输入草稿保留。" />
    </details>
    <details className="agent-run-details"><summary>可检索的资料库 · {draft.grant.libraryIds.length}</summary>
      <AgentLibraryScope registry={registry} selected={draft.grant.libraryIds.map(id => ({ id, name: registry.libraries.find(l => l.id === id)?.name || id }))}
        disabled={blocked} description="只保存到专题；重新核对并确认应用后生效。"
        onChange={libraries => setDraft({ ...draft, grant: { ...draft.grant, libraryIds: libraries.map(l => l.id) } })} />
    </details>
    {!!draft.grant.sources?.length && <div className="agent-note">{draft.grant.sources.map((locator, index) => <div key={JSON.stringify(locator)}>
      <span>{topic.versions?.find(v => JSON.stringify(v.locator) === JSON.stringify(locator))?.title || `其他核心资料 ${index + 1}`}</span>
      <button type="button" disabled={blocked} onClick={() => setDraft({ ...draft, grant: { ...draft.grant, sources: draft.grant.sources?.filter((_, i) => i !== index) } })}>移除这份专题资料</button>
    </div>)}</div>}
    {!!draft.grant.readingItemKeys.length && <div className="agent-note">{draft.grant.readingItemKeys.map(key => <div key={key}>
      <span>{topic.versions?.find(v => v.locator.kind === "reading" && v.locator.itemKey === key)?.title || "阅读资料"}</span>
      <button type="button" disabled={blocked} onClick={() => setDraft({ ...draft, grant: { ...draft.grant, readingItemKeys: draft.grant.readingItemKeys.filter(k => k !== key) } })}>移除这份阅读资料</button>
    </div>)}</div>}
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={blocked || empty} onClick={() => void save()}>保存资料并重新核对</button>
    <button type="button" disabled={blocked} onClick={onCancel}>取消修改</button>
  </div>;
}
