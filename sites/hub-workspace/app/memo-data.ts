export type MemoRecord={id:string;date:string;text:string;files:string[];library?:string;pinned?:boolean;tags?:string[]};
export type MemoScope={kind:"all"|"pinned"|"tag"|"day";value?:string};
export type JournalRecordFilter="all"|"pinned"|"attachments"|"untagged";
export const journalRecordFilters={all:"全部记录",pinned:"置顶记录",attachments:"带附件",untagged:"未加标签"} as const;
export function journalRecordMatches(record:MemoRecord,filter:JournalRecordFilter){return filter==="all"||filter==="pinned"&&!!record.pinned||filter==="attachments"&&record.files.length>0||filter==="untagged"&&!record.tags?.some(tag=>tag.trim())&&memoTags(record.text).length===0;}
export function memoTags(text:string){return [...new Set([...text.matchAll(/(?:^|\s)#([^\s#.,，。!?！？\[\]<>]+)/gu)].map(m=>m[1]))];}
export function memoMatches(record:MemoRecord,scope:MemoScope,query:string){return (scope.kind==="all"||scope.kind==="pinned"&&record.pinned||scope.kind==="tag"&&memoTags(record.text).some(t=>t===scope.value||t.startsWith(scope.value+"/"))||scope.kind==="day"&&record.date===scope.value)&&[record.text,...record.files].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());}
export function sortMemos(records:MemoRecord[]){return [...records].sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned)||b.date.localeCompare(a.date));}
export const sampleMemos:MemoRecord[]=[
 {id:"memo-example-project",date:"2026-11-08",pinned:true,files:[],text:"#项目/Hub 今天想清楚的一件事：先让记录变得轻松，再考虑怎样整理。\n\n- 输入时不用先想标题。\n- 用 #标签 留下一个能再次找到它的入口。\n- 回看时保留上下文，少一点来回跳转。\n\n**下一步**\n用一条真实想法，走完记录、搜索和再次打开的过程。"},
 {id:"memo-example-reading",date:"2026-11-07",files:[],text:"#阅读/方法 读完以后，留下一个与当前问题有关的想法。\n\n记录不必像文章那样完整。有时一句观察、一个疑问，或者一段没有想完的话，就足够成为下一次继续的起点。\n\n我想尝试把读过的内容分成两部分：一部分是作者真正说了什么，另一部分是这件事和我现在的问题有什么关系。前者帮助我保留依据，后者帮助我找到使用它的场景。两部分都不需要很长，但要能在回看时辨认出来。\n\n如果一个观点暂时用不上，可以先留下原始出处和一个简单标签。以后遇到类似问题时，再补充新的理解。无需为了把记录做得完整，打断当前正在进行的阅读。\n\n> 好的记录，为下一次思考留一个入口。\n\n回看也不必从头整理所有笔记。可以从一个标签、一段时间，或一条还没有得到回答的问题开始。在同一个主题下，观察自己前后的理解有什么变化，往往比继续增加新的资料更有帮助。\n\n这张长卡片是交互示例，可以展开阅读全文。"},
 {id:"memo-example-inbox",date:"2026-11-06",files:[],text:"#灵感 一个可以试试的小习惯：\n\n每天结束时，只记下今天确认的一件事、还没想清楚的一个问题。\n\n不急着给所有想法下结论。"},
];
