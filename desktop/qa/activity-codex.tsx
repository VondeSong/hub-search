import {useEffect,useState} from "react";
import {createRoot} from "react-dom/client";
import {type ActivityRun,type ActivityEvent} from "../src/AgentActivity";
import {AgentConversation,type Conversation,type Report} from "../src/AgentDelivery";
import "../src/App.css";
import "../src/AgentInvestigation.css";
const stages=['初始等待','公开进展','执行工具','工具结束后思考','连续工具','公开思考摘要','下一阶段','长列表与异常','生成答复','执行完成'];
function eventsFor(stage:number,start:number):ActivityEvent[]{
 const event=(id:string,kind:ActivityEvent['kind'],label:string,at:number,extra:Partial<ActivityEvent>={}):ActivityEvent=>({id,kind,label,createdAt:start+at,state:'completed',...extra});
 if(stage===0)return [];
 const events=[event('m1','message','我会核对两份材料的适用范围，再检查原文与引用是否一致。',1000)];
 if(stage===1)return events;
 events.push(event('read','tool','读取原文 · Lark Coding Agent Bridge',2000,{state:stage===2?'running':'completed',finishedAt:stage>=3?start+4500:undefined,detail:'已读取正文第 1–80 行。原文和引用将在下一步核对。'}));
 if(stage<=3)return events;
 events.push(event('search','webSearch','搜索网页 · 3 条查询',5000,{state:stage===4?'running':'completed',action:'search',queries:['Lark Coding Agent Bridge documentation','source attribution','release history'],resultCount:8}));
 if(stage===4)return events;
 events.push(event('reason','reasoning','两份材料对应不同版本，需要核对发布时间，避免把旧版限制当作当前行为。',6000));
 if(stage===5)return events;
 events.push(event('m2','message','已找到两个版本的说明。接下来核对差异，并保留未能读取页面的具体原因。',7000));
 if(stage===6)return events;
 events.push(event('web','webSearch','访问原始说明',8000,{action:'openPage',resultCount:3,errorCount:1,errors:[{refId:'source-3',reason:'页面访问超时'}]}));
 for(let i=0;i<9;i++)events.push(event('check-'+i,'tool','核对引用 '+(i+1)+' · documentation/source-and-release-history',9000+i*100,{detail:'已核对对应段落，引用与原文一致。',finishedAt:start+9200+i*100}));
 events.push(event('verify','tool','验证引用与适用范围',10500,{state:stage===7?'running':'completed',detail:'全部已读取材料核对完成。无法读取的页面不作为结论依据。'}));
 if(stage>=8)events.push(event('answer','answer','已核对材料与引用。两份说明对应不同版本；未能读取的页面没有用于支持结论。',12000,{state:stage===8?'running':'completed'}));
 return events;
}
function App(){
 const [startedAt,setStartedAt]=useState(()=>Date.now());
 const [stage,setStage]=useState(0),[narrow,setNarrow]=useState(false),[playing,setPlaying]=useState(false),[iteration,setIteration]=useState(0);
 const [direct,setDirect]=useState(false);
 useEffect(()=>{if(!playing)return;const timer=setInterval(()=>setStage(s=>Math.min(9,s+1)),2200);return()=>clearInterval(timer)},[playing]);
 useEffect(()=>{if(stage===9)setPlaying(false)},[stage]);
 const restart=()=>{setStage(0);setStartedAt(Date.now());setIteration(i=>i+1);setPlaying(false)};
 const value:ActivityRun={runId:'replay-'+iteration,revision:1,state:stage===9?'completed':'investigating',running:stage!==9,startedAt,finishedAt:stage===9?startedAt+12000:null,steps:stage,events:eventsFor(stage,startedAt).filter(e=>!direct||e.kind==='answer')};
 const report:Report={status:'completed',summary:'',findings:[],nextSteps:[],questions:[],limitations:[],waitCondition:'',prose:{markdown:'已核对材料与引用。两份说明对应不同版本；未能读取的页面没有用于支持结论。',citations:[]}};
 const conversation:Conversation={hasEarlier:false,messages:[{id:'user',role:'user',revision:1,text:'比较两份材料，核对引用与适用范围。',createdAt:startedAt},...(stage===9?[{id:'final',role:'assistant' as const,runId:value.runId,revision:1,createdAt:startedAt+12000,report}]:[])]};
 return <main style={{maxWidth:narrow?390:800,margin:'24px auto',padding:20,height:'calc(100% - 48px)',overflowY:'auto',background:'var(--hub-content-surface)'}}>
 <nav aria-label="回放控制" style={{display:'flex',flexWrap:'wrap',gap:12,alignItems:'center',marginBottom:28,fontSize:12}}>
 <span>录屏交互回放 · 合成测试数据</span><button onClick={restart}>重新开始</button><button onClick={()=>setPlaying(p=>!p)} disabled={stage===9}>{playing?'暂停回放':'自动回放'}</button><button disabled={stage===9} onClick={()=>setStage(s=>s+1)}>下一阶段</button><button onClick={()=>setNarrow(n=>!n)}>{narrow?'宽屏':'窄屏'}</button>
 <label>阶段 <select value={stage} onChange={e=>{setStage(Number(e.target.value));setPlaying(false)}}>{stages.map((label,i)=><option key={label} value={i}>{i+1}. {label}</option>)}</select></label><label><input type="checkbox" checked={direct} onChange={e=>{setDirect(e.target.checked);restart()}}/>直接回答（无公开过程）</label></nav>
 <div className="agent-body" style={{padding:0,overflow:'visible'}}><AgentConversation conversation={conversation} activity={[value]} revoked={false} onOpenCitation={()=>{}}/></div></main>
}
const root=createRoot(document.getElementById('root')!);
root.render(<App/>);
import.meta.hot?.dispose(()=>root.unmount());
