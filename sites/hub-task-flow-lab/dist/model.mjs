/**
 * Pure, browser-local task model for the Hub task-flow prototype.
 * No connector, network request, credential, or real external write exists here.
 * All source acknowledgements are explicit simulations.
 */

import {planningInitial, planningValid, reducePlanning} from './planning.mjs';

export const MODEL_VERSION = 1;
export const ACTION_POOL_LIMIT = 5;
export const DEMO_DATE = '2026-11-14';

const STATES = new Set(['todo', 'doing', 'waiting', 'done']);
const SOURCES = new Set(['dida', 'craft', 'obsidian', 'feishu', 'hub']);
const CANDIDATE_STATES = new Set(['pending', 'linked', 'updated', 'created', 'ignored', 'deferred']);
const COMPLETION_LOCKED_ACTIONS = new Set(['UPDATE_TASK', 'TOGGLE_NOW', 'START_TASK', 'WAIT_TASK', 'RESUME_TASK', 'TOGGLE_CHECK', 'ADD_AI_NOTE', 'ADD_MATERIAL', 'REMOVE_MATERIAL']);
const clone = value => structuredClone(value);
const text = value => typeof value === 'string' ? value.trim() : '';

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function datePart(value, fallback = DEMO_DATE) {
  const part = typeof value === 'string' ? value.slice(0, 10) : '';
  return validDate(part) ? part : fallback;
}

function dayOffset(day, offset) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function makeTask(id, title, extra = {}) {
  return {
    id, title, project: '个人', list: '收集箱', source: 'dida', state: 'todo',
    priority: 'normal', due: null, plannedDate: null, now: false,
    purpose: '把需要关注的事情变成明确、可完成的行动。',
    nextStep: '', doneCriteria: '', materialIds: [], checklist: [], waiting: null,
    syncStatus: 'synced', pendingOperation: null, completedOn: null,
    completionSnapshot: null, aiNote: '', history: [], needsTriage: false,
    simulated: true, ...extra,
  };
}

