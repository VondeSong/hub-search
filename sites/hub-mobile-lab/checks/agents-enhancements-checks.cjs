'use strict';

// Focused VM regression checks. No browser, service, credentials or model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;

const root = path.resolve(__dirname, '..');
let canSave = true, saved = 0, destination = '', lastToast = '', clipboardText = '', lastSheet = null, networkCalls = 0;
let taskCall = null;
const elements = {};
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const context = {
  crypto, structuredClone, URL, Date, console,
  setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame() {},
  CustomEvent: function CustomEvent(type) { this.type = type; }, dispatchEvent() {}, addEventListener() {},
  navigator: { clipboard: { writeText: async text => { clipboardText = text; } } },
  fetch: () => { networkCalls++; throw new Error('Unexpected network access'); },
  st: { notes: Array.from({ length: 8 }, (_, i) => ({ id: 'note-' + i, title: '本地记录 ' + i, text: i === 7 ? '深处记录的独特全文关键词' : '本地正文 ' + i, date: '2026-11-13', createdAt: i })) },
  docs: Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['d' + (i + 1), { t: '资料 ' + (i + 1), s: i % 2 ? 'Obsidian' : 'Craft', date: '11 月 13 日', body: '资料正文 ' + (i + 1) }])),
  reading: [{ id: 'r1', t: '阅读测试', src: 'X 书签', body: '阅读文章全文与追溯信息', status: '未读' }],
  save: () => { saved++; return canSave; },
  tell: text => { lastToast = text; }, go: route => { destination = route; },
  render() {}, close() {}, route: () => ['none'],
  sheet: (title, html) => { lastSheet = { title, html }; },
  document: { querySelector: selector => elements[selector] || null },
  window: { scrollTo() {} }, scrolls: {}, innerHeight: 800,
  esc, ico: () => '<svg></svg>', iconBtn: () => '',
  plain: (label, action) => '<button data-act="' + esc(action) + '">' + esc(label) + '</button>',
  btn: (label, action) => '<button data-act="' + esc(action) + '">' + esc(label) + '</button>',
  chip: (label, action, selected) => '<button data-act="' + esc(action) + '" aria-pressed="' + Boolean(selected) + '">' + esc(label) + '</button>',
  row: (title, detail, icon, action) => '<button data-act="' + esc(action) + '">' + esc(title) + ' ' + esc(detail) + '</button>',
  group: body => body, section: (title, body) => '<section>' + esc(title) + body + '</section>',
  intro: (title, text) => '<h1>' + esc(title) + '</h1><p>' + esc(text) + '</p>', tag: text => esc(text),
  workspaceTaskFromAgent: (threadId, messageId) => { taskCall = { threadId, messageId }; }
};
vm.createContext(context);
for (const file of ['dist/agents-runtime.js', 'dist/agents-ui.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
const run = code => vm.runInContext(code, context);
const snapshot = () => JSON.stringify(context.st);
const thread = id => context.agentThread(id);
context.initAgents();

async function check() {
  const seedId = 'ag-seed-reading';
  const originalMessages = JSON.stringify(thread(seedId).messages);
  assert.equal(context.agentRenameThread(seedId, '  阅读   <script>alert(1)</script>  ').ok, true);
  assert.equal(thread(seedId).title, '阅读 <script>alert(1)</script>');
  assert.equal(JSON.stringify(thread(seedId).messages), originalMessages);
  assert.ok(context.agentThreadRows().includes('&lt;script&gt;'));
  assert.ok(!context.agentThreadRows().includes('<script>'));
  const beforeInvalid = snapshot();
  assert.equal(context.agentRenameThread(seedId, '   ').ok, false);
  assert.equal(context.agentRenameThread(seedId, 'a'.repeat(81)).ok, false);
  assert.equal(snapshot(), beforeInvalid);
  canSave = false;
  assert.equal(context.agentRenameThread(seedId, '不应保存').code, 'storage');
  assert.equal(snapshot(), beforeInvalid);
  canSave = true;
  console.log('PASS: rename validation, HTML escaping, message preservation, storage rollback');

  assert.equal(context.agentArchiveThread(seedId, true).ok, true);
  assert.ok(thread(seedId).archivedAt);
  assert.ok(!context.agentThreadRows().includes('go:agent-chat/' + seedId));
  run("agentListScope='archived'; agentListQuery='阅读'");
  assert.ok(context.agentThreadRows().includes('go:agent-chat/' + seedId));
  run("agentListScope='all'; agentListQuery='摘录'");
  assert.ok(context.agentThreadRows().includes('go:agent-chat/' + seedId), 'Search still sees old message text in archived history');
  assert.ok(!context.agentUiComposer(thread(seedId)).includes('id="agent-prompt"'));
  assert.equal(context.agentSend(seedId).code, 'archived');
  const archived = snapshot();
  canSave = false;
  assert.equal(context.agentArchiveThread(seedId, false).code, 'storage');
  assert.equal(snapshot(), archived);
  canSave = true;
  assert.equal(context.agentArchiveThread(seedId, false).ok, true);
  assert.equal(thread(seedId).archivedAt, null);
  const restored = snapshot();
  canSave = false;
  assert.equal(context.agentArchiveThread(seedId, true).code, 'storage');
  assert.equal(snapshot(), restored);
  canSave = true;
  run("agentListScope='active'; agentListQuery=''");
  assert.equal(JSON.stringify(thread(seedId).messages), originalMessages);
  console.log('PASS: archive/restore, all-history search, read-only archived drafts, atomic rollback');

  const activeId = context.agentCreateThread({ prompt: '测试原请求恢复' }).threadId;
  const send = context.agentSend(activeId);
  assert.equal(send.ok, true);
  assert.equal(context.agentArchiveThread(activeId, true).code, 'busy');
  const requestId = context.st.agents.runs[send.runId].requestId;
  context.agentSetConnection('network', 'offline');
  assert.equal(context.st.agents.runs[send.runId].phase, 'unknown');
  context.agentSetConnection('network', 'online');
  assert.equal(context.agentRetry(send.runId).reused, true);
  assert.equal(context.st.agents.runs[send.runId].requestId, requestId);
  assert.equal(context.st.agents.runs[send.runId].launchCount, 1);
  const activeRun = context.st.agents.runs[send.runId];
  context.agentSyncRun(activeRun, activeRun.completeAt + 1);
  assert.equal(activeRun.phase, 'completed');
  assert.equal(context.agentArchiveThread(activeId, true).ok, true);
  assert.equal(thread(activeId).messages.length, 2);
  console.log('PASS: running archive guard, reconnect same request, no duplicate generation/history');

  const catalog = context.agentMaterialCatalog();
  assert.equal(catalog.length, 17);
  assert.ok(catalog.some(item => item.recordId === 'note-7'), 'All local notes, not only the first five');
  assert.ok(catalog.some(item => item.route === 'article/r1' && item.materialType === 'reading'));
  const materialId = context.agentCreateThread().threadId;
  thread(materialId).attachments.push({ id: 'keep-image', kind: 'image', name: '既有图片', dataUrl: 'data:image/png;base64,AA==' });
  for (const selector of ['#agent-material-rows', '#agent-material-filters', '#agent-material-selected', '#agent-material-apply']) elements[selector] = { innerHTML: '', textContent: '', disabled: true };
  context.agentUiSelectDocSheet(materialId);
  context.handleAgentInput({ target: { id: 'agent-material-query', value: '独特全文' } });
  assert.ok(elements['#agent-material-rows'].innerHTML.includes('本地记录 7'));
  assert.ok(!elements['#agent-material-rows'].innerHTML.includes('本地记录 0'));
  const choose = id => context.handleAgentChange({ target: { id: '', dataset: { agentMaterial: id }, checked: true, disabled: false } });
  choose('material-note-note-7');
  context.handleAgentAction('agent-material-filter', 'reading');
  context.handleAgentInput({ target: { id: 'agent-material-query', value: '' } });
  choose('material-reading-r1');
  assert.equal(run('agentMaterialPicker.selected.size'), 2);
  assert.ok(elements['#agent-material-selected'].textContent.includes('已选 2 项'));
  assert.equal(elements['#agent-material-apply'].disabled, false);
  context.handleAgentAction('agent-material-apply', materialId);
  assert.equal(thread(materialId).attachments.length, 3);
  assert.ok(thread(materialId).attachments.some(item => item.id === 'keep-image'));
  assert.ok(thread(materialId).attachments.some(item => item.recordId === 'note-7'));
  assert.ok(thread(materialId).attachments.some(item => item.route === 'article/r1'));
  assert.equal(context.agentAttachMaterials(materialId, [catalog.find(item => item.recordId === 'note-7')]).count, 0);
  const materialsBeforeFailure = snapshot();
  canSave = false;
  assert.equal(context.agentAttachMaterials(materialId, [catalog.find(item => item.docId === 'd8')]).code, 'storage');
  assert.equal(snapshot(), materialsBeforeFailure);
  canSave = true;
  console.log('PASS: full catalog, body/source search, multiselect across filters, explicit-only additions, dedup and rollback');

  const existingRuns = Object.keys(context.st.agents.runs).length;
  const hook = context.agentStartWithMaterial({ kind: 'task', id: 'task-custom-1', title: '核对卡扣', text: '来源：任务\n截止：明天\n内容：核对位置', source: '本地任务', route: 'task/task-custom-1' });
  assert.equal(hook.ok, true);
  assert.equal(destination, 'agent-chat/' + hook.threadId);
  assert.equal(thread(hook.threadId).attachments.length, 1);
  assert.equal(thread(hook.threadId).attachments[0].route, 'task/task-custom-1');
  assert.ok(thread(hook.threadId).attachments[0].text.includes('截止：明天'));
  assert.equal(thread(hook.threadId).messages.length, 0);
  assert.equal(Object.keys(context.st.agents.runs).length, existingRuns);
  const collidingNote = context.agentMaterialFromRecord({ type: 'note', id: 'd3', title: '不同于示例资料的本地笔记', text: '本地内容', route: 'note/d3' });
  assert.equal(collidingNote.name, '不同于示例资料的本地笔记');
  assert.equal(collidingNote.text, '本地内容');
  assert.equal(collidingNote.kind, 'material');
  assert.equal(collidingNote.route, 'note/d3');
  assert.equal(context.agentDemoAnswer({ materials: [], messages: [] }, '请看这份本地笔记', [collidingNote]).citations.length, 0, 'A note named d3 must not trigger the sample-document answer or citation');
  const unsafeRoute = context.agentMaterialFromRecord({ type: 'reading', id: 'safe', title: '<img onerror=x>', body: '<script>bad</script>', route: 'javascript:alert(1)' });
  assert.equal(unsafeRoute.route, '');
  thread(hook.threadId).attachments.push(unsafeRoute);
  context.agentUiShowAttachment(hook.threadId, unsafeRoute.id);
  assert.ok(lastSheet.html.includes('&lt;script&gt;'));
  assert.ok(!lastSheet.html.includes('<script>'));
  const beforeHookFailure = snapshot(), previousDestination = destination;
  canSave = false;
  assert.equal(context.agentStartWithMaterial({ type: 'reading', id: 'r1', title: '阅读', body: '正文', route: 'article/r1' }).code, 'storage');
  assert.equal(snapshot(), beforeHookFailure);
  assert.equal(destination, previousDestination);
  canSave = true;
  console.log('PASS: one-material integration hook, retained provenance, no autosend, local-route validation, rollback');

  for (const address of ['javascript:alert(1)', 'http://external.example', 'https://user:password@example.test', 'https://example.test?token=foo', 'https://example.test#secret']) {
    assert.equal(context.agentValidateDemoConnection(address, '手机').ok, false, address);
  }
  assert.equal(context.agentValidateDemoConnection('https://hub.example.test', 'sk-secret-example').ok, false);
  assert.equal(context.agentValidateDemoConnection('https://hub.example.test', '').ok, false);
  assert.equal(context.agentValidateDemoConnection('http://localhost:3000', '开发手机').ok, true);
  const form = { id: 'agent-setup-form', elements: { address: { value: 'https://hub.example.test' }, nickname: { value: '我的手机' }, scenario: { value: 'unreachable' } } };
  elements['#agent-setup-result'] = { innerHTML: '' };
  const preSetup = snapshot();
  context.handleAgentSubmit(form);
  assert.ok(elements['#agent-setup-result'].innerHTML.includes('模拟失败'));
  assert.equal(run('agentPairingDraft'), null);
  assert.equal(snapshot(), preSetup);
  form.elements.scenario.value = 'success';
  context.handleAgentSubmit(form);
  assert.ok(elements['#agent-setup-result'].innerHTML.includes('不表示真实服务可达'));
  context.handleAgentInput({ target: { id: 'agent-device-nickname', form } });
  assert.equal(run('agentPairingDraft'), null);
  context.handleAgentAction('agent-setup-confirm');
  assert.equal(context.st.agents.setup, undefined);
  context.handleAgentSubmit(form);
  canSave = false;
  context.handleAgentAction('agent-setup-confirm');
  assert.equal(snapshot(), preSetup);
  canSave = true;
  context.handleAgentAction('agent-setup-confirm');
  assert.equal(context.st.agents.setup.demo, true);
  assert.equal(context.st.agents.setup.deviceNickname, '我的手机');
  assert.equal(context.st.agents.setup.serviceAddress, 'https://hub.example.test/');
  assert.deepEqual(Object.keys(context.st.agents.setup).sort(), ['demo', 'deviceNickname', 'pairedAt', 'serviceAddress', 'testedAt']);
  assert.ok(lastToast.includes('未连接或验证真实服务'));
  console.log('PASS: demo onboarding, credential-bearing URL rejection, stale-test invalidation, simulated failure and save rollback');

  const completed = context.st.agents.runs['run-ag-seed-reading'];
  await context.agentUiCopyAnswer(completed.id);
  assert.ok(clipboardText.startsWith(completed.text));
  assert.ok(clipboardText.includes('未调用真实模型'));
  context.navigator.clipboard.writeText = async () => { throw new Error('Denied'); };
  completed.text = '<script>copy safely</script>';
  await context.agentUiCopyAnswer(completed.id);
  assert.equal(lastSheet.title, '手动复制回答');
  assert.ok(lastSheet.html.includes('&lt;script&gt;'));
  assert.ok(!lastSheet.html.includes('<script>'));
  const controls = context.agentUiMessageActions({ id: completed.messageId }, completed);
  assert.ok(controls.includes('agent-copy:'));
  assert.ok(controls.includes('agent-result-task:'));
  context.handleAgentAction('agent-result-task', completed.threadId, completed.messageId);
  assert.deepEqual(taskCall, { threadId: completed.threadId, messageId: completed.messageId });
  console.log('PASS: copy answer and denied-permission fallback, demo marking, result-to-task hook');

  const limits = context.agentUiInputLimits();
  for (const label of ['最多 6 张', '4 MiB', '12 MiB', '30 秒', '最多 3 张', '2 MiB', '合成关键帧']) assert.ok(limits.includes(label), label);
  context.handleAgentAction('agent-model');
  assert.ok(lastSheet.html.includes('固定示例回复'));
  assert.ok(lastSheet.html.includes('非实时模型列表'));
  assert.equal(networkCalls, 0);
  assert.ok(saved > 0);
  console.log('PASS: service/demo constraint separation, transparent model information, zero network calls');
  console.log('Agents enhancement checks completed successfully.');
}
check().catch(error => { console.error(error); process.exitCode = 1; });
