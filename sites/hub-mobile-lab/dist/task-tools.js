'use strict';

// Browser-local task workflows. Source snapshots are never mutated or written back.
// Loaded before app.js: access to its store and helpers stays inside functions.
let taskToolsQuery = '', taskToolsSource = '全部来源', taskToolsSort = '日期优先';
const taskToolsDates = ['所有日期', '今天', '明天', '已逾期', '未来7天', '未安排', '昨天'];
const taskToolsSorts = ['日期优先', '优先级', '最近更新'];
const taskToolsPriorities = { high: '高优先级', normal: '普通优先级', low: '低优先级' };

function taskToolsInit() {
  for (const key of ['taskEdits', 'taskEditorDrafts', 'taskSourceLinks', 'linkedTasks', 'tasks']) {
    if (!st[key] || typeof st[key] !== 'object' || Array.isArray(st[key])) st[key] = {};
  }
  if (!Array.isArray(st.customTasks)) st.customTasks = [];
}

function taskRecord(id) {
  taskToolsInit();
  const seed = tasks.find(task => task.id === id);
  const base = seed || st.customTasks.find(task => task && task.id === id);
  if (!base) return undefined;
  const edit = st.taskEdits[id] && typeof st.taskEdits[id] === 'object' ? st.taskEdits[id] : {};
  const record = { ...base, ...edit, id: base.id, src: String(base.src || '本地任务') };
  record.t = record.title = String(edit.t ?? edit.title ?? base.t ?? base.title ?? '未命名任务');
  record.note = String(record.note || '');
  record.priority = Object.hasOwn(taskToolsPriorities, record.priority) ? record.priority : 'normal';
  record.localOnly = true;
  record.sourceTask = Boolean(seed);
  record.localProposal = Boolean(seed && (Object.keys(edit).length || Object.hasOwn(st.tasks, id)));
  return record;
}

function taskToolsTasks() {
  taskToolsInit();
  return [...new Set([...tasks, ...st.customTasks].filter(task => task && typeof task.id === 'string' && task.id).map(task => task.id))].map(taskRecord).filter(Boolean);
}

function taskToolsValidDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || value.startsWith('0000')) return false;
  const date = new Date(value + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function taskToolsDay(offset = 0) {
  const now = new Date();
  now.setDate(now.getDate() + offset);
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}

function taskToolsDueDay(task) {
  if (taskToolsValidDay(task.dueDate)) return task.dueDate;
  if (taskToolsValidDay(task.date)) return task.date;
  const relative = { 今天: 0, 明天: 1, 昨天: -1 };
  return Object.hasOwn(relative, task.date) ? taskToolsDay(relative[task.date]) : '';
}

function taskToolsDateLabel(task) {
  const due = taskToolsDueDay(task);
  if (!due) return '未安排日期';
  if (!taskToolsValidDay(task.date) && !taskToolsValidDay(task.dueDate)) return task.date;
  if (due === taskToolsDay()) return '今天 · ' + due;
  if (due === taskToolsDay(1)) return '明天 · ' + due;
  if (due === taskToolsDay(-1)) return '昨天 · ' + due;
  return due;
}

function taskToolsNormalizeContext(value) {
  if (!value || typeof value !== 'object' || !value.id || !value.kind) return null;
  const kind = String(value.kind).slice(0, 40), id = String(value.id).slice(0, 320);
  if (!/^[a-z][a-z-]*$/.test(kind)) return null;
  const routeValue = String(value.route || '');
  const safeRoute = /^(?:doc|note|article|finding|task|card|agent-chat|study|label)\/[A-Za-z0-9][A-Za-z0-9._~%-]*$/.test(routeValue) ? routeValue : '';
  let sourceName = String(value.source || '');
  if (!sourceName && kind === 'doc' && typeof docs !== 'undefined') sourceName = docs[id]?.s || '本地记录';
  if (!sourceName && kind === 'reading' && typeof reading !== 'undefined') sourceName = reading.find(item => item.id === id)?.src || '阅读';
  if (!sourceName) sourceName = ({ finding: '洞察', insight: '洞察', agent: 'Agents 回答', task: '任务', note: '本地记录' })[kind] || '来源资料';
  return { kind, id, title: String(value.title || '来源资料').slice(0, 240), route: safeRoute,
    text: String(value.text || '').slice(0, 8000), source: sourceName.slice(0, 100),
    ...(value.taskTitle ? { taskTitle: String(value.taskTitle).slice(0, 160) } : {}) };
}

function taskToolsSourceKey(context) {
  return context ? JSON.stringify([context.kind, context.id]) : '';
}

function taskToolsSourceContext(task) {
  const context = taskToolsNormalizeContext(task.sourceContext);
  if (context) return context;
  if (task.finding && typeof findings !== 'undefined' && findings[task.finding]) {
    const finding = typeof findData === 'function' ? findData(task.finding) : findings[task.finding];
    return taskToolsNormalizeContext({ kind: 'finding', id: task.finding, title: finding.t, route: 'finding/' + task.finding, text: finding.body });
  }
  return null;
}

function taskToolsFindLinked(context) {
  taskToolsInit();
  if (!context) return undefined;
  const key = taskToolsSourceKey(context);
  const linkedId = st.taskSourceLinks[key] || (context.kind === 'finding' ? st.linkedTasks[context.id] : undefined);
  const linked = linkedId && taskRecord(linkedId);
  if (linked) return linked;
  return taskToolsTasks().find(task => taskToolsSourceKey(taskToolsSourceContext(task)) === key);
}

function taskToolsSourceName(task) {
  return taskToolsSourceContext(task)?.source || String(task.src || '本地任务').split(' · ')[0];
}

function taskToolsDateMatches(task, selection = taskDate) {
  const due = taskToolsDueDay(task), today = taskToolsDay();
  if (selection === '所有日期') return true;
  if (selection === '未安排') return !due;
  if (selection === '已逾期') return Boolean(due && due < today && !done(task));
  if (selection === '未来7天') return Boolean(due && due >= today && due <= taskToolsDay(6));
  const relative = { 今天: 0, 明天: 1, 昨天: -1 };
  return Object.hasOwn(relative, selection) && due === taskToolsDay(relative[selection]);
}

function taskToolsVisibleTasks() {
  const words = taskToolsQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const weights = { high: 0, normal: 1, low: 2 };
  return taskToolsTasks().filter(task =>
    (taskFilter === '全部' || (taskFilter === '已完成') === done(task)) && taskToolsDateMatches(task) &&
    (taskToolsSource === '全部来源' || taskToolsSourceName(task) === taskToolsSource) &&
    words.every(word => [task.t, task.note, task.src, taskToolsSourceContext(task)?.title || '', taskToolsSourceName(task)].join(' ').toLocaleLowerCase().includes(word)))
    .sort((a, b) => {
      if (taskFilter === '全部' && done(a) !== done(b)) return Number(done(a)) - Number(done(b));
      const dates = (taskToolsDueDay(a) || '9999').localeCompare(taskToolsDueDay(b) || '9999');
      const priorities = weights[a.priority] - weights[b.priority];
      if (taskToolsSort === '最近更新') return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0);
      return taskToolsSort === '优先级' ? priorities || dates : dates || priorities;
    });
}

function taskToolsResults() {
  const list = taskToolsVisibleTasks();
  if (!list.length) return '<div class="empty-state">' + ico('task', 28) + '<h3>这里还没有任务</h3><p>换个关键词或清除筛选，也可以写下一个具体的下一步。</p><div class="actions">' + plain('清除筛选', 'task-reset') + btn('新建任务', 'task-new', 'secondary', 'plus') + '</div></div>';
  return group(list.map(task => {
    const complete = done(task), due = taskToolsDueDay(task), overdue = due && due < taskToolsDay() && !complete;
    const meta = [taskToolsDateLabel(task), taskToolsSourceName(task)];
    if (task.priority !== 'normal') meta.push(taskToolsPriorities[task.priority]);
    if (overdue) meta.push('已逾期');
    if (task.localProposal) meta.push('本地修改提案');
    return '<div class="row-wrap task-row task-tools-row' + (complete ? ' is-complete' : '') + '" data-priority="' + task.priority + '">' +
      iconBtn((complete ? '恢复待办：' : '完成：') + task.t, 'task-toggle:' + esc(task.id), complete ? 'check' : 'circle') +
      row(task.t, meta.join(' · '), 'task', 'go:task/' + esc(task.id)) + '</div>';
  }).join(''));
}

