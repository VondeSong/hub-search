"use client";
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, FileText, FolderBookmark, Library, Search, SlidersHorizontal, X } from 'lucide-react';
import { researchPolicies, resolveTopicSources, TopicSourceReview, type ResearchPolicy, type ResearchTopic } from './AssistantResearch';
import type { AssistantContext } from './Assistant';
import type { ResourceDraft } from './AssistantResources';

type ScopePage = 'overview' | 'pages' | 'topic';

export function AssistantMaterialScope({ catalog, resources, onChange, material, current, disabled, policy, webStatus, onPolicy, onSave, editingTopic, skillNames, onAttachCurrent, onRemoveCurrent, onDone, topicScope, manualOnce }: {
  catalog: AssistantContext[]; resources: ResourceDraft; onChange: (value: ResourceDraft) => void;
  material: AssistantContext | null; current: AssistantContext | null; disabled: boolean;
  policy: ResearchPolicy; webStatus: string; onPolicy: (value: ResearchPolicy) => void;
  onSave: (name: string, includeSkills: boolean) => boolean; editingTopic?: ResearchTopic; skillNames: string[]; onAttachCurrent: () => void; onRemoveCurrent: () => void; onDone: () => void;
  topicScope?: ResourceDraft; manualOnce?: { checked: boolean; count: number; onChange: (checked: boolean) => void };
}) {
  const [page, setPage] = useState<ScopePage>('overview');
  const [expanded,setExpanded]=useState({policy:false,libraries:false});
  const [query, setQuery] = useState('');
  const [name, setName] = useState(editingTopic?.name || '');
  const [includeSkills, setIncludeSkills] = useState(!!editingTopic?.skillIds?.length);
  const [pageLimit, setPageLimit] = useState(12);
  const body = useRef<HTMLDivElement>(null);
  const previous = useRef<ScopePage>('overview');
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
    const target = page === 'overview' ? body.current?.querySelector<HTMLElement>('[data-scope-page="' + previous.current + '"]') : body.current?.querySelector<HTMLElement>('[data-scope-focus]');
    target?.focus({ preventScroll: true });
    if (page !== 'overview') previous.current = page;
  }, [page]);

  const libraries = [...new Map(catalog.filter(item => item.libraryId).map(item => [item.libraryId!, item.libraryName || item.libraryId!])).entries()];
  const libraryNames = resources.libraryIds.map(id => libraries.find(([key]) => key === id)?.[1] || '不可用资料库');
  const selectedPages = [...new Map([...(material ? [material] : []), ...resources.pages].map(item => [item.id, item])).values()];
  const selected = new Set(selectedPages.map(item => item.id));
  const available = new Set(catalog.map(item => item.id));
  const hasScope = !!(selectedPages.length || resources.libraryIds.length);
  const policyName = researchPolicies.find(item => item.id === policy)?.name || '材料优先';
  const allPages = [...selectedPages, ...catalog.filter(item => !selected.has(item.id))];
  const keyword = query.trim().toLowerCase();
  const matchingPages = keyword ? allPages.filter(item => [item.title, item.libraryName, item.path].filter(Boolean).join(' ').toLowerCase().includes(keyword)) : allPages;
  const pageResults = matchingPages.slice(0, Math.max(pageLimit, selectedPages.length));
  const review = page === 'topic' ? resolveTopicSources({ pageIds: selectedPages.map(item => item.id), libraryIds: resources.libraryIds,
    pageLabels: Object.fromEntries(selectedPages.map(item => [item.id, item.title])), libraryLabels: editingTopic?.libraryLabels }, catalog) : null;
  const missing = !!review?.sources.some(item => !item.available);
  const canSave = !!review?.sources.some(item => item.available);

  const allLibraries = !!libraries.length && libraries.every(([id]) => resources.libraryIds.includes(id));
  const title = { overview: '资料范围', pages: '核心材料', topic: editingTopic ? '更新专题' : topicScope ? '保存手选为专题' : '保存为专题' }[page];
  const formId = 'ha-save-research-topic';
  function togglePage(item: AssistantContext) {
    if (item.id === material?.id) { onRemoveCurrent(); return; }
    onChange({ ...resources, pages: selected.has(item.id) ? resources.pages.filter(value => value.id !== item.id) : [...resources.pages, item] });
  }

  return <section className="ha-menu ha-composer-menu ha-material-menu" aria-label="资料范围">
    <header className="ha-scope-header">
      {page !== 'overview' && <button type="button" className="ha-icon" aria-label="返回资料范围" onClick={() => setPage('overview')}><ArrowLeft size={16}/></button>}
      <h3>{title}</h3>
      <button type="button" className="ha-icon" aria-label="关闭资料范围" onClick={onDone}><X size={17}/></button>
    </header>
    <div className="ha-scope-body" ref={body}>
      {page === 'overview' && <>
        <div className="ha-scope-overview">
          <button type="button" data-scope-page="policy" aria-expanded={expanded.policy} aria-controls="ha-scope-policy" onClick={()=>setExpanded(value=>({...value,policy:!value.policy}))}><SlidersHorizontal size={16}/><strong>资料策略</strong><span>{policyName}</span><ChevronDown className={expanded.policy?'is-open':''} size={14}/></button>
          {expanded.policy&&<div className="ha-scope-inline" id="ha-scope-policy" role="region" aria-label="资料策略选项">
        <fieldset className="ha-scope-policies"><legend className="ha-sr-only">怎样使用资料</legend>
          {researchPolicies.map((item, index) => <label className="ha-resource-choice" key={item.id}><input data-scope-focus={index === 0 ? '' : undefined} type="radio" name="ha-research-policy" value={item.id} disabled={disabled} checked={policy === item.id} onChange={() => onPolicy(item.id)}/><span><strong>{item.name}</strong><small>{item.hint}</small></span></label>)}
        </fieldset>
        {webStatus && <p className="ha-scope-hint">{webStatus}</p>}
      </div>}
          <button type="button" data-scope-page="pages" onClick={() => setPage('pages')}><FileText size={16}/><strong>核心材料</strong><span>{selectedPages.length ? (topicScope ? '手选 ' : '已选 ') + selectedPages.length + ' 页' : '添加页面'}</span><ChevronRight size={14}/></button>
          <button type="button" data-scope-page="libraries" aria-expanded={expanded.libraries} aria-controls="ha-scope-libraries" onClick={()=>setExpanded(value=>({...value,libraries:!value.libraries}))}><Library size={16}/><strong>可检索的资料库</strong><span title={libraryNames.join('、')}>{libraryNames.length > 2 ? libraryNames.length + ' 个库' : libraryNames.join('、') || '未选择'}</span><ChevronDown className={expanded.libraries?'is-open':''} size={14}/></button>
          {expanded.libraries&&<div className="ha-scope-inline" id="ha-scope-libraries" role="region" aria-label="资料库选择">
        <p className="ha-scope-hint">只在所选库中按问题查找相关内容。</p>
        {libraries.length > 0 && <label className="ha-resource-choice"><Library size={16}/><span>全部资料库</span><input data-scope-focus type="checkbox" aria-label="选择全部资料库" disabled={disabled} checked={allLibraries} onChange={event => onChange({ ...resources, libraryIds: event.target.checked ? libraries.map(([id]) => id) : [] })}/></label>}
        {!libraries.length && !resources.libraryIds.length && <p className="ha-scope-hint">当前没有可检索的资料库。</p>}
        {[...libraries, ...resources.libraryIds.filter(id => !libraries.some(([key]) => key === id)).map(id => [id, '不可用资料库'] as const)].map(([id, label]) => <label className="ha-resource-choice" key={id}><Library size={16}/><span>{label}{topicScope?.libraryIds.includes(id) && <small>专题已包含</small>}</span><input type="checkbox" aria-label={'允许查找 ' + label} disabled={disabled} checked={resources.libraryIds.includes(id)} onChange={event => onChange({ ...resources, libraryIds: event.target.checked ? [...resources.libraryIds, id] : resources.libraryIds.filter(value => value !== id) })}/></label>)}
      </div>}
        </div>
        {manualOnce && <label className="ha-resource-choice"><input type="checkbox" checked={manualOnce.checked} disabled={disabled || (!manualOnce.count && !manualOnce.checked)} onChange={event => manualOnce.onChange(event.target.checked)}/><span><strong>下一条消息也使用手选资料</strong><small>{manualOnce.count ? '仅对下一条消息生效。会在专题范围外加入手选的页面、库或附件。' : '可先选页面、资料库或添加附件。'}</small></span></label>}
        {editingTopic && <p className="ha-scope-hint">正在调整「{editingTopic.name}」。更新会保存到专题，当前对话不受影响。</p>}
        {policy === 'materials-only' && resources.url && <p className="ha-scope-hint">{webStatus}</p>}
      </>}
      {page === 'pages' && <>
        <label className="ha-resource-search"><Search size={16}/><input data-scope-focus type="search" aria-label="搜索页面标题、路径或资料库" placeholder="搜索页面标题、路径或资料库" value={query} maxLength={200} onChange={event => { setQuery(event.target.value); setPageLimit(12); }}/></label>
        {current && !selected.has(current.id) && <button type="button" className="ha-menu-choice" disabled={disabled || resources.pages.length >= 31} onClick={onAttachCurrent}><FileText size={16}/><span><strong>添加当前页面</strong><small>{current.title}</small></span></button>}
        {!pageResults.length && <p className="ha-scope-hint">没有找到页面。</p>}
        {pageResults.map(item => <label className="ha-resource-choice" key={item.id}><input type="checkbox" aria-label={'选择资料 ' + item.title} disabled={disabled || (!selected.has(item.id) && resources.pages.length >= 31)} checked={selected.has(item.id)} onChange={() => togglePage(item)}/><span><strong>{item.title}</strong><small>{[item.libraryName || 'Hub', item.path].filter(Boolean).join(' · ')}{!available.has(item.id) && item.id !== material?.id ? ' · 当前不可用' : selected.has(item.id) ? (topicScope ? ' · 手选' : ' · 已加入') : ''}{topicScope?.pages.some(page => page.id === item.id) ? ' · 专题已包含' : ''}</small></span></label>)}
        {matchingPages.length > pageResults.length && <button type="button" className="ha-mode-link" onClick={() => setPageLimit(pageResults.length + 12)}>查看更多页面（{pageResults.length} / {matchingPages.length}）</button>}
      </>}
      {page === 'topic' && <form id={formId} className="ha-scope-topic" onSubmit={event => {
        event.preventDefault();
        if (!disabled && canSave && name.trim() && onSave(name.trim(), includeSkills)) { setName(''); setIncludeSkills(false); setPage('overview'); }
      }}><label>专题名称<input data-scope-focus value={name} onChange={event => setName(event.target.value)} placeholder="例如：线束设计评审" maxLength={60}/></label>
        <p className="ha-scope-hint">资料策略：{policyName}</p>
        {review && <TopicSourceReview sources={review.sources}/>}
        {missing && <p className="ha-scope-hint" role="status">{canSave ? '不可用资料不会写入专题。确认后可只保存可用资料。' : '当前没有可用资料，请返回调整范围。'}</p>}
        {!!skillNames.length && <label className="ha-resource-choice"><input type="checkbox" checked={includeSkills} disabled={disabled} onChange={event => setIncludeSkills(event.target.checked)}/><span><strong>同时保存已选技能</strong><small>{skillNames.join('、')}</small></span></label>}
      </form>}
    </div>
    <footer className="ha-scope-footer">
      {page === 'overview' && <><p>{editingTopic ? '选好资料后更新专题。' : topicScope ? '这里编辑手选资料。专题资料可在输入框的专题标签里查看或移除。' : hasScope ? '所选范围用于下一轮；切换浏览页面不会自动加入资料。' : '未选资料，可直接提问。'}</p><div><button type="button" className="ha-secondary-button" disabled={disabled || !hasScope} onClick={() => setPage('topic')}><FolderBookmark size={14}/>{editingTopic ? '更新专题' : topicScope ? '保存手选为专题' : '保存为专题'}</button><button type="button" className="ha-primary-button" onClick={onDone}>{editingTopic ? '返回专题' : '完成'}</button></div></>}
      {page === 'topic' && <div><button type="button" className="ha-secondary-button" onClick={() => setPage('overview')}>取消</button><button type="submit" form={formId} className="ha-primary-button" disabled={disabled || !canSave || !name.trim()}>{missing ? '保存可用资料' : editingTopic ? '确认更新' : '保存专题'}</button></div>}
      {page !== 'overview' && page !== 'topic' && <div><button type="button" className="ha-primary-button" onClick={() => setPage('overview')}>完成选择</button></div>}
    </footer>
  </section>;
}
