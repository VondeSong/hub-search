// Browser-local demonstrations. No model or task service is contacted.
export const planningInitial = () => ({runs: {}, today: [], receipts: []});
export const taskRevision = task => JSON.stringify([task.title, task.state, task.due, task.plannedDate, task.nextStep, task.waiting, task.syncStatus, task.materialIds, task.priority, task.list, task.source, task.aiNote]);

export function planningValid(plan, tasks, materials) {
  if (plan === undefined) return true; // v1 archives retain all existing tasks.
  try {
    const ids = new Set(tasks.map(task => task.id));
    const materialIds = new Set(materials.map(material => material.id));
    const modes = ['today', 'project', 'task'];
    const statuses = ['pending', 'adopted', 'dismissed', 'failed', 'unknown'];
    return plan && Array.isArray(plan.today) && new Set(plan.today).size === plan.today.length && plan.today.every(id => ids.has(id)) &&
      Array.isArray(plan.receipts) && plan.receipts.every(item => item && typeof item.message === 'string' && ids.has(item.taskId)) &&
      plan.runs && typeof plan.runs === 'object' && !Array.isArray(plan.runs) && Object.entries(plan.runs).every(([mode, run]) =>
        modes.includes(mode) && run && run.mode === mode && ['fresh', 'cached', 'partial'].includes(run.coverage) && typeof run.at === 'string' &&
        Number.isSafeInteger(run.total) && run.total >= 0 && (run.mode !== 'task' || ids.has(run.taskId)) &&
        Array.isArray(run.suggestions) && run.suggestions.every(s => ids.has(s.taskId) && ['plan', 'note', 'nextStep'].includes(s.kind) &&
          ['id', 'title', 'reason', 'text', 'revision'].every(key => typeof s[key] === 'string') && Array.isArray(s.evidence) && s.evidence.every(id=>materialIds.has(id)) && statuses.includes(s.status)));
  } catch { return false; }
}

