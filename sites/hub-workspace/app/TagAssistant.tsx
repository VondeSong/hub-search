"use client";

import { useState } from "react";
import { ArrowUpRight, Check, ChevronDown, Search, Tags, X } from "lucide-react";
import { sourceMeta } from "./data";
import { tagIntents, tagLibraryOptions, type TagReviewModel, type TagTask } from "./tag-assistant";
import "./tag-assistant.css";

type Suggestion = TagReviewModel["suggestions"][number];
export function TagReviewCard({item,model,onOpenQueue}: {item:Suggestion; model:TagReviewModel; onOpenQueue?:(id:string)=>void}) {
  const [draft,setDraft]=useState(item.kind==="definition"?item.rule:null);
  const [definitionLibraries,setDefinitionLibraries]=useState(item.libraries);
  const [expanded,setExpanded]=useState(false);
  const stale=model.stale(item);
  const pending=item.status==="pending";
  const source=item.kind==="missing"?model.records.find(record=>record.id===item.entityId):null;
  const accepted=item.status==="accepted";
  const comparison=item.kind==="relation"?model.records.filter(i=>!item.evidence||item.evidence.includes(i.id)):[];
  const left=item.kind==="relation"?comparison.filter(i=>i.tags.includes(item.tag)):[];
  const right=item.kind==="relation"?comparison.filter(i=>i.tags.includes(item.other)):[];
  const both=left.filter(i=>right.includes(i));
  const onlyLeft=left.filter(i=>!right.includes(i)),onlyRight=right.filter(i=>!left.includes(i));
  const evidence=(ids:string[])=>model.records.filter(i=>ids.includes(i.id));
  const label=item.kind==="definition"?"定义草稿":item.kind==="missing"?"补标建议":"关系建议";
  return <article className="tag-ai-card" aria-label={label+" #"+item.tag}>
    <header><span>{label} · #{item.tag}</span><small data-state={item.status}>{stale?"依据已更新":pending?"待处理":accepted?"已应用到 Hub":"已驳回"}</small></header>
    {item.kind==="definition"&&draft&&<>
      {pending ? <div className="tag-ai-fields">
        {([["description","标签定义"],["include","应该使用"],["exclude","不应使用"]] as const).map(([key,name])=><label key={key}>{name}<textarea rows={2} maxLength={1000} value={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.value})}/></label>)}
      </div>:<p>{item.rule.description}</p>}
      {pending&&<fieldset><legend>定义适用范围</legend>{tagLibraryOptions(model.records,item.libraries).map(([key,label])=><label className="tag-ai-check" key={key}><input type="checkbox" checked={definitionLibraries.includes(key)} onChange={e=>setDefinitionLibraries(e.target.checked?[...definitionLibraries,key]:definitionLibraries.filter(x=>x!==key))}/>{label}</label>)}</fieldset>}
      <p className="tag-ai-note">适用范围：{(pending?definitionLibraries:item.libraries).join("、")||"未选择"} · {item.version&&accepted?`版本 ${item.version}`:"确认后成为判断依据"}</p>
      {item.evidence.length>0&&<details><summary>查看参考样本 · {item.evidence.length}</summary>{evidence(item.evidence).map(i=><p key={i.id}>{i.space} · {i.title}<br/>{i.excerpt}</p>)}</details>}
    </>}
    {item.kind==="missing"&& (source?<><strong>{source.title}</strong><p className="tag-ai-note">{sourceMeta[source.source].name} / {source.space} · 定义 v{item.version}</p>
      <blockquote>{source.excerpt}</blockquote><p>这条预置候选涉及线束接口或装配验证。请对照当前定义核对；采纳后可用此标签在 Hub 中找到它。</p></>:<p>这条建议的来源暂不可用。</p>)}
    {item.kind==="relation"&&<>
      <p>{item.alias?`建议将「${item.other}」作为「${item.tag}」的 Hub 检索别名。`:`建议暂时保留「${item.tag}」与「${item.other}」各自独立。共现不足以证明同义。`}</p>
      <button className="tag-ai-button" type="button" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?"收起内容对比":"对比内容与影响"}</button>
      {expanded&&<div className="tag-ai-comparison">{([["共同内容",both],["仅 "+item.tag,onlyLeft],["仅 "+item.other,onlyRight]] as const).map(([name,entries])=><details key={name}><summary>{name} · {entries.length}</summary>{entries.slice(0,4).map(i=><p key={i.id}>{i.space} · {i.title}<br/>{i.excerpt}</p>)}</details>)}
        <p>{item.alias?`展开别名后的检索：${left.length} → ${left.length+onlyRight.length} 条带来源标签的内容。原标签保持不变。`:"确认后记录「保持独立」，两个标签的检索保持原样。"}</p></div>}
    </>}
    {stale&&<p className="tag-ai-note">定义版本已变化。请重新查找或起草后再审核。</p>}
    <footer>
      {pending?<><button className="tag-ai-button" type="button" disabled={!model.ready} onClick={()=>model.change(item,"rejected")}>{item.kind==="relation"&&item.alias?"保持独立":"驳回"}</button>
        <button className="tag-ai-button tag-ai-primary" type="button" disabled={!model.ready||stale||(item.kind==="missing"&&!source)||(item.kind==="relation"&&!expanded)||(item.kind==="definition"&&(!draft?.description.trim()||!draft.include.trim()||!definitionLibraries.length))} onClick={()=>model.change(item,"accepted",draft||undefined,definitionLibraries)}>{item.kind==="definition"?"确认并保存定义":item.kind==="missing"?"采纳到 Hub":item.alias?"设置检索别名":"确认保持独立"}</button></>:
        <button className="tag-ai-button" type="button" onClick={()=>model.change(item,"pending")}>{accepted?"撤销本次应用":"重新打开建议"}</button>}
      {onOpenQueue&&<button className="tag-ai-button" type="button" onClick={()=>onOpenQueue(item.id)}>在标签页查看<ArrowUpRight size={13}/></button>}
    </footer>
  </article>;
}

