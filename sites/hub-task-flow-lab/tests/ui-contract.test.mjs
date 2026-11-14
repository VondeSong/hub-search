import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Static integration contracts; these do not replace browser interaction,
// responsive-layout, focus-return, or assistive-technology verification.
const read = name => readFileSync(new URL(`../dist/${name}`, import.meta.url), 'utf8');
const app = read('app.mjs');
const model = read('model.mjs');
const html = read('index.html');
const css = read('styles.css');
const flow = read('flow.mjs');
const diagram = read('task-flow.svg');
const section = (start, end) => {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing app section: ${start}`);
  return app.slice(from, to);
};

test('entry point stays local and the prototype has no external write transport', () => {
  assert.match(html, /<script\s+type="module"\s+src="\.\/app\.mjs"/);
  assert.match(app, /from ['"]\.\/model\.mjs['"]/);
  assert.match(app, /from ['"]\.\/flow\.mjs['"]/);
  assert.doesNotMatch(app + model + flow, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/);
  assert.doesNotMatch(app + model + flow, /\bimport\s*\(\s*['"]https?:/);
});

test('all localStorage access is isolated to this prototype namespace', () => {
  const constants = [...app.matchAll(/const\s+(STORAGE_KEY|VIEW_KEY)\s*=\s*['"]([^'"]+)['"]/g)];
  assert.equal(constants.length, 2);
  assert.equal(new Set(constants.map(match => match[2])).size, 2);
  for (const [, , key] of constants) assert.match(key, /^hub-task-flow-lab-(?:view-)?v\d+$/);
  const accesses = [...app.matchAll(/localStorage\.(?:getItem|setItem|removeItem)\(\s*([^,)]+)/g)];
  assert.ok(accesses.length >= 4);
  for (const [, key] of accesses) assert.ok(['STORAGE_KEY', 'VIEW_KEY'].includes(key.trim()), `Unexpected storage key ${key}`);
  assert.doesNotMatch(app, /localStorage\.clear\s*\(/);
  assert.match(app, /无法保存到浏览器[\s\S]*?当前修改只在本次打开期间有效/);
});

test('the old workspace is only an explicit external link, not a write target', () => {
  assert.match(app, /const ORIGINAL_SITE = 'https:\/\/hub-workspace-[^']+\?view=tasks'/);
  assert.match(app, /href="\$\{ORIGINAL_SITE\}" target="_blank" rel="noopener"/);
  assert.equal([...app.matchAll(/\bORIGINAL_SITE\b/g)].length, 2);
});

test('new task dates are optional and empty, with a per-submit identity', () => {
  const create = section('function newTask()', 'function editTask(');
  for (const name of ['plannedDate', 'due']) {
    const input = [...create.matchAll(/<input\b[^>]+>/g)].find(([tag]) => tag.includes(`name="${name}"`))?.[0];
    assert.ok(input, `Missing date input ${name}`);
    assert.match(input, /type="date"/);
    assert.doesNotMatch(input, /\b(?:value|required)=?/);
  }
  assert.match(create, /const requestId=/);
  assert.match(create, /type:'ADD_TASK'[\s\S]*?requestId/);
  assert.match(create, /创建任务（演示）/);
});

test('candidate UI exposes deliberate decisions instead of implicit creation', () => {
  const candidate = section('function renderCandidatePanel(', 'function renderJournal(');
  for (const choice of ['link', 'update', 'create']) assert.ok(candidate.includes(`['${choice}',`));
  assert.match(candidate, /不会再次新建副本/);
  assert.match(candidate, /保留原任务 ID、清单和日期，不新增任务/);
  assert.match(app, /case 'candidate-ignore':case 'candidate-defer'/);
  assert.match(app, /case 'restore-candidate'/);
});

test('guide follows the resolved task and diagram links have implemented targets', () => {
  assert.match(app, /ui\.guideTaskId=resolved\.resolvedTaskId/);
  assert.match(app, /function resumeGuide\(\)/);
  const guideGo = section("case 'guide-go':", "case 'flow-open':");
  assert.match(guideGo, /openTask\(guideTask\(\)/);
  assert.doesNotMatch(guideGo, /openTask\('t-harness'/);
  assert.match(app, /case 'flow-open'/);
  const targets = [...flow.matchAll(/data-action="flow-open" data-target="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(targets, ['triage', 'now', 'waiting', 'journal']);
  assert.match(flow, /href="\.\/task-flow\.svg" download=/);
  assert.match(flow, /不会访问你的真实账户/);
  assert.match(diagram, /<svg\b/);
});

test('reset invalidates asynchronous AI work and cannot recapture old drafts', () => {
  const ai = section('function runAI(', 'function openSimulation(');
  assert.match(ai, /const generation=asyncGeneration/);
  assert.match(ai, /if\(generation!==asyncGeneration\)return/);
  const reset = section("dialogContent.addEventListener('click'", "root.addEventListener('click'");
  for (const guard of ['clearTimeout(timer)', 'timers.clear()', 'asyncGeneration++', 'busyAI.clear()', 'skipDraftCapture=true']) {
    assert.ok(reset.includes(guard), `Missing reset guard ${guard}`);
  }
  assert.match(reset, /assistantDrafts:\{\},candidateDrafts:\{\}/);
  assert.match(app, /function captureDrafts\(\)\{if\(skipDraftCapture\)\{skipDraftCapture=false;return;\}/);
});

test('drafts belong to their task and candidate mode across rerenders', () => {
  assert.match(app, /assistantDrafts\[assistant\.dataset\.task\]/);
  assert.match(app, /candidateDrafts\[`\$\{candidate\.dataset\.id\}:\$\{candidate\.dataset\.mode\}`\]/);
  assert.match(app, /esc\(ui\.assistantDrafts\[t\.id\]/);
  assert.match(app, /id="candidate-title"/);
  assert.match(app, /id="candidate-next-step"/);
  assert.match(app, /closest\('#assistant-form,#candidate-form'\)/);
});

test('blocked assistant submissions return before clearing the custom prompt', () => {
  const submit = section("  if(form.id==='assistant-form')", "\n});\ndocument.addEventListener");
  const clearAt = submit.indexOf("ui.assistantDrafts[form.dataset.task]=''");
  assert.ok(clearAt > 0);
  const beforeClear = submit.slice(0, clearAt);
  assert.match(beforeClear, /if\(!task\)\{[^}]*return;\}/);
  assert.match(beforeClear, /if\(busyAI\.has\(task\.id\)\)\{[^}]*return;\}/);
  assert.match(beforeClear, /if\(\['pending','failed'\]\.includes\(task\.syncStatus\)\)\{[^}]*return;\}/);
  assert.ok(submit.indexOf("input.value=''") > clearAt);
  assert.ok(submit.indexOf("runAI(form.dataset.task,'custom',prompt)") > clearAt);
});

test('completion UI retains uncertainty and cancellation is wired to the model', () => {
  const status = section('function renderSyncStatus(', 'function renderTaskMaterials(');
  assert.match(status, /当前仍未完成，不会提前写入完成日志/);
  assert.match(status, /模拟同步失败/);
  assert.match(status, /cancel-complete/);
  assert.match(app, /case 'cancel-complete':[\s\S]*?clearTimeout[\s\S]*?type:'CANCEL_COMPLETE'/);
  assert.match(model, /case 'CANCEL_COMPLETE'/);
  assert.match(app, /模拟来源已确认完成，日志已更新/);
  assert.doesNotMatch(app, /\.state\s*=\s*['"]done['"]/);
});

test('modal replacement keeps its new submit handler and reports errors inside', () => {
  assert.match(html, /<dialog id="dialog" aria-labelledby="dialog-title"/);
  assert.match(app, /dialog\.showModal\(\)/);
  assert.match(app, /dialog\.addEventListener\('close',\(\)=>\{if\(!dialog\.open\)/);
  assert.match(app, /if\(dialog\.open\)\{const el=document\.getElementById\('dialog-error'\)/);
  assert.match(html, /id="toast" role="status" aria-live="polite"/);
});

test('source counts use linked evidence and planned work is shown separately', () => {
  assert.match(app, /taskSources\(state,t\)\.includes\(source\)/);
  assert.match(model, /!taskSources\(state, task\)\.includes\(filters\.source\)/);
  assert.match(app, /const planned=tasks\.filter/);
  assert.match(app, /plannedDate<=state\.demoDate/);
  assert.match(app, /截止任务单独显示，不受行动池 5 项上限影响/);
});

test('basic keyboard, dark-theme, responsive and reduced-motion hooks remain', () => {
  assert.match(html, /<html lang="zh-CN"/);
  assert.match(html, /class="skip-link" href="#main"/);
  assert.match(app, /aria-label="\$\{esc\(label\)\}"/);
  assert.match(app, /CSS\.escape\(activeCheck\)/);
  assert.match(app, /if\(event\.key==='Escape'/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\(max-width:760px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
});

test('effective light text tokens include the final override on main surfaces', () => {
  const base = css.match(/(?:^|\n):root\{([^}]+)\}/)?.[1];
  assert.ok(base);
  const overrides = [...css.matchAll(/:root:not\(\[data-theme="dark"\]\)\{([^}]+)\}/g)].map(match => match[1]);
  const tokens = Object.fromEntries([...`${base};${overrides.join(';')}`.matchAll(/--([a-z-]+):\s*(#[0-9a-f]+)/gi)].map(match => [match[1], match[2]]));
  const luminance = hex => {
    const raw = hex.slice(1);
    const expanded = raw.length === 3 ? [...raw].map(value => value + value).join('') : raw;
    const rgb = expanded.match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  for (const foreground of ['muted', 'subtle']) for (const background of ['bg', 'surface']) {
    const values = [luminance(tokens[foreground]), luminance(tokens[background])].sort((a, b) => a - b);
    const ratio = (values[1] + 0.05) / (values[0] + 0.05);
    assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
  }
});