function taskToolsViewState() {
  return { query: taskToolsQuery, source: taskToolsSource, sort: taskToolsSort, date: taskDate, status: taskFilter };
}

function taskToolsRestoreView(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.query === 'string') taskToolsQuery = value.query.slice(0, 500);
  if (typeof value.source === 'string') taskToolsSource = value.source.slice(0, 100);
  if (taskToolsSorts.includes(value.sort)) taskToolsSort = value.sort;
  if (taskToolsDates.includes(value.date)) taskDate = value.date;
  if (['待办', '已完成', '全部'].includes(value.status)) taskFilter = value.status;
}

function taskToolsRememberView() {
  if (typeof mobileRememberView === 'function') mobileRememberView();
}

function taskToolsPage() {
  const all = taskToolsTasks(), today = all.filter(task => taskToolsDueDay(task) === taskToolsDay());
  const finished = today.filter(done).length, overdue = all.filter(task => taskToolsDateMatches(task, '已逾期')).length;
  const filters = [taskDate, taskToolsSource, taskToolsSort].filter(value => !['所有日期', '全部来源', '日期优先'].includes(value));
  return '<div class="task-summary"><div class="inline"><strong>今天</strong><span class="fine">已完成 ' + finished + ' / ' + today.length + (overdue ? ' · ' + overdue + ' 项逾期' : '') + '</span></div>' +
    '<div class="task-progress" role="progressbar" aria-label="今天的任务进度" aria-valuemin="0" aria-valuemax="' + Math.max(1, today.length) + '" aria-valuenow="' + finished + '"><span style="width:' + (today.length ? Math.round(finished / today.length * 100) : 0) + '%"></span></div></div>' +
    '<div class="filter">' + ['待办', '已完成', '全部'].map(value => chip(value, 'taskfilter:' + value, taskFilter === value)).join('') + '</div>' +
    '<div class="task-tools-search"><div class="task-tools-query">' + ico('search', 19) + '<input type="search" id="task-tools-query" aria-label="搜索任务、说明和来源" placeholder="搜索任务、说明、来源" value="' + esc(taskToolsQuery) + '" enterkeyhint="search" autocomplete="off"><button type="button" class="icon-btn" id="task-tools-query-clear" aria-label="清除任务搜索" data-act="task-clear-query"' + (!taskToolsQuery ? ' hidden' : '') + '>' + ico('close', 16) + '</button></div>' + iconBtn('筛选与排序' + (filters.length ? '，已启用 ' + filters.length + ' 项' : ''), 'task-tools-filters', 'tune') + '</div>' +
    '<div class="task-tools-result-head"><span class="fine" id="task-tools-result-count" role="status">' + taskToolsVisibleTasks().length + ' 项任务</span>' + (filters.length ? plain(filters.join(' · '), 'task-tools-filters') : plain('日期 · 来源 · 排序', 'task-tools-filters')) + '</div>' +
    (undoTask ? '<div class="task-tools-undo"><span class="fine">任务状态已更新 · 仅本地</span>' + plain('撤销', 'task-undo') + '</div>' : '') +
    '<div id="task-tools-results">' + taskToolsResults() + '</div><p class="settings-note">演示任务只保存在此浏览器。来源任务的修改会标记为本地提案，不会写回 Craft 或滴答清单。</p>';
}

function taskToolsSourceBlock(context) {
  if (!context) return '';
  return '<div class="task-tools-source"><span class="mini-label">关联来源 · ' + esc(context.source) + '</span><strong>' + esc(context.title) + '</strong>' +
    (context.route ? plain('查看来源', 'go:' + esc(context.route), 'link') : '<p class="fine">保留了来源摘要；暂未提供可打开的页面。</p>') + '</div>';
}

