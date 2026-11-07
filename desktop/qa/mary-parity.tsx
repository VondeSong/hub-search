import {useState} from "react";
import {createRoot} from "react-dom/client";
import {AgentActivity,type ActivityRun} from "../src/AgentActivity";
import skill from "../src-tauri/src/agent_work/skills/hub-research/SKILL.md?raw";
import "../src/App.css";
import "../src/AgentInvestigation.css";
const instructions=skill.split('---').slice(2).join('---').trim();
const record=JSON.stringify({kind:"skillInstructions",instructions});
Object.assign(window,{__TAURI_INTERNALS__:{invoke:async(command:string)=>{
 if(command!=="agent_investigation")throw new Error("Unexpected fixture call");
 return {kind:"historicalToolResult",recordId:"skill",sha256:"a".repeat(64),content:record,startChar:0,endChar:Array.from(record).length,totalChars:Array.from(record).length,nextStartChar:null,historical:true,currentEvidence:false,methodPreview:{title:"资料分析与核对",content:instructions,totalChars:Array.from(instructions).length,truncated:false}};
}}});
const run:ActivityRun={workId:"fixture",currentWorkRevision:1,authorizationVersion:1,runId:"qa",revision:1,state:"completed",running:false,startedAt:1000,finishedAt:115000,steps:1,events:[
 {id:"m",kind:"message",state:"completed",label:"这是展示回归示例。公开网页研究可直接使用联网工具；本地资料研究按需读取方法说明。",createdAt:1},
 {id:"s",kind:"skill",state:"completed",label:"已读取「资料分析与核对」技能",detail:"Hub 内置 · 方法说明",resultRef:{recordId:"skill",sha256:"a".repeat(64)},createdAt:2},
 {id:"w1",kind:"webSearch",state:"completed",label:"搜索网页 · 2 条查询",action:"search",queries:["Mary I biography","Mary I original sources"],sourceRefs:[{url:"https://www.hrp.org.uk/hampton-court-palace/history-and-stories/mary-i/",title:"Mary I · Historic Royal Palaces"},{url:"https://yalebooks.yale.edu/book/9780300160451/fires-of-faith/",title:"Fires of Faith · Yale"}],errorCount:2,resultCount:5,errors:[{refId:"a",url:"https://www.nationalarchives.gov.uk/",reason:"网站拒绝访问（403）"},{refId:"b",url:"https://www.repository.cam.ac.uk/",reason:"访问超时"}],createdAt:3},
 {id:"w2",kind:"webSearch",state:"completed",label:"查阅网页资料",errorCount:1,resultCount:4,errors:[{refId:"c"}],createdAt:4},
 {id:"r",kind:"reasoning",state:"completed",label:"核对继承危机的原始研究",createdAt:5},
 {id:"m2",kind:"message",state:"completed",label:"部分页面无法访问，其余来源仍可核对。研究结论与方法说明分开呈现。",createdAt:6}
]};
function App(){const [narrow,setNarrow]=useState(false);return <main style={{width:narrow?360:880,maxWidth:"100%",margin:"auto",minHeight:"100dvh",background:"var(--hub-content-surface)",color:"var(--hub-text-primary)"}}>
 <header style={{padding:16}}>Hub · 研究过程回归（示例数据） <button onClick={()=>setNarrow(!narrow)}>{narrow?"桌面宽度":"窄窗口"}</button></header>
 <div className="agent-body" style={{padding:20}}><h2>玛丽一世与命运</h2><AgentActivity value={run}/></div>
 </main>}
createRoot(document.getElementById("root")!).render(<App/>);
