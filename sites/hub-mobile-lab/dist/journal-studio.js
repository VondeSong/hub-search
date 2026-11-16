'use strict';

// All mutations below belong to this browser prototype, never to OSS or an OS vault.
let journalSelection = null, journalEditorSession = null, journalSyncTimer = null, journalComposing = false;
function journalStore() {
  const j = st.journalStudio ||= {};
  for (const key of ['overrides','edits','history','annotations','trash']) if (!j[key] || typeof j[key] !== 'object' || Array.isArray(j[key])) j[key] = {};
  if (!Array.isArray(j.pins)) j.pins = ['journal-demo-d6'];
  return j;
}
function journalStudioRecords(includeTrash = false) {
  const j = journalStore();
  const examples = ['d6','d2','d1','d8'].filter(id => docs[id]).map(id => {
    const source = docs[id], day = source.date.match(/\s(\d+)\s日/);
    return { id:'journal-demo-'+id, sourceId:id, date:'2026-'+(source.date.startsWith('10')?'10':'11')+'-'+String(day?.[1]||'01').padStart(2,'0'), text:source.body, demo:true, attachments:[], syncState:'written', revision:0 };
  });
  return [...st.notes.map(n => ({...n,date:recordDay(n),syncState:n.syncState||'pending'})), ...examples].map(n => j.overrides[n.id] || n).filter(n => includeTrash || !j.trash[n.id]).sort((a,b) => typeof journalCompare==='function'?journalCompare(a,b):Number(j.pins.includes(b.id))-Number(j.pins.includes(a.id)) || b.date.localeCompare(a.date));
}
function journalFind(id, includeTrash = false) { return journalStudioRecords(includeTrash).find(n => n.id === id); }
function journalSignature(n) { return JSON.stringify([n.text, n.date, n.attachments||[], n.photos||[], n.revision||0]); }
function journalTransaction(change) {
  const previous = structuredClone(st);
  change();
  if (save() !== false) return true;
  st = previous;
  return false;
}
function journalMarkup(text, interactive = false) {
  const inline = value => esc(value).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/==([^=\n]+)==/g,'<mark>$1</mark>').replace(/(^|\s)(#[^\s#.,，。!?！？\[\]&<>]+)/gu, (all,space,tag) => space+(interactive?'<button type="button" class="journal-tag-link" data-act="journal-tag:'+encodeURIComponent(tag.slice(1))+'">'+tag+'</button>':'<span class="journal-inline-tag">'+tag+'</span>'));
  const lines = String(text||'').split('\n'), output = [], stack=[];
  const close=()=>{const item=stack.pop();if(item)output.push('</li></'+item.type+'>');};
  for (const line of lines) {
    const match=line.match(/^(\s*)(?:([-*]) |(\d+)\. )(.*)$/),type=match?(match[2]?'ul':'ol'):'',indent=match?.[1].replace(/\t/g,'  ').length||0;
    if(!match){while(stack.length)close();output.push('<div>'+(line?inline(line):'<br>')+'</div>');continue;}
    while(stack.length&&indent<stack[stack.length-1].indent)close();
    if(stack.length&&stack[stack.length-1].indent===indent&&stack[stack.length-1].type!==type)close();
    if(!stack.length||indent>stack[stack.length-1].indent){output.push('<'+type+(type==='ol'?' start="'+(Number(match[3])||1)+'"':'')+'>');stack.push({type,indent});}else output.push('</li>');
    output.push('<li>'+inline(match[4]));
  }
  while(stack.length)close();
  return output.join('');
}
function journalSerialize(editor) {
  const walk = node => {
    if (node.nodeType === 3) return node.nodeValue.replace(/[\u200b\ufeff]/g,'');
    if (node.nodeType !== 1) return '';
    if (node.tagName === 'BR') return '\n';
    const body = [...node.childNodes].map(walk).join('');
    if (['B','STRONG'].includes(node.tagName) || node.style?.fontWeight === 'bold' || Number(node.style?.fontWeight) >= 600) return body?'**'+body+'**':'';
    if (['UL','OL'].includes(node.tagName)) return [...node.children].filter(n=>n.tagName==='LI').map((li,i)=>{const nested=[...li.children].filter(n=>['UL','OL'].includes(n.tagName)),own=[...li.childNodes].filter(n=>!nested.includes(n)).map(walk).join('').trimEnd();return(node.tagName==='OL'?(i+(Number(node.getAttribute?.('start'))||1))+'. ':'- ')+own+nested.map(n=>'\n'+walk(n).trimEnd().split('\n').map(l=>'  '+l).join('\n')).join('');}).join('\n')+'\n';
    return ['DIV','P','BLOCKQUOTE'].includes(node.tagName)?body+(body.endsWith('\n')?'':'\n'):body;
  };
  return [...editor.childNodes].map(walk).join('').replace(/\n$/,'');
}
function journalFiltered() {
  const j = journalStore(), q = journalQuery.toLocaleLowerCase(), mode = j.filter||'all';
  return journalStudioRecords(mode==='trash').filter(n => (mode==='trash'?Boolean(j.trash[n.id]):!j.trash[n.id]) && (mode!=='pinned'||j.pins.includes(n.id)) && (mode!=='attachments'||recordAttachments(n).length||capturePhotos(n.photos).length) && (mode!=='untagged'||!journalTags(n.text).length) && (!q||(n.text+' '+recordAttachments(n).map(a=>a.name).join(' ')).toLocaleLowerCase().includes(q)) && (!journalTag||journalTags(n.text).includes(journalTag)) && (journalPeriod==='all'||journalPeriod==='today'&&n.date===localDay()||journalPeriod==='pending'&&!n.demo&&n.syncState!=='written'));
}
function journalStudioCard(n) {
  const j = journalStore(), long = n.text.length>240 || n.text.split('\n').length>8, expanded = journalExpanded.has(n.id);
  const selecting=route()[0]==='journal-select',picked=selecting&&journalPicked.has(n.id);
  return '<article class="journal-memo journal-studio-card'+(picked?' is-selected':'')+'" data-record-id="'+esc(n.id)+'">'+(selecting?'<button class="journal-card-selector" type="button" aria-label="选择记录 '+esc(n.date)+'" aria-pressed="'+picked+'" data-act="journal-pick:'+esc(n.id)+'">'+(picked?ico('check',16):'')+'</button>':'')+'<header><span>'+(j.pins.includes(n.id)?'<span class="journal-pin">置顶 · </span>':'')+esc(n.date||'日期未记录')+'</span><span class="journal-state" data-journal-state="'+esc(n.id)+'">'+esc(n.syncState==='written'?'':journalStatus(n))+'</span>'+iconBtn('记录操作','journal-menu:'+n.id,'more')+'</header><div class="journal-card-copy'+(long&&!expanded?' is-collapsed':'')+'" role="button" tabindex="0" data-act="'+(selecting?'journal-pick:':'journal-edit:')+esc(n.id)+'" aria-label="'+(selecting?'选择这条记录':'编辑这条记录')+'">'+journalMarkup(n.text,true)+'</div><div class="saved-capture-photos">'+attachmentMarkup(n)+'</div>'+(long?plain(expanded?'收起':'展开','journal-expand:'+n.id):'')+(j.trash[n.id]?plain('恢复记录','journal-restore:'+n.id):'')+'</article>';
}
function journalStudioHeader() {
  return '<button type="button" class="journal-back" data-act="go:browse" aria-label="返回浏览">'+ico('back',20)+'</button><h1 class="journal-page-title">日志</h1><div class="journal-header-actions">'+iconBtn('搜索日志','journal-search','search')+'<button type="button" class="icon-btn" data-act="journal-filters" aria-label="日志设置" aria-haspopup="dialog">'+ico('more',21)+'</button></div>';
}
const journalScopeLabels = {all:'全部记录',pinned:'置顶',attachments:'有附件',untagged:'无标签',trash:'回收站',today:'今天',pending:'待同步'};
function journalScopeDescription() {
  return [journalStore().filter&&journalStore().filter!=='all'&&journalScopeLabels[journalStore().filter],journalTag&&'#'+journalTag,journalPeriod!=='all'&&journalScopeLabels[journalPeriod]].filter(Boolean).join(' · ')||'全部记录';
}
function journalSyncSummary() {
  const records=journalStudioRecords().filter(n=>!n.demo), p=syncPreferences();
  const count=key=>records.filter(n=>n.syncState===key).length;
  if(st.offline)return {tone:'warn',icon:'cloud',label:'当前离线',detail:'记录保留在此浏览器',notice:true};
  if(count('error'))return {tone:'error',icon:'info',label:count('error')+' 条记录需重试',detail:'点此查看同步状态',notice:true};
  if(!p.enabled||!p.quick||!p.auto)return {tone:'quiet',icon:'cloud',label:!p.enabled||!p.quick?'速记同步已暂停':'自动同步已暂停',detail:'可在同步详情中查看与处理',notice:true};
  if(count('pending'))return {tone:'quiet',icon:'sync',label:count('pending')+' 条记录待上传',detail:'同步演示 · 原文已保留在此浏览器',notice:true};
  if(count('uploaded'))return {tone:'quiet',icon:'cloud',label:count('uploaded')+' 条记录等待电脑',detail:'同步演示 · 尚未写入 OS',notice:true};
  return {tone:'quiet',icon:'cloud',label:'同步状态',detail:'本机新建记录无待处理项 · 仅演示',notice:false};
}
function journalSyncNotice() {
  const s=journalSyncSummary();
  return s.notice?'<button type="button" class="journal-sync-notice" data-tone="'+s.tone+'" data-act="journal-sync-status">'+ico(s.icon,18)+'<span><strong>'+esc(s.label)+'</strong><small>'+esc(s.detail)+'</small></span>'+ico('chev',16)+'</button>':'';
}
function journalRefreshSyncNotice() {
  const region=document.querySelector('#journal-sync-notice');if(region){const html=journalSyncNotice();if(region.innerHTML!==html)region.innerHTML=html;}
}
function journalStudioPage() {
  const j = journalStore(), filtered = journalFiltered(), constrained = journalQuery || journalTag || journalPeriod!=='all' || j.filter&&j.filter!=='all';
  const floating = j.floating && journalFind(j.floating);
  return '<section class="journal-studio" aria-label="日志记录"><div class="journal-toolbar"><button type="button" class="journal-scope-trigger" data-act="journal-nav" aria-label="切换日志范围，当前：'+esc(journalScopeDescription())+'" aria-haspopup="dialog"><span>'+esc(journalScopeDescription())+'</span>'+ico('chevronDown',14)+'</button><div class="journal-shortcuts">'+plain('AI 洞察','go:insights','spark')+plain('每日回顾','journal-recap','clock')+'</div></div><div id="journal-sync-notice" aria-live="polite">'+journalSyncNotice()+'</div>'+(j.searchOpen?'<div class="journal-inline-search">'+searchInput('journal-query','搜索正文、标签或附件',journalQuery)+iconBtn('关闭日志搜索','journal-search-close','close')+'</div>':'')+(constrained?'<div class="journal-active-filter"><span data-journal-result-count>'+esc([journalQuery&&'搜索：'+journalQuery,filtered.length+' 条记录'].filter(Boolean).join(' · '))+'</span>'+plain('显示全部','journal-reset')+'</div>':'')+'<div id="journal-feed">'+(filtered.length?filtered.map(journalStudioCard).join(''):'<div class="empty-state"><h2>'+((journalQuery||constrained)?'没有符合条件的记录':'记下一点新的想法')+'</h2><p>'+((journalQuery||constrained)?'试试切换日志范围或清除条件。':'点下方的＋，开始写。')+'</p>'+plain('记一条','quick-capture:note')+'</div>')+'</div><div class="journal-create-dock"><button type="button" class="journal-create-button" aria-label="记一条" data-act="quick-capture:note">'+ico('plus',30)+'</button></div>'+(floating?'<aside class="journal-floating"><button type="button" data-act="journal-edit:'+esc(floating.id)+'">'+esc(floating.text.slice(0,28)||'附件记录')+'</button>'+iconBtn('关闭便览','journal-float-close','close')+'</aside>':'')+'</section>';
}
function journalEditorDraft(id) {
  const j=journalStore(), n=journalFind(id); if (!n) return null;
  return j.edits[id] ||= {text:n.text,date:n.date,attachments:structuredClone(n.attachments||[]),photos:structuredClone(n.photos||[]),base:journalSignature(n)};
}
function journalDraftFor(form) { return form?.dataset.editId?journalEditorDraft(form.dataset.editId):workflowDraft('note'); }
function journalTool(label, command, icon) { return '<button type="button" class="icon-btn" data-act="journal-format:'+command+'" aria-label="'+label+'" aria-pressed="false">'+(icon?ico(icon):label)+'</button>'; }
function journalStudioCaptureForm(draft, editId = '') {
  const count=recordAttachments(draft).length+capturePhotos(draft.photos).length, enabled=!attachmentBusy&&(draft.text?.trim()||count);
  return '<form id="quick-capture-form" class="memo-capture journal-rich-form" data-kind="note"'+(editId?' data-edit-id="'+esc(editId)+'"':'')+' novalidate><textarea id="quick-text" name="text" hidden>'+esc(draft.text||'')+'</textarea><div id="journal-rich" class="journal-rich-editor" data-journal-editor contenteditable="true" role="textbox" aria-label="此刻的想法" aria-multiline="true" data-placeholder="现在的想法是…">'+(draft.text?journalMarkup(draft.text):'')+'</div><div class="capture-photos">'+attachmentMarkup(draft,true)+'</div><p class="capture-error" role="alert"></p><div class="capture-toolbar journal-rich-toolbar"><div class="capture-tools">'+journalTool('插入标签','tag','hash')+iconBtn('添加照片','capture-photos','image')+(typeof voiceMic==='function'?'<button type="button" class="icon-btn" aria-label="语音记录" data-act="journal-voice">'+voiceMic()+'</button>':'')+'<span class="journal-tool-separator"></span>'+journalTool('加粗','bold','bold')+'<button type="button" class="icon-btn" aria-label="列表格式" aria-expanded="false" data-act="journal-list">'+ico('list')+'</button><span class="journal-tool-separator"></span><button type="button" class="icon-btn" aria-label="更多记录选项" aria-expanded="false" data-act="journal-more">'+ico('more')+'</button></div>'+(!editId?'<button type="submit" class="capture-send" aria-label="保存记录"'+(enabled?'':' disabled')+'>'+ico('send',21)+'</button>':'')+'</div><div class="journal-list-popover" hidden>'+journalTool('无序列表','insertUnorderedList','list')+journalTool('有序列表','insertOrderedList','')+journalTool('增加缩进','indent','')+journalTool('减少缩进','outdent','')+'</div><div class="capture-extra" hidden><label for="quick-date">记录日期</label><input id="quick-date" type="date" value="'+esc(draft.date||localDay())+'"><div class="capture-extra-tools">'+plain('添加文件','capture-files','paperclip')+plain('语音记录','journal-voice','chat')+'</div><p class="fine">每条最多9个附件，单个20 MB。保存到此浏览器。</p></div><input type="file" id="quick-photos" accept="image/*" multiple hidden><input type="file" id="quick-files" multiple hidden><div class="capture-meta"><span class="capture-status" role="status">'+(draft.text||count?'草稿已保留':'')+'</span><small id="capture-day-label">'+esc(draft.date===localDay()?'今天':draft.date||'今天')+'</small></div></form>';
}
function journalRecordPage(id, readOnly = false) {
  const n=journalFind(id); if (!n) return '<div class="empty-state"><h2>记录暂不可用</h2><p>它可能在回收站，或不在此浏览器。</p>'+btn('返回日志','go:logs')+'</div>';
  if (readOnly) return '<article class="journal-record-reader"><p class="journal-record-date">'+esc(n.date)+'</p><div class="journal-reader-copy">'+journalMarkup(n.text,true)+'</div><div class="saved-capture-photos">'+attachmentMarkup(n)+'</div>'+btn('编辑此记录','journal-edit:'+id,'outline')+'</article>';
  const draft=journalEditorDraft(id);
  journalEditorSession={id,state:structuredClone(history.state||{}),hash:location.hash};
  return '<section class="journal-full-editor"><p class="journal-record-date">'+esc(draft.date)+'</p>'+journalStudioCaptureForm(draft,id)+'</section>';
}
function journalEditorHeader(id) {
  const n=journalFind(id), d=n&&journalEditorDraft(id), dirty=n&&d&&journalDirty(n,d);
  return '<button type="button" id="journal-return" class="icon-btn'+(dirty?' has-change':'')+'" aria-label="'+(dirty?'保存修改并返回':'返回日志')+'" data-act="journal-finish">'+ico(dirty?'check':'back')+'</button><span class="sr-only">编辑日志</span>'+iconBtn('记录操作','journal-menu:'+id,'more');
}
function journalDirty(n,d) { return n.text!==d.text || n.date!==d.date || JSON.stringify(n.attachments||[])!==JSON.stringify(d.attachments||[]) || JSON.stringify(n.photos||[])!==JSON.stringify(d.photos||[]); }
function journalReadEditor(form) {
  const d=journalDraftFor(form), editor=form?.querySelector('[data-journal-editor]'); if (!d||!editor) return;
  d.text=journalSerialize(editor); form.querySelector('#quick-text').value=d.text;
  editor.dataset.empty=String(!d.text.trim());
  const date=form.querySelector('#quick-date'); if(date)d.date=date.value;
  if(!form.dataset.editId)st.draft=d.text;
}
function journalPersistEditor(form) {
  journalReadEditor(form);
  const ok=save()!==false, d=journalDraftFor(form), send=form.querySelector('[type=submit]');
  if(send)send.disabled=attachmentBusy||journalComposing||!(d.text.trim()||recordAttachments(d).length||capturePhotos(d.photos).length);
  form.querySelector('.capture-status').textContent=ok?'草稿已保存':'草稿暂未保存';
  if(!ok)form.querySelector('.capture-error').textContent='输入仍在此处，请保留页面并重试。';
  if(form.dataset.editId){const n=journalFind(form.dataset.editId),button=document.querySelector('#journal-return');if(n&&button){const dirty=journalDirty(n,d);button.innerHTML=ico(dirty?'check':'back');button.setAttribute('aria-label',dirty?'保存修改并返回':'返回日志');button.classList.toggle('has-change',dirty);}}
  return ok;
}
function journalCommitEdit(id, force = false) {
  const n=journalFind(id), d=journalEditorDraft(id); if(!n||!d)return false;
  const form=document.querySelector('form[data-edit-id="'+CSS.escape(id)+'"]');if(form)journalReadEditor(form);
  if(attachmentBusy){tell('附件仍在保存，请稍后再返回。');return false;}
  if(new TextEncoder().encode(d.text).length>100000){if(form)captureError(form,'正文超过100 KB，内容仍保留，请缩短后重试。');return false;}
  if(!d.text.trim()&&!recordAttachments(d).length&&!capturePhotos(d.photos).length){if(form)captureError(form,'记录不能为空；删除请从记录菜单移到回收站。');return false;}
  if(!validJournalDay(d.date)){if(form)captureError(form,'请选择有效日期。');return false;}
  if(!force&&d.base!==journalSignature(n)){if(form)captureError(form,'原记录已变化，草稿已保留。请从更多菜单查看当前版本后再核对。');return false;}
  return journalTransaction(()=>{
    const j=journalStore();
    if(journalDirty(n,d)){
      (j.history[id] ||= []).push({...structuredClone(n),savedAt:Date.now()});
      const updated={...n,text:d.text,date:d.date,journalDate:d.date,attachments:structuredClone(recordAttachments(d)),photos:structuredClone(capturePhotos(d.photos)),revision:(n.revision||0)+1,modifiedAt:Date.now(),syncState:'pending'};
      if(n.demo)j.overrides[id]=updated;else st.notes=st.notes.map(v=>v.id===id?updated:v);
    }
    delete j.edits[id];
  });
}
function journalFinishEdit() {
  const id=route()[1];if(!journalCommitEdit(id))return;
  journalEditorSession=null;back();journalQueueSync();
}
function journalBeforePop() {
  if(!journalEditorSession||route()[0]==='journal-edit')return false;
  const old=journalEditorSession;
  if(journalCommitEdit(old.id)){journalEditorSession=null;return false;}
  history.pushState(old.state,'',old.hash);render(false);return true;
}
function journalUpdateFeed() {
  const feed=document.querySelector('#journal-feed'); if(feed) { const anchor=window.scrollY;feed.innerHTML=journalFiltered().map(journalStudioCard).join('')||'<div class="empty-state"><p>没有符合条件的记录。</p>'+plain('清除筛选','journal-reset')+'</div>';void hydrateAttachmentImages(feed);window.scrollTo(0,anchor); }
  const count=document.querySelector('[data-journal-result-count]');if(count)count.textContent=[journalQuery&&'搜索：'+journalQuery,journalFiltered().length+' 条记录'].filter(Boolean).join(' · ');
  journalRefreshSyncNotice();
}
function journalSyncStatus() {
  const all=journalStudioRecords().filter(n=>!n.demo), p=syncPreferences(), count=key=>all.filter(n=>n.syncState===key).length;
  sheet('速记同步','<div class="journal-sync-summary">'+[['pending','待上传'],['uploaded','等电脑'],['written','已写入'],['error','需重试']].map(([key,t])=>'<span><strong>'+count(key)+'</strong>'+t+'</span>').join('')+'</div><p class="prose">'+(!p.enabled||!p.quick?'本设备速记同步已暂停。':!p.auto?'自动同步已暂停，仍可手动尝试。':st.offline?'当前离线，记录已保留。':'保存后会自动尝试，无需进入设置。')+'</p><p class="fine">交互演示：状态只在此浏览器变化，不上传真实OSS或写入OS。电脑离线时停留在等待电脑。</p><div class="actions">'+btn('立即重试','journal-sync','','sync')+plain('同步设置','go:sync','settings')+'</div>');
}
function journalRunSync(manual = false) {
  const p=syncPreferences();if(!p.enabled||!p.quick||!manual&&!p.auto||st.offline)return false;
  const ok=journalTransaction(()=>{for(const n of st.notes){if(n.syncState==='written')continue;n.syncState=st.syncError?'error':st.desktopOnline?'written':'uploaded';}for(const n of Object.values(journalStore().overrides)){if(n.syncState!=='written')n.syncState=st.syncError?'error':st.desktopOnline?'written':'uploaded';}});
  if(ok)journalUpdateFeed();return ok;
}
function journalQueueSync() {
  clearTimeout(journalSyncTimer);
  const p=syncPreferences();if(!p.enabled||!p.quick||!p.auto||st.offline)return;
  if(journalStudioRecords().some(n=>n.syncState==='pending'||n.syncState==='uploaded'&&st.desktopOnline))journalSyncTimer=setTimeout(()=>journalRunSync(false),850);
}
async function journalCopy(text) {
  try { if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(text);tell('已复制'); }
  catch { sheet('复制内容','<textarea class="journal-copy-fallback" readonly aria-label="可复制的内容">'+esc(text)+'</textarea><p class="fine">此浏览器未授予剪贴板权限，可长按选择后复制。</p>'); }
}
function journalMenu(id) {
  const n=journalFind(id,true);if(!n)return;
  const j=journalStore(), words=[...n.text.replace(/\*\*|^[-*]\s/gm,'')].length;
  const actions=[['置顶','pin'],['加入浮窗','float'],['相关笔记','related'],['查看详情','details'],['历史版本','history'],['复制链接','link'],['批注','annotate'],['设定日期','date'],['删除','delete']];
  sheet('记录操作','<div class="journal-action-menu" data-record-id="'+esc(id)+'"><div class="journal-menu-primary">'+[['分享','share','link'],['编辑','edit','note'],['复制','copy','copy']].map(([t,a,icon])=>'<button type="button" data-act="journal-'+a+':'+esc(id)+'">'+ico(icon,23)+'<span>'+t+'</span></button>').join('')+'</div><div class="journal-menu-options">'+actions.map(([t,a])=>'<button type="button"'+(a==='delete'?' class="is-destructive"':'')+' data-act="journal-'+a+':'+esc(id)+'">'+esc(a==='pin'&&j.pins.includes(id)?'取消置顶':t)+'</button>').join('')+'</div><footer><p>正文字符：'+words+'</p><p>创建日期：'+esc(n.createdAt?new Date(n.createdAt).toLocaleDateString('zh-CN'):'未记录')+'</p><p>最后编辑：'+esc(n.modifiedAt?new Date(n.modifiedAt).toLocaleDateString('zh-CN'):'未记录')+'</p></footer></div>');
}
function journalScopeMatches(n,key) {
  const j=journalStore();
  if(key==='trash')return Boolean(j.trash[n.id]);
  if(j.trash[n.id])return false;
  if(key==='pinned')return j.pins.includes(n.id);
  if(key==='attachments')return Boolean(recordAttachments(n).length||capturePhotos(n.photos).length);
  if(key==='untagged')return !journalTags(n.text).length;
  if(key==='today')return n.date===localDay();
  if(key==='pending')return !n.demo&&n.syncState!=='written';
  return key==='all';
}
function journalSetScope(key,tag='') {
  if(!Object.hasOwn(journalScopeLabels,key)&&key!=='tag')return false;
  const mode=['today','pending','tag'].includes(key)?'all':key;
  if(!journalTransaction(()=>{journalStore().filter=mode;journalStore().searchOpen=false;}))return false;
  journalTag=key==='tag'?tag:'';journalPeriod=['today','pending'].includes(key)?key:'all';journalQuery='';
  return true;
}
function journalNavigation() {
  const j=journalStore(), all=journalStudioRecords(true), current=journalTag?'tag:'+journalTag:journalPeriod!=='all'?journalPeriod:j.filter||'all';
  const option=(label,action,icon,count,selected)=>'<button type="button" class="journal-scope-option" data-act="'+esc(action)+'" aria-pressed="'+selected+'">'+ico(icon,19)+'<span>'+esc(label)+'</span><small aria-label="'+count+' 条记录">'+count+'</small>'+(selected?ico('check',18):'<span class="journal-scope-check" aria-hidden="true"></span>')+'</button>';
  const choices=[['all','note'],['today','calendar'],['pinned','pin'],['attachments','paperclip'],['untagged','tag'],['pending','sync'],['trash','trash']];
  const tags=[...new Set(all.filter(n=>!j.trash[n.id]).flatMap(n=>journalTags(n.text)))];
  sheet('日志范围','<div class="journal-scope-options"><div class="journal-scope-list">'+choices.map(([key,icon])=>option(journalScopeLabels[key],'journal-scope:'+key,icon,all.filter(n=>journalScopeMatches(n,key)).length,current===key)).join('')+'</div>'+(tags.length?'<div class="journal-scope-tags"><h3>标签</h3>'+tags.map(t=>option('#'+t,'journal-scope-tag:'+encodeURIComponent(t),'tag',all.filter(n=>!j.trash[n.id]&&journalTags(n.text).includes(t)).length,current==='tag:'+t)).join('')+'</div>':'')+'<p class="fine">选择后立即切换范围 · 示例与本机记录</p></div>');
}
function journalRichForm() { return document.querySelector('#sheet[open] .journal-rich-form')||document.querySelector('.journal-rich-form'); }
function journalRememberSelection() {
  const editor=journalRichForm()?.querySelector('[data-journal-editor]'),s=window.getSelection?.();
  if(editor&&s?.rangeCount&&editor.contains(s.getRangeAt(0).commonAncestorContainer))journalSelection=s.getRangeAt(0).cloneRange();
}
function journalCommand(command) {
  const form=journalRichForm(),editor=form?.querySelector('[data-journal-editor]');if(!editor||journalComposing)return;
  editor.focus({preventScroll:true});const selection=window.getSelection();
  if(journalSelection&&editor.contains(journalSelection.commonAncestorContainer)){selection.removeAllRanges();selection.addRange(journalSelection);}
  // shortcut: native editing commands retain prototype undo; the Android editor needs its own IME-tested adapter.
  let success=false;try{success=document.execCommand(command==='tag'?'insertText':command,false,command==='tag'?'#':null);}catch{}
  if(!success){tell('此浏览器未完成格式操作，请保留当前文字。');return;}
  form.querySelector('.journal-list-popover').hidden=true;
  journalRememberSelection();journalPersistEditor(form);journalToolbarState();
}
function journalToolbarState() {
  const f=journalRichForm();if(!f)return;
  for(const key of ['bold','insertUnorderedList','insertOrderedList']){const b=f.querySelector('[data-act="journal-format:'+key+'"]');if(b)try{b.setAttribute('aria-pressed',String(document.queryCommandState(key)));}catch{}}
}
function journalStudioInput(event) {
  const el=event.target, form=el.closest?.('.journal-rich-form');if(!form||el.type==='file')return false;
  if(el.matches('[data-journal-editor]')||el.id==='quick-date'){journalPersistEditor(form);return true;}
  return false;
}
function journalStudioSubmit(form) {
  if(form.id==='journal-date-form'){
    const n=journalFind(form.dataset.id), date=form.querySelector('input').value;if(!n||!validJournalDay(date))return true;
    if(route()[0]==='journal-edit'&&route()[1]===n.id){const d=journalEditorDraft(n.id);d.date=date;if(save()!==false){close();render();}return true;}
    if(journalTransaction(()=>{const j=journalStore();(j.history[n.id]||=[]).push({...structuredClone(n),savedAt:Date.now()});const next={...n,date,journalDate:date,revision:(n.revision||0)+1,modifiedAt:Date.now(),syncState:'pending'};if(n.demo)j.overrides[n.id]=next;else st.notes=st.notes.map(v=>v.id===n.id?next:v);})){close();render();journalQueueSync();}return true;
  }
  if(form.id==='journal-annotation-form'){const text=form.querySelector('textarea').value.trim();if(text&&journalTransaction(()=>{(journalStore().annotations[form.dataset.id]||=[]).push({text,at:Date.now()});})){journalDetails(form.dataset.id);}return true;}
  if(form.matches('.journal-rich-form')){journalReadEditor(form);if(form.dataset.editId){journalFinishEdit();return true;}}
  if(form.matches('.journal-rich-form')&&new TextEncoder().encode(journalDraftFor(form).text).length>100000){captureError(form,'正文超过100 KB，内容仍保留，请缩短后重试。');return true;}
  return false;
}
function journalDetails(id) {
  const n=journalFind(id);if(!n)return;
  sheet('记录详情','<p class="prose">'+esc(n.date)+' · '+esc(journalStatus(n))+'</p><p class="fine">此浏览器记录 · '+(n.demo?'示例':'本机')+'，版本 '+(n.revision||0)+'</p><div class="journal-detail-text">'+journalMarkup(n.text)+'</div>'+attachmentMarkup(n)+section('批注',group((journalStore().annotations[id]||[]).map(a=>'<p class="journal-annotation">'+esc(a.text)+'</p>').join(''),'还没有批注'))+plain('添加批注','journal-annotate:'+id));
  void hydrateAttachmentImages();
}
function journalStudioAction(a,key) {
  if(typeof journalFeedToolsAction==='function'&&journalFeedToolsAction(a,key))return true;
  if(a==='journal-photo'){sheet('照片','<div class="journal-photo-view"><img data-local-image="'+esc(key)+'" alt="照片原图" hidden><span class="attachment-loading">照片加载中</span></div>'+plain('保存原图','download-attachment:'+key));void hydrateAttachmentImages();return true;}
  if(a==='journal-version'||a==='journal-version-restore'){
    const split=key?.lastIndexOf('~'),id=split>0?key.slice(0,split):'',index=Number(key?.slice(split+1));
    const current=journalFind(id),version=journalStore().history[id]?.[index];
    if(!current||!Number.isInteger(index)||index<0||!version){tell('该版本暂不可用');return true;}
    if(a==='journal-version'){sheet('历史版本','<p class="fine">'+esc(version.date)+' · 版本 '+(version.revision||0)+'</p><div class="journal-detail-text">'+journalMarkup(version.text)+'</div>'+btn('恢复此版本','journal-version-restore:'+key)+'<p class="fine">恢复前会保留当前版本，原记录身份不变。</p>');return true;}
    if(journalStore().edits[id]&&journalDirty(current,journalStore().edits[id])){tell('请先保存或核对正在编辑的草稿，再恢复历史版本。');return true;}
    if(journalTransaction(()=>{const j=journalStore();j.history[id].push({...structuredClone(current),savedAt:Date.now()});const next={...structuredClone(version),id,revision:(current.revision||0)+1,modifiedAt:Date.now(),syncState:'pending'};delete next.savedAt;if(current.demo)j.overrides[id]=next;else st.notes=st.notes.map(v=>v.id===id?next:v);delete j.edits[id];})){close();render();journalQueueSync();tell('已恢复，原版本保留在历史中');}return true;
  }
  const n=key&&journalFind(key,true), j=journalStore();
  if(a==='journal-menu'){journalMenu(key);return true;}
  if(a==='journal-edit'){if(n)go('journal-edit/'+key);return true;}
  if(a==='journal-finish'){journalFinishEdit();return true;}
  if(a==='journal-nav'||a==='journal-filters'){journalNavigation();return true;}
  if(a==='journal-scope'||a==='journal-scope-tag'){if(journalSetScope(a==='journal-scope-tag'?'tag':key,a==='journal-scope-tag'?decodeURIComponent(key):'')){close();render();}return true;}
  if(a==='journal-search'){j.searchOpen=true;render();requestAnimationFrame(()=>document.querySelector('#journal-query')?.focus());return true;}
  if(a==='journal-search-close'){j.searchOpen=false;journalQuery='';render();return true;}
  if(a==='journal-filter'||a==='journal-period'){if(journalSetScope(key)){close();render();}return true;}
  if(a==='journal-tag'){if(journalSetScope('tag',decodeURIComponent(key))){if(route()[0]==='logs'){close();render();}else go('logs');}return true;}
  if(a==='journal-reset'){if(journalSetScope('all'))render();return true;}
  if(a==='journal-sync-status'){journalSyncStatus();return true;}
  if(a==='journal-sync'){journalRunSync(true);journalSyncStatus();return true;}
  if(a==='journal-list'||a==='journal-more'){const f=journalRichForm();if(f){const panel=f.querySelector(a==='journal-list'?'.journal-list-popover':'.capture-extra');panel.hidden=!panel.hidden;f.querySelector('[data-act="'+a+'"]').setAttribute('aria-expanded',String(!panel.hidden));}return true;}
  if(a==='journal-format'){journalCommand(key);return true;}
  if(a==='journal-voice'){sheet('语音记录','<p class="prose">录音、原音回听和实时转写将使用同一条记录。</p><p class="fine">语音服务尚未接入此网页原型。当前可保留文字草稿，或通过“更多 → 添加文件”保存已有音频，不会发送给转写服务。</p>'+plain('继续原草稿','quick-capture:note'));return true;}
  if(a==='journal-recap'){go('recap');return true;}
  if(a==='journal-shortcut'){sheet('控制中心 · 记一条','<p class="prose">从手机下拉控制中心点“记一条”，直接打开同一份草稿。</p><p class="fine">网页只能预演入口；真正添加系统磁贴由Android #54接入，本站不会修改手机控制中心。</p>'+btn('预演记一条','quick-capture:note'));return true;}
  if(a==='journal-float-close'){delete j.floating;save();render();return true;}
  if(['capture-remove-file','capture-remove-photo'].includes(a)&&journalRichForm()){const f=journalRichForm(),d=journalDraftFor(f),previous=structuredClone(d);if(a==='capture-remove-file')d.attachments=recordAttachments(d).filter(v=>v.id!==key);else d.photos=capturePhotos(d.photos).filter((v,i)=>i!==Number(key));if(save()===false)Object.assign(d,previous);f.querySelector('.capture-photos').innerHTML=attachmentMarkup(d,true);updateCaptureSubmit(f);void hydrateAttachmentImages(f);return true;}
  if(!a.startsWith('journal-')||!n)return false;
  if(a==='journal-copy'){void journalCopy(n.text);return true;}
  if(a==='journal-link'){void journalCopy(location.origin+location.pathname+'#journal-record/'+encodeURIComponent(n.id));return true;}
  if(a==='journal-share'){if(navigator.share)void navigator.share({title:'Hub 日志',text:n.text}).catch(e=>{if(e.name!=='AbortError')tell('分享未完成，原记录保留。');});else sheet('分享记录','<div class="journal-detail-text">'+journalMarkup(n.text)+'</div>'+btn('复制正文','journal-copy:'+key,'outline','copy')+'<p class="fine">当前浏览器未提供系统分享，可先复制正文。</p>');return true;}
  if(a==='journal-pin'){if(journalTransaction(()=>{j.pins=j.pins.includes(key)?j.pins.filter(id=>id!==key):[...j.pins,key];})){close();render();}return true;}
  if(a==='journal-float'){if(journalTransaction(()=>{j.floating=key;})){close();render();tell('已加入应用内便览');}return true;}
  if(a==='journal-related'){const tags=new Set(journalTags(n.text)),related=journalStudioRecords().filter(v=>v.id!==key&&journalTags(v.text).some(t=>tags.has(t)));sheet('相关笔记',group(related.map(v=>row(v.text.slice(0,40),v.date,'note','journal-edit:'+v.id)).join(''),'还没有共享标签的记录')+'<p class="fine">按相同标签关联，不生成或猜测AI关系。</p>');return true;}
  if(a==='journal-details'){journalDetails(key);return true;}
  if(a==='journal-history'){const historyItems=j.history[key]||[];sheet('历史版本','<p class="fine">仅此浏览器实际保存的版本，恢复会保留当前版本。</p>'+group(historyItems.map((v,i)=>row('版本 '+(v.revision||0),v.date+' · '+v.text.slice(0,36),'clock','journal-version:'+key+'~'+i)).reverse().join(''),'还没有修改历史'));return true;}
  if(a==='journal-annotate'){sheet('添加批注','<form id="journal-annotation-form" data-id="'+esc(key)+'"><label for="journal-annotation">批注内容</label><textarea id="journal-annotation" rows="5" required maxlength="4000"></textarea><p class="fine">批注单独保存，不改动原正文。</p><button class="btn" type="submit">保存批注</button></form>');return true;}
  if(a==='journal-date'){sheet('设定日期','<form id="journal-date-form" data-id="'+esc(key)+'"><label for="journal-date-choice">记录日期</label><input id="journal-date-choice" type="date" value="'+esc(n.date)+'" required><p class="fine">调整此浏览器的归属日，记录身份保持。</p><button type="submit" class="btn">保存日期</button></form>');return true;}
  if(a==='journal-delete'){sheet('删除记录','<p class="prose">移到回收站？正文、附件和历史会保留，可以恢复。</p><div class="actions">'+btn('移到回收站','journal-delete-confirm:'+key,'danger')+plain('取消','close')+'</div>');return true;}
  if(a==='journal-delete-confirm'){if(journalTransaction(()=>{j.trash[key]={at:Date.now()};})){go('logs');tell('已移到回收站');}return true;}
  if(a==='journal-restore'){if(journalTransaction(()=>{delete j.trash[key];})){close();render();}return true;}
  return false;
}
function journalStudioAfterRender() {
  const p=route()[0];
  if(!['logs','journal-edit','journal-record'].includes(p))journalEditorSession=null;
  const d=document.querySelector('#sheet');if(d)d.classList.toggle('journal-capture-sheet',Boolean(d.querySelector('.journal-rich-form')&&!d.querySelector('[data-edit-id]')));
  if(d)d.classList.toggle('journal-menu-sheet',Boolean(d.querySelector('.journal-action-menu')));
  if(d){d.classList.remove('journal-view-sheet');d.classList.toggle('journal-tools-sheet',Boolean(d.querySelector('.journal-view-options,.journal-scope-options,.journal-sync-summary')));}
  if(d)d.classList.toggle('journal-filter-sheet',Boolean(d.querySelector('#journal-search-filter-form')));
  const editor=journalRichForm()?.querySelector('[data-journal-editor]');
  if(editor&&!editor.dataset.ready){editor.dataset.ready='true';requestAnimationFrame(()=>editor.focus({preventScroll:true}));}
  journalQueueSync();
}
document.addEventListener('selectionchange',()=>{journalRememberSelection();journalToolbarState();});
document.addEventListener('pointerdown',event=>{if(event.target.closest('[data-act^="journal-format:"],[data-act="journal-list"],[data-act="journal-more"]')){journalRememberSelection();event.preventDefault();}},true);
document.addEventListener('compositionstart',event=>{if(event.target.matches('[data-journal-editor]'))journalComposing=true;});
document.addEventListener('compositionend',event=>{if(event.target.matches('[data-journal-editor]')){journalComposing=false;journalPersistEditor(event.target.closest('form'));}});
document.addEventListener('paste',event=>{if(!event.target.matches('[data-journal-editor]'))return;event.preventDefault();const text=event.clipboardData.getData('text/plain');try{document.execCommand('insertText',false,text);}catch{}journalPersistEditor(event.target.closest('form'));});
document.addEventListener('keydown',event=>{if(event.target.matches('[data-journal-editor]')&&(event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.isComposing){event.preventDefault();event.target.closest('form').requestSubmit();}else if(event.key==='Enter'&&event.target.matches('.journal-card-copy[role=button]')){event.preventDefault();go('journal-edit/'+event.target.closest('[data-record-id]').dataset.recordId);}});
