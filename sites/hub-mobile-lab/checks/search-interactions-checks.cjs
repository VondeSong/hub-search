'use strict';

// Search interaction contracts. No browser, network, or persistent user data is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const dist = path.resolve(__dirname, '../dist');
const read = file => fs.readFileSync(path.join(dist, file), 'utf8');
const json = value => JSON.parse(JSON.stringify(value));
const decode = value => String(value || '').replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]);
const attr = (tag, name) => decode(tag.match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"'))?.[1] || '');

function makeElement() {
  return {
    open: false, innerHTML: '', textContent: '', hidden: false, value: '', dataset: {},
    style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, focus() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
    close() { this.open = false; }, showModal() { this.open = true; },
  };
}

// Parse only the native form controls exercised here. This deliberately avoids
// assuming the implementation's draft helper names or persistence representation.
function parseScopeForm(html) {
  if (!html.includes('id="workspace-scope-form"')) return null;
  const fields = new Map(), controls = [], groups = [];
  const form = { id: 'workspace-scope-form', dataset: {}, innerHTML: html };
  for (const tag of html.match(/<input\b[^>]*>/g) || []) {
    const input = { ...makeElement(), tagName: 'INPUT', form, id: attr(tag, 'id'),
      name: attr(tag, 'name'), value: attr(tag, 'value'), type: attr(tag, 'type'),
      checked: /\schecked(?:\s|>|=)/.test(tag), indeterminate: false, dataset: {} };
    if (attr(tag, 'data-scope-group')) input.dataset.scopeGroup = attr(tag, 'data-scope-group');
    if (input.id) fields.set(input.id, input);
    if (input.name === 'workspace-scope') controls.push(input);
    if (input.dataset.scopeGroup) groups.push(input);
  }
  for (const match of html.matchAll(/(<select\b[^>]*>)([\s\S]*?)<\/select>/g)) {
    const options = [...match[2].matchAll(/(<option\b[^>]*>)([\s\S]*?)<\/option>/g)].map(option => ({
      value: attr(option[1], 'value') || decode(option[2].replace(/<[^>]+>/g, '')),
      selected: /\sselected(?:\s|>|=)/.test(option[1]),
    }));
    const select = { ...makeElement(), tagName: 'SELECT', form, id: attr(match[1], 'id'), options,
      value: (options.find(option => option.selected) || options[0] || {}).value || '' };
    fields.set(select.id, select);
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    if (!fields.has(match[1])) fields.set(match[1], makeElement());
  }
  form.querySelector = selector => selector.startsWith('#') ? fields.get(selector.slice(1)) || null : makeElement();
  form.querySelectorAll = selector => {
    if (selector.includes('name="workspace-scope"') || selector.includes("name='workspace-scope'")) {
      return selector.includes(':checked') ? controls.filter(control => control.checked) : controls;
    }
    if (selector.includes('data-scope-group')) return groups;
    if (selector === 'input,textarea,select') return [...controls, ...groups, ...fields.values()].filter(control => control.form);
    return [];
  };
  return form;
}

function fixture(saved = {}) {
  const local = new Map(saved.local || []), session = new Map(saved.session || []), elements = new Map();
  const state = { writable: true, localWrites: 0, renders: 0, sheets: 0, closes: 0, snapshots: 0, notices: [], lastSheet: '', form: null };
  const element = selector => {
    if (selector === '#workspace-scope-form') return state.form;
    if (selector.startsWith('#workspace-') && state.form) {
      const field = state.form.querySelector(selector);
      if (field) return field;
    }
    if (!elements.has(selector)) elements.set(selector, makeElement());
    return elements.get(selector);
  };
  const context = {
    crypto, structuredClone, Blob, URL, URLSearchParams, console,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {}, requestAnimationFrame() {},
    location: { hash: '#search' },
    history: { state: { hubDepth: 0 }, replaceState(value) { this.state = value; }, pushState(value) { this.state = value; }, back() {} },
    localStorage: {
      getItem(key) { return local.get(key) || null; },
      setItem(key, value) { if (!state.writable) throw new Error('quota'); local.set(key, value); state.localWrites++; },
    },
    sessionStorage: { getItem(key) { return session.get(key) || null; }, setItem(key, value) { session.set(key, value); } },
    document: { addEventListener() {}, querySelector: element, querySelectorAll() { return []; }, body: element('body'), documentElement: element('html') },
    navigator: {}, window: { scrollY: 0, scrollTo() {}, addEventListener() {} }, innerHeight: 844,
    addEventListener() {}, matchMedia() { return { matches: false }; },
  };
  vm.createContext(context);
  const run = code => vm.runInContext(code, context);
  for (const file of ['mobile.js', 'mobile-features.js', 'workflows.js', 'agents-runtime.js', 'agents-ui.js', 'task-tools.js', 'workspace-tools.js']) run(read(file));
  const app = read('app.js'), startup = app.lastIndexOf('initAgents();\nsetupMobile();');
  assert.ok(startup >= 0, 'find the full-app startup boundary, without executing its browser lifecycle');
  run(app.slice(0, startup));
  context.render = () => state.renders++;
  context.tell = value => state.notices.push(value);
  context.go = destination => { state.destination = destination; };
  context.sheet = (title, html) => {
    state.sheets++;
    state.lastSheet = title + '\n' + html;
    state.form = parseScopeForm(html);
    element('#sheet').open = true;
  };
  context.close = () => { state.closes++; element('#sheet').open = false; state.form = null; };
  context.snapshotMobileSheet = () => state.snapshots++;
  run('initAgents(); mobileRestoreView();');
  const filters = () => json(run('({query,source,searchFolder,searchDate,searchType,scope:workspaceScope(),sort:workspacePrefs().sort})'));
  const configure = (values = {}) => {
    const next = { query: '', source: '全部资料库', searchFolder: '全部分组', searchDate: '不限日期', searchType: '全部类型', scope: null, sort: '相关优先', ...values };
    run(`query=${JSON.stringify(next.query)};source=${JSON.stringify(next.source)};searchFolder=${JSON.stringify(next.searchFolder)};searchDate=${JSON.stringify(next.searchDate)};searchType=${JSON.stringify(next.searchType)};st.workspaceSearch={scope:${JSON.stringify(next.scope)},sort:${JSON.stringify(next.sort)}};`);
  };
  const flush = () => { run('save(); mobileWriteView();'); };
  const stored = () => ({ local: [...local], session: [...session] });
  const openPanel = () => { context.workspaceAction('search-scope'); assert.ok(state.form, 'the filter action opens the expected form'); return state.form; };
  const changePanel = (values = {}) => {
    const form = state.form;
    assert.ok(form, 'a filter panel is open');
    if (values.scope) {
      const inputs = form.querySelectorAll('[name="workspace-scope"]');
      inputs.forEach(input => { input.checked = values.scope.includes(input.value); });
      context.workspaceInput({ target: inputs[0] });
    }
    for (const [key, id] of [['type', 'workspace-type'], ['date', 'workspace-date'], ['sort', 'workspace-sort'], ['folder', 'workspace-folder']]) {
      if (values[key] !== undefined) {
        const input = form.querySelector('#' + id);
        assert.ok(input, 'filter field exists: ' + id);
        input.value = values[key];
        context.workspaceInput({ target: input });
      }
    }
  };
  const panelValues = () => {
    const form = state.form;
    return { scope: form.querySelectorAll('[name="workspace-scope"]:checked').map(input => input.value),
      type: form.querySelector('#workspace-type').value, date: form.querySelector('#workspace-date').value,
      sort: form.querySelector('#workspace-sort').value };
  };
  return { context, run, state, filters, configure, flush, stored, openPanel, changePanel, panelValues };
}

const f = fixture();
const { context: app, run } = f;
const quickTypes = ['全部类型', '资料', '任务', '阅读', '对话', '洞察', '闪卡'];
const allLeaves = json(run('workspaceLeaves()'));

// The filter icon has one purpose; quick type buttons never open the filter sheet.
f.configure();
const searchHtml = app.workspaceSearchPage();
assert.equal((searchHtml.match(/data-act="search-scope"/g) || []).length, 1, 'one comprehensive filter entry on the search page');
for (const type of quickTypes) assert.equal((searchHtml.match(new RegExp('data-act="workspace-type:' + type + '"', 'g')) || []).length, 1, 'one direct type action: ' + type);
assert.ok(searchHtml.includes('试试搜索'), 'suggested words have their own search area');
assert.ok(!/<button\b[^>]*data-act="search-scope"[^>]*>[^<]*全部内容/.test(searchHtml), 'the old all-content popup button is gone');
for (const type of quickTypes) {
  f.configure({ query: '保留的搜索词', source: 'Craft', searchFolder: '项目', searchDate: '11 月', scope: ['craft-projects'], sort: '最近优先' });
  const before = f.filters(), sheets = f.state.sheets;
  assert.equal(app.workspaceAction('workspace-type', type), true);
  assert.deepEqual(f.filters(), { ...before, searchType: type }, 'type switching changes only type: ' + type);
  assert.equal(f.state.sheets, sheets, 'type switch does not open a modal');
  const selected = app.workspaceSearchPage().match(new RegExp('<button\\b[^>]*data-act="workspace-type:' + type + '"[^>]*>'))?.[0];
  assert.ok(selected?.includes('aria-pressed="true"'), 'the applied type is visually and accessibly selected: ' + type);
}
console.log('PASS: unique filter entry, direct quick types, preserved query/scope/date, selected semantics');

// Aggregate documents must include doc + local note records, not tasks or reading.
f.configure();
run("st.notes.push({id:'n-search-plain',kind:'note',title:'测试速记',text:'回归测试',journalDate:'2026-11-13',attachments:[]},{id:'n-search-link',kind:'link',title:'测试链接',text:'链接说明',url:'https://example.com',journalDate:'2026-11-13',attachments:[]});");
const index = app.workspaceIndex();
app.workspaceAction('workspace-type', '资料');
assert.deepEqual(Array.from(app.workspaceMatches(), item => item.key).sort(), Array.from(index.filter(item => ['doc', 'note'].includes(item.kind)), item => item.key).sort(), '资料 means the complete doc/note aggregate');
for (const type of ['笔记', '日志', 'PDF', '链接', '任务', '阅读', '对话', '洞察', '闪卡']) {
  run('searchType=' + JSON.stringify(type));
  const matches = app.workspaceMatches();
  assert.ok(matches.length > 0, 'sample data exercises the exact type: ' + type);
  assert.ok(matches.every(item => item.type === type), 'exact types remain exact: ' + type);
}
app.workspaceAction('workspace-type', '全部类型');
assert.equal(app.workspaceMatches().length, index.length, 'all types restores the entire index, within other unchanged conditions');
console.log('PASS: document aggregate, precise legacy types, and all-type results');

// Remove one applied filter, never silently clear the query or sibling filters.
const defaults = { scope: allLeaves, source: '全部资料库', folder: '全部分组', date: '不限日期', type: '全部类型' };
const stateKeys = { scope: 'scope', source: 'source', folder: 'searchFolder', date: 'searchDate', type: 'searchType' };
const constrained = { query: '不能清除的搜索词', source: 'Craft', searchFolder: '项目', searchDate: '11 月', searchType: 'PDF', scope: ['craft-projects'], sort: '最近优先' };
for (const key of Object.keys(defaults)) {
  f.configure(constrained);
  const before = f.filters(), sheets = f.state.sheets;
  assert.equal(app.workspaceAction('workspace-clear-filter', key), true);
  assert.deepEqual(f.filters(), { ...before, [stateKeys[key]]: defaults[key] }, 'only the selected filter is cleared: ' + key);
  assert.equal(f.state.sheets, sheets, 'removing a filter does not open a modal');
}
f.configure(constrained);
const badges = app.workspaceSearchPage();
for (const key of Object.keys(defaults)) assert.ok(badges.includes('workspace-clear-filter:' + key), 'active condition has its own clear action: ' + key);
console.log('PASS: individually removable filters preserve query and all sibling conditions');

// Committed quick actions are atomic when localStorage is unavailable.
for (const [action, key] of [['workspace-type', '任务'], ...Object.keys(defaults).map(key => ['workspace-clear-filter', key])]) {
  f.configure(constrained);
  f.flush();
  const before = f.filters(), storedBefore = f.stored(), sheets = f.state.sheets;
  f.state.writable = false;
  app.workspaceAction(action, key);
  assert.deepEqual(f.filters(), before, 'storage failure rolls back ' + action + ':' + key);
  assert.deepEqual(f.stored(), storedBefore, 'failed action changes neither persisted store');
  assert.equal(f.state.sheets, sheets);
  f.state.writable = true;
}
console.log('PASS: failed quick type/filter saves roll back applied state and persisted storage');

// Opening, changing, resetting and cancelling only edit the panel draft.
f.configure(constrained);
f.flush();
const applied = f.filters(), storedApplied = f.stored(), writes = f.state.localWrites;
f.openPanel();
assert.equal(f.state.form.querySelector('#workspace-folder')?.value, constrained.searchFolder, 'a legacy tag is explicitly visible in the panel, not a hidden restriction');
const details = f.state.lastSheet.match(/<details\b[^>]*class="[^"]*scope-library[^>]*>/g) || [];
assert.ok(details.length > 0, 'the scope tree remains available');
assert.ok(details.every(tag => !/\sopen(?:\s|>|=)/.test(tag)), 'all scope groups start collapsed');
assert.ok(f.state.lastSheet.includes('data-act="workspace-scope-reset"'), 'reset is an unapplied panel action');
assert.ok(!f.state.lastSheet.includes('data-act="clear-scope"'), 'panel reset is not the old immediate applied-state reset');
f.changePanel({ scope: ['reading-telegram'], type: '阅读', date: '不限日期', sort: '相关优先' });
assert.deepEqual(f.filters(), applied, 'editing controls does not apply filters');
assert.deepEqual(f.stored(), storedApplied, 'editing controls does not persist applied filters');
app.workspaceAction('workspace-scope-reset');
assert.deepEqual(f.filters(), applied, 'reset changes only the draft');
assert.deepEqual(f.panelValues(), { scope: allLeaves, type: '全部类型', date: '不限日期', sort: '相关优先' }, 'reset displays the default draft');
assert.equal(f.state.form.querySelector('#workspace-folder')?.value, '全部分组', 'reset also clears the visible legacy tag draft');
assert.equal(f.state.localWrites, writes, 'neither opening, editing nor resetting writes the applied state');
app.close();
assert.deepEqual(f.filters(), applied, 'cancel leaves applied filters intact');
f.openPanel();
assert.deepEqual(f.panelValues(), { scope: constrained.scope, type: constrained.searchType, date: constrained.searchDate, sort: constrained.sort }, 'reopening restores applied values, not the cancelled reset');
console.log('PASS: collapsed tree, unapplied control edits/reset, cancellation and reopening');

