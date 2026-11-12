const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;

let canSave = true, destination = '', renders = 0;
const context = {
  crypto, structuredClone, Blob, URL, setTimeout,
  document: { addEventListener() {}, querySelector() { return null; } },
  st: { notes: [], captureDraft: { note: { text: '', date: '2026-11-10', attachments: [] }, task: { title: 'keep task' }, link: { url: 'https://example.com' } }, reviewed: [], grades: {}, customCards: [], draft: '' },
  cards: [{id:'c1',deck:'test',q:'question',a:'answer',doc:'d1'}],
  docs: { d1: { date:'11 月 7 日', body:'sample', tag:'topic' }, d2:{}, d3:{}, d5:{}, d6:{}, d8:{} },
  labels: ['topic'],
  tagQuery: '', match: (value,query) => value.toLowerCase().includes(query.toLowerCase()),
  save: () => canSave,
  render: () => renders++, tell() {}, go: path => { destination = path; },
  close() {},
  esc: value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
  ico: () => '', iconBtn: () => '', plain: (label,action) => `${label}:${action}`,
  row: (title,detail,icon,action) => `${title}:${detail}:${action}`,
  group: value => value,
  sourceRow: id => id,
};
vm.createContext(context);
for (const file of ['dist/mobile-features.js','dist/workflows.js']) vm.runInContext(fs.readFileSync(file,'utf8'),context);

assert.equal(context.validJournalDay('2026-02-29'),false);
assert.equal(context.validJournalDay('2024-02-29'),true);
assert.equal(context.validJournalDay('2026-11-31'),false);
assert.equal(context.recordDay({date:'2026/11/7',createdAt:Date.now()}),'2026-11-07');
assert.equal(context.recordDay({journalDate:'2025-12-31',createdAt:Date.now()}),'2025-12-31');
assert.deepEqual(Array.from(context.journalTags('#日常 #123 #日常 #项目/想法')),['日常','123','项目/想法']);
assert.equal(context.labelFromRoute('tag-123'),'123');
assert.equal(context.labelFromRoute('0'),'topic');
assert.equal(context.labelFromRoute('tag-%broken'),'');
assert.equal(context.labelFromRoute(undefined),'');
assert.ok(context.captureNoteBody('intro\n- item').includes('<ul>'));
assert.ok(!context.captureNoteBody('<script>bad</script>').includes('<script>'));

const field = { value:'test #123', setAttribute() {}, focus() {} };
const date = { value:'2026-11-10',setAttribute() {},focus() {} };
const error = {textContent:''};
const form = { id:'quick-capture-form',dataset:{kind:'note'},querySelector(selector) {
  return selector==='#quick-text'?field:selector==='#quick-date'?date:selector==='.capture-error'?error:null;
}};
context.st.captureDraft.note.attachments=[{id:'file-1',name:'plan.txt',size:20,type:'text/plain',image:false}];
const legacy=JSON.stringify(context.st.captureDraft.link), task=JSON.stringify(context.st.captureDraft.task);
canSave=false;
context.handleWorkflowSubmit(form);
assert.equal(context.st.notes.length,0);
assert.equal(context.st.captureDraft.note.attachments.length,1);
assert.equal(context.st.captureDraft.note.text,field.value);
assert.equal(destination,'');
assert.ok(error.textContent);
canSave=true;
context.handleWorkflowSubmit(form);
assert.equal(destination,'logs');
assert.equal(context.st.notes.length,1);
assert.equal(context.st.notes[0].date,'2026-11-10');
assert.equal(context.st.notes[0].attachments[0].id,'file-1');
assert.equal(JSON.stringify(context.st.captureDraft.link),legacy);
assert.equal(JSON.stringify(context.st.captureDraft.task),task);
assert.ok(context.mobileTagRows().includes('label/tag-123'));
assert.ok(context.mobileTagItems('123').includes('go:doc/'));

context.st.deviceSync={enabled:true,quick:true};
context.st.offline=true;
context.syncJournalDemo();
assert.equal(context.st.notes[0].syncState,'pending');
context.st.offline=false;
context.st.syncError=true;
context.syncJournalDemo();
assert.equal(context.st.notes[0].syncState,'error');
context.st.syncError=false;
context.st.desktopOnline=false;
context.syncJournalDemo();
assert.equal(context.st.notes[0].syncState,'uploaded');
context.syncJournalDemo();
assert.equal(context.st.notes[0].syncState,'uploaded');
context.st.desktopOnline=true;
canSave=false;
context.syncJournalDemo();
assert.equal(context.st.notes[0].syncState,'uploaded');
canSave=true;
context.syncJournalDemo();
assert.equal(context.st.notes[0].syncState,'written');
context.syncJournalDemo();
assert.equal(context.st.notes.length,1);

context.mobileFeatureAction('accept-card','demo-card-inbox-1');
context.mobileFeatureAction('accept-card','demo-card-inbox-1');
assert.equal(context.st.customCards.length,1);
canSave=false;
context.mobileFeatureAction('dismiss-card','demo-card-inbox-2');
assert.equal(context.st.inboxStatus['demo-card-inbox-2'],undefined);
canSave=true;
context.mobileFeatureAction('dismiss-card','demo-card-inbox-2');
context.mobileFeatureAction('restore-inbox');
assert.equal(context.st.inboxStatus['demo-card-inbox-2'],undefined);
assert.ok(renders>0);
async function backupChecks() {
  const data={kind:'hub-mobile-review-demo',version:1,customCards:[{id:'demo-card-extra',q:'question',a:'answer',deck:'test',doc:'d1'}],reviewed:['c1'],grades:{c1:'记得'}};
  const input=payload=>({files:[{size:100,text:async()=>JSON.stringify(payload)}],value:'file'});
  const before=JSON.stringify(context.st);
  await context.restoreReviewBackup(input({...data,version:99}));
  assert.equal(JSON.stringify(context.st),before);
  await context.restoreReviewBackup(input({...data,customCards:[data.customCards[0],data.customCards[0]]}));
  assert.equal(JSON.stringify(context.st),before);
  await context.restoreReviewBackup(input(data));
  await context.restoreReviewBackup(input(data));
  assert.equal(context.st.customCards.filter(c=>c.id==='demo-card-extra').length,1);
  assert.ok(context.st.reviewed.includes('c1'));
  canSave=false;
  const retained=JSON.stringify(context.st);
  await context.restoreReviewBackup(input({...data,reviewed:[],grades:{c1:'困难'}}));
  assert.equal(JSON.stringify(context.st),retained);
  console.log('PASS: date identity, legacy drafts, capture rollback, tag routing, staged sync/retry/rollback, inbox deduplication/recovery, backup validation/merge/rollback');
}
backupChecks().catch(error=>{console.error(error);process.exitCode=1;});
