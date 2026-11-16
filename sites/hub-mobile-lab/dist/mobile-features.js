'use strict';

// Browser-only prototype: cloud/OS transitions are explicit demonstrations.
let journalQuery = '', journalTag = '', journalPeriod = 'all', reviewTab = 'today', attachmentBusy = false;
let attachmentDatabase, syncControlsOpen = false;
const attachmentUrls = new Map();
const journalExpanded = new Set();
const inboxExamples = [
  { id: 'demo-card-inbox-1', q: '纸面原型与实机验证的进展分别是什么？', a: '纸面原型的核对已完成，实机验证仍未开始；下一步用小样本核对交互与数据回读。', deck: 'Hub 使用', doc: 'd5' },
  { id: 'demo-card-inbox-2', q: '一条阅读摘录怎样更容易在下次使用？', a: '保留来源，并记下它与当前问题的关系。', deck: '阅读方法', doc: 'd3' },
];
function localDay() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function validJournalDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const d = new Date(value + 'T12:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function recordDay(note) {
  if (validJournalDay(note.journalDate)) return note.journalDate;
  if (validJournalDay(note.date)) return note.date;
  const m = String(note.date || '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(note.createdAt);
  return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : '';
}
function journalTags(text) {
  return [...new Set([...String(text || '').matchAll(/(?:^|\s)#([^\s#.,，。!?！？\[\]<>]+)/gu)].map(m => m[1]))];
}
function syncPreferences() {
  return st.deviceSync ||= { enabled: true, quick: true, auto: true };
}
function commitMobile(change, notice = '') {
  const controls = document.querySelector('.demo-controls');
  if (controls) syncControlsOpen = controls.open;
  const old = structuredClone(st);
  change();
  if (save() === false) { st = old; return false; }
  render();
  if (notice) tell(notice);
  return true;
}
function prototypeHint() {
  return '<p class="prototype-note">交互原型 · 数据保存在当前浏览器，云同步与 OS 写入为模拟。</p>';
}

function openAttachmentDatabase() {
  if (!attachmentDatabase) attachmentDatabase = new Promise((resolve, reject) => {
    const request = indexedDB.open('hub-mobile-attachments', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('附件存储不可用，请保留页面后重试。'));
  }).catch(error => { attachmentDatabase = null; throw error; });
  return attachmentDatabase;
}
async function attachmentTransaction(mode, operation) {
  const db = await openAttachmentDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode), request = operation(tx.objectStore('files'));
    let result;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(new Error('附件未能保存，原输入已保留。'));
  });
}
function recordAttachments(record) {
  return Array.isArray(record.attachments) ? record.attachments.filter(a => a && typeof a.id === 'string' && typeof a.name === 'string') : [];
}
function attachmentMarkup(record, removable = false) {
  const legacy = capturePhotoStrip(record.photos, removable);
  const files = recordAttachments(record).map(a => '<figure class="capture-file">' +
    (a.voice ? '<button type="button" class="voice-attachment" data-act="voice-open:'+esc(a.id)+'">'+voiceMic()+'<span>'+esc(a.name)+'<small>'+voiceTime(a.voice.elapsed)+' · '+(a.voice.mode==='demo'?'转录演示': '本机原音 · 文字待转写')+'</small></span></button>' : a.image ? '<button type="button" class="journal-photo-open" aria-label="查看照片 '+esc(a.name)+'" data-act="journal-photo:'+esc(a.id)+'"><img data-local-image="' + esc(a.id) + '" alt="' + esc(a.name) + '" hidden><span class="attachment-loading">照片加载中</span></button>' : '<button type="button" data-act="download-attachment:'+esc(a.id)+'">'+ico('note',25)+' '+esc(a.name)+'</button>') +
    (removable ? '<span class="file-name">' + esc(a.name) + '</span><button type="button" aria-label="移除附件 ' + esc(a.name) + '" data-act="capture-remove-file:' + esc(a.id) + '">' + ico('close',14) + '</button>' : '') + '</figure>').join('');
  return legacy + files;
}
async function hydrateAttachmentImages(root = document) {
  for (const img of root.querySelectorAll('img[data-local-image]')) {
    try {
      const id = img.dataset.localImage;
      let url = attachmentUrls.get(id);
      if (!url) {
        const blob = await attachmentTransaction('readonly', store => store.get(id));
        if (!blob) throw new Error('本机附件缺失');
        url = URL.createObjectURL(blob); attachmentUrls.set(id, url);
      }
      if (!img.isConnected) continue;
      img.src = url; img.hidden = false;
      img.nextElementSibling?.classList.contains('attachment-loading') && img.nextElementSibling.remove();
    } catch {
      if (img.isConnected && img.nextElementSibling) img.nextElementSibling.textContent = '照片暂不可用，原记录仍保留';
    }
  }
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function downloadAttachment(id) {
  try {
    const meta = (typeof journalStudioRecords==='function'?journalStudioRecords(true):st.notes).flatMap(recordAttachments).find(a => a.id === id);
    const blob = await attachmentTransaction('readonly', store => store.get(id));
    if (!meta || !blob) throw new Error('本机附件缺失，原记录仍保留。');
    downloadBlob(blob, meta.name);
  } catch (error) { tell(error.message); }
}
async function addCaptureAttachments(input) {
  if (attachmentBusy || !input.files?.length) return;
  const draft = typeof journalDraftFor === 'function' ? journalDraftFor(input.form) : workflowDraft('note'), files = [...input.files], added = [];
  attachmentBusy = true; updateCaptureSubmit(input.form);
  input.form.querySelector('.capture-status').textContent = '正在保存附件…';
  let errorText = '';
  try {
    if (files.length + recordAttachments(draft).length + capturePhotos(draft.photos).length > 9) throw new Error('每条最多添加 9 个附件。');
    for (const file of files) if (file.size > 20 * 1024 * 1024) throw new Error(file.name + ' 超过 20 MB，请选择较小的文件。');
    for (const file of files) {
      const id = crypto.randomUUID();
      await attachmentTransaction('readwrite', store => store.put(file, id));
      added.push({ id, name: file.name, size: file.size, type: file.type, image: /^image\/(png|jpeg|webp|gif)$/.test(file.type) });
    }
    const old = draft.attachments;
    draft.attachments = [...recordAttachments(draft), ...added];
    if (save() === false) { draft.attachments = old; throw new Error('附件列表未能保存，请重试。原输入已保留。'); }
  } catch (error) {
    errorText = error.message;
    for (const a of added) await attachmentTransaction('readwrite', store => store.delete(a.id)).catch(() => {});
  } finally {
    attachmentBusy = false; input.value = '';
    const form = input.form || document.querySelector('#quick-capture-form[data-kind="note"]');
    if (form) {
      form.querySelector('.capture-photos').innerHTML = attachmentMarkup(typeof journalDraftFor === 'function' ? journalDraftFor(form) : workflowDraft('note'), true);
      updateCaptureSubmit(form); void hydrateAttachmentImages(form);
      form.querySelector('.capture-status').textContent = errorText ? '输入已保留' : '草稿已保存';
      form.querySelector('.capture-error').textContent = errorText;
    }
  }
}

function journalRecords() {
  if (typeof journalStudioRecords === 'function') return journalStudioRecords();
  const examples = ['d6','d2','d1','d8'].map(id => ({ id, date: `2026-${docs[id].date.startsWith('10') ? '10' : '11'}-${docs[id].date.match(/\s(\d+)\s日/)[1].padStart(2,'0')}`, text: docs[id].body, demo: true, syncState: 'written', attachments: [] }));
  return [...st.notes.map(n => ({ ...n, date: recordDay(n), syncState: n.syncState || 'pending' })), ...examples].sort((a,b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
}
function journalStatus(note) {
  return ({ pending: '已保存本机 · 待上传', uploaded: '示例 · 已上传，等待电脑', written: '示例 · 已写入 OS', error: '示例 · 上传失败' })[note.syncState] || '已保存本机';
}
function journalCard(note) {
  if (typeof journalStudioCard === 'function') return journalStudioCard(note);
  const long = note.text.length > 280 || note.text.split('\n').length > 7;
  const expanded = journalExpanded.has(note.id);
  return '<article class="journal-memo" data-record-id="' + esc(note.id) + '"><header><span>' + esc(note.date || '日期未记录') + '</span><span class="journal-state ' + (note.syncState === 'error' ? 'has-error' : '') + '">' + esc(journalStatus(note)) + '</span></header>' +
    '<div class="journal-memo-body' + (long && !expanded ? ' is-collapsed' : '') + '">' + captureNoteBody(note.text) + '</div>' +
    '<div class="saved-capture-photos">' + attachmentMarkup(note) + '</div>' +
    (recordAttachments(note).length ? '<div class="journal-file-links">' + recordAttachments(note).map(a => plain('保存 ' + a.name, 'download-attachment:' + a.id, 'note')).join('') + '</div>' : '') +
    '<footer>' + (long ? plain(expanded ? '收起' : '展开全文', 'journal-expand:' + note.id) : '') + journalTags(note.text).map(t => chip('#' + t, 'journal-tag:' + encodeURIComponent(t), journalTag === t)).join('') +
    (note.syncState === 'error' ? plain('重试演示', 'journal-sync', 'sync') : '') + (note.demo ? plain('查看当日日记示例','go:doc/'+note.id,'link') : '') + '</footer></article>';
}
function journalFeed() {
  const records = journalRecords().filter(n => (!journalQuery || (n.text + ' ' + recordAttachments(n).map(a=>a.name).join(' ')).toLocaleLowerCase().includes(journalQuery.toLocaleLowerCase())) && (!journalTag || journalTags(n.text).includes(journalTag)) && (journalPeriod === 'all' || journalPeriod === 'today' && n.date === localDay() || journalPeriod === 'pending' && !n.demo && n.syncState !== 'written'));
  return records.map(journalCard).join('') || '<div class="empty-state"><h2>这里还没有记录</h2><p>写下一个想法，或放宽日期与标签筛选。</p>' + btn('记一条','quick-capture:note') + plain('清除筛选','journal-reset') + '</div>';
}
function journalPage() {
  if (typeof journalStudioPage === 'function') return journalStudioPage();
  const pending = st.notes.filter(n => (n.syncState || 'pending') !== 'written').length;
  const tags = [...new Set(journalRecords().flatMap(n => journalTags(n.text)))];
  return intro('日志','按天留下想法，随时回来接着看。') + prototypeHint() +
    '<div class="journal-sync-line"><span>' + (pending ? pending + ' 条本机记录待同步演示' : '暂无待同步演示的本机记录') + '</span>' + plain('同步状态','go:sync','sync') + '</div>' +
    '<div class="journal-search">' + searchInput('journal-query','搜索记录或附件',journalQuery) + '<label class="journal-tag-select">标签<select id="journal-tag" aria-label="筛选速记标签"><option value="">全部标签</option>' + tags.map(t=>'<option value="'+esc(t)+'"'+(journalTag===t?' selected':'')+'>'+esc('#'+t)+'</option>').join('') + '</select></label></div>' +
    '<div class="filter">' + [['all','全部'],['today','今天'],['pending','待同步']].map(([key,t])=>chip(t,'journal-period:'+key,journalPeriod===key)).join('') + plain('记一条','quick-capture:note','plus') + '</div><div id="journal-feed">' + journalFeed() + '</div>';
}
function allMobileLabels() {
  return [...new Set([...labels, ...st.notes.flatMap(n => journalTags(n.text))])];
}
function labelFromRoute(id) {
  if (typeof id !== 'string') return '';
  try { return id.startsWith('tag-') ? decodeURIComponent(id.slice(4)) : /^\d+$/.test(id) ? labels[Number(id)] || '' : decodeURIComponent(id); }
  catch { return ''; }
}
function mobileTagItems(label) {
  return Object.keys(docs).filter(k => docs[k].tag === label).map(sourceRow).join('') + st.notes.filter(n => journalTags(n.text).includes(label)).map(n => row(n.title || n.text.slice(0,45) || '附件记录',recordDay(n),'note','go:doc/'+n.id)).join('');
}
function mobileTagRows() {
  return group(allMobileLabels().filter(t => match(t,tagQuery)).map(t => row(t, (Object.values(docs).filter(d=>d.tag===t).length + st.notes.filter(n=>journalTags(n.text).includes(t)).length) + ' 条资料','tag','go:label/tag-'+encodeURIComponent(t))).join(''),'未找到标签。');
}
function deviceSyncPage() {
  const p = syncPreferences(), counts = { pending:0, uploaded:0, written:0, error:0 };
  st.notes.forEach(n => { counts[n.syncState || 'pending']++; });
  return intro('同步状态','查看本机记录，并预演上传与电脑写入。') + prototypeHint() +
    section('速记', '<div class="sync-counts">'+[['pending','待上传'],['uploaded','等电脑'],['written','已写入'],['error','失败']].map(([k,t])=>'<span><strong>'+counts[k]+'</strong>'+t+'</span>').join('')+'</div><p class="fine">本机保存后即可离开输入页。此原型不会启动真实锁屏上传。</p><div class="actions">'+btn('模拟同步一次','journal-sync','','sync')+plain('查看记录','go:logs')+'</div>') +
    section('本设备', group('<label class="setting-switch"><span><strong>启用云同步演示</strong><small>关闭后保留本机内容与待传队列</small></span><input type="checkbox" data-sync-pref="enabled" '+(p.enabled?'checked':'')+'></label><label class="setting-switch"><span><strong>自动同步偏好</strong><small>这里只保存偏好，演示进度由按钮推进</small></span><input type="checkbox" data-sync-pref="auto" '+(p.auto?'checked':'')+'></label>') + '<p class="settings-note">示例云连接：阿里云 OSS。本站不读取实际密钥或设备配置。</p>') +
    section('同步范围', group([['quick','速记','文字、附件与写入回执'],['reading','阅读','正文、状态、标签与附件'],['review','闪卡','卡片与复习记录']].map(([k,t,d])=>'<label class="setting-switch"><span><strong>'+t+'</strong><small>'+d+'</small></span><input type="checkbox" data-sync-module="'+k+'" '+((k==='quick'?p.quick:k==='reading'?st.readingSync:st.reviewSync)?'checked':'')+'></label>').join('')) + '<p class="settings-note">安卓速记支持后台队列；阅读在打开或返回应用时补同步。此处仅演示各模块设置。</p>') +
    '<details class="demo-controls"'+(syncControlsOpen?' open':'')+'><summary>测试同步异常与电脑离线</summary><div class="actions">'+btn(st.offline?'模拟手机恢复在线':'模拟手机离线','offline','outline')+btn(st.desktopOnline?'模拟电脑离线':'模拟电脑上线','desktop-online','outline')+btn(st.syncError?'恢复上传连接':'模拟上传失败','sync-error','outline')+'</div><p class="fine">手机'+(st.offline?'离线':'在线')+' · 电脑'+(st.desktopOnline?'在线':'离线')+'。第一次同步上传；电脑在线后，再同步一次确认写入。</p></details>';
}
function syncJournalDemo() {
  const p = syncPreferences();
  if (!p.enabled || !p.quick) { tell('同步演示已关闭；本机记录保留，请先开启本设备速记同步。'); return; }
  if (st.offline) { tell('模拟手机离线；本机记录保留，恢复在线后重试。'); return; }
  commitMobile(() => {
    for (const n of st.notes) {
      const state = n.syncState || 'pending';
      if (state === 'written') continue;
      if (st.syncError) { n.retryState = state === 'error' ? n.retryState : state; n.syncState = 'error'; continue; }
      const next = state === 'error' ? n.retryState || 'pending' : state;
      n.syncState = next === 'pending' ? 'uploaded' : st.desktopOnline ? 'written' : 'uploaded';
      delete n.retryState;
    }
    st.lastSync = Date.now();
  }, st.syncError ? '演示上传失败；记录和附件保留，恢复连接后可重试。' : '本轮同步演示已完成，请查看记录状态。');
}
function mobileBrowsePage() {
  const tail=text=>'<span class="directory-meta">'+esc(text)+'</span><span class="tail">'+ico('chev',16)+'</span>';
  const count=Object.keys(findings).filter(id=>status(id)==='待关注'||pending(id)).length;
  return '<div class="browse-directory">'+group(row('日志','','calendar','go:logs','',tail('按天'))+row('阅读','','book','go:reading','',tail('稍后读'))+row('收藏','','star','go:favorites')+row('最近浏览','','clock','go:recent')+row('标签','','tag','go:tags'))+
    section('资料来源',group(row('资料库','Craft、Obsidian 与本地记录','folder','go:libraries')+row('连接总览','内容同步与 Agents 会话','cloud','go:connections')))+
    section('发现与回看',group(row('洞察','','spark','go:insights','',tail(count+' 条示例'))))+'</div>';
}
function futurePage() {
  return intro('后续功能','桌面协作与阶段回顾保留交互演示。') + section('尚未接入本原型的真实服务',group(row('阶段回顾','查看既有交互演示；不运行真实分析','spark','go:recap')+row('桌面协作与工作专题','提交、等待和回执的历史演示','chat','go:works')+row('桌面成果同步演示','查看原有请求和桌面离线流程','sync','go:collab-sync'))) + '<p class="settings-note">洞察现可从浏览直接进入；Agents 是独立主入口。本站仍只演示交互，不代表 Android / VPS 的同名功能已接通。</p>';
}
function allReviewCards() { return [...cards, ...(st.customCards || [])].map(c=>({...c,...(st.cardEdits?.[c.id]||{})})); }
function cardEditSheet(id) {
  const card=allReviewCards().find(c=>c.id===id);if(!card)return;
  const draft=st.drafts?.['card-'+id]||card;
  sheet('编辑闪卡','<form id="card-edit-form" data-id="'+esc(id)+'"><p class="fine">'+esc(card.deck)+' · 只修改本浏览器副本，来源和评分保留。</p><div class="field"><label for="card-question">问题</label><textarea id="card-question" name="q" maxlength="10000" required>'+esc(draft.q)+'</textarea></div><div class="field"><label for="card-answer">答案与解释</label><textarea id="card-answer" name="a" maxlength="10000" required>'+esc(draft.a)+'</textarea></div><p id="card-edit-feedback" class="fine" role="status">关闭后可继续草稿；点“保存”才会替换卡片。</p></form>');
}
function saveCardEdit(form) {
  const id=form.dataset.id,q=form.querySelector('[name="q"]').value.trim(),a=form.querySelector('[name="a"]').value.trim(),feedback=form.querySelector('#card-edit-feedback');
  if(!allReviewCards().some(c=>c.id===id)||!q||!a||q.length>10000||a.length>10000){feedback.textContent='问题和答案都要填写，每项最多一万字。';return false;}
  const oldEdits=st.cardEdits,oldDraft=st.drafts?.['card-'+id];
  st.cardEdits={...oldEdits,[id]:{q,a}};st.drafts||={};delete st.drafts['card-'+id];
  if(!save()){st.cardEdits=oldEdits;st.drafts['card-'+id]=oldDraft||{q,a};feedback.textContent='没有保存成功，原卡片未改变。请保留当前输入并重试。';return false;}
  close();render();tell('已保存此浏览器的卡片副本');return true;
}
function reviewDecks() { return [...new Set(allReviewCards().map(c=>c.deck))]; }
function mobileReviewPage() {
  const all = allReviewCards(), left = all.filter(c=>!st.reviewed.includes(c.id));
  const inbox = inboxExamples.filter(c=>!st.inboxStatus?.[c.id]);
  let body;
  if (reviewTab === 'library') body = section('牌组',group(reviewDecks().map((d,i)=>row(d,all.filter(c=>c.deck===d).length+' 张 · '+left.filter(c=>c.deck===d).length+' 张待复习','cards','go:deck/'+i)).join('')));
  else if (reviewTab === 'inbox') body = '<p class="fine">以下为示例草稿。先核对问题、答案和来源，再决定是否加入牌库。</p>' + (inbox.map(c=>'<article class="inbox-card"><h2>'+esc(c.q)+'</h2><p class="prose">'+esc(c.a)+'</p>'+plain('查看来源','go:doc/'+c.doc,'link')+'<div class="actions">'+btn('加入牌库','accept-card:'+c.id)+plain('暂不采用','dismiss-card:'+c.id)+'</div></article>').join('') || '<div class="empty-state"><h2>收件箱已处理完</h2><p>已采用的卡片在牌库中；暂不采用的草稿可以恢复。</p></div>') + (inboxExamples.some(c=>st.inboxStatus?.[c.id]==='dismissed')?plain('恢复暂不采用的示例草稿','restore-inbox'): '');
  else body = '<div class="review-progress"><h2>'+left.length+' 张待复习</h2><p class="fine">本轮已完成 '+(all.length-left.length)+' / '+all.length+' 张</p>'+btn(left.length?'开始复习':'查看牌库',left.length?'start:全部':'review-tab:library','wide','cards')+'</div>'+section('接着复习',group(reviewDecks().map(d=>row(d,left.filter(c=>c.deck===d).length+' 张待复习','cards','start:'+d)).join('')));
  return intro('复习','翻卡评分，也能回到牌库与收件箱。') + '<div class="filter review-sections">'+[['today','今日'],['library','牌库'],['inbox','收件箱'+(inbox.length?' '+inbox.length:'')]].map(([k,t])=>chip(t,'review-tab:'+k,reviewTab===k)).join('')+'</div>'+body+section('管理',group(row('小组件预览','从桌面或负一屏开始复习','cards','go:widgets')+row('原型备份与恢复','保存此浏览器的闪卡演示进度','folder','review-backup')+row('同步设置','查看本设备闪卡同步范围','sync','go:sync')))+'<p class="settings-note">翻卡间隔和草稿为演示；不替代安卓的复习计划。</p>';
}
function deckPage(index) {
  const deck = reviewDecks()[Number(index)];
  if (!deck) return missing();
  return intro(deck,'查看问题、答案和原始资料。')+'<div class="actions">'+btn('复习这个牌组','start:'+deck,'','cards')+'</div>'+allReviewCards().filter(c=>c.deck===deck).map(c=>'<details class="deck-card"><summary>'+esc(c.q)+'</summary><p class="prose">'+esc(c.a)+'</p><div class="actions">'+plain('查看来源','go:doc/'+c.doc,'link')+plain(st.drafts?.['card-'+c.id]?'继续编辑草稿':'编辑','edit-card:'+c.id)+'</div></details>').join('');
}
function readingManagement(id) {
  const item = reading.find(r=>r.id===id);
  if (!item) return;
  sheet('本文管理','<p class="prose">'+esc(item.t)+'</p>'+group(row('正文',st.cache[id]?'已标记离线示例':'可以标记为离线示例','note','reading-cache:'+id)+row('原文出处',item.src+' · 示例未提供真实外链','link','reading-original:'+id)) + (id==='r3'?section('附件',group(sourceRow('d7'))+'<p class="fine">本示例提供 PDF 文字摘录，暂不提供原文件。</p>'):'<p class="fine">这篇示例没有附件。</p>') + '<p class="settings-note">此处演示正文与附件的缓存状态，不能作为实际离线可用的确认。</p>');
}
function mobileFeatureAction(action,key) {
  if (action === 'edit-card') { cardEditSheet(key);return true; }
  if (action === 'journal-reset') { journalQuery='';journalTag='';journalPeriod='all';render();return true; }
  if (action === 'journal-period') { journalPeriod=key;render();return true; }
  if (action === 'journal-tag') { journalTag=decodeURIComponent(key);go('logs');render();return true; }
  if (action === 'journal-expand') { journalExpanded.has(key)?journalExpanded.delete(key):journalExpanded.add(key);render();return true; }
  if (action === 'journal-sync') { syncJournalDemo();return true; }
  if (action === 'download-attachment') { void downloadAttachment(key);return true; }
  if (action === 'capture-options') { const panel=document.querySelector('.capture-extra');panel.hidden=!panel.hidden;document.querySelector('[data-act="capture-options"]').setAttribute('aria-expanded',String(!panel.hidden));return true; }
  if (action === 'capture-files') { document.querySelector('#quick-files')?.click();return true; }
  if (action === 'capture-remove-file') {
    const d=workflowDraft('note'), old=d.attachments;d.attachments=recordAttachments(d).filter(a=>a.id!==key);
    if(save()===false){d.attachments=old;return true;}
    if(!st.notes.some(n=>recordAttachments(n).some(a=>a.id===key)))void attachmentTransaction('readwrite',store=>store.delete(key)).then(()=>{const url=attachmentUrls.get(key);if(url)URL.revokeObjectURL(url);attachmentUrls.delete(key);}).catch(()=>tell('附件已移出草稿，缓存清理未完成。'));
    const f=document.querySelector('#quick-capture-form');f.querySelector('.capture-photos').innerHTML=attachmentMarkup(d,true);updateCaptureSubmit(f);void hydrateAttachmentImages(f);return true;
  }
  if (action === 'review-tab') { reviewTab=key;render();return true; }
  if (action === 'accept-card' || action === 'dismiss-card') {
    const card=inboxExamples.find(c=>c.id===key);if(!card || st.inboxStatus?.[key])return true;
    commitMobile(()=>{st.inboxStatus||={};st.inboxStatus[key]=action==='accept-card'?'accepted':'dismissed';if(action==='accept-card'&&!allReviewCards().some(c=>c.id===key))(st.customCards||=[]).push({...card});},action==='accept-card'?'示例卡片已加入牌库':'草稿暂不采用，可从收件箱恢复');return true;
  }
  if (action === 'restore-inbox') { commitMobile(()=>{for(const [id,state] of Object.entries(st.inboxStatus||{}))if(state==='dismissed')delete st.inboxStatus[id];},'示例草稿已恢复');return true; }
  if (action === 'review-backup') {
    sheet('原型备份与恢复','<p class="prose">导出或合并恢复本站的自定义卡片与评分。此 JSON 仅供手机原型使用，与安卓备份格式不同。</p><div class="actions">'+btn('导出原型备份','export-review')+btn('选择原型备份','pick-review-backup','outline')+'</div><input id="review-restore" type="file" accept="application/json,.json" hidden>');return true;
  }
  if (action === 'export-review') { downloadBlob(new Blob([JSON.stringify({kind:'hub-mobile-review-demo',version:1,reviewed:st.reviewed,grades:st.grades,customCards:st.customCards||[],cardEdits:st.cardEdits||{},inboxStatus:st.inboxStatus||{}},null,2)],{type:'application/json'}),'Hub-手机原型-闪卡备份.json');return true; }
  if (action === 'pick-review-backup') { document.querySelector('#review-restore')?.click();return true; }
  return false;
}
document.addEventListener('input',event=>{
  const form=event.target.form;
  if(form?.id==='card-edit-form'){
    st.drafts||={};st.drafts['card-'+form.dataset.id]={q:form.querySelector('[name="q"]').value,a:form.querySelector('[name="a"]').value};
    form.querySelector('#card-edit-feedback').textContent=save()?'编辑草稿已保留；点“保存”才会替换卡片。':'草稿暂未存入浏览器，请保持页面并重试。';
  }
  if(event.target.id==='journal-query'){journalQuery=event.target.value;document.querySelector('#journal-feed').innerHTML=journalFeed();void hydrateAttachmentImages();}
});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.id==='quick-photos'||el.id==='quick-files'){void addCaptureAttachments(el);return;}
  if(el.id==='journal-tag'){journalTag=el.value;render();return;}
  if(el.dataset.syncPref){const key=el.dataset.syncPref;commitMobile(()=>{syncPreferences()[key]=el.checked;},'本设备演示偏好已保存');return;}
  if(el.dataset.syncModule){const key=el.dataset.syncModule;commitMobile(()=>{if(key==='quick')syncPreferences().quick=el.checked;else st[key==='reading'?'readingSync':'reviewSync']=el.checked;},'同步范围演示已保存');return;}
  if(el.id==='review-restore')void restoreReviewBackup(el);
});
async function restoreReviewBackup(input) {
  try {
    const file=input.files?.[0];if(!file)return;
    if(file.size>2*1024*1024)throw new Error('备份超过 2 MB，未导入。');
    const data=JSON.parse(await file.text());
    if(data.kind!=='hub-mobile-review-demo'||data.version!==1||!Array.isArray(data.customCards)||!Array.isArray(data.reviewed)||!data.grades||typeof data.grades!=='object'||Array.isArray(data.grades))throw new Error('不是受支持的手机原型备份，原进度保留。');
    if(new Set(data.customCards.map(c=>c?.id)).size!==data.customCards.length||data.customCards.length>1000||data.customCards.some(c=>!c||typeof c.id!=='string'||!/^demo-card-[a-zA-Z0-9-]{1,100}$/.test(c.id)||!['q','a','deck'].every(k=>typeof c[k]==='string'&&c[k].length>0&&c[k].length<=10000)||!Object.hasOwn(docs,c.doc)))throw new Error('备份中的卡片不完整，未导入。');
    if(data.inboxStatus && (typeof data.inboxStatus!=='object'||Array.isArray(data.inboxStatus)||Object.entries(data.inboxStatus).some(([id,state])=>!inboxExamples.some(c=>c.id===id)||!['accepted','dismissed'].includes(state))))throw new Error('备份草稿状态无法识别，未导入。');
    const ids=new Set([...cards,...(st.customCards||[]),...data.customCards].map(c=>c.id));
    if(data.cardEdits&&(typeof data.cardEdits!=='object'||Array.isArray(data.cardEdits)||Object.entries(data.cardEdits).some(([id,c])=>!ids.has(id)||!c||!['q','a'].every(k=>typeof c[k]==='string'&&c[k].trim().length>0&&c[k].length<=10000)||Object.keys(c).some(k=>!['q','a'].includes(k)))))throw new Error('备份中的卡片修改无法识别，未导入。');
    if(data.reviewed.some(id=>typeof id!=='string'||!ids.has(id))||Object.entries(data.grades).some(([id,v])=>!ids.has(id)||!['重来','困难','记得','轻松'].includes(v)))throw new Error('备份评分无法识别，未导入。');
    close();
    commitMobile(()=>{
      const existing=new Set((st.customCards||[]).map(c=>c.id));
      st.customCards=[...(st.customCards||[]),...data.customCards.filter(c=>!existing.has(c.id)).map(({id,q,a,deck,doc})=>({id,q,a,deck,doc}))];
      st.reviewed=[...new Set([...st.reviewed,...data.reviewed])];st.grades={...data.grades,...st.grades};
      st.cardEdits={...(data.cardEdits||{}),...(st.cardEdits||{})};
      st.inboxStatus||={};for(const [id,state] of Object.entries(data.inboxStatus||{}))if(state==='dismissed'&&!st.inboxStatus[id])st.inboxStatus[id]='dismissed';for(const c of inboxExamples)if(st.customCards.some(x=>x.id===c.id))st.inboxStatus[c.id]='accepted';
    },'原型备份已合并恢复，现有进度保留');
  }catch(error){tell(error.message||'无法读取备份，原进度保留。');}finally{input.value='';}
}

async function clearPrototypeAttachments() {
  try {
    await attachmentTransaction('readwrite', store => store.clear());
    for (const url of attachmentUrls.values()) URL.revokeObjectURL(url);
    attachmentUrls.clear();
  } catch { tell('演示记录已重置，附件缓存清理未完成。可再次重置或清理本站数据。'); }
}
