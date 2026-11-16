const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
let canSave=true,lastSheet='',route=['logs'],timers=[];
const context={structuredClone,TextEncoder,Date,URL,Blob,Set,Map,console,
  document:{addEventListener(){},querySelector(){return null;}},window:{},navigator:{},
  CSS:{escape:v=>v},location:{origin:'https://example.test',pathname:'/',hash:'#logs'},
  history:{state:{}},setTimeout:f=>{timers.push(f);return timers.length;},clearTimeout(){},
  st:{notes:[{id:'note-1',date:'2026-11-15',text:'original\n\n正文',attachments:[],revision:0,syncState:'pending'}],captureDraft:{note:{text:'new draft',date:'2026-11-16',attachments:[]}}},
  docs:{},journalQuery:'',journalTag:'',journalPeriod:'all',journalExpanded:new Set(),attachmentBusy:false,
  route:()=>route,save:()=>canSave,tell(){},render(){},close(){},back(){},go(){},
  localDay:()=> '2026-11-16',recordDay:n=>n.date,recordAttachments:n=>n.attachments||[],capturePhotos:n=>n||[],
  journalTags:t=>[...t.matchAll(/#([^\s#]+)/g)].map(m=>m[1]),journalStatus:n=>n.syncState,
  workflowDraft:()=>context.st.captureDraft.note,
  validJournalDay:d=>/^\d{4}-\d{2}-\d{2}$/.test(d),
  syncPreferences:()=>({enabled:true,quick:true,auto:true,...context.st.deviceSync}),
  esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  ico:()=>'',iconBtn:()=>'',plain:(t,a)=>t+':'+a,btn:(t,a)=>t+':'+a,row:(t,d,i,a)=>t+d+a,group:v=>v,attachmentMarkup:()=>'',hydrateAttachmentImages(){},
  sheet:(title,body)=>{lastSheet=title+body;},section:(t,b)=>t+b,
};
vm.createContext(context);vm.runInContext(fs.readFileSync('dist/journal-studio.js','utf8'),context);
const call=(s)=>vm.runInContext(s,context);
assert(!context.journalMarkup('<img src=x onerror=alert(1)>').includes('<img'));
assert(context.journalMarkup('**加粗**\n- 项目\n#标签',true).includes('<strong>加粗</strong>'));
assert(context.journalMarkup('- 主项\n  - 子项\n- 后项').includes('<li>主项<ul><li>子项'));
const text=v=>({nodeType:3,nodeValue:v});
const element=(tag,children)=>({nodeType:1,tagName:tag,childNodes:children,children:children.filter(c=>c.nodeType===1),style:{}});
assert.equal(context.journalSerialize(element('DIV',[element('DIV',[text('one')]),element('DIV',[element('BR',[])]),element('DIV',[text('two')])])),'one\n\ntwo');
assert.equal(context.journalSerialize(element('DIV',[element('STRONG',[text('bold')]),element('UL',[element('LI',[text('item')])])])),'**bold**- item');
assert.equal(context.journalSerialize(element('DIV',[element('UL',[element('LI',[text('主项'),element('UL',[element('LI',[text('子项')])])]),element('LI',[text('后项')])])])),'- 主项\n  - 子项\n- 后项');
call("journalEditorDraft('note-1').text='updated **bold**'");
canSave=false;assert.equal(context.journalCommitEdit('note-1'),false);
assert.equal(context.journalFind('note-1').text,'original\n\n正文');
assert.equal(call("journalStore().edits['note-1'].text"),'updated **bold**');
canSave=true;assert.equal(context.journalCommitEdit('note-1'),true);
assert.equal(context.st.notes.length,1);assert.equal(context.st.notes[0].id,'note-1');
assert.equal(context.st.notes[0].date,'2026-11-15');
assert.equal(call("journalStore().history['note-1'][0].text"),'original\n\n正文');
context.journalStudioAction('journal-version','note-1~0');assert(lastSheet.includes('恢复此版本'));
context.journalStudioAction('journal-version-restore','note-1~0');
assert.equal(context.journalFind('note-1').text,'original\n\n正文');assert.equal(call("journalStore().history['note-1'].length"),2);
call("journalEditorDraft('note-1').text='unsaved';st.notes[0].text='external change'");
assert.equal(context.journalCommitEdit('note-1'),false);assert.equal(context.journalFind('note-1').text,'external change');
assert.equal(context.st.captureDraft.note.text,'new draft');
call("delete journalStore().edits['note-1']");
context.journalStudioAction('journal-delete-confirm','note-1');assert.equal(context.journalStudioRecords().length,0);
context.journalStudioAction('journal-restore','note-1');assert.equal(context.journalStudioRecords().length,1);
context.journalStudioAction('journal-pin','note-1');assert(call("journalStore().pins.includes('note-1')"));
const form={id:'journal-date-form',dataset:{id:'note-1'},querySelector:()=>({value:'2026-11-13'})};
context.journalStudioSubmit(form);assert.equal(context.journalFind('note-1').date,'2026-11-13');assert.equal(context.st.notes.length,1);
context.journalStudioSubmit({id:'journal-annotation-form',dataset:{id:'note-1'},querySelector:()=>({value:'独立批注'})});
assert.equal(call("journalStore().annotations['note-1'][0].text"),'独立批注');assert.equal(context.journalFind('note-1').text,'external change');
context.st.deviceSync={auto:false};assert.equal(context.journalRunSync(),false);assert.equal(context.st.notes[0].syncState,'pending');
context.st.offline=true;assert.equal(context.journalRunSync(true),false);
context.st.offline=false;context.st.desktopOnline=false;assert(context.journalRunSync(true));assert.equal(context.st.notes[0].syncState,'uploaded');
context.st.desktopOnline=true;assert(context.journalRunSync(true));assert.equal(context.st.notes[0].syncState,'written');
console.log('journal studio: identity, history, conflict, rollback, drafts, date, trash, annotations and sync passed');

let collapsed=true,rendered=0;
const topButton={dataset:{act:'journal-expand:note-1'},classList:{contains:()=>true},setAttribute(){},hidden:true};
const bottomButton={dataset:{act:'journal-expand:note-1'},classList:{contains:()=>false},setAttribute(){},textContent:'展开'};
const copy={classList:{toggle:(name,value)=>{collapsed=value;}}};
const card={dataset:{recordId:'note-1'},getBoundingClientRect:()=>({top:-50}),querySelector:()=>copy,querySelectorAll:()=>[topButton,bottomButton]};
context.document.querySelectorAll=()=>[card];context.window.scrollY=100;context.window.scrollTo=()=>{};context.render=()=>rendered++;
for(let i=0;i<3;i++){
 assert(context.journalStudioAction('journal-expand','note-1'));assert.equal(collapsed,false);assert.equal(topButton.hidden,false);assert.equal(bottomButton.textContent,'收起');
 assert(context.journalStudioAction('journal-expand','note-1'));assert.equal(collapsed,true);assert.equal(topButton.hidden,true);assert.equal(bottomButton.textContent,'展开');
}
assert.equal(rendered,0,'Expanding must not rebuild the feed or reload its media');
console.log('PASS in-place expand/collapse, both controls and no feed rerender');
