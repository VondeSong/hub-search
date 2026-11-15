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
  const handlers = new Map();
  return {
    open: false, innerHTML: '', textContent: '', hidden: false, value: '', dataset: {},
    style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, callback) { const values=handlers.get(type)||[];values.push(callback);handlers.set(type,values); },
    emit(type, event) { for(const callback of handlers.get(type)||[])callback(event); },
    focus() {}, blur() {}, querySelector() { return null; }, querySelectorAll() { return []; },
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
  const listeners = new Map();
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
    history: { state: { hubDepth: 0 }, replaceState(value, title, url) { this.state = value; if (url) context.location.hash = url; }, pushState(value, title, url) { this.state = value; if (url) context.location.hash = url; }, back() {} },
    localStorage: {
      getItem(key) { return local.get(key) || null; },
      setItem(key, value) { if (!state.writable) throw new Error('quota'); local.set(key, value); state.localWrites++; },
    },
    sessionStorage: { getItem(key) { return session.get(key) || null; }, setItem(key, value) { session.set(key, value); } },
    document: { addEventListener(type, listener) { const handlers = listeners.get(type) || []; handlers.push(listener); listeners.set(type, handlers); }, querySelector: element, querySelectorAll() { return []; }, body: element('body'), documentElement: element('html') },
    navigator: {}, window: { scrollY: 0, scrollTo() {}, addEventListener() {} }, innerHeight: 844,
    addEventListener() {}, matchMedia() { return { matches: false }; },
    widgetSubmit() { return false; },
  };
  vm.createContext(context);
  const run = code => vm.runInContext(code, context);
  for (const file of ['mobile.js', 'mobile-features.js', 'workflows.js', 'agents-runtime.js', 'agents-ui.js', 'task-tools.js', 'workspace-tools.js']) run(read(file));
  const app = read('app.js'), startup = app.lastIndexOf('initAgents();\nsetupMobile();');
  assert.ok(startup >= 0, 'find the full-app startup boundary, without executing its browser lifecycle');
  run(app.slice(0, startup));
  context.render = () => state.renders++;
  context.tell = value => state.notices.push(value);
  const navigate = context.go;
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
    run(`query=${JSON.stringify(next.query)};source=${JSON.stringify(next.source)};searchFolder=${JSON.stringify(next.searchFolder)};searchDate=${JSON.stringify(next.searchDate)};searchType=${JSON.stringify(next.searchType)};st.workspaceSearch={scope:${JSON.stringify(next.scope)},sort:${JSON.stringify(next.sort)}};workspaceSearchActive=false;workspaceSearchEntryQuery=query;`);
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
  const dispatch = (type, event) => { for (const listener of listeners.get(type) || []) listener(event); };
  return { context, run, state, filters, configure, flush, stored, openPanel, changePanel, panelValues, element, dispatch, navigate };
}

const f = fixture();
const { context: app, run } = f;
const sheetElement=f.element('#sheet');sheetElement.open=true;
const closesBeforePicker=f.state.closes;
sheetElement.emit('cancel',{target:makeElement(),currentTarget:sheetElement,preventDefault(){throw new Error('child file cancellation must remain untouched');}});
assert.equal(sheetElement.open,true,'cancelling a child file picker preserves the open editor');
assert.equal(f.state.closes,closesBeforePicker);
let dialogCancelPrevented=false;
sheetElement.emit('cancel',{target:sheetElement,currentTarget:sheetElement,preventDefault(){dialogCancelPrevented=true;}});
assert.equal(dialogCancelPrevented,true);
assert.equal(f.state.closes,closesBeforePicker+1,'the dialog cancellation still closes the editor once');
const menuTypes = json(run('WORKSPACE_TYPES'));
const allLeaves = json(run('workspaceLeaves()'));