export function reducePlanning(next, action, at) {
  const fail = error => ({...next, error});
  next.planning ??= planningInitial();
  const plan = next.planning;
  if (action.type === 'PLAN_RUN') {
    if (Object.values(plan.runs).some(run => run.suggestions.some(s => ['failed', 'unknown'].includes(s.status)))) return fail('请先处理上一次模拟保存的失败或未知结果，再重新分析。');
    const {mode, coverage = 'fresh'} = action;
    if (!['today', 'project', 'task'].includes(mode) || !['fresh', 'cached', 'partial'].includes(coverage)) return fail('请选择有效的分析入口与数据情境。');
    let tasks = next.tasks.filter(task => task.state !== 'done');
    if (mode === 'project') tasks = tasks.filter(task => task.project === action.project);
    if (mode === 'task') tasks = tasks.filter(task => task.id === action.taskId);
    const total = tasks.length;
    tasks.sort((a, b) => Number(!!b.due && b.due <= next.demoDate) - Number(!!a.due && a.due <= next.demoDate) || Number(b.priority === 'high') - Number(a.priority === 'high') || a.id.localeCompare(b.id));
    // A partial read visibly omits a source; it is never labelled a complete inventory.
    const missingSource = coverage === 'partial' ? 'feishu' : null;
    const materials = next.materials.filter(m => !missingSource || m.source !== missingSource);
    const runId = `analysis-${next.nextId++}`;
    const capacity = [60, 120, 240].includes(Number(action.capacity)) ? Number(action.capacity) : 120;
    const hardDue = tasks.filter(t => t.due && t.due <= next.demoDate);
    const available = tasks.filter(t => t.state !== 'waiting' && !hardDue.includes(t));
    const chosen = mode === 'today' ? [...hardDue, ...available.slice(0, Math.max(0, Math.floor(capacity / 30) - hardDue.length))] : tasks;
    const suggestions = chosen.map((task, index) => {
      const waiting = task.state === 'waiting';
      const kind = mode === 'today' && !waiting ? 'plan' : mode === 'task' && !waiting ? 'nextStep' : 'note';
      const evidence = materials.filter(m => task.materialIds.includes(m.id) || (mode !== 'today' && m.project === task.project)).map(m => m.id);
      const drawing = task.id === 't-harness' && evidence.includes('m-drawing');
      const text = drawing ? '对照 V3 变更通知与固定点核对方法，列出 P12 位置、卡扣方向及干涉风险；最终版本请 DRE 确认。' : waiting ? `向${task.waiting?.person || '相关负责人'}确认：${task.waiting?.reason || '当前缺少的条件'}。条件未满足前保留等待状态。` : task.nextStep || '先明确需要交付的结果，再选择可以立即开始的一步。';
      return {id: `${runId}-${index}`, taskId: task.id, kind, status: 'pending', revision: taskRevision(task), evidence,
        title: kind === 'plan' ? task.due && task.due <= next.demoDate ? '先照顾今天的截止承诺' : '建议加入今日计划' : waiting ? '先核实等待条件' : drawing ? '依据有更新，先核对版本' : '明确一个可以开始的下一步',
        reason: task.due && task.due <= next.demoDate ? '原任务已到截止日，单独列出，不会被可用时间隐藏。' : waiting ? '当前任务正在等待，不能把它当成已具备执行条件。' : drawing ? '同项目发现 V3 变更资料，原任务目前只关联了核对方法；建议核实后补充下一步。' : mode === 'today' ? `${task.priority === 'high' ? '来源标为高优先级' : '当前没有等待条件'}；先做明确的下一步。` : '根据原任务的下一步和已读取的资料整理，尚未修改原任务。', text};
    });
    plan.runs[mode] = {id: runId, mode, at, coverage, total, capacity, project: action.project || null, taskId: action.taskId || null, suggestions};
    return next;
  }
  if (action.type === 'PLAN_REMOVE') {
    plan.today = plan.today.filter(id => id !== action.taskId);
    return next;
  }
  const run = plan.runs[action.mode];
  const suggestion = run?.suggestions.find(item => item.id === action.id);
  if (!suggestion) return fail('这条建议已更新，请重新查看。');
  if (action.type === 'PLAN_DISMISS') {
    if (suggestion.status !== 'pending') return fail('这条建议已有处理结果。');
    suggestion.status = 'dismissed';
    return next;
  }
  const task = next.tasks.find(item => item.id === suggestion.taskId);
  if (suggestion.status === 'adopted') return next;
  if (action.type === 'PLAN_RECONCILE' && suggestion.status === 'unknown') {
    suggestion.status = 'dismissed';
    plan.receipts.unshift({id: `adoption-${next.nextId++}`, taskId: task.id, at, message: '演示核对：来源尚未修改；旧操作已结束，可重新分析后采用。本次没有重新提交。'});
    return next;
  }
  if (taskRevision(task) !== suggestion.revision) return fail('原任务已变化，请重新分析后再采用。');
  if (task.state === 'done' || ['pending', 'failed'].includes(task.syncStatus)) return fail('请先处理原任务的完成状态，再重新分析。');
  const receipt = message => plan.receipts.unshift({id: `adoption-${next.nextId++}`, taskId: task.id, at, message});
  if (action.type === 'PLAN_ADOPT') {
    if (suggestion.status !== 'pending') return fail('请先核对上一次操作结果。');
    if (suggestion.kind === 'plan') {
      if (!plan.today.includes(task.id)) plan.today.push(task.id);
      receipt('已加入 Hub 今日计划：仅引用原任务，来源日期与清单保持原样。');
    } else if (suggestion.kind === 'note') {
      task.aiNote = `【AI 演示建议，待人工核对】\n${suggestion.text}`;
      receipt('建议已保留到这条任务的 Hub 助手笔记；未改变来源任务。');
    } else {
      if (run.coverage === 'cached') return fail('当前使用旧缓存，请切换为完整示例数据并重新分析，再修改来源。');
      if (action.outcome === 'failure') {suggestion.status = 'failed'; return next;}
      if (action.outcome === 'unknown') {suggestion.status = 'unknown'; return next;}
      if (action.outcome !== 'success') return fail('请先预览并确认模拟来源修改。');
      task.nextStep = suggestion.text;
      receipt('演示：来源下一步已确认更新；原任务 ID、清单、截止日和完成状态保留。');
    }
    suggestion.status = 'adopted';
    return next;
  }
  if (action.type === 'PLAN_RETRY' && suggestion.status === 'failed') {
    suggestion.status = 'pending';
    return reducePlanning(next, {...action, type: 'PLAN_ADOPT', outcome: 'success'}, at);
  }
  return fail('当前状态不支持这项操作。');
}
