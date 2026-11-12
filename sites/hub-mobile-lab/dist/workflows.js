'use strict';

// Mobile workflows share the existing sample store. No external service is called.
function allTasks() {
  return [...tasks, ...(Array.isArray(st.customTasks) ? st.customTasks : [])];
}

function linkedFindingTask(id) {
  const taskId = st.linkedTasks?.[id];
  return taskId ? allTasks().find(task => task.id === taskId) : undefined;
}

function findingTaskAction(id) {
  const task = linkedFindingTask(id);
  if (task) {
    return '<div class="insight-action">' + btn('查看任务', 'go:task/' + task.id, 'secondary', 'task') +
      '<p class="fine">' + (done(task) ? '关联任务已完成；发现仍保留当前处理状态。' : '已转为任务，待完成。') + '</p></div>';
  }
  return '<div class="insight-action">' + btn('安排下一步', 'create-finding-task:' + id, '', 'plus') +
    '<p class="fine">加入演示任务，继续跟进这条发现。</p></div>';
}

function mobileTaskPage() {
  const list = allTasks();
  const today = list.filter(task => task.date === '今天');
  const finished = today.filter(done).length;
  const visible = list.filter(task =>
    (taskFilter === '全部' || (taskFilter === '已完成') === done(task)) &&
    (taskDate === '所有日期' || taskDate === task.date));
  const progress = today.length ? Math.round(finished / today.length * 100) : 0;
  const rows = visible.map(task => '<div class="row-wrap task-row' + (done(task) ? ' is-complete' : '') + '">' +
    iconBtn((done(task) ? '恢复待办：' : '完成：') + task.t, 'task:' + task.id, done(task) ? 'check' : 'circle') +
    row(task.t, task.date + ' · ' + task.src, 'task', 'go:task/' + task.id) + '</div>').join('');
  const empty = '<div class="empty-state">' + ico('check', 27) + '<h3>' +
    (taskFilter === '已完成' ? '还没有完成的任务' : '这里已经清空了') + '</h3><p>' +
    (taskFilter === '已完成' ? '完成一件事后，可以在这里回看。' : '换个日期看看，或清除筛选。') + '</p>' +
    plain('清除筛选', 'task-reset') + '</div>';
  return intro('任务', '把下一步写清楚，一件一件来。') +
    '<div class="task-summary"><div class="inline"><strong>今天</strong>' + '<span class="fine">已完成 ' + finished + ' / ' + today.length + '</span></div>' +
    '<div class="task-progress" role="progressbar" aria-label="今天的任务进度" aria-valuemin="0" aria-valuemax="' + Math.max(today.length, 1) + '" aria-valuenow="' + finished + '"><span style="width:' + progress + '%"></span></div></div>' +
    '<div class="filter">' + ['待办', '已完成', '全部'].map(value => chip(value, 'taskfilter:' + value, taskFilter === value)).join('') + '</div>' +
    '<div class="filter">' + ['所有日期', '今天', '明天', '昨天'].map(value => chip(value, 'taskdate:' + value, taskDate === value)).join('') + '</div>' +
    (undoTask ? '<div class="inline"><span class="fine">任务状态已更新</span>' + plain('撤销', 'undo-task') + '</div>' : '') +
    (rows ? group(rows) : empty) + '<p class="settings-note">任务修改保存在当前浏览器，不写回 Craft 或滴答清单。</p>';
}

function mobileTaskDetail(id) {
  const task = allTasks().find(item => item.id === id);
  if (!task) return missing();
  const linked = task.finding && findings[task.finding];
  return detail(task.t, tag(done(task) ? '已完成' : '待办', done(task) ? 'green' : 'blue') + ' ' + tag(task.date),
    '<p class="reader-meta">' + esc(task.src) + '</p><div class="reader-body"><p>' + esc(task.note || '把这一步完成，就很好。') + '</p></div>' +
    (linked ? section('来自这条发现', group(row(findData(task.finding).t, '保留依据和处理状态', 'spark', 'go:finding/' + task.finding, 'purple'))) : '') +
    '<div class="actions">' + btn(done(task) ? '恢复待办' : '完成任务', 'task:' + id, '', 'check') + '</div>' +
    '<p class="settings-note">已保存在当前浏览器。' + (linked ? '完成任务后，可回到发现核对结果。' : '这里的修改不写回来源。') + '</p>');
}

