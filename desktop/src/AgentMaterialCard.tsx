import {BookOpen,FileText,Image,Layers,Globe2,SquareCheck,Quote,SlidersHorizontal,X} from "lucide-react";
export type MaterialKind="library"|"page"|"reading"|"task"|"flashcard"|"text"|"image"|"link";
const icons={library:Layers,page:FileText,reading:BookOpen,task:SquareCheck,flashcard:Layers,text:Quote,image:Image,link:Globe2};
const labels={library:"资料库范围",page:"页面",reading:"阅读条目",task:"任务",flashcard:"闪卡文字快照",text:"所选文字",image:"已授权原图",link:"公共网页"};
export function AgentMaterialCard({kind,title,subtitle,onRemove,disabled=false,removeLabel,onOpen,openLabel,manage=false}:{kind:MaterialKind;title:string;subtitle?:string;onRemove?:()=>void;disabled?:boolean;removeLabel?:string;onOpen?:()=>void;openLabel?:string;manage?:boolean}){
 const Icon=icons[kind];
 const content=<><span className="agent-material-icon" aria-hidden="true">{kind==="text"?<span className="agent-material-monogram">Aa</span>:<Icon size={19} strokeWidth={1.7}/>}</span><span className="agent-material-caption"><span className="agent-material-title" title={title}>{title}</span><small>{subtitle||labels[kind]}</small></span></>;
 return <span className="agent-context agent-material-card" data-material-kind={kind}>{onOpen?<button type="button" className="agent-context-open" aria-label={openLabel} onClick={onOpen}>{content}</button>:content}{onRemove&&<button type="button" className="agent-context-remove" disabled={disabled} aria-label={removeLabel||`移除材料 ${title}`} title={manage?"管理原图授权；撤回会使依赖它的旧回答失效":"移除待发送资料，不删除原文"} onClick={onRemove}>{manage?<SlidersHorizontal size={13}/>:<X size={13}/>}</button>}</span>;
}
