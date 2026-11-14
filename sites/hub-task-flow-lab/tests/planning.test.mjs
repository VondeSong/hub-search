import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState, reducer, validateState} from '../dist/model.mjs';
import {readFileSync} from 'node:fs';

const at = '2026-11-14T10:00:00';
const run = (state, mode, rest = {}) => reducer(state, {type:'PLAN_RUN',mode,taskId:'t-harness',project:'BEV',...rest}, at);
const adopt = (state, mode, rest = {}) => reducer(state, {type:'PLAN_ADOPT',mode,id:state.planning.runs[mode].suggestions[0].id,...rest}, at);

test('analysis is read only for all three entries and preserves task identities', () => {
  for (const mode of ['today','project','task']) {
    const original = createInitialState();
    const state = run(original, mode);
    assert.deepEqual(state.tasks, original.tasks);
    assert.deepEqual(state.journal, original.journal);
    assert.ok(state.planning.runs[mode].suggestions.length);
    assert.ok(validateState(state));
  }
});
test('today uses capacity but never hides a hard deadline and adoption only references originals', () => {
  let state = createInitialState();
  state.tasks.filter(t=>t.state !== 'done').forEach(t=>t.due=state.demoDate);
  state = run(state,'today',{capacity:60});
  assert.equal(state.planning.runs.today.suggestions.length,9);
  const before = structuredClone(state.tasks);
  state = adopt(state,'today');
  state = adopt(state,'today');
  assert.equal(state.planning.today.length,1);
  assert.deepEqual(state.tasks,before);
  assert.equal(state.planning.receipts.length,1);
});
test('project and task scope are respected and partial results do not cite unavailable materials', () => {
  for (const mode of ['project','task']) {
    const state = run(createInitialState(),mode,{coverage:'partial'});
    const result=state.planning.runs[mode];
    assert.ok(result.suggestions.every(s=>state.tasks.find(t=>t.id===s.taskId).project==='BEV'));
    assert.ok(result.suggestions.every(s=>!s.evidence.includes('m-drawing')));
    assert.equal(result.coverage,'partial');
    if(mode==='task')assert.equal(result.suggestions.length,1);
  }
});
test('a source change requires an explicit outcome and preserves unrelated fields', () => {
  let state = run(createInitialState(),'task');
  const before = structuredClone(state.tasks);
  assert.match(adopt(state,'task').error,/预览/);
  state = adopt(state,'task',{outcome:'success'});
  const changed=state.tasks.find(t=>t.id==='t-harness');
  assert.match(changed.nextStep,/V3/);
  assert.deepEqual({...changed,nextStep:before[0].nextStep},before[0]);
  assert.equal(state.journal.length,1);
  assert.ok(validateState(state));
});
test('stale advice cannot overwrite task edits made after analysis', () => {
  let state = run(createInitialState(),'task');
  state = reducer(state,{type:'UPDATE_TASK',id:'t-harness',patch:{nextStep:'用户新的决定'}},at);
  const result=adopt(state,'task',{outcome:'success'});
  assert.match(result.error,/已变化/);
  assert.equal(result.tasks[0].nextStep,'用户新的决定');
});
test('failure retry is idempotent and unknown requires reconciliation first', () => {
  for (const outcome of ['failure','unknown']) {
    let state=run(createInitialState(),'task');
    const before=structuredClone(state.tasks);
    const id=state.planning.runs.task.suggestions[0].id;
    state=adopt(state,'task',{outcome});
    assert.deepEqual(state.tasks,before);
    assert.ok(validateState(state));
    if(outcome==='unknown') {
      assert.match(adopt(state,'task',{outcome:'success'}).error,/核对/);
      state=reducer(state,{type:'PLAN_RECONCILE',mode:'task',id},at);
      assert.deepEqual(state.tasks,before);
      state=run(state,'task');
      state=adopt(state,'task',{outcome:'success'});
    } else state=reducer(state,{type:'PLAN_RETRY',mode:'task',id},at);
    const done=structuredClone(state);
    state=adopt(state,'task',{outcome:'success'});
    assert.deepEqual(state,done);
  }
});
test('old cache allows local planning but cannot silently write a source task', () => {
  const state=run(createInitialState(),'task',{coverage:'cached'});
  assert.match(adopt(state,'task',{outcome:'success'}).error,/旧缓存/);
});
test('v1 archives remain loadable and planning survives roundtrip/reset', () => {
  const v1=createInitialState();delete v1.planning;assert.ok(validateState(v1));
  const state=adopt(run(v1,'today'),'today');
  assert.ok(validateState(JSON.parse(JSON.stringify(state))));
  assert.deepEqual(reducer(state,{type:'RESET'},at).planning.today,[]);
  const bad=structuredClone(state);bad.planning.today.push('not-a-task');assert.equal(validateState(bad),false);
  const badEvidence=structuredClone(state);badEvidence.planning.runs.today.suggestions[0].evidence.push('not-a-material');assert.equal(validateState(badEvidence),false);
});
test('new planning modules never contact external services and UI exposes deliberate outcomes', () => {
  const read=name=>readFileSync(new URL(`../dist/${name}`,import.meta.url),'utf8');
  const code=read('planning.mjs')+read('planning-ui.mjs');
  assert.doesNotMatch(code,/\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/);
  for(const text of ['安排今天','梳理项目','推进任务','预览来源修改','核对模拟来源','暂不采用'])assert.ok(code.includes(text));
});