// Only Apply commits. A failed commit leaves an editable draft and the original results.
f.changePanel({ scope: ['reading-telegram'], type: '阅读', date: '不限日期', sort: '相关优先' });
const draft = f.panelValues(), closes = f.state.closes;
f.state.writable = false;
assert.equal(app.workspaceSubmit(f.state.form), true);
assert.deepEqual(f.filters(), applied);
assert.deepEqual(f.panelValues(), draft, 'failed apply retains the changed controls for retry');
assert.equal(f.state.closes, closes, 'failed apply stays open');
assert.deepEqual(f.stored(), storedApplied, 'failed apply does not partially persist');
f.state.writable = true;
app.workspaceSubmit(f.state.form);
assert.deepEqual(f.filters(), { ...applied, source: '全部资料库', searchFolder: constrained.searchFolder, scope: ['reading-telegram'], searchType: '阅读', searchDate: '不限日期', sort: '相关优先' }, 'apply normalizes source into the tree and retains the explicitly visible tag');
assert.equal(f.state.closes, closes + 1, 'successful apply closes once');
assert.equal(f.filters().query, constrained.query, 'applying the panel preserves the search term');
f.openPanel();
app.workspaceAction('workspace-scope-reset');
app.workspaceSubmit(f.state.form);
assert.deepEqual(f.filters(), { query: constrained.query, source: '全部资料库', searchFolder: '全部分组', searchDate: '不限日期', searchType: '全部类型', scope: allLeaves, sort: '相关优先' }, 'a reset takes effect only after apply');
console.log('PASS: apply-only commits, failed-apply rollback and retry, applied reset preserves query');

