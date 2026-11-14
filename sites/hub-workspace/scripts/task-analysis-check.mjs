import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../app/task-analysis-model.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {buildTaskAdvice,analysisRevision,adoptionError,applyLocalAdvice,parseAnalysisMemory,emptyAnalysisMemory}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const day='2026-11-14';
const tasks=[
 {id:'one',title:'核对接口',description:'确认责任方',source:'滴答清单',project:'工程',parent:'',date:day,status:'doing',priority:'高'},
 {id:'two',title:'等待补充',description:'等待供应商回复',source:'滴答清单',project:'工程',parent:'one',date:'',status:'waiting'},
 {id:'three',title:'整理记录',description:'保存依据',source:'Obsidian',project:'工程',parent:'',date:'',status:'todo'},
 {id:'done',title:'已完成',description:'旧记录',source:'滴答清单',project:'工程',parent:'',date:day,status:'done'},
 {id:'other',title:'别的项目',description:'',source:'Craft',project:'生活',parent:'',date:'',status:'todo'},
];
const evidence={one:[{id:'f',title:'接口定义',source:'飞书',text:'核对针脚'},{id:'c',title:'评审依据',source:'Craft',text:'确认版本'}]};
const request=(mode='task',ids=['one'])=>({id:1,mode,label:'所选范围',taskIds:ids});
test('the existing aggregate is read without changing or creating tasks',()=>{
 const before=structuredClone(tasks);
 for(const mode of ['today','project','task'])buildTaskAdvice(tasks,request(mode,tasks.map(t=>t.id)),evidence,'fresh',day);
 assert.deepEqual(tasks,before);
});
test('scope uses exact original IDs across same-named projects and excludes done tasks',()=>{
 const result=buildTaskAdvice(tasks,request('project',['one','two','done']),evidence,'fresh',day);
 assert.deepEqual(new Set(result.map(a=>a.taskId)),new Set(['one','two']));
 assert.ok(result.every(a=>a.kind==='note'));
});
test('partial reads do not cite missing Feishu materials',()=>{
 const result=buildTaskAdvice(tasks,request(),evidence,'partial',day)[0];
 assert.deepEqual(result.evidence.map(r=>r.id),['c']);
 assert.ok(!result.text.includes('接口定义'));
});
test('today plan references original tasks and adoption is idempotent',()=>{
 const a=buildTaskAdvice(tasks,request('today',tasks.map(t=>t.id)),evidence,'fresh',day).find(a=>a.taskId==='one');
 const memory=applyLocalAdvice(emptyAnalysisMemory(),a,day,'now');
 assert.deepEqual(memory.today,{one:day});assert.equal(memory.receipts.length,1);
 assert.equal(applyLocalAdvice(memory,a,day,'later'),memory);
 assert.deepEqual(tasks[0].date,day);
});
test('waiting tasks stay notes and Obsidian is not offered a simulated source edit',()=>{
 for(const id of ['two','three']){
  const a=buildTaskAdvice(tasks,request('task',[id]),evidence,'fresh',day)[0];
  assert.equal(a.kind,'note');
 }
 assert.equal(tasks[1].status,'waiting');
 const local=buildTaskAdvice(tasks,request('today',['three']),evidence,'fresh',day)[0];assert.equal(local.kind,'today');
});
test('source edits retain original content and require a current revision',()=>{
 const a=buildTaskAdvice(tasks,request(),evidence,'fresh',day)[0];
 assert.equal(a.kind,'source');assert.ok(a.text.startsWith(tasks[0].description));
 assert.equal(adoptionError(tasks[0],a,'fresh'),'');
 for(const change of [{date:'2026-11-15'},{status:'done'},{description:'用户的新说明'},{source:'Craft'}])assert.match(adoptionError({...tasks[0],...change},a,'fresh'),/变化/);
 assert.match(adoptionError(undefined,a,'fresh'),/不在/);
 const written={...tasks[0],description:a.text};assert.equal(buildTaskAdvice([written],request(),evidence,'fresh',day)[0].text,a.text);
});
test('old caches cannot authorize source changes',()=>{
 const a=buildTaskAdvice(tasks,request(),evidence,'cached',day)[0];
 assert.match(adoptionError(tasks[0],a,'cached'),/旧数据/);
 const local=buildTaskAdvice(tasks,request('today'),evidence,'cached',day)[0];
 assert.equal(adoptionError(tasks[0],local,'cached'),'');
});
test('local notes and source receipts never change completion or copy task data',()=>{
 const note=buildTaskAdvice(tasks,request('project'),evidence,'fresh',day)[0];
 const memory=applyLocalAdvice(emptyAnalysisMemory(),note,day,'now');
 assert.equal(memory.notes.one,note.text);assert.deepEqual(Object.keys(memory.today),[]);
 assert.equal(tasks[0].status,'doing');assert.equal(tasks.length,5);
 assert.ok(analysisRevision(tasks[0]).includes('one'));
});
test('memory round trips and malformed records are rejected without overwriting the raw archive',()=>{
 assert.deepEqual(parseAnalysisMemory(null),emptyAnalysisMemory());
 assert.equal(parseAnalysisMemory('{bad'),null);
 assert.equal(parseAnalysisMemory(JSON.stringify({today:[],notes:{},receipts:[]})),null);
 assert.equal(parseAnalysisMemory(JSON.stringify({today:{one:123},notes:{},receipts:[]})),null);
 assert.deepEqual(parseAnalysisMemory(JSON.stringify(emptyAnalysisMemory())),emptyAnalysisMemory());
});
test('task and project launchers remain inside the existing task module',()=>{
 const app=readFileSync(new URL('../app/TaskWorkspace.tsx',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../app/TaskAnalysis.tsx',import.meta.url),'utf8');
 assert.match(app,/beginAnalysis\('task',t\)/);assert.match(app,/beginAnalysis\('project',undefined,c.key\)/);
 assert.match(app,/analysis\?<TaskAnalysis/);assert.doesNotMatch(app+ui,/hub-task-flow-lab|window\.open|location\.href\s*=/);
 assert.doesNotMatch(source+ui,/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
});