function findingCard(id) {
  const finding = findData(id);
  const task = linkedFindingTask(id);
  const label = pending(id) ? '待复核' : finding.kind;
  return '<article class="insight-card">' +
    '<div class="insight-kicker">' + tag(label, pending(id) ? 'warn' : finding.kind === '直接观察' ? 'blue' : '') +
    '<span class="fine">11 月 1–9 日</span></div>' +
    '<button type="button" class="insight-main" data-act="go:finding/' + id + '"><h3>' + esc(finding.t) + '</h3><p>' + esc(finding.desc) + '</p></button>' +
    '<div class="insight-evidence">' + plain(finding.docs.length + ' 条依据', 'finding-evidence:' + id, 'note') +
    (task ? plain(done(task) ? '任务已完成' : '查看任务', 'go:task/' + task.id, 'task') : plain('安排下一步', 'create-finding-task:' + id, 'plus')) + '</div>' +
    (task && !done(task) ? '<p class="fine">已转为任务，待完成</p>' : '') + '</article>';
}

function mobileInsights() {
  const ids = Object.keys(findings).filter(id => filter === '待复核' ? pending(id) : status(id) === filter);
  const jobs = st.jobs.filter(job => !['applied', 'cancelled'].includes(job.stage));
  const attention = Object.keys(findings).filter(id => status(id) === '待关注').length;
  const list = ids.length ? ids.map(findingCard).join('') :
    '<div class="empty-state">' + ico('spark', 28) + '<h3>' + (filter === '待关注' ? '暂时没有待关注的发现' : '这里还没有发现') + '</h3><p>' +
    (filter === '待关注' ? '可以回看已处理的记录，或继续本月回顾。' : '切换状态，找回其他发现。') + '</p>' +
    plain(filter === '待关注' ? '查看已处理' : '返回待关注', 'filter:' + (filter === '待关注' ? '已处理' : '待关注')) + '</div>';
  return intro('洞察', '回看记录，让下一步更清楚。') +
    '<div class="insight-summary"><span class="eyebrow">11 月 1–9 日</span><span class="fine">' + attention + ' 项值得留意</span></div>' +
    '<div class="filter">' + ['待关注', '稍后', '已处理', '待复核'].map(value => chip(value, 'filter:' + value, filter === value)).join('') + '</div>' + list +
    '<div class="continue-card">' + row('继续本月回顾', '消费、阅读与生活记录', 'calendar', 'go:recap', 'purple') + '</div>' +
    (jobs.length ? section('更新进度', group(jobs.slice(-3).reverse().map(requestRow).join('')), plain('全部请求', 'go:requests')) : '') +
    '<div class="actions">' + plain('桌面成果同步演示', 'go:collab-sync', 'sync') + plain('查看原工作', 'go:works', 'chat') + '</div>';
}

function showFindingEvidence(id) {
  const finding = findData(id);
  if (!finding) return;
  const entries = finding.docs.map(docId => {
    const doc = docs[docId];
    const extra = docId === 'd4' && st.revised ? '\n补录：就诊 ¥150，更新后净支出 ¥850。' : '';
    return '<article class="quote"><div class="fine">' + esc(doc.s + ' · ' + doc.date) + '</div><h3>' + esc(doc.t) + '</h3>' +
      '<p>' + esc(doc.body + extra) + '</p><div class="actions">' + plain('打开资料', 'go:doc/' + docId, 'link') + '</div></article>';
  }).join('');
  sheet('查看依据', '<p class="lede">' + esc(finding.t) + '</p>' + entries +
    (id === 'f2' && st.sourceChanged && !st.revised ? '<p class="info warning">资料已有补录，当前发现仍保留上次发布的结论。</p>' : '') +
    '<p class="settings-note">' + esc(finding.limit) + '</p>');
}

