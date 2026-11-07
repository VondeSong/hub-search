import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
type Page={snapshot:string;totalMembers:number;fullToolReturnMembers:number;partialToolReturnMembers:number;noVerifiedReadReceiptMembers:number;unverifiableOutcomeRecords:number;failedOutcomeRecords:number;nextCursor:string|null;members:{locator:{documentId:string};state:string;coveredChars:number;totalChars:number|null;receiptCount:number}[]};
export function AgentScopeCoverage({workId,revision,authorizationVersion,disabled}:{workId:string;revision:number;authorizationVersion:number;disabled:boolean}){
 const[page,setPage]=useState<Page|null>(null);const[busy,setBusy]=useState(false);const[error,setError]=useState("");const seq=useRef(0);
 useEffect(()=>{seq.current++;setPage(null);setError("");setBusy(false);return()=>{seq.current++;};},[workId,revision,authorizationVersion]);
 async function read(next=false){if(busy||disabled)return;const ticket=++seq.current;setBusy(true);setError("");try{
  const result=await invoke<Page>("agent_investigation",{args:{action:"sourceScopeCoverage",id:workId,expectedWorkRevision:revision,expectedAuthorizationVersion:authorizationVersion,...(next&&page?.nextCursor?{cursor:page.nextCursor}:{})}});
  if(ticket!==seq.current)return;if(next&&result.snapshot!==page?.snapshot)throw Error("读取记录已变化，请重新查看覆盖记录");setPage(result);
 }catch(e){if(ticket===seq.current){setError(String(e));setPage(null);}}finally{if(ticket===seq.current)setBusy(false);}}
 return <details className="agent-materials"><summary>材料读取覆盖</summary><p>按需核对固定清单和已保存的读取记录。全文返回不代表模型已读懂或完成抽取；模型阅读、抽取完成度和远端完整性仍未验证。</p>
 <button type="button" disabled={busy||disabled} onClick={()=>void read()}>查看覆盖记录</button>{busy&&<p role="status">正在核对读取记录…</p>}{error&&<p role="alert">{error}</p>}
 {page&&<><p>固定 {page.totalMembers} 份：工具已返回全文 {page.fullToolReturnMembers} 份、部分正文 {page.partialToolReturnMembers} 份、没有可核对读取回执 {page.noVerifiedReadReceiptMembers} 份。</p><p>无法核对的旧记录 {page.unverifiableOutcomeRecords} 条；失败工具回执 {page.failedOutcomeRecords} 条。没有回执不等于确认未读，工具失败不等于来源不存在。</p><ul>{page.members.map(m=><li key={m.locator.documentId}>{m.locator.documentId}：{m.state==="fullToolReturn"?"全文返回":m.state==="partialToolReturn"?"部分正文返回":"没有可核对读取回执"}；已返回 {m.coveredChars} / {m.totalChars??"未知"} 字符，{m.receiptCount} 条回执（重叠区间只计一次）。</li>)}</ul>{page.nextCursor&&<button type="button" disabled={busy||disabled} onClick={()=>void read(true)}>下一页覆盖</button>}</>}
 </details>;
}
