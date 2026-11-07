import {useState} from "react";
import {createRoot} from "react-dom/client";
import {AgentActivity,type ActivityRun} from "../src/AgentActivity";
import {CodexSuiteFooter} from "../src/CodexSuiteFooter";
import "../src/App.css";
import "../src/AgentInvestigation.css";

// Isolated display fixture: no model calls or user database access.
Object.assign(window,{__TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:()=>{}},__TAURI_INTERNALS__:{transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string)=>{
  if(command==="plugin:event|listen") return 1;
  if(command==="plugin:event|unlisten") return;
  if(command==="get_window_visibility") return {revision:"1",visible:true,foreground:true,minimized:false};
  if(command==="model_runtime") return {revision:1,settings:{model:"gpt-6.1-sol",reasoningEffort:"",fast:false,maxConcurrent:2},jobs:[{id:"qa",label:"拿破仑与命运观",workflow:"agent",state:"succeeded",model:"gpt-6.1-sol",reasoningEffort:"xhigh",fast:false,finishedAt:10}]};
  throw new Error(`Unexpected fixture call: ${command}`);
}}});
const run:ActivityRun={runId:"qa",revision:1,state:"completed",running:false,startedAt:1000,finishedAt:245000,steps:1,events:[
  {id:"m1",kind:"message",state:"completed",label:"我会核对拿破仑的书信与回忆录，区分当时的表达和事后的叙述。",createdAt:1},
  {id:"s1",kind:"skill",state:"completed",label:"已读取「资料分析与核对」技能",detail:"Hub 内置 · 模型选择读取",createdAt:2},
  {id:"r1",kind:"reasoning",state:"completed",label:"核对书信的日期与版本",createdAt:3},
  {id:"w1",kind:"webSearch",state:"completed",label:"搜索网页 · 2 条查询",action:"search",queries:["Napoleon correspondence destiny 1796 Lodi original letter","Napoléon mémoires destin Sainte-Hélène"],resultCount:6,errorCount:1,sourceRefs:[{url:"https://fr.wikisource.org/wiki/Mémoires_(1842)",title:"回忆录（1842）"}],createdAt:4},
  {id:"m2",kind:"message",state:"completed",label:"已找到书信与回忆录两个版本；一项网页读取失败，接下来交叉核对可用来源。",createdAt:5},
  {id:"r2",kind:"reasoning",state:"completed",label:"区分原始书信与事后回忆",createdAt:6},
  {id:"w2",kind:"webSearch",state:"completed",label:"访问网页",action:"openPage",url:"https://fr.wikisource.org/wiki/Mémoires_(1842)",resultCount:3,errorCount:0,createdAt:7},
  {id:"r3",kind:"reasoning",state:"completed",label:"正在核对研究来源",createdAt:8}
]};
function App(){const [narrow,setNarrow]=useState(false);return <main style={{width:narrow?360:880,maxWidth:"100%",margin:"auto",height:"100dvh",display:"flex",flexDirection:"column",background:"var(--hub-content-surface)",color:"var(--hub-text-primary)"}}>
  <header style={{padding:16}}>Hub · 过程展示回归（示例数据） <button onClick={()=>setNarrow(!narrow)}>{narrow?"桌面宽度":"窄窗口"}</button></header>
  <div className="agent-body" style={{flex:1,overflow:"auto",padding:20}}><h2>拿破仑与命运观</h2><p>请核对一手材料，并继续解释上一轮的第二点。</p><AgentActivity value={run}/><article className="agent-report"><h3>从书信到回忆录</h3><p>此页面只验收正式组件的分组、来源与状态展示，不生成新的研究结论。</p></article></div>
  <CodexSuiteFooter/>
</main>}
createRoot(document.getElementById("root")!).render(<App/>);
