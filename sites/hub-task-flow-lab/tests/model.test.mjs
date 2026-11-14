import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialState, reducer, selectors, selectView, selectCounts,
  taskSources, validateState, validDate, ACTION_POOL_LIMIT,
} from '../dist/model.mjs';

const byId = (state, id) => state.tasks.find(task => task.id === id);
const complete = (state, id, date = state.demoDate) => reducer(reducer(state, {type: 'REQUEST_COMPLETE', id}, date), {type: 'RESOLVE_COMPLETE', id, outcome: 'success'}, date);

test('seed has coherent IDs, relative dates, no candidate counted as task', () => {
  const state = createInitialState('2027-01-31');
  assert.equal(validateState(state), true);
  assert.equal(state.tasks.length, 10);
  assert.equal(state.candidates.length, 3);
  assert.equal(byId(state, 't-harness').due, '2027-02-02');
  assert.equal(byId(state, 't-review').due, '2027-01-31');
  assert.equal(selectCounts(state).actionPool, 3);
  assert.equal(selectCounts(state).hardDue, 1);
  assert.equal(selectCounts(state).triage, 4);
});

test('candidate link is idempotent and retains source/list/ID/task count', () => {
  const original = createInitialState();
  const action = {type: 'RESOLVE_CANDIDATE', id: 'c-drawing', decision: 'link', taskId: 't-harness'};
  const linked = reducer(original, action);
  const again = reducer(linked, action);
  assert.equal(again.tasks.length, original.tasks.length);
  assert.equal(byId(again, 't-harness').materialIds.filter(id => id === 'm-drawing').length, 1);
  assert.equal(byId(again, 't-harness').list, '工程交付');
  assert.equal(byId(again, 't-harness').source, 'dida');
  assert.deepEqual(again, linked);
  assert.equal(byId(original, 't-harness').materialIds.includes('m-drawing'), false);
});

test('confirmed candidate creation creates exactly one canonical task', () => {
  const action = {type: 'RESOLVE_CANDIDATE', id: 'c-notes', decision: 'create', title: '验证另一个具体问题'};
  const state = reducer(createInitialState(), action);
  const repeated = reducer(state, action);
  assert.equal(state.tasks.length, 11);
  assert.equal(repeated.tasks.length, 11);
  const task = byId(state, 'task-from-c-notes');
  assert.equal(task.source, 'dida');
  assert.equal(task.due, null);
  assert.deepEqual(task.materialIds, ['m-product']);
  assert.equal(state.candidates.find(c => c.id === 'c-notes').resolvedTaskId, task.id);
});

test('candidate update patches next step and links evidence without replacing task fields', () => {
  const original = createInitialState();
  const task = byId(original, 't-harness');
  const action = {type: 'RESOLVE_CANDIDATE', id: 'c-drawing', decision: 'update', taskId: task.id, nextStep: '先核对 V3 的 P12 固定点变更'};
  const state = reducer(original, action);
  const updated = byId(state, task.id);
  assert.equal(updated.nextStep, action.nextStep);
  assert.equal(updated.due, task.due);
  assert.equal(updated.now, task.now);
  assert.equal(updated.list, task.list);
  assert.equal(updated.state, task.state);
  assert.ok(updated.materialIds.includes('m-drawing'));
  assert.equal(state.tasks.length, original.tasks.length);
  assert.equal(state.candidates.find(item => item.id === 'c-drawing').status, 'updated');
  assert.deepEqual(reducer(state, action), state);
});

test('ignoring or deferring candidates never deletes material or creates tasks', () => {
  let state = createInitialState();
  state = reducer(state, {type: 'RESOLVE_CANDIDATE', id: 'c-notes', decision: 'ignore'});
  state = reducer(state, {type: 'RESOLVE_CANDIDATE', id: 'c-insight', decision: 'defer'});
  assert.equal(state.tasks.length, 10);
  assert.equal(state.materials.length, 6);
  assert.equal(selectCounts(state).pendingCandidates, 1);
  state = reducer(state, {type: 'RESTORE_CANDIDATE', id: 'c-insight'});
  assert.equal(selectCounts(state).pendingCandidates, 2);
});

