import {useState} from "react";
import {createRoot} from "react-dom/client";
import {AgentSkills,skillTitle} from "../src/AgentSkills";
import "../src/App.css";
import "../src/AgentInvestigation.css";
const names=["hub-research","hub-statistics","hub-flashcards","hub-note-edit","hub-archive","hub-tool-guide"];
Object.assign(window,{__TAURI_INTERNALS__:{invoke:async(_command:string,{args}:{args:{action:string}})=>args.action==="skillPackages"?{sources:[]}:({skills:names.map(name=>({name,title:skillTitle(name),description:"仅在任务需要时使用，按已授权资料和工具范围处理。",origin:"builtin",available:true,allowImplicitInvocation:true,unavailableReasons:[],version:"preview"})),diagnostics:[],directory:"示例目录"})}});
function App(){const [selected,setSelected]=useState<string[]>([]);return <main className="agent-body agent-composer" style={{width:560,maxWidth:"100%",margin:"20px auto",position:"relative"}}><div className="agent-add-content agent-add-skills" style={{position:"relative",bottom:"auto",width:"100%"}}><header className="agent-popover-header"><strong>添加技能</strong></header><AgentSkills embedded disabled={false} selected={selected} onSelect={name=>setSelected([...new Set([...selected,name])])} onReset={()=>setSelected([])}/></div></main>}
createRoot(document.getElementById("root")!).render(<App/>);
