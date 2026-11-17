"use client";
import { useState } from 'react';
import type { ResourceDraft } from './AssistantResources';

export function AssistantVisualMaterials({resources,onChange,disabled}:{resources:ResourceDraft;onChange:(value:ResourceDraft)=>void;disabled:boolean}) {
  const [query,setQuery]=useState('');
  const [page,setPage]=useState(1);
  const names=[...resources.pages.slice(0,3).map(item=>`${item.title} · 图片 1`),'示例资料.pdf · 第 '+page+' 页'];
  const candidates=names.filter(name=>name.toLowerCase().includes(query.trim().toLowerCase()));
  return <section aria-label="图片与 PDF 页面">
    <h4>图片与 PDF 页面</h4>
    <p className="ha-scope-hint">演示：按所属笔记查找图片，或选择 PDF 页码。加入并发送后才授权模型读取；预览过不等于已经读图。</p>
    <label className="ha-resource-search">按笔记或附件标题查找<input type="search" value={query} onChange={e=>setQuery(e.target.value)} maxLength={200}/></label>
    <label className="ha-resource-search">PDF 页码<input aria-label="PDF 页码" type="number" min={1} max={131} value={page} onChange={e=>setPage(Math.max(1,Math.min(131,Number(e.target.value)||1)))}/></label>
    {candidates.map(name=><label className="ha-resource-choice" key={name}><input type="checkbox" disabled={disabled||(!resources.images.includes(name)&&resources.images.length>=8)} checked={resources.images.includes(name)} onChange={e=>onChange({...resources,images:e.target.checked?[...resources.images,name]:resources.images.filter(item=>item!==name)})}/><span><strong>{name}</strong><small>未发送 · 可随下一条消息读取</small></span></label>)}
    {!candidates.length&&<p className="ha-scope-hint">没有匹配的图片或附件。</p>}
    <p className="ha-scope-hint">已选 {resources.images.length} / 8 项。实际读取范围与失败原因会留在工作过程里；这里使用演示材料。</p>
  </section>;
}
