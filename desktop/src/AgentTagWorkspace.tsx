import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, X } from "lucide-react";
import { TagAssignmentInbox } from "./TagAssignmentInbox";
import { CodexTagGovernance } from "./CodexTagGovernance";
import { TagGovernanceInbox } from "./TagGovernanceInbox";

type Tag = { name: string; normalizedName: string; count: number };
export function AgentTagWorkspace() {
  const [task,setTask]=useState("起草定义"),[tags,setTags]=useState<Tag[]>([]),[tag,setTag]=useState<Tag|null>(null),[query,setQuery]=useState(""),[error,setError]=useState("");
  const [searching,setSearching]=useState(false),[opened,setOpened]=useState(false),[revision,setRevision]=useState(0);
  useEffect(()=>{let alive=true;void invoke<Tag[]>("list_tags",{spaceIds:[],limit:500}).then(value=>{if(alive&&Array.isArray(value))setTags(value);},reason=>{if(alive)setError(String(reason));});return()=>{alive=false;};},[]);
  return <section className="agent-tag-workspace" aria-label="标签助手">
    <nav aria-label="标签任务">{["起草定义","查找漏标","比较关系"].map(name=><button type="button" key={name} aria-pressed={task===name} onClick={()=>{setTask(name);setOpened(false);}}>{name}</button>)}</nav>
    <h2>{task==="起草定义"?"起草标签定义":task==="查找漏标"?"查找可能漏标":"比较标签关系"}</h2>
    <p className="agent-note">{task==="比较关系"?"核对当前标签的相关候选，逐项审核关系建议。":"按已确认的资料范围取证，保存或补标前由你确认。"}</p>
    <button type="button" className="agent-tag-chip" aria-expanded={searching} onClick={()=>setSearching(!searching)}>#{tag?.name||"选择标签"}</button>
    {tag&&<button type="button" className="agent-tag-remove" aria-label="移除目标标签" onClick={()=>{setTag(null);setOpened(false);}}><X size={13}/></button>}
    {searching&&<div className="agent-tag-picker"><label><Search size={16}/><input autoFocus aria-label="搜索标签" placeholder="搜索标签" value={query} onChange={e=>setQuery(e.target.value)}/></label><div>{tags.filter(item=>item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0,100).map(item=><button type="button" key={item.normalizedName} onClick={()=>{setTag(item);setSearching(false);setOpened(false);}}>#{item.name}<small>{item.count}</small></button>)}</div>{!tags.length&&<p>暂无可用标签</p>}</div>}
    {error&&<p role="alert">{error}</p>}
    {tag&&!opened&&<button type="button" className="agent-tag-open" onClick={()=>setOpened(true)}>{task==="起草定义"?"准备定义草稿":task==="查找漏标"?"核对定义与检查范围":"核对关系与审核范围"}</button>}
    {tag&&opened&&<div className="agent-tag-native" key={tag.normalizedName}>{task==="比较关系"?<><CodexTagGovernance tagId={tag.normalizedName} onCompleted={()=>setRevision(v=>v+1)}/><TagGovernanceInbox key={revision} tagId={tag.normalizedName}/></>:<TagAssignmentInbox tagId={tag.normalizedName}/>}</div>}
  </section>;
}