test('new tasks have no invented deadline and repeated request is idempotent', () => {
  const action = {type: 'ADD_TASK', title: '  确认版本号  ', requestId: 'request-one'};
  const state = reducer(createInitialState(), action);
  const task = state.tasks[0];
  assert.equal(task.title, '确认版本号');
  assert.equal(task.due, null);
  assert.equal(task.plannedDate, null);
  assert.equal(task.source, 'dida');
  assert.equal(reducer(state, action).tasks.length, 11);
});

test('invalid title/date and identity/status bypass are rejected without partial change', () => {
  const state = createInitialState();
  for (const action of [
    {type: 'ADD_TASK', title: ' '},
    {type: 'ADD_TASK', title: 'test', due: '2026-02-30'},
    {type: 'UPDATE_TASK', id: 't-harness', patch: {title: ''}},
    {type: 'UPDATE_TASK', id: 't-harness', patch: {title: 'changed', due: 'tomorrow'}},
    {type: 'UPDATE_TASK', id: 't-harness', patch: {state: 'done'}},
    {type: 'UPDATE_TASK', id: 't-harness', patch: {id: 'other'}},
  ]) {
    const result = reducer(state, action);
    assert.ok(result.error);
    assert.deepEqual(result.tasks, state.tasks);
    assert.deepEqual(result.journal, state.journal);
  }
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(validDate('2026-02-29'), false);
});

test('action pool limit does not hide hard deadlines and never copies/moves task', () => {
  let state = createInitialState();
  state = reducer(state, {type: 'TOGGLE_NOW', id: 't-harness'});
  state = reducer(state, {type: 'TOGGLE_NOW', id: 't-read'});
  assert.equal(selectCounts(state).actionPool, ACTION_POOL_LIMIT);
  const rejected = reducer(state, {type: 'TOGGLE_NOW', id: 't-home'});
  assert.ok(rejected.error);
  assert.equal(byId(rejected, 't-home').now, false);
  assert.ok(selectView(rejected, 'now').some(task => task.id === 't-review'));
  assert.equal(byId(rejected, 't-harness').list, '工程交付');
  assert.equal(rejected.tasks.length, 10);
});

test('waiting requires person/reason and resumes the same unfinished task', () => {
  let state = reducer(createInitialState(), {type: 'START_TASK', id: 't-harness'});
  state = reducer(state, {type: 'TOGGLE_NOW', id: 't-harness'});
  const invalid = reducer(state, {type: 'WAIT_TASK', id: 't-harness', person: '', reason: '缺版本'});
  assert.ok(invalid.error);
  assert.equal(byId(invalid, 't-harness').state, 'doing');
  state = reducer(state, {type: 'WAIT_TASK', id: 't-harness', person: 'DRE', reason: '待确认图纸版本', reviewDate: '2026-11-15'});
  assert.equal(byId(state, 't-harness').state, 'waiting');
  assert.equal(byId(state, 't-harness').now, false);
  assert.equal(byId(state, 't-harness').waiting.reviewDate, '2026-11-15');
  assert.ok(reducer(state, {type: 'REQUEST_COMPLETE', id: 't-harness'}).error);
  state = reducer(state, {type: 'RESUME_TASK', id: 't-harness'});
  assert.equal(byId(state, 't-harness').state, 'doing');
  assert.equal(byId(state, 't-harness').completedOn, null);
  assert.equal(state.tasks.length, 10);
});

test('waiting hard deadline remains visible in Now', () => {
  const state = reducer(createInitialState(), {type: 'WAIT_TASK', id: 't-review', person: '同事', reason: '待核对'});
  assert.ok(selectView(state, 'now').some(task => task.id === 't-review'));
  assert.ok(selectView(state, 'waiting').some(task => task.id === 't-review'));
});

test('AI note/checklist stays attached to original task without marking completion', () => {
  let state = reducer(createInitialState(), {type: 'ADD_AI_NOTE', id: 't-harness'});
  state = reducer(state, {type: 'ADD_AI_NOTE', id: 't-harness'});
  const task = byId(state, 't-harness');
  assert.equal(state.tasks.length, 10);
  assert.equal(task.state, 'todo');
  assert.ok(task.aiNote.includes('演示草稿'));
  assert.equal(task.checklist.filter(item => item.id === 'ai-verify').length, 1);
  state = reducer(state, {type: 'TOGGLE_CHECK', id: 't-harness', checkId: 'ai-verify'});
  assert.equal(selectors(byId(state, 't-harness')).checklistDone, 1);
});

