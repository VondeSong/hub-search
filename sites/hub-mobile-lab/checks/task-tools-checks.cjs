const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;

let canSave = true, destination = '', lastSheet = '', lastMessage = '', lastMaterial = null, renders = 0;
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const context = {
  crypto, structuredClone, Date,
  document: { querySelector() { return null; } },
  st: { tasks: {}, customTasks: [], linkedTasks: {} },
  tasks: [
    { id: 't1', t: '示例任务', date: '今天', src: 'Craft · 项目', note: '原始说明' },
    { id: 't2', t: '固定日期', date: '2026-11-13', src: '滴答清单 · 生活', note: '真实年月日' },
    { id: 't3', t: '已完成任务', date: '昨天', src: 'Craft · 项目', note: '', done: true },
  ],
  docs: { d1: { s: 'Craft' } },
  reading: [{ id: 'r1', src: 'X 书签' }],
  findings: { f1: { t: '一条发现', body: '来源依据', docs: ['d1'] } },
  taskFilter: '待办', taskDate: '所有日期', undoTask: null,
  done: task => context.st.tasks[task.id] ?? !!task.done,
  save: () => canSave,
  render: () => renders++,
  go: route => { destination = route; }, close() {},
  sheet: (title, content) => { lastSheet = title + '\n' + content; },
  tell: message => { lastMessage = message; },
  esc: html, ico: () => '',
  btn: (label, action) => '<button data-act="' + action + '">' + html(label) + '</button>',
  plain: (label, action) => '<button data-act="' + action + '">' + html(label) + '</button>',
  iconBtn: (label, action) => '<button aria-label="' + html(label) + '" data-act="' + action + '"></button>',
  chip: (label, action) => '<button data-act="' + action + '">' + html(label) + '</button>',
  row: (title, description, icon, action) => '<button data-act="' + action + '">' + html(title) + html(description) + '</button>',
  group: value => value, intro: (title, description) => title + description,
  detail: (title, badges, body) => html(title) + badges + body, tag: html, missing: () => 'missing',
  selectField: () => '<select></select>',
  agentStartWithMaterial: material => { lastMaterial = material; return { ok: true, threadId: 'demo-thread' }; },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../dist/task-tools.js'), 'utf8'), context);
const originalSeeds = JSON.stringify(context.tasks);
const parse = value => JSON.parse(JSON.stringify(value));

function formFor(key, updates = {}) {
  const draft = { ...context.st.taskEditorDrafts[key], ...updates };
  const nodes = {};
  for (const [name, prop] of [['title', 'title'], ['date', 'dueDate'], ['priority', 'priority'], ['note', 'note']]) {
    nodes['#task-editor-' + name] = { id: 'task-editor-' + name, value: draft[prop] || '',
      setAttribute() {}, removeAttribute() {}, focus() {} };
  }
  nodes['.task-editor-error'] = { textContent: '' };
  nodes['.task-editor-status'] = { textContent: '' };
  const form = { id: 'task-tools-editor', dataset: { draft: key }, querySelector: selector => nodes[selector] || null };
  for (const node of Object.values(nodes)) node.form = form;
  return form;
}

assert.equal(context.taskToolsValidDay('2024-02-29'), true);
assert.equal(context.taskToolsValidDay('2026-02-29'), false);
assert.equal(context.taskToolsValidDay('2026-11-31'), false);
assert.equal(context.taskToolsValidDay('明天'), false);
assert.equal(context.taskToolsValidDay('0000-01-01'), false);
assert.equal(context.taskToolsDueDay(context.taskRecord('t1')), context.taskToolsDay());
assert.equal(context.taskToolsDueDay(context.taskRecord('t2')), '2026-11-13');
assert.equal(context.taskRecord('missing'), undefined);

// Seed edits overlay the source snapshot and preserve legacy relative dates if unchanged.
context.taskToolsOpenEditor('t1');
assert.ok(lastSheet.includes('本地修改提案'));
let form = formFor('edit:t1', { title: '已编辑任务', note: '新说明' });
assert.equal(context.taskToolsSubmit(form), true);
assert.equal(destination, 'task/t1');
assert.equal(context.taskRecord('t1').t, '已编辑任务');
assert.equal(context.taskRecord('t1').date, '今天');
assert.equal(context.taskRecord('t1').dueDate, '');
assert.equal(context.taskRecord('t1').localProposal, true);
assert.equal(JSON.stringify(context.tasks), originalSeeds);

// A deliberately chosen date is persisted as a fixed ISO date.
context.taskToolsOpenEditor('t1');
form = formFor('edit:t1', { dueDate: '2027-02-28', priority: 'high' });
context.taskToolsInput({ target: form.querySelector('#task-editor-date') });
context.taskToolsSubmit(form);
assert.equal(context.taskRecord('t1').date, '2027-02-28');
assert.equal(context.taskRecord('t1').dueDate, '2027-02-28');
assert.equal(context.taskRecord('t1').priority, 'high');
assert.equal(context.taskRecord('t1').src, 'Craft · 项目');

// Failed edit is atomic and keeps the most recent editor draft, including whitespace.
context.taskToolsOpenEditor('t1');
form = formFor('edit:t1', { title: '未保存的新标题', note: '  未保存的草稿  ', dueDate: '2027-03-02' });
const beforeEdit = parse(context.taskRecord('t1'));
canSave = false;
context.taskToolsSubmit(form);
assert.deepEqual(parse(context.taskRecord('t1')), beforeEdit);
assert.equal(context.st.taskEditorDrafts['edit:t1'].title, '未保存的新标题');
assert.equal(context.st.taskEditorDrafts['edit:t1'].note, '  未保存的草稿  ');
assert.ok(form.querySelector('.task-editor-error').textContent.includes('输入仍在草稿里'));
canSave = true;
context.taskToolsSubmit(form);
assert.equal(context.taskRecord('t1').t, '未保存的新标题');
assert.equal(context.st.taskEditorDrafts['edit:t1'], undefined);

// No-date tasks, repeated submits, title validation and invalid dates.
context.taskToolsOpenEditor();
form = formFor('new', { title: '本地新任务', note: '<script>unsafe</script>' });
context.taskToolsSubmit(form);
const newId = form.dataset.savedTaskId;
assert.equal(context.taskRecord(newId).date, '暂不安排');
assert.equal(context.taskToolsDueDay(context.taskRecord(newId)), '');
const numberCreated = context.st.customTasks.length;
context.taskToolsSubmit(form);
assert.equal(context.st.customTasks.length, numberCreated);
assert.ok(context.taskToolsDetail(newId).includes('&lt;script&gt;'));
context.taskToolsOpenEditor();
form = formFor('new', { title: '  ' });
context.taskToolsSubmit(form);
assert.ok(form.querySelector('.task-editor-error').textContent);
assert.equal(context.st.customTasks.length, numberCreated);
form = formFor('new', { title: '不合法日期', dueDate: '2026-02-29' });
context.taskToolsSubmit(form);
assert.ok(form.querySelector('.task-editor-error').textContent.includes('有效'));
form = formFor('new', { title: '日期未输完', dueDate: '' });
form.querySelector('#task-editor-date').validity = { badInput: true };
context.taskToolsSubmit(form);
assert.ok(form.querySelector('.task-editor-error').textContent.includes('填写完整'));
assert.equal(context.st.customTasks.length, numberCreated);

// Linked-source creation is idempotent (including combined thread/message IDs).
const source = { kind: 'agent', id: 'thread-1:message-2', title: '回答里的下一步', route: 'agent-chat/thread-1', text: '先核对，再执行。' };
context.taskToolsOpenEditor(source);
const sourceKey = context.taskToolsDraftKey('', context.taskToolsNormalizeContext(source));
form = formFor(sourceKey);
const countBeforeLink = context.st.customTasks.length;
canSave = false;
context.taskToolsSubmit(form);
assert.equal(context.st.customTasks.length, countBeforeLink);
assert.equal(context.taskToolsFindLinked(context.taskToolsNormalizeContext(source)), undefined);
assert.equal(context.st.taskEditorDrafts[sourceKey].sourceContext.id, 'thread-1:message-2');
canSave = true;
context.taskToolsSubmit(form);
const linkedId = form.dataset.savedTaskId;
assert.ok(linkedId);
context.taskToolsOpenEditor(source);
assert.equal(destination, 'task/' + linkedId);
assert.equal(context.st.customTasks.length, countBeforeLink + 1);
assert.ok(context.taskToolsDetail(linkedId).includes('go:agent-chat/thread-1'));
context.taskToolsAction('task-agent', linkedId);
assert.equal(lastMaterial.id, linkedId);
assert.ok(lastMaterial.text.includes('来源摘要：先核对，再执行。'));
assert.equal(lastMaterial.demo, true);
const noteSource = { kind: 'note', id: 'n-local', title: '本地记录', route: 'note/n-local', text: '需要跟进的速记。' };
context.taskToolsOpenEditor(noteSource);
const noteKey = context.taskToolsDraftKey('', context.taskToolsNormalizeContext(noteSource));
form = formFor(noteKey);
context.taskToolsSubmit(form);
assert.ok(context.taskToolsDetail(form.dataset.savedTaskId).includes('go:note/n-local'));
assert.equal(context.taskToolsSourceName(context.taskRecord(form.dataset.savedTaskId)), '本地记录');

// Legacy finding links are honored; new ones retain the finding round trip.
context.st.customTasks.push({ id: 'old-finding', t: '旧关联任务', src: '洞察 · 本地任务', finding: 'f1', date: '今天' });
context.st.linkedTasks.f1 = 'old-finding';
context.taskToolsAction('create-finding-task', 'f1');
assert.equal(destination, 'task/old-finding');
assert.equal(context.taskToolsSourceContext(context.taskRecord('old-finding')).route, 'finding/f1');
const newFinding = { kind: 'finding', id: 'f2', title: '新的发现', route: 'finding/f2', text: '证据摘要' };
context.taskToolsOpenEditor(newFinding);
const findingKey = context.taskToolsDraftKey('', context.taskToolsNormalizeContext(newFinding));
form = formFor(findingKey);
canSave = false;
context.taskToolsSubmit(form);
assert.equal(context.st.linkedTasks.f2, undefined);
canSave = true;
context.taskToolsSubmit(form);
assert.equal(context.st.linkedTasks.f2, form.dataset.savedTaskId);

// Completion, rollback and exact undo (including removal of a formerly absent override).
assert.equal(context.done(context.taskRecord('t2')), false);
canSave = false;
context.taskToolsToggle('t2');
assert.equal(context.done(context.taskRecord('t2')), false);
assert.equal(context.undoTask, null);
canSave = true;
context.taskToolsToggle('t2');
assert.equal(context.done(context.taskRecord('t2')), true);
canSave = false;
context.taskToolsUndo();
assert.equal(context.done(context.taskRecord('t2')), true);
assert.ok(context.undoTask);
canSave = true;
context.taskToolsUndo();
assert.equal(Object.hasOwn(context.st.tasks, 't2'), false);
assert.equal(context.taskRecord('t2').localProposal, false);
context.taskToolsToggle('t3');
assert.equal(context.done(context.taskRecord('t3')), false);
context.taskToolsUndo();
assert.equal(context.done(context.taskRecord('t3')), true);

// Query/source/date/status and priority sorting use the merged records.
context.taskToolsRestoreView({ query: '未保存 新标题', source: 'Craft', status: '待办', date: '所有日期', sort: '优先级' });
assert.deepEqual(Array.from(context.taskToolsVisibleTasks(), task => task.id), ['t1']);
context.taskToolsRestoreView({ query: '', source: '全部来源', date: '未安排', status: '全部' });
assert.ok(context.taskToolsVisibleTasks().some(task => task.id === newId));
assert.ok(!context.taskToolsVisibleTasks().some(task => task.id === 't1'));
assert.equal(context.taskToolsDateMatches({ date: context.taskToolsDay(-2), id: 'overdue' }, '已逾期'), true);
assert.equal(context.taskToolsDateMatches({ date: context.taskToolsDay(-2), id: 'completed-overdue', done: true }, '已逾期'), false);
assert.equal(context.taskToolsDateMatches({ date: context.taskToolsDay(6) }, '未来7天'), true);
assert.equal(context.taskToolsDateMatches({ date: context.taskToolsDay(7) }, '未来7天'), false);
context.taskToolsAction('task-reset');
assert.ok(context.taskToolsPage().includes('搜索任务、说明和来源'));
const taskHeader = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/mobile.js'), 'utf8') + '\nmobileRootHeader("tasks");', {
  routes: { tasks: '任务' }, esc: html, btn: context.btn, iconBtn: context.iconBtn,
});
assert.equal((taskHeader.match(/data-act="task-new"/g) || []).length, 1, 'task creation has one primary action in the compact shell');
assert.ok(taskHeader.includes('新任务'));
assert.ok(!taskHeader.includes('quick-capture:task'), 'the shell keeps the full task editor instead of the legacy quick-capture task form');
assert.ok(!context.taskToolsPage().includes('task-tools-heading'), 'the task body no longer duplicates the shell title and create action');
const beforePrimaryCreate = context.st.customTasks.length;
assert.equal(context.taskToolsAction('task-new'), true);
assert.ok(lastSheet.includes('新建任务') && lastSheet.includes('task-tools-editor'), 'the moved action still opens the existing draft-safe editor');
assert.equal(context.st.customTasks.length, beforePrimaryCreate, 'opening the editor does not create a task before submission');
assert.equal(context.taskToolsNormalizeContext({ kind: 'doc', id: 'd1', title: 'x', route: 'javascript:alert(1)' }).route, '');
assert.equal(context.taskToolsAction('not-a-task-action'), false);
assert.equal(context.taskToolsSubmit({ id: 'not-a-task-form' }), false);
assert.equal(JSON.stringify(context.tasks), originalSeeds);
assert.ok(renders > 0);
console.log('task-tools-checks: passed (source overlays, dates, drafts, idempotency, rollback, undo, filters, Agents provenance)');
