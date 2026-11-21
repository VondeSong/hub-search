import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {AppWindow,BookOpen,Circle,Download,FilePenLine,FileSearch,Globe2,Images,MessagesSquare,Network,Search,Shrink,SquareTerminal,TriangleAlert,Wrench,type LucideProps} from "lucide-react";
import {publicWebHref} from "./AgentWebSources";
import type {ActivityEvent} from "./AgentActivity";
import github from "./assets/agent-services/github.svg";
import notion from "./assets/agent-services/notion.svg";

export type ActivityOperation="search"|"read"|"command"|"compute"|"edit"|"imageInput"|"viewImage"|"readChat"|"renameChat"|"skill"|"context"|"delegate"|"mcp"|"browser"|"download"|"webSearch"|"webOpen"|"webFind"|"webUnknown"|"tool";
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
  if(operation==="imageInput" || operation==="viewImage")return operation;
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
export const operationLabels:Record<ActivityOperation,string>={search:"搜索资料",read:"读取资料",command:"运行命令",compute:"运行计算脚本",edit:"编辑文件",imageInput:"原图资料",viewImage:"查看图像",readChat:"读取聊天",renameChat:"重命名聊天",skill:"使用技能",context:"整理上下文",delegate:"协调子代理",mcp:"使用外部工具",browser:"操作浏览器",download:"获取资料文件",webSearch:"搜索网页",webOpen:"打开网页",webFind:"在网页内查找",webUnknown:"处理网页",tool:"调用工具"};
export function activityLabel(event:ActivityEvent) {
  if (event.kind==="tool" && event.operation==="analyzeFiles" && event.label==="分析数据并生成文件") return "分析附件";
  return event.kind==="tool" && event.operation==="compute" ? operationLabels.compute : event.label;
}
function ReadMaterialIcon({size=16,...props}:LucideProps) {
  return <svg width={size} height={size} viewBox="2 2 20 20" fill="currentColor" {...props}>
    <path d="M9.17 8.508h5.67a.51.51 0 0 0 .376-.152.504.504 0 0 0 .151-.37c0-.14-.05-.258-.151-.356a.518.518 0 0 0-.376-.147H9.17a.53.53 0 0 0-.386.147.478.478 0 0 0-.151.356.521.521 0 0 0 .537.522Zm0 2.59h5.67a.516.516 0 0 0 .527-.531c0-.14-.05-.258-.151-.356a.518.518 0 0 0-.376-.147H9.17a.53.53 0 0 0-.386.147.478.478 0 0 0-.151.356.516.516 0 0 0 .537.531Zm0 2.582h2.654c.15 0 .275-.05.376-.147a.478.478 0 0 0 .151-.356.505.505 0 0 0-.15-.37.51.51 0 0 0-.377-.152H9.17a.521.521 0 0 0-.537.522c0 .139.05.258.151.356.101.098.23.147.386.147Zm-3.67 3.9c0 .81.203 1.416.61 1.817.407.402 1.02.603 1.84.603h8.09c.82 0 1.435-.2 1.845-.603.41-.401.615-1.007.615-1.817V6.42c0-.804-.205-1.408-.615-1.813C17.475 4.202 16.86 4 16.04 4H7.95c-.82 0-1.433.202-1.84.607-.407.405-.61 1.01-.61 1.813v11.16Zm1.405-.019V6.44c0-.342.095-.606.283-.793.19-.186.469-.28.84-.28h7.944c.365 0 .641.094.83.28.189.187.283.451.283.793V17.56c0 .342-.095.606-.283.793-.189.186-.465.28-.83.28H8.028c-.371 0-.65-.094-.84-.28-.188-.187-.283-.451-.283-.793Z"/>
  </svg>;
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
  const icons={search:Search,read:ReadMaterialIcon,command:SquareTerminal,compute:SquareTerminal,edit:FilePenLine,imageInput:Images,viewImage:Images,readChat:MessagesSquare,renameChat:FilePenLine,skill:BookOpen,context:Shrink,delegate:Network,mcp:Globe2,browser:AppWindow,download:Download,webSearch:Search,webOpen:Globe2,webFind:FileSearch,webUnknown:Globe2,tool:Wrench};
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
