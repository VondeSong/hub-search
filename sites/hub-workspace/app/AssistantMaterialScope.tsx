"use client";
import {AssistantDataMaterials} from './AssistantDataMaterials';
import { useEffect, useId, useRef, useState } from 'react';
import { AssistantOverlay } from './AssistantOverlay';
import { ChevronDown, ChevronRight, FileText, FolderBookmark, Image, Library, Search, Sheet, SlidersHorizontal, X } from 'lucide-react';
import { researchPolicies, resolveTopicSources, TopicSourceReview, type ResearchPolicy, type ResearchTopic } from './AssistantResearch';
import type { AssistantContext } from './Assistant';
import type { ResourceDraft } from './AssistantResources';
import { AssistantVisualMaterials } from './AssistantVisualMaterials';

type ScopePage = 'overview' | 'pages' | 'topic' | 'data' | 'images';

export function AssistantMaterialScope({ catalog, resources, onChange, material, current, disabled, policy, webStatus, onPolicy, onSave, editingTopic, skillNames, onAttachCurrent, onRemoveCurrent, onDone, topicScope, manualOnce, effectiveScope }: {
  catalog: AssistantContext[]; resources: ResourceDraft; onChange: (value: ResourceDraft) => void;
  material: AssistantContext | null; current: AssistantContext | null; disabled: boolean;
  policy: ResearchPolicy; webStatus: string; onPolicy: (value: ResearchPolicy) => void;
  onSave: (name: string, includeSkills: boolean) => boolean; editingTopic?: ResearchTopic; skillNames: string[]; onAttachCurrent: () => void; onRemoveCurrent: () => void; onDone: () => void;
  effectiveScope?: boolean; topicScope?: ResourceDraft; manualOnce?: { checked: boolean; count: number; onChange: (checked: boolean) => void };
}) {
  const [page, setPage] = useState<ScopePage>('overview');
  const [expanded,setExpanded]=useState({policy:false,libraries:false});
  const [query, setQuery] = useState('');
  const [name, setName] = useState(editingTopic?.name || '');
  const [includeSkills, setIncludeSkills] = useState(!!editingTopic?.skillIds?.length);
  const [pageLimit, setPageLimit] = useState(12);
  const [filter, setFilter] = useState<'all' | 'selected'>('all');
  const [selectionDraft, setSelectionDraft] = useState<ResourceDraft>(resources);
  const instanceId = useId();
  const search = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const previous = useRef<ScopePage>('overview');
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
    const target = page === 'pages' ? search.current : page === 'overview' ? body.current?.closest('[data-assistant-overlay]')?.querySelector<HTMLElement>('[data-scope-page="' + (previous.current === 'topic' ? 'topic' : 'pages') + '"]') : body.current?.querySelector<HTMLElement>('[data-scope-focus], input');
    target?.focus({ preventScroll: true });
    if (page !== 'overview') previous.current = page;
  }, [page]);

  const libraries = [...new Map(catalog.filter(item => item.libraryId).map(item => [item.libraryId!, item.libraryName || item.libraryId!])).entries()];
  const libraryNames = resources.libraryIds.map(id => libraries.find(([key]) => key === id)?.[1] || '不可用资料库');
  const selectedPages = [...new Map([...(material ? [material] : []), ...resources.pages].map(item => [item.id, item])).values()];
  const selected = new Set(selectedPages.map(item => item.id));
  const available = new Set(catalog.map(item => item.id));
  const hasScope = !!(selectedPages.length || resources.libraryIds.length);
  const canChoosePolicy = effectiveScope ?? hasScope;
  const needsMaterial = !canChoosePolicy && policy === 'materials-only';
  const policyName = researchPolicies.find(item => item.id === policy)?.name || '材料优先';
  const draftSelected = new Set(selectionDraft.pages.map(item => item.id));
  const allPages = [...new Map([...selectionDraft.pages, ...(current ? [current] : []), ...catalog].map(item => [item.id, item])).values()];
  const keyword = query.trim().toLowerCase();
  const matchingPages = allPages.filter(item => (filter === 'all' || draftSelected.has(item.id)) && (!keyword || [item.title, item.libraryName, item.path].filter(Boolean).join(' ').toLowerCase().includes(keyword)));
  const showCurrent = !keyword && filter === 'all' && !!current;
  const listPages = matchingPages.filter(item => !showCurrent || item.id !== current?.id);
  const pageResults = listPages.slice(0, pageLimit);
  const attachmentCount = (selectionDraft.dataFiles?.length || 0) + selectionDraft.images.length;
  const review = page === 'topic' ? resolveTopicSources({ pageIds: selectedPages.map(item => item.id), libraryIds: resources.libraryIds,
    pageLabels: Object.fromEntries(selectedPages.map(item => [item.id, item.title])), libraryLabels: editingTopic?.libraryLabels }, catalog) : null;
  const missing = !!review?.sources.some(item => !item.available);
  const canSave = !!review?.sources.some(item => item.available);

  const allLibraries = !!libraries.length && libraries.every(([id]) => resources.libraryIds.includes(id));
  const title = { overview: '资料范围', pages: '选择材料', data: '表格与数据文件', images: '图片与 PDF 页面', topic: editingTopic ? '更新专题' : topicScope ? '保存手选为专题' : '保存为专题' }[page];
  const formId = instanceId + '-topic';
  function beginSelection() {
    setSelectionDraft({ ...resources, pages: selectedPages });
    setPage('pages');
  }
  function togglePage(item: AssistantContext) {
    setSelectionDraft(value => ({ ...value, pages: value.pages.some(page => page.id === item.id) ? value.pages.filter(page => page.id !== item.id) : [...value.pages, item] }));
  }
  function applySelection() {
    if (disabled) return;
    if (material && !draftSelected.has(material.id)) onRemoveCurrent();
    onChange({ ...resources, pages: selectionDraft.pages.filter(item => item.id !== material?.id), dataFiles: selectionDraft.dataFiles, images: selectionDraft.images });
    setPage('overview');
  }
  function goBack() { setPage(page === 'data' || page === 'images' ? 'pages' : 'overview'); }
  function pageRow(item: AssistantContext) {
    const checked = draftSelected.has(item.id);
    const unavailable = !available.has(item.id) && item.id !== material?.id && item.id !== current?.id;
    return <label className="ha-resource-choice ha-material-page-row" key={item.id} data-selected={checked || undefined}>
      <input type="checkbox" aria-label={'选择资料 ' + item.title} disabled={disabled || (!checked && (selectionDraft.pages.length >= 31 || unavailable))} checked={checked} onChange={() => togglePage(item)}/>
      <span><strong>{item.title}</strong><small>{[item.libraryName || 'Hub', item.path].filter(Boolean).join(' · ')}{unavailable ? ' · 当前不可用，可移除' : topicScope?.pages.some(page => page.id === item.id) ? ' · 专题已包含' : ''}</small></span>
    </label>;
  }

  const toolbar = page === 'pages' ? <>
    <label className="ha-resource-search ha-material-search"><Search size={17} aria-hidden="true"/><input ref={search} data-overlay-autofocus type="search" aria-label="搜索页面标题、路径或资料库" placeholder="搜索页面、路径或资料库" value={query} maxLength={200} onChange={event => { setQuery(event.target.value); setPageLimit(12); }}/>{query && <button type="button" aria-label="清空材料搜索" className="ha-icon" onClick={() => { setQuery(''); setPageLimit(12); search.current?.focus(); }}><X size={15}/></button>}</label>
    <div className="ha-material-filter" aria-label="材料列表筛选"><button type="button" aria-pressed={filter === 'all'} onClick={() => { setFilter('all'); setPageLimit(12); }}>全部页面<small>{allPages.length}</small></button><button type="button" aria-pressed={filter === 'selected'} onClick={() => { setFilter('selected'); setPageLimit(12); }}>已选<small>{selectionDraft.pages.length}</small></button></div>
  </> : undefined;
  const footer = <div className="ha-scope-footer-content">
      {page === 'overview' && <><p>{editingTopic ? '选好资料后更新专题。' : topicScope ? '这里编辑手选资料。专题资料可在输入框的专题标签里查看或移除。' : hasScope ? '只附带所选页面；资料库检索范围单独设置。' : needsMaterial ? '' : '未选资料，可直接提问。'}</p><div><button type="button" data-scope-page="topic" className="ha-secondary-button" disabled={disabled || !hasScope} onClick={() => setPage('topic')}><FolderBookmark size={15}/>{editingTopic ? '更新专题' : topicScope ? '保存手选为专题' : '保存为专题'}</button><button type="button" className="ha-primary-button" onClick={onDone}>{editingTopic ? '返回专题' : '完成'}</button></div></>}
      {page === 'topic' && <div><button type="button" className="ha-secondary-button" onClick={() => setPage('overview')}>取消</button><button type="submit" form={formId} className="ha-primary-button" disabled={disabled || !canSave || !name.trim()}>{missing ? '保存可用资料' : editingTopic ? '确认更新' : '保存专题'}</button></div>}
      {(page === 'pages' || page === 'data' || page === 'images') && <><p><strong>已选 {selectionDraft.pages.length} 页{attachmentCount ? '、' + attachmentCount + ' 个附件' : ''}</strong><span>完成后附带到输入框，不会发送。</span></p><div><button type="button" className="ha-secondary-button" onClick={() => setPage('overview')}>取消</button><button type="button" className="ha-primary-button" disabled={disabled} onClick={applySelection}>完成选择</button></div></>}
    </div>;
  return <AssistantOverlay title={title} className="ha-composer-menu ha-material-menu" bodyClassName="ha-scope-body" bodyRef={body} onClose={onDone} onBack={page !== 'overview' ? goBack : undefined} backLabel={page === 'data' || page === 'images' ? '返回材料列表' : '返回资料范围'} toolbar={toolbar} footer={footer} onEscape={() => page === 'overview' ? onDone() : goBack()}>

      {page === 'overview' && <>
        <div className="ha-scope-overview">
          <button type="button" data-scope-page="pages" onClick={beginSelection}><FileText size={16}/><strong>核心材料</strong><span>{selectedPages.length ? (topicScope ? '手选 ' : '已选 ') + selectedPages.length + ' 页' : '添加页面'}</span><ChevronRight size={14}/></button>
          <button type="button" data-scope-page="libraries" aria-expanded={expanded.libraries} aria-controls={instanceId + '-libraries'} onClick={()=>setExpanded(value=>({...value,libraries:!value.libraries}))}><Library size={16}/><strong>可检索的资料库</strong><span title={libraryNames.join('、')}>{libraryNames.length > 2 ? libraryNames.length + ' 个库' : libraryNames.join('、') || '未选择'}</span><ChevronDown className={expanded.libraries?'is-open':''} size={14}/></button>
          {expanded.libraries&&<div className="ha-scope-inline" id={instanceId + '-libraries'} role="region" aria-label="资料库选择">
        <p className="ha-scope-hint">只在所选库中按问题查找相关内容。</p>
        {libraries.length > 0 && <label className="ha-resource-choice"><Library size={16}/><span>全部资料库</span><input data-scope-focus type="checkbox" aria-label="选择全部资料库" disabled={disabled} checked={allLibraries} onChange={event => onChange({ ...resources, libraryIds: event.target.checked ? libraries.map(([id]) => id) : [] })}/></label>}
        {!libraries.length && !resources.libraryIds.length && <p className="ha-scope-hint">当前没有可检索的资料库。</p>}
        {[...libraries, ...resources.libraryIds.filter(id => !libraries.some(([key]) => key === id)).map(id => [id, '不可用资料库'] as const)].map(([id, label]) => <label className="ha-resource-choice" key={id}><Library size={16}/><span>{label}{topicScope?.libraryIds.includes(id) && <small>专题已包含</small>}</span><input type="checkbox" aria-label={'允许查找 ' + label} disabled={disabled} checked={resources.libraryIds.includes(id)} onChange={event => onChange({ ...resources, libraryIds: event.target.checked ? [...resources.libraryIds, id] : resources.libraryIds.filter(value => value !== id) })}/></label>)}
      </div>}
          {canChoosePolicy && <button type="button" data-scope-page="policy" aria-expanded={expanded.policy} aria-controls={instanceId + '-policy'} onClick={() => setExpanded(value => ({ ...value, policy: !value.policy }))}><SlidersHorizontal size={16}/><strong>怎样使用资料</strong><span>{policyName}</span><ChevronDown className={expanded.policy ? 'is-open' : ''} size={14}/></button>}
          {canChoosePolicy && expanded.policy && <fieldset className="ha-scope-inline ha-scope-policies" id={instanceId + '-policy'}>
            <legend className="ha-sr-only">怎样使用资料</legend>
            {researchPolicies.filter(item => item.id !== 'open' || policy === 'open').map(item => <label className="ha-resource-choice" key={item.id}><input type="radio" name={instanceId + '-policy'} value={item.id} disabled={disabled} checked={policy === item.id} onChange={() => onPolicy(item.id)}/><span><strong>{item.name}</strong><small>{item.hint}</small></span></label>)}
          </fieldset>}
        </div>
        {needsMaterial && <div className="ha-scope-recovery" role="status"><p>当前只用所选资料。请添加资料，或切换为普通提问。</p><button type="button" className="ha-secondary-button" disabled={disabled} onClick={() => onPolicy('material-first')}>切换为普通提问</button></div>}
        {manualOnce && <label className="ha-resource-choice"><input type="checkbox" checked={manualOnce.checked} disabled={disabled || (!manualOnce.count && !manualOnce.checked)} onChange={event => manualOnce.onChange(event.target.checked)}/><span><strong>下一条消息也使用手选资料</strong><small>{manualOnce.count ? '仅对下一条消息生效。会在专题范围外加入手选的页面、库或附件。' : '可先选页面、资料库或添加附件。'}</small></span></label>}
        {editingTopic && <p className="ha-scope-hint">正在调整「{editingTopic.name}」。更新会保存到专题，当前对话不受影响。</p>}
        {policy === 'materials-only' && resources.url && <p className="ha-scope-hint">{webStatus}</p>}
      </>}
      {page === 'pages' && <>
        {showCurrent && current && <section className="ha-material-group" aria-label="当前页面"><h4>当前页面</h4>{pageRow(current)}</section>}
        <section className="ha-material-group" aria-label={keyword ? '搜索结果' : filter === 'selected' ? '已选页面' : '页面列表'}><h4>{keyword ? '搜索结果' : filter === 'selected' ? '已选页面' : '页面列表'}<span>{listPages.length}</span></h4>
          {!pageResults.length && <div className="ha-picker-empty"><FileText size={22}/><strong>{keyword ? '没有找到匹配页面' : filter === 'selected' ? '还没有选择页面' : '没有其他页面'}</strong><p>{keyword ? '试试更短的标题、路径或资料库名称。' : '勾选需要的页面，完成后再随消息发送。'}</p></div>}
          {pageResults.map(pageRow)}
          {listPages.length > pageResults.length && <button type="button" className="ha-material-load-more" onClick={() => setPageLimit(pageResults.length + 12)}>查看更多页面（{pageResults.length} / {listPages.length}）</button>}
        </section>
        <section className="ha-material-attachments" aria-label="其他材料"><h4>其他材料</h4><button type="button" onClick={() => setPage('data')}><Sheet size={17}/><span>表格与数据文件</span><small>{selectionDraft.dataFiles?.length || 0}</small><ChevronRight size={15}/></button><button type="button" onClick={() => setPage('images')}><Image size={17}/><span>图片与 PDF 页面</span><small>{selectionDraft.images.length}</small><ChevronRight size={15}/></button></section>
      </>}
      {page === 'data' && <AssistantDataMaterials resources={selectionDraft} onChange={setSelectionDraft} disabled={disabled}/>}
      {page === 'images' && <AssistantVisualMaterials resources={selectionDraft} onChange={setSelectionDraft} disabled={disabled}/>}
      {page === 'topic' && <form id={formId} className="ha-scope-topic" onSubmit={event => {
        event.preventDefault();
        if (!disabled && canSave && name.trim() && onSave(name.trim(), includeSkills)) { setName(''); setIncludeSkills(false); setPage('overview'); }
      }}><label>专题名称<input data-scope-focus value={name} onChange={event => setName(event.target.value)} placeholder="例如：线束设计评审" maxLength={60}/></label>
        <p className="ha-scope-hint">资料策略：{policyName}</p>
        {review && <TopicSourceReview sources={review.sources}/>}
        {missing && <p className="ha-scope-hint" role="status">{canSave ? '不可用资料不会写入专题。确认后可只保存可用资料。' : '当前没有可用资料，请返回调整范围。'}</p>}
        {!!skillNames.length && <label className="ha-resource-choice"><input type="checkbox" checked={includeSkills} disabled={disabled} onChange={event => setIncludeSkills(event.target.checked)}/><span><strong>同时保存已选技能</strong><small>{skillNames.join('、')}</small></span></label>}
      </form>}
  </AssistantOverlay>;
}
