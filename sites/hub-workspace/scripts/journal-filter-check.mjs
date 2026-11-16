import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const read = name => readFileSync(new URL('../app/' + name, import.meta.url), 'utf8');
const compile = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText).toString('base64');
const viewUrl = compile(read('journal-local/JournalViews.tsx').replace('from "react"', 'from ' + JSON.stringify(pathToFileURL(require.resolve('react')).href)));
const views = await import(viewUrl);
const filter = await import(compile(read('journal-filter.ts').replaceAll('"./journal-local/JournalViews"', JSON.stringify(viewUrl))));
const base = { ...views.defaultJournalView(), month: '2026-11', ascending: true };
let count = 0;
function test(name, run) { run(); count++; console.log('✓ ' + name); }

test('历史日期的搜索命中不受今天之后七天窗口限制', () => {
  assert.deepEqual(filter.journalStreamDates({ ...base, query: 'Hub' }, '2026-11-16', 7, ['2026-11-01', '2026-11-08']), ['2026-11-01', '2026-11-08']);
});
test('普通月底每日视图不混入下月日期', () => {
  assert.deepEqual(filter.journalStreamDates(base, '2026-11-29', 7, []), ['2026-11-29', '2026-11-30']);
});
test('全部日期覆盖锚点前后并去重', () => {
  assert.deepEqual(filter.journalStreamDates({ ...base, period: 'all' }, '2026-11-16', 7, ['2026-12-01', '2026-10-01', '2026-10-01']), ['2026-10-01', '2026-12-01']);
});
test('指定日期只显示所选日', () => {
  assert.deepEqual(filter.journalStreamDates({ ...base, period: 'day', day: '2026-12-03' }, '2026-11-16', 28, []), ['2026-12-03']);
});
test('筛选无结果时返回空状态而不是空白日期占位', () => {
  assert.deepEqual(filter.journalStreamDates({ ...base, query: '不存在的关键词' }, '2026-11-16', 7, []), []);
});
test('资料库与记录特征条件也定位真实命中日期', () => {
  for (const patch of [{ libraries: ['OS'] }, { recordFilter: 'pinned' }, { libraries: [] }]) {
    assert.equal(filter.journalUsesResultDays({ ...base, ...patch }), true);
  }
});
test('记录与任务日期合并时服从范围和排序', () => {
  assert.deepEqual(filter.journalStreamDates({ ...base, query: '线束', ascending: false }, '2026-11-16', 7, ['2026-11-08', '2026-11-10', '2026-11-08', '2026-12-01', 'bad']), ['2026-11-10', '2026-11-08']);
});
test('显式月范围可修正旧的跨月锚点', () => {
  assert.deepEqual(filter.journalStreamDates({ ...base, month: '2026-12' }, '2026-11-16', 2, []), ['2026-12-01', '2026-12-02']);
});
test('搜索同时覆盖正文、附件名和结构化标签', () => {
  const record = { id: 'test', date: '2026-11-08', text: '一条记录', files: ['Review.PDF'], tags: ['Hub'] };
  for (const query of ['记录', ' review.pdf ', '#hub']) assert.equal(filter.journalMatchesQuery(record, query), true);
  assert.equal(filter.journalMatchesQuery(record, '找不到'), false);
});
test('旧多资料库、空选择和表格布局配置保留明确语义', () => {
  assert.deepEqual(views.normalizeJournalView({ libraries: ['OS', 'Car', 'OS'] }).libraries, ['Car', 'OS']);
  assert.deepEqual(views.normalizeJournalView({ libraries: [] }).libraries, []);
  assert.equal(views.normalizeJournalView({ layout: 'table' }).layout, 'list');
  assert.equal(views.normalizeJournalView({ libraries: null }).libraries, null);
});
test('临时搜索不把保存视图标记为已修改', () => {
  const saved = { ...base, query: '旧关键词' };
  for (const query of ['', 'Hub', '不存在的词']) {
    assert.equal(views.journalViewModified(saved, { ...base, query }), false);
  }
});
test('真实筛选变化仍会标记保存视图已修改', () => {
  for (const patch of [{ libraries: [] }, { recordFilter: 'pinned' }, { period: 'all' }, { layout: 'calendar' }]) {
    assert.equal(views.journalViewModified(base, { ...base, ...patch, query: 'Hub' }), true);
  }
});
test('保存视图排除临时搜索并保留全部筛选及显示配置', () => {
  const current = { ...base, query: '临时查找', libraries: ['Car', 'OS'], recordFilter: 'attachments', compact: true };
  const snapshot = views.journalSavedConfig(current);
  assert.equal(snapshot.query, '');
  assert.deepEqual({ ...snapshot, query: current.query }, current);
  assert.equal(current.query, '临时查找');
});
test('切换或恢复视图保留当前查找而不复活旧搜索词', () => {
  const saved = { ...base, query: '旧词', libraries: ['OS'], period: 'day', day: '2026-11-08' };
  assert.deepEqual(views.journalSelectConfig(saved, 'Hub'), { ...saved, query: 'Hub' });
  assert.equal(views.journalSelectConfig(saved, '').query, '');
  assert.equal(saved.query, '旧词');
});
test('旧视图存储继续接受历史搜索及明确空资料库选择', () => {
  const restored = views.parseJournalViews(JSON.stringify({ version: 1, view: { ...base, query: '会话查找' }, activeId: 'saved', saved: [{ id: 'saved', name: '原有视图', hidden: false, config: { ...base, query: '旧词', libraries: [] } }] }));
  assert.equal(restored.activeId, 'saved');
  assert.equal(restored.view.query, '会话查找');
  assert.equal(restored.saved[0].config.query, '旧词');
  assert.deepEqual(restored.saved[0].config.libraries, []);
  assert.equal(views.journalViewModified(restored.saved[0].config, { ...restored.saved[0].config, query: '新词' }), false);
});
console.log(`${count} 项日志筛选回归通过。`);
