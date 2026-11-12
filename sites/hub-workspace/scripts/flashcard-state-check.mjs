import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

function compiledModule(path, dependencies = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  let js = ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
  for (const [name, url] of Object.entries(dependencies)) js = js.replaceAll(`'${name}'`, `'${url}'`).replaceAll(`"${name}"`, `"${url}"`);
  return `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
}

const demoUrl = compiledModule('../app/flashcard-demo.ts');
const {demoCards} = await import(demoUrl);
const {
  FLASH_STORAGE_KEY, makeFlashState, loadFlashState, reconcileFlashDay, buildFlashSession,
  reconcileFlashSession, applyFlashRating, restoreFlashRating, getFlashCardStatus,
} = await import(compiledModule('../app/flashcard-state.ts', {'./flashcard-demo': demoUrl}));
const now = new Date('2026-11-08T08:00:00Z');
const ids = demoCards.map(card => card.id);
const fresh = (overrides = {}) => ({...makeFlashState(now), ...overrides});
const withSession = (state, deck = '') => ({...state, session: buildFlashSession(state, deck)});
const reveal = state => ({...state, session: {...state.session, revealed: true}});
const newCard = demoCards.find(card => card.id === 'engineering');
let checks = 0;
function check(name, run) { run(); checks += 1; console.log(`✓ ${name}`); }

check('旧存储兼容、首次演示统计与卡片 ID 去重', () => {
  assert.equal(FLASH_STORAGE_KEY, 'hub-flashcard-prototype-v1');
  assert.equal(fresh().reviewed, 16);
  assert.equal(fresh().newToday, 1);
  const legacy = {...fresh(), due: [...ids, 'knowledge'], studied: ['engineering', 'engineering'], dailyLimit: 5, newToday: 4};
  delete legacy.session;
  const loaded = loadFlashState(JSON.stringify(legacy), now);
  assert.deepEqual(loaded.due, ids);
  assert.deepEqual(loaded.studied, ['engineering']);
  assert.equal(loaded.session, null);
  assert.equal(loaded.dailyLimit, 5);
  assert.equal(loaded.newToday, 4);
});

check('损坏字段安全回退，损坏会话保留有效的当日进度', () => {
  const invalid = [null, [], {...fresh(), date: '2026-02-30'}, {...fresh(), due: ['missing']},
    {...fresh(), studied: 'knowledge'}, {...fresh(), reviewed: '16'}, {...fresh(), newToday: 1.5},
    {...fresh(), dailyLimit: 1}, {...fresh(), sessionLimit: -1}];
  for (const value of invalid) assert.deepEqual(loadFlashState(JSON.stringify(value), now), fresh());
  assert.deepEqual(loadFlashState('{broken', now), fresh());
  const valid = withSession(fresh({reviewed: 23, newToday: 4}));
  for (const session of [{...valid.session, ratings: [5]}, {...valid.session, queue: ['missing']},
    {...valid.session, revealed: 'true'}, {...valid.session, initialIds: ['knowledge']}]) {
    const loaded = loadFlashState(JSON.stringify({...valid, session}), now);
    assert.equal(loaded.reviewed, 23);
    assert.equal(loaded.newToday, 4);
    assert.equal(loaded.session, null);
  }
});

check('剩余一个新卡额度、不限额、空队列与牌组范围', () => {
  assert.deepEqual(buildFlashSession(fresh({dailyLimit: 5, newToday: 4})).queue, ['knowledge', 'hub', 'engineering']);
  assert.deepEqual(buildFlashSession(fresh({dailyLimit: 5, newToday: 5})).queue, ['knowledge', 'hub']);
  assert.deepEqual(buildFlashSession(fresh({dailyLimit: 0, newToday: 100, sessionLimit: 0})).queue, ids);
  assert.deepEqual(buildFlashSession(fresh(), '工程知识').queue, ['engineering']);
  assert.deepEqual(buildFlashSession(fresh(), '学习笔记').queue, ['knowledge', 'hub', 'decision']);
  assert.equal(buildFlashSession(fresh(), '不存在的牌组'), null);
  assert.equal(buildFlashSession(fresh({due: []})), null);
});

check('调低每日额度延后未学卡，保留重来卡与准确进度', () => {
  const state = reveal(withSession(fresh({newToday: 4})));
  const limited = reconcileFlashSession({...state, dailyLimit: 5});
  assert.deepEqual(limited.session.queue, ['knowledge', 'hub', 'engineering']);
  assert.deepEqual(limited.session.initialIds, ['knowledge', 'hub', 'engineering']);
  assert.equal(limited.session.revealed, true);
  assert.equal(limited.reviewed, state.reviewed);
  assert.equal(limited.newToday, state.newToday);
  const repeating = {...state, studied: ['engineering'], dailyLimit: 5, newToday: 5};
  assert.deepEqual(reconcileFlashSession(repeating).session.queue, ['knowledge', 'hub', 'engineering']);
  const oneNew = reveal(withSession(fresh({dailyLimit: 10, newToday: 5}), '工程知识'));
  assert.equal(reconcileFlashSession({...oneNew, dailyLimit: 5}).session, null);
  const nextRoundSetting = reconcileFlashSession({...state, sessionLimit: 100});
  assert.deepEqual(nextRoundSetting.session, state.session);
});

check('只有揭示后的有效评分生效，重来回队且只占一次新卡额度', () => {
  let state = withSession(fresh({dailyLimit: 5, newToday: 4}), '工程知识');
  assert.strictEqual(applyFlashRating(state, 3), state);
  state = reveal(state);
  for (const rating of [0, 5, 1.5, NaN]) assert.strictEqual(applyFlashRating(state, rating), state);
  assert.equal(getFlashCardStatus(newCard, state), 'new');
  state = applyFlashRating(state, 1);
  assert.deepEqual(state.session.queue, ['engineering']);
  assert.equal(state.newToday, 5);
  assert.equal(state.reviewed, 17);
  assert.equal(getFlashCardStatus(newCard, state), 'due');
  assert.strictEqual(applyFlashRating(state, 1), state, '重复事件不能在未揭示下一面时评分');
  state = applyFlashRating(reveal(state), 1);
  assert.equal(state.newToday, 5);
  assert.equal(state.reviewed, 18);
  state = applyFlashRating(reveal(state), 3);
  assert.deepEqual(state.session.queue, []);
  assert.deepEqual(state.session.ratings, [1, 1, 3]);
  assert.equal(state.newToday, 5);
  assert.equal(getFlashCardStatus(newCard, state), 'done');
  let mixed = withSession(fresh());
  mixed = reveal({...mixed, session: {...mixed.session, queue: ['engineering', 'knowledge', 'hub', 'decision']}});
  assert.deepEqual(applyFlashRating(mixed, 1).session.queue, ['knowledge', 'hub', 'decision', 'engineering']);
});

check('撤销恢复卡片和计数，保留最新设置，并可重新评分', () => {
  const before = reveal(withSession(fresh({dailyLimit: 5, newToday: 4}), '工程知识'));
  const after = applyFlashRating(before, 3);
  const current = {...after, dailyLimit: 0, sessionLimit: 50};
  const restored = restoreFlashRating(current, before);
  assert.deepEqual(restored, {...before, dailyLimit: 0, sessionLimit: 50});
  assert.equal(restored.session.revealed, true);
  const ratedAgain = applyFlashRating(restored, 3);
  assert.equal(ratedAgain.newToday, 5);
  assert.equal(ratedAgain.reviewed, 17);
  assert.deepEqual(ratedAgain.session.ratings, [3]);
  const blocked = restoreFlashRating({...after, dailyLimit: 5, newToday: 6}, {...before, newToday: 5});
  assert.equal(blocked.session, null, '撤销后仍须遵守当前每日额度');
});

check('刷新保留正面、答案面、重来顺序与完成会话', () => {
  const front = withSession(fresh());
  const back = reveal(front);
  const repeat = applyFlashRating(back, 1);
  const completed = applyFlashRating(reveal(withSession(fresh(), '工程知识')), 4);
  for (const state of [front, back, repeat, completed]) {
    assert.deepEqual(loadFlashState(JSON.stringify(state), now), state);
  }
  const duplicated = {...front, session: {...front.session, queue: [...front.session.queue, 'knowledge'], initialIds: [...ids, 'knowledge']}};
  assert.deepEqual(loadFlashState(JSON.stringify(duplicated), now), front);
});

check('北京时间跨日清零并保留偏好，旧日撤销不能恢复旧进度', () => {
  const beforeMidnight = new Date('2026-11-08T15:59:59Z');
  const afterMidnight = new Date('2026-11-08T16:00:00Z');
  const state = applyFlashRating(reveal(withSession(fresh({dailyLimit: 5, sessionLimit: 50}))), 3);
  assert.strictEqual(reconcileFlashDay(state, beforeMidnight), state);
  const next = reconcileFlashDay(state, afterMidnight);
  assert.equal(next.date, '2026-11-09');
  assert.deepEqual(next.due, ids);
  assert.deepEqual(next.studied, []);
  assert.equal(next.reviewed, 0);
  assert.equal(next.newToday, 0);
  assert.equal(next.session, null);
  assert.equal(next.dailyLimit, 5);
  assert.equal(next.sessionLimit, 50);
  assert.deepEqual(loadFlashState(JSON.stringify(state), afterMidnight), next);
  assert.strictEqual(restoreFlashRating(next, state), next);
});

check('会话固定牌组范围，移除已完成卡后隐藏不对应的答案', () => {
  const deck = reveal(withSession(fresh(), '工程知识'));
  assert.equal(reconcileFlashSession({...deck, dailyLimit: 0}).session.label, '工程知识');
  const crossDeck = {...deck, session: {...deck.session, queue: ['engineering', 'knowledge'], initialIds: ['engineering', 'knowledge']}};
  assert.equal(loadFlashState(JSON.stringify(crossDeck), now).session, null);
  const state = reveal(withSession(fresh()));
  const completedElsewhere = {...state, due: ids.filter(id => id !== 'knowledge'), studied: ['knowledge']};
  const cleaned = reconcileFlashSession(completedElsewhere);
  assert.deepEqual(cleaned.session.queue, ['hub', 'engineering', 'decision']);
  assert.equal(cleaned.session.revealed, false);
  assert.deepEqual(cleaned.session.initialIds, ids);
  assert.equal(cleaned.session.label, state.session.label);
});

check('评分、额度调整与撤销不修改输入快照', () => {
  const state = reveal(withSession(fresh()));
  const snapshot = JSON.stringify(state);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(state);
  const after = applyFlashRating(state, 3);
  reconcileFlashSession({...state, dailyLimit: 5, newToday: 5});
  restoreFlashRating(after, state);
  assert.equal(JSON.stringify(state), snapshot);
});

console.log(`通过 ${checks} 组闪卡状态检查。`);
