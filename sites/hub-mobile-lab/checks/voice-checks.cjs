const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
let now=10000,canSave=true;
const c={console,Blob,URL,structuredClone,crypto:require('node:crypto').webcrypto,
 Date:{now:()=>now},setInterval:()=>1,clearInterval(){},
 st:{notes:[],captureDraft:{note:{text:'已有文字',attachments:[],photos:[]}}},
 document:{addEventListener(){},querySelector(){return null;}},window:{addEventListener(){}},navigator:{},
 localDay:()=> '2026-11-16',save:()=>canSave,tell(){},sheet(){},esc:String,btn:()=>'',plain:()=>'',
 workflowDraft:()=>c.st.captureDraft.note,recordAttachments:n=>n.attachments||[],capturePhotos:a=>a||[],
 journalFind:id=>c.st.notes.find(n=>n.id===id),journalStudioRecords:()=>c.st.notes,
 journalRichForm:()=>null,journalDraftFor:()=>c.st.captureDraft.note,
 journalStore:()=>({}),journalEditorDraft:()=>null,quickCapture(){},close(){},render(){},
 journalTransaction(fn){const old=structuredClone(c.st);fn();if(canSave)return true;c.st=old;return false;},
 attachmentTransaction:async()=>{},
};
vm.createContext(c);vm.runInContext(fs.readFileSync('dist/voice.js','utf8'),c);
const run=s=>vm.runInContext(s,c);
(async()=>{
 assert.equal(c.voiceTime(125000),'02:05');
 run("st.voiceDraft=voiceNew();st.voiceDraft.provider='openai'");
 const id=c.st.voiceDraft.id;
 await c.voiceStart('demo');now+=6200;c.voiceTick();
 assert.equal(c.st.voiceDraft.segments.length,1);assert(c.st.voiceDraft.partial.length>0);
 c.voicePause();const elapsed=c.st.voiceDraft.elapsed;now+=5000;c.voiceTick();assert.equal(c.st.voiceDraft.elapsed,elapsed);
 c.voicePause();now+=1000;c.voiceTick();assert.equal(c.st.voiceDraft.id,id);assert(c.st.voiceDraft.elapsed<10000);
 c.voiceAction('voice-fail','断网');const old=JSON.stringify(c.st.voiceDraft.segments);now+=6000;c.voiceTick();assert.equal(JSON.stringify(c.st.voiceDraft.segments),old);
 await c.voiceFinish();assert.equal(c.st.voiceDraft.state,'review');assert(c.st.voiceDraft.failure);
 c.st.voiceDraft.edited='我的校对稿';c.st.voiceDraft.editedByUser=true;c.voiceRetry(c.st.voiceDraft);
 assert.equal(c.st.voiceDraft.edited,'我的校对稿');assert.equal(c.st.voiceDraft.segments.length,3);assert.equal(c.st.voiceDraft.id,id);
 canSave=false;await c.voiceAttach();assert.equal(c.st.captureDraft.note.text,'已有文字');assert.equal(c.st.voiceDraft.id,id);
 canSave=true;await c.voiceAttach();assert.equal(c.st.captureDraft.note.text,'已有文字\n\n我的校对稿');assert.equal(c.st.captureDraft.note.attachments.length,1);assert(!c.st.voiceDraft);
 const attachment=c.st.captureDraft.note.attachments[0];assert.equal(attachment.voice.provider,'openai');
 c.st.notes=[{id:'note-1',text:'人工改过的正文',attachments:[attachment]}];c.voiceOpen(id);
 c.st.voiceDraft.edited='后来补充的校对稿';c.st.voiceDraft.editedByUser=true;await c.voiceAttach();
 assert.equal(c.st.notes.length,1);assert.equal(c.st.notes[0].text,'人工改过的正文');assert.equal(c.st.notes[0].attachments[0].voice.edited,'后来补充的校对稿');
 let closed=0,rendered=0,committed=0,shown=0,destination='';
 c.close=()=>closed++;c.render=()=>rendered++;c.sheet=()=>shown++;c.go=path=>destination=path;
 const targetDraft={text:'原记录正文',attachments:[],photos:[]};
 c.journalEditorDraft=()=>targetDraft;c.journalCommitEdit=target=>{assert.equal(target,'note-1');committed++;return true;};
 run("st.voiceDraft=voiceNew('note-1')");c.st.voiceDraft.state='review';c.st.voiceDraft.mode='demo';
 c.st.voiceDraft.edited='追加内容';c.st.voiceDraft.editedByUser=true;
 await c.voiceAttach();
 assert.equal(committed,1);assert.equal(closed,1);assert.equal(rendered,1);assert.equal(shown,0,'Saving an appended recording must not reopen the recorder');
 assert(!c.st.voiceDraft,'Saving must not create another voice draft');assert.equal(targetDraft.text,'原记录正文\n\n追加内容');
 c.journalCommitEdit=()=>false;
 run("st.voiceDraft=voiceNew('note-1')");c.st.voiceDraft.state='review';c.st.voiceDraft.mode='demo';
 await c.voiceAttach();assert.equal(destination,'journal-edit/note-1');assert.equal(shown,0);assert(!c.st.voiceDraft);
 assert.equal(targetDraft.attachments.length,2,'Uncommitted append remains in the original editor draft');
 run('st.voiceDraft=voiceNew()');c.st.voiceDraft.state='review';c.st.voiceDraft.mode='real';await c.voiceAttach();assert(c.st.voiceDraft,'Cannot claim missing original audio saved');
 let microphoneStopped=false,savedBlob=null;
 c.navigator.mediaDevices={getUserMedia:async()=>({getTracks:()=>[{stop:()=>microphoneStopped=true}],getAudioTracks:()=>[{}]})};
 c.MediaRecorder=class {constructor(){this.state='inactive';this.mimeType='audio/webm';}start(){this.state='recording';}pause(){this.state='paused';}resume(){this.state='recording';}stop(){this.state='inactive';this.ondataavailable({data:new Blob(['unit-test-audio'],{type:this.mimeType})});this.onstop();}};
 c.attachmentTransaction=async(mode,fn)=>fn({put:blob=>{savedBlob=blob;},get:()=>savedBlob});
 run('st.voiceDraft=voiceNew()');await c.voiceStart('real');now+=1200;c.voicePause();c.voicePause();await c.voiceFinish();await new Promise(resolve=>setImmediate(resolve));
 assert(microphoneStopped);assert(savedBlob.size>0);assert.equal(c.st.voiceDraft.audioSaved,true);assert.equal(c.st.voiceDraft.segments.length,0,'No invented transcript for a real recording');
 assert.equal(c.st.voiceDraft.state,'review');await c.voiceAttach();assert(!c.st.voiceDraft);assert(c.st.captureDraft.note.attachments.some(a=>a.voice.mode==='real'&&a.voice.audioSaved));
 console.log('PASS voice: timer, pause/resume identity, failure retention, retry/edit protection, draft merge, save rollback, same-note update, missing-audio guard');
 console.log('PASS recorder lifecycle mock: final data before storage, microphone release, real audio has no simulated transcript');
})().catch(e=>{console.error(e);process.exitCode=1;});