function taskToolsDetail(id) {
  const task = taskRecord(id);
  if (!task) return missing();
  const complete = done(task), context = taskToolsSourceContext(task);
  const scope = task.localProposal ? '本地修改提案' : task.sourceTask ? '来源任务示例' : '本地任务';
  const sourceNote = task.sourceTask ? '这是来源任务的本地副本。编辑或完成只生成本地修改提案，未发送到 ' + task.src.split(' · ')[0] + '。' : '这项任务仅在当前浏览器保存，没有写入任何外部任务服务。';
  return detail(task.t, tag(complete ? '已完成' : '待办', complete ? 'green' : 'blue') + ' ' + tag(scope),
    '<dl class="task-tools-metadata"><div><dt>日期</dt><dd>' + esc(taskToolsDateLabel(task)) + '</dd></div><div><dt>优先级</dt><dd>' + esc(taskToolsPriorities[task.priority]) + '</dd></div><div><dt>任务来源</dt><dd>' + esc(task.src) + '</dd></div></dl>' +
    '<div class="reader-body"><p>' + esc(task.note || '还没有补充说明，可以在编辑时写下要点。').replace(/\n/g, '<br>') + '</p></div>' + taskToolsSourceBlock(context) +
    '<div class="actions task-tools-actions">' + btn(complete ? '恢复待办' : '完成任务', 'task-toggle:' + esc(id), '', 'check') + btn('编辑任务', 'task-edit:' + esc(id), 'outline', 'note') +
    (typeof agentStartWithMaterial === 'function' || typeof taskToolsSendToAgent === 'function' ? btn('交给 Agents', 'task-agent:' + esc(id), 'secondary', 'chat') : '') + '</div>' +
    (undoTask?.id === id ? '<div class="task-tools-undo"><span class="fine">任务状态已更新</span>' + plain('撤销', 'task-undo') + '</div>' : '') +
    '<p class="settings-note">' + esc(sourceNote) + (task.finding ? ' 完成后仍需回到发现核对结果，发现状态不会自动改变。' : '') + '</p>');
}

function taskToolsDraftKey(id, context) {
  return id ? 'edit:' + id : context ? 'source:' + taskToolsSourceKey(context) : 'new';
}

function taskToolsOpenEditor(id, sourceContext) {
  taskToolsInit();
  if (id && typeof id === 'object') { sourceContext = id; id = ''; }
  const task = id ? taskRecord(id) : null;
  if (id && !task) { tell('这项任务已不存在。'); return; }
  const context = task ? taskToolsSourceContext(task) : taskToolsNormalizeContext(sourceContext);
  const existing = !id && context && taskToolsFindLinked(context);
  if (existing) { go('task/' + existing.id); tell('这条来源已有关联任务，已为你打开。'); return; }
  const key = taskToolsDraftKey(id, context);
  let draft = st.taskEditorDrafts[key];
  const restored = Boolean(draft);
  if (!draft || typeof draft !== 'object') {
    draft = { key, id: id || '', title: task?.t || context?.taskTitle || (context ? '跟进：' + context.title : ''),
      dueDate: task ? taskToolsDueDay(task) : '', priority: task?.priority || 'normal',
      note: task?.note || (context ? '来自「' + context.title + '」。\n\n' + context.text.slice(0, 1800) : ''),
      legacyDate: task && !taskToolsValidDay(task.dueDate) && ['今天', '明天', '昨天'].includes(task.date) ? task.date : '',
      sourceContext: context };
    draft.title = draft.title.slice(0, 160);
    st.taskEditorDrafts[key] = draft;
  }
  sheet(task ? '编辑任务' : '新建任务', taskToolsEditorMarkup(draft, restored, Boolean(task?.sourceTask)));
}