export function TagContext({tag,open,onOpen,onRemove}:{tag:string;open:boolean;onOpen:()=>void;onRemove:()=>void}) {
  return <span className="ha-tag-chip">
    <button type="button" className="ha-tag-trigger" aria-label={tag?'选择标签：#'+tag:'选择标签'} aria-expanded={open} onClick={onOpen}>
      <Tags size={15} aria-hidden="true"/><span>{tag?'#'+tag:'选择标签'}</span><ChevronDown size={12} aria-hidden="true"/>
    </button>
    {tag&&<button type="button" className="ha-chip-remove" aria-label={'移除标签 #'+tag} title="移除本轮标签" onClick={onRemove}><X size={12}/></button>}
  </span>;
}

export function TagPicker({tag,model,onPick,onClose,onDraft,selected,onRelated,single=false,title="选择标签"}:{tag:string;model:TagReviewModel;onPick:(tag:string)=>void;onClose:()=>void;onDraft:()=>void;selected:string[];onRelated:()=>void;single?:boolean;title?:string}) {
  const [query,setQuery]=useState('');
  const definition=tag?model.ruleFor(tag):null;
  const matches=model.tags.filter(value=>value.toLocaleLowerCase().includes(query.trim().replace(/^[#＃]/,'').toLocaleLowerCase()));
  return <section className="ha-menu ha-composer-menu ha-tag-picker" aria-label="标签选择">
    <header className="ha-menu-heading"><strong>{title}</strong><button type="button" className="ha-icon" aria-label="关闭标签选择" onClick={onClose}><X size={16}/></button></header>
    <label className="ha-tag-search"><Search size={15}/><input autoFocus aria-label="搜索标签" placeholder="搜索标签…" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing&&matches.length){event.preventDefault();onPick(matches[0]);}}}/></label>
    {tag&&<div className="ha-tag-definition">
      <details><summary><span>#{tag}</span><small>{definition?'定义 v'+definition.version:'尚无已确认定义'}</small></summary>
        {definition?<><p>{definition.rule.description}</p><dl><dt>纳入</dt><dd>{definition.rule.include}</dd>{definition.rule.exclude&&<><dt>排除</dt><dd>{definition.rule.exclude}</dd></>}<dt>适用范围</dt><dd>{definition.libraries.join('、')}</dd></dl></>:<p>可以先起草定义，确认后再用于查找漏标。</p>}
        <button type="button" className="ha-tag-definition-action" onClick={onDraft}>{definition?'起草修订定义':'起草标签定义'}</button>
      </details>
    </div>}
    <div className="ha-tag-options" role="group" aria-label="可选标签">
      {matches.map(value=><button type="button" className="ha-menu-choice" aria-pressed={selected.includes(value)} key={value} onClick={()=>onPick(value)}><Tags size={15}/><span>#{value}</span>{selected.includes(value)&&<Check size={15}/>}</button>)}
      {!matches.length&&<p role="status">没有找到匹配标签，试试其他关键词。</p>}
    </div>
    {!single&&<footer className="ha-tag-picker-footer"><button type="button" onClick={onRelated} disabled={!selected.length}>查找关联资料</button><button type="button" onClick={onClose}>完成 · {selected.length} 个标签</button></footer>}
  </section>;
}

export function TagTaskSelector({intent,onChange,onCancel}:{intent:TagTask['intent'];onChange:(intent:TagTask['intent'])=>void;onCancel:()=>void}) {
  return <nav className="ha-tag-task-switcher" aria-label="标签任务切换">
    <div className="ha-tag-task-choices" role="group" aria-label="选择标签任务">{tagIntents.map(([id,label],index)=><button type="button" key={id} aria-label={label} aria-pressed={id===intent} onClick={()=>onChange(id)}>{['起草定义','查找漏标','比较关系'][index]}</button>)}</div>
    <button type="button" className="ha-icon" aria-label="取消标签任务" title="返回标签助手" onClick={onCancel}><X size={14}/></button>
  </nav>;
}