export function createInitialState(now = DEMO_DATE) {
  const today = datePart(now);
  const yesterday = dayOffset(today, -1);
  const materials = [
    {
      id: 'm-drawing', title: '室内线束固定点变更通知 · V3', source: 'feishu',
      kind: '变更通知', project: 'BEV', updatedAt: today,
      body: '示例资料：本次图纸把副驾侧固定点 P12 的位置向横梁方向调整，并补充了卡扣型号说明。请核对位置、安装方向与干涉风险；最终发布版本仍待 DRE 确认。',
    },
    {
      id: 'm-craft-check', title: '固定点核对方法与验收清单', source: 'craft',
      kind: '工作笔记', project: 'BEV', updatedAt: yesterday,
      body: '示例资料：核对时保留图纸版本号；逐项检查位置、方向、安装空间和与周边件的关系。完成标准是形成可追溯的核对结论，并给出需要确认的问题。',
    },
    {
      id: 'm-interface', title: '接口评审问题记录', source: 'feishu',
      kind: '评审记录', project: 'BEV', updatedAt: yesterday,
      body: '示例资料：整理本次评审涉及的三个接口问题，区分已确认项与待供应商补充项。记录应包含责任方、所需信息和下一次跟进日期。',
    },
    {
      id: 'm-product', title: '手机端搜索范围交互记录', source: 'craft',
      kind: '产品笔记', project: 'Hub', updatedAt: today,
      body: '示例资料：点击“全部”应切换视图；只有主动修改资料范围时才展开筛选器。记住上次选择，保留返回路径，避免反复确认。',
    },
    {
      id: 'm-reading', title: '任务、资料与项目的关系', source: 'obsidian',
      kind: '阅读摘录', project: '学习', updatedAt: yesterday,
      body: '示例资料：资料提供依据，项目表达希望达成的结果，任务表示具体行动。摘录中的复选框不应未经判断全部转为个人承诺。',
    },
    {
      id: 'm-insight', title: '本周等待项缺少跟进日期', source: 'hub',
      kind: '洞察依据', project: '个人', updatedAt: today,
      body: '示例发现：部分等待中的事项没有下一次核对日期。建议先补充等待对象与跟进时间；不必为每次提醒再创建一个重复任务。',
    },
  ];

  const tasks = [
    makeTask('t-harness', '核对线束固定点并反馈', {
      project: 'BEV', list: '工程交付', priority: 'high', due: dayOffset(today, 2),
      purpose: '确认固定点变更能够正确装配，让交付结论有图纸与核对记录支撑。',
      nextStep: '关联最新图纸，列出与上一版不同的固定点。',
      doneCriteria: '核对位置、卡扣与干涉；确认图纸版本；保存结论并反馈。',
      materialIds: ['m-craft-check'],
      checklist: [
        {id: 'h-version', text: '确认本次使用的图纸版本', done: false},
        {id: 'h-position', text: '核对固定点位置与卡扣方向', done: false},
        {id: 'h-feedback', text: '保存核对结论并反馈', done: false},
      ],
    }),
    makeTask('t-review', '发送接口评审确认记录', {
      project: 'BEV', list: '工程交付', priority: 'high', due: today,
      purpose: '让相关人员对已确认项与待补充项达成一致。',
      nextStep: '核对三个问题的责任方后发送评审记录。',
      doneCriteria: '记录已核对并发送。', materialIds: ['m-interface'],
    }),
    makeTask('t-mobile', '验证手机端资料范围记忆', {
      project: 'Hub', list: '产品迭代', now: true, plannedDate: today,
      purpose: '减少重复确认，让搜索能够直接开始。',
      nextStep: '切换资料范围，刷新页面，再次打开搜索。',
      doneCriteria: '范围选择得到保留，点击全部不反复弹窗。', materialIds: ['m-product'],
    }),
    makeTask('t-docs', '整理任务原型验收要点', {
      project: 'Hub', list: '产品迭代', now: true, plannedDate: today,
      purpose: '用清楚的验收项判断任务流程是否真的闭环。',
      nextStep: '写下“关联不新增、等待可恢复、失败不假成功”三个用例。',
      doneCriteria: '每个核心流程都有可以重复执行的验证步骤。',
    }),
    makeTask('t-bills', '核对本周订阅账单', {
      project: '生活', list: '个人事务', now: true,
      purpose: '确认每笔定期扣费都符合预期。',
      nextStep: '打开账单，核对服务名称与扣费周期。',
      doneCriteria: '已核对本周账单，异常项有记录。',
    }),
    makeTask('t-wait', '等待供应商补充接口规格', {
      project: '160', list: '工程交付', state: 'waiting', due: dayOffset(today, 3),
      purpose: '在接口信息确认后继续核对方案。', nextStep: '收到规格后继续原任务。',
      doneCriteria: '接口参数已核对，未确认项已反馈。',
      waiting: {person: '供应商接口负责人', reason: '缺少最终接口尺寸与针脚定义', reviewDate: dayOffset(today, 1), previousState: 'doing'},
    }),
    makeTask('t-inbox', '整理本次评审的三个问题', {
      project: '未分类', list: '收集箱', needsTriage: true,
      purpose: '把已记录的承诺补充为可以开始的下一步。',
      nextStep: '', doneCriteria: '', materialIds: ['m-interface'],
    }),
    makeTask('t-read', '阅读与摘录设计规范', {
      project: '学习', list: '学习积累',
      purpose: '为下一次方案评审积累可以引用的依据。',
      nextStep: '阅读与当前项目相关的一小节。',
      doneCriteria: '摘录关键条款并记录适用范围。', materialIds: ['m-reading'],
    }),
    makeTask('t-done', '归档上一次评审记录', {
      project: 'BEV', list: '工程交付', state: 'done', completedOn: yesterday,
      purpose: '让后续核对能够找回原始结论。', nextStep: '已完成。',
      doneCriteria: '评审记录已整理到对应项目。', materialIds: ['m-interface'],
      completionSnapshot: {state: 'todo', now: false},
      history: [{id: 'seed-history', type: 'completed', at: yesterday, message: '示例：已收到滴答完成确认', simulated: true}],
    }),
    makeTask('t-home', '预约设备保养', {
      project: '生活', list: '个人事务', due: dayOffset(today, 7),
      purpose: '在合适的时间处理日常维护。', nextStep: '确认可预约的时间段。',
      doneCriteria: '保养时间已确认并记入日程。',
    }),
  ];

  return {
    version: MODEL_VERSION, demoDate: today, tasks, materials,
    candidates: [
      {
        id: 'c-drawing', title: '新图纸来了，需要核对固定点', source: 'feishu',
        materialId: 'm-drawing', project: 'BEV',
        summary: '这是新的依据，不一定是新的任务。已有“核对线束固定点并反馈”，建议先关联。',
        suggestedTaskId: 't-harness', status: 'pending', resolvedTaskId: null,
      },
      {
        id: 'c-notes', title: '检查搜索范围是否保留', source: 'craft',
        materialId: 'm-product', project: 'Hub',
        summary: '笔记中有一项待验证建议。可以关联现有任务，也可以确认后创建。',
        suggestedTaskId: 't-mobile', status: 'pending', resolvedTaskId: null,
      },
      {
        id: 'c-insight', title: '给等待事项补充跟进日期', source: 'hub',
        materialId: 'm-insight', project: '个人',
        summary: '洞察只是建议。先判断是否直接补充已有任务，或暂不处理。',
        suggestedTaskId: 't-wait', status: 'pending', resolvedTaskId: null,
      },
    ],
    journal: [{id: 'j-seed', taskId: 't-done', title: '归档上一次评审记录', project: 'BEV', type: 'completed', date: yesterday, at: yesterday, operationId: 'seed-complete', simulated: true, reopenedAt: null}],
    events: [], nextId: 1, error: null, planning: planningInitial(),
  };
}

