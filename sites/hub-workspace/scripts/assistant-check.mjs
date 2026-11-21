import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function loadFunctions(file, names, prefixOnly = false) {
  let text = readFileSync(new URL(file, import.meta.url), 'utf8');
  if (prefixOnly) text = text.slice(0, text.indexOf('export default function Assistant'));
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  text = tree.statements.filter(node => !ts.isImportDeclaration(node) && (prefixOnly || (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)))).map(node => node.getText(tree)).join('\n');
  text += '\nexport { ' + names.join(', ') + ' };';
  const { outputText } = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}
const { readSettings, readConversation, readSession, readResources, reducer, pauseConversation, resourcesForTurn, replyCitations } = await loadFunctions('../app/Assistant.tsx', ['readSettings', 'readConversation', 'readSession', 'readResources', 'reducer', 'pauseConversation', 'resourcesForTurn', 'replyCitations'], true);
const { clampPanelSize } = await loadFunctions('../app/AssistantChrome.tsx', ['clampPanelSize']);
const { publicUrl } = await loadFunctions('../app/AssistantResources.tsx', ['publicUrl']);
const { historyGroup } = await loadFunctions('../app/AssistantHistory.tsx', ['historyGroup']);
const { resolveTopicSources } = await loadFunctions('../app/AssistantResearch.tsx', ['resolveTopicSources']);
const { cleanTagStarter, prepareTagTask } = await loadFunctions('../app/tag-task.ts', ['cleanTagStarter','prepareTagTask']);
const memorySource = readFileSync(new URL('../app/assistant-memory.ts', import.meta.url), 'utf8');
const memoryCode = ts.transpileModule(memorySource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const memory = await import('data:text/javascript;base64,' + Buffer.from(memoryCode).toString('base64'));
assert.equal(cleanTagStarter('查找可能漏标的内容：'),'');
assert.equal(cleanTagStarter('请比较 #方法 和 #工具，重点看边界'),'请比较 #方法 和 #工具，重点看边界');
assert.ok('error' in prepareTagTask('definition',['方法'],'方法','',false,false));
assert.ok('error' in prepareTagTask('missing',['方法'],'方法','',true,false));
assert.ok('error' in prepareTagTask('relation',['方法','工具'],'方法','方法',true,true));
assert.ok('error' in prepareTagTask('definition',['方法'],'工具','',true,true));
assert.deepEqual(prepareTagTask('relation',['方法','工具'],'方法','工具',true,true),{task:{intent:'relation',tag:'方法',other:'工具'}});
assert.deepEqual(prepareTagTask('definition',['方法','工具'],'方法','',true,false),{task:{intent:'definition',tag:'方法'}});
let checks = 0;
function check(label, fn) { fn(); checks++; console.log('✓ ' + label); }
const empty = () => ({ messages: [], active: null, queue: [], frozen: false });
const request = (id, settings = {}) => ({ ...readSettings(null), ...settings, id, text: '核对材料 ' + id, context: { id: 'source-' + id, title: '示例 ' + id, excerpt: '示例正文' }, attachmentNames: [], additions: [] });
check('行内引用按出现顺序编号，旧摘录兼容且不把无关段落当作引用', () => {
  const evidence = [{ id: 'a', title: '同名', excerpt: '第一份原文' }, { id: 'b', title: '同名', excerpt: '第二份原文' }, { id: 'c', title: '仅关联', excerpt: '背景原文' }];
  const context = { id: 'a', title: '同名', excerpt: '第一份原文', evidence };
  const message = { id: 'old', role: 'assistant', text: '演示', context, sections: [
    { heading: '1. 同名', body: '第一份原文' }, { heading: '网页补充', body: '第二份原文' },
    { heading: '交叉核对', body: '同时核对两份材料', sourceIds: ['b', 'a', 'b', '未知'] },
  ] };
  const { sections, numbers, unplaced } = replyCitations(readSession({ messages: [message] }).messages[0]);
  assert.deepEqual(sections.map(items => items.map(item => item.id)), [['a'], [], ['b', 'a']]);
  assert.deepEqual([...numbers.entries()], [['a', 1], ['b', 2]]);
  assert.deepEqual(unplaced.map(item => item.id), ['c']);
});
check('专题核对区分可用与缺失来源，保留缺失项名称及原配置', () => {
  const scope = {pageIds: ['page-ok', 'page-lost'], libraryIds: ['vault', 'old-vault'], pageLabels: {'page-lost': '旧笔记'}, libraryLabels: {'old-vault': '旧资料库'}};
  const catalog = [{id:'page-ok', title:'当前标题', libraryId:'vault', libraryName:'Obsidian'}, {id:'other', title:'未选择的页面', libraryId:'other-vault'}];
  const reviewed = resolveTopicSources(scope, catalog);
  assert.deepEqual(reviewed.pages.map(item => item.id), ['page-ok']);
  assert.deepEqual(reviewed.libraryIds, ['vault']);
  assert.deepEqual(reviewed.sources.filter(item => !item.available).map(item => item.label), ['旧笔记', '旧资料库']);
  assert.equal(reviewed.sources[0].label, '当前标题');
  assert.equal(resolveTopicSources(scope, []).sources.some(item => item.available), false);
  assert.deepEqual(scope.pageIds, ['page-ok', 'page-lost']);
});
check('专题和手选分别恢复，相同项去重但保留手选来源', () => {
  const shared = { id: 'p1', title: '共用页' }, manual = { id: 'p2', title: '仅手选' };
  const restored = readConversation({ input: '草稿', activeTopic: { id: 'topic-1', name: '评审', scope: { pages: [shared], libraryIds: ['craft'], skills: ['hub-research', 'hub-note-edit'] }, policy: 'materials-only', previousPolicy: 'open' }, resources: { pages: [manual, shared], libraryIds: ['craft', 'obsidian'], skills: ['hub-research', 'hub-statistics'], url: 'https://example.org/' } });
  const { activeTopic: topic, resources } = restored;
  assert.equal(topic.policy, 'materials-only');
  assert.equal(topic.previousPolicy, 'open');
  const base = resourcesForTurn(resources, topic);
  assert.deepEqual(base.pages.map(page => page.id), ['p1']);
  assert.deepEqual(base.libraryIds, ['craft']);
  assert.deepEqual(base.skills, ['hub-research', 'hub-statistics', 'hub-note-edit']);
  assert.equal(base.url, '');
  const included = resourcesForTurn(resources, { ...topic, useManualOnce: true });
  assert.deepEqual(included.pages.map(page => page.id), ['p1', 'p2']);
  assert.deepEqual(included.libraryIds, ['craft', 'obsidian']);
  assert.equal(included.url, 'https://example.org/');
  assert.equal(restored.input, '草稿');
  assert.deepEqual(resourcesForTurn(resources, null).pages.map(page => page.id), ['p2', 'p1']);
  assert.deepEqual(resourcesForTurn(resources, null).skills, ['hub-research', 'hub-statistics']);
});
check('旧专题将已标注的内容拆开，其余仍归手选', () => {
  const restored = readConversation({ activeTopic: { id: 'old', name: '旧专题', pageIds: ['p1'], libraryIds: ['craft'], addedSkillIds: ['hub-research'] }, resources: { pages: [{ id: 'p1', title: '专题页' }, { id: 'p2', title: '手选页' }], libraryIds: ['craft', 'obsidian'], skills: ['hub-research', 'hub-statistics'] } });
  assert.deepEqual(restored.activeTopic.scope.pages.map(page => page.id), ['p1']);
  assert.deepEqual(restored.activeTopic.scope.skills, ['hub-research']);
  assert.deepEqual(restored.resources.pages.map(page => page.id), ['p2']);
  assert.deepEqual(restored.resources.libraryIds, ['obsidian']);
  assert.deepEqual(restored.resources.skills, ['hub-statistics']);
  assert.equal(readConversation({ activeTopic: { id: 'broken' } }).activeTopic, null);
});
check('旧会话兼容并校验新增设置', () => {
  const old = readConversation({ model: 'deepseek', input: '保留输入', contexts: [{ id: 'a', title: '旧资料' }] });
  assert.equal(old.input, '保留输入'); assert.equal(old.inputContext.id, 'a'); assert.equal(old.model, 'deepseek');
  assert.equal(old.webSearch, 'live'); assert.equal(old.externalMcp, false);
  assert.equal(readSettings({ webSearch: 'cached', externalMcp: true }).webSearch, 'cached');
  assert.equal(readSettings({ webSearch: 'invalid', externalMcp: 'true' }).externalMcp, false);
});
check('刷新时暂停运行与队列，不丢失输入或附件', () => {
  let state = reducer(empty(), { type: 'send', request: request('a') });
  state = reducer(state, { type: 'send', request: request('b') });
  const restored = readConversation({ session: state, input: '未发送', attachmentNames: ['材料.txt'] });
  assert.equal(restored.session.active.status, 'paused'); assert.equal(restored.session.frozen, true);
  assert.equal(restored.session.queue[0].id, 'b'); assert.equal(restored.input, '未发送'); assert.deepEqual(restored.attachmentNames, ['材料.txt']);
});
check('排队保留发送时的模型与额度快照', () => {
  let state = reducer(empty(), { type: 'send', request: request('a', { model: 'codex' }) });
  state = reducer(state, { type: 'send', request: request('b', { model: 'deepseek', taskMode: 'extended' }) });
  state = reducer(state, { type: 'complete', id: 'a' });
  assert.equal(state.active.id, 'b'); assert.equal(state.active.model, 'deepseek'); assert.equal(state.active.taskMode, 'extended'); assert.equal(state.queue.length, 0);
});
check('立即追加保留当前请求和附件，递增本轮版本', () => {
  let state = reducer(empty(), { type: 'send', request: request('a') });
  state = reducer(state, { type: 'append', id: 'follow', text: '保留前导零', attachmentNames: ['附件.txt'] });
  assert.equal(state.active.id, 'a'); assert.equal(state.active.revision, 1); assert.equal(state.active.additions[0], '保留前导零'); assert.equal(state.active.attachmentNames[0], '附件.txt');
});
check('停止后不接受迟到完成，恢复才继续执行', () => {
  let state = reducer(empty(), { type: 'send', request: request('a') });
  state = reducer(state, { type: 'stop' }); const stopped = state;
  assert.equal(reducer(state, { type: 'complete', id: 'a' }), stopped);
  state = reducer(state, { type: 'continue' }); assert.equal(state.active.status, 'running');
  assert.equal(reducer(state, { type: 'complete', id: 'wrong' }), state);
  assert.equal(reducer(state, { type: 'complete', id: 'a' }).active, null);
});
check('切换对话暂停原工作，保留历史和排队请求', () => {
  let state = reducer(empty(), { type: 'send', request: request('a') });
  state = reducer(state, { type: 'send', request: request('b') });
  const paused = pauseConversation(readConversation({ session: state }));
  assert.equal(paused.session.active.status, 'paused'); assert.equal(paused.session.messages[0].text, request('a').text); assert.equal(paused.session.queue.length, 1);
});
check('移除不可用请求后仍保留历史且不自动运行队列', () => {
  let state = reducer(empty(), { type: 'send', request: request('a') });
  state = reducer(state, { type: 'send', request: request('b') });
  state = reducer(state, { type: 'discard-active' });
  assert.equal(state.active, null); assert.equal(state.frozen, true); assert.equal(state.messages.length, 1); assert.equal(state.queue.length, 1);
  assert.equal(reducer(state, { type: 'continue' }).active.id, 'b');
});
check('异常快照过滤无效消息、来源和超长附件列表', () => {
  const restored = readSession({ messages: [{ role: 'bad', text: '无效' }, { id: 'a', role: 'user', text: '保留', context: { title: '无身份' } }], queue: [null] });
  assert.equal(restored.messages.length, 1); assert.equal(restored.messages[0].context, null); assert.equal(restored.queue.length, 0);
  assert.equal(readConversation({ attachmentNames: Array.from({ length: 20 }, (_, i) => 'file-' + i) }).attachmentNames.length, 8);
});
check('浮窗尺寸限制于视口，支持窄窗口、键盘步进和非负下限', () => {
  assert.equal(clampPanelSize(440, 1440, 0, 1200), 440); assert.equal(clampPanelSize(9000, 1440, 0, 1200), 1200);
  assert.equal(clampPanelSize(440, 320, 0, 1200), 296); assert.equal(clampPanelSize(-100, 1440, 0, 1200), 0);
  assert.equal(clampPanelSize(10, 800, 320, Infinity), 320); assert.equal(clampPanelSize(320, 200, 320, Infinity), 176);
});
check('具体模型只能匹配对应提供方，推理默认与连接设置严格校验', () => {
  assert.equal(readSettings({ model: 'codex', modelId: 'deepseek-analysis' }).modelId, null);
  const settings = readSettings({ model: 'deepseek', modelId: 'deepseek-analysis', thinking: 'xhigh', reasoningDefault: false, mcpServices: ['Craft', 'unknown'], inputLimit: -2 });
  assert.equal(settings.modelId, 'deepseek-analysis'); assert.equal(settings.thinking, 'xhigh'); assert.equal(settings.reasoningDefault, false); assert.deepEqual(settings.mcpServices, ['Craft']); assert.equal(settings.inputLimit, 0);
});
check('资料、技能和图片快照有边界，不恢复未知技能或不安全链接', () => {
  const resources = readResources({ pages: Array.from({ length: 50 }, (_, i) => ({ id: 'p' + i, title: '资料' })), skills: ['hub-research', 'unknown'], images: Array.from({length:10},(_,i)=>String(i)), dataFiles:Array.from({length:10},(_,i)=>'file'+i), url: 'javascript:alert(1)' });
  assert.equal(resources.pages.length, 31); assert.equal(resources.images.length, 8); assert.equal(resources.dataFiles.length,8); assert.deepEqual(resources.skills, ['hub-research']); assert.equal(resources.url, '');
});
check('公共链接拒绝 HTTP、相对地址和嵌入凭据，合法地址规范化', () => {
  assert.equal(publicUrl('http://example.org'), null); assert.equal(publicUrl('/relative'), null); assert.equal(publicUrl('https://user:pass@example.org'), null);
  assert.equal(publicUrl(' https://example.org '), 'https://example.org/'); assert.equal(publicUrl(''), '');
});
check('新增选项与资料随对话和请求恢复，旧记录保持兼容', () => {
  const restored = readConversation({ autoFlashcardInbox: true, memoryEnabled: true, inputLimit: 1000, resources: { pages: [{ id: 'p1', title: '资料', libraryId: 'craft' }], skills: ['hub-research'], libraryIds: ['craft'], url: 'https://example.org/' } });
  assert.equal(restored.autoFlashcardInbox, true); assert.equal(restored.memoryEnabled, true); assert.equal(restored.inputLimit, 1000); assert.equal(restored.resources.pages[0].libraryId, 'craft'); assert.equal(restored.resources.url, 'https://example.org/');
});
check('历史分组使用置顶和日历边界，未知时间进入更早', () => {
  const now = new Date(2026, 10, 8, 12).getTime();
  assert.equal(historyGroup({ pinned: true }, now), '已固定'); assert.equal(historyGroup({ updatedAt: now }, now), '今天');
  assert.equal(historyGroup({ updatedAt: new Date(2026, 10, 7).getTime() }, now), '过去 30 天'); assert.equal(historyGroup({}, now), '更早');
});
check('旧任务类型迁移为可移除技能；对话与队列保留原选择', () => {
  const value = readConversation({ taskKind: 'hub-research', resources: { skills: ['hub-research', 'hub-statistics'] }, taskMode: 'extended', thinking: 'max', model: 'codex', modelId: 'codex-6-astra', speed: 'fast', session: { queue: [{ id: 'q', text: '核对', taskKind: 'hub-archive' }] } });
  assert.deepEqual(value.resources.skills, ['hub-research', 'hub-statistics']);
  assert.deepEqual(value.session.queue[0].resources.skills, ['hub-archive']);
  assert.equal(value.taskMode, 'auto'); assert.equal(value.thinking, 'max'); assert.equal(value.modelId, 'codex-6-astra'); assert.equal(value.speed, 'fast');
  assert.deepEqual(readConversation({ taskKind: 'unknown' }).resources.skills, []);
});
check('DeepSeek 思考开关独立保存，默认启用且不覆盖强度', () => {
  assert.equal(readSettings({ model: 'deepseek' }).deepseekThinking, true);
  const value = readSettings({ model: 'deepseek', deepseekThinking: false, thinking: 'max' });
  assert.equal(value.deepseekThinking, false); assert.equal(value.thinking, 'max');
});
check('新请求默认自动，旧暂停和排队请求保留冻结的执行模式', () => {
  const old = readConversation({ taskMode: 'extended', input: '保留草稿', session: { active: { ...request('old-a', { taskMode: 'standard' }), status: 'running' }, queue: [request('old-b', { taskMode: 'extended' })], messages: [] } });
  assert.equal(old.taskMode, 'auto'); assert.equal(readSettings(null).taskMode, 'auto');
  assert.equal(old.input, '保留草稿'); assert.equal(old.session.active.taskMode, 'standard');
  assert.equal(old.session.active.status, 'paused'); assert.equal(old.session.queue[0].taskMode, 'extended');
  assert.equal(old.session.frozen, true);
});
check('记忆首次关闭，主动偏好与旧聊天快照独立；失效范围不会扩大授权', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const saved = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } });
  try {
    assert.deepEqual(memory.loadMemoryPreference(), { memoryEnabled: false, memoryScope: 'general' });
    assert.equal(memory.rememberMemoryPreference({ memoryEnabled: true, memoryScope: 'hub' }), true);
    const old = readConversation({ memoryEnabled: false, memoryScope: 'general', input: '保留原聊天' });
    assert.equal(old.memoryEnabled, false);
    assert.equal(old.memoryScope, 'general');
    assert.deepEqual(memory.loadMemoryPreference(), { memoryEnabled: true, memoryScope: 'hub' });
    const fresh = readConversation(memory.loadMemoryPreference());
    assert.equal(fresh.memoryEnabled, true); assert.equal(fresh.memoryScope, 'hub');
    memory.rememberMemoryPreference({ memoryEnabled: false, memoryScope: 'hub' });
    assert.deepEqual(memory.loadMemoryPreference(), { memoryEnabled: false, memoryScope: 'hub' });
    assert.equal(readSettings({ memoryEnabled: true, memoryScope: 'removed-project' }).memoryEnabled, false);
    assert.deepEqual(memory.readMemoryPreference({ memoryEnabled: true, memoryScope: 'removed-project' }), { memoryEnabled: false, memoryScope: 'general' });
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; }
});
check('确认建议仅保存一次且固定项目；忽略不生成记忆，存储往返保持状态', () => {
  const initial = memory.createMemoryDemoState();
  const proposal = initial.proposals[0];
  const ignored = memory.changeMemoryState(initial, { type: 'dismiss', id: proposal.id });
  assert.equal(ignored.proposals.length, 0); assert.equal(ignored.entries.length, initial.entries.length);
  const accepted = memory.changeMemoryState(initial, { type: 'accept', id: proposal.id });
  assert.equal(accepted.proposals.length, 0); assert.equal(accepted.entries.length, initial.entries.length + 1);
  assert.equal(accepted.entries.at(-1).scope, 'hub'); assert.equal(accepted.entries.at(-1).use, 'relevant');
  assert.equal(memory.changeMemoryState(accepted, { type: 'accept', id: proposal.id }), accepted);
  assert.deepEqual(memory.readMemoryState(JSON.parse(JSON.stringify(accepted))), accepted);
});
check('修改记忆保留前后记录和停用状态，遗忘同时移除正文与修改历史', () => {
  const initial = memory.createMemoryDemoState(), entry = initial.entries[0];
  const inactive = memory.changeMemoryState(initial, { type: 'toggle', id: entry.id });
  const edited = memory.changeMemoryState(inactive, { type: 'edit', id: entry.id, title: entry.title, body: '先列结论，再用表格展示依据。', use: 'relevant' });
  const current = edited.entries.find(item => item.id === entry.id);
  assert.equal(current.state, 'inactive'); assert.equal(current.scope, 'general');
  assert.equal(current.history[0].before.body, entry.body); assert.equal(current.history[0].after.body, current.body);
  assert.deepEqual(memory.readMemoryState(JSON.parse(JSON.stringify(edited))), edited);
  const forgotten = memory.changeMemoryState(edited, { type: 'forget', id: entry.id });
  assert.equal(forgotten.entries.some(item => item.id === entry.id), false);
  assert.equal(JSON.stringify(forgotten).includes(current.body), false); assert.equal(JSON.stringify(forgotten).includes(entry.body), false);
});
check('损坏记忆快照保留为不可读取，容量边界不会写入下次无法恢复的数据', () => {
  const initial = memory.createMemoryDemoState();
  assert.equal(memory.readMemoryState({ ...initial, version: 9 }), null);
  assert.equal(memory.readMemoryState({ ...initial, entries: [initial.entries[0], initial.entries[0]] }), null);
  assert.equal(memory.readMemoryState({ ...initial, entries: [{ ...initial.entries[0], history: [{ at: 1, before: {}, after: {} }] }] }), null);
  const full = { ...initial, entries: Array.from({ length: 80 }, (_, index) => ({ ...initial.entries[0], id: 'entry-' + index })) };
  assert.ok(memory.readMemoryState(full));
  assert.equal(memory.changeMemoryState(full, { type: 'accept', id: initial.proposals[0].id }), full);
});
console.log(`${checks} 项助手状态检查通过。`);
