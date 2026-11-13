'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
let canSave = true, destination = '', renders = 0, lastSheet = '';
const storage = new Map();
const elements = new Map();
const element = selector => {
  if (!elements.has(selector)) elements.set(selector, { open:false, innerHTML:'', textContent:'', hidden:false, value:'', dataset:{}, style:{setProperty(){}}, classList:{add(){},remove(){},toggle(){}}, addEventListener(){}, focus(){}, querySelector(){return null;}, querySelectorAll(){return[];}, setAttribute(){}, close(){this.open=false;}, showModal(){this.open=true;} });
  return elements.get(selector);
};
const context = {
  crypto, structuredClone, Blob, URL, URLSearchParams, console,
  setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},requestAnimationFrame(){},
  location:{hash:'#search'}, history:{state:{hubDepth:0},replaceState(value){this.state=value;},pushState(value){this.state=value;},back(){}},
  localStorage:{getItem(key){return storage.get(key)||null;},setItem(key,value){if(!canSave)throw new Error('quota');storage.set(key,value);}},
  sessionStorage:{getItem(key){return storage.get(key)||null;},setItem(key,value){storage.set(key,value);}},
  document:{addEventListener(){},querySelector:element,querySelectorAll(){return[];},body:element('body'),documentElement:element('html')},
  navigator:{},window:{scrollY:0,scrollTo(){},addEventListener(){}},innerHeight:844,addEventListener(){},matchMedia(){return{matches:false};},
};
vm.createContext(context);
const run = code => vm.runInContext(code,context);
for(const file of ['mobile.js','mobile-features.js','workflows.js','agents-runtime.js','agents-ui.js','task-tools.js','workspace-tools.js'])run(fs.readFileSync('dist/'+file,'utf8'));
const app=fs.readFileSync('dist/app.js','utf8');
assert.ok(app.includes('initAgents();\nsetupMobile();'));
run(app.slice(0,app.lastIndexOf('initAgents();\nsetupMobile();')));
context.render=()=>renders++;
context.tell=()=>{};
context.go=path=>{destination=path;};
context.sheet=(title,body)=>{lastSheet=title+'\n'+body;};
run('initAgents();');

for(const [q,route] of [['核对本周消费账单','task/t1'],['一周如何留出恢复时间','article/r2'],['线束固定点','agent-chat/ag-seed-harness']]){
  run('query='+JSON.stringify(q));
  assert.ok(context.workspaceMatches().some(item=>item.route===route),q);
  assert.ok(context.searchResults().includes('data-act="go:'+route+'"'));
}
run("query=''; st.notes.push({id:'d3',kind:'note',title:'同 ID 的本地笔记',text:'独立本地正文',date:'2026-11-13',attachments:[]});");
const index=context.workspaceIndex();
assert.ok(index.find(item=>item.key==='doc:d3'&&item.route==='doc/d3'));
assert.ok(index.find(item=>item.key==='note:d3'&&item.route==='note/d3'));
assert.ok(context.docPage('d3',true).includes('独立本地正文'));
assert.ok(!context.docPage('d3').includes('独立本地正文'));
assert.ok(context.docPage('d3',true).includes('star:note/d3'));
assert.ok(context.itemRow('note/d3').includes('同 ID 的本地笔记'));
run("st.stars['note/d3']=true");
assert.ok(context.favoriteRows().includes('go:note/d3'));
context.location.hash='#note/d3';
context.mobileHandleAction('doc-source','d3');
assert.ok(lastSheet.includes('同 ID 的本地笔记'));
assert.ok(!lastSheet.includes('Craft'));
context.mobileHandleAction('copy-doc','note/d3');
assert.ok(lastSheet.includes('独立本地正文'));
context.location.hash='#search';

