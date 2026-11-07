import {useState} from "react";
import {createRoot} from "react-dom/client";
import {AgentPanelProvider,StandaloneAgentLauncher} from "../src/StandaloneAgentLauncher";
import "../src/App.css";
import "../src/AgentInvestigation.css";
const messageActions=new URLSearchParams(location.search).has("message-actions");
const examples=[messageActions?"Codex 附件处理和消息队列吗？为什么你简单参考 T3 的附件处理和消息队列":"总结这一天的事件","整理资料","核对计划","安装方案","历史决定","材料来源","接口分析","实施步骤","待验证事项","设计约束","任务记录","后续安排","参考文档","验收结果"].map((goal,index)=>({id:`history-example-${index}`,goal,state:"completed",messageCount:2,updatedAt:Date.now()-index*60000,pinned:false,deleted:false}));
const view=(id:string)=>{const item=examples.find(work=>work.id===id)!;return {work:{...item,revision:1,report:{status:"completed",summary:"这是一段固定示例答复，用于检查历史删除和撤销。",findings:[],nextSteps:[],questions:[],limitations:[],waitCondition:""},grant:{libraryIds:[],notes:[]}},conversation:{hasEarlier:false,messages:[{id:`${id}-question`,role:"user",text:item.goal,revision:1,createdAt:item.updatedAt}]},evidence:[],decisions:[],run:null,validity:"",runActive:false,actionActive:false};};
Object.assign(window,{__TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:()=>{}},__TAURI_INTERNALS__:{transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,{args}:{args:any}={args:{}})=>{
 if(command==="plugin:event|listen")return 1;if(command==="plugin:event|unlisten")return;
 if(command==="get_window_visibility")return {revision:"1",visible:true,foreground:true,minimized:false};
 if(command==="list_libraries")return [];
 if(command==="shared_memory")return {configured:false,projects:[],entries:[],selection:{enabled:false,projectId:""}};
 if(command==="model_runtime"){
  if(args.action==="codexAccounts")return {selected:"desktop",accounts:[],current:{label:"t***@example.invalid",scopeId:"a".repeat(64),kind:"chatgpt",plan:"plus"}};
  return args.action==="models"?{models:[]}:{settings:{provider:"codex",model:"example-model",reasoningEffort:"medium",fast:false,maxConcurrent:2},jobs:[],revision:1};
 }
 if(command==="agent_investigation"){
  if(args.action==="list"){const visible=examples.filter(item=>!item.deleted);const start=Number(args.before?.offset||0);return {works:visible.slice(start,start+6),nextCursor:start+6<visible.length?{offset:start+6}:null};}
  if(args.action==="status")return view(args.id);
  if(args.action==="setHistoryPreference"){const work=examples.find(item=>item.id===args.id)!;if(typeof args.deleted==="boolean")work.deleted=args.deleted;if(typeof args.pinned==="boolean")work.pinned=args.pinned;return {deleted:work.deleted,pinned:work.pinned};}
 }
 throw new Error("验收页面仅支持固定示例的历史管理。");
}}});
function App(){const [generation,setGeneration]=useState(0);return <main style={{height:"100dvh",padding:24,boxSizing:"border-box",background:"var(--hub-content-surface)"}}><h2>Hub · 浮窗尺寸与历史撤销验收</h2><p>固定示例，不调用模型，不修改真实对话。</p><button type="button" onClick={()=>setGeneration(value=>value+1)}>重新创建助手浮窗</button><AgentPanelProvider key={generation}><StandaloneAgentLauncher/></AgentPanelProvider></main>;}
createRoot(document.getElementById("root")!).render(<App/>);
