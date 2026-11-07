import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentInvestigation } from "../src/AgentInvestigation";
import type { SearchResult } from "../src/SearchTypes";
import type { ConversationMessage } from "../src/AgentDelivery";
import "../src/App.css";
import "../src/AgentInvestigation.css";
const sourceText="先理解材料，再尝试不看原文回忆。将难以回忆的关键问题做成闪卡，并为答案保留原文依据。";
const evidence={title:"间隔重复学习",sourcePath:"学习方法/间隔重复学习.md",content:sourceText,startChar:0,endChar:sourceText.length,totalChars:sourceText.length,truncated:false};
const saved=localStorage.getItem("hub-assistant-outcomes-qa");
let work=saved?JSON.parse(saved):null;
const persist=()=>localStorage.setItem("hub-assistant-outcomes-qa",JSON.stringify(work));
const qaWidth=Number(new URLSearchParams(location.search).get("width"))||0;
Object.assign(window,{__TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:()=>{}},__TAURI_INTERNALS__:{transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,{args}:{args:any}={args:{}})=>{
  if(command==="plugin:event|listen")return 1;
  if(command==="plugin:event|unlisten")return;
  if(command==="get_window_visibility")return {revision:"1",visible:true,foreground:true,minimized:false};
  if(command==="shared_memory")return {configured:false,projects:[],entries:[],selection:{enabled:false,projectId:""}};
  if(command==="model_runtime")return {models:[{id:"qa-model",name:"示例模型",reasoningLevels:["low","high"],defaultReasoning:"high"}]};
  if(command!=="agent_investigation")throw new Error(command);
  if(args.action==="list")return {works:work?[{id:work.work.id,goal:work.work.goal,state:work.work.state}]:[]};
  if(args.action==="create")work={work:{id:"qa-conversation",goal:args.goal,revision:1,state:"ready",report:null,grant:args.grant},evidence:[evidence],decisions:[],run:null,runActive:false,conversation:{messages:[{id:"u0",role:"user",text:args.goal,revision:1,createdAt:Date.now()}],hasEarlier:false},validity:""};
  if(args.action==="message"||args.action==="decision"){work.work.revision++;work.work.report=null;work.work.state="ready";work.conversation.messages.push({id:crypto.randomUUID(),role:"user",text:args.text,revision:work.work.revision,createdAt:Date.now()});}
  if(args.action==="respond"){
    const id=crypto.randomUUID(); const latest=work.conversation.messages.filter((m:ConversationMessage)=>m.role==="user").at(-1).text;
    const report={status:"completed",summary:`${latest.includes("简")?"核心是理解后主动回忆，针对薄弱点制卡。":"这篇笔记建议把阅读变成主动回忆和反馈：理解后合上原文回忆，再把薄弱点做成闪卡。"}`,findings:[{text:"制卡应围绕难以回忆的关键问题，并保留原文依据。",citations:[{evidenceId:"e1",quote:"将难以回忆的关键问题做成闪卡"}]}],nextSteps:[],questions:[],limitations:["此页面使用固定回复检查正式组件交互，没有调用真实模型。"],waitCondition:""};
    work.draftRequest=latest.includes("闪卡")?{runId:id,kind:"flashcards"}:null;
    work.work.report=report;work.work.state="completed";work.run={id,usage:{modelCalls:1,entitiesRead:1,bodyChars:sourceText.length}};work.conversation.messages.push({id,role:"assistant",report,evidence:[evidence],runId:id,revision:work.work.revision,createdAt:Date.now()});
  }
  if(args.action==="configureAssistant")work.assistantOptions=args.options;
  if(args.action==="prepareResponse") {
    work.draftRequest=null;
    work.actions={tagOptions:[],flashcardDecks:["收件箱"],obsidianEditAvailable:true,items:[{id:"qa-cards",kind:"flashcardDrafts",baseRevision:work.work.revision,state:"prepared",confirmationToken:"qa-confirm",payload:{deckName:"收件箱",learningGoal:"用主动回忆巩固关键问题",cards:[{question:"阅读材料后，怎样检查自己是否理解？",answer:"合上原文，尝试主动回忆，再核对遗漏。",explanation:"主动回忆可以帮助发现难以回忆的部分，为后续制卡提供具体目标。",evidenceText:"先理解材料，再尝试不看原文回忆。"},{question:"哪些内容适合做成闪卡？",answer:"难以回忆的关键问题，并为答案保留原文依据。",explanation:"用薄弱点确定制卡目标，让问题与原文依据保持对应。",evidenceText:"将难以回忆的关键问题做成闪卡，并为答案保留原文依据。"}],uncoveredTargets:[]}}]};
  }
  if(args.action==="selectFlashcards") {const a=work.actions.items[0];a.payload.cards=a.payload.cards.filter((_:unknown,i:number)=>args.selectedIndices.includes(i));a.confirmationToken+="-selected";}
  if(args.action==="submitFlashcards"){const a=work.actions.items[0];a.state="verified";a.receipt={goalCompleted:false,result:{imported:a.payload.cards.length,duplicates:0}};a.currentResult={drafts:a.payload.cards.map((_:unknown,i:number)=>({id:`draft-${i}`,status:"pending"}))};}
  if(args.action==="source")return {excerpt:evidence};
  if(args.action==="revoke"){work.work.state="revoked";work.work.report=null;work.conversation.messages=[];}
  if(args.action==="cancel")work.work.state="interrupted";
  persist();return structuredClone(work);
}}});
const base:SearchResult={id:"page-a",entityKey:"page:os:a",provider:"obsidian",libraryId:"os",libraryName:"OS",spaceId:"os",spaceName:"OS",documentId:"a",contentType:"markdown",sourceType:"note",title:"间隔重复学习",path:"学习方法/间隔重复学习.md",snippet:"",matchTerms:[],matchField:"",matchCount:0,subMatches:[]};
function App(){const [selected,setSelected]=useState(base);return <main style={{height:"100dvh",width:qaWidth?Math.max(320,qaWidth):"100%",maxWidth:"100%",display:"flex",flexDirection:"column",color:"var(--hub-text-primary)",background:"var(--hub-content-surface)"}}><header style={{padding:"10px 18px",fontSize:12}}>Hub · 正式组件交互验收 · 固定回复示例<button onClick={()=>setSelected(selected.documentId==="a"?{...base,id:"page-b",documentId:"b",title:"检索练习",path:"学习方法/检索练习.md"}:base)} style={{marginLeft:20}}>切换资料</button></header><section className="preview-pane" style={{flex:1}}><article className="preview-card"><header className="preview-heading"><div className="preview-heading-top"><span>Obsidian · OS</span><AgentInvestigation result={selected}/></div><h1>{selected.title}</h1></header><div className="preview-content"><h2>我的学习流程</h2><p>{sourceText}</p><h2>制卡时的约定</h2><ul><li>每张卡围绕一个清楚的问题。</li><li>答案之外补充解释，帮助理解关联。</li><li>先检查草稿，再决定是否进入复习。</li></ul></div></article></section></main>}
createRoot(document.getElementById("root")!).render(<App/>);
