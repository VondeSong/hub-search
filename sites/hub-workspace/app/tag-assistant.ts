import { useEffect, useState } from "react";
import { sourceMeta, type HubItem, type SourceId } from "./data";

export const TOPIC = "线束设计", ALIAS = "汽车线束", IMPORT = "+BEGIN_NOTE";
const definitions: Record<string, string> = {
  [TOPIC]: "布线、接口与装配相关的设计资料。",
  [ALIAS]: "车辆线束的设计与验证记录。",
  "连接器": "连接器选型、端子与接口资料。",
  "评审": "需要共同审阅的材料或任务。",
  "验证": "试装或检查的过程与结果。",
  [IMPORT]: "疑似导入时被误识别为标签，需对照原文核对。",
};
export const descriptionOf=(tag:string)=>Object.hasOwn(definitions,tag)?definitions[tag]:"";
const fixture = (id:string, title:string, source:SourceId, space:string, tags:string[], excerpt:string, points:string[] = []):HubItem => ({
  id:"tag-demo-"+id, title, source, space, tags, excerpt, kind:source==="ticktick"?"task":"note",
  date:"2026-11-08", dateLabel:"示例", group:"本周",
  sections:[{type:"p",text:excerpt},...(points.length?[{type:"list" as const,items:points}]:[])],
});
export const tagExamples = [
  fixture("brief","前舱线束设计评审稿","craft","Car",[TOPIC, ALIAS, "评审"],"评审聚焦线束走向、夹点间距和连接器接近空间。",["对照装配图核对防磨保护范围。","确认需重新试装的两个夹点。"]),
  fixture("field","左前门线束试装记录","obsidian","OS",[TOPIC,"验证","工程/线束"],"试装发现门铰链附近在极限位置弯折偏紧。",["用全开和半开两个角度记录余量。"]),
  fixture("task","汇总线束评审待确认项","ticktick","线束项目",[TOPIC,"评审"],"整理接口、夹点和试装三类问题，附上评审稿与试装记录。"),
  fixture("interface","接口对照表与检查方法","craft","Car",["连接器"],"将线束插接件、回路和线号按接口编号关联，核对端子位置和装配方向。"),
  fixture("branch","车身线束分支布置备忘","obsidian","OS",[ALIAS,"评审","工程/线束/布置"],"比较分支出口向上与向侧面两种布置，记录装配顺序限制。"),
  fixture("routing","后舱线束固定点验证","craft","Car",[ALIAS,"验证"],"记录后舱固定点的振动和干涉检查。"),
  fixture("grommet","前门护套装配备忘","obsidian","OS",["装配"],"前门线束护套的安装角度影响弯折余量，应核对卡扣与固定点位置。"),
  fixture("import","旧试验记录导入样本","obsidian","OS",[IMPORT],"原文含 +BEGIN_NOTE。应检查导入规则是否把正文标记误识别为标签。"),
];
export type TagIntent = "definition" | "missing" | "relation";
export type TagTask = { intent: TagIntent; tag: string; other?: string; libraries?: string[] };
type Rule = { description: string; include: string; exclude: string };
type Status = "pending" | "accepted" | "rejected";
type Suggestion = {
  id: string; tag: string; status: Status; libraries: string[];
} & ({ kind: "definition"; rule: Rule; version?: number; basedOn: number; evidence: string[] }
   | { kind: "missing"; entityId: string; version: number }
   | { kind: "relation"; other: string; alias: boolean; evidence?: string[] });