// Legacy source filters are represented by the tree without broadening results.
const sourceCase = fixture();
sourceCase.configure({ source: 'Craft', scope: ['craft-projects', 'reading-telegram'] });
const sourceResults = Array.from(sourceCase.context.workspaceMatches(), item => item.key).sort();
sourceCase.openPanel();
assert.deepEqual(sourceCase.panelValues().scope, ['craft-projects'], 'the panel reflects source intersected with saved scope');
sourceCase.context.workspaceSubmit(sourceCase.state.form);
assert.deepEqual(Array.from(sourceCase.context.workspaceMatches(), item => item.key).sort(), sourceResults, 'applying the unchanged panel does not broaden legacy source results');
assert.equal(sourceCase.filters().source, '全部资料库');
assert.deepEqual(sourceCase.filters().scope, ['craft-projects']);
sourceCase.openPanel();
sourceCase.changePanel({ scope: [] });
assert.ok(sourceCase.state.form.querySelector('#workspace-filter-summary').textContent.includes('未选择资料'), 'zero-scope draft is clearly explained before apply');
sourceCase.context.workspaceSubmit(sourceCase.state.form);
assert.equal(sourceCase.context.workspaceMatches().length, 0, 'an explicitly empty scope stays empty');
assert.ok(sourceCase.context.workspaceSearchResults().includes('清除搜索与筛选'), 'empty results retain a recovery action');
const emptyState = sourceCase.filters(), invalidWrites = sourceCase.state.localWrites;
sourceCase.context.workspaceAction('workspace-type', 'not-a-type');
sourceCase.context.workspaceAction('workspace-clear-filter', 'not-a-filter');
assert.deepEqual(sourceCase.filters(), emptyState, 'unknown actions cannot accidentally broaden search');
assert.equal(sourceCase.state.localWrites, invalidWrites);
console.log('PASS: legacy source/tree equivalence, explicit empty scope and invalid-action safety');