function workflowDraft(kind) {
  if (!st.captureDraft || typeof st.captureDraft !== 'object') st.captureDraft = {};
  const draft = st.captureDraft;
  if (!draft.note) draft.note = { text: draft.text || st.draft || '' };
  if (!draft.task) draft.task = { title: draft.title || '', text: '', date: '今天' };
  if (!draft.link) draft.link = { title: '', url: draft.url || '', text: '' };
  const selected = ['note', 'task', 'link'].includes(kind) ? kind : ['note', 'task', 'link'].includes(draft.kind) ? draft.kind : 'note';
  draft.kind = selected;
  st.captureKind = selected;
  return draft[selected];
}

function captureForm(kind) {
  const draft = workflowDraft(kind);
  if (kind !== 'task') return memoCaptureForm(workflowDraft('note'));
  const fields = '<div class="field"><label for="quick-title">下一步要做什么？</label><input id="quick-title" name="title" type="text" placeholder="写下一个具体动作" maxlength="160" required value="' + esc(draft.title) + '"></div>' +
    '<div class="field"><label for="quick-text">补充说明 <span class="fine">可选</span></label><textarea id="quick-text" name="text" rows="3" maxlength="2000" placeholder="需要带上什么信息？">' + esc(draft.text) + '</textarea></div>' +
    selectField('quick-date', '安排在', ['今天', '明天', '暂不安排'], draft.date || '今天');
  return '<form id="quick-capture-form" data-kind="task" novalidate>' + fields +
    '<p class="capture-status fine" role="status">' + (Object.values(draft).some(value => value && value !== '今天') ? '已恢复草稿' : '草稿会自动保留') + '</p>' +
    '<p class="capture-error" role="alert"></p><div class="actions"><button type="submit" class="btn wide">加入任务</button></div>' +
    '<p class="settings-note">保存在当前浏览器。</p></form>';
}