export const tagIntents = [["definition","起草标签定义"],["missing","查找可能漏标"],["relation","比较标签关系"]] as const;
export const demoLibraries = [["Car","Craft · Car"],["OS","Obsidian · OS"],["线束项目","滴答清单 · 线束项目"]] as const;
export function tagRuleLibrary(item: HubItem) {
  if ((item.source==="craft"&&item.space==="Car")||(item.source==="obsidian"&&item.space==="OS")||(item.source==="ticktick"&&item.space==="线束项目")) return item.space;
  return item.source;
}
export function tagLibraryOptions(records: HubItem[], saved: string[]) {
  const options = new Map<string,string>(demoLibraries);
  for (const item of records) {
    const id=tagRuleLibrary(item);
    if (!options.has(id)) options.set(id,sourceMeta[item.source].name + (["craft","obsidian","ticktick"].includes(id)?" · 其他资料":""));
  }
  for (const id of saved) if (!options.has(id)) options.set(id,id);
  return [...options];
}
const aliasId = "tag-alias-vehicle";
const storage = "hub-tag-assistant-v1";
const alias: Suggestion = {id:aliasId,kind:"relation",tag:TOPIC,other:ALIAS,alias:true,libraries:[],status:"pending"};
const defaultRule: Rule = {description:descriptionOf(TOPIC),include:"线束走向、固定点、接口对照和试装验证。",exclude:"通用连接器产品目录、与线束无关的装配安排。"};
export const tagPrompt = ({intent,tag,other,libraries}:TagTask) => (intent==="relation" ? `比较标签 #${tag} 和 ${other ? "#"+other : ""}` : `${intent==="missing"?"查找可能漏标的内容：":"起草标签定义："}#${tag}`) + (libraries?.length ? '，只看 ' + libraries.join('、') : '');
export function parseTagRequest(text:string,tags:string[],currentTag?:string):{task:TagTask}|{clarify:string} {
  const intent = /比较|对比|别名|标签关系/.test(text) ? "relation"
    : /漏标|补标|没打|未打|(?:应该|适合|需要|可以).{0,8}(?:加上|加|打上|打).{0,8}(?:标签|[#＃])/.test(text) ? "missing"
    : /定义|说明这个标签|含义|是什么/.test(text) ? "definition" : null;
  if (!intent) return {clarify:"我可以起草标签定义、查找可能漏标的内容，或比较两个标签。你想先做哪一项？"};
  const explicit = [...text.matchAll(/[#＃]([^#＃\s，。！？；、：,;!?]+)/g)].map(match=>match[1]);
  const unknown = explicit.find(tag=>!tags.includes(tag));
  if (unknown) return {clarify:`没有找到 #${unknown}。请核对标签名称，或从标签页选中一个现有标签再试。`};
  let rest=text;
  const mentioned = [...tags].sort((a,b)=>b.length-a.length).flatMap(tag=>{
    const at=rest.indexOf(tag);
    if(at<0)return [];
    rest=rest.slice(0,at)+' '.repeat(tag.length)+rest.slice(at+tag.length);
    return [{tag,at}];
  }).sort((a,b)=>a.at-b.at).map(item=>item.tag);
  const found=[...new Set(explicit.length?explicit:mentioned)];
  if(intent==="relation"&&found.length===1&&currentTag&&tags.includes(currentTag)&&currentTag!==found[0])found.unshift(currentTag);
  if(intent==="relation"&&found.length!==2)return {clarify:"请告诉我要比较的两个标签，例如「比较 #线束设计 和 #汽车线束」。"};
  if(intent!=="relation"&&found.length>1)return {clarify:"这次要处理哪个标签？请用 # 指定一个标签。"};
  const tag=found[0] || (currentTag && tags.includes(currentTag) ? currentTag : undefined);
  if(!tag)return {clarify:"你想处理哪个标签？可以输入 #标签名。"};
  const libraries=demoLibraries.map(([key])=>key).filter(key=>key==='线束项目'?text.includes(key):new RegExp('\\b'+key+'\\b','i').test(text));
  if(libraries.length&&/排除|不看|不用.*(?:Car|OS|线束项目)|以外|除外/.test(text))return {clarify:"请在「资料范围」中排除不想看的资料，再发送。"};
  return {task:{intent,tag,other:found[1],libraries:libraries.length?libraries:undefined}};
}
export function useTagReview(items:HubItem[], notify:(text:string)=>void) {
  const [suggestions,setSuggestions] = useState<Suggestion[]>([alias]);
  const [ready,setReady] = useState(false);
  useEffect(()=>{
    try {
      const raw = JSON.parse(localStorage.getItem(storage)||"null");
      if(Array.isArray(raw)) setSuggestions(raw.filter(s=>s && typeof s.id==="string" && typeof s.tag==="string" && Array.isArray(s.libraries) && ["pending","accepted","rejected"].includes(s.status) && (
        (s.kind==="missing" && typeof s.entityId==="string") ||
        (s.kind==="definition" && Array.isArray(s.evidence) && typeof s.rule?.description==="string") ||
        (s.kind==="relation" && typeof s.other==="string"))));
      else {
        const previous = JSON.parse(localStorage.getItem("hub-tag-workspace-v1")||"null")?.decision;
        if(previous==="alias"||previous==="separate")setSuggestions([{...alias,status:previous==="alias"?"accepted":"rejected"}]);
      }
    } catch {}
    setReady(true);
  },[]);
  useEffect(()=>{if(ready)try{localStorage.setItem(storage,JSON.stringify(suggestions));}catch{notify("浏览器未能保存标签建议");}},[ready,suggestions]);
  const records = items;
  const tags = [...new Set(records.flatMap(item=>item.tags))].sort((a,b)=>a.localeCompare(b,"zh-CN"));
  const confirmed = (tag:string) => suggestions.filter((s):s is Extract<Suggestion,{kind:"definition"}>=>s.kind==="definition"&&s.tag===tag&&s.status==="accepted").sort((a,b)=>(b.version||0)-(a.version||0))[0];
  const ruleFor = (tag:string) => {
    const saved=confirmed(tag);
    return saved ? {rule:saved.rule,version:saved.version||1,libraries:saved.libraries} : tag===TOPIC ? {rule:defaultRule,version:1,libraries:demoLibraries.map(([key])=>key)} : null;
  };
  const description = (tag:string)=>ruleFor(tag)?.rule.description||descriptionOf(tag);
  const available = (s:Suggestion)=>s.kind!=="missing" || records.some(item=>item.id===s.entityId);
  const stale = (s:Suggestion)=>s.status==="pending" && (s.kind==="missing"?ruleFor(s.tag)?.version!==s.version:s.kind==="definition"?(ruleFor(s.tag)?.version||0)!==s.basedOn:false);
  const change=(s:Suggestion,status:Status,rule?:Rule,libraries=s.libraries)=>{
    if(!ready || !available(s) || (status==="accepted" && stale(s)))return;
    const version=Math.max(s.tag===TOPIC?1:0,...suggestions.flatMap(x=>x.kind==="definition"&&x.tag===s.tag?[x.version||0]:[]))+1;
    setSuggestions(old=>old.map(x=>x.id!==s.id?x:x.kind==="definition"&&rule?{...x,rule,status,version,libraries}:{...x,status}));
    notify(status==="pending"?"已撤销处理，建议回到待处理":status==="rejected"?"已驳回建议":s.kind==="definition"?"已保存标签定义":"已应用到 Hub");
  };
  function generate({intent,tag,other,libraries=[]}:TagTask, scoped:HubItem[]) {
    const base={tag,libraries,status:"pending" as const};
    const current=ruleFor(tag);
    let generated:Suggestion[]=[];
    if(intent==="definition") {
      const evidence=scoped.filter(i=>i.tags.includes(tag));
      const existing=description(tag);
      generated=[{...base,kind:"definition",id:"definition:"+crypto.randomUUID(),basedOn:current?.version||0,
        rule:{description:existing || ("用于整理与「"+tag+"」直接相关的资料。"),include:tag===TOPIC?defaultRule.include:"主题或工作内容明确涉及「"+tag+"」，并可从原文核对。",exclude:tag===TOPIC?defaultRule.exclude:"只顺带提及，或缺少支持该标签的原文。"},
        evidence:evidence.map(i=>i.id)}];
    } else if(intent==="missing") {
      if(!current)return {ids:[],message:"请先确认标签定义和适用范围，再查找漏标。"};
      const scope=libraries.filter(lib=>current.libraries.includes(lib));
      if(!scope.length)return {ids:[],message:"所选资料库不在已确认定义的适用范围内。"};
      const matches=tag===TOPIC?scoped.filter(i=>["tag-demo-interface","tag-demo-grommet"].includes(i.id)&&scope.includes(tagRuleLibrary(i))&&!i.tags.includes(tag)):[];
      generated=matches.map(item=>({...base,libraries:scope,kind:"missing",id:`missing:${item.id}:${tag}:${current.version}`,entityId:item.id,version:current.version}));
    } else if(other && other!==tag) {
      const evidence=scoped.filter(item=>item.tags.includes(tag)||item.tags.includes(other));
      const hasLeft=evidence.some(item=>item.tags.includes(tag)), hasRight=evidence.some(item=>item.tags.includes(other));
      if(!hasLeft||!hasRight)return {ids:[],message:"所选范围没有同时找到两个标签的样本，暂不能判断关系。可调整资料范围后重试。"};
      const isAlias=[tag,other].includes(TOPIC)&&[tag,other].includes(ALIAS)&&evidence.some(item=>item.tags.includes(tag)&&item.tags.includes(other));
      const ids=evidence.map(item=>item.id).sort();
      const previous=suggestions.find(item=>item.kind==="relation"&&((item.tag===tag&&item.other===other)||(item.tag===other&&item.other===tag))&&item.evidence?.join("\n")===ids.join("\n"));
      generated=[previous||{...base,kind:"relation",id:"compare:"+crypto.randomUUID(),other,alias:isAlias,evidence:ids}];
    }
    const existingIds=new Set(suggestions.map(s=>s.id));
    const fresh=generated.filter(s=>!existingIds.has(s.id));
    setSuggestions(old=>[...fresh.filter(s=>!old.some(x=>x.id===s.id)),...old]);
    return {ids:generated.map(s=>s.id),message:generated.length
      ? (fresh.length?"已准备建议。你可以在这里审核，也可稍后在「待处理」里查看。":"已找到同一条建议，沿用现有审核状态。")
      : "所选范围没有找到漏标示例。原型只检查预置样本。"};
  }
  function manualDefinition(tag:string) {
    const current=ruleFor(tag);
    const draft:Suggestion={id:"definition:"+crypto.randomUUID(),kind:"definition",tag,status:"pending",basedOn:current?.version||0,
      libraries:current?.libraries||demoLibraries.map(([key])=>key),rule:current?.rule||{description:description(tag),include:"",exclude:""},evidence:[]};
    setSuggestions(old=>[draft,...old]);
    return draft.id;
  }
  const supplement=(item:HubItem,tag:string)=>suggestions.some(s=>s.kind==="missing"&&s.status==="accepted"&&s.entityId===item.id&&s.tag===tag);
  const aliasEnabled=suggestions.some(s=>s.kind==="relation"&&s.alias&&s.status==="accepted");
  return {records,tags,suggestions,ready,description,ruleFor,stale,change,generate,manualDefinition,supplement,aliasEnabled};
}
export type TagReviewModel = ReturnType<typeof useTagReview>;
