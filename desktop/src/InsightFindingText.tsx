import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Only explicit sections are separated; legacy prose stays intact.
export function findingSections(text:string){
 const parts={body:"",why:"",conditions:"",limits:"",comparison:""};
 const names:Record<string,keyof typeof parts>={发现:"body",为什么现在有关:"why",适用条件:"conditions",限制与未知:"limits",核对说明:"comparison"};
 let field:keyof typeof parts="body";
 let fence:{marker:string;length:number}|null=null;
 for(const line of text.split(/\r?\n/)){
  const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
  if(marker){if(!fence)fence={marker:marker[1][0],length:marker[1].length};else if(marker[1][0]===fence.marker&&marker[1].length>=fence.length&&line.trim()===marker[1])fence=null;parts[field]+=line+"\n";continue;}
  if(fence){parts[field]+=line+"\n";continue;}
  const heading=line.match(/^#{1,3}\s+(发现|为什么现在有关|适用条件|限制与未知|核对说明)\s*[:：]?\s*$/);
  if(heading){field=names[heading[1]];continue;}
  parts[field]+=line+"\n";
 }
 for(const key of Object.keys(parts) as (keyof typeof parts)[])parts[key]=parts[key].trim();
 return parts;
}
export function FindingMarkdown({text}:{text:string}){
 return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{img:()=>null,a:({children})=><span>{children}</span>}}>{text}</ReactMarkdown>;
}
export function InsightFindingText({text,previous}:{text:string;previous?:string}){
 const parts=findingSections(text);
 const body=<FindingMarkdown text={parts.body}/>;
 return <>{previous?<div className="idd-compare-grid" aria-label="新旧判断对照"><section><p className="idd-kicker">原判断 · 保留历史</p><FindingMarkdown text={previous}/></section><section><p className="idd-kicker">本次发现与调整</p>{body}</section></div>:body}
  <dl className="idd-conditions">{[["为什么现在有关",parts.why],["适用条件",parts.conditions],["限制与未知",parts.limits]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value?<FindingMarkdown text={value}/>:"此条结果未单列，请结合正文与依据核对。"}</dd></div>)}</dl>
  {parts.comparison&&<section><h4>核对说明</h4><FindingMarkdown text={parts.comparison}/></section>}
 </>;
}