function fail(state, message) {
  return {...state, error: message};
}

function taskEvent(state, task, type, message, now, extra = {}) {
  const entry = {id: `event-${state.nextId++}`, type, taskId: task.id, at: now, message, simulated: true, ...extra};
  task.history.push(entry);
  state.events.push(entry);
  return entry;
}

function optionalDate(value) {
  return value === undefined || value === null || value === '' ? null : value;
}

function checkDates(values) {
  return values.every(value => optionalDate(value) === null || validDate(value));
}

function candidateHasResolved(candidate) {
  return candidate.status === 'linked' || candidate.status === 'updated' || candidate.status === 'created';
}

function completeRequest(next, task, now, retry = false) {
  if (task.state === 'done') return next;
  if (task.state === 'waiting') return fail(next, '这项任务正在等待条件。请先恢复任务，再确认完成。');
  if (task.syncStatus === 'pending') return next;
  if (retry && (!task.pendingOperation || task.syncStatus !== 'failed')) return fail(next, '没有需要重试的完成操作。');
  if (!task.pendingOperation) {
    task.pendingOperation = {id: `complete-${next.nextId++}`, kind: 'complete', requestedAt: now, previousState: task.state, previousNow: task.now};
  } else {
    // Keep the idempotency key, but never restore an obsolete snapshot if a
    // previously saved prototype state predates the completion edit lock.
    task.pendingOperation.previousState = task.state;
    task.pendingOperation.previousNow = task.now;
  }
  task.syncStatus = 'pending';
  taskEvent(next, task, retry ? 'completion-retry' : 'completion-requested', retry ? '演示：重试同一完成操作，保留原任务 ID' : '演示：正在等待滴答完成确认', now, {operationId: task.pendingOperation.id});
  return next;
}

/**
 * Mutations are copy-on-write. Validation errors do not partially apply changes.
 * Pass a local YYYY-MM-DD date (or ISO timestamp) for completion/journal dates.
 */