test('pending and failed completion do not look completed or create a journal entry', () => {
  const initial = createInitialState();
  const pending = reducer(initial, {type: 'REQUEST_COMPLETE', id: 't-mobile'});
  const task = byId(pending, 't-mobile');
  assert.equal(task.syncStatus, 'pending');
  assert.equal(task.state, 'todo');
  assert.equal(task.completedOn, null);
  assert.equal(pending.journal.length, initial.journal.length);
  assert.equal(reducer(pending, {type: 'REQUEST_COMPLETE', id: 't-mobile'}).events.length, pending.events.length);
  const failed = reducer(pending, {type: 'RESOLVE_COMPLETE', id: 't-mobile', outcome: 'failure'});
  assert.equal(byId(failed, 't-mobile').syncStatus, 'failed');
  assert.equal(byId(failed, 't-mobile').state, 'todo');
  assert.equal(failed.journal.length, initial.journal.length);
});

test('retry reuses operation and success writes journal once with actual completion date', () => {
  let state = createInitialState();
  state = reducer(state, {type: 'REQUEST_COMPLETE', id: 't-bills'});
  const operationId = byId(state, 't-bills').pendingOperation.id;
  state = reducer(state, {type: 'RESOLVE_COMPLETE', id: 't-bills', outcome: 'failure'});
  state = reducer(state, {type: 'RETRY_COMPLETE', id: 't-bills'});
  assert.equal(byId(state, 't-bills').pendingOperation.id, operationId);
  state = reducer(state, {type: 'RESOLVE_COMPLETE', id: 't-bills', outcome: 'success', operationId}, '2026-11-16T09:10:00+08:00');
  assert.equal(byId(state, 't-bills').state, 'done');
  assert.equal(byId(state, 't-bills').completedOn, '2026-11-16');
  assert.equal(byId(state, 't-bills').due, null);
  assert.equal(state.journal[0].date, '2026-11-16');
  assert.equal(state.journal[0].taskId, 't-bills');
  const count = state.journal.length;
  state = reducer(state, {type: 'RESOLVE_COMPLETE', id: 't-bills', outcome: 'success', operationId});
  assert.equal(state.journal.length, count);
});

test('stale completion response cannot acknowledge a different operation', () => {
  const state = reducer(createInitialState(), {type: 'REQUEST_COMPLETE', id: 't-docs'});
  const result = reducer(state, {type: 'RESOLVE_COMPLETE', id: 't-docs', outcome: 'success', operationId: 'old-response'});
  assert.equal(byId(result, 't-docs').state, 'todo');
  assert.equal(byId(result, 't-docs').syncStatus, 'pending');
  assert.equal(result.journal.length, state.journal.length);
});

test('undo/reopen preserves task ID and event history; previous completion is historical', () => {
  let state = complete(createInitialState(), 't-mobile');
  const completion = state.journal[0];
  const taskCount = state.tasks.length;
  state = reducer(state, {type: 'UNDO_COMPLETE', id: 't-mobile'}, '2026-11-15');
  assert.equal(state.tasks.length, taskCount);
  assert.equal(byId(state, 't-mobile').state, 'todo');
  assert.equal(byId(state, 't-mobile').now, true);
  assert.equal(byId(state, 't-mobile').completedOn, null);
  assert.equal(state.journal.find(entry => entry.id === completion.id).reopenedAt, '2026-11-15');
  assert.equal(state.journal[0].type, 'reopened');
  const journalLength = state.journal.length;
  state = reducer(state, {type: 'REOPEN_TASK', id: 't-mobile'});
  assert.equal(state.journal.length, journalLength);
  state = complete(state, 't-mobile', '2026-11-16');
  assert.equal(state.journal.filter(entry => entry.taskId === 't-mobile' && entry.type === 'completed').length, 2);
  assert.equal(state.journal[0].reopenedAt, null);
});