function taskToolsEditorMarkup(draft, restored, sourceTask) {
  return '<form id="task-tools-editor" data-draft="' + esc(draft.key) + '" novalidate><div class="field"><label for="task-editor-title">下一步要做什么？</label><input id="task-editor-title" name="title" type="text" maxlength="160" required placeholder="写下一个具体动作" value="' + esc(draft.title) + '"></div>' +
    '<div class="task-tools-form-grid"><div class="field"><label for="task-editor-date">计划日期 <span class="fine">可选</span></label><input id="task-editor-date" name="dueDate" type="date" value="' + esc(draft.dueDate) + '" aria-describedby="task-editor-date-hint"></div><div class="field"><label for="task-editor-priority">优先级</label><select id="task-editor-priority" name="priority">' + Object.entries(taskToolsPriorities).map(([value, label]) => '<option value="' + value + '"' + (draft.priority === value ? ' selected' : '') + '>' + esc(label) + '</option>').join('') + '</select></div></div>' +
    '<p class="fine" id="task-editor-date-hint">' + (draft.legacyDate ? '原示例日期为「' + esc(draft.legacyDate) + '」。不改日期会保留此标签；重新选择后保存为实际日期。' : '可留空；选定后按实际年月日保存，不会随明天滚动。') + '</p>' +
    '<div class="field"><label for="task-editor-note">补充说明 <span class="fine">可选</span></label><textarea id="task-editor-note" name="note" rows="4" maxlength="4000" placeholder="需要核对的内容、步骤或完成标准">' + esc(draft.note) + '</textarea></div>' + taskToolsSourceBlock(draft.sourceContext) +
    '<p class="task-editor-status fine" role="status">' + (restored ? '已恢复未提交草稿。' : '关闭后可重新打开继续编辑。') + '</p><p class="task-editor-error" role="alert"></p>' +
    '<div class="actions"><button type="submit" class="btn">' + (draft.id ? sourceTask ? '保存本地提案' : '保存修改' : '加入本地任务') + '</button>' + btn('保留草稿并关闭', 'close', 'outline') + '</div>' +
    '<p class="settings-note">' + (sourceTask ? '这是本地修改提案，不写回 Craft 或滴答清单。' : '任务和草稿仅保存在此浏览器，不写入外部任务服务。') + '</p></form>';
}

function taskToolsReadEditor(form) {
  taskToolsInit();
  const key = form.dataset.draft || 'new', previous = st.taskEditorDrafts[key] || { key, id: '', sourceContext: null };
  const dueDate = form.querySelector('#task-editor-date')?.value || '';
  const draft = { ...previous, key, title: form.querySelector('#task-editor-title')?.value || '', dueDate,
    priority: form.querySelector('#task-editor-priority')?.value || 'normal', note: form.querySelector('#task-editor-note')?.value || '' };
  if (dueDate !== previous.dueDate) draft.legacyDate = '';
  st.taskEditorDrafts = { ...st.taskEditorDrafts, [key]: draft };
  return draft;
}

function taskToolsPersist() {
  try { return save() !== false; } catch { return false; }
}

function taskToolsSaveDraft(draft) {
  taskToolsInit();
  st.taskEditorDrafts = { ...st.taskEditorDrafts, [draft.key]: { ...draft } };
  const title = String(draft.title || '').trim(), note = String(draft.note || '').trim();
  if (!title || title.length > 160) return { ok: false, message: '写下一个具体动作，最多 160 个字。', field: 'task-editor-title' };
  if (draft.dueDate && !taskToolsValidDay(draft.dueDate)) return { ok: false, message: '请选择有效的年月日，或清空日期。', field: 'task-editor-date' };
  if (note.length > 4000) return { ok: false, message: '补充说明最多 4000 个字。', field: 'task-editor-note' };
  const context = taskToolsNormalizeContext(draft.sourceContext);
  const existing = !draft.id && context && taskToolsFindLinked(context);
  if (existing) return { ok: true, id: existing.id, existing: true };
  const task = draft.id && taskRecord(draft.id);
  if (draft.id && !task) return { ok: false, message: '原任务已不存在。输入仍保留在草稿里。' };
  const prior = { customTasks: st.customTasks, taskEdits: st.taskEdits, taskSourceLinks: st.taskSourceLinks,
    linkedTasks: st.linkedTasks, taskEditorDrafts: st.taskEditorDrafts };
  const legacy = ['今天', '明天', '昨天'].includes(draft.legacyDate) ? draft.legacyDate : '';
  const changes = { t: title, title, note, dueDate: legacy ? '' : draft.dueDate || '', date: legacy || draft.dueDate || '暂不安排',
    priority: Object.hasOwn(taskToolsPriorities, draft.priority) ? draft.priority : 'normal', updatedAt: Date.now() };
  const id = task ? task.id : 'mt-' + crypto.randomUUID();
  if (task) st.taskEdits = { ...st.taskEdits, [id]: { ...st.taskEdits[id], ...changes } };
  else {
    const record = { id, ...changes, src: '本地任务', createdAt: Date.now(), localOnly: true };
    if (context) {
      record.sourceContext = context;
      st.taskSourceLinks = { ...st.taskSourceLinks, [taskToolsSourceKey(context)]: id };
      if (context.kind === 'finding') { record.finding = context.id; st.linkedTasks = { ...st.linkedTasks, [context.id]: id }; }
    }
    st.customTasks = [record, ...st.customTasks];
  }
  st.taskEditorDrafts = { ...st.taskEditorDrafts };
  delete st.taskEditorDrafts[draft.key];
  if (!taskToolsPersist()) {
    Object.assign(st, prior);
    return { ok: false, message: '暂时无法保存。任务没有改变，输入仍在草稿里；请保留当前页面并重试。' };
  }
  return { ok: true, id, proposal: Boolean(task?.sourceTask) };
}

