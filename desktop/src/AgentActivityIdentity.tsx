import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {BookOpen,Circle,FileText,Globe2,Network,Pencil,Search,Shrink,Terminal,TriangleAlert,Wrench} from "lucide-react";
import {publicWebHref} from "./AgentWebSources";
import type {ActivityEvent} from "./AgentActivity";
import github from "./assets/agent-services/github.svg";
import notion from "./assets/agent-services/notion.svg";

export type ActivityOperation="search"|"read"|"command"|"edit"|"skill"|"context"|"delegate"|"mcp"|"tool";
/** The same resolver feeds rows and collapsed groups. Labels are legacy only. */
export function activityOperation(event:ActivityEvent):ActivityOperation {
  const operation=event.operation;
  if(event.kind==="webSearch" || operation==="search")return "search";
  if(event.kind==="skill" || operation==="loadSkill" || operation==="readSkillReference")return "skill";
  if(operation==="command" || operation==="compute")return "command";
  if(operation==="delegate")return "delegate";
  if(operation==="edit")return "edit";
  if(operation==="mcp")return "mcp";
  if(operation==="read" || operation==="traceResult" || operation==="toolSchema")return "read";
  if(event.kind==="context")return event.origin==="publicLifecycle"?"context":"read";
  if(operation)return "tool";
  if(/搜索|检索|查找/.test(event.label))return "search";
  if(/命令|运行|执行/.test(event.label))return "command";
  if(/编辑|修改|创建文件/.test(event.label))return "edit";
  if(/读取|原文|材料/.test(event.label))return "read";
  return "tool";
}
export const operationLabels:Record<ActivityOperation,string>={search:"搜索资料",read:"读取资料",command:"运行命令",edit:"编辑文件",skill:"使用技能",context:"整理上下文",delegate:"协调子代理",mcp:"查询外部工具",tool:"调用工具"};
export function ActivityIcon({event}:{event:ActivityEvent}) {
  if(event.kind==="reasoning"||event.kind==="status")return null;
  const icons={search:Search,read:FileText,command:Terminal,edit:Pencil,skill:BookOpen,context:Shrink,delegate:Network,mcp:Globe2,tool:Wrench};
  const Icon=event.state==="failed"||event.errorCount?TriangleAlert:event.state==="interrupted"?Circle:icons[activityOperation(event)];
  return <Icon size={16} aria-hidden="true" data-activity-icon={event.state==="failed"?"failed":activityOperation(event)}/>;
}
export function activitySites(events:ActivityEvent[]) {
  const sites=new Map<string,{url:string;title:string}>();
  for(const event of events)for(const source of [...(event.url?[{url:event.url,title:""}]:[]),...(event.sourceRefs??[])]) {
    const url=publicWebHref(source.url);if(!url)continue;
    const domain=new URL(url).hostname;
    if(!sites.has(domain))sites.set(domain,{url,title:source.title||domain});
  }
  return [...sites.values()];
}
const iconCache=new Map<string,{expires:number;value:Promise<string|null>}>();
function cachedIcon(workId:string,url:string,dark:boolean) {
  const key=`${workId}:${new URL(url).hostname}:${dark}`;
  const old=iconCache.get(key);if(old&&old.expires>Date.now())return old.value;
  if(iconCache.size>=256)iconCache.delete(iconCache.keys().next().value!);
  const value=invoke<{dataUrl?:string}>("agent_investigation",{args:{action:"websiteIcon",id:workId,url,theme:dark?"dark":"light"}})
    .then(result=>/^data:image\/(png|x-icon);base64,[A-Za-z0-9+/=]+$/.test(result?.dataUrl??"")?result.dataUrl!:null).catch(()=>null);
  iconCache.set(key,{expires:Date.now()+600_000,value});return value;
}
function WebsiteIcon({url,title,workId}:{url:string;title:string;workId?:string}) {
  const [src,setSrc]=useState<string|null>(null);
  useEffect(()=>{
    let active=true;setSrc(null);
    if(workId)void cachedIcon(workId,url,document.documentElement.dataset.theme==="dark").then(value=>{if(active)setSrc(value);});
    return ()=>{active=false;};
  },[workId,url]);
  return <span className="agent-site-icon" title={title} aria-label={new URL(url).hostname}>{src?<img src={src} alt="" width={16} height={16} onError={()=>setSrc(null)}/>:<Globe2 size={16} aria-hidden="true"/>}</span>;
}
const brands:Record<string,{src:string;title:string}>={github:{src:github,title:"GitHub"},notion:{src:notion,title:"Notion"}};
export function ActivityIdentity({events,workId}:{events:ActivityEvent[];workId?:string}) {
  const sites=activitySites(events);
  const services=[...new Set(events.map(e=>e.serviceId).filter((s):s is string=>!!s))];
  const agents=[...new Set(events.flatMap(e=>e.agentIds??[]))];
  const identities=[...services.flatMap(id=>brands[id]?[{id,...brands[id]}]:[])];
  if(!sites.length&&!agents.length&&!identities.length)return null;
  return <span className="agent-activity-identities" aria-label="活动来源">
    {identities.slice(0,3).map(service=><span key={service.id} className="agent-service-icon" title={service.title}><img src={service.src} alt={service.title} width={16} height={16}/></span>)}
    {sites.slice(0,3).map(site=><WebsiteIcon key={new URL(site.url).hostname} {...site} workId={workId}/>)}
    {sites.length>3&&<small title={sites.map(s=>new URL(s.url).hostname).join("、")}>+{sites.length-3}</small>}
    {agents.slice(0,3).map(id=>{
      const hash=Array.from(id).reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,0);
      return <svg key={id} width="16" height="16" viewBox="0 0 16 16" role="img" aria-label={`子代理 ${id.slice(-6)}`} className="agent-avatar" style={{color:`hsl(${[205,160,330,270,35][hash%5]} 64% 58%)`}}><title>{id}</title>{Array.from({length:6},(_,i)=><path key={i} d="M8 8 6 1h4Z" fill="currentColor" opacity={i%2?0.6:1} transform={`rotate(${i*60+(hash%2?30:0)} 8 8)`}/>)}</svg>;
    })}
    {agents.length>3&&<small>+{agents.length-3}</small>}
  </span>;
}