// Scope, type and advanced filters share one compact row. Types live in a menu.
f.configure();
const searchHtml = app.workspaceSearchPage();
assert.equal((searchHtml.match(/data-act="search-scope"/g) || []).length, 1, 'one comprehensive filter entry on the search page');
assert.equal((searchHtml.match(/data-act="search-scope:range"/g) || []).length, 1, 'one direct scope entry');
assert.equal((searchHtml.match(/data-act="workspace-types"/g) || []).length, 1, 'one type-menu entry');
const compactControls = searchHtml.match(/<div class="search-controls"[\s\S]*?<\/div>/)?.[0] || '';
for (const action of ['search-scope:range', 'workspace-types', 'search-scope']) assert.ok(compactControls.includes('data-act="' + action + '"'), action + ' stays in the compact controls row');
assert.ok(!searchHtml.includes('data-act="workspace-type:'), 'the home page no longer renders seven permanent type buttons');
assert.ok(!searchHtml.includes('<h1>搜索</h1>'), 'search does not duplicate its shell title');
assert.ok(searchHtml.includes('推荐内容 · 示例') && !searchHtml.includes('最近打开'), 'fresh visitors see honestly labelled sample recommendations');
assert.ok(!searchHtml.includes('近期搜索') && !searchHtml.includes('试试搜索'), 'unactivated search keeps query suggestions out of the first screen');
assert.ok(!/<input\b[^>]*\sautofocus(?:\s|>|=)/.test(searchHtml), 'entering search does not request the keyboard automatically');
assert.ok(!/<button\b[^>]*data-act="search-scope"[^>]*>[^<]*全部内容/.test(searchHtml), 'the old all-content popup button is gone');
for (const type of menuTypes) {
  f.configure({ query: '保留的搜索词', source: 'Craft', searchFolder: '项目', searchDate: '11 月', scope: ['craft-projects'], sort: '最近优先' });
  const before = f.filters(), sheets = f.state.sheets;
  assert.equal(app.workspaceAction('workspace-type', type), true);
  assert.deepEqual(f.filters(), { ...before, searchType: type }, 'type switching changes only type: ' + type);
  assert.equal(f.state.sheets, sheets, 'type switch does not open a modal');
  const menuBefore = f.filters();
  app.workspaceTypeMenu();
  assert.deepEqual(f.filters(), menuBefore, 'opening the type menu does not apply a change');
  const selected = f.state.lastSheet.match(new RegExp('<button\\b[^>]*data-act="workspace-type:' + type + '"[^>]*>'))?.[0];
  assert.ok(selected?.includes('aria-pressed="true"'), 'the applied type is visually and accessibly selected: ' + type);
  app.close();
}
console.log('PASS: compact scope/type controls, accurate initial state, exact/aggregate menu types, selected semantics');

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
for (const key of ['source', 'folder', 'date']) assert.ok(badges.includes('workspace-clear-filter:' + key), 'secondary condition has its own clear action: ' + key);
for (const action of ['search-scope:range', 'workspace-types']) {
  const trigger = badges.match(new RegExp('<button\\b[^>]*data-act="' + action + '"[^>]*>'))?.[0];
  assert.ok(trigger?.includes('aria-pressed="true"'), 'scope/type stays visibly applied in its own menu trigger: ' + action);
}
assert.ok(badges.includes('内容类型：PDF'), 'a precise type remains visible instead of silently showing its aggregate');
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
const scopeEmpty = sourceCase.context.workspaceSearchResults();
assert.ok(scopeEmpty.includes('调整筛选'), 'empty results let the user adjust the active conditions');
assert.ok(!scopeEmpty.includes('data-act="clear-search"'), 'empty results do not require clearing both query and filters');
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

// Focus, composition and submission are different states. Typing is not search history.
const states = fixture(), searchInput = states.element('#query');
searchInput.id = 'query'; searchInput.form = { id: 'search-form' };
states.configure();
states.dispatch('focusin', { target: searchInput });
assert.equal(states.run('workspaceSearchActive'), true);
assert.ok(states.context.workspaceSearchResults().includes('近期搜索'), 'focused empty input shows recent query controls');
assert.ok(!states.context.workspaceSearchResults().includes('推荐内容 · 示例'), 'focused empty input leaves the unactivated recommendations');
assert.deepEqual(Array.from(states.context.workspaceRecentQueries()), [], 'focus does not invent a recent query');
searchInput.value = '项';
states.dispatch('input', { target: searchInput, isComposing: true });
assert.equal(states.filters().query, '', 'incomplete IME composition is not applied');
searchInput.value = '项目';
states.dispatch('compositionend', { target: searchInput });
assert.equal(states.filters().query, '项目', 'the completed composition updates the actual query');
assert.ok(states.context.workspaceSearchResults().includes('条结果'), 'typed query displays matching results');
assert.deepEqual(Array.from(states.context.workspaceRecentQueries()), [], 'typing does not store unsubmitted fragments');
let blurred = 0;
searchInput.blur = () => blurred++;
states.dispatch('submit', { target: searchInput.form, preventDefault() {} });
assert.equal(blurred, 1, 'explicit submission dismisses the keyboard request');
assert.deepEqual(Array.from(states.context.workspaceRecentQueries()), ['项目'], 'explicit submission records the query');
assert.ok(states.context.workspaceSearchResults().includes('条结果'), 'submitting keeps the result state after blur');

