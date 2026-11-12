export type CloudModule = 'flashcards' | 'reading' | 'quick';
export type AttachmentType = 'image'|'video'|'pdf'|'other';
export type AttachmentPolicy = Record<AttachmentType,boolean> & {maxMb:number};
export type MediaPolicy = {attachments:Record<CloudModule,AttachmentPolicy>; downloaded:Record<CloudModule,AttachmentType[]>; network:'any'|'unmetered'|'wifi'; cacheMb:number};
export type CloudState = MediaPolicy & {
  craftInterval:number; sourceImages:boolean; sourcePdf:boolean; sourceOriginals:boolean; deviceSeen:string; deviceConfirmed:boolean; restoreStep:number; historyStep:number; repairPaused:boolean; repairFailed:boolean;
  flashCloud:boolean; pinA:boolean; pinB:boolean; backupFolder:string; backupHours:number; backupKeep:number; backupCount:number; craftReplica:string; legacyRetired:boolean; journalMigration:string;
  connected:boolean; provider:'oss'|'none'; name:string; bucket:string; region:string; prefix:string; credential:boolean;
  enabled:boolean; auto:boolean; online:boolean; modules:Record<CloudModule,boolean>; pending:Record<CloudModule,number>;
  uploads:Record<CloudModule,AttachmentPolicy>; uploaded?:Partial<Record<CloudModule,AttachmentType[]>>;
  media:boolean; cloudMedia:boolean; uploadFlash:boolean; uploadQuick:boolean; quickCloud:boolean;
  awaiting:number; written:number; writerOnline:boolean; quickBound:boolean;
  error:false|'media'|'auth'; phase:number; last:number|null; log:string[];
  retired:boolean; cacheUsed:number; pinnedMb:number; historyClean:boolean;
  journalFolder:string; journalLibrary:string; dateFolders:boolean; sourceMinutes:number; cleanup:boolean; backupAuto:boolean;
};
export const CLOUD_KEY = 'hub-cloud-center-demo-v1';
export const modules:CloudModule[] = ['flashcards','reading','quick'];
export const moduleNames:Record<CloudModule,string> = {flashcards:'闪卡',reading:'阅读',quick:'速记'};
export const attachmentTypes:AttachmentType[] = ['image','video','pdf','other'];
export const attachmentNames:Record<AttachmentType,string> = {image:'图片',video:'视频',pdf:'PDF',other:'其他'};
export const attachmentMax:Record<CloudModule,number> = {flashcards:250,reading:100,quick:20};
export const attachmentSamples:Record<CloudModule,{type:AttachmentType;name:string;mb:number}[]> = {
  flashcards:[{type:'image',name:'端子示意.png',mb:2},{type:'video',name:'装配演示.mp4',mb:30},{type:'pdf',name:'接线手册.pdf',mb:12},{type:'other',name:'讲解录音.mp3',mb:4}],
  reading:[{type:'image',name:'连接器照片.jpg',mb:3},{type:'video',name:'拆解视频.mp4',mb:40},{type:'pdf',name:'连接器说明.pdf',mb:12},{type:'other',name:'参考资料.zip',mb:8}],
  quick:[{type:'image',name:'现场记录.jpg',mb:2},{type:'video',name:'现场视频.mp4',mb:16},{type:'pdf',name:'随记附件.pdf',mb:6},{type:'other',name:'语音速记.m4a',mb:4}],
};
const defaultAttachments=():Record<CloudModule,AttachmentPolicy> => ({flashcards:{image:true,video:false,pdf:true,other:false,maxMb:20},reading:{image:true,video:false,pdf:true,other:false,maxMb:20},quick:{image:true,video:false,pdf:true,other:false,maxMb:20}});
export const makeCloudState = ():CloudState => ({
  uploads:{flashcards:{image:true,video:true,pdf:true,other:true,maxMb:250},reading:{image:true,video:true,pdf:true,other:true,maxMb:100},quick:{image:true,video:true,pdf:true,other:true,maxMb:20}},attachments:defaultAttachments(),downloaded:{flashcards:[],reading:[],quick:[]},network:'any',cacheMb:1024,craftInterval:1440,sourceImages:true,sourcePdf:true,sourceOriginals:true,deviceSeen:'尚未刷新',deviceConfirmed:false,restoreStep:0,historyStep:0,repairPaused:false,repairFailed:false,flashCloud:true,pinA:true,pinB:true,backupFolder:'Hub Backups',backupHours:24,backupKeep:7,backupCount:1,craftReplica:'',legacyRetired:false,journalMigration:'pending', connected:true,provider:'oss',name:'我的 Hub',bucket:'hub-personal-demo',region:'cn-hangzhou',prefix:'hub/',credential:true,
  enabled:true,auto:false,online:true,modules:{flashcards:true,reading:true,quick:true},pending:{flashcards:2,reading:1,quick:2},
  media:true,cloudMedia:false,uploadFlash:true,uploadQuick:true,quickCloud:true,awaiting:1,written:8,writerOnline:false,quickBound:true,
  phase:0,error:false,last:null,log:[],retired:false,cacheUsed:186,pinnedMb:32,historyClean:false,
  journalFolder:'Daily',journalLibrary:'OS',dateFolders:true,sourceMinutes:15,cleanup:false,backupAuto:false,
});
export const quickSupported = (s:CloudState) => s.provider==='oss';
export const uploadEnabled=(s:CloudState,m:CloudModule)=>m==='flashcards'?s.uploadFlash:m==='reading'?s.media:s.uploadQuick;
export const cloudAttachments=(s:CloudState,m:CloudModule):AttachmentType[]=>s.uploaded?.[m]??((m==='flashcards'?s.flashCloud:m==='reading'?s.cloudMedia:s.quickCloud)?attachmentTypes:[]);
export const uploadCandidates=(s:CloudState,m:CloudModule)=>uploadEnabled(s,m)?attachmentSamples[m].filter(f=>s.uploads[m][f.type]&&f.mb<=s.uploads[m].maxMb).map(f=>f.type):[];
export const uploadPending=(s:CloudState,m:CloudModule)=>uploadCandidates(s,m).some(t=>!cloudAttachments(s,m).includes(t));
export function setAttachmentUpload(s:CloudState,m:CloudModule,change:Partial<AttachmentPolicy>):CloudState {
 const policy={...s.uploads[m],...change},key=m==='flashcards'?'uploadFlash':m==='reading'?'media':'uploadQuick';
 return {...s,[key]:attachmentTypes.some(t=>policy[t]),uploads:{...s.uploads,[m]:policy}};
}
export function uploadAttachments(s:CloudState,m:CloudModule):CloudState {
 const list=[...new Set([...cloudAttachments(s,m),...uploadCandidates(s,m)])],key=m==='flashcards'?'flashCloud':m==='reading'?'cloudMedia':'quickCloud';
 return {...s,[key]:list.length>0,uploaded:{...s.uploaded,[m]:list}};
}
export function cloudPending(s:CloudState) {
 return modules.reduce((n,m)=>n+(s.modules[m]&&(m!=='quick'||quickSupported(s))?s.pending[m]+(uploadPending(s,m)?1:0):0),0);
}
export function cloudCanStart(s:CloudState) {
  return s.connected&&s.credential&&s.enabled&&s.online&&!s.phase&&modules.some(m=>s.modules[m]&&(m!=='quick'||quickSupported(s)))&&s.error!=='auth';
}
export const quickNeedsWriter = (s:CloudState) => s.modules.quick&&quickSupported(s)&&s.awaiting>0;
export const quickMigrationBlocked = (s:CloudState) => s.quickBound||s.pending.quick>0||s.awaiting>0;
export const activeCloudError=(s:CloudState)=>s.error==='auth'||s.modules.reading&&s.media?s.error:false;
export function cloudComplete(s:CloudState) {
  return cloudCanStart(s)&&!cloudPending(s)&&!activeCloudError(s)&&!quickNeedsWriter(s)&&!(s.modules.quick&&!quickSupported(s));
}
export function setAttachmentDownload(s:CloudState,module:CloudModule,change:Partial<AttachmentPolicy>):CloudState {
  return {...s,attachments:{...s.attachments,[module]:{...s.attachments[module],...change}}};
}
export const attachmentSummary=(s:CloudState,module:CloudModule)=>{
  const p=s.attachments[module],names=attachmentTypes.filter(type=>p[type]).map(type=>attachmentNames[type]);
  return names.length?`${names.join('、')} · 单个 ≤ ${p.maxMb} MB`:'附件仅手动下载';
};
export function downloadAttachments(s:CloudState,module:CloudModule):CloudState {
  const p=s.attachments[module],types=attachmentSamples[module].filter(file=>p[file.type]&&file.mb<=p.maxMb&&cloudAttachments(s,module).includes(file.type)).map(file=>file.type);
  return {...s,downloaded:{...s.downloaded,[module]:[...new Set([...s.downloaded[module],...types])]}};
}
export function cloudStep(s:CloudState):CloudState {
  if(!s.phase||!s.connected||s.provider!=='oss'||!s.enabled||!s.online||!s.credential||s.error==='auth')return {...s,phase:0};
  if(s.phase===1){const next=s.modules.flashcards?downloadAttachments(uploadAttachments(s,'flashcards'),'flashcards'):s;return {...next,phase:2,pending:{...s.pending,...(s.modules.flashcards?{flashcards:0}:{})}};}
  if(s.phase===2)return {...s,phase:3,pending:{...s.pending,...(s.modules.reading?{reading:0}:{})}};
  if(s.phase===3){
    if(!s.modules.quick||!quickSupported(s))return {...s,phase:4};
    const total=s.awaiting+s.pending.quick;
    return {...downloadAttachments(uploadAttachments(s,'quick'),'quick'),phase:4,quickBound:true,pending:{...s.pending,quick:0},awaiting:s.writerOnline?0:total,written:s.written+(s.writerOnline?total:0)};
  }
  const next=s.modules.reading?downloadAttachments(uploadAttachments(s,'reading'),'reading'):s;
  const result:CloudState={...next,phase:0,error:s.modules.reading?false:s.error,
    log:[`${new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} · 本轮已处理${s.modules.quick&&s.awaiting?'，速记等待电脑写入':''}（演示）`,...s.log].slice(0,6)};
  return {...result,last:cloudComplete(result)?Date.now():s.last};
}
export function cloudScenario(name:string):CloudState {
  const s=makeCloudState();
  if(name==='unconnected')return {...s,connected:false,credential:false,quickBound:false};
  if(name==='paused')return {...s,enabled:false};
  if(name==='offline')return {...s,online:false};
  if(name==='retired')return {...s,provider:'none',connected:false,credential:false,legacyRetired:true,quickBound:false};
  if(name==='flashmedia')return {...s,pending:{flashcards:0,reading:0,quick:0},awaiting:0,cloudMedia:true,flashCloud:false};
  if(name==='auth')return {...s,error:'auth'};
  if(name==='waiting')return {...s,pending:{flashcards:0,reading:0,quick:0},cloudMedia:true,awaiting:3};
  if(name==='synced'||name==='partial')return {...s,pending:{flashcards:0,reading:0,quick:0},awaiting:0,cloudMedia:name==='synced',error:name==='partial'?'media':false,last:name==='synced'?Date.now():null};
  return s;
}
const record=(v:unknown):v is Record<string,unknown> => !!v&&typeof v==='object'&&!Array.isArray(v);
const count=(v:unknown,max=10000):v is number => Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=max;
export function loadCloudState(raw:string|null):CloudState {
  const base=makeCloudState();
  try {
    const v:unknown=JSON.parse(raw||'null');
    if(!record(v)||!record(v.modules)||!record(v.pending))return base;
    const s:CloudState={...base,uploads:{...base.uploads},attachments:{...base.attachments},modules:{...base.modules},pending:{...base.pending}};
    for(const key of ['connected','enabled','auto','online','media','cloudMedia','uploadFlash','uploadQuick','quickCloud','credential','writerOnline','quickBound','sourceImages','sourcePdf','sourceOriginals','deviceConfirmed','repairPaused','repairFailed','retired','legacyRetired','flashCloud','pinA','pinB','historyClean','dateFolders','cleanup','backupAuto'] as const){
      if(key in v){if(typeof v[key]!=='boolean')return base;s[key]=v[key];}
    }
    for(const m of modules){
      if(m in v.modules){if(typeof v.modules[m]!=='boolean')return base;s.modules[m]=v.modules[m];}
      if(m in v.pending){if(!count(v.pending[m]))return base;s.pending[m]=v.pending[m];}
    }
    // Existing prototype preferences stay intact; newly introduced sync is opt-in on upgrade.
    if(!('quick' in v.modules)){s.modules.quick=false;s.pending.quick=0;s.awaiting=0;s.quickBound=false;}
    for(const key of ['awaiting','written','cacheUsed','pinnedMb','backupCount','restoreStep','historyStep'] as const)if(key in v){if(!count(v[key]))return base;s[key]=v[key];}
    for(const key of ['name','bucket','region','prefix','journalFolder','journalLibrary','backupFolder','craftReplica','journalMigration','deviceSeen'] as const)if(key in v){if(typeof v[key]!=='string'||v[key].length>160)return base;s[key]=v[key];}
    if('attachments' in v){
      if(!record(v.attachments))return base;
      for(const m of modules){
        const p=v.attachments[m];if(!record(p)||!count(p.maxMb,attachmentMax[m])||Number(p.maxMb)<1||attachmentTypes.some(t=>typeof p[t]!=='boolean'))return base;
        s.attachments[m]={image:p.image as boolean,video:p.video as boolean,pdf:p.pdf as boolean,other:p.other as boolean,maxMb:p.maxMb as number};
      }
    }else{
      // Map old automatic choices conservatively; a single limit uses the smaller previous limit.
      for(const m of ['flashcards','reading'] as const){
        const mode=v[m==='flashcards'?'flashDownload':'download'];if(mode!==undefined&&mode!=='all'&&mode!=='onDemand')return base;
        const auto=mode==='all',limits=[v.imageMb,v.documentMb].filter((n):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=1&&n<=100);
        s.attachments[m]={image:auto,video:m==='flashcards'&&auto,pdf:auto,other:m==='flashcards'&&auto,maxMb:m==='flashcards'?250:limits.length?Math.min(...limits):20};
      }
      s.attachments.quick={image:true,video:true,pdf:true,other:true,maxMb:20};
    }
    if('uploads' in v){
      if(!record(v.uploads))return base;
      for(const m of modules){const p=v.uploads[m];if(!record(p)||!count(p.maxMb,attachmentMax[m])||Number(p.maxMb)<1||attachmentTypes.some(t=>typeof p[t]!=='boolean'))return base;s.uploads[m]={image:p.image as boolean,video:p.video as boolean,pdf:p.pdf as boolean,other:p.other as boolean,maxMb:p.maxMb as number};}
    }else{
      for(const m of modules){const on=uploadEnabled(s,m);s.uploads[m]={image:on,video:on,pdf:on,other:on,maxMb:attachmentMax[m]};}
    }
    if('uploaded' in v){
      if(!record(v.uploaded))return base;
      s.uploaded={};for(const m of modules){const list=v.uploaded[m];if(list===undefined)continue;if(!Array.isArray(list)||list.some(t=>!attachmentTypes.includes(t)))return base;s.uploaded[m]=[...new Set(list)] as AttachmentType[];}
    }
    if('downloaded' in v){
      if(!record(v.downloaded))return base;
      for(const m of modules){const list=v.downloaded[m];if(!Array.isArray(list)||list.some(t=>!attachmentTypes.includes(t)))return base;s.downloaded[m]=[...new Set(list)] as AttachmentType[];}
    }else{
      if(v.flashLocal===true)s.downloaded.flashcards=['image'];
      if(v.localMedia===true)s.downloaded.reading=['pdf'];
    }
    if('provider' in v){if(v.provider==='webdav'){s.provider='none';s.connected=false;s.credential=false;s.legacyRetired=true;}else if(v.provider==='oss'||v.provider==='none')s.provider=v.provider;else return base;}
    if('network' in v){if(!['any','unmetered','wifi'].includes(String(v.network)))return base;s.network=v.network as CloudState['network'];}
    for(const [key,min,max] of [['cacheMb',100,10240],['sourceMinutes',0,1440],['backupHours',1,720],['backupKeep',1,100],['craftInterval',0,1440]] as const){
      if(key in v){if(!count(v[key],max)||Number(v[key])<min)return base;s[key]=v[key];}
    }
    s.error=v.error===true?'media':['media','auth'].includes(String(v.error))?v.error as CloudState['error']:false;
    s.last=v.last===null?null:count(v.last,Number.MAX_SAFE_INTEGER)?v.last:null;
    s.log=Array.isArray(v.log)?v.log.filter((l):l is string=>typeof l==='string'&&l.length<180).slice(0,6):[];
    return s;
  }catch{return base;}
}

export function loadCloudWithLegacy(raw:string|null,journalRaw:string|null):CloudState {
 const s=loadCloudState(raw);if(s.journalMigration!=='pending')return s;
 try{const legacy=JSON.parse(journalRaw||'null')?.settings;if(!legacy||typeof legacy.folder!=='string'||!legacy.folder||legacy.folder.includes('..')||/[:\\]/.test(legacy.folder)||legacy.folder.startsWith('/'))return {...s,journalMigration:'none'};
 const custom=s.journalFolder!==makeCloudState().journalFolder||s.dateFolders!==makeCloudState().dateFolders;
 return custom?{...s,journalMigration:'kept'}:{...s,journalFolder:legacy.folder,dateFolders:typeof legacy.dateFolders==='boolean'?legacy.dateFolders:s.dateFolders,journalMigration:'migrated'};
 }catch{return {...s,journalMigration:'none'};}
}
