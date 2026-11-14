export type DiscoveryScope = "work" | "life";
export type DiscoveryRecord = {id:string; title:string; date:string; library:string; text:string; nature:string};
export const discoveryExamples = {
 work: {
  title:"批量提取线表前，先找到能用的旧经验", question:"这次提取 DXF 线表，怎样判断可以开始批量处理？",
  records:[
   {id:"work-current",title:"这次的线表需求",date:"2026-11-10",library:"工作笔记",nature:"需求记录",text:"这批 DXF 需要提取导线编号与连接器孔位。文字可能在普通文字、块属性和多行文字中。准备先用工具 A 做一张样图，再决定是否批量处理。"},
   {id:"work-old",title:"上次批量转换的复盘",date:"2026-08-21",library:"经验笔记",nature:"本人复盘",text:"上次只核对普通文字就扩批，漏掉了块属性。以后应先用一张图分别核对普通文字、块属性和多行文字，检查缺失，再决定是否扩批。这个方法要求有一份可人工核对的样图结果。"},
   {id:"work-noise",title:"仓库批次编号说明",date:"2026-10-02",library:"参考资料",nature:"他人资料",text:"运输批次编号由仓库日期和流水号组成。本说明不涉及 DXF 图纸、块属性或提取验证。"},
  ],
  finding:"先用一张样图核对三种文字，再决定是否扩批。",
  why:"这次要提取的文字位置，正好对应旧复盘曾经遗漏的部分。旧经验提供了具体的验证顺序。",
  conditions:"需要覆盖普通文字、块属性和多行文字的代表样图，以及可以人工核对的结果。",
  exceptions:"旧复盘不能证明工具 A 现在能读全；一张样图通过也不代表所有图纸都通过。",
  observation:{id:"work-observation",title:"样图验证的新记录",date:"2026-11-12",library:"工作笔记",nature:"本人验证记录（示例）",text:"用工具 A 测试一张样图：普通文字已读出，块属性没有读出，多行文字尚未核对。其他图纸和工具 B 都没有测试。"},
  affected:"“样图已覆盖所需文字，可以扩批”这一条件尚未满足。先核对再扩批的旧经验仍然适用。",
  revised:"这张样图尚不满足扩批条件：先补齐块属性，并核对多行文字。",
  rationale:"新记录给出了块属性未读出、多行文字未核对的具体缺口。更新下一步，不把一次样图结果推广为工具 A 永远不可用。",
 },
 life: {
  title:"回看这一周，找到值得留下的安排",question:"这周实际发生了什么，有哪些做法值得继续观察？",
  records:[
   {id:"life-current",title:"这一周的记录",date:"2026-11-06",library:"生活日志",nature:"本人记录",text:"周一计划读完一本书。周三实际读了两章。周五参加了展览。周三晚上留了一个空档，感觉没有那么赶。"},
   {id:"life-old",title:"一次周末回顾",date:"2026-09-06",library:"生活日志",nature:"本人回顾",text:"那次周末没有把时间排满，临时陪朋友散步，觉得很舒服。我想以后试着留一点空档；这只是那次经历，还不知道是否每次都适合。"},
   {id:"life-noise",title:"尚未观看的电影收藏",date:"2026-11-13",library:"阅读收藏",nature:"收藏记录",text:"收藏了一份电影片单，准备以后再看。目前没有观看记录。"},
  ],
  finding:"留一点空档，是可以继续观察的安排。",
  why:"两段本人记录都提到留白与当时的轻松感，可以帮助回想有效的安排；不必把展览和散步换算成效率。",
  conditions:"只适用于这些明确写下的经历与感受。下一次安排可以留意实际情况。",
  exceptions:"记录少，不能确定留白造成了轻松，也不知道睡眠、工作量等其他因素的影响。计划读完一本书不等于已读完。",
  observation:{id:"life-observation",title:"后续一周的补充",date:"2026-11-13",library:"生活日志",nature:"本人补充（示例）",text:"这周也预留了一晚，但临时工作占用了空档。我感觉很累，同时这几天睡得也比较少。不能确定疲惫主要由什么造成。"},
  affected:"新记录没有提供“实际拥有空档”的相同条件。它提醒我们保留其他影响因素，不能据此否定原来的经历。",
  revised:"把“是否真正留下空档”和睡眠等情况一起记下，再观察哪些安排适合自己。",
  rationale:"后续空档被占用，条件已经不同。原观察可以维持；也可以把后续观察方法写得更具体，仍然不作因果判断。",
 },
} satisfies Record<DiscoveryScope,{title:string;question:string;records:DiscoveryRecord[];finding:string;why:string;conditions:string;exceptions:string;observation:DiscoveryRecord;affected:string;revised:string;rationale:string}>;

