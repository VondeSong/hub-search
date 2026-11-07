import {createRoot} from "react-dom/client";
import {CodexAccountsSettings} from "../src/CodexAccountsSettings";
import {refreshCodexAccounts} from "../src/CodexAccounts";
import {AgentPanelProvider,StandaloneAgentLauncher} from "../src/StandaloneAgentLauncher";
import "../src/App.css";
import "../src/CodexSuiteSettings.css";
const a={label:"a***@example.invalid",scopeId:"a".repeat(64),plan:"plus",kind:"chatgpt",workspaceLabel:"工作区尾号 100001"};
const b={label:"b***@example.invalid",scopeId:"b".repeat(64),plan:"pro",kind:"chatgpt",workspaceLabel:"工作区尾号 200002"};
let selected="desktop",desktop=a,login:any=null;
let accounts=[{id:"profile-b",...b}];
const current=()=>selected==="desktop"?desktop:accounts.find(p=>p.id===selected)||null;
Object.assign(window,{__TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:()=>{}},__TAURI_INTERNALS__:{
 transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,{args}:{args:any}={args:{}})=>{
  if(command==="plugin:event|listen")return 1;if(command==="plugin:event|unlisten"||command==="plugin:opener|open_url")return;
  if(command==="get_window_visibility")return {revision:"1",visible:true,foreground:true,minimized:false};
  if(command==="list_libraries")return [];
  if(command==="model_runtime"){
   if(args.action==="codexAccounts")return {selected,accounts,current:current(),login};
   if(args.action==="selectCodexAccount"){selected=args.id;return {selected};}
   if(args.action==="startCodexLogin"){login={id:"demo-login",state:"pending",authUrl:"https://auth.openai.com/oauth/authorize?state=synthetic-preview"};return login;}
   if(args.action==="cancelCodexLogin"){login={id:"demo-login",state:"cancelled"};return {requested:true};}
   if(args.action==="removeCodexAccount"){accounts=accounts.filter(p=>p.id!==args.id);return {removed:args.id};}
   if(args.action==="models")return {models:[{id:"example-model",name:"示例模型",reasoningLevels:["medium"],defaultReasoning:"medium"}]};
   return {settings:{provider:"codex",model:"example-model",reasoningEffort:"medium",fast:false,maxConcurrent:2},jobs:[],revision:1};
  }
  if(command==="agent_investigation"&&args.action==="list")return {works:[]};
  if(command==="shared_memory")return {configured:false,projects:[],entries:[],selection:{enabled:false,projectId:""}};
  throw Error("此验收页只检查账号选择和草稿，不调用真实模型或写入个人资料。");
 }
}});
function App(){return <AgentPanelProvider><main className="codex-suite-settings" style={{height:"100dvh",overflow:"auto",background:"var(--hub-content-surface)",padding:24}}><div style={{width:"100%",maxWidth:560,marginInline:"auto"}}><header style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}><h2 style={{fontSize:18}}>Hub · 账号设置交互验收</h2><StandaloneAgentLauncher/></header><p>示例账号与官方组件；此页面没有登录真实账号，也不会打开真实授权或发送模型请求。</p><CodexAccountsSettings/><div style={{marginTop:24,display:"flex",gap:12,flexWrap:"wrap"}}><button onClick={()=>{if(login?.state!=="pending")return;const profile={id:"profile-c",...a,label:"c***@example.invalid",scopeId:"c".repeat(64)};accounts.push(profile);login={id:login.id,state:"completed",profile};void refreshCodexAccounts();}}>完成示例授权</button><button onClick={()=>{desktop=desktop===a?b:a;void refreshCodexAccounts();}}>模拟桌面换号</button></div></div></main></AgentPanelProvider>}
createRoot(document.getElementById("root")!).render(<App/>);