states.configure(constrained);
searchInput.value = constrained.query;
states.dispatch('focusin', { target: searchInput });
searchInput.value = '未提交的新词';
states.dispatch('input', { target: searchInput, isComposing: false });
const beforeCancelRecent = Array.from(states.context.workspaceRecentQueries());
states.context.workspaceAction('workspace-cancel');
assert.deepEqual(states.filters(), { query: constrained.query, source: constrained.source, searchFolder: constrained.searchFolder, searchDate: constrained.searchDate, searchType: constrained.searchType, scope: constrained.scope, sort: constrained.sort }, 'cancel restores the entry query without clearing any applied condition');
assert.equal(states.run('workspaceSearchActive'), false);
assert.deepEqual(Array.from(states.context.workspaceRecentQueries()), beforeCancelRecent, 'cancel does not save the abandoned query');
const beforeClear = states.filters();
states.context.mobileHandleAction('clear-query');
assert.deepEqual(states.filters(), { ...beforeClear, query: '' }, 'clear keyword preserves every filter and sort');
console.log('PASS: explicit search activation, IME completion, submission history, keyboard blur, cancel and keyword-only clear');

// Empty focused search prioritizes history even with saved filters; applying a filter returns to results.
const focusedFilters = fixture(), filteredInput = focusedFilters.element('#query');
filteredInput.id = 'query'; filteredInput.form = { id: 'search-form' }; filteredInput.value = '';
focusedFilters.run('query="已经提交的项目查询"'); focusedFilters.context.workspaceRememberQuery();
focusedFilters.configure({ scope: ['craft-projects'], searchType: 'PDF', searchFolder: '项目', searchDate: '11 月', sort: '最近优先' });
const beforeFilteredFocus = focusedFilters.filters();
focusedFilters.dispatch('focusin', { target: filteredInput });
assert.ok(focusedFilters.context.workspaceSearchResults().includes('近期搜索') && focusedFilters.context.workspaceSearchResults().includes('已经提交的项目查询'), 'saved filters do not suppress history when empty input receives focus');
assert.ok(focusedFilters.context.workspaceSearchPage().includes('内容类型：PDF'), 'the applied filter controls remain visible while showing history');
assert.deepEqual(focusedFilters.filters(), beforeFilteredFocus, 'focusing never changes the applied conditions');
focusedFilters.context.workspaceTypeMenu();
focusedFilters.state.writable = false;
focusedFilters.context.workspaceAction('workspace-type', '笔记');
assert.equal(focusedFilters.run('workspaceSearchActive'), true, 'failed type commit keeps the focused search state');
assert.deepEqual(focusedFilters.filters(), beforeFilteredFocus);
focusedFilters.state.writable = true;
focusedFilters.context.workspaceAction('workspace-type', '笔记');
assert.equal(focusedFilters.run('workspaceSearchActive'), false, 'successful type commit leaves input-editing state');
assert.ok(focusedFilters.context.workspaceSearchResults().includes('条结果') && !focusedFilters.context.workspaceSearchResults().includes('近期搜索'), 'type selection shows its filtered results');
focusedFilters.dispatch('focusin', { target: filteredInput });
focusedFilters.openPanel();
focusedFilters.changePanel({ scope: ['reading-telegram'], type: '阅读', date: '不限日期', folder: '全部分组' });
const beforeRangeCommit = focusedFilters.filters();
focusedFilters.state.writable = false;
focusedFilters.context.workspaceSubmit(focusedFilters.state.form);
assert.equal(focusedFilters.run('workspaceSearchActive'), true, 'failed scope commit keeps editing state');
assert.deepEqual(focusedFilters.filters(), beforeRangeCommit);
focusedFilters.state.writable = true;
focusedFilters.context.workspaceSubmit(focusedFilters.state.form);
assert.equal(focusedFilters.run('workspaceSearchActive'), false, 'successful scope Apply leaves input-editing state');
assert.ok(focusedFilters.context.workspaceSearchResults().includes('go:article/r2') && !focusedFilters.context.workspaceSearchResults().includes('近期搜索'), 'scope Apply displays the newly scoped results');
console.log('PASS: focused empty history respects existing filters; successful type/scope commits return to results and failures retain editing');