function taskToolsFormError(form, message, field) {
  const error = form.querySelector('.task-editor-error');
  if (error) error.textContent = message;
  const input = field && form.querySelector('#' + field);
  if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
}

function taskToolsRefreshResults() {
  const list = document.querySelector('#task-tools-results');
  if (list) list.innerHTML = taskToolsResults();
  const count = document.querySelector('#task-tools-result-count');
  if (count) count.textContent = taskToolsVisibleTasks().length + ' 项任务';
  const clear = document.querySelector('#task-tools-query-clear');
  if (clear) clear.hidden = !taskToolsQuery;
  taskToolsRememberView();
}

function taskToolsInput(event) {
  const element = event.target;
  if (element.id === 'task-tools-query') {
    if (!event.isComposing) { taskToolsQuery = element.value; taskToolsRefreshResults(); }
    return true;
  }
  if (element.form?.id !== 'task-tools-editor') return false;
  const draft = taskToolsReadEditor(element.form);
  if (element.id === 'task-editor-date') draft.legacyDate = '';
  const persisted = taskToolsPersist(), status = element.form.querySelector('.task-editor-status');
  if (status) status.textContent = persisted ? '草稿已保留在此浏览器。' : '草稿仍在当前页面，暂未写入浏览器存储。';
  element.removeAttribute?.('aria-invalid');
  taskToolsFormError(element.form, persisted ? '' : '浏览器存储不可用。请保留当前页面，稍后再保存。');
  return true;
}

function taskToolsSubmit(form) {
  if (form.id === 'task-tools-filter-form') {
    const date = form.querySelector('#task-filter-date').value, sort = form.querySelector('#task-filter-sort').value;
    taskDate = taskToolsDates.includes(date) ? date : '所有日期';
    taskToolsSort = taskToolsSorts.includes(sort) ? sort : '日期优先';
    taskToolsSource = form.querySelector('#task-filter-source').value;
    close(); render(); taskToolsRememberView(); return true;
  }
  if (form.id !== 'task-tools-editor') return false;
  if (form.dataset.savedTaskId && taskRecord(form.dataset.savedTaskId)) { go('task/' + form.dataset.savedTaskId); return true; }
  if (form.querySelector('#task-editor-date')?.validity?.badInput) {
    taskToolsReadEditor(form); taskToolsFormError(form, '日期还没有填写完整，请补全年月日或清空。', 'task-editor-date'); return true;
  }
  const result = taskToolsSaveDraft(taskToolsReadEditor(form));
  if (!result.ok) { taskToolsFormError(form, result.message, result.field); return true; }
  form.dataset.savedTaskId = result.id;
  go('task/' + result.id);
  tell(result.existing ? '已打开这条来源已有的关联任务。' : result.proposal ? '已保存本地修改提案，未写回来源。' : '已保存到此浏览器。');
  return true;
}

function taskToolsToggle(id) {
  const task = taskRecord(id);
  if (!task) return;
  const previous = st.tasks, previousUndo = undoTask, was = done(task);
  const nextUndo = { id, was, hadFlag: Object.hasOwn(st.tasks, id), priorFlag: st.tasks[id] };
  st.tasks = { ...st.tasks, [id]: !was };
  if (!taskToolsPersist()) { st.tasks = previous; undoTask = previousUndo; tell('状态未保存，任务保持原样，请重试。'); return; }
  undoTask = nextUndo;
  render(); tell(was ? '已在此浏览器恢复待办。' : '已在此浏览器完成任务，可撤销。');
}

