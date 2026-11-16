const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
let canSave=true;
const c={Date,Set,Map,structuredClone,TextEncoder,console,document:{addEventListener(){}},window:{},navigator:{},
 st:{notes:[{id:'a',date:'2026-11-15',text:'alpha #work',attachments:[{name:'p.png',image:true}],modifiedAt:3},{id:'b',date:'2026-11-16',text:'https://example.com',attachments:[],modifiedAt:1}]},docs:{},
 localDay:()=> '2026-11-16',recordDay:n=>n.date,recordAttachments:n=>n.attachments||[],capturePhotos:n=>n||[],journalTags:t=>[...t.matchAll(/#([^\s#]+)/g)].map(m=>m[1]),
 save:()=>canSave,route:()=>['logs'],journalQuery:'',journalTag:'',journalPeriod:'all',setTimeout(){},clearTimeout(){}};
vm.createContext(c);for(const file of ['journal-studio','journal-feed-tools'])vm.runInContext(fs.readFileSync('dist/'+file+'.js','utf8'),c);
const run=s=>vm.runInContext(s,c);
run("journalStore().pins=[];journalStore().sort='date-asc'");assert.equal(c.journalStudioRecords()[0].id,'a');
run("journalStore().sort='edit-asc'");assert.equal(c.journalStudioRecords()[0].id,'b');
run("journalStore().pins=['a']");assert.equal(c.journalStudioRecords()[0].id,'a');
run("journalAdvanced.more=['images','links']");assert.equal(c.journalAdvancedMatches(c.st.notes[0]),false);
run("journalAdvanced.more=['images']");assert.equal(c.journalAdvancedMatches(c.st.notes[0]),true);
run("journalAdvanced.more=[];journalAdvanced.period='week'");assert.equal(c.journalAdvancedMatches(c.st.notes[0]),false);assert.equal(c.journalAdvancedMatches(c.st.notes[1]),true);
run("journalAdvanced.period='all';journalAdvanced.tagMode='exclude';journalAdvanced.tags=['work']");assert.equal(c.journalAdvancedMatches(c.st.notes[0]),false);
run("journalPicked=new Set(['a'])");assert(c.journalBatchUpdate('tag','#work #new'));assert.equal(c.st.notes[0].text,'alpha #work\n#new');assert.equal(c.st.notes[1].text,'https://example.com');
const previous=c.st.notes[0].text;canSave=false;assert.equal(c.journalBatchUpdate('tag','#unsaved'),false);assert.equal(c.st.notes[0].text,previous);
canSave=true;assert(c.journalBatchUpdate('tag','plain second'));assert.equal(c.st.notes[0].text,previous+'\n#plain #second');
canSave=true;assert(c.journalBatchUpdate('delete'));assert(run("!!journalStore().trash.a"));assert.equal(run("!!journalStore().trash.b"),false);
assert.equal(c.st.notes[0].id,'a');assert.equal(run("journalStore().history.a.length"),2);
console.log('journal feed sorting, combined filters, selected-only edits and failed-save rollback passed');
