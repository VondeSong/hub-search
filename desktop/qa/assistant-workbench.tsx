import { createRoot } from "react-dom/client";
import { AgentInvestigation } from "../src/AgentInvestigation";
import type { SearchResult } from "../src/SearchTypes";
import "../src/App.css";

// This read-only viewer consumes a recorded real-provider run. It is not an
// end-to-end test and never fabricates model actions, save receipts or progress.
async function main() {
  const receipt=new URLSearchParams(location.search).get("receipt");
  const sourcePath=["native-first","native-second","native-resumed"].includes(receipt || "") ? `../artifacts/agent-native-20261022/${receipt}.json` : "../artifacts/agent-workbench-20261021/real-provider.json";
  const data=await fetch(sourcePath).then(r=>{if(!r.ok)throw new Error("实际运行记录尚未生成");return r.json();});
  const view=data.view;
  const anchor=view.work.anchor;
  const source=view.evidence[0];
  const width=Number(new URLSearchParams(location.search).get("width"))||0;
  Object.assign(window,{__TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:()=>{}},__TAURI_INTERNALS__:{
    transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,{args}:{args:any}={args:{}})=>{
      if(command==="plugin:event|listen")return 1;
      if(command==="plugin:event|unlisten")return;
      if(command==="get_window_visibility")return {revision:"1",visible:true,foreground:true,minimized:false};
      if(command==="shared_memory")return {configured:false,projects:[],entries:[],selection:{enabled:false,projectId:""}};
      if(command==="agent_investigation"){
        if(args.action==="list")return {works:[{id:view.work.id,goal:view.work.goal,state:view.work.state}]};
        if(args.action==="status")return structuredClone(view);
        if(args.action==="source")return {excerpt:source};
      }
      throw new Error("实际运行回放为只读。请在 Hub 中继续操作。");
    }
  }});
  const result:SearchResult={id:"trace-note",entityKey:"page:"+anchor.libraryId+":"+anchor.documentId,provider:"obsidian",libraryId:anchor.libraryId,libraryName:"验收笔记",spaceId:anchor.libraryId,spaceName:"验收笔记",documentId:anchor.documentId,contentType:"markdown",sourceType:"note",title:source.title,path:source.sourcePath,snippet:"",matchTerms:[],matchField:"",matchCount:0,subMatches:[]};
  createRoot(document.getElementById("root")!).render(
    <main style={{height:"100dvh",width:width?Math.max(320,width):"100%",maxWidth:"100%",display:"flex",flexDirection:"column",color:"var(--hub-text-primary)",background:"var(--hub-content-surface)"}}>
      <header style={{padding:"9px 18px",fontSize:12,borderBottom:"1px solid var(--hub-separator)"}}>Hub · 实际模型运行记录回放 · 仅查看</header>
      <section className="preview-pane" style={{flex:1}}>
        <article className="preview-card"><header className="preview-heading"><div className="preview-heading-top"><span>Obsidian · 验收笔记</span><AgentInvestigation result={result}/></div><h1>主动回忆与闪卡审核</h1></header><div className="preview-content"><p style={{whiteSpace:"pre-wrap"}}>{source.content}</p></div></article>
      </section>
    </main>
  );
}
void main().catch(reason=>{document.getElementById("root")!.textContent=String(reason);});
