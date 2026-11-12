"use client";
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ArrowLeft,ArrowRight,ArrowUp,ArrowDown,Image as ImageIcon,Video,FileText,Paperclip,BookOpenCheck,Bookmark,Check,ChevronRight,Cloud,CloudCheck,FolderOpen,HardDrive,KeyRound,LoaderCircle,Monitor,Pause,PencilLine,RefreshCw,ShieldCheck,Smartphone,TriangleAlert,WifiOff} from 'lucide-react';
import {CLOUD_KEY,makeCloudState,cloudCanStart,cloudComplete,cloudPending,cloudScenario,cloudStep,quickSupported,quickNeedsWriter,quickMigrationBlocked,setAttachmentDownload,setAttachmentUpload,uploadPending,attachmentTypes,attachmentNames,attachmentMax,attachmentSummary,modules,moduleNames,type AttachmentPolicy,type CloudState,type CloudModule,activeCloudError,loadCloudWithLegacy} from './cloud-demo';
import {AttachmentDetails,CacheDetails,BackupDetails,DeviceDetails,RepairDetails} from './CloudDetailPanels';
export type CloudPage='overview'|'preferences'|'connection'|'advanced';
export type RelatedSetting='journal'|'sources'|'backup'|'cache';
type Page=CloudPage|RelatedSetting;
const pageNames:Record<CloudPage,string>={overview:'云同步',preferences:'同步设置',connection:'云连接',advanced:'同步诊断与修复'};
const related:Partial<Record<Page,string>>={journal:'速记保存位置',sources:'来源与采集',backup:'备份与恢复',cache:'数据与存储'};
function Switch({label,hint,checked,disabled,onChange}:{label:string;hint:string;checked:boolean;disabled?:boolean;onChange:()=>void}){
  return <label className="cs-setting"><span><strong>{label}</strong>{hint&&<small>{hint}</small>}</span><input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={onChange}/></label>;
}
function Row({icon,title,children}:{icon:ReactNode;title:string;children:ReactNode}){return <div className="cs-module"><span className="cs-module-icon">{icon}</span><div><h3>{title}</h3>{children}</div></div>;}
function Link({children,onClick}:{children:ReactNode;onClick:()=>void}){return <button className="cs-link" onClick={onClick}>{children}<ChevronRight size={14}/></button>;}
function ModuleIcon({id}:{id:CloudModule}){const Icon=id==='flashcards'?BookOpenCheck:id==='reading'?Bookmark:PencilLine;return <span className="cs-app-icon" data-module={id}><Icon size={18}/></span>;}
function AttachmentPolicyRow({id,s,locked,direction='download',onChange}:{id:CloudModule;s:CloudState;locked:boolean;direction?:'upload'|'download';onChange:(change:Partial<AttachmentPolicy>)=>void}){
  const p=(direction==='upload'?s.uploads:s.attachments)[id],verb=direction==='upload'?'上传':'自动下载',[draft,setDraft]=useState(String(p.maxMb));
  const disabled=locked||!s.modules[id]||id==='quick'&&!quickSupported(s);
  useEffect(()=>setDraft(String(p.maxMb)),[p.maxMb]);
  const icons={image:ImageIcon,video:Video,pdf:FileText,other:Paperclip};
  return <div className="cs-download-row" data-disabled={disabled}>
    <div className="cs-row-name"><ModuleIcon id={id}/><strong>{moduleNames[id]}</strong></div>
    <div className="cs-type-options" role="group" aria-label={`${moduleNames[id]}${verb}类型`}>{attachmentTypes.map(type=>{const Icon=icons[type];return <label key={type} className="cs-type-choice"><input type="checkbox" disabled={disabled} aria-label={`${moduleNames[id]}${verb}${attachmentNames[type]}`} checked={p[type]} onChange={e=>onChange({[type]:e.target.checked})}/><span><Icon size={15}/>{attachmentNames[type]}<Check className="cs-type-tick" size={12}/></span></label>;})}</div>
    <label className="cs-size-field"><span>单个上限</span><span className="cs-size-control"><input className="cs-size-input" type="number" aria-label={`${moduleNames[id]}${verb}单个附件上限`} title={`1–${attachmentMax[id]} MB`} min={1} max={attachmentMax[id]} step={1} disabled={disabled} value={draft} onChange={e=>{setDraft(e.target.value);const n=Number(e.target.value);if(Number.isSafeInteger(n)&&n>=1&&n<=attachmentMax[id])onChange({maxMb:n});}} onBlur={()=>setDraft(String(p.maxMb))}/><span>MB</span></span></label>
  </div>;
}
export default function CloudSyncCenter({onExit,initialPage='overview',standalone=false,onOpenSettings,onOpenCloud}:{onExit:()=>void;initialPage?:Page;standalone?:boolean;onOpenSettings?:(target:RelatedSetting)=>void;onOpenCloud?:(target:CloudPage)=>void}){
  const [s,set]=useState(makeCloudState),[ready,setReady]=useState(false),[storageOk,setStorageOk]=useState(true);
  const [page,setPage]=useState<Page>(initialPage),[scenario,setScenario]=useState('pending'),[notice,setNotice]=useState('');
  const [wizard,setWizard]=useState<''|'location'|'verify'|'migrate'|'credentials'|'legacy'|'check'>('');
  const [draft,setDraft]=useState({name:'我的 Hub',bucket:'hub-personal-demo',region:'cn-hangzhou',prefix:'hub/'});
  const [draftDav,setDraftDav]=useState({url:'https://dav.example.invalid/hub/',user:'demo-user'}),[migrationTarget,setMigrationTarget]=useState<'oss'|'webdav'>('oss');
  const error=activeCloudError(s);
  const [ack,setAck]=useState(false),[connecting,setConnecting]=useState(false),[checkFails,setCheckFails]=useState(false),[checkError,setCheckError]=useState('');
  const connectionTimer=useRef<ReturnType<typeof setTimeout>|null>(null),headingRef=useRef<HTMLHeadingElement>(null),scrollRef=useRef<HTMLDivElement>(null);
  const locked=!!s.phase||connecting||!ready;
  const detailProps={s,set,notice:setNotice,locked};
  useEffect(()=>{try{set(loadCloudWithLegacy(localStorage.getItem(CLOUD_KEY),localStorage.getItem('hub-journal-prototype-records-v1')));}catch{setStorageOk(false);}setReady(true);},[]);
  useEffect(()=>{if(ready)try{localStorage.setItem(CLOUD_KEY,JSON.stringify(s));}catch{setStorageOk(false);}},[s,ready]);
  useEffect(()=>()=>{if(connectionTimer.current)clearTimeout(connectionTimer.current);},[]);
  useEffect(()=>{if(!s.phase)return;const id=setTimeout(()=>set(cloudStep),650);return()=>clearTimeout(id);},[s.phase]);
  useEffect(()=>{if(!ready||!s.auto||!cloudCanStart(s)||!cloudPending(s)||error)return;const id=setTimeout(()=>set(p=>cloudCanStart(p)?{...p,phase:1}:p),2000);return()=>clearTimeout(id);},[s,ready]);
  useEffect(()=>{setPage(initialPage);setNotice('');setWizard('');scrollRef.current?.scrollTo(0,0);requestAnimationFrame(()=>headingRef.current?.focus());},[initialPage]);
  function navigate(next:Page){if(related[next]&&onOpenSettings){onOpenSettings(next as RelatedSetting);return;}if(standalone&&!related[next]&&onOpenCloud){onOpenCloud(next as CloudPage);return;}setPage(next);setNotice('');setWizard('');setCheckError('');scrollRef.current?.scrollTo(0,0);requestAnimationFrame(()=>headingRef.current?.focus());}
  function example(value:string){setScenario(value);set(cloudScenario(value));setWizard('');setNotice('');setCheckError('');}
  function start(){if(cloudCanStart(s))set({...s,phase:1});}
  function beginConnection(mode:typeof wizard){setDraft({name:s.name,bucket:s.bucket,region:s.region,prefix:s.prefix});setDraftDav({url:s.webdavUrl,user:s.webdavUser});setMigrationTarget('oss');setWizard(mode);setCheckFails(mode==='check'&&error==='auth');setAck(false);setCheckError('');}
  function saveConnection(){
    if(!s.online){setCheckError('当前离线，无法完成连接检查；原配置保留。');return;}
    if(wizard==='migrate'&&(!s.enabled||!ack||quickMigrationBlocked(s))){setCheckError('请先启用云同步，并确认迁移范围。');return;}
    setConnecting(true);setCheckError('');
    connectionTimer.current=setTimeout(()=>{
      setConnecting(false);
      if(checkFails){setCheckError('示例连接检查失败，原连接和内容已保留。关闭失败场景后可重试。');return;}
      if(wizard==='credentials')set(p=>({...p,credential:true,error:p.error==='auth'?false:p.error}));
      else if(wizard==='check')set(p=>({...p,error:p.error==='auth'?false:p.error}));
      else if(wizard!=='legacy')set(p=>({...p,...draft,name:draft.name.trim()||'我的 Hub',connected:true,credential:true,provider:wizard==='migrate'?migrationTarget:'oss',...(migrationTarget==='webdav'?{webdavUrl:draftDav.url,webdavUser:draftDav.user}:{})}));
      setWizard('');setNotice(wizard==='migrate'?'闪卡与阅读迁移演示完成，旧云副本保留。':wizard==='credentials'?'示例凭据已更新，连接检查通过。内容同步结果请查看概览。':'演示连接检查通过，不代表内容已同步。');
    },1100);
  }
  function primary(){
    if(!s.connected){navigate('connection');beginConnection('location');}
    else if(!s.enabled)set({...s,enabled:true});
    else if(!s.credential||error==='auth'){navigate('connection');beginConnection('credentials');}
    else if(!s.online)setNotice('当前为离线演示，改动已保留。可在页尾切换联网场景后继续。');
    else if(!active||unsupported&&!pending)navigate('preferences');
    else start();
  }
  function moduleStatus(id:CloudModule){
    if(!s.modules[id])return '未开启';
    if(id==='quick'&&!quickSupported(s))return '当前连接不支持';
    if(!s.connected)return '等待连接';
    if(!s.enabled)return '已暂停';
    if(!s.online)return '离线待传';
    if(!s.credential||error==='auth')return '连接需要处理';
    if(s.phase===modules.indexOf(id)+1)return '同步中';
    if(s.pending[id])return `${s.pending[id]} 项待上传`;
    if(id==='flashcards'&&!s.uploadFlash)return '正文已同步 · 附件上传已关闭';
    if(id==='flashcards'&&uploadPending(s,id))return '卡片已同步 · 附件未完成';
    if(id==='quick'&&uploadPending(s,id))return '正文已同步 · 附件未完成';
    if(id==='quick'&&!s.awaiting&&!s.uploadQuick)return '已写入日记 · 附件上传已关闭';
    if(id==='quick')return s.awaiting?`${s.awaiting} 条等待电脑写入`:'已写入日记';
    if(id==='reading'&&!s.media)return '正文已同步';
    if(id==='reading'&&uploadPending(s,id))return '正文已同步 · 附件未完成';
    return '已同步';
  }
  const pending=cloudPending(s),waiting=quickNeedsWriter(s),unsupported=s.modules.quick&&!quickSupported(s);
  const active=modules.some(m=>s.modules[m]&&(m!=='quick'||quickSupported(s))),clean=cloudComplete(s);
  const title=!s.connected?'连接云空间，开始同步':!s.enabled?'这台设备已暂停同步':s.phase?'正在同步':!s.credential||error==='auth'?'云连接需要更新':!s.online?'离线，改动已保留':!active?'选择要同步的内容':error||unsupported?'有项目需要处理':pending?'有内容等待同步':waiting?'云端已更新':'已同步';
  const description=!s.connected?'电脑和手机使用同一个云空间。':!s.enabled?'恢复后继续处理待同步内容。':s.phase?['','正在同步闪卡与复习记录…','正在同步阅读内容…','正在处理速记…','正在检查阅读附件…'][s.phase]:!s.online?'联网后可继续同步。':!active?'在同步设置中开启需要的内容。':'';
  const action=!s.connected?'连接云空间':!s.enabled?'恢复同步':!s.credential||error==='auth'?'更新凭据':!s.online?'查看离线说明':!active?'选择同步内容':unsupported&&!pending?'查看同步范围':error==='media'?'重试未完成项':'立即同步';
  const StatusIcon=!s.enabled?Pause:!s.online?WifiOff:s.phase?RefreshCw:clean?CloudCheck:error||unsupported?TriangleAlert:Cloud;
  return <section className={`cs-center${standalone?'':' cs-document'}`} aria-label={standalone?'内容与数据设置':'云同步中心'}>
    <header className="cs-topbar"><button onClick={onExit}><ArrowLeft size={17}/><span>{standalone?'返回来源页面':'返回 Hub'}</span></button><span>{standalone?<><FolderOpen size={17}/>设置</>:<><Cloud size={17}/>云同步</>}</span><span className="cs-demo-badge">交互演示</span></header>
    <div className="cs-scroll" ref={scrollRef}><div className="cs-wrap">
      <div className="cs-heading"><div><h1>{standalone?related[page]:pageNames[page as CloudPage]||'云同步'}</h1>{(standalone||page==='overview')&&<p>{standalone?'独立管理，设置仅保存在当前浏览器。':'闪卡、阅读与速记，在设备间接着用。'}</p>}</div></div>
      {standalone?<nav className="cs-tabs" aria-label="内容与数据设置">{(['cache','journal','sources','backup'] as RelatedSetting[]).map(id=><button key={id} aria-current={page===id?'page':undefined} onClick={()=>navigate(id)}>{related[id]}</button>)}</nav>:<nav className="cs-page-nav" aria-label="云同步导航">{(['overview','preferences','connection'] as CloudPage[]).map(id=><button key={id} aria-current={page===id?'page':undefined} onClick={()=>navigate(id)}>{id==='overview'?'概览':pageNames[id]}</button>)}</nav>}
      <h2 className="cs-sr-only" ref={headingRef} tabIndex={-1}>{related[page]||pageNames[page as CloudPage]}</h2>
      {notice&&<p className="cs-notice" role="status"><Check size={16}/>{notice}</p>}
      {page==='overview'&&<>
        <section className="cs-status" data-tone={error||unsupported?'warning':clean?'success':'neutral'} aria-label="当前同步状态"><div className="cs-status-symbol"><StatusIcon size={30} className={s.phase?'cs-spinning':''}/></div><div className="cs-status-copy" aria-live="polite"><h2>{title}</h2>{description&&<p>{description}</p>}<div className="cs-status-meta"><span>{s.connected?s.name:'尚未连接'}</span>{s.last&&<span>最近完成 {new Date(s.last).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</span>}{pending>0&&<span>{pending} 项待处理</span>}</div></div><button className="cs-primary" disabled={locked} onClick={primary}>{s.phase?<LoaderCircle size={16} className="cs-spinning"/>:<RefreshCw size={16}/>}<span>{s.phase?'正在同步…':action}</span></button>{!!s.phase&&<div className="cs-progress" role="progressbar" aria-label="演示同步进度" aria-valuenow={s.phase} aria-valuemin={0} aria-valuemax={4}><span style={{width:`${s.phase/4*100}%`}}/></div>}</section>
        <div className="cs-module-list cs-compact-list">{modules.map(id=><Row key={id} icon={id==='flashcards'?<BookOpenCheck size={21}/>:id==='reading'?<Bookmark size={21}/>:<PencilLine size={21}/>} title={moduleNames[id]}><div className="cs-module-result"><span className={!s.modules[id]?'is-muted':''}>{moduleStatus(id)}</span>{id==='quick'&&s.modules.quick&&<Link onClick={()=>navigate(quickSupported(s)?'journal':'preferences')}>查看</Link>}</div>{s.modules[id]&&<small className="cs-download-note">{attachmentSummary(s,id)}</small>}</Row>)}</div>
        {(error||!s.credential||unsupported)&&s.connected&&s.enabled&&s.online&&<section className="cs-issues" aria-label="需要关注"><h3>需要关注</h3>{error==='media'&&<div><span><strong>连接器说明.pdf 云副本未完成</strong><small>正文已同步，可重试未完成项。</small></span></div>}{(error==='auth'||!s.credential)&&<div><span><strong>连接凭据已失效</strong><small>更新凭据后继续，本机改动已保留。</small></span></div>}{unsupported&&<div><span><strong>当前 WebDAV 连接不支持速记</strong><small>闪卡与阅读可继续同步，速记保留在本机。</small></span></div>}</section>}
        <div className="cs-overview-footer"><span><ShieldCheck size={15}/>{!s.enabled?'已暂停':s.auto?'自动同步':'手动同步'} · 本设备</span><button disabled={locked||!s.connected} className="cs-link" onClick={()=>set({...s,enabled:!s.enabled})}>{s.enabled?'暂停此设备':'恢复此设备'}</button></div>
        <details className="cs-details"><summary>最近同步记录</summary>{s.log.length?s.log.map((l,i)=><p key={i}>{l}</p>):<p>尚无演示操作记录。</p>}</details>
      </>}
      {page==='preferences'&&<div className="cs-settings-page">
        <section className="cs-general-group" aria-label="同步方式与内容">
          <label className="cs-setting cs-mode-setting"><span><strong>同步方式</strong><small>管理这台设备的同步</small></span><select aria-label="同步方式" disabled={locked} value={!s.enabled?'paused':s.auto?'auto':'manual'} onChange={e=>set({...s,enabled:e.target.value!=='paused',auto:e.target.value==='paused'?s.auto:e.target.value==='auto'})}><option value="auto">自动同步</option><option value="manual">仅手动同步</option><option value="paused">暂停此设备</option></select></label>
          <div className="cs-scope-line"><span>同步内容</span><div className="cs-scope-picker">{modules.map(id=><Switch key={id} label={moduleNames[id]} hint="" checked={s.modules[id]} disabled={locked||id==='quick'&&!quickSupported(s)&&!s.modules.quick} onChange={()=>set(p=>({...p,modules:{...p.modules,[id]:!p.modules[id]}}))}/>)}</div></div>
          {s.modules.quick&&!quickSupported(s)&&<p className="cs-table-note">当前 WebDAV 连接不支持速记。</p>}
        </section>
        <section className="cs-transfer-section" aria-labelledby="cs-upload-heading">
          <div className="cs-transfer-heading"><span className="cs-direction-icon"><ArrowUp size={18}/></span><div><h3 id="cs-upload-heading">上传到云端</h3><p>正文与记录随同步上传，附件由你选择。</p></div></div>
          <div className="cs-group">{modules.map(id=><AttachmentPolicyRow key={id} id={id} s={s} locked={locked} direction="upload" onChange={change=>set(p=>setAttachmentUpload(p,id,change))}/>)}</div>
          <p className="cs-download-footnote">未选择或超出上限的附件留在本机，正文与记录照常同步。</p>
        </section>
        <section className="cs-transfer-section" aria-labelledby="cs-download-heading">
          <div className="cs-transfer-heading"><span className="cs-direction-icon"><ArrowDown size={18}/></span><div><h3 id="cs-download-heading">下载到本机</h3><p>选择自动下载的附件，超出上限时手动下载。</p></div></div>
          <div className="cs-group">{modules.map(id=><AttachmentPolicyRow key={id} id={id} s={s} locked={locked} onChange={change=>set(p=>setAttachmentDownload(p,id,change))}/>)}</div>
          <p className="cs-download-footnote">仅控制本机自动下载，不影响上传或已有文件。</p>
        </section>
        <details className="cs-details"><summary>更多设置与同步说明</summary><p>正文与记录包括卡片、复习进度、文章正文和状态等；其他附件包含音频及已支持的其他格式。速记正文由电脑写入日记，附件可随后补下载。速记仅支持 OSS。</p>
          <label className="cs-setting"><span><strong>阅读允许的网络</strong><small>约束阅读正文、附件和副本记录；不约束闪卡与速记。</small></span><select aria-label="阅读允许的网络" value={s.network} disabled={locked} onChange={e=>set({...s,network:e.target.value as CloudState['network']})}><option value="any">不限制网络</option><option value="unmetered">仅非计费网络</option><option value="wifi">仅非计费 Wi-Fi</option></select></label>
          <Link onClick={()=>navigate('cache')}>管理本机缓存与固定离线</Link>
        </details>
        <AttachmentDetails {...detailProps}/>
        <Link onClick={()=>navigate('connection')}>云连接 · {s.connected?s.name:'尚未连接'}</Link>
        <Link onClick={()=>navigate('advanced')}>同步诊断与修复</Link>
        <details className="cs-details"><summary>手机自动同步的范围</summary><p>阅读在打开或返回应用时补同步；Android 速记有独立后台任务，执行仍受系统约束。这里的自动同步只演示当前页面。</p></details><Link onClick={()=>navigate('journal')}>速记保存位置与电脑写入</Link>
      </div>}
      {page==='connection'&&<div className="cs-settings-page">
        <h2>{s.connected?'管理云空间':'连接一个云空间'}</h2>{!s.online&&<p role="status">当前离线，连接检查与迁移无法执行，原配置保留。</p>}{!s.enabled&&<p>此设备已暂停，需恢复云同步才能迁移内容。</p>}<p>日常无需修改连接。更新凭据与更换云空间分别处理。</p><div className="cs-connection-summary"><span className="cs-module-icon"><Cloud size={22}/></span><div><strong>{s.connected?s.name:'尚未连接'}</strong><p>{s.connected?(s.provider==='oss'?`${s.bucket} · ${s.region} · ${s.prefix}`:`${s.webdavUrl} · ${s.webdavUser}`):'电脑和手机使用同一个云空间'}</p></div>{s.connected&&<span className="cs-tag">当前连接</span>}</div>
        {!wizard&&<div className="cs-actions">{s.connected&&<><button className="cs-secondary" disabled={locked} onClick={()=>beginConnection('credentials')}><KeyRound size={15}/>更新凭据</button><button className="cs-secondary" disabled={locked||!s.credential||!s.online} onClick={()=>beginConnection('check')}>检查连接</button></>}<button className="cs-secondary" disabled={locked} onClick={()=>beginConnection(s.provider==='webdav'?'migrate':'location')}>{!s.connected?'连接阿里云 OSS':s.provider==='webdav'?'迁移到阿里云 OSS':'更换云空间'}<ChevronRight size={15}/></button>{s.provider==='webdav'&&<Link onClick={()=>beginConnection('legacy')}>查看旧 WebDAV 配置</Link>}</div>}
        {s.provider==='webdav'&&<p className="cs-warning">旧连接保留兼容，速记不受支持。完整退出方案仍待确定，原型不删除旧配置或云数据。</p>}
        {wizard&&<form className="cs-connect-form" onSubmit={e=>{e.preventDefault();if(wizard==='location')setWizard(s.connected?'migrate':'verify');else if(wizard==='legacy'&&(draftDav.url!==s.webdavUrl||draftDav.user!==s.webdavUser)){setMigrationTarget('webdav');setWizard('migrate');setAck(false);}else saveConnection();}}><h3>{wizard==='location'?'云空间位置':wizard==='credentials'?'更新连接凭据':wizard==='legacy'?'原有 WebDAV 配置':wizard==='migrate'?'确认迁移范围':'检查并连接'}</h3>
          {wizard==='location'&&<><label>连接名称<input required maxLength={60} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label><label>Bucket 名称<input required pattern="[a-z0-9][a-z0-9-]{1,61}[a-z0-9]" value={draft.bucket} onChange={e=>setDraft({...draft,bucket:e.target.value})}/></label><label>地域<select value={draft.region} onChange={e=>setDraft({...draft,region:e.target.value})}><option value="cn-hangzhou">杭州</option><option value="cn-shanghai">上海</option><option value="cn-beijing">北京</option></select></label><label>目录前缀<input maxLength={120} pattern="[a-zA-Z0-9_/-]*" value={draft.prefix} onChange={e=>setDraft({...draft,prefix:e.target.value})}/></label><p>位置变化才进入迁移；仅更新密钥请返回“更新凭据”。</p></>}
          {wizard==='credentials'&&<><p>{s.provider==='oss'?'AccessKey ID / Secret':'WebDAV 账号 / 密码'}：{s.credential?'已保存（示例）':'尚未提供（示例）'}</p><p>使用占位凭据，不接收或保存真实密钥。点击下方按钮模拟更新及读写检查。</p><button type="button" className="cs-secondary" disabled={connecting} onClick={()=>{set({...s,credential:false});setNotice('示例凭据已清除，本机内容和队列保留。');}}>清除示例凭据</button></>}
          {wizard==='legacy'&&<><label>服务器地址<input type="url" required value={draftDav.url} onChange={e=>setDraftDav({...draftDav,url:e.target.value})}/></label><label>账号<input required value={draftDav.user} onChange={e=>setDraftDav({...draftDav,user:e.target.value})}/></label><p>仅编辑示例账号与地址；位置或账号变化需迁移检查后才切换。密码在“更新凭据”单独处理。</p></>}
          {(wizard==='verify'||wizard==='migrate')&&<><p>{migrationTarget==='webdav'?draftDav.url: `${draft.name} · ${draft.bucket} · ${draft.region} · ${draft.prefix}`}</p><ul className="cs-check-list"><li><Check size={14}/>闪卡、复习记录与闪卡附件</li><li><Check size={14}/>阅读正文、记录与阅读附件</li></ul>{wizard==='migrate'&&<><p className="cs-warning">速记尚未纳入统一迁移与恢复，不能承诺随云空间迁移。</p>{quickMigrationBlocked(s)?<p role="alert">示例速记已绑定当前云空间，本轮禁止切换。请保留原连接，待速记迁移方案完成后继续。</p>:<label className="cs-check"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>其他设备已同步并暂停编辑与自动同步</label>}<p>读回核验通过后才切换；失败继续使用原连接，原云副本保留。</p></>}<p>目录读写、内容与附件读回全部使用示例数据。</p></>}
          {wizard!=='location'&&<label className="cs-check"><input type="checkbox" checked={checkFails} disabled={connecting} onChange={e=>setCheckFails(e.target.checked)}/>模拟连接检查失败</label>}{checkError&&<p role="alert" className="cs-warning">{checkError}</p>}
          <div className="cs-form-actions"><button type="button" className="cs-secondary" disabled={connecting} onClick={()=>{setWizard('');setCheckError('');}}>取消</button><button className="cs-primary" disabled={locked||wizard==='migrate'&&(!s.online||!s.enabled||!ack||quickMigrationBlocked(s))} type="submit">{connecting?<><LoaderCircle size={15} className="cs-spinning"/>正在检查…</>:wizard==='location'?'下一步':wizard==='migrate'?'开始闪卡与阅读迁移演示':wizard==='credentials'?'模拟更新并检查':wizard==='legacy'?'检查并保存示例配置':'检查演示连接'}</button></div>
        </form>}
      </div>}
      {page==='advanced'&&<div className="cs-settings-page"><p>遇到同步异常、长期离线或更换设备时再使用。</p>
        <details className="cs-details"><summary><Monitor size={16}/>设备记录</summary><DeviceDetails {...detailProps}/></details>
        <details className="cs-details"><summary><RefreshCw size={16}/>从云端恢复同步记录</summary><RepairDetails {...detailProps} kind="restore"/></details>
        <details className="cs-details"><summary><HardDrive size={16}/>云端历史整理</summary><RepairDetails {...detailProps} kind="history"/><details><summary>维护暂存与异常预留</summary><p>仅当旧批次无法继续或空间不足时释放本机维护暂存；重新预览会重新读取，原件与云内容保留。</p><button className="cs-secondary" onClick={()=>{set(p=>({...p,restoreStep:0,historyStep:0,repairFailed:false,repairPaused:false}));setNotice("已释放示例维护暂存，下次需重新预览；内容与附件保留。");}}>模拟释放本机维护暂存</button><p>流量预留仅在检测到异常时核对，不作为日常清理项。</p></details></details>

      </div>}
      {related[page]&&<div className="cs-settings-page">
        {page==='journal'&&<>{s.journalMigration==='migrated'&&<p className="cs-notice">已沿用旧原型的速记目录与分目录设置。</p>}{s.journalMigration==='kept'&&<p className="cs-note">已保留统一设置中的自定义目录，旧速记配置未覆盖它。</p>}<p>速记通过 OSS 中转，电脑是日记写入端。此处为关联设置演示。</p><div className="cs-flow" aria-label="速记处理状态"><span>待上传 <strong>{s.pending.quick}</strong></span><ArrowRight size={14}/><span>等待电脑 <strong>{s.awaiting}</strong></span><ArrowRight size={14}/><span>已写入 <strong>{s.written}</strong></span></div><label className="cs-setting"><span><strong>目标 Obsidian 资料库</strong><small>在电脑端指定。</small></span><select aria-label="速记目标资料库" value={s.journalLibrary} onChange={e=>set({...s,journalLibrary:e.target.value})}><option value="OS">OS</option><option value="示例日记库">示例日记库</option></select></label><label className="cs-setting"><span><strong>日记目录</strong><small>位于所选资料库内。</small></span><input aria-label="日记目录" maxLength={120} value={s.journalFolder} onChange={e=>{const v=e.target.value;if(!v.includes('..')&&!/[:\\]/.test(v)&&!v.startsWith('/'))set({...s,journalFolder:v});}}/></label><Switch label="按年 / 月分目录" hint="按记录日期写入对应日记。" checked={s.dateFolders} onChange={()=>set({...s,dateFolders:!s.dateFolders})}/><p>示例位置：{s.journalLibrary}/{s.journalFolder}/{s.dateFolders?'2026/11/':''}2026-11-08.md</p><p>保存位置变化只影响后续写入，不搬动已写入的日记。</p><p className="cs-warning">速记尚未纳入统一云空间迁移与恢复，请保留原连接。上传成功不等于写入完成。</p><button className="cs-secondary" disabled={locked||!s.modules.quick||!quickSupported(s)||!s.connected||!s.enabled||!s.online||!s.credential} onClick={()=>{set(p=>({...p,writerOnline:true,phase:1}));setNotice('已模拟电脑上线，本轮将接收速记并确认写入。');}}>模拟电脑上线并接收</button><Link onClick={()=>navigate('preferences')}>管理速记同步开关</Link></>}
        {page==='sources'&&<><p>来源采集把新内容带进 Hub；云同步负责设备之间的内容副本。</p><div className="cs-related">{['Craft','Obsidian','滴答','飞书','Telegram','X 书签','X 喜欢'].map(name=><details className="cs-source" key={name}><summary>{name} 来源账号与目录</summary><p>示例来源：{name==='Obsidian'?'OS 资料库':name==='滴答'?'阅读收件箱':name==='Telegram'?'已选频道':'我的空间'}。不连接真实账号。</p><button className="cs-secondary" onClick={()=>setNotice(`${name} 来源检查演示完成，未读取真实内容。`)}>检查示例来源</button></details>)}</div><details className="cs-details"><summary>采集内容与附件策略（示例）</summary>{([['sourceImages','保存图片原件'],['sourcePdf','保存 PDF 原件'],['sourceOriginals','保留其他支持的原附件']] as const).map(([key,label])=><Switch key={key} label={label} hint="按来源能力适用；不改变云同步上传范围。" checked={s[key]} onChange={()=>set({...s,[key]:!s[key]})}/>)}<p>文字识别、正文解析及单个资料库覆盖规则仍在资料库设置中；这里仅演示原件保存选项。</p></details><label className="cs-setting"><span><strong>来源更新频率</strong><small>与跨设备云同步分开设置。</small></span><select aria-label="来源更新频率" value={s.sourceMinutes} onChange={e=>set({...s,sourceMinutes:Number(e.target.value)})}><option value={0}>仅手动更新</option><option value={15}>每 15 分钟</option><option value={30}>每 30 分钟</option><option value={60}>每小时</option></select></label><Switch label="完整保存后删除滴答原内容" hint="默认保留；仅电脑端在本机、云端正文及全部原附件核验完整后逐项删除。" checked={s.cleanup} disabled={locked||!s.enabled||!s.modules.reading} onChange={()=>set({...s,cleanup:!s.cleanup})}/><p>关闭阅读、暂停云同步与来源清理各有条件；此处仅保存演示偏好，不触发真实删除。</p><button className="cs-secondary" onClick={()=>setNotice('来源更新演示完成，未向真实服务发起请求。')}>获取示例新内容</button></>}
        {page==='cache'&&<><CacheDetails {...detailProps}/><Link onClick={()=>navigate('preferences')}>调整附件下载方式</Link></>}
        {page==='backup'&&<BackupDetails {...detailProps}/>}
      </div>}
      {!standalone&&page==='preferences'&&<div className="cs-shortcuts"><details><summary>其他设置</summary><div>{(['journal','sources','cache','backup'] as RelatedSetting[]).map(id=><Link key={id} onClick={()=>navigate(id)}>{related[id]}</Link>)}</div></details></div>}
      {!standalone&&page!=='advanced'&&<footer className="cs-demo-tools"><div><strong>体验不同状态</strong><p>全部为示例，不传输真实内容。偏好自动保存在本浏览器。{!storageOk&&'当前无法保存。'}</p></div><select aria-label="切换同步演示状态" value={scenario} disabled={locked} onChange={e=>example(e.target.value)}><option value="pending">有改动待同步</option><option value="waiting">速记等待电脑写入</option><option value="unconnected">首次连接</option><option value="synced">已启用内容全部完成</option><option value="offline">离线待传</option><option value="flashmedia">闪卡附件未完成</option><option value="partial">正文成功，附件失败</option><option value="auth">凭据失效</option><option value="paused">本设备暂停</option><option value="legacy">旧 WebDAV 连接</option></select></footer>}
    </div></div>
  </section>;
}
