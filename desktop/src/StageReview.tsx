import {useCallback,useRef} from "react";
import {invoke} from "@tauri-apps/api/core";
import {StageReviewForm,type ReviewInput,type ReviewPlan,type ReviewView,type ReviewWork} from "./StageReviewForm";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./StageReview.css";
const call=<T,>(args:Record<string,unknown>)=>invoke<T>("agent_investigation",{args});
export function StageReview({onOpenWork}:{onOpenWork:(id:string)=>void}){
 const pending=useRef<{key:string;id:string;args:Record<string,unknown>}|null>(null);
 const loadWorks=useCallback(async()=>{let before:unknown=null;let all:ReviewWork[]=[];do{const page=await call<{works:ReviewWork[];nextCursor:unknown}>({action:"list",anchor:null,...(before?{before}:{})});all=[...all,...page.works];before=page.nextCursor;if(all.length>1000)throw new Error("事项较多，请先在助手历史中整理范围后重试");}while(before);return all;},[]);
 const read=useCallback(async(id:string)=>{const value=await call<ReviewView|null>({action:"insightReviewRead",id});if(!value)return null;const status=await call<{work:{revision:number;updatedAt:number;report?:{prose?:{markdown:string};summary:string}|null}}>({action:"status",id});if(status.work.revision!==value.revision)throw new Error("事项已更新，请重新核对");return {...value,...(status.work.report?{answer:{markdown:status.work.report.prose?.markdown??status.work.report.summary,createdAt:status.work.updatedAt}}:{})};},[]);
 const send=useCallback(async(args:Record<string,unknown>)=>{
  const {expectedRevision:_,...identity}=args;const key=JSON.stringify(identity);if(pending.current?.key!==key)pending.current={key,id:crypto.randomUUID(),args};
  const value=await call<ReviewView>({...pending.current.args,operationId:pending.current.id});pending.current=null;return value;
 },[]);
 const prepare=useCallback(async(plan:ReviewPlan,input:ReviewInput,id:string)=>{
  const current=id?await call<{work:{revision:number}}>({action:"status",id}):null;
  return send({action:"insightReviewPrepare",id,expectedRevision:current?.work.revision,plan,input});
 },[send]);
 const revise=useCallback((id:string,input:ReviewInput,revision:number)=>send({action:"insightReviewInput",id,input,expectedRevision:revision}),[send]);
 const preview=useCallback((id:string)=>call<{description:string;count:number;items:{title:string;path:string}[]}>({action:"insightReviewScope",id}),[]);
 return <StageReviewForm renderAnswer={markdown=><ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>} preview={preview} loadWorks={loadWorks} read={read} prepare={prepare} revise={revise} onOpenWork={onOpenWork}/>;
}
