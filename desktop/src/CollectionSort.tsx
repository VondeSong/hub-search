import { ArrowUpDown, GripVertical, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "./CollectionSort.css";

export const collectionSortFields = {title:"内容",status:"状态",tags:"标签",source:"来源",author:"作者",published:"发布时间",collected:"收藏时间",media:"附件",liked:"喜欢",destination:"保存到"};
export type CollectionSortField = keyof typeof collectionSortFields;
export type CollectionSortRule = {id:string;field:CollectionSortField;ascending:boolean};
export const defaultCollectionSorts:CollectionSortRule[] = [{id:"default-sort",field:"collected",ascending:false}];
export function normalizeCollectionSorts(value:unknown,field:CollectionSortField="collected",ascending=false):CollectionSortRule[] {
  if (!Array.isArray(value)) return [{id:"legacy-sort",field,ascending}];
  const seen=new Set<string>(),ids=new Set<string>();
  return value.filter(rule=>rule&&typeof rule.field==="string"&&Object.prototype.hasOwnProperty.call(collectionSortFields,rule.field)&&!seen.has(rule.field)&&seen.add(rule.field)).slice(0,10).map((rule,index)=>{
    let id=typeof rule.id==="string"&&rule.id?rule.id:`sort-${index}-${rule.field}`;
    if(ids.has(id))id=`sort-${index}-${rule.field}`;ids.add(id);
    return {id,field:rule.field,ascending:rule.ascending===true};
  });
}
export function CollectionSort({rules,onChange}:{rules:CollectionSortRule[];onChange:(rules:CollectionSortRule[])=>void}) {
  const [open,setOpen]=useState(false);
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if(!open)return;
    const closeOutside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener("pointerdown",closeOutside);return()=>document.removeEventListener("pointerdown",closeOutside);
  },[open]);
  const close=()=>{setOpen(false);trigger.current?.focus();};
  const update=(id:string,patch:Partial<CollectionSortRule>)=>onChange(rules.map(rule=>rule.id===id?{...rule,...patch}:rule));
  const move=(from:number,to:number)=>{if(to<0||to>=rules.length||from===to)return;const next=[...rules];next.splice(to,0,next.splice(from,1)[0]);onChange(next);};
  const add=()=>{const field=(Object.keys(collectionSortFields) as CollectionSortField[]).find(field=>!rules.some(rule=>rule.field===field));if(field)onChange([...rules,{id:crypto.randomUUID(),field,ascending:true}]);};
  return <div ref={root} className="task-tool-popover-wrap collection-sort-wrap" onKeyDown={event=>{if(open&&event.key==="Escape"){event.preventDefault();event.stopPropagation();close();}}}>
    <button ref={trigger} aria-label="排序" title="排序" aria-haspopup="dialog" aria-expanded={open} className={open||rules.length?"active":""} onClick={()=>setOpen(!open)}><ArrowUpDown size={18}/></button>
    {open&&<section className="collection-sort-popover" role="dialog" aria-label="排序设置">
      <header><strong>排序</strong><button aria-label="关闭排序" onClick={close}><X size={15}/></button></header>
      <div className="collection-sort-rules">{rules.map((rule,index)=><div className="collection-sort-rule" key={rule.id} onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();const from=rules.findIndex(rule=>rule.id===event.dataTransfer.getData("application/hub-collection-sort"));if(from>=0)move(from,index);}}>
        <button draggable className="collection-sort-drag" aria-label={`调整第 ${index+1} 条排序优先级`} title="拖动调整优先级，或按上下键" onDragStart={event=>{event.dataTransfer.effectAllowed="move";event.dataTransfer.setData("application/hub-collection-sort",rule.id);}} onKeyDown={event=>{if(event.key==="ArrowUp"||event.key==="ArrowDown"){event.preventDefault();move(index,index+(event.key==="ArrowUp"?-1:1));}}}><GripVertical size={14}/></button>
        <select autoFocus={index===0} aria-label={index===0?"排序方式":`第 ${index+1} 条排序属性`} value={rule.field} onChange={event=>update(rule.id,{field:event.target.value as CollectionSortField})}>{Object.entries(collectionSortFields).map(([field,label])=><option key={field} value={field} disabled={rules.some(other=>other.id!==rule.id&&other.field===field)}>{label}</option>)}</select>
        <select aria-label={index===0?"排序方向":`第 ${index+1} 条排序方向`} value={rule.ascending?"asc":"desc"} onChange={event=>update(rule.id,{ascending:event.target.value==="asc"})}><option value="asc">升序</option><option value="desc">降序</option></select>
        <button aria-label={`删除第 ${index+1} 条排序`} onClick={()=>onChange(rules.filter(other=>other.id!==rule.id))}><X size={14}/></button>
      </div>)}</div>
      {!rules.length&&<p className="collection-sort-empty">未添加排序条件</p>}
      <button className="collection-sort-add" disabled={rules.length>=10} onClick={add}><Plus size={14}/>添加排序</button>
      <footer><small>按从上到下的条件排序</small><button onClick={()=>onChange(defaultCollectionSorts.map(rule=>({...rule})))}>重置排序</button></footer>
    </section>}
  </div>;
}
