'use strict';

// Browser prototype only; Android uses the authenticated VPS adapters. No keys belong in this Site.
const voiceProviders = { aliyun: ['阿里实时识别', 'paraformer-realtime-v2'], openai: ['OpenAI', 'gpt-live-transcribe'] };
const voiceExample = ['先把今天的想法记下来。', '这次先完成录音原型，再核对暂停、回听和文字校对。', '即使转写中断，也要保留原音，稍后补转到同一条记录。'];
let voiceRecorder = null, voiceStream = null, voiceChunks = [], voiceTimer = null, voiceStarted = 0, voiceBlob = null, voiceBusy = false;
function voiceMic() { return '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>'; }
function voiceTime(ms) { const s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }
function voiceElapsed(v) { return v.elapsed+(v.state==='recording'?Date.now()-voiceStarted:0); }
function voiceText(v) { return (v.segments||[]).join('\n'); }
function voiceNew(target = '') { return {id:'voice-'+crypto.randomUUID(),target,provider:st.voiceProvider||'aliyun',state:'ready',mode:'demo',elapsed:0,segments:[],partial:'',failure:'',edited:'',editedByUser:false,date:localDay()}; }
function voicePersist() { const ok=save()!==false;if(!ok)voiceNotice('浏览器存储未成功，请保留页面并重试。');return ok; }
function voiceNotice(message) { const el=document.querySelector('#voice-notice');if(el)el.textContent=message;else tell(message); }
function voiceOpen(id) {
  if(id){
    const form=journalRichForm(),draft=form&&journalDraftFor(form);
    const draftAttachment=draft&&recordAttachments(draft).find(a=>a.id===id);
    const n=journalStudioRecords(true).find(n=>recordAttachments(n).some(a=>a.id===id));
    const a=draftAttachment||(n&&recordAttachments(n).find(a=>a.id===id));
    if(!a?.voice)return;
    if(st.voiceDraft&&st.voiceDraft.state==='ready'&&!st.voiceDraft.elapsed&&!voiceText(st.voiceDraft)&&!st.voiceDraft.edited){st.voiceDraft=null;}
    if(st.voiceDraft&&st.voiceDraft.id!==id){tell('请先完成当前语音草稿，再打开其他录音。');return;}
    voiceBlob=null;
    st.voiceDraft={...structuredClone(a.voice),id,target:draftAttachment?(form.dataset.editId||''):n.id,state:'review',attached:true,inDraft:Boolean(draftAttachment)};
  }else if(!st.voiceDraft){
    const f=journalRichForm();if(f&&!journalPersistEditor(f))return;
    st.voiceDraft=voiceNew(f?.dataset.editId||'');
  }
  const v=st.voiceDraft;
  if(['recording','paused','requesting','saving'].includes(v.state)&&!voiceRecorder&&!voiceTimer){v.state='review';v.failure='上次流程中断；文字已保留，未完成录音可能缺失。';}
  voicePersist();voiceShow();
}
function voiceShow() {
  const v=st.voiceDraft;if(!v)return;
  const active=['recording','paused'].includes(v.state),ready=v.state==='ready',review=v.state==='review';
  sheet('语音速记','<section class="voice-panel" aria-label="语音速记"><p class="voice-context">'+(v.mode==='real'&&!ready?'本机录音 · 转写服务尚未接入':'交互演示 · 文字为预设示例')+'</p>'+
    '<label class="voice-provider">转写服务<select id="voice-provider" '+(!ready?'disabled':'')+'>'+Object.entries(voiceProviders).map(([k,p])=>'<option value="'+k+'" '+(v.provider===k?'selected':'')+'>'+p[0]+'</option>').join('')+'</select></label><p class="fine voice-model">'+voiceProviders[v.provider][1]+' · 每次只选一家</p>'+
    '<div class="voice-clock"><span class="voice-indicator '+(v.state==='recording'?'is-recording':'')+'">'+voiceMic()+'</span><strong id="voice-time">'+voiceTime(voiceElapsed(v))+'</strong><span id="voice-state">'+({ready:'准备好就开始',requesting:'等待麦克风权限',recording:'录音中',paused:'已暂停',saving:'正在保存原音',review:'录音已结束'}[v.state]||'')+'</span></div>'+
    '<div id="voice-notice" class="voice-notice" role="status">'+esc(v.failure)+'</div>'+
    (ready?'<p class="voice-intro">说下来，再慢慢校对。</p><p class="fine">本站可体验演示或本机录音，不会上传音频。Android Hub 可通过个人 VPS 使用阿里或 OpenAI，识别后校对并加入文字，保留原音。</p><div class="voice-actions">'+btn('体验实时转录','voice-demo')+plain('使用麦克风录音','voice-real')+'</div>':'')+
    (active?'<div class="voice-transcript"><h3>'+(v.mode==='demo'?'实时文字 · 演示':'文字待转写')+'</h3><div id="voice-final">'+voiceParagraphs(v)+'</div><p id="voice-partial" class="voice-partial">'+esc(v.partial||(!v.segments.length?'说出的内容将在这里逐段出现…':''))+'</p></div><div class="voice-actions">'+btn(v.state==='paused'?'继续录音':'暂停录音','voice-pause','outline')+btn('完成录音','voice-finish')+'</div>'+(v.mode==='demo'?'<details class="voice-scenarios"><summary>体验异常与恢复</summary><div class="actions">'+plain('模拟断网','voice-fail:断网')+plain('模拟额度不足','voice-fail:额度不足')+(v.failure?plain('恢复转写演示','voice-retry'):'')+'</div></details>':''):'')+
    (review?'<div class="voice-playback">'+(v.mode==='real'?'<audio id="voice-audio" controls aria-label="原音回听"></audio><p id="voice-audio-state" class="fine">正在读取本机原音…</p>':'<p class="fine">流程演示未使用麦克风，没有原音文件。</p>')+'</div><label class="voice-edit-label" for="voice-edit">校对后的文字</label><textarea id="voice-edit" rows="5" placeholder="可以手动补充文字">'+esc(v.editedByUser?v.edited:voiceText(v))+'</textarea><details class="voice-original"><summary>查看识别原文'+(v.mode==='demo'?'（演示）':'')+'</summary><p>'+esc(voiceText(v)||'尚无识别结果')+'</p></details>'+(v.failure&&v.mode==='demo'?plain('补转缺失文字（演示）','voice-retry'):'')+'<p class="fine">'+(v.target?'保留同一条记录；补转原文不会覆盖你已有的正文。':'确认后回到原速记草稿，文字和录音一起保存。')+'</p><div class="voice-actions">'+btn(v.attached?'保存校对':'加入速记草稿','voice-attach')+(v.mode==='real'?plain('下载原音','voice-download'):'')+(v.attached&&v.target?plain('继续追加录音','voice-continue'):'')+'</div>':'')+
    (review&&v.mode==='real'&&!v.audioSaved&&!voiceBlob?plain('重新录制','voice-retake'):'')+
    '<p class="voice-footnote">阿里与 OpenAI 均未连接，不产生识别费用。网页不保证锁屏或后台持续录音。</p></section>');
  if(review&&v.mode==='real')void voiceLoadAudio(v);
}
function voiceParagraphs(v) { return v.segments.map(t=>'<p>'+esc(t)+'</p>').join(''); }
function voiceTick() {
  const v=st.voiceDraft;if(!v||v.state!=='recording')return;
  const ms=voiceElapsed(v),clock=document.querySelector('#voice-time');if(clock)clock.textContent=voiceTime(ms);
  if(v.mode==='demo'&&!v.failure){
    const count=Math.min(voiceExample.length,Math.floor(ms/5000));
    v.segments=voiceExample.slice(0,count);v.partial=count<voiceExample.length?voiceExample[count].slice(0,Math.floor(ms%5000/150)):'';
    const final=document.querySelector('#voice-final'),partial=document.querySelector('#voice-partial');
    if(final)final.innerHTML=voiceParagraphs(v);if(partial)partial.textContent=v.partial;
  }
  // Persist elapsed progress separately from wall-clock origin, so reopening never counts time spent away.
  v.elapsed=ms;voiceStarted=Date.now();voicePersist();
}
async function voiceStart(mode) {
  const v=st.voiceDraft;if(!v||v.state!=='ready'||voiceBusy)return;
  v.mode=mode;voiceBlob=null;voiceChunks=[];
  if(mode==='real'){
    if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){voiceNotice('此浏览器不能录音，请使用支持麦克风的 HTTPS 浏览器，或体验演示。');return;}
    v.state='requesting';voiceShow();
    try{
      voiceStream=await navigator.mediaDevices.getUserMedia({audio:true});
      if(st.voiceDraft!==v||v.state!=='requesting'){voiceStream.getTracks().forEach(t=>t.stop());voiceStream=null;return;}
      voiceRecorder=new MediaRecorder(voiceStream);
      voiceRecorder.ondataavailable=e=>{if(e.data.size)voiceChunks.push(e.data);};
      voiceRecorder.onstop=()=>{if(v.state==='recording')voiceTick();clearInterval(voiceTimer);voiceTimer=null;voiceBlob=new Blob(voiceChunks,{type:voiceRecorder.mimeType});voiceStream?.getTracks().forEach(t=>t.stop());voiceStream=null;voiceRecorder=null;void voiceFinishStorage(v);};
      voiceRecorder.onerror=()=>{v.failure='录音中断；正在保留已采集的原音。';void voiceFinish();};
      voiceStream.getAudioTracks()[0].onended=()=>void voiceFinish();
      voiceRecorder.start(1000);
    }catch(error){voiceStream?.getTracks().forEach(t=>t.stop());voiceStream=null;voiceRecorder=null;v.state='ready';v.failure=error.name==='NotAllowedError'?'麦克风未获允许。可在浏览器中重新授权，或先体验演示。':'麦克风不可用，请检查设备后重试，或先体验演示。';voiceShow();return;}
  }
  v.state='recording';voiceStarted=Date.now();voiceTimer=setInterval(voiceTick,250);voicePersist();voiceShow();
}
function voicePause() {
  const v=st.voiceDraft;if(!v||!['recording','paused'].includes(v.state))return;
  if(v.state==='recording'){voiceTick();voiceRecorder?.pause();v.state='paused';}
  else{voiceRecorder?.resume();v.state='recording';voiceStarted=Date.now();}
  voicePersist();voiceShow();
}
async function voiceFinish() {
  const v=st.voiceDraft;if(!v||!['recording','paused'].includes(v.state))return;
  if(v.state==='recording')voiceTick();clearInterval(voiceTimer);voiceTimer=null;v.state='saving';voiceShow();
  if(voiceRecorder){if(voiceRecorder.state!=='inactive')voiceRecorder.stop();return;}
  await voiceFinishStorage(v);
}
async function voiceFinishStorage(v) {
  if(v.mode==='real'){
    if(!voiceBlob?.size){v.state='ready';v.elapsed=0;v.failure='没有采集到可用音频，请重新录制。';voicePersist();voiceShow();return;}
    try{await attachmentTransaction('readwrite',s=>s.put(voiceBlob,v.id));v.audioSaved=true;v.mime=voiceBlob.type;v.size=voiceBlob.size;}
    catch{v.state='review';v.failure='原音尚未保存。请保留页面，下载原音或重试加入草稿。';voiceShow();return;}
    v.failure='原音已保存在本机，文字待接通真实服务后转写。';
  }else if(!v.failure){if(v.partial)v.segments.push(voiceExample[v.segments.length]||v.partial);v.partial='';}
  v.state='review';voicePersist();voiceShow();
}
async function voiceLoadAudio(v) {
  try{const blob=voiceBlob||await attachmentTransaction('readonly',s=>s.get(v.id));if(!blob)throw Error();
    let url=attachmentUrls.get(v.id);if(!url){url=URL.createObjectURL(blob);attachmentUrls.set(v.id,url);}
    const el=document.querySelector('#voice-audio');if(el)el.src=url;
    const status=document.querySelector('#voice-audio-state');if(status)status.textContent=v.audioSaved?'原音已保存 · 仅此浏览器':'原音暂存于当前页面，请下载备份';
  }catch{voiceNotice('本机原音暂不可用，文字仍保留；不能将其当作已保存的录音。');}
}
function voiceRetry(v) {
  if(v.mode!=='demo')return;
  v.failure='';v.segments=[...voiceExample];v.partial='';
  if(v.state==='recording'){v.elapsed=Math.max(v.elapsed,15000);voiceStarted=Date.now();}
  voicePersist();voiceShow();if(v.editedByUser)voiceNotice('演示原文已补齐；你的校对稿保持不变。');
}
async function voiceAttach() {
  const v=st.voiceDraft;if(!v||v.state!=='review'||voiceBusy)return;
  voiceBusy=true;
  try{
    if(v.mode==='real'&&!v.audioSaved){if(!voiceBlob?.size)throw Error('没有可保存的原音，请先重新录制。');await attachmentTransaction('readwrite',s=>s.put(voiceBlob,v.id));v.audioSaved=true;v.mime=voiceBlob.type;v.size=voiceBlob.size;}
    const text=v.editedByUser?v.edited:voiceText(v),meta={id:v.id,name:v.mode==='demo'?'语音流程演示':'语音速记.'+(v.mime?.includes('mp4')?'m4a':'webm'),type:v.mime||'application/x-hub-voice-demo',size:v.size||0,voice:structuredClone(v)};
    const ok=journalTransaction(()=>{
      if(v.attached){
        if(v.inDraft){
          const d=v.target?journalEditorDraft(v.target):workflowDraft('note');
          if(!d||!recordAttachments(d).some(a=>a.id===v.id))throw Error('语音已不在原草稿中，校对内容仍保留。');
          d.attachments=recordAttachments(d).map(a=>a.id===v.id?meta:a);
        }else{
        const n=journalFind(v.target);if(!n)throw Error('原记录已移入回收站，请先恢复它。');
        const updated={...n,attachments:recordAttachments(n).map(a=>a.id===v.id?meta:a),revision:(n.revision||0)+1};
        if(n.demo)journalStore().overrides[n.id]=updated;else st.notes=st.notes.map(n=>n.id===v.target?updated:n);
        }
      }else{
        const d=v.target?journalEditorDraft(v.target):workflowDraft('note');if(!d)throw Error('原草稿暂不可用，语音内容仍保留。');
        if(recordAttachments(d).length+capturePhotos(d.photos).length>=9)throw Error('草稿已有9个附件，请先移除一个，再加入录音。');
        d.attachments=[...recordAttachments(d).filter(a=>a.id!==v.id),meta];
        d.text=[d.text,text].filter(Boolean).join('\n\n');if(!v.target)st.draft=d.text;
      }
      delete st.voiceDraft;
    });
    if(!ok){voiceNotice('未能保存，原草稿与语音仍保留，请重试。');return;}
    voiceBlob=null;
    if(v.attached&&v.inDraft&&!v.target){quickCapture('note');tell('校对稿已保存在语音附件内，正文保持不变。');}
    else if(v.attached){close();render();tell('校对稿已保存，原正文保持不变。');}
    else if(v.target){if(journalCommitEdit(v.target)){close();render();tell('已保存到原记录。');}else{close();go('journal-edit/'+v.target);tell('追加已保留在原记录草稿，请核对后保存。');}}
    else {quickCapture('note');}
  }catch(e){voiceNotice(e.message);}finally{voiceBusy=false;}
}
function voiceAction(a,key) {
  if(a==='voice-continue'){
    const previous=st.voiceDraft;if(!previous?.attached||!previous.target)return true;
    st.voiceDraft=voiceNew(previous.target);voicePersist();voiceShow();return true;
  }
  if(a==='journal-voice'){voiceOpen();return true;}
  if(a==='voice-open'){voiceOpen(key);return true;}
  if(!a.startsWith('voice-'))return false;
  if(a==='voice-demo')void voiceStart('demo');
  if(a==='voice-real')void voiceStart('real');
  if(a==='voice-pause')voicePause();
  if(a==='voice-finish')void voiceFinish();
  if(a==='voice-fail'){st.voiceDraft.failure=key+'（模拟）：文字待补转，不影响录音控制。';voicePersist();voiceShow();}
  if(a==='voice-retry')voiceRetry(st.voiceDraft);
  if(a==='voice-attach')void voiceAttach();
  if(a==='voice-retake'&&st.voiceDraft?.mode==='real'&&!st.voiceDraft.audioSaved&&!voiceBlob){st.voiceDraft.state='ready';st.voiceDraft.elapsed=0;st.voiceDraft.failure='原校对文字已保留，可以重新录制。';voicePersist();voiceShow();}
  if(a==='voice-download')void (async()=>{const v=st.voiceDraft;const blob=voiceBlob||await attachmentTransaction('readonly',s=>s.get(v.id));if(blob)downloadBlob(blob,'语音速记.'+(blob.type.includes('mp4')?'m4a':'webm'));else voiceNotice('原音暂不可用。');})().catch(()=>voiceNotice('读取原音失败，请重试。'));
  return true;
}
document.addEventListener('change',e=>{if(e.target.id==='voice-provider'&&st.voiceDraft?.state==='ready'){st.voiceDraft.provider=e.target.value;st.voiceProvider=e.target.value;voicePersist();voiceShow();}});
document.addEventListener('input',e=>{if(e.target.id==='voice-edit'&&st.voiceDraft){st.voiceDraft.edited=e.target.value;st.voiceDraft.editedByUser=true;voicePersist();}});
// Closing or leaving the recorder ends capture rather than keeping the microphone running invisibly.
document.addEventListener('click',e=>{if(e.target.closest?.('[data-act="close"]')&&document.querySelector('.voice-panel')&&['recording','paused'].includes(st.voiceDraft?.state)){e.preventDefault();e.stopImmediatePropagation();void voiceFinish();}},true);
document.addEventListener('visibilitychange',()=>{if(document.hidden)void voiceFinish();});
window.addEventListener('popstate',()=>{if(st.voiceDraft?.state==='requesting'){st.voiceDraft.state='ready';voicePersist();}if(['recording','paused'].includes(st.voiceDraft?.state))void voiceFinish();});
window.addEventListener('beforeunload',e=>{if(voiceRecorder||voiceBlob&&!st.voiceDraft?.audioSaved){e.preventDefault();e.returnValue='';}});
let voiceHoldTimer=null,voiceHoldOrigin=null,voiceHoldFired=false;
document.addEventListener('pointerdown',e=>{
  const button=e.target.closest?.('[data-act="quick-capture:note"]');if(!button||e.button!==0)return;
  voiceHoldFired=false;voiceHoldOrigin={x:e.clientX,y:e.clientY};
  voiceHoldTimer=setTimeout(()=>{voiceHoldFired=true;voiceOpen();},500);
});
document.addEventListener('pointermove',e=>{if(voiceHoldOrigin&&Math.hypot(e.clientX-voiceHoldOrigin.x,e.clientY-voiceHoldOrigin.y)>12)clearTimeout(voiceHoldTimer);});
for(const name of ['pointerup','pointercancel'])document.addEventListener(name,()=>{clearTimeout(voiceHoldTimer);voiceHoldOrigin=null;});
document.addEventListener('click',e=>{if(voiceHoldFired&&e.target.closest?.('[data-act="quick-capture:note"]')){e.preventDefault();e.stopImmediatePropagation();voiceHoldFired=false;}},true);
