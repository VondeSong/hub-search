const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let canSave = true, destination = '', renders = 0;
const context = {
  st: {
    notes: [{ id: 'd3', text: '本机笔记', date: '2026-11-15' }],
    reviewed: ['c1'], grades: { c1: '记得' }, studyDeck: '阅读方法',
    captureDraft: { text: '保留已有草稿' }
  },
  docs: { d3: { t: '示例笔记', body: '示例原文', date: '11 月 8 日', s: 'Craft', tag: '阅读' }, d5: { t: '另一条', body: '另一条原文' } },
  face: true, cardIndex: 2, reviewTab: 'today',
  reviewDecks: () => ['阅读方法', '复盘方法'],
  allReviewCards: () => [{ id: 'c1', deck: '阅读方法' }, { id: 'c2', deck: '阅读方法' }, { id: 'c3', deck: '复盘方法' }],
  save: () => canSave,
  render: () => { renders++; },
  go: route => { destination = route; },
  tell() {}, recordAttachments: n => n.attachments || [],
  recordDay: n => n.date, journalTags: () => [],
  document: { querySelector: () => null },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync('dist/widgets.js', 'utf8'), context);

const protectedState = () => JSON.stringify({ notes: context.st.notes, reviewed: context.st.reviewed, grades: context.st.grades, draft: context.st.captureDraft });
const before = protectedState();
context.widgetAction('widget-next');
context.widgetAction('widget-tone', 'dark');
context.widgetAction('widget-state', 'empty');
assert.equal(protectedState(), before, 'Preview operations must not grade, edit notes, or alter drafts.');

context.st.widgetPreview = { scopes: [] };
assert.equal(context.widgetRecallPool().length, 0, 'Explicitly empty scope must remain empty.');
context.st.widgetPreview = { scopes: ['samples', 'local'] };
context.widgetAction('widget-open', encodeURIComponent('note/d3'));
assert.equal(destination, 'note/d3');
context.widgetAction('widget-open', encodeURIComponent('doc/d3'));
assert.equal(destination, 'doc/d3', 'Typed IDs must open the exact content.');

context.st.widgetPreview = { kind: 'review', deck: 'current' };
context.widgetAction('widget-study');
assert.equal(destination, 'study');
assert.equal(context.face, true);
assert.equal(context.cardIndex, 2);
assert.equal(context.st.studyDeck, '阅读方法');
assert.equal(context.widgetReviewModel().remaining.length, 1);
assert.equal(protectedState(), before, 'Entering a session must not grade a card.');

context.st.widgetPreview = { scopes: ['samples'] };
canSave = false; destination = '';
context.widgetAction('widget-open', encodeURIComponent('doc/d3'));
assert.equal(destination, 'doc/d3', 'Storage failures must not block reading cached content.');

context.st.widgetPreview = { kind: 'review', deck: 'current' };
const priorRenders = renders;
context.widgetChange({ target: { id: 'widget-deck', value: '2' } });
assert.equal(context.st.widgetPreview.deck, 'current');
assert.ok(renders > priorRenders, 'A failed range save must redraw the original selected value.');

context.st.widgetPreview = { kind: 'review', deck: '复盘方法' };
destination = '';
context.widgetAction('widget-study');
assert.equal(destination, '');
assert.equal(context.st.studyDeck, '阅读方法');
assert.equal(context.face, true);
assert.equal(context.cardIndex, 2);
canSave = true;
context.widgetAction('widget-study');
assert.equal(destination, 'study');
assert.equal(context.st.studyDeck, '复盘方法');
assert.equal(context.face, false);
assert.equal(context.cardIndex, 0);
assert.equal(context.widgetAction('quick-capture', 'note'), false, 'Capture must use the existing handler.');
assert.equal(protectedState(), before);
console.log('PASS: widget scope isolation, typed routes, no grading side effects, session resume, storage-failure reading and selector rollback.');
