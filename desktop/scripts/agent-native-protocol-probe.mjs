import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
const root=path.resolve(import.meta.dirname,'..');
const directory=path.join(root,'.local','agent-native-20261022','protocol-probe');
const home=path.join(directory,'home'), workspace=path.join(directory,'workspace');
fs.mkdirSync(home,{recursive:true});fs.mkdirSync(workspace,{recursive:true});
const source=path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE,'.codex'),'auth.json');
const auth=path.join(home,'auth.json');
const borrowed=JSON.parse(fs.readFileSync(source,'utf8'));
if(borrowed.tokens)borrowed.tokens.refresh_token='';
fs.writeFileSync(auth,JSON.stringify(borrowed),{mode:0o600});
const disabled=['shell_tool','apps','plugins','remote_plugin','hooks','memories','skill_search','multi_agent','multi_agent_v2','computer_use','browser_use','browser_use_external','in_app_browser','image_generation','view_image','code_mode','workspace_dependencies','artifact','goals','tool_suggest','skill_mcp_dependency_install','unbounded_connection_retries'];
const child=spawn(process.argv[2],['app-server','--stdio',...disabled.flatMap(name=>['--disable',name]),'--enable','skip_host_skill_discovery','-c','web_search="disabled"'],{cwd:workspace,env:{...process.env,CODEX_HOME:home},windowsHide:true,stdio:['pipe','pipe','pipe']});
const report={startedAt:new Date().toISOString(),pid:child.pid,events:[],calls:[],status:'running'};
const save=()=>fs.writeFileSync(path.join(root,'artifacts','agent-native-20261022','protocol-probe.json'),JSON.stringify(report,null,2));
save();
const pending=new Map();let serial=0,finish;
const completed=new Promise((resolve,reject)=>{finish={resolve,reject};});
const send=x=>child.stdin.write(JSON.stringify(x)+'\n');
const call=(method,params)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject,method});send({id,method,params});});
child.stderr.resume();
const lines=readline.createInterface({input:child.stdout});
lines.on('line',line=>{
  let event;try{event=JSON.parse(line);}catch{return;}
  if(event.id && pending.has(event.id)){const p=pending.get(event.id);pending.delete(event.id);if(event.error){report.error={method:p.method,code:event.error.code,message:event.error.message};save();p.reject(new Error('RPC failed: '+p.method));}else p.resolve(event.result);return;}
  const name=event.method;if(!name)return;
  if(!report.events.includes(name))report.events.push(name);
  if(name==='item/tool/call'){
    report.calls.push({tool:event.params.tool,arguments:event.params.arguments});
    send({id:event.id,result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify({verified:true,answer:42})}]}});
  }
  if(name==='item/agentMessage/delta' || name==='item/reasoning/summaryTextDelta')report.publicBeforeCompletion=true;
  if(name==='item/completed' && event.params.item.type==='agentMessage'){report.message=event.params.item.text;report.phase=event.params.item.phase;}
  if(name==='turn/completed'){report.turnStatus=event.params.turn.status;finish.resolve();}
  save();
});
const timeout=setTimeout(()=>finish.reject(new Error('probe timeout')),120000);
try{
  await call('initialize',{clientInfo:{name:'hub_protocol_probe',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
  const thread=await call('thread/start',{modelProvider:'openai',cwd:workspace,approvalPolicy:'never',sandbox:'read-only',baseInstructions:'You are testing one scoped tool. Follow the user task. Do not access files or other tools.',dynamicTools:[{type:'function',name:'hub_probe',description:'Return a verified test number.',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}}]});
  report.threadId=thread.thread.id;save();
  const turn=await call('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Say briefly what you will check, call hub_probe, then report the returned number in one short sentence.'}],summary:'auto'});
  if(process.argv.includes('--steer'))await call('turn/steer',{threadId:thread.thread.id,expectedTurnId:turn.turn.id,input:[{type:'text',text:'Additional requirement: start your final sentence with Checked. Continue the original tool task.'}]});
  await completed;
  report.status=report.turnStatus==='completed' && report.calls.length===1?'passed':'failed';
}catch(error){report.status='failed';report.errorSummary=error.message;process.exitCode=1;}
finally{clearTimeout(timeout);child.kill();await new Promise(resolve=>child.once('close',resolve));lines.close();fs.rmSync(auth,{force:true});report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,events:report.events,calls:report.calls.length,error:report.errorSummary}));}
