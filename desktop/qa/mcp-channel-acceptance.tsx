// Automated acceptance in an owned native WebView. No IPC or model result is mocked.
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {initializeUserProfileStorage,flushUserProfileStorage} from '../src/UserProfileStorage';
import {AgentAssistantOptions,type AssistantOptions} from '../src/AgentAssistantOptions';
import {ExistingWorkInvestigation} from '../src/AgentInvestigation';
import '../src/App.css';
import '../src/AgentInvestigation.css';
import '../src/AgentAssistantRefinement.css';

const call=(args:Record<string,unknown>)=>invoke<any>('agent_investigation',{args});
const pause=(ms=50)=>new Promise(r=>setTimeout(r,ms));
const root=createRoot(document.getElementById('root')!);
let config:any,events:any[]=[],details:any={};
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
async function checkpoint(state:string){await call({action:'mcpAcceptanceCheckpoint',result:{phase:config.phase,state,events,details}});}
async function record(name:string,data?:unknown){events.push({name,data,at:Date.now()});await checkpoint('running');}
async function wait<T>(read:()=>T|Promise<T>,name:string,ms=30_000):Promise<NonNullable<T>>{
 const limit=Date.now()+ms;while(Date.now()<limit){const value=await read();if(value)return value as NonNullable<T>;await pause(100);}throw Error('等待超时：'+name);
}
const visible=(element:HTMLElement)=>element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden';
async function button(name:string){return wait(()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===name&&!b.disabled&&visible(b)),name);}
async function click(name:string){const el=await button(name);el.scrollIntoView({block:'nearest'});el.focus();el.click();await pause();}
async function openConnection(){
 const trigger=await wait(()=>document.querySelector<HTMLButtonElement>('button[aria-label="对话详情"]'),'对话详情入口');trigger.click();await pause();
 const summary=await wait(()=>[...document.querySelectorAll<HTMLElement>('.agent-details-sections summary')].find(s=>s.textContent?.includes('联网与工具')),'联网与工具入口');
 if(!(summary.parentElement as HTMLDetailsElement).open)summary.click();await pause();
 return wait(()=>document.querySelector<HTMLSelectElement>('.agent-connection-settings label:first-of-type select'),'工具连接选择器');
}
async function field(selector:string,value:string){const el=await wait(()=>document.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>(selector),'输入控件');const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;el.focus();Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(el,value);el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}));await pause();}
const locator=(documentId:string)=>({kind:'note',libraryId:'mcp-fixture',documentId,pageId:null});
const options:AssistantOptions={model:{provider:'codex',model:'gpt-6.1-sol',reasoningEffort:'low',fast:false,maxConcurrent:1},autoFlashcardInbox:false,externalMcp:true,researchPolicy:'materials-only'};
async function create(goal:string){const value=await call({action:'create',goal,successCriteria:'',anchor:locator('allowed'),grant:{libraryIds:[],notes:[locator('allowed'),locator('extra')],readingItemKeys:[]}});await call({action:'configureAssistant',id:value.work.id,options});return value.work.id as string;}
async function view(id:string){return call({action:'status',id});}
function Settings({id,value,fail=false}:{id:string;value:AssistantOptions;fail?:boolean}){
 const [current,setCurrent]=useState(value);
 return <AgentAssistantOptions section="connection" value={current} canAuto={false} disabled={false} onSave={async next=>{
  const candidate=fail?{...next,model:{...options.model!,provider:'deepseek'}}:next;
  await call({action:'configureAssistant',id,options:candidate});setCurrent(next);
 }}/>;
}
async function submit(id:string,text:string){
 root.render(<ExistingWorkInvestigation workId={id}/>);
 await wait(()=>document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.disabled===false,'对话可输入');
 await field('[name="investigationGoal"]',text);
 const send=await wait(()=>document.querySelector<HTMLButtonElement>('.agent-send:not(:disabled)'),'发送按钮');send.click();
 await record('submittedThroughProductionComposer',{workId:id});
}
async function completed(id:string){const result=await wait(async()=>{const v=await view(id);if(v.runActive||v.work.state==='ready')return null;if(['failed','interrupted','insufficientEvidence','needsDecision'].includes(v.work.state))throw Error('本轮没有完成：'+v.work.state+' '+(v.run?.error||v.validity||''));return v.work.report?v:null;},'模型完成',240_000);assert(JSON.stringify(result.work.report).includes('7'),'答案遗漏数量');assert(!JSON.stringify(result.work.report).includes('PRIVATE_MCP_SENTINEL'),'未授权资料泄漏');return result;}
async function settings(){
 const id=await create('设置保留验收（不调用模型）'),other=await create('其他对话设置隔离（不调用模型）');
 const catalog=await call({action:'discoverMcpService',server:'openai_docs'});
 assert(catalog.tools?.length,'外部服务目录为空');
 const service={server:catalog.server,catalogSha256:catalog.catalogSha256,tools:[catalog.tools[0].name]};
 const initial={...options,externalMcp:false,webSearch:'cached' as const,researchPolicy:'material-first' as const,mcpServices:[service]};
 await call({action:'configureAssistant',id,options:initial});await call({action:'configureAssistant',id:other,options:initial});
 root.render(<Settings id={id} value={initial}/>);
 await field('.agent-connection-settings label:first-of-type select','mcp');
 assert((await view(id)).assistantOptions.externalMcp!==true,'未应用的选择已落盘');
 root.render(<div>关闭未应用面板</div>);await pause();
 root.render(<Settings id={id} value={initial}/>);await pause();
 assert(document.querySelector<HTMLSelectElement>('.agent-connection-settings label:first-of-type select')?.value==='native','取消后未恢复已存设置');
 await field('.agent-connection-settings label:first-of-type select','mcp');await click('应用到本对话');
 const saved=await view(id);assert(saved.assistantOptions.externalMcp===true,'应用没有持久化');assert(saved.assistantOptions.webSearch==='cached','通道改变了联网偏好');
 const retained=saved.assistantOptions.mcpServices;
 assert(retained?.length===1&&retained[0].server===service.server&&retained[0].catalogSha256===service.catalogSha256&&JSON.stringify(retained[0].tools)===JSON.stringify(service.tools),'通道改变了所选外部服务');
 assert((await view(other)).assistantOptions.externalMcp!==true,'影响了其他对话');
 await record('settingsAppliedAndIsolated',{workId:id,otherWorkId:other});
 root.render(<div/>);await pause();root.render(<Settings id={id} value={saved.assistantOptions} fail/>);await pause();
 await field('.agent-connection-settings label:first-of-type select','native');await click('应用到本对话');
 await wait(()=>document.querySelector('[role="alert"]')?.textContent,'后端保存拒绝');
 assert((await view(id)).assistantOptions.externalMcp===true,'保存失败改写了后端设置');
 await record('failedApplyPreservesStoredOptions');details={settingsWorkId:id,otherWorkId:other};
}
async function run(){
 const id=config.workId||await create('读取合成资料并给出有原文依据的项目摘要。');details.workId=id;const before=await view(id);
 if(config.saveOnly){root.render(<ExistingWorkInvestigation workId={id}/>);await pause();}
 else{
  await submit(id,'先分别调用本轮 MCP 的读取工具重新读取两篇已授权页面：libraryId=mcp-fixture，documentId 分别为 allowed 和 extra，kind=note，pageId=null。然后简短说明数量、负责人、截止日期和待确认条件，附两篇原文引用。不要搜索网页，不保存资料。');
  if(before.run?.id)await wait(async()=>{const value=await view(id);return value.run?.id!==before.run.id?value:null;},'同一对话的新轮次',30_000);
 }
 const v=await completed(id);details.firstRun=v.run?.id;details.report=v.work.report;
 assert((v.work.report.prose?.citations||[]).length>=2,'没有两篇原文引用');
 await record('realMcpAnswerCompleted',{workId:id,runId:v.run?.id});
 const newNote=await wait(()=>[...document.querySelectorAll<HTMLButtonElement>('.agent-answer-destinations button')].filter(b=>b.textContent==='新建笔记'&&!b.disabled&&visible(b)).reverse()[0],'本轮回答保存入口');
 newNote.scrollIntoView({block:'nearest'});newNote.click();
 await wait(()=>document.querySelector<HTMLSelectElement>('[aria-label="保存资料库"]')?.disabled===false,'保存目标就绪');
 await field('[aria-label="保存资料库"]','mcp-fixture');await field('[aria-label="保存标题"]',config.saveTitle||'MCP验收保存A');
 await click('预览保存');await button('确认保存');
 await record('previewRequiresConfirmation');await click('确认保存');
 await wait(()=>document.querySelector('.agent-answer-save')?.textContent?.includes('已保存并核验'),'保存回执');
 const saves=(await view(id)).answerSaves;details.answerSaves=saves;
 await record('answerSavedThroughProductionPreview');
}
async function stop(){const id=config.workId;assert(id,'缺少原对话');details.workId=id;
 await submit(id,'继续只读核对：请分步读取两篇资料，分别复核数量、负责人、日期和缺少的验收信息，再形成带原文引用的简短总结。请先读取再总结。');
 await wait(async()=>{const v=await view(id);return v.runActive&&v.run?.id!==config.previousRunId?v:null;},'新一轮运行中',30_000);
 const stop=await wait(()=>document.querySelector<HTMLButtonElement>('[aria-label="停止本轮"]:not(:disabled)'),'停止按钮');stop.click();
 const v=await wait(async()=>{const value=await view(id);return !value.runActive&&['paused','interrupted','cancelled'].includes(value.work.state)?value:null;},'停止生效',45_000);
 details.stoppedRun=v.run?.id;details.lifecycle=v.lifecycle;await record('stoppedThroughProductionControl');
}
async function resume(){
 const id=config.workId;details.workId=id;const before=await view(id);details.before=before.lifecycle;
 root.render(<ExistingWorkInvestigation key="first-reopen" workId={id}/>);await pause(1500);
 const idle=await view(id);assert(!idle.runActive&&idle.run?.id===before.run?.id,'重开后静默启动了新一轮');await record('reopenDoesNotAutoResume');
 if(config.failureProbe){
  await continueExplicit(id);
  const failed=await wait(async()=>{const v=await view(id);return v.run?.id!==before.run?.id&&!v.runActive&&v.work.state!=='ready'?v:null;},'MCP 启动故障被保留',90_000);
  details.failedRunId=failed.run?.id;details.failedState=failed.work.state;details.failureMessage=failed.run?.error||document.querySelector('[role="alert"]')?.textContent;
  assert(!failed.runActive&&failed.work.state==='failed','MCP 启动故障没有形成可恢复失败');await record('requiredMcpPeerFailureRetainsWork');
  return;
 }
 await continueExplicit(id);
 await wait(async()=>{const v=await view(id);return v.run?.id!==before.run?.id?v:null;},'恢复创建新轮',30_000);
 const after=await completed(id);details.runId=after.run?.id;details.after=after.lifecycle;details.report=after.work.report;
 assert(after.work.id===id,'恢复更换了对话身份');assert(after.assistantOptions.externalMcp===true,'恢复丢失 MCP 设置');
 await record('resumedSameWorkThroughProductionControl');
}
async function continueExplicit(id:string){
 const current=await view(id);
 if(current.lifecycle?.requiresExplicitResume){
  const notice=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='查看任务详情'&&visible(b));
  if(notice){notice.click();await pause();}
  await click('恢复并继续');
 }else{
  await field('[name="investigationGoal"]','继续完成前述未完成要求，沿用当前资料授权，附当前仍可核对的原文引用。');
  const send=await wait(()=>document.querySelector<HTMLButtonElement>('button.agent-send[type="submit"]:not(:disabled)'),'继续发送');send.click();
 }
}
async function narrow(){
 const id=config.workId;details.workId=id;const before=await view(id);
 const changed=before.work.grant.notes.some((note:any)=>note.documentId==='extra')
  ?await call({action:'message',id,clientMessageId:crypto.randomUUID(),expectedRevision:before.work.revision,removeNotes:[locator('extra')],text:'明确撤回 B 资料的读取授权，仅保留 A；不要自动启动分析。'})
  :before;
 assert(changed.work.grant.notes.length===1&&changed.work.grant.notes[0].documentId==='allowed','资料没有收窄');
 assert((changed===before||changed.work.revision>before.work.revision)&&changed.work.authorizationVersion>=before.work.authorizationVersion,'范围修改缺少新的事项版本');
 details.scopeBefore={revision:before.work.revision,authorizationVersion:before.work.authorizationVersion,grant:before.work.grant};
 details.scopeAfter={revision:changed.work.revision,authorizationVersion:changed.work.authorizationVersion,grant:changed.work.grant};
 await submit(id,'本轮重新调用读取工具，只按当前仍授权的资料 A（documentId=allowed）核对数量和未确认事项，附 A 的原文引用。对已撤回的 B 不再读取或引用；不根据历史回答推断负责人或日期。');
 await wait(async()=>{const v=await view(id);return v.run?.id!==before.run?.id?v:null;},'收窄后的新轮',30_000);
 const after=await completed(id);details.runId=after.run?.id;details.report=after.work.report;
 assert((after.work.report.prose?.citations||[]).every((c:any)=>!JSON.stringify(c).includes('extra')),'答案引用了撤回资料');
 assert(!['2026-11-20','林','MCP-B-283'].some(value=>JSON.stringify(after.work.report).includes(value)),'答案重新使用了已撤回资料的事实');
 await record('narrowedAuthorizationRetained');
}
async function unknown(){
 const id=config.workId;details.workId=id;const v=await view(id),item=v.answerSaves.find((s:any)=>s.saveId===config.saveId);
 assert(item?.state==='unknown','丢失确认的故障注入未生效');
 let rejected=false,replay:any;try{replay=await call({action:'submitAnswerSave',id,saveId:item.saveId,confirmationToken:item.confirmationToken});}catch{rejected=true;}
 assert(rejected||replay?.state==='unknown','未知保存结果没有保留待核对状态');
 root.render(<ExistingWorkInvestigation workId={id}/>);
 await click('核对保存结果');await wait(()=>document.querySelector('.agent-answer-save')?.textContent?.includes('已保存并核验'),'只读核对保存结果');
 details.answerSaves=(await view(id)).answerSaves;await record('unknownSaveInspectedWithoutRetry');
}
async function main(){
 await initializeUserProfileStorage();
 await listen<{requestId:string}>('hub:flush-user-profile-before-exit',async event=>{
  await flushUserProfileStorage();await invoke('confirm_user_profile_exit',{requestId:event.payload.requestId});
 });
 config=await call({action:'mcpAcceptanceConfig'});await checkpoint('running');
 if(config.phase==='settings'&&config.settingsWorkId){
  details={settingsWorkId:config.settingsWorkId,otherWorkId:config.otherWorkId};
  const v=await view(config.settingsWorkId);root.render(<Settings id={config.settingsWorkId} value={v.assistantOptions}/>);await pause(300);
  assert(document.querySelector<HTMLSelectElement>('.agent-connection-settings label:first-of-type select')?.value==='mcp','进程重开后通道未保留');
  assert(v.assistantOptions.webSearch==='cached','进程重开后联网偏好未保留');assert(!(await view(config.otherWorkId)).assistantOptions.externalMcp,'重开改变其他对话');await record('settingsPersistAcrossNativeProcessRestart');
  root.render(<ExistingWorkInvestigation key="settings-in-full-assistant" workId={config.settingsWorkId}/>);
  await wait(()=>document.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')?.disabled===false,'完整助手加载');
  let select=await openConnection();assert(select.value==='mcp','完整详情入口未恢复 MCP');
  await field('.agent-connection-settings label:first-of-type select','native');await click('应用到本对话');
  await wait(async()=>!(await view(config.settingsWorkId)).assistantOptions.externalMcp,'完整助手应用内置连接');
  await field('.agent-connection-settings label:first-of-type select','mcp');await click('应用到本对话');
  const actual=await wait(async()=>{const next=await view(config.settingsWorkId);return next.assistantOptions.externalMcp?next:null;},'完整助手应用 MCP');
  assert(actual.assistantOptions.webSearch==='cached'&&actual.assistantOptions.mcpServices?.length===1,'完整助手切换改变独立选项');
  await record('fullAssistantHeaderDetailsAndApply');
 }else if(config.phase==='settings')await settings();
 else if(config.phase==='run')await run();
 else if(config.phase==='stop')await stop();
 else if(config.phase==='resume')await resume();
 else if(config.phase==='narrow')await narrow();
 else if(config.phase==='unknown')await unknown();
 else {throw Error('该验收阶段尚未配置：'+config.phase);}
 await checkpoint('passed');await call({action:'mcpAcceptanceExit'});
}
void main().catch(async e=>{events.push({error:String(e),at:Date.now(),ui:{alerts:[...document.querySelectorAll('[role="alert"]')].map(e=>e.textContent),fields:[...document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('.agent-answer-save input,.agent-answer-save select,.agent-answer-save textarea')].map(e=>({name:e.getAttribute('aria-label'),value:e.value,disabled:e.disabled})),buttons:[...document.querySelectorAll<HTMLButtonElement>('.agent-answer-save button')].map(e=>({name:e.textContent,disabled:e.disabled,visible:visible(e)}))}});try{
 if(details.workId){const v=await view(details.workId);if(v.runActive){const l=v.lifecycle;await call({action:'cancel',id:details.workId,commandId:crypto.randomUUID(),expectedControlRevision:l.controlRevision,expectedWorkRevision:l.workRevision,expectedRunId:l.activeRunId});await wait(async()=>!(await view(details.workId)).runActive,'失败清理停止',30_000);}}
 await checkpoint('failed');await call({action:'mcpAcceptanceExit'});
 }catch{document.body.textContent=String(e);}});
