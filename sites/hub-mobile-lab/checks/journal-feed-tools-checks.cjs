const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
let canSave=true,currentRoute='logs';
const listeners=new Map();
const c={Date,Set,Map,structuredClone,TextEncoder,console,document:{addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},querySelector(){return null;}},window:{},navigator:{},
 st:{notes:[{id:'a',date:'2026-11-15',text:'alpha #work',attachments:[{name:'p.png',image:true}],modifiedAt:3},{id:'b',date:'2026-11-16',text:'https://example.com',attachments:[],modifiedAt:1}]},docs:{},
 localDay:()=> '2026-11-16',recordDay:n=>n.date,recordAttachments:n=>n.attachments||[],capturePhotos:n=>n||[],journalTags:t=>[...t.matchAll(/#([^\s#]+)/g)].map(m=>m[1]),
 save:()=>canSave,route:()=>[currentRoute],go:to=>{currentRoute=to;},requestAnimationFrame:fn=>fn(),hydrateAttachmentImages(){},journalQuery:'',journalTag:'',journalPeriod:'all',setTimeout(){},clearTimeout(){}};
vm.createContext(c);for(const file of ['journal-studio','journal-feed-tools'])vm.runInContext(fs.readFileSync('dist/'+file+'.js','utf8'),c);
const run=s=>vm.runInContext(s,c);
run("journalStore().pins=[];journalStore().sort='date-asc'");assert.equal(c.journalStudioRecords()[0].id,'a');
run("journalStore().sort='edit-asc'");assert.equal(c.journalStudioRecords()[0].id,'b');
run("journalStore().pins=['a']");assert.equal(c.journalStudioRecords()[0].id,'a');
run("journalAdvanced.more=['images','links']");assert.equal(c.journalAdvancedMatches(c.st.notes[0]),false);
run("journalAdvanced.more=['images']");assert.equal(c.journalAdvancedMatches(c.st.notes[0]),true);
run("journalAdvanced.more=[];journalAdvanced.period='week'");assert.equal(c.journalAdvancedMatches(c.st.notes[0]),false);assert.equal(c.journalAdvancedMatches(c.st.notes[1]),true);
run("journalAdvanced.period='all';journalAdvanced.tagMode='exclude';journalAdvanced.tags=['work']");assert.equal(c.journalAdvancedMatches(c.st.notes[0]),false);

// Search owns its query and keeps the journal's entry scope until it is reopened.
const beforeSearch=structuredClone(c.st);
run("journalStore().filter='all';journalTag='work';journalPeriod='all';journalQuery='alpha'");
const entryIds=Array.from(c.journalFiltered(),n=>n.id);
assert(c.journalFeedToolsAction('journal-search'));assert.equal(currentRoute,'journal-search');
for(const fn of listeners.get('input')||[])fn({target:{id:'journal-detail-query',value:'unrelated search'},isComposing:false});
assert.equal(run('journalSearchQuery'),'unrelated search');assert.equal(c.journalQuery,'alpha');
assert.deepEqual(Array.from(c.journalFiltered(),n=>n.id),entryIds);
assert.deepEqual(Array.from(c.journalSearchCandidates(),n=>n.id),['a']);
run("journalStore().filter='untagged';journalTag='';journalQuery=''");
assert.deepEqual(Array.from(c.journalSearchCandidates(),n=>n.id),['a'],'changing the journal after entering search does not widen its captured scope');

// Clearing text must retain a date, tag, or attachment condition.
for(const condition of ["journalAdvanced.period='month'","journalAdvanced.tagMode='untagged'","journalAdvanced.more=['images']"]){
  run("journalAdvanced={period:'all',start:'',end:'',tagMode:'all',tags:[],more:[]};journalSearchQuery='typed';journalSearched=true");
  run(condition);assert(c.journalFeedToolsAction('journal-search-clear'));
  assert.equal(run('journalSearchQuery'),'');assert(c.journalSearchHasConditions());
}
run("journalAdvanced={period:'all',start:'',end:'',tagMode:'all',tags:[],more:[]};journalSearched=false");
assert.equal(c.journalSearchHasConditions(),false);

// A scope change is atomic: failure preserves every prior criterion.
run("journalStore().filter='pinned';journalStore().searchOpen=true;journalTag='work';journalPeriod='today';journalQuery='alpha'");
canSave=false;assert.equal(c.journalSetScope('all'),false);
assert.equal(run('journalStore().filter'),'pinned');assert.equal(run('journalStore().searchOpen'),true);
assert.equal(c.journalTag,'work');assert.equal(c.journalPeriod,'today');assert.equal(c.journalQuery,'alpha');
canSave=true;assert(c.journalSetScope('all'));
assert.equal(run('journalStore().filter'),'all');assert.equal(run('journalStore().searchOpen'),false);
assert.equal(c.journalTag,'');assert.equal(c.journalPeriod,'all');assert.equal(c.journalQuery,'');
assert.deepEqual(Array.from(c.journalFiltered(),n=>n.id).sort(),['a','b']);

// Search candidates stay within the selected range, including the recycle bin.
assert(c.journalSetScope('pinned'));c.journalFeedToolsAction('journal-search');
assert.deepEqual(Array.from(c.journalSearchCandidates(),n=>n.id),['a']);
assert(c.journalSetScope('today'));c.journalFeedToolsAction('journal-search');
assert.deepEqual(Array.from(c.journalSearchCandidates(),n=>n.id),['b']);
run("journalStore().trash.a={at:1}");
assert(c.journalSetScope('all'));c.journalFeedToolsAction('journal-search');
assert.deepEqual(Array.from(c.journalSearchCandidates(),n=>n.id),['b']);
assert(c.journalSetScope('trash'));c.journalFeedToolsAction('journal-search');
assert.deepEqual(Array.from(c.journalSearchCandidates(),n=>n.id),['a']);
assert.equal(c.journalSetScope('invalid-scope'),false);assert.equal(run('journalStore().filter'),'trash');
c.st=beforeSearch;currentRoute='logs';
run("journalQuery='';journalTag='';journalPeriod='all';journalSearchQuery='';journalSearchScope=null;journalSearched=false");

run("journalPicked=new Set(['a'])");assert(c.journalBatchUpdate('tag','#work #new'));assert.equal(c.st.notes[0].text,'alpha #work\n#new');assert.equal(c.st.notes[1].text,'https://example.com');
const previous=c.st.notes[0].text;canSave=false;assert.equal(c.journalBatchUpdate('tag','#unsaved'),false);assert.equal(c.st.notes[0].text,previous);
canSave=true;assert(c.journalBatchUpdate('tag','plain second'));assert.equal(c.st.notes[0].text,previous+'\n#plain #second');
canSave=true;assert(c.journalBatchUpdate('delete'));assert(run("!!journalStore().trash.a"));assert.equal(run("!!journalStore().trash.b"),false);
assert.equal(c.st.notes[0].id,'a');assert.equal(run("journalStore().history.a.length"),2);
console.log('journal feed sorting, combined filters, isolated search, captured ranges, atomic scope changes, selected-only edits and failed-save rollback passed');