export function reducer(state, action, now = state.demoDate) {
  if (!state || !action || typeof action.type !== 'string') return state;
  const at = typeof now === 'string' && validDate(now.slice(0, 10)) ? now : state.demoDate;
  const day = datePart(at, state.demoDate);
  if (action.type === 'RESET') return createInitialState(day);
  if (action.type === 'CLEAR_ERROR') return {...state, error: null};
  const next = clone(state);
  next.error = null;
  if (action.type.startsWith('PLAN_')) return reducePlanning(next, action, at);

  if (action.type === 'ADD_TASK') {
    const title = text(action.title);
    if (!title) return fail(state, '请先填写任务标题。');
    if (!checkDates([action.due, action.plannedDate])) return fail(state, '日期格式不正确。');
    if (action.requestId && next.tasks.some(item => item.creationRequestId === action.requestId)) return next;
    const task = makeTask(`task-${next.nextId++}`, title, {
      project: text(action.project) || '个人', list: text(action.list) || '收集箱',
      due: optionalDate(action.due), plannedDate: optionalDate(action.plannedDate),
      purpose: text(action.purpose) || '由你明确创建的行动。',
      nextStep: text(action.nextStep), doneCriteria: text(action.doneCriteria),
      creationRequestId: action.requestId || null,
    });
    next.tasks.unshift(task);
    taskEvent(next, task, 'created', '演示：新任务已保存到滴答；没有额外创建一份 Hub 任务', at);
    return next;
  }

  if (action.type === 'RESOLVE_CANDIDATE' || action.type === 'RESTORE_CANDIDATE') {
    const candidate = next.candidates.find(item => item.id === action.id);
    if (!candidate) return fail(state, '找不到这条待整理建议。');
    if (action.type === 'RESTORE_CANDIDATE') {
      if (candidate.status === 'deferred' || candidate.status === 'ignored') candidate.status = 'pending';
      return next;
    }
    if (!['link', 'update', 'create', 'ignore', 'defer'].includes(action.decision)) return fail(state, '请先选择如何处理这条建议。');
    if (candidateHasResolved(candidate)) return next;
    if (action.decision === 'ignore' || action.decision === 'defer') {
      candidate.status = action.decision === 'ignore' ? 'ignored' : 'deferred';
      candidate.resolvedAt = at;
      return next;
    }
    if (action.decision === 'link' || action.decision === 'update') {
      const task = next.tasks.find(item => item.id === action.taskId);
      if (!task) return fail(state, '请先选择要关联的已有任务。');
      if (task.syncStatus === 'pending' || task.syncStatus === 'failed') return fail(state, '这项任务有尚未处理的完成操作。请先确认结果，或取消这次完成操作。');
      if (!task.materialIds.includes(candidate.materialId)) task.materialIds.push(candidate.materialId);
      if (action.decision === 'update') task.nextStep = text(action.nextStep) || [task.nextStep, `补充：${candidate.summary}`].filter(Boolean).join('\n');
      candidate.status = action.decision === 'update' ? 'updated' : 'linked';
      candidate.resolvedTaskId = task.id;
      candidate.resolvedAt = at;
      taskEvent(next, task, action.decision === 'update' ? 'candidate-updated' : 'material-linked', action.decision === 'update' ? '演示：补充原任务的下一步并关联依据；保留日期与原清单' : '已把候选建议关联到原任务；任务数量不增加', at, {materialId: candidate.materialId, candidateId: candidate.id});
      return next;
    }
    const title = text(action.title) || candidate.title;
    if (!title) return fail(state, '请先填写要创建的任务标题。');
    if (!checkDates([action.due, action.plannedDate])) return fail(state, '日期格式不正确。');
    const id = `task-from-${candidate.id}`;
    let task = next.tasks.find(item => item.id === id);
    if (!task) {
      task = makeTask(id, title, {
        project: text(action.project) || candidate.project || '个人',
        list: text(action.list) || '收集箱', due: optionalDate(action.due),
        plannedDate: optionalDate(action.plannedDate),
        purpose: candidate.summary, nextStep: text(action.nextStep),
        doneCriteria: text(action.doneCriteria), materialIds: [candidate.materialId],
      });
      next.tasks.unshift(task);
      taskEvent(next, task, 'candidate-created', '演示：你确认了新任务，保留原资料作为依据', at, {candidateId: candidate.id});
    }
    candidate.status = 'created';
    candidate.resolvedTaskId = task.id;
    candidate.resolvedAt = at;
    return next;
  }

  const task = next.tasks.find(item => item.id === action.id);
  if (!task) return fail(state, '找不到这项任务。');
  if ((task.syncStatus === 'pending' || task.syncStatus === 'failed') && COMPLETION_LOCKED_ACTIONS.has(action.type)) return fail(state, '这项任务有尚未处理的完成操作。请先确认结果，或取消这次完成操作。');

  switch (action.type) {
    case 'UPDATE_TASK': {
      const patch = action.patch || {};
      if ('title' in patch && !text(patch.title)) return fail(state, '任务标题不能为空。');
      if (!checkDates([patch.due, patch.plannedDate])) return fail(state, '日期格式不正确。');
      if ('state' in patch || 'id' in patch || 'source' in patch || 'syncStatus' in patch) return fail(state, '任务身份和状态需要使用对应的流程操作。');
      const allowed = ['title', 'project', 'list', 'purpose', 'nextStep', 'doneCriteria'];
      for (const key of allowed) if (key in patch) task[key] = text(patch[key]);
      for (const key of ['due', 'plannedDate']) if (key in patch) task[key] = optionalDate(patch[key]);
      if ('priority' in patch) task.priority = patch.priority === 'high' ? 'high' : 'normal';
      if ('needsTriage' in patch) task.needsTriage = !!patch.needsTriage;
      taskEvent(next, task, 'updated', '演示：已更新原任务信息', at);
      return next;
    }
    case 'TOGGLE_NOW': {
      if (task.state === 'done') return fail(state, '已完成任务无需加入行动池。可以先恢复任务。');
      if (task.state === 'waiting') return fail(state, '正在等待条件的任务不能加入行动池。请先恢复任务。');
      if (!task.now && next.tasks.filter(item => item.now && item.state !== 'done' && item.state !== 'waiting').length >= ACTION_POOL_LIMIT) return fail(state, '行动池先保留最多 5 项。请移出一项，再选择新的下一步；硬性截止任务仍会单独显示。');
      task.now = !task.now;
      taskEvent(next, task, task.now ? 'pool-added' : 'pool-removed', task.now ? '加入行动池；原任务与原清单保持不变' : '从行动池移出；没有删除原任务', at);
      return next;
    }
    case 'START_TASK': {
      if (task.state === 'done') return fail(state, '请先恢复已完成的任务。');
      if (task.state === 'waiting') return fail(state, '请先确认等待条件已满足，再恢复任务。');
      if (task.syncStatus === 'pending') return fail(state, '正在等待完成确认，请先处理当前操作。');
      task.state = 'doing';
      taskEvent(next, task, 'started', '开始处理原任务', at);
      return next;
    }
    case 'WAIT_TASK': {
      if (task.state === 'done') return fail(state, '已完成任务不能设为等待。');
      if (task.syncStatus === 'pending') return fail(state, '正在等待完成确认，请先处理当前操作。');
      const person = text(action.person);
      const reason = text(action.reason);
      if (!person || !reason) return fail(state, '请写明等待谁，以及还缺少什么条件。');
      if (!checkDates([action.reviewDate])) return fail(state, '跟进日期格式不正确。');
      const previousState = task.waiting?.previousState || task.state;
      task.waiting = {person, reason, reviewDate: optionalDate(action.reviewDate), previousState};
      task.state = 'waiting';
      task.now = false;
      taskEvent(next, task, 'waiting', `等待 ${person}：${reason}`, at);
      return next;
    }
    case 'RESUME_TASK': {
      if (task.state !== 'waiting') return next;
      const previousState = task.waiting?.previousState;
      task.state = previousState === 'doing' ? 'doing' : 'todo';
      task.waiting = null;
      task.now = false;
      taskEvent(next, task, 'resumed', '等待条件已满足，恢复原任务；尚未标记完成', at);
      return next;
    }
    case 'TOGGLE_CHECK': {
      const check = task.checklist.find(item => item.id === action.checkId);
      if (!check) return fail(state, '找不到这条核对项。');
      if (task.state === 'done') return fail(state, '请先恢复任务，再修改核对项。');
      check.done = !check.done;
      return next;
    }
    case 'ADD_AI_NOTE': {
      const note = text(action.text) || '【AI 演示草稿，待人工核对】\n1. 对比当前图纸版本与变更通知。\n2. 逐项核对固定点的位置、卡扣方向及周边干涉。\n3. 把不确定项列给 DRE 确认，保留回复依据。\n4. 保存核对结论后，再由你决定任务是否完成。';
      task.aiNote = note;
      if (!task.checklist.some(item => item.id === 'ai-verify')) task.checklist.push({id: 'ai-verify', text: '人工核对 AI 草稿中的关键结论', done: false});
      taskEvent(next, task, 'ai-draft', '已把 AI 演示草稿附到原任务；没有新建任务或自动完成', at);
      return next;
    }
    case 'ADD_MATERIAL': {
      if (!next.materials.some(item => item.id === action.materialId)) return fail(state, '这份资料当前不可用。');
      if (!task.materialIds.includes(action.materialId)) {
        task.materialIds.push(action.materialId);
        taskEvent(next, task, 'material-linked', '已关联资料，保留原资料与原任务', at, {materialId: action.materialId});
      }
      return next;
    }
    case 'REMOVE_MATERIAL': {
      task.materialIds = task.materialIds.filter(id => id !== action.materialId);
      taskEvent(next, task, 'material-unlinked', '已移除任务与资料的关联；未删除资料', at, {materialId: action.materialId});
      return next;
    }
    case 'REQUEST_COMPLETE':
      return completeRequest(next, task, at);
    case 'RETRY_COMPLETE':
      return completeRequest(next, task, at, true);
    case 'CANCEL_COMPLETE': {
      if (!task.pendingOperation || !['pending', 'failed'].includes(task.syncStatus)) return next;
      const operationId = task.pendingOperation.id;
      task.pendingOperation = null;
      task.syncStatus = 'synced';
      taskEvent(next, task, 'completion-cancelled', '演示：已取消这次完成操作；原任务仍未完成，过期的模拟确认不会再生效', at, {operationId});
      return next;
    }
    case 'RESOLVE_COMPLETE': {
      const operation = task.pendingOperation;
      if (!operation || task.syncStatus !== 'pending') return state;
      if (action.operationId && action.operationId !== operation.id) return state;
      if (action.outcome === 'failure') {
        task.syncStatus = 'failed';
        taskEvent(next, task, 'completion-failed', '演示：未收到来源确认；任务保持未完成，可重试同一操作', at, {operationId: operation.id});
        return next;
      }
      if (action.outcome !== 'success') return fail(state, '请选择模拟成功或模拟失败。');
      task.completionSnapshot = {state: operation.previousState, now: operation.previousNow};
      task.state = 'done';
      task.completedOn = day;
      task.now = false;
      task.syncStatus = 'synced';
      task.pendingOperation = null;
      if (!next.journal.some(entry => entry.operationId === operation.id)) {
        next.journal.unshift({id: `journal-${next.nextId++}`, taskId: task.id, title: task.title, project: task.project, type: 'completed', date: day, at, operationId: operation.id, simulated: true, reopenedAt: null});
      }
      taskEvent(next, task, 'completed', '演示：收到滴答完成确认，按实际完成日期写入日志', at, {operationId: operation.id});
      return next;
    }
    case 'REOPEN_TASK':
    case 'UNDO_COMPLETE': {
      if (task.state !== 'done') return next;
      const previous = task.completionSnapshot;
      task.state = previous?.state === 'doing' ? 'doing' : 'todo';
      task.now = !!previous?.now && next.tasks.filter(item => item.now && item.state !== 'done' && item.state !== 'waiting').length < ACTION_POOL_LIMIT;
      task.completedOn = null;
      task.syncStatus = 'synced';
      task.pendingOperation = null;
      for (const entry of next.journal) if (entry.taskId === task.id && entry.type === 'completed' && !entry.reopenedAt) entry.reopenedAt = at;
      const id = `reopen-${next.nextId++}`;
      next.journal.unshift({id, taskId: task.id, title: task.title, project: task.project, type: 'reopened', date: day, at, operationId: id, simulated: true});
      taskEvent(next, task, 'reopened', action.type === 'UNDO_COMPLETE' ? '演示：撤销完成，恢复同一任务并保留历史' : '演示：恢复同一任务，完成记录保留为历史', at);
      return next;
    }
    default:
      return state;
  }
}

