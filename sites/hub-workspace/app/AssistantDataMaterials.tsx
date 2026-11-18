"use client";
import {useState} from 'react';
import type {ResourceDraft} from './AssistantResources';
import {AssistantCloudHandoff} from './AssistantCloudHandoff';

export function AssistantDataMaterials({resources,onChange,disabled}:{resources:ResourceDraft;onChange:(value:ResourceDraft)=>void;disabled:boolean}){
 const [query,setQuery]=useState('');
 const selected=resources.dataFiles||[];
 const names=['线束力矩清单.xlsx','连接器核对.csv','材料记录.json'].filter(name=>name.includes(query.trim()));
 return <section aria-label="表格与数据文件"><h4>表格与数据文件</h4><p className="ha-scope-hint">演示：选择资料库附件，发送后可按实际内容计算。原件保留；公式不自动重算。也可以从添加附件选择本地文件。</p><label className="ha-resource-search">按笔记或文件标题查找<input type="search" value={query} maxLength={200} onChange={e=>setQuery(e.target.value)}/></label>{names.map(name=><label key={name} className="ha-resource-choice"><input type="checkbox" checked={selected.includes(name)} disabled={disabled||(!selected.includes(name)&&selected.length>=8)} onChange={e=>onChange({...resources,dataFiles:e.target.checked?[...selected,name]:selected.filter(item=>item!==name)})}/><span><strong>{name}</strong><small>演示附件 · 尚未发送</small></span></label>)}<p className="ha-scope-hint">已选 {selected.length} / 8 个文件。每文件最多 10 MiB；首次分析需要准备固定环境。</p></section>;
}

export function AssistantFileDelivery(){
 const [version,setVersion]=useState(1),[show,setShow]=useState(false);
 return <section aria-label="分析文件交付演示"><button type="button" className="ha-secondary-button" onClick={()=>setShow(!show)}>{show?'收起文件示例':'查看分析文件交付示例'}</button>{show&&<><p className="ha-scope-hint">交互演示，不是实际计算结果。正式客户端会先核对来源与文件，再打开或保存。</p><details open><summary>材料汇总 · 第 {version} 版 · 4 个文件</summary><p>汇总.csv · 核对.xlsx · 分类图.png · 报告.pdf</p><p className="ha-scope-hint">文件保存在本次工作中；保存到知识库、发送给别人分别确认并记录结果。</p></details>{version>1&&<details><summary>第 1 版 · 已被修订</summary><p>保留历史文件，后续回答使用第 {version} 版；原资料撤销后，文件入口也会失效。</p></details>}<button type="button" className="ha-secondary-button" onClick={()=>setVersion(v=>v+1)}>模拟调整统计口径</button><AssistantCloudHandoff/></>}</section>;
}
