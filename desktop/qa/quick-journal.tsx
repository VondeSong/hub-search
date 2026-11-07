import { createRoot } from "react-dom/client";
import { QuickJournal } from "../src/QuickJournal";
import { defaultJournalView } from "../src/JournalViews";
import "../src/JournalDatabase.css";
const today="2026-11-07";
const records=["今天的一个想法：把记录的动作变得足够轻，才能一直记下去。\n\n#想法 #日常", "整理下一次评审需要确认的事项：\n\n- 照片和文字一起保存在本机\n- 断网后继续记录，联网再上传\n- 重试不会在当天日记中产生重复内容\n\n#工作", "读书摘记\n\n"+"记录不是为了安排每一分钟，而是给之后的自己留下能接着思考的线索。\n\n".repeat(12)];
let items=records.map((text,i)=>({record:{version:1,id:String(i).repeat(32),date:today,text,attachments:[]},body:text,applied:i!==1,uploaded:i!==1,libraryId:"os",path:"",namespace:"demo"}));
(window as any).__TAURI_INTERNALS__={invoke:async(cmd:string,args:any)=>{
 if(cmd==="get_quick_journal_draft")return "";
 if(cmd==="get_quick_journal_settings")return {settings:{libraryId:"os",folder:"Journals",sync:false},mobile:innerWidth<500};
 if(cmd==="list_quick_journal")return {items,error:""};
 if(cmd==="capture_quick_journal"){items=[{record:args.record,body:args.record.text,applied:false,uploaded:false,libraryId:"os",path:"",namespace:""},...items];return {warning:null};}
 return null;
}};
createRoot(document.getElementById("root")!).render(<div style={{height:"95dvh",maxWidth:location.search?390:undefined,display:"flex",fontFamily:"system-ui",margin:"0 auto"}}><main className="results-pane journal-database"><header style={{padding:"20px",borderBottom:"1px solid #ddd"}}><h1 style={{margin:0,fontSize:22}}>速记</h1><p>界面检查 · 示例数据</p></header><div style={{overflow:"auto",flex:1}}><QuickJournal libraries={[{id:"os",name:"OS",provider:"obsidian",connected:true,documentCount:0,excludedPaths:[]}]} scope={null} view={{...defaultJournalView(),period:"all",layout:"records",ascending:false}} dataVersion="qa"/></div></main></div>);