export function selectors(task) {
  const checklist = task?.checklist || [];
  return {
    isOpen: !!task && task.state !== 'done',
    isWaiting: task?.state === 'waiting', isDone: task?.state === 'done',
    isSyncPending: task?.syncStatus === 'pending', isSyncFailed: task?.syncStatus === 'failed',
    canComplete: !!task && task.state !== 'done' && task.state !== 'waiting' && !['pending', 'failed'].includes(task.syncStatus),
    checklistDone: checklist.filter(item => item.done).length, checklistTotal: checklist.length,
  };
}

export function taskSources(state, task) {
  return [...new Set([task.source, ...task.materialIds.map(id => state.materials.find(material => material.id === id)?.source).filter(Boolean)])];
}

export function selectView(state, view, filters = {}) {
  const today = validDate(filters.today) ? filters.today : state.demoDate;
  return state.tasks.filter(task => {
    if (view === 'now' && !(task.state !== 'done' && ((task.due && task.due <= today) || (task.state !== 'waiting' && (task.now || (task.plannedDate && task.plannedDate <= today)))))) return false;
    if ((view === 'triage' || view === 'organize') && !(task.state !== 'done' && task.needsTriage)) return false;
    if (view === 'waiting' && task.state !== 'waiting') return false;
    if (filters.project && filters.project !== 'all' && task.project !== filters.project) return false;
    if (filters.source && filters.source !== 'all' && !taskSources(state, task).includes(filters.source)) return false;
    if (filters.status === 'open' && task.state === 'done') return false;
    if (filters.status === 'done' && task.state !== 'done') return false;
    const query = text(filters.query).toLocaleLowerCase();
    if (query && ![task.title, task.project, task.list, task.purpose, task.nextStep, task.doneCriteria].join(' ').toLocaleLowerCase().includes(query)) return false;
    return true;
  });
}