function taskToolsUndo() {
  if (!undoTask) return;
  const previous = st.tasks, undo = undoTask;
  st.tasks = { ...st.tasks };
  if (undo.hadFlag === false) delete st.tasks[undo.id];
  else st.tasks[undo.id] = undo.priorFlag ?? undo.was;
  if (!taskToolsPersist()) { st.tasks = previous; tell('撤销尚未保存，请重试。'); return; }
  undoTask = null; render(); tell('已撤销刚才的任务状态修改。');
}

function taskToolsAgentContext(id) {
  const task = taskRecord(id);
  if (!task) return null;
  const sourceContext = taskToolsSourceContext(task);
  return { kind: 'task', id: task.id, title: task.t, route: 'task/' + task.id, source: taskToolsSourceName(task), demo: true,
    text: ['任务：' + task.t, '状态：' + (done(task) ? '已完成' : '待办'), '计划日期：' + taskToolsDateLabel(task),
      '优先级：' + taskToolsPriorities[task.priority], '任务来源：' + task.src,
      sourceContext ? '关联来源：' + sourceContext.title + (sourceContext.route ? '（#' + sourceContext.route + '）' : '') + '\n来源摘要：' + sourceContext.text : '',
      '说明：' + task.note, '以上是手机原型中的浏览器本地演示资料；任务状态不代表远端服务状态。'].filter(Boolean).join('\n\n'),
    prompt: '请根据这项任务和所附依据，帮我拆成可执行的下一步。' };
}

function taskToolsAction(action, key) {
  if (action === 'task-new') { taskToolsOpenEditor(); return true; }
  if (action === 'task-edit') { taskToolsOpenEditor(key); return true; }
  if (action === 'task' || action === 'task-toggle') { taskToolsToggle(key); return true; }
  if (action === 'undo-task' || action === 'task-undo') { taskToolsUndo(); return true; }
  if (action === 'task-agent') {
    const context = taskToolsAgentContext(key);
    if (context && typeof taskToolsSendToAgent === 'function') taskToolsSendToAgent(context);
    else if (context && typeof agentStartWithMaterial === 'function') agentStartWithMaterial(context);
    else return false;
    return true;
  }
  if (action === 'taskfilter') { taskFilter = ['待办', '已完成', '全部'].includes(key) ? key : '待办'; render(); taskToolsRememberView(); return true; }
  if (action === 'taskdate') { taskDate = taskToolsDates.includes(key) ? key : '所有日期'; render(); taskToolsRememberView(); return true; }
  if (action === 'task-reset') { taskFilter = '待办'; taskDate = '所有日期'; taskToolsQuery = ''; taskToolsSource = '全部来源'; taskToolsSort = '日期优先'; render(); taskToolsRememberView(); return true; }
  if (action === 'task-clear-query') {
    taskToolsQuery = ''; const input = document.querySelector('#task-tools-query'); if (input) { input.value = ''; input.focus(); }
    taskToolsRefreshResults(); return true;
  }
  if (action === 'task-tools-filters') {
    const sources = ['全部来源', ...new Set(taskToolsTasks().map(taskToolsSourceName))];
    sheet('筛选与排序', '<form id="task-tools-filter-form">' + selectField('task-filter-date', '计划日期', taskToolsDates, taskDate) +
      selectField('task-filter-source', '任务或关联资料的来源', sources, taskToolsSource) + selectField('task-filter-sort', '排序方式', taskToolsSorts, taskToolsSort) +
      '<p class="fine">已逾期仅包含未完成任务；未来 7 天包含今天。</p><div class="actions"><button type="submit" class="btn">应用</button>' + btn('取消', 'close', 'outline') + '</div></form>'); return true;
  }
  if (action === 'create-finding-task') {
    if (typeof findings === 'undefined' || !findings[key]) return true;
    const finding = typeof findData === 'function' ? findData(key) : findings[key];
    const titles = { f1: '试一周更容易执行的加班日休息安排', f2: '核对本月医疗支出与退款', f3: '安排一轮实机交互验证', f4: '给一条阅读摘录补上应用场景' };
    taskToolsOpenEditor({ kind: 'finding', id: key, title: finding.t, route: 'finding/' + key, text: finding.body + '\n\n先核对依据，再记录执行结果。', taskTitle: titles[key] });
    return true;
  }
  return false;
}