function capturePhotos(photos) {
  return Array.isArray(photos) ? photos.filter(p => p && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(p.src)).slice(0, 4) : [];
}
function capturePhotoStrip(photos, removable = true) {
  return capturePhotos(photos).map((p, i) => '<figure><img src="' + esc(p.src) + '" alt="' + esc(p.name || '照片') + '">' + (removable ? '<button type="button" aria-label="移除照片 ' + (i + 1) + '" data-act="capture-remove-photo:' + i + '">' + ico('close', 14) + '</button>' : '') + '</figure>').join('');
}
function captureNoteBody(text) {
  const inline = value => esc(value).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  return text.split(/\n\s*\n/).map(p => p.split('\n').reduce((groups, line) => {
    const list = /^- /.test(line), last = groups.at(-1);
    if (last && last.list === list) last.lines.push(line); else groups.push({ list, lines: [line] });
    return groups;
  }, []).map(g => g.list ? '<ul>' + g.lines.map(line => '<li>' + inline(line.slice(2)) + '</li>').join('') + '</ul>' : '<p>' + g.lines.map(inline).join('<br>') + '</p>').join('')).join('');
}
function memoCaptureForm(draft) {
  const date = validJournalDay(draft.date) ? draft.date : localDay();
  const count = recordAttachments(draft).length + capturePhotos(draft.photos).length;
  const canSave = !attachmentBusy && (draft.text?.trim() || count);
  return '<form id="quick-capture-form" class="memo-capture" data-kind="note" novalidate>' +
    '<label for="quick-text" class="sr-only">此刻的想法</label><textarea class="capture-text" id="quick-text" name="text" rows="7" maxlength="100000" placeholder="现在的想法是…">' + esc(draft.text) + '</textarea>' +
    '<div class="capture-photos">' + attachmentMarkup(draft, true) + '</div><p class="capture-error" role="alert"></p>' +
    '<div class="capture-toolbar"><div class="capture-tools">' + iconBtn('插入标签', 'capture-insert:tag', 'hash') + iconBtn('添加照片', 'capture-photos', 'image') + '<button type="button" class="icon-btn" aria-label="更多记录选项" aria-expanded="false" data-act="capture-options">' + ico('more') + '</button></div>' +
    '<button type="submit" class="capture-send" aria-label="保存记录"' + (canSave ? '' : ' disabled') + '>' + ico('send', 19) + '<span>记下</span></button></div>' +
    '<div class="capture-extra" hidden><label for="quick-date">记录日期</label><input type="date" id="quick-date" value="' + date + '" required><div class="capture-extra-tools">' + plain('添加文件','capture-files','note') + plain('加粗','capture-insert:bold','bold') + plain('项目符号','capture-insert:list','list') + '</div><small>每条最多 9 个附件，单个 20 MB；文件保存在此浏览器。</small></div>' +
    '<input type="file" id="quick-photos" accept="image/*" multiple hidden><input type="file" id="quick-files" multiple hidden>' +
    '<div class="capture-meta"><span class="capture-status" role="status">' + (attachmentBusy ? '正在保存附件…' : draft.text || count ? '草稿已保留' : '') + '</span><small><span id="capture-day-label">' + (date === localDay() ? '今天' : date) + '</span> · 仅存当前浏览器</small></div></form>';
}
function updateCaptureSubmit(form) {
  if (!form || form.dataset.kind !== 'note') return;
  const draft = workflowDraft('note');
  form.querySelector('[type="submit"]').disabled = attachmentBusy || !(draft.text?.trim() || capturePhotos(draft.photos).length || recordAttachments(draft).length);
}
function insertCaptureText(kind) {
  const input = document.querySelector('#quick-text');
  if (!input) return;
  const start = input.selectionStart, end = input.selectionEnd, selected = input.value.slice(start, end);
  const value = kind === 'bold' ? '**' + (selected || '文字') + '**' : kind === 'list' ? (start && input.value[start - 1] !== '\n' ? '\n' : '') + '- ' + selected : (start && !/\s/.test(input.value[start - 1]) ? ' ' : '') + '#';
  input.setRangeText(value, start, end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus({ preventScroll: true });
  if (kind === 'bold') input.setSelectionRange(start + 2, start + value.length - 2);
}
document.addEventListener('keydown', event => {
  if (event.target.id === 'quick-text' && !event.isComposing && (event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); const f = event.target.form; if (!f.querySelector('[type="submit"]').disabled) f.requestSubmit(); }
});

function quickCapture(kind = 'note') {
  if (kind === 'task') { sheet('任务创建', '<p class="prose">手机原型保留任务查看、完成与恢复。新建任务的保存目标尚未接入，请在现有任务来源中创建。</p>'); return; }
  kind = 'note';
  sheet(kind === 'task' ? '新建任务' : '速记', captureForm(kind));
  document.querySelector('#sheet #quick-text')?.focus({ preventScroll: true });
  void hydrateAttachmentImages(document.querySelector('#sheet'));
}

function capturePage() {
  return captureForm('note');
}

function readCaptureForm(form) {
  const kind = form.dataset.kind;
  const draft = workflowDraft(kind);
  for (const key of ['title', 'text', 'url', 'date']) {
    const input = form.querySelector('#quick-' + key);
    if (input) draft[key] = input.value;
  }
  if (kind === 'note') st.draft = draft.text;
  return draft;
}

function captureError(form, message, focusId) {
  const error = form.querySelector('.capture-error');
  if (error) error.textContent = message;
  const input = focusId && form.querySelector('#' + focusId);
  if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
}

function handleWorkflowInput(event) {
  const form = event.target.form;
  if (form?.id !== 'quick-capture-form' || event.target.type === 'file') return false;
  readCaptureForm(form);
  updateCaptureSubmit(form);
  const dayLabel = form.querySelector('#capture-day-label');
  if (dayLabel) dayLabel.textContent = workflowDraft('note').date === localDay() ? '今天' : workflowDraft('note').date;
  const persisted = save();
  const statusLine = form.querySelector('.capture-status');
  if (statusLine) statusLine.textContent = persisted === false ? '草稿暂未保存，请保留当前页面' : '草稿已保存';
  event.target.removeAttribute('aria-invalid');
  const error = form.querySelector('.capture-error');
  if (error) error.textContent = persisted === false ? '浏览器存储不可用，输入仍在这里。恢复后可重试保存。' : '';
  return true;
}

function handleWorkflowSubmit(form) {
  if (form.id !== 'quick-capture-form') return false;
  const kind = form.dataset.kind;
  const draft = readCaptureForm(form);
  const text = (draft.text || '').trim();
  const title = (draft.title || '').trim();
  if (kind === 'note' && attachmentBusy) return true;
  if (kind === 'note' && !text && !capturePhotos(draft.photos).length && !recordAttachments(draft).length) { captureError(form, '先写下一点内容，或添加照片。', 'quick-text'); return true; }
  if (kind === 'task' && !title) { captureError(form, '写下要完成的具体动作。', 'quick-title'); return true; }
  const chosenDate = draft.date || localDay();
  if (kind === 'note' && !validJournalDay(chosenDate)) { captureError(form, '请选择有效的记录日期。', 'quick-date'); return true; }
  const id = (kind === 'task' ? 'mt-' : 'n-') + crypto.randomUUID();
  const at = Date.now();
  const oldDraft = structuredClone(st.captureDraft);
  const oldLegacy = st.draft;
  if (kind === 'task') {
    if (!Array.isArray(st.customTasks)) st.customTasks = [];
    st.customTasks.unshift({ id, t: title, note: text, date: draft.date || '今天', src: '本地任务', createdAt: at });
  } else {
    st.notes.unshift({ id, kind, title: text.split('\n')[0].slice(0, 40) || '附件记录',
      text,
      ...(kind === 'note' ? { photos: capturePhotos(draft.photos), attachments: structuredClone(recordAttachments(draft)), journalDate: chosenDate, syncState: 'pending' } : {}),
      date: chosenDate, createdAt: at });
  }
  st.captureDraft[kind] = kind === 'task' ? { title: '', text: '', date: '今天' } : { text: '', date: localDay() };
  if (kind === 'note') st.draft = '';
  if (save() === false) {
    if (kind === 'task') st.customTasks = st.customTasks.filter(task => task.id !== id);
    else st.notes = st.notes.filter(note => note.id !== id);
    st.captureDraft = oldDraft;
    st.draft = oldLegacy;
    captureError(form, '暂时无法保存。输入已保留，请检查浏览器存储后重试。');
    return true;
  }
  go(kind === 'task' ? 'task/' + id : 'logs');
  tell(kind === 'task' ? '已加入本地任务' : '已保存到当前浏览器；上传和电脑写入请在同步页演示。');
  return true;
}

function handleWorkflowAction(action, key) {
  if (mobileFeatureAction(action, key)) return true;
  if (action === 'task-reset') { taskFilter = '待办'; taskDate = '所有日期'; render(); return true; }
  if (action === 'quick-capture') { quickCapture(key || 'note'); return true; }
  if (action === 'capture-insert') { insertCaptureText(key); return true; }
  if (action === 'capture-photos') { document.querySelector('#quick-photos')?.click(); return true; }
  if (action === 'capture-remove-photo') { const d = workflowDraft('note'); d.photos = capturePhotos(d.photos).filter((_, i) => i !== Number(key)); const f = document.querySelector('#quick-capture-form'); f.querySelector('.capture-photos').innerHTML = capturePhotoStrip(d.photos); handleWorkflowInput({ target: f.querySelector('#quick-text') }); return true; }
  if (action === 'finding-evidence') { showFindingEvidence(key); return true; }
  if (action !== 'create-finding-task') return false;
  if (!findings[key]) return true;
  const existing = linkedFindingTask(key);
  if (existing) { go('task/' + existing.id); return true; }
  const titles = { f1: '试一周更容易执行的加班日休息安排', f2: '核对本月医疗支出与退款', f3: '安排一轮实机交互验证', f4: '给一条阅读摘录补上应用场景' };
  const finding = findData(key);
  const task = { id: 'fi-' + crypto.randomUUID(), t: titles[key], date: '今天', src: '洞察 · 本地任务', finding: key,
    note: '根据「' + finding.t + '」安排的下一步。\n\n先核对依据，再记录执行结果。', createdAt: Date.now() };
  if (!Array.isArray(st.customTasks)) st.customTasks = [];
  if (!st.linkedTasks || typeof st.linkedTasks !== 'object') st.linkedTasks = {};
  const priorLink = st.linkedTasks[key];
  st.customTasks.unshift(task);
  st.linkedTasks[key] = task.id;
  if (save() === false) {
    st.customTasks = st.customTasks.filter(item => item.id !== task.id);
    if (priorLink) st.linkedTasks[key] = priorLink; else delete st.linkedTasks[key];
    tell('任务未保存，请检查浏览器存储后重试。');
    return true;
  }
  render();
  tell('已加入演示任务');
  return true;
}