export type DiscoverySession={scope:DiscoveryScope; selected:string[]; started:boolean; saved:boolean; added:boolean; compared:boolean; correction:string; history:{outcome:"maintain"|"revise";text:string;reason:string}[]};
export function newDiscovery(scope:DiscoveryScope="work"):DiscoverySession{return {scope,selected:discoveryExamples[scope].records.slice(0,2).map(r=>r.id),started:false,saved:false,added:false,compared:false,correction:"",history:[]};}
export function hasDiscovery(s:DiscoverySession){return discoveryExamples[s.scope].records.slice(0,2).every(r=>s.selected.includes(r.id));}
export type DiscoveryAction={type:"select";id:string}|{type:"start"}|{type:"save"}|{type:"add"}|{type:"compare"}|{type:"confirm";outcome:"maintain"|"revise"}|{type:"correct";reason:string};
export function transitionDiscovery(s:DiscoverySession,a:DiscoveryAction):DiscoverySession{
 const sample=discoveryExamples[s.scope];
 switch(a.type){
  case "select":return !s.started&&sample.records.some(r=>r.id===a.id)?{...s,selected:s.selected.includes(a.id)?s.selected.filter(id=>id!==a.id):[...s.selected,a.id]}:s;
  case "start":return s.selected.length?{...s,started:true}:s;
  case "save":return s.started&&hasDiscovery(s)&&!s.correction?{...s,saved:true}:s;
  case "add":return s.saved?{...s,added:true}:s;
  case "compare":return s.added&&!s.correction?{...s,compared:true}:s;
  case "confirm":return s.compared&&!s.correction&&!s.history.length?{...s,history:[{outcome:a.outcome,text:a.outcome==="revise"?sample.revised:sample.finding,reason:a.outcome==="revise"?sample.rationale:"保留原判断及其适用条件；后续记录和本次核对理由一并保留。"}]}:s;
  case "correct":return {...s,correction:a.reason.trim().slice(0,500)};
 }
}
export function decodeDiscovery(raw:string|null):DiscoverySession|null{
 try{
  const s=JSON.parse(raw||"null");
  if(!s||!Object.hasOwn(discoveryExamples,s.scope)||!Array.isArray(s.selected)||!s.selected.every((v:unknown)=>typeof v==="string"&&discoveryExamples[s.scope as DiscoveryScope].records.some(r=>r.id===v))||new Set(s.selected).size!==s.selected.length)return null;
  if(![s.started,s.saved,s.added,s.compared].every(v=>typeof v==="boolean")||typeof s.correction!=="string"||!Array.isArray(s.history)||s.history.length>1)return null;
  if(s.saved&&(!s.started||!hasDiscovery(s))||s.added&&!s.saved||s.compared&&!s.added||s.history.length&&!s.compared)return null;
  if(s.history.some((v:Record<string,unknown>)=>!v||!["maintain","revise"].includes(String(v.outcome))||typeof v.text!=="string"||typeof v.reason!=="string"))return null;
  return s;
 }catch{return null;}
}