// The existing session format, precise old types and new aggregate all survive restoration.
f.configure({ query: '恢复的词', source: 'Craft', searchFolder: '项目', searchDate: '11 月', searchType: 'PDF', scope: ['craft-projects'], sort: '最近优先' });
f.flush();
const oldFormat = fixture(f.stored());
assert.deepEqual(oldFormat.filters(), f.filters(), 'legacy precise filters and saved multi-scope are restored');
assert.ok(oldFormat.run('st.notes.some(note=>note.id==="n-search-link")'), 'restoring preferences does not reset existing notes');
oldFormat.context.workspaceAction('workspace-type', '资料');
oldFormat.flush();
const aggregated = fixture(oldFormat.stored());
assert.deepEqual(aggregated.filters(), oldFormat.filters(), 'new aggregate is accepted by restoration alongside legacy scopes');
assert.equal(aggregated.filters().searchType, '资料');
const newVisit = fixture({ local: oldFormat.stored().local });
assert.deepEqual({ ...newVisit.filters(), query: oldFormat.filters().query }, oldFormat.filters(), 'applied conditions survive a new visit without the previous tab session');
assert.ok(f.state.renders > 0, 'direct actions refresh visible search state');
console.log('PASS: precise/aggregate persistence compatibility and preservation of existing data');
console.log('Search interaction checks completed successfully. Browser layout and history traversal remain separate UI acceptance checks.');
