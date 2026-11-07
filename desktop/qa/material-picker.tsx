import {useState} from "react";
import {createRoot} from "react-dom/client";
import {AgentMaterials,type AgentMaterial} from "../src/AgentMaterials";
import "../src/App.css";
import "../src/AgentInvestigation.css";
const notes=Array.from({length:20},(_,i)=>({locator:{kind:"note",libraryId:"demo",documentId:String(i),pageId:null},title:i===0?"拿破仑：人生转折与选择":`历史阅读笔记 ${i+1}`,libraryName:"示例资料库",path:`历史研究 / 阅读摘录 ${i+1}`}));
Object.assign(window,{__TAURI_INTERNALS__:{invoke:async(_command:string,{args}:{args:{query:{query:string}}})=>({notes:notes.filter(n=>n.title.includes(args.query.query)),total:notes.filter(n=>n.title.includes(args.query.query)).length,nextOffset:null,snapshot:"demo"})}});
function App(){const [selected,setSelected]=useState<AgentMaterial[]>([]),[done,setDone]=useState(false);return <main className="agent-body agent-composer" style={{width:360,maxWidth:"100%",margin:"20px auto",height:600,position:"relative"}}><p>笔记选择器 · 示例数据</p>{done?<p>已选 {selected.length} 份，等待发送消息。<button onClick={()=>setDone(false)}>继续选择</button></p>:<div className="agent-add-content agent-add-materials" style={{position:"relative",bottom:"auto",width:"100%"}}><header className="agent-popover-header"><strong>从笔记库添加</strong></header><div className="agent-add-section"><AgentMaterials embedded selected={selected} disabled={false} onChange={setSelected} onDone={()=>setDone(true)}/></div></div>}</main>}
createRoot(document.getElementById("root")!).render(<App/>);
