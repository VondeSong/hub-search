"use client";
import {useCallback} from "react";
import {StageReviewForm,type ReviewInput,type ReviewPlan,type ReviewView} from "./StageReviewForm";
import "./stage-review.css";
const demoWork={id:"stage-review-example",goal:"回看这个月的支出与阅读（示例）"};
let saved:ReviewView|null=null;
export function StageReviewDemo({onAssistant}:{onAssistant:(prompt:string)=>void}){
 const loadWorks=useCallback(async()=>[demoWork],[]);
 const read=useCallback(async()=>saved,[]);
 const prepare=useCallback(async(plan:ReviewPlan,input:ReviewInput)=>{
  const question=plan.question.trim()||(plan.perspective==="year"?"与去年同期相比，有哪些有依据的变化？":plan.perspective==="month"?"这个月有哪些值得留下的经历与进展？":"请围绕这些笔记开放探索。");
  const day=plan.cutoff.slice(0,10);
  const end=day.slice(0,7)===plan.month?day:new Date(Date.UTC(Number(plan.month.slice(0,4)),Number(plan.month.slice(5)),1)).toISOString().slice(0,10);
  const windows=plan.perspective==="open"?[]:[{label:"本期",start:`${plan.month}-01`,end}];
  if(plan.perspective==="year")windows.push({label:"去年同期",start:`${Number(plan.month.slice(0,4))-1}${plan.month.slice(4)}-01`,end:`${Number(end.slice(0,4))-1}${end.slice(4)}`});
  saved={answer:{markdown:plan.perspective==="year"?"这组示例中，已记录净支出从500元变为700元，增加200元（40%）。差额来自医疗净支出：医疗300元减退款100元。内部转账与重复导入已排除。\n\n这只是同一覆盖范围的演示；没有完整账单时，不能据此判断全部消费变化。":"这组示例保留了从提出方案、验证纸面样本到补充检查条件的进展。可以复用的是：先在同一份输入上比较，再把发现的限制补进检查。\n\n纸面验证与实机完成仍需分开记录。这段文字只展示回顾的文章布局，不代表已经分析真实资料或贴入的内容。",createdAt:Date.now()},workId:demoWork.id,revision:(saved?.revision??0)+1,config:{...plan,question,windows,methodVersion:"示例演示",asOf:plan.cutoff},scope:{description:"演示资料：餐饮、医疗、退款、转账及重复记录；不代表真实读取",count:6},inputs:input.text.trim()?[{...input,id:"demo-input",version:1}]:[],calculations:plan.perspective==="year"?[{id:"demo-calc",createdAt:Date.now(),excluded:2,metrics:[{label:"示例已记录净支出",unit:"CNY",current:"700",previous:"500",difference:"200",percent:"40",status:"示例可比覆盖"}]}]:[]};
  return saved;
 },[]);
 const preview=useCallback(async()=>({description:"仅用于演示，未读取真实账单",count:6,items:["本期餐饮","本期医疗","医疗退款","内部转账","重复导入","去年餐饮"].map(title=>({title,path:"示例记录"}))}),[]);
 return <StageReviewForm preview={preview} demo loadWorks={loadWorks} read={read} prepare={prepare} onOpenWork={()=>onAssistant(`阶段回顾交互演示：${saved?.config.question}。仅用示例材料说明分析方式；不声称已经读取真实记录。${saved?.config.extraDiscoveries?"如有依据可补充线索，没有则省略。":"只回答原问题。"}`)}/>;
}