// History remains atomic, bounded and persistent, and only meaningful navigation commits a typed query.
const histories = fixture();
histories.configure({ query: '导航之前的草稿词' });
histories.navigate('settings');
assert.deepEqual(Array.from(histories.context.workspaceRecentQueries()), [], 'leaving for a non-result page does not store an unfinished query');
histories.context.location.hash = '#search';
const beforeBlockedNavigation = histories.stored();
histories.run('mobileClosingSheet=true');
histories.navigate('doc/d5');
assert.equal(histories.context.location.hash, '#search', 'a closing sheet blocks the pending navigation');
assert.deepEqual(Array.from(histories.context.workspaceRecentQueries()), [], 'blocked result navigation does not record a query that was not used');
assert.deepEqual(histories.stored(), beforeBlockedNavigation, 'blocked navigation writes no search history');
histories.run('mobileClosingSheet=false');
histories.navigate('doc/d5');
assert.deepEqual(Array.from(histories.context.workspaceRecentQueries()), ['导航之前的草稿词'], 'opening a search result commits its query');
for (let i = 0; i < 10; i++) { histories.run('query=' + JSON.stringify('关键词' + i)); histories.context.workspaceRememberQuery(); }
assert.equal(histories.context.workspaceRecentQueries().length, 8, 'recent searches stay bounded');
histories.run('query="关键词5"'); histories.context.workspaceRememberQuery();
const orderedRecent = Array.from(histories.context.workspaceRecentQueries());
assert.equal(orderedRecent[0], '关键词5');
assert.equal(orderedRecent.filter(value => value === '关键词5').length, 1, 'a reused query moves to the front without duplicating');
const beforeHistoryFailure = histories.stored();
histories.state.writable = false;
histories.run('query="不能保存的搜索"'); histories.context.workspaceRememberQuery();
assert.deepEqual(Array.from(histories.context.workspaceRecentQueries()), orderedRecent, 'failed query-history writes roll back memory');
assert.deepEqual(histories.stored(), beforeHistoryFailure, 'failed query-history writes leave persisted data intact');
histories.context.workspaceAction('workspace-clear-recent');
assert.deepEqual(Array.from(histories.context.workspaceRecentQueries()), orderedRecent, 'failed history clearing is also reversible');
histories.state.writable = true;
histories.context.workspaceAction('workspace-clear-recent');
assert.deepEqual(Array.from(histories.context.workspaceRecentQueries()), []);
const encodedQuery = '项目:范围 / 线束固定点';
histories.context.workspaceAction('workspace-query', encodeURIComponent(encodedQuery));
assert.equal(histories.filters().query, encodedQuery, 'suggested/recent queries preserve colons and slashes through action encoding');
const persistedHistories = fixture({ local: histories.stored().local });
assert.deepEqual(Array.from(persistedHistories.context.workspaceRecentQueries()), [encodedQuery], 'committed query history survives a new visit');
console.log('PASS: result-only navigation history, query deduplication/limits, persistence and failure rollback');

