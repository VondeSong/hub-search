import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const js=ts.transpileModule(fs.readFileSync(new URL('../app/cloud-demo.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {makeCloudState,cloudPending,cloudCanStart,cloudComplete,cloudScenario,cloudStep,loadCloudState,setAttachmentDownload,downloadAttachments,attachmentTypes,attachmentSamples,quickMigrationBlocked,loadCloudWithLegacy,setAttachmentUpload,uploadAttachments,cloudAttachments}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const finish=s=>{s={...s,phase:1};for(let i=0;i<4;i++)s=cloudStep(s);return s;};
const s=makeCloudState();
assert.equal(cloudPending(s),6);
const uploaded=finish(s);
assert.equal(cloudPending(uploaded),0);
assert.equal(uploaded.awaiting,3);
assert.equal(cloudComplete(uploaded),false,'uploaded quick notes still await the desktop writer');
assert.equal(uploaded.last,null);
assert.equal(cloudComplete(finish({...uploaded,writerOnline:true})),true);
assert.equal(finish({...uploaded,writerOnline:true}).written,11);
assert.deepEqual(finish(s).downloaded.reading,['image','pdf']);
assert.equal(finish(s).downloaded.reading.includes('video'),false,'cloud completion does not imply every attachment is local');
for(const n of ['unconnected','paused','offline','auth'])assert.equal(cloudCanStart(cloudScenario(n)),false,n);
assert.equal(finish(cloudScenario('partial')).error,false);

const scoped=finish({...s,modules:{flashcards:true,reading:false,quick:false}});
assert.equal(scoped.pending.reading,1);assert.equal(scoped.pending.quick,2);assert.equal(scoped.cloudMedia,false);assert.equal(scoped.awaiting,1);assert.equal(cloudComplete(scoped),true);
const legacy=loadCloudState(JSON.stringify({...s,provider:'webdav',pending:{flashcards:1,reading:1,quick:2}}));
assert.equal(legacy.provider,'none');assert.equal(legacy.connected,false);assert.equal(legacy.legacyRetired,true);
assert.equal(cloudCanStart(legacy),false);assert.deepEqual(finish(legacy).pending,legacy.pending);
assert.deepEqual(legacy.attachments,s.attachments);assert.deepEqual(legacy.uploads,s.uploads);
assert.equal(quickMigrationBlocked(s),true);assert.equal(cloudScenario('retired').legacyRetired,true);
const stopped=cloudStep({...s,phase:1,enabled:false});assert.equal(stopped.phase,0);assert.equal(stopped.pending.flashcards,2);
const custom={...s,network:'unmetered',cacheMb:888,media:false,cloudMedia:true,modules:{...s.modules,reading:false}};
for(const module of ['flashcards','reading','quick']){
  for(const type of attachmentTypes){
    const change={[type]:!custom.attachments[module][type]},next=setAttachmentDownload(custom,module,change);
    assert.deepEqual(next,{...custom,attachments:{...custom.attachments,[module]:{...custom.attachments[module],...change}}},'only the selected module policy changes');
    assert.deepEqual(loadCloudState(JSON.stringify(next)),next,'independent preferences survive reload');
  }
  const smaller=setAttachmentDownload(custom,module,{maxMb:1});
  assert.deepEqual(downloadAttachments(smaller,module).downloaded[module],[],'oversized files are not downloaded');
  const edge=setAttachmentDownload(custom,module,{image:true,maxMb:attachmentSamples[module][0].mb});
  assert.equal(downloadAttachments(edge,module).downloaded[module].includes('image'),true,'limit is inclusive');
  const downloaded=downloadAttachments(custom,module);
  assert.deepEqual(setAttachmentDownload(downloaded,module,{image:false,pdf:false,maxMb:1}).downloaded,downloaded.downloaded,'policy changes never delete files');
}
const {attachments,downloaded,...oldBase}=s;
const old={...oldBase,modules:{flashcards:false,reading:true},pending:{flashcards:7,reading:3},download:'all',flashDownload:'onDemand',imageMb:10,documentMb:20,dailyMb:1,batchMb:1,error:'quota',localMedia:true};
const upgraded=loadCloudState(JSON.stringify(old));
assert.equal(upgraded.modules.quick,false);assert.equal(upgraded.modules.flashcards,false);
assert.deepEqual(upgraded.attachments.reading,{image:true,pdf:true,video:false,other:false,maxMb:10});
assert.equal(Object.values(upgraded.attachments.flashcards).filter(x=>x===true).length,0);
assert.deepEqual(upgraded.downloaded.reading,['pdf']);assert.equal(upgraded.error,false);
assert.equal('dailyMb' in upgraded,false);assert.equal('batchMb' in upgraded,false);
assert.equal(finish({...upgraded,modules:{...upgraded.modules,reading:true}}).cloudMedia,true,'old budgets cannot block transfer');
const oldPreset=loadCloudState(JSON.stringify({...old,preset:'offline',custom:{dailyMb:99}}));
assert.equal(oldPreset.network,s.network);assert.equal(oldPreset.attachments.reading.video,false);
assert.equal(loadCloudState(JSON.stringify({...old,download:'onDemand'})).attachments.reading.pdf,false,'manual preferences remain manual');
assert.deepEqual(loadCloudState('{bad'),s);
assert.deepEqual(loadCloudState(JSON.stringify({...s,attachments:{...s.attachments,quick:{...s.attachments.quick,maxMb:21}}})),s);
const noQuickMedia=setAttachmentDownload(s,'quick',{image:false,video:false,pdf:false,other:false});
const written=finish({...noQuickMedia,writerOnline:true});
assert.equal(written.awaiting,0);assert.equal(written.written,11);assert.deepEqual(written.downloaded.quick,[],'body is written without downloading attachments');
assert.equal(finish(written).written,11,'retry does not write the same note twice');
assert.equal(cloudComplete(finish({...s,writerOnline:true})),true,'intentional attachment omissions are not failures');
assert.equal(loadCloudState(JSON.stringify({...s,phase:2})).phase,0);
assert.equal(loadCloudState(JSON.stringify({...s,retired:true,sourceMinutes:60,journalFolder:'Diary'})).journalFolder,'Diary');
console.log('通过：三模块范围、速记上传/写入区分、OSS迁移限制、旧WebDAV停止且保留偏好与队列、暂停/离线/凭据门禁、附件重试、独立下载选项和存储校验');

const disabledError={...cloudScenario('partial'),modules:{flashcards:true,reading:false,quick:false}};
assert.equal(cloudComplete(disabledError),true,'disabled module errors do not block other modules');
assert.equal(finish(disabledError).error,'media','running other modules must retain the unresolved reading error');
assert.equal(finish({...disabledError,modules:{...disabledError.modules,reading:true}}).error,false);
const migrated=loadCloudWithLegacy(null,JSON.stringify({settings:{folder:'OldNotes',dateFolders:false}}));
assert.equal(migrated.journalFolder,'OldNotes');assert.equal(migrated.dateFolders,false);
const preserved=loadCloudWithLegacy(JSON.stringify({...makeCloudState(),journalFolder:'MyNotes'}),JSON.stringify({settings:{folder:'OldNotes'}}));
assert.equal(preserved.journalFolder,'MyNotes');assert.equal(preserved.journalMigration,'kept');
const flashFail=cloudScenario('flashmedia');assert.equal(cloudComplete(flashFail),false);assert.equal(cloudPending(flashFail),1);assert.equal(finish(flashFail).flashCloud,true);
assert.equal(finish(makeCloudState()).downloaded.flashcards.includes('image'),true);
const saved=loadCloudState(JSON.stringify({...makeCloudState(),restoreStep:2,repairFailed:true,backupHours:48,sourceImages:false}));
assert.equal(saved.restoreStep,2);assert.equal(saved.repairFailed,true);assert.equal(saved.backupHours,48);assert.equal(saved.sourceImages,false);
console.log('新增回归通过：停用范围与错误保留、下载不更改网络/上传/缓存/模块、旧速记迁移与冲突、闪卡附件、恢复进度与备份策略保存');

console.log('通过：三模块类型与大小上限、边界值、保留已下载文件、旧配置迁移且不扩大范围、移除旧额度阻断、速记正文先写且重试不重复');

const uploadsOff={...makeCloudState(),uploadFlash:false,uploadQuick:false,media:false,flashCloud:false,quickCloud:false,cloudMedia:false,writerOnline:true};
const bodyOnly=finish(uploadsOff);
assert.deepEqual(bodyOnly.pending,{flashcards:0,reading:0,quick:0});
assert.equal(bodyOnly.written,11);
assert.equal(bodyOnly.flashCloud,false);assert.equal(bodyOnly.quickCloud,false);assert.equal(bodyOnly.cloudMedia,false);
assert.deepEqual(bodyOnly.attachments,uploadsOff.attachments);
assert.equal(cloudComplete(bodyOnly),true,'disabled uploads must not leave endless pending work');
const reenabled={...bodyOnly,uploadFlash:true,uploadQuick:true,media:true};
assert.equal(cloudPending(reenabled),3,'re-enabling uploads resumes retained attachments');
const resumed=finish(reenabled);
assert.equal(resumed.flashCloud,true);assert.equal(resumed.quickCloud,true);assert.equal(resumed.cloudMedia,true);assert.equal(resumed.written,11);
assert.equal(loadCloudState(JSON.stringify(uploadsOff)).uploadFlash,false);
assert.equal(loadCloudState(JSON.stringify(uploadsOff)).uploadQuick,false);
assert.deepEqual(finish({...uploadsOff,flashCloud:true,cloudMedia:true,quickCloud:true}).downloaded,finish(makeCloudState()).downloaded,'existing cloud copies download independently of upload switches');
console.log('通过：三模块独立附件上传、关闭仍同步正文、重新开启补传、已有云副本下载、刷新保留及速记幂等');

for(const m of ['flashcards','reading','quick']){
 const empty={...makeCloudState(),flashCloud:false,cloudMedia:false,quickCloud:false};
 const limited=setAttachmentUpload(empty,m,{image:true,video:false,pdf:true,other:false,maxMb:attachmentSamples[m][0].mb});
 assert.deepEqual(limited.attachments,empty.attachments,'upload does not change download policy');
 const result=finish(limited);
 assert.deepEqual(cloudAttachments(result,m),['image'],'upload respects type and inclusive size');
 const expanded=setAttachmentUpload(result,m,{maxMb:20});
 assert.equal(cloudPending(expanded)>0,true,'newly eligible retained files can resume');
 assert.equal(cloudAttachments(finish(expanded),m).includes('pdf'),true);
 assert.deepEqual(loadCloudState(JSON.stringify(limited)).uploads,limited.uploads);
 assert.deepEqual(setAttachmentUpload(result,m,{image:false}).uploaded,result.uploaded,'changing upload rules never deletes cloud files');
}
const {uploads:oldUploads,uploaded:oldUploaded,...legacyUpload}=makeCloudState();
const disabledLegacy=loadCloudState(JSON.stringify({...legacyUpload,uploadFlash:false,uploadQuick:false,media:false}));
for(const p of Object.values(disabledLegacy.uploads))assert.equal(attachmentTypes.some(t=>p[t]),false,'legacy disabled uploads stay disabled');
console.log('通过：上传类型与大小过滤、边界、重新补传、上下行独立、旧开关迁移和云副本保留');
