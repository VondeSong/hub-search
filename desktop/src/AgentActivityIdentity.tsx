import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {AppWindow,BookOpen,Circle,Download,FilePenLine,FileSearch,FileText,Globe2,MessagesSquare,Network,Search,Shrink,SquareTerminal,TriangleAlert,Wrench} from "lucide-react";
import {publicWebHref} from "./AgentWebSources";
import type {ActivityEvent} from "./AgentActivity";
import github from "./assets/agent-services/github.svg";
import notion from "./assets/agent-services/notion.svg";

export type ActivityOperation="search"|"read"|"command"|"compute"|"edit"|"readChat"|"renameChat"|"skill"|"context"|"delegate"|"mcp"|"browser"|"download"|"webSearch"|"webOpen"|"webFind"|"webUnknown"|"tool";
/** The same resolver feeds rows and collapsed groups. Labels are legacy only. */
export function activityOperation(event:ActivityEvent):ActivityOperation {
  const operation=event.operation;
  if (event.kind === "webSearch") {
    if (event.action === "search") return "webSearch";
    if (event.action === "openPage") return "webOpen";
    if (event.action === "findInPage") return "webFind";
    if (!event.action) {
      if (/^(Codex\s+)?搜索网页/.test(event.label)) return "webSearch";
      if (/^(Codex\s+)?(访问|打开)网页/.test(event.label)) return "webOpen";
      if (/^(Codex\s+)?(在网页内|页内)查找/.test(event.label)) return "webFind";
    }
    return "webUnknown";
  }
  if (operation === "search") return "search";
  if(event.kind==="skill" || operation==="loadSkill" || operation==="readSkillReference")return "skill";
  if(operation==="fetchFile")return "download";
  if(operation==="compute"||operation==="analyzeFiles")return "compute";
  if(operation==="command")return "command";
  if(operation==="delegate")return "delegate";
  if(operation==="edit")return "edit";
  if(operation==="readChat" || operation==="renameChat")return operation;
  if(operation==="mcp")return event.serviceId?.startsWith("browser:")?"browser":"mcp";
  if(operation==="read" || operation==="traceResult" || operation==="toolSchema")return "read";
  if(event.kind==="context")return event.origin==="publicLifecycle"?"context":"read";
  if(operation)return "tool";
  if(/搜索|检索|查找/.test(event.label))return "search";
  if(/命令|运行|执行/.test(event.label))return "command";
  if(/编辑|修改|创建文件/.test(event.label))return "edit";
  if(/读取|原文|材料/.test(event.label))return "read";
  return "tool";
}
export const operationLabels:Record<ActivityOperation,string>={search:"搜索资料",read:"读取资料",command:"运行命令",compute:"运行计算脚本",edit:"编辑文件",readChat:"读取聊天",renameChat:"重命名聊天",skill:"使用技能",context:"整理上下文",delegate:"协调子代理",mcp:"使用外部工具",browser:"操作浏览器",download:"获取资料文件",webSearch:"搜索网页",webOpen:"打开网页",webFind:"在网页内查找",webUnknown:"处理网页",tool:"调用工具"};
export function activityLabel(event:ActivityEvent) {
  if (event.kind==="tool" && event.operation==="analyzeFiles" && event.label==="分析数据并生成文件") return "分析附件";
  return event.kind==="tool" && event.operation==="compute" ? operationLabels.compute : event.label;
}
export function ActivityIcon({event}:{event:ActivityEvent}) {
  if(event.kind==="reasoning"||event.kind==="status")return null;
  const operation = activityOperation(event);
  const brand = operation === "mcp" && event.serviceId ? brands[event.serviceId] : undefined;
  if (brand && event.state !== "failed" && event.state !== "interrupted" && !event.errorCount) {
    return <span className="agent-service-icon" aria-hidden="true" data-activity-icon={operation} data-activity-brand={brand.title}>
      <img src={brand.src} alt="" width={16} height={16}/>
    </span>;
  }
  const icons={search:Search,read:FileText,command:SquareTerminal,compute:SquareTerminal,edit:FilePenLine,readChat:MessagesSquare,renameChat:FilePenLine,skill:BookOpen,context:Shrink,delegate:Network,mcp:Globe2,browser:AppWindow,download:Download,webSearch:Search,webOpen:Globe2,webFind:FileSearch,webUnknown:Globe2,tool:Wrench};
  const Icon=event.state==="failed"||event.errorCount?TriangleAlert:event.state==="interrupted"?Circle:icons[operation];
  return <Icon size={16} aria-hidden="true" data-activity-icon={event.state==="failed"?"failed":operation}/>;
}
export function activitySites(events:ActivityEvent[]) {
  const sites=new Map<string,{url:string;title:string}>();
  for(const event of events)for(const source of [...(event.url?[{url:event.url,title:""}]:[]),...(event.sourceRefs??[])]) {
    const url=publicWebHref(source.url);if(!url)continue;
    const domain=new URL(url).hostname;
    if(!sites.has(domain))sites.set(domain,{url,title:source.title||domain});
  }
  const groups = new Map<string, { url: string; title: string; hosts: string[] }>();
  for (const [host, site] of sites) {
    const local = host.match(/^(?:en|fr|de|es|it|ja|ko|pt|ru|zh)(?:-[a-z]{2})?\.(.+)$/);
    // A language variant shares an icon only when its main host is also in the results.
    const parent = local?.[1];
    const key = parent && (sites.has(parent) || sites.has(`www.${parent}`)) ? parent : host.replace(/^www\./, "");
    let group = groups.get(key);
    if (!group) {
      const main = sites.get(key) ?? sites.get(`www.${key}`) ?? site;
      group = { ...main, hosts: [] };
      groups.set(key, group);
    }
    group.hosts.push(host);
  }
  return [...groups.values()];
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
export function WebsiteIcon({url,title,hosts,workId}:{url:string;title:string;hosts:string[];workId?:string}) {
  const [src,setSrc]=useState<string|null>(null);
  useEffect(()=>{
    let active=true;setSrc(null);
    if(workId)void cachedIcon(workId,url,document.documentElement.dataset.theme==="dark").then(value=>{if(active)setSrc(value);});
    return ()=>{active=false;};
  },[workId,url]);
  return <span className="agent-site-icon" title={hosts.length > 1 ? hosts.join("、") : title} aria-label={hosts.join("、")}>{src?<img src={src} alt="" width={16} height={16} onError={()=>setSrc(null)}/>:<Globe2 size={16} aria-hidden="true"/>}</span>;
}
const brands:Record<string,{src:string;title:string}>={github:{src:github,title:"GitHub"},"app:connector_76869538009648d5b282a4bb21c3d157":{src:github,title:"GitHub"},notion:{src:notion,title:"Notion"}};
export function activityServiceTitle(server:string,events:ActivityEvent[]) {
  return brands[server]?.title ?? events.find(event=>event.serviceId===server && event.serviceTitle)?.serviceTitle;
}
export function ActivityIdentity({events,workId,primaryIcon,showRemainingSites=true}:{events:ActivityEvent[];workId?:string;primaryIcon?:ActivityEvent;showRemainingSites?:boolean}) {
  const sites=activitySites(events);
  const services=[...new Set(events.map(e=>e.serviceId).filter((s):s is string=>!!s))];
  const agents=[...new Set(events.flatMap(e=>e.agentIds??[]))];
  const primaryBrand = primaryIcon && activityOperation(primaryIcon) === "mcp" && !primaryIcon.errorCount
    && !["failed", "interrupted"].includes(primaryIcon.state) ? brands[primaryIcon.serviceId ?? ""] : undefined;
  const identities=services.flatMap(id=>brands[id] && brands[id].src !== primaryBrand?.src ? [{id,...brands[id]}] : []);
  if(!sites.length&&!agents.length&&!identities.length)return null;
  return <span className="agent-activity-identities" aria-label="活动来源">
    {identities.slice(0,3).map(service=><span key={service.id} className="agent-service-icon" title={service.title}><img src={service.src} alt={service.title} width={16} height={16}/></span>)}
    {sites.slice(0,3).map(site=><WebsiteIcon key={new URL(site.url).hostname} {...site} workId={workId}/>)}
    {showRemainingSites && sites.length > 3 && <small title={sites.slice(3).flatMap(site => site.hosts).join("、")}>另 {sites.length - 3} 个站点</small>}
    {agents.slice(0,3).map(id=>{
      const hash=Array.from(id).reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,0);
      return <svg key={id} width="16" height="16" viewBox="0 0 16 16" role="img" aria-label={`子代理 ${id.slice(-6)}`} className="agent-avatar" style={{color:`hsl(${[205,160,330,270,35][hash%5]} 64% 58%)`}}><title>{id}</title>{Array.from({length:6},(_,i)=><path key={i} d="M8 8 6 1h4Z" fill="currentColor" opacity={i%2?0.6:1} transform={`rotate(${i*60+(hash%2?30:0)} 8 8)`}/>)}</svg>;
    })}
    {agents.length>3&&<small>+{agents.length-3}</small>}
  </span>;
}