// Recently opened is real typed history; missing records and same-ID notes never become fake visits.
const recent = fixture();
recent.configure();
assert.deepEqual(Array.from(recent.context.workspaceRecentItems()), []);
recent.run("st.notes.push({id:'d3',kind:'note',title:'同 ID 本地速记',text:'本地正文',journalDate:'2026-11-13',attachments:[]});");
recent.context.workspaceRememberOpened('doc/d3');
recent.context.workspaceRememberOpened('note/d3');
recent.context.workspaceRememberOpened('task/t1');
recent.context.workspaceRememberOpened('article/r2');
assert.deepEqual(Array.from(recent.context.workspaceRecentItems(), item => item.route), ['article/r2', 'task/t1', 'note/d3', 'doc/d3'], 'recent visits retain typed identity and newest-first order');
assert.ok(recent.context.workspaceSearchResults().includes('最近打开'));
assert.ok(!recent.context.workspaceSearchResults().includes('推荐内容 · 示例'), 'real visits replace fallback recommendations');
recent.context.workspaceRememberOpened('note/d3');
assert.deepEqual(Array.from(recent.context.workspaceRecentItems(), item => item.route), ['note/d3', 'article/r2', 'task/t1', 'doc/d3'], 'reopening moves one record without duplication');
const beforeUnknown = recent.stored(), writesBeforeUnknown = recent.state.localWrites;
recent.context.workspaceRememberOpened('doc/not-present');
assert.deepEqual(recent.stored(), beforeUnknown);
assert.equal(recent.state.localWrites, writesBeforeUnknown, 'unknown routes cannot create fictitious recent items');
const beforeVisitFailure = Array.from(recent.context.workspaceRecentItems(), item => item.route);
recent.state.writable = false;
recent.context.workspaceRememberOpened('doc/d5');
assert.deepEqual(Array.from(recent.context.workspaceRecentItems(), item => item.route), beforeVisitFailure, 'failed recent-item write rolls back order and membership');
assert.deepEqual(recent.stored(), beforeUnknown);
recent.state.writable = true;
recent.configure({ scope: ['reading-telegram'] });
const filteredRecent = recent.context.workspaceSearchResults();
assert.ok(filteredRecent.includes('go:article/r2') && !filteredRecent.includes('go:task/t1'), 'applied scopes show filtered results instead of leaking unrelated recent visits');
recent.configure();
recent.run("st.workspaceRecent=[];st.history=['d3','article/r2','note/d3','doc/missing'];");
assert.deepEqual(Array.from(recent.context.workspaceRecentItems(), item => item.route), ['doc/d3', 'article/r2', 'note/d3'], 'legacy document IDs restore correctly alongside typed local notes, dropping missing records');
recent.flush();
const restoredRecent = fixture(recent.stored());
assert.deepEqual(Array.from(restoredRecent.context.workspaceRecentItems(), item => item.route), ['doc/d3', 'article/r2', 'note/d3'], 'real recent items and same-ID records survive restoration');
console.log('PASS: real recent visits, typed identity, truthful fallback, missing-record handling and persistence rollback');

// The dedicated range shortcut opens the same unapplied form, and exact-type changes remain atomic in a menu.
const shortcuts = fixture();
shortcuts.configure(constrained); shortcuts.flush();
const shortcutBefore = shortcuts.filters(), shortcutStore = shortcuts.stored();
shortcuts.context.workspaceAction('search-scope', 'range');
assert.ok(/<details\b[^>]*class="workspace-scope-picker"[^>]*\sopen(?:\s|>)/.test(shortcuts.state.lastSheet), 'range shortcut immediately reveals the existing multi-select tree');
assert.deepEqual(shortcuts.filters(), shortcutBefore);
assert.deepEqual(shortcuts.stored(), shortcutStore);
shortcuts.context.close();
shortcuts.context.workspaceTypeMenu();
const menuCloses = shortcuts.state.closes;
shortcuts.state.writable = false;
shortcuts.context.workspaceAction('workspace-type', '链接');
assert.deepEqual(shortcuts.filters(), shortcutBefore, 'exact-type failure retains all prior filters');
assert.deepEqual(shortcuts.stored(), shortcutStore);
assert.equal(shortcuts.state.closes, menuCloses, 'a failed type change leaves its menu available for retry');
shortcuts.state.writable = true;
shortcuts.context.workspaceAction('workspace-type', '链接');
assert.deepEqual(shortcuts.filters(), { ...shortcutBefore, searchType: '链接' });
assert.equal(shortcuts.state.closes, menuCloses + 1, 'a successful type selection closes its menu once');
console.log('PASS: scope shortcut uses the existing draft transaction; exact type menu commits and rolls back atomically');
console.log('Search interaction checks completed successfully. Browser layout and history traversal remain separate UI acceptance checks.');