test('source filtering recognizes linked material sources without dropping Dida task', () => {
  let state = reducer(createInitialState(), {type: 'RESOLVE_CANDIDATE', id: 'c-drawing', decision: 'link', taskId: 't-harness'});
  assert.deepEqual(taskSources(state, byId(state, 't-harness')).sort(), ['craft', 'dida', 'feishu']);
  assert.ok(selectView(state, 'all', {source: 'feishu'}).some(task => task.id === 't-harness'));
  assert.ok(selectView(state, 'all', {source: 'dida'}).some(task => task.id === 't-harness'));
  state = reducer(state, {type: 'REMOVE_MATERIAL', id: 't-harness', materialId: 'm-drawing'});
  assert.equal(state.materials.length, 6);
  assert.equal(taskSources(state, byId(state, 't-harness')).includes('feishu'), false);
});

test('inbox task can be clarified without conversion or ID replacement', () => {
  const state = reducer(createInitialState(), {type: 'UPDATE_TASK', id: 't-inbox', patch: {project: 'BEV', nextStep: '标记各问题的责任方', doneCriteria: '三个问题均有责任方', needsTriage: false}});
  assert.equal(state.tasks.length, 10);
  assert.equal(byId(state, 't-inbox').id, 't-inbox');
  assert.equal(selectView(state, 'triage').length, 0);
});

test('reducer leaves input unchanged and serializes without runtime-only values', () => {
  const state = createInitialState();
  const snapshot = JSON.stringify(state);
  reducer(state, {type: 'TOGGLE_NOW', id: 't-harness'});
  assert.equal(JSON.stringify(state), snapshot);
  assert.equal(validateState(JSON.parse(snapshot)), true);
  assert.equal(validateState({version: 1}), false);
});

test('planned today and overdue plans stay in Now without entering or duplicating action pool', () => {
  let state = createInitialState();
  state = reducer(state, {type: 'UPDATE_TASK', id: 't-read', patch: {plannedDate: '2026-11-14'}});
  state = reducer(state, {type: 'UPDATE_TASK', id: 't-home', patch: {plannedDate: '2026-11-13'}});
  let visible = selectView(state, 'now');
  assert.ok(visible.some(task => task.id === 't-read'));
  assert.ok(visible.some(task => task.id === 't-home'));
  assert.equal(byId(state, 't-read').now, false);
  assert.equal(selectCounts(state).actionPool, 3);
  assert.equal(selectCounts(state).plannedToday, 4);
  state = reducer(state, {type: 'TOGGLE_NOW', id: 't-read'});
  visible = selectView(state, 'now');
  assert.equal(visible.filter(task => task.id === 't-read').length, 1);
  assert.equal(selectCounts(state).now, visible.length);
  state = reducer(state, {type: 'WAIT_TASK', id: 't-read', person: '资料负责人', reason: '需要补充资料'});
  assert.equal(selectView(state, 'now').some(task => task.id === 't-read'), false);
  state = reducer(state, {type: 'UPDATE_TASK', id: 't-read', patch: {due: '2026-11-14'}});
  assert.equal(selectView(state, 'now').some(task => task.id === 't-read'), true);
});

test('unfinished completion operation locks edits until explicit cancellation', () => {
  let state = reducer(createInitialState(), {type: 'REQUEST_COMPLETE', id: 't-harness'});
  const blockedActions = [
    {type: 'WAIT_TASK', id: 't-harness', person: 'DRE', reason: '版本待定'},
    {type: 'START_TASK', id: 't-harness'},
    {type: 'TOGGLE_NOW', id: 't-harness'},
    {type: 'UPDATE_TASK', id: 't-harness', patch: {nextStep: '改变下一步'}},
    {type: 'TOGGLE_CHECK', id: 't-harness', checkId: 'h-version'},
    {type: 'ADD_AI_NOTE', id: 't-harness'},
    {type: 'ADD_MATERIAL', id: 't-harness', materialId: 'm-drawing'},
    {type: 'RESOLVE_CANDIDATE', id: 'c-drawing', decision: 'link', taskId: 't-harness'},
  ];
  for (const phase of ['pending', 'failed']) {
    if (phase === 'failed') state = reducer(state, {type: 'RESOLVE_COMPLETE', id: 't-harness', outcome: 'failure'});
    for (const action of blockedActions) {
      const result = reducer(state, action);
      assert.ok(result.error, `${phase}: ${action.type} must report its blocker`);
      assert.deepEqual(result.tasks, state.tasks);
      assert.deepEqual(result.candidates, state.candidates);
    }
  }
  state = reducer(state, {type: 'CANCEL_COMPLETE', id: 't-harness'});
  assert.equal(byId(state, 't-harness').syncStatus, 'synced');
  assert.equal(byId(state, 't-harness').pendingOperation, null);
  assert.equal(byId(state, 't-harness').state, 'todo');
  assert.equal(state.journal.length, 1);
  assert.ok(byId(state, 't-harness').history.some(entry => entry.type === 'completion-cancelled'));
  state = reducer(state, {type: 'WAIT_TASK', id: 't-harness', person: 'DRE', reason: '版本待定'});
  assert.equal(state.error, null);
  assert.equal(byId(state, 't-harness').state, 'waiting');
});