run("st.taskEdits.t1={t:'核对更新后的测试账单',note:'新说明'};query='更新后的测试账单';");
assert.equal(context.workspaceMatches()[0].title,'核对更新后的测试账单');
run("query='';st.workspaceSearch={scope:['reading-telegram'],sort:'相关优先'}");
assert.deepEqual(Array.from(context.workspaceMatches(),item=>item.key),['reading:r2']);
run("st.workspaceSearch.scope=[]");
assert.equal(context.workspaceMatches().length,0);
assert.ok(context.searchResults().includes('清除搜索与筛选'));
canSave=false;
context.workspaceClearSearch(true);
assert.equal(context.workspaceMatches().length,0,'failed reset rolls back saved scope');
canSave=true;
context.workspaceClearSearch(true);
assert.ok(context.workspaceMatches().length>10);
run("searchType='对话'");
assert.ok(context.workspaceMatches().every(item=>item.type==='对话'));
run("searchType='全部类型'; searchDate='11 月'");
assert.equal(context.workspaceDateMatches({date:'2025-11-13'}),false);
assert.equal(context.workspaceDateMatches({date:'2026-11-13'}),true);
assert.equal(context.workspaceDateMatches({date:''}),false);
run("searchDate='不限日期';");

// A reading note has its own draft, not the flomo-style global capture draft.
run("st.captureDraft={note:{text:'不要覆盖的速记',attachments:[{id:'keep-file',name:'kept.pdf'}]}};st.draft='不要覆盖的速记';");
const capture=run('JSON.stringify(st.captureDraft)');
context.workspaceNoteSheet('reading','r2');
assert.ok(lastSheet.includes('不会覆盖'));
const noteFields={'#workspace-note-text':{value:'为恢复时间留出一个小空白'},'#workspace-note-quote':{value:'计划和实际分开看'},'.capture-error':{textContent:''}};
const noteForm={id:'workspace-note-form',dataset:{kind:'reading',id:'r2'},querySelector(selector){return noteFields[selector];}};
const countBefore=run('st.notes.length');
canSave=false;
context.workspaceSubmit(noteForm);
assert.equal(run('st.notes.length'),countBefore);
assert.ok(run("st.contextNotes['reading:r2'].text").includes('小空白'));
assert.ok(noteFields['.capture-error'].textContent.includes('尚未保存'));
assert.equal(run('JSON.stringify(st.captureDraft)'),capture);
canSave=true;
context.workspaceSubmit(noteForm);
assert.equal(run('st.notes.length'),countBefore+1);
assert.ok(destination.startsWith('note/n-'));
assert.equal(run('st.notes[0].origin.route'),'article/r2');
assert.equal(run('JSON.stringify(st.captureDraft)'),capture);
assert.ok(context.workspaceOriginMarkup(run('st.notes[0].origin')).includes('go:article/r2'));

let createdContext;
context.taskToolsOpenEditor=value=>{createdContext=value;};
context.workspaceAction('workspace-task','reading','r2');
assert.equal(createdContext.title,'一周如何留出恢复时间');
assert.equal(createdContext.route,'article/r2');
context.workspaceAction('workspace-task','note','d3');
assert.equal(createdContext.route,'note/d3');
const thread=run('st.agents.threads[0]');
context.workspaceTaskFromAgent(thread.id,thread.messages[1].id);
assert.equal(createdContext.title,thread.title);
assert.equal(createdContext.route,'agent-chat/'+thread.id);

// Navigation, typed route ownership, and old source compatibility remain explicit.
assert.equal(run('navs.length'),5);
assert.equal(run("tabFor('agent-chat')"),'agents');
assert.equal(run("tabFor('insights')"),'browse');
assert.equal(run("tabFor('card')"),'review');
assert.ok(context.content('note','d3').includes('独立本地正文'));
assert.ok(context.article('r2').includes('workspace-task:reading:r2'));
assert.ok(context.mobileBrowsePage().includes('go:insights'));
assert.ok(context.workspaceConnectionsPage().includes('两条独立通道'));
assert.ok(!fs.readFileSync('dist/agents-ui.js','utf8').match(/close\(\);\s*go\(/),'sheet navigation must not race history.back');
assert.ok(renders>0);
console.log('PASS: typed cross-module search, edited tasks, multi-scope filters and rollback, date semantics, safe reading-note drafts and origin, source task/Agent handoff, five-tab routes');
