const sourcePolicy = {
  first: '优先用所选资料',
  only: '只用所选资料',
  open: '开放研究',
};

const workPatterns = {
  ask: '直接回答',
  goal: '追踪完成条件',
  tag: '处理标签',
};

function newRequestDraft(files = []) {
  return {
    text: '', pattern: 'ask', condition: '', taskId: null, tagTask: '查找漏标', tag: '线束设计', compareTag: '试装复核',
    scope: {files: [...files], library: false, policy: 'first'},
    memory: false, search: '关闭', model: 'GPT-6.2 Sol', skill: false,
    recipe: null, includeManual: false, fixedMethod: null,
  };
}

function resolveDraft(draft) {
  const recipe = draft.recipe;
  const includeManual = !recipe || draft.includeManual;
  const files = [...new Set([...(recipe?.files ?? []), ...(includeManual ? draft.scope.files : [])])];
  const policy = recipe?.policy ?? draft.scope.policy;
  const library = Boolean(recipe?.library || (includeManual && draft.scope.library));
  const search = policy === 'only' || draft.model === 'DeepSeek' ? '关闭' : draft.search;
  const memory = policy !== 'only' && draft.memory;
  const skills = [...new Set([...(recipe?.skills ?? []), ...(includeManual && draft.skill ? ['资料分析与核对'] : [])])];
  return {files, policy, library, search, memory, skills};
}

function prepareRequest(draft) {
  const effective = resolveDraft(draft);
  if (!draft.text.trim()) return { error: '先输入要处理的问题。', field: 'question' };
  if (effective.policy === 'only' && !effective.files.length && !effective.library) {
    return { error: '当前只用所选资料。请添加资料，或调整来源规则。', field: 'scope' };
  }
  if (draft.pattern === 'tag' && !effective.library) {
    return { error: '标签任务需要明确选择可检索资料库。核心资料不会开放整库。', field: 'scope' };
  }
  if (draft.pattern === 'tag' && draft.tagTask === '比较关系' && draft.tag === draft.compareTag) {
    return { error: '请选择两个不同的标签。', field: 'intent' };
  }
  if (draft.pattern === 'goal' && draft.model === 'DeepSeek') {
    return { error: '此模型不支持追踪完成条件，请切换模型。', field: 'execution' };
  }
  return {
    request: Object.freeze({
      ...effective, files: Object.freeze(effective.files), skills: Object.freeze(effective.skills),
      text: draft.text.trim(), pattern: draft.pattern, model: draft.model,
      condition: draft.pattern === 'goal' ? draft.condition.trim() : '',
      taskId: draft.pattern === 'goal' ? draft.taskId : null,
      tag: draft.pattern === 'tag' ? draft.tag : '',
      tagTask: draft.pattern === 'tag' ? draft.tagTask : '',
      compareTag: draft.pattern === 'tag' && draft.tagTask === '比较关系' ? draft.compareTag : '',
      method: draft.fixedMethod ?? draft.recipe?.label ?? '',
    }),
  };
}

function createTask(id, request) {
  return {id, goal: request.text, condition: request.condition, accepted: false};
}

function createTurn(id, request, taskId, result = null) {
  return {id, request, taskId, status: result ? 'complete' : 'running', step: result ? 3 : 0, result, saves: []};
}

function confirmWrite(turn, preview) {
  if (turn.status !== 'complete' || preview.turnId !== turn.id ||
      turn.saves.some(item => item.state === 'unverified')) return null;
  const receipt = {id: turn.saves.length + 1, preview, state: 'unverified'};
  turn.saves.push(receipt);
  return receipt;
}