test('cancelled completion rejects stale response before or after a fresh request', () => {
  let state = reducer(createInitialState(), {type: 'REQUEST_COMPLETE', id: 't-mobile'});
  const oldOperationId = byId(state, 't-mobile').pendingOperation.id;
  state = reducer(state, {type: 'CANCEL_COMPLETE', id: 't-mobile'});
  state = reducer(state, {type: 'RESOLVE_COMPLETE', id: 't-mobile', outcome: 'success', operationId: oldOperationId});
  assert.equal(byId(state, 't-mobile').state, 'todo');
  assert.equal(state.journal.length, 1);
  state = reducer(state, {type: 'REQUEST_COMPLETE', id: 't-mobile'});
  const freshOperationId = byId(state, 't-mobile').pendingOperation.id;
  assert.notEqual(freshOperationId, oldOperationId);
  state = reducer(state, {type: 'RESOLVE_COMPLETE', id: 't-mobile', outcome: 'success', operationId: oldOperationId});
  assert.equal(byId(state, 't-mobile').syncStatus, 'pending');
  state = reducer(state, {type: 'RESOLVE_COMPLETE', id: 't-mobile', outcome: 'success', operationId: freshOperationId});
  assert.equal(byId(state, 't-mobile').state, 'done');
  assert.equal(state.journal.length, 2);
  assert.equal(validateState(state), true);
});

test('retry defensively refreshes legacy previous state while preserving operation ID', () => {
  let state = reducer(createInitialState(), {type: 'REQUEST_COMPLETE', id: 't-harness'});
  state = reducer(state, {type: 'RESOLVE_COMPLETE', id: 't-harness', outcome: 'failure'});
  const operationId = byId(state, 't-harness').pendingOperation.id;
  // A saved snapshot from an older prototype might permit these intervening edits.
  state = structuredClone(state);
  byId(state, 't-harness').state = 'doing';
  byId(state, 't-harness').now = true;
  state = reducer(state, {type: 'RETRY_COMPLETE', id: 't-harness'});
  assert.equal(byId(state, 't-harness').pendingOperation.id, operationId);
  state = reducer(state, {type: 'RESOLVE_COMPLETE', id: 't-harness', outcome: 'success', operationId});
  state = reducer(state, {type: 'UNDO_COMPLETE', id: 't-harness'});
  assert.equal(byId(state, 't-harness').state, 'doing');
  assert.equal(byId(state, 't-harness').now, true);
  assert.equal(validateState(state), true);
});

