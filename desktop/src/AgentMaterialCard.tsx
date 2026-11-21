import {BookOpen,File,FileText,Image,Layers,Globe2,MessageSquare,SquareCheck,Quote,WandSparkles,X} from "lucide-react";
import {useAgentPopover} from "./useAgentPopover";
export type MaterialKind="library"|"page"|"file"|"reading"|"task"|"flashcard"|"text"|"image"|"link"|"skill"|"conversation";
const icons={library:Layers,page:FileText,file:File,reading:BookOpen,task:SquareCheck,flashcard:Layers,text:Quote,image:Image,link:Globe2,skill:WandSparkles,conversation:MessageSquare};
const labels={library:"资料库范围",page:"页面",file:"本地附件",reading:"阅读条目",task:"任务",flashcard:"闪卡文字快照",text:"所选文字",image:"已授权原图",link:"公共网页",skill:"本条请求选择的技能",conversation:"旧对话摘录"};
export function AgentMaterialCard({kind,title,subtitle,identifier,onRemove,disabled=false,removeLabel,onOpen,openLabel,manage=false}:{kind:MaterialKind;title:string;subtitle?:string;identifier?:string;onRemove?:()=>void;disabled?:boolean;removeLabel?:string;onOpen?:()=>void;openLabel?:string;manage?:boolean}){
 const popover=useAgentPopover(),Icon=icons[kind];
 return <span className="agent-context agent-material-card agent-reference-token" data-material-kind={kind}>
  <details ref={popover.ref} className="agent-token-disclosure" onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();popover.close(true);}}}>
   <summary aria-label={`查看${kind==="skill"?"技能":"资料"}详情 ${title}`}><Icon size={15} strokeWidth={1.7} aria-hidden="true"/><span className="agent-token-title agent-material-title">{title}</span></summary>
   <section className="agent-token-detail" aria-label={`${title}详情`}><header><strong>{title}</strong><button type="button" aria-label="关闭详情" onClick={()=>popover.close(true)}><X size={14}/></button></header><p>{subtitle||labels[kind]}</p>{identifier&&<><small>技能标识：{identifier}</small><p>使用本条消息选择的资料；实际执行状态见助手进展。</p></>}{onOpen&&<button type="button" disabled={disabled} onClick={()=>{popover.close();onOpen();}}>{openLabel||"打开原页面"}</button>}</section>
  </details>
  {onRemove&&<button type="button" className="agent-token-remove" disabled={disabled} aria-label={removeLabel||`移除材料 ${title}`} title={manage?"管理原图授权":"移除待发送资料，不删除原文"} onClick={onRemove}><X size={12}/></button>}
 </span>;
}