export function selectCounts(state) {
  const open = state.tasks.filter(task => task.state !== 'done');
  const pendingCandidates = state.candidates.filter(candidate => candidate.status === 'pending').length;
  const inbox = open.filter(task => task.needsTriage).length;
  return {
    now: selectView(state, 'now').length, triage: pendingCandidates + inbox,
    waiting: open.filter(task => task.state === 'waiting').length,
    all: state.tasks.length, active: open.length, done: state.tasks.length - open.length,
    hardDue: open.filter(task => task.due && task.due <= state.demoDate).length,
    plannedToday: open.filter(task => task.state !== 'waiting' && task.plannedDate && task.plannedDate <= state.demoDate).length,
    actionPool: open.filter(task => task.now && task.state !== 'waiting').length,
    pendingCandidates, inbox,
  };
}

export function validateState(state) {
  // Local storage is untrusted input. Reject malformed nested values instead of
  // allowing them to reach .map(), .replace(), date, or reference rendering.
  try {
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const string = value => typeof value === 'string';
    const nonempty = value => string(value) && !!value.trim();
    const nullableDate = value => value === null || validDate(value);
    const timestamp = value => string(value) && validDate(value.slice(0, 10));
    const unique = values => values.length === new Set(values).size;
    if (!record(state) || state.version !== MODEL_VERSION || !validDate(state.demoDate)) return false;
    if (!planningValid(state.planning, state.tasks, state.materials)) return false;
    if (!['tasks', 'candidates', 'materials', 'journal', 'events'].every(key => Array.isArray(state[key]))) return false;
    if (!Number.isSafeInteger(state.nextId) || state.nextId < 1 || !(state.error === null || string(state.error))) return false;
    for (const key of ['tasks', 'candidates', 'materials', 'journal', 'events']) {
      if (!state[key].every(item => record(item) && nonempty(item.id)) || !unique(state[key].map(item => item.id))) return false;
    }
    const taskIds = new Set(state.tasks.map(item => item.id));
    const materialIds = new Set(state.materials.map(item => item.id));
    const candidateIds = new Set(state.candidates.map(item => item.id));
    const eventValid = (entry, requiredTaskId = null) => record(entry) &&
      ['id', 'type', 'message'].every(key => nonempty(entry[key])) && timestamp(entry.at) && entry.simulated === true &&
      (entry.taskId === undefined || (taskIds.has(entry.taskId) && (!requiredTaskId || entry.taskId === requiredTaskId))) &&
      (entry.operationId === undefined || nonempty(entry.operationId)) &&
      (entry.materialId === undefined || materialIds.has(entry.materialId)) &&
      (entry.candidateId === undefined || candidateIds.has(entry.candidateId));
    if (!state.materials.every(material => ['title', 'kind', 'project', 'body'].every(key => string(material[key])) && nonempty(material.title) && SOURCES.has(material.source) && timestamp(material.updatedAt))) return false;
    if (!state.candidates.every(candidate => {
      const resolved = ['linked', 'updated', 'created'].includes(candidate.status);
      return ['title', 'summary', 'project'].every(key => string(candidate[key])) && nonempty(candidate.title) &&
        SOURCES.has(candidate.source) && CANDIDATE_STATES.has(candidate.status) && materialIds.has(candidate.materialId) &&
        (candidate.suggestedTaskId === null || taskIds.has(candidate.suggestedTaskId)) &&
        (resolved ? taskIds.has(candidate.resolvedTaskId) : candidate.resolvedTaskId === null) &&
        (candidate.resolvedAt === undefined || timestamp(candidate.resolvedAt));
    })) return false;
    if (!state.tasks.every(task => {
      if (!['title', 'project', 'list', 'purpose', 'nextStep', 'doneCriteria', 'aiNote'].every(key => string(task[key])) || !nonempty(task.title)) return false;
      if (!STATES.has(task.state) || !SOURCES.has(task.source) || !['normal', 'high'].includes(task.priority) || !['synced', 'pending', 'failed', 'local'].includes(task.syncStatus)) return false;
      if (typeof task.now !== 'boolean' || typeof task.needsTriage !== 'boolean' || task.simulated !== true) return false;
      if (![task.due, task.plannedDate, task.completedOn].every(nullableDate)) return false;
      if (!Array.isArray(task.materialIds) || !unique(task.materialIds) || !task.materialIds.every(id => materialIds.has(id))) return false;
      if (!Array.isArray(task.checklist) || !task.checklist.every(item => record(item) && nonempty(item.id) && nonempty(item.text) && typeof item.done === 'boolean') || !unique(task.checklist.map(item => item.id))) return false;
      if (!Array.isArray(task.history) || !task.history.every(entry => eventValid(entry, task.id)) || !unique(task.history.map(entry => entry.id))) return false;
      if (task.state === 'waiting') {
        if (!record(task.waiting) || !nonempty(task.waiting.person) || !nonempty(task.waiting.reason) || !nullableDate(task.waiting.reviewDate) || !['todo', 'doing'].includes(task.waiting.previousState) || task.now) return false;
      } else if (task.waiting !== null) return false;
      if (task.state === 'done') {
        if (!validDate(task.completedOn) || task.now || task.pendingOperation !== null) return false;
      } else if (task.completedOn !== null) return false;
      if (task.completionSnapshot !== null && (!record(task.completionSnapshot) || !['todo', 'doing'].includes(task.completionSnapshot.state) || typeof task.completionSnapshot.now !== 'boolean')) return false;
      if (['pending', 'failed'].includes(task.syncStatus)) {
        const operation = task.pendingOperation;
        if (!['todo', 'doing'].includes(task.state) || !record(operation) || !nonempty(operation.id) || operation.kind !== 'complete' || !timestamp(operation.requestedAt) || !['todo', 'doing'].includes(operation.previousState) || typeof operation.previousNow !== 'boolean') return false;
      } else if (task.pendingOperation !== null) return false;
      return task.creationRequestId === undefined || task.creationRequestId === null || nonempty(task.creationRequestId);
    })) return false;
    if (!state.events.every(entry => eventValid(entry) && taskIds.has(entry.taskId))) return false;
    if (!state.journal.every(entry => ['title', 'project'].every(key => string(entry[key])) && nonempty(entry.title) && taskIds.has(entry.taskId) && ['completed', 'reopened'].includes(entry.type) && validDate(entry.date) && timestamp(entry.at) && nonempty(entry.operationId) && entry.simulated === true && (entry.reopenedAt === undefined || entry.reopenedAt === null || timestamp(entry.reopenedAt)))) return false;
    const generatedIds = [...state.tasks, ...state.events, ...state.journal, ...state.tasks.flatMap(task => task.history), ...state.tasks.map(task => task.pendingOperation).filter(Boolean)].map(item => item.id);
    if (generatedIds.some(id => /^(?:task|event|journal|complete|reopen)-\d+$/.test(id) && Number(id.slice(id.lastIndexOf('-') + 1)) >= state.nextId)) return false;
    return true;
  } catch {
    return false;
  }
}