test('stored state validation rejects malformed nested data and invalid references without throwing', () => {
  const mutations = [
    s => s.tasks.push(null),
    s => s.tasks[0].checklist.push(null),
    s => s.tasks[0].checklist[0].text = {},
    s => s.tasks[0].checklist[0].done = 'yes',
    s => s.tasks[0].history = [null],
    s => s.tasks[0].history = [{id: 'bad', type: 'x', at: null, message: 'x', simulated: true}],
    s => s.tasks[0].materialIds = ['missing-material'],
    s => s.tasks[0].materialIds.push('m-craft-check'),
    s => s.tasks[0].aiNote = {},
    s => s.tasks[0].due = '2026-02-30',
    s => s.tasks[0].syncStatus = 'success',
    s => s.tasks[0].syncStatus = 'pending',
    s => {s.tasks[0].syncStatus = 'pending'; s.tasks[0].pendingOperation = {};},
    s => {s.tasks[0].syncStatus = 'pending'; s.tasks[0].pendingOperation = {id: 'operation', kind: 'other', requestedAt: '2026-11-14', previousState: 'todo', previousNow: false};},
    s => {s.tasks[0].syncStatus = 'pending'; s.tasks[0].pendingOperation = {id: 'operation', kind: 'complete', requestedAt: null, previousState: 'todo', previousNow: false};},
    s => {s.tasks[0].syncStatus = 'pending'; s.tasks[0].pendingOperation = {id: 'operation', kind: 'complete', requestedAt: '2026-11-14', previousState: 'done', previousNow: false};},
    s => {s.tasks[0].syncStatus = 'pending'; s.tasks[0].pendingOperation = {id: 'operation', kind: 'complete', requestedAt: '2026-11-14', previousState: 'todo', previousNow: null};},
    s => s.tasks[0].state = 'waiting',
    s => s.tasks[0].state = 'done',
    s => s.tasks[0].completionSnapshot = {state: 'broken', now: true},
    s => s.tasks.find(t => t.id === 't-wait').waiting.reason = null,
    s => s.tasks.find(t => t.id === 't-wait').waiting.previousState = 'waiting',
    s => s.candidates.push(null),
    s => s.candidates[0].status = 'other',
    s => s.candidates[0].materialId = 'missing',
    s => s.candidates[0].suggestedTaskId = 'missing',
    s => s.candidates[0].summary = {},
    s => s.candidates[0].status = 'linked',
    s => s.materials.push(null),
    s => s.materials[0].body = {},
    s => s.materials[0].source = 'unknown-source',
    s => s.materials[0].updatedAt = null,
    s => s.journal.push(null),
    s => s.journal[0].taskId = 'missing',
    s => s.journal[0].date = 'yesterday',
    s => s.journal[0].reopenedAt = [],
    s => s.journal[0].type = 'wrong',
    s => s.events.push({id: 'x', type: 'x', message: 'x', at: '2026-11-14', simulated: true, taskId: 'missing'}),
    s => s.error = {},
    s => s.nextId = 0,
  ];
  for (const mutate of mutations) {
    const state = createInitialState();
    mutate(state);
    assert.doesNotThrow(() => validateState(state));
    assert.equal(validateState(state), false, String(mutate));
  }
  for (const malformed of [null, [], '', 12, {}, {version: 1, demoDate: {}}]) {
    assert.doesNotThrow(() => validateState(malformed));
    assert.equal(validateState(malformed), false);
  }
});

test('all legitimate workflow snapshots remain safe to restore', () => {
  let state = createInitialState();
  const steps = [
    {type: 'RESOLVE_CANDIDATE', id: 'c-drawing', decision: 'update', taskId: 't-harness'},
    {type: 'ADD_AI_NOTE', id: 't-harness'},
    {type: 'START_TASK', id: 't-harness'},
    {type: 'WAIT_TASK', id: 't-harness', person: 'DRE', reason: '确认版本'},
    {type: 'RESUME_TASK', id: 't-harness'},
    {type: 'REQUEST_COMPLETE', id: 't-harness'},
    {type: 'RESOLVE_COMPLETE', id: 't-harness', outcome: 'failure'},
    {type: 'CANCEL_COMPLETE', id: 't-harness'},
    {type: 'REQUEST_COMPLETE', id: 't-harness'},
    {type: 'RESOLVE_COMPLETE', id: 't-harness', outcome: 'success'},
    {type: 'REOPEN_TASK', id: 't-harness'},
    {type: 'RESOLVE_CANDIDATE', id: 'c-notes', decision: 'create'},
    {type: 'RESOLVE_CANDIDATE', id: 'c-insight', decision: 'defer'},
    {type: 'RESTORE_CANDIDATE', id: 'c-insight'},
    {type: 'ADD_TASK', title: '明确的新行动', requestId: 'one'},
  ];
  for (const step of steps) {
    state = reducer(state, step);
    assert.equal(state.error, null, step.type);
    assert.equal(validateState(JSON.parse(JSON.stringify(state))), true, step.type);
  }
  const invalidSequence = structuredClone(state);
  invalidSequence.nextId = 1;
  assert.equal(validateState(invalidSequence), false);
});
