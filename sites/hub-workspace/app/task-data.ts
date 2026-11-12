import {libraryNodes,nodeById,ancestorsOf} from "./library-data";
export const taskStates={todo:"待办",doing:"进行中",waiting:"等待条件",done:"已完成"} as const;
export type TaskState=keyof typeof taskStates;
export const didaTasks=libraryNodes.filter(n=>n.library==="dida"&&n.kind==="task");
export function taskProject(id:string){return ancestorsOf(id).find(n=>n.kind==="taskList")?.title||"收件箱";}
export function taskDate(id:string,dates:Record<string,string>){if(Object.hasOwn(dates,id))return dates[id];const day=nodeById[id]?.due?.match(/11\s*月\s*(\d+)/)?.[1];return day?"2026-11-"+day.padStart(2,"0"):"";}
export function taskStatus(id:string,checks:Record<string,boolean>,status:Record<string,string>):TaskState{if(checks["task:"+id]===true)return "done";if(status[id]&&status[id]!=="done")return status[id] as TaskState;if(checks["task:"+id]===false)return nodeById[id]?.status==="doing"?"doing":"todo";return (nodeById[id]?.status||"todo") as TaskState;}
export const taskResources=[
 {task:"d-review",resource:"c-guide",relation:"设计依据"},
 {task:"d-review",resource:"f-review",relation:"评审记录"},
 {task:"d-review",resource:"o-learning",relation:"方法参考"},
 {task:"d-interface",resource:"f-sheet",relation:"核对台账"},
 {task:"d-interface",resource:"f-interface",relation:"接口定义"},
 {task:"d-sample",resource:"c-checks",relation:"检查记录"},
];

// Fictional cross-provider examples keep source filtering reviewable without local account data.
export const localTaskSamples: import("./data").HubItem[]=[
 {id:"sample-craft-review",title:"整理设计评审依据",source:"craft",project:"主项目"},
 {id:"sample-craft-check",title:"核对规范适用版本",source:"craft",project:"技术参考"},
 {id:"sample-obsidian-note",title:"补充项目回顾记录",source:"obsidian",project:"主项目"},
 {id:"sample-obsidian-plan",title:"整理下一轮验证计划",source:"obsidian",project:"工作记录"},
].map(t=>({...t,source:t.source as import("./data").SourceId,kind:"task" as const,space:t.source==="craft"?"Car":"OS",group:"今天" as const,date:"2026-11-08",dateLabel:"示例",tags:["项目"],excerpt:"用于对照本地任务界面的虚构任务。",sections:[{type:"p" as const,text:"这是跨来源任务视图的示例内容。"}],taskState:"todo" as const}));
