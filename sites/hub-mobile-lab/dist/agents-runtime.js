'use strict';

// Local interaction model for Issue #32. No network, model or credential calls.
// Request identity and server/client phases remain distinct to make recovery reviewable.
const AGENT_MODEL = 'gpt-6.1-sol';
const AGENT_ACTIVE_PHASES = ['queued', 'accepted', 'running', 'stop_pending', 'unknown'];
let agentRuntimeTimer = null;
let agentRuntimeStoragePaused = false;

function agentId(prefix) { return prefix + '-' + crypto.randomUUID(); }
function agentDocMaterial(docId) {
  const doc = docs[docId];
  const note = st.notes?.find(item => item.id === docId);
  if (!doc && !note) return null;
  return { id: 'doc-' + docId, kind: 'doc', docId, name: doc?.t || note?.title || '本地记录',
    source: doc?.s || '本地记录', date: doc?.date || note?.date || '', text: doc?.body || note?.text || '', demo: Boolean(doc) };
}
function agentSeedState() {
  const now = Date.now();
  const definitions = [
    { id: 'ag-seed-harness', title: '线束固定点，先核对什么', ago: 18 * 60000,
      prompt: '准备核对一处车门线束固定点，先帮我整理检查思路。',
      answer: '先把判断需要的材料准备齐，再决定这个固定点是否合适。\n\n1. 对照当前版本图纸，确认固定点的位置、卡扣型号和装配方向。\n2. 补一张近景与一张周边空间照片，让相邻零件、活动区域和走线关系可见。\n3. 把已经确认的事实、仍待测量的项目分开记录，再由项目规范和实测结果判断。\n\n这是一份示例检查提纲。当前没有上传现场照片，也没有读取你的工程资料，不能据此判定零件合格。', citations: [] },
    { id: 'ag-seed-reading', title: '让摘录在下次用得上', ago: 70 * 60000, docIds: ['d3'],
      prompt: '根据这篇阅读笔记，给我一个今天就能试的小动作。',
      answer: '先给一条摘录补上一句：它与我现在的问题有什么关系。\n\n示例笔记强调，重新打开时需要能找回当时的上下文，而不只是看到一个收藏链接。可以依次留下三个很短的部分：原文摘录、当前问题、一个使用场景。\n\n今天只处理一条就够了。回看时再补充想法的变化，保留前后的思路。', citations: ['d3'] },
    { id: 'ag-seed-validation', title: '把实机验证拆成下一步', ago: 26 * 3600000, docIds: ['d5', 'd7'],
      prompt: '原型核对完成后，实机验证该从哪里开始？',
      answer: '目前能确认的是纸面原型已核对，实机验证还没有开始。\n\n先选两条能定位出处的示例资料，分别记录预期结果与实际结果。第一轮只检查三件事：引用能否定位、手机返回是否保留上下文、断线后能否恢复同一结果。\n\n把问题和复现步骤记下来，再决定下一轮范围。完成纸面核对不能替代实机验收。', citations: ['d5', 'd7'] }
  ];
  const threads = [], runs = {};
  for (const item of definitions) {
    const at = now - item.ago, runId = 'run-' + item.id;
    const materials = (item.docIds || []).map(agentDocMaterial).filter(Boolean);
    const userMessageId = 'user-' + item.id, messageId = 'assistant-' + item.id;
    threads.push({ id: item.id, title: item.title, model: AGENT_MODEL, createdAt: at, updatedAt: at + 8800,
      draft: '', attachments: [], materials, activeRunId: null, view: 'chat', origin: 'cloud',
      messages: [{ id: userMessageId, role: 'user', text: item.prompt, at, attachments: structuredClone(materials) },
        { id: messageId, role: 'assistant', text: item.answer, at: at + 8800, attachments: [], runId, citations: item.citations, demo: true }] });
    runs[runId] = { id: runId, requestId: 'request-' + item.id, threadId: item.id, phase: 'completed', serverPhase: 'completed',
      prompt: item.prompt, text: item.answer, answer: item.answer, citations: item.citations, error: null, errorCode: null,
      createdAt: at, acceptedAt: at + 200, startedAt: at + 850, finishedAt: at + 8800, completeAt: at + 8800,
      messageId, userMessageId, stopRequestedAt: null, stopSentAt: null, resultNoteId: null, launchCount: 1, demo: true };
  }
  return { version: 1, threads, runs,
    connection: { network: 'online', server: 'online', auth: 'valid', quota: 'unknown', device: 'active', windows: 'offline' },
    model: AGENT_MODEL, accountType: 'ChatGPT', plan: '订阅登录 · 示例', lastRecoveredAt: null };
}
function initAgents() {
  if (!st.agents || st.agents.version !== 1 || !Array.isArray(st.agents.threads) || !st.agents.runs) {
    st.agents = agentSeedState();
    return st.agents;
  }
  const state = st.agents;
  state.connection = { network: 'online', server: 'online', auth: 'valid', quota: 'unknown', device: 'active', windows: 'offline', ...state.connection };
  const choices = { network: ['online', 'offline'], server: ['online', 'offline'], auth: ['valid', 'expired'],
    quota: ['unknown', 'available', 'exhausted'], device: ['active', 'revoked'], windows: ['online', 'offline'] };
  for (const [key, values] of Object.entries(choices)) if (!values.includes(state.connection[key])) state.connection[key] = values[0];
  for (const thread of state.threads) {
    thread.draft = typeof thread.draft === 'string' ? thread.draft : '';
    thread.attachments = Array.isArray(thread.attachments) ? thread.attachments : [];
    thread.materials = Array.isArray(thread.materials) ? thread.materials : [];
    thread.messages = Array.isArray(thread.messages) ? thread.messages : [];
    thread.model = AGENT_MODEL;
    if (thread.activeRunId && !state.runs[thread.activeRunId]) thread.activeRunId = null;
  }
  return state;
}
function agentState() { return st.agents || initAgents(); }
function agentThread(id) { return agentState().threads.find(thread => thread.id === id); }
function agentLastRun(thread) {
  if (typeof thread === 'string') thread = agentThread(thread);
  if (!thread) return null;
  if (thread.activeRunId && agentState().runs[thread.activeRunId]) return agentState().runs[thread.activeRunId];
  const message = [...thread.messages].reverse().find(item => item.runId);
  return message ? agentState().runs[message.runId] || null : null;
}
function agentConnectionReady() {
  const c = agentState().connection;
  return c.network === 'online' && c.server === 'online' && c.auth === 'valid' && c.device === 'active';
}
function agentPhaseLabel(run) {
  if (typeof run === 'string') return ({ queued: '待发送', accepted: '云端已接收', running: '正在回复', completed: '已完成', failed: '未能开始', stopped: '已停止', stop_pending: '停止待确认', unknown: '等待恢复连接' })[run] || run;
  if (!run) return '尚未发送';
  if (run.phase === 'stop_pending') return run.stopSentAt ? '停止待确认' : '停止待送达';
  return agentPhaseLabel(run.phase);
}
function agentEmit() { dispatchEvent(new CustomEvent('hub-agent-update')); }
function agentFailure(error, code = 'error') { return { ok: false, error, code }; }
function agentTransaction(change, options = {}) {
  const prior = structuredClone(agentState());
  const notes = options.notes ? structuredClone(st.notes) : null;
  const result = change() || { ok: true };
  if (result.ok === false) { st.agents = prior; if (notes) st.notes = notes; return result; }
  if (save() === false) {
    st.agents = prior;
    if (notes) st.notes = notes;
    agentRuntimeStoragePaused = true;
    clearTimeout(agentRuntimeTimer); agentRuntimeTimer = null;
    return agentFailure('浏览器暂时无法保存，原内容已保留。请重试。', 'storage');
  }
  agentRuntimeStoragePaused = false;
  agentEmit(); agentSchedule();
  return result;
}
function agentCreateThread(context = {}) {
  if (typeof context === 'string') context = { docId: context };
  if (agentState().connection.device === 'revoked') return agentFailure('此设备的访问已撤销。', 'revoked');
  return agentTransaction(() => {
    const docIds = [...new Set([...(Array.isArray(context.docIds) ? context.docIds : []), ...(context.docId ? [context.docId] : [])])];
    const materials = docIds.map(agentDocMaterial).filter(Boolean);
    const now = Date.now(), id = agentId('thread');
    const attachments = [...(Array.isArray(context.attachments) ? context.attachments : []), ...materials];
    agentState().threads.unshift({ id, title: context.title || (materials.length ? '关于 ' + materials[0].name : '新对话'), model: AGENT_MODEL,
      createdAt: now, updatedAt: now, messages: [], draft: context.prompt || context.draft || '', attachments, materials: [],
      activeRunId: null, view: 'chat', origin: 'mobile' });
    return { ok: true, threadId: id };
  });
}
function agentDemoAnswer(thread, prompt, attachments) {
  const suppliedDocs = [...new Set([...thread.materials, ...attachments].filter(item => item.kind === 'doc').map(item => item.docId))];
  const photo = attachments.some(item => item.kind === 'image' && !item.demo);
  const frames = attachments.filter(item => item.kind === 'frame');
  if (photo) return { text: '图片已放入这条对话。当前是交互原型，还没有调用模型识别你选择的图片。\n\n正式接入后，可以先结合这轮问题描述看得见的细节，再把需要更多照片、尺寸或资料才能判断的部分单独列出。不会把看不清的地方当作确定事实。\n\n你可以继续追问、停止这轮演示，或到“材料”查看已选图片。', citations: [] };
  if (frames.length) return { text: '这里分析的是关键帧示例，而不是完整视频。\n\n已选时间点：' + frames.map(item => typeof item.time === 'number' ? item.time + ' 秒' : item.time || item.timestamp || '未标注').join('、') + '。本轮 ' + frames.length + ' 张示例帧依次呈现' + frames.map(item => ({ red: '红色', green: '绿色', blue: '蓝色' })[item.color] || '示例').join('、') + '画面。\n\n这些帧不能说明两个时间点之间发生了什么。短暂动作可能完全落在采样间隔里，因此不能把“帧里没看到”写成“视频里没有发生”。\n\n需要检查细节时，应补充对应时间附近的帧；声音也没有进入本次材料。', citations: [] };
  if (suppliedDocs.includes('d5') || suppliedDocs.includes('d7')) return { text: '可以先做一轮范围很小的实机核对。\n\n示例项目回顾只确认了纸面原型已完成，实机验证仍待进行。建议先选择两条有明确出处的资料，分别走完“查找—打开—返回”和“发送—断线—恢复”。\n\n每一步留下预期、实际结果和复现条件。只有实际验证通过的项目才标为完成，资料不足的部分继续保留待核对。\n\n这条演示只使用当前对话中选定的示例材料，没有访问桌面私有资料库。', citations: suppliedDocs.filter(id => ['d5', 'd7'].includes(id)) };
  if (suppliedDocs.includes('d3')) return { text: '先把这篇笔记里的方法缩成一个很小的动作：为一条摘录写下“它与我当前的问题有什么关系”。\n\n保留原文和出处，再补一行自己的理解。下次回看时，先读这句话，能更快找回当时为什么留下它。\n\n如果你是在追问上一轮，就继续沿用这条对话里已经选择的材料；不需要重新上传整份资料库。\n\n这是根据所选示例笔记组织的演示回复。', citations: ['d3'] };
  if (/线束|卡扣|固定点|CATIA/i.test(prompt) || thread.id === 'ag-seed-harness') return { text: '可以先把要核对的内容整理成一个短清单。\n\n① 资料版本：确认图纸和现场零件是否对应同一版本。\n② 位置与环境：准备固定点近景、周边空间和装配方向的材料。\n③ 待确认项：把尺寸、干涉或活动范围中尚未实测的部分单列出来。\n\n当前是示例回复，并没有分析现场照片或读取工程资料，不能作出合格判定。你可以为下一轮明确选择一张图片或一段资料。', citations: [] };
  const followup = thread.messages.filter(item => item.role === 'user').length > 0;
  return { text: (followup ? '这轮会接着同一条对话继续，已经选择的材料会保留。' : '可以先把问题落到一个容易核对的下一步。') + '\n\n先区分：目前已知什么、还缺什么依据、下一步要确认什么。需要资料时，只加入与你这轮问题有关的笔记或图片。\n\n你可以在回复过程中停止，也可以离开页面。演示会保存这次请求的身份，恢复时回到同一条结果，不重复建立一轮。\n\n这是用于体验交互的固定示例回复，没有调用模型分析你的实际输入。', citations: [] };
}
function agentAccept(run, now) {
  if (run.acceptedAt) return;
  run.acceptedAt = now;
  run.startedAt = now + 700;
  run.completeAt = now + 8800;
  run.launchCount = 1;
  run.serverPhase = 'accepted';
  run.phase = 'accepted';
  run.error = null; run.errorCode = null;
}
function agentAttempt(run, now) {
  const c = agentState().connection;
  if (c.device === 'revoked') { run.phase = 'failed'; run.errorCode = 'revoked'; run.error = '此设备的访问已撤销。'; return; }
  if (c.auth !== 'valid') { run.phase = 'failed'; run.errorCode = 'auth'; run.error = '执行端的 ChatGPT 登录已失效，请恢复登录后重试。'; return; }
  if (c.quota === 'exhausted') { run.phase = 'failed'; run.errorCode = 'quota'; run.error = '订阅额度暂不可用。本次没有启动生成，也不会自动切换账号或按量 API。'; return; }
  if (c.network !== 'online' || c.server !== 'online') { run.phase = 'queued'; run.errorCode = null; run.error = null; return; }
  agentAccept(run, now);
}
function agentSend(threadId) {
  const thread = agentThread(threadId);
  if (!thread) return agentFailure('找不到这条对话。', 'missing');
  const active = thread.activeRunId && agentState().runs[thread.activeRunId];
  if (active && AGENT_ACTIVE_PHASES.includes(active.phase)) {
    if (!thread.draft.trim() && !thread.attachments.length) return { ok: true, reused: true, threadId, runId: active.id };
    return agentFailure('这轮还在进行。输入会保留，完成或停止后再发送。', 'busy');
  }
  const text = thread.draft.trim(), attachments = structuredClone(thread.attachments);
  if (!text && !attachments.length) return agentFailure('先写一点内容，或选择一份材料。', 'empty');
  return agentTransaction(() => {
    const now = Date.now(), runId = agentId('run'), userMessageId = agentId('message'), messageId = agentId('message');
    const reply = agentDemoAnswer(thread, text, attachments);
    const run = { id: runId, requestId: agentId('request'), threadId, phase: 'queued', serverPhase: null,
      prompt: text, text: '', answer: reply.text, citations: reply.citations, attachments,
      error: null, errorCode: null, createdAt: now, acceptedAt: null, startedAt: null, finishedAt: null, completeAt: null,
      stopRequestedAt: null, stopSentAt: null, messageId, userMessageId, resultNoteId: null, launchCount: 0, demo: true };
    agentState().runs[runId] = run;
    thread.messages.push({ id: userMessageId, role: 'user', text: text || '请查看本轮选择的材料。', at: now, attachments, runId });
    thread.messages.push({ id: messageId, role: 'assistant', text: '', at: now, attachments: [], runId, citations: reply.citations, demo: true });
    for (const item of attachments) if (!thread.materials.some(material => material.id === item.id)) thread.materials.push(structuredClone(item));
    if (thread.title === '新对话') thread.title = (text || attachments[0]?.name || '材料问答').replace(/\s+/g, ' ').slice(0, 25);
    thread.draft = ''; thread.attachments = []; thread.activeRunId = runId; thread.updatedAt = now;
    agentAttempt(run, now);
    return { ok: true, threadId, runId, phase: run.phase };
  });
}
function agentSyncRun(run, now) {
  if (!run.acceptedAt || ['completed', 'stopped'].includes(run.phase)) return false;
  const before = JSON.stringify([run.phase, run.text, run.stopSentAt, run.finishedAt]);
  if (!agentConnectionReady()) {
    if (run.phase !== 'stop_pending') run.phase = 'unknown';
    return before !== JSON.stringify([run.phase, run.text, run.stopSentAt, run.finishedAt]);
  }
  if (run.stopRequestedAt && !run.stopSentAt && now < run.completeAt) run.stopSentAt = now;
  const stopAt = run.stopSentAt ? run.stopSentAt + 600 : Infinity;
  const finalAt = Math.min(run.completeAt, stopAt);
  const stopped = stopAt < run.completeAt;
  const observedAt = Math.min(now, finalAt);
  const fraction = Math.max(0, Math.min(1, (observedAt - run.startedAt) / (run.completeAt - run.startedAt)));
  run.text = run.answer.slice(0, Math.floor(run.answer.length * fraction));
  if (now >= finalAt) {
    run.phase = stopped ? 'stopped' : 'completed';
    run.serverPhase = run.phase;
    run.finishedAt = finalAt;
    if (!stopped) run.text = run.answer;
  } else if (run.stopRequestedAt) { run.phase = 'stop_pending'; run.serverPhase = now < run.startedAt ? 'accepted' : 'running'; }
  else { run.phase = now < run.startedAt ? 'accepted' : 'running'; run.serverPhase = run.phase; }
  const thread = agentThread(run.threadId);
  const message = thread?.messages.find(item => item.id === run.messageId);
  if (message) message.text = run.text;
  if (['completed', 'stopped'].includes(run.phase) && thread) { thread.activeRunId = null; thread.updatedAt = run.finishedAt; }
  return before !== JSON.stringify([run.phase, run.text, run.stopSentAt, run.finishedAt]);
}
function agentTick() {
  agentRuntimeTimer = null;
  if (agentRuntimeStoragePaused || !agentConnectionReady()) return;
  const prior = structuredClone(agentState());
  let changed = false;
  for (const run of Object.values(agentState().runs)) if (run.acceptedAt && AGENT_ACTIVE_PHASES.includes(run.phase)) changed = agentSyncRun(run, Date.now()) || changed;
  if (changed) {
    if (save() === false) { st.agents = prior; agentRuntimeStoragePaused = true; agentEmit(); return; }
    agentEmit();
  }
  agentSchedule();
}
function agentSchedule() {
  clearTimeout(agentRuntimeTimer); agentRuntimeTimer = null;
  if (agentRuntimeStoragePaused || !agentConnectionReady()) return;
  if (Object.values(agentState().runs).some(run => run.acceptedAt && AGENT_ACTIVE_PHASES.includes(run.phase))) agentRuntimeTimer = setTimeout(agentTick, 350);
}
function resumeAgents() { agentRuntimeStoragePaused = false; agentRecover(); }
function agentRecover() {
  if (!agentConnectionReady()) { agentSchedule(); return agentFailure('连接尚未恢复，已收到的内容仍保留在本机。', 'offline'); }
  return agentTransaction(() => {
    const now = Date.now();
    for (const run of Object.values(agentState().runs)) if (run.acceptedAt && AGENT_ACTIVE_PHASES.includes(run.phase)) agentSyncRun(run, now);
    agentState().lastRecoveredAt = now;
    return { ok: true, recovered: true };
  });
}
function agentRetry(runId) {
  const run = agentState().runs[runId];
  if (!run) return agentFailure('找不到这次请求。', 'missing');
  if (run.acceptedAt) { const result = agentRecover(); return { ...result, runId, threadId: run.threadId, reused: true }; }
  const thread = agentThread(run.threadId);
  const other = thread?.activeRunId && agentState().runs[thread.activeRunId];
  if (other && other.id !== runId && AGENT_ACTIVE_PHASES.includes(other.phase)) return agentFailure('这条对话已有另一轮正在进行，请先完成或停止。', 'busy');
  if (run.phase === 'stopped') return agentFailure('这条本地请求已经撤销。请在输入栏开始新的一轮。', 'cancelled');
  return agentTransaction(() => {
    agentAttempt(run, Date.now());
    if (thread) thread.activeRunId = run.id;
    return { ok: true, runId, threadId: run.threadId, phase: run.phase, reused: true };
  });
}
function agentStop(runId) {
  const run = agentState().runs[runId];
  if (!run) return agentFailure('找不到这次请求。', 'missing');
  if (['completed', 'stopped', 'failed'].includes(run.phase)) return { ok: true, runId, reused: true, phase: run.phase };
  return agentTransaction(() => {
    const now = Date.now();
    if (!run.acceptedAt) {
      run.phase = 'stopped'; run.serverPhase = null; run.finishedAt = now; run.cancelledBeforeSend = true;
      const thread = agentThread(run.threadId); if (thread) thread.activeRunId = null;
    } else {
      if (agentConnectionReady()) agentSyncRun(run, now);
      if (!['completed', 'stopped'].includes(run.phase)) { run.stopRequestedAt ||= now; if (agentConnectionReady()) run.stopSentAt ||= now; run.phase = 'stop_pending'; }
    }
    return { ok: true, runId, phase: run.phase };
  });
}
function agentSetConnection(key, value) {
  const values = { network: ['online', 'offline'], server: ['online', 'offline'], auth: ['valid', 'expired'],
    quota: ['unknown', 'available', 'exhausted'], device: ['active', 'revoked'], windows: ['online', 'offline'] };
  if (!values[key]?.includes(value)) return agentFailure('不支持这个演示状态。', 'invalid');
  return agentTransaction(() => {
    agentState().connection[key] = value;
    const now = Date.now();
    for (const run of Object.values(agentState().runs)) if (run.acceptedAt && AGENT_ACTIVE_PHASES.includes(run.phase)) agentSyncRun(run, now);
    if (agentConnectionReady()) agentState().lastRecoveredAt = now;
    return { ok: true, key, value };
  });
}
function agentSaveResult(runId) {
  const run = agentState().runs[runId], thread = run && agentThread(run.threadId);
  if (!run || !thread) return agentFailure('找不到这份成果。', 'missing');
  if (agentState().connection.device === 'revoked') return agentFailure('此设备的访问已撤销，不能读取或保存云端成果。', 'revoked');
  if (run.resultNoteId && st.notes.some(note => note.id === run.resultNoteId)) return { ok: true, noteId: run.resultNoteId, reused: true };
  if (run.phase !== 'completed') return agentFailure('这轮尚未完成。已收到的文字会继续保留在对话里。', 'incomplete');
  return agentTransaction(() => {
    const now = Date.now(), id = agentId('agent-note');
    const sources = run.citations.map(docId => docs[docId]).filter(Boolean).map(doc => doc.s + ' · ' + doc.t);
    st.notes.unshift({ id, kind: 'note', title: thread.title, text: 'Agents 示例成果\n\n' + run.answer +
      (sources.length ? '\n\n所选资料：\n' + sources.join('\n') : '') + '\n\n此内容来自手机交互原型，没有调用真实模型。',
      date: new Date(now).toLocaleDateString('zh-CN'), createdAt: now, agentRunId: run.id });
    run.resultNoteId = id;
    return { ok: true, noteId: id, runId };
  }, { notes: true });
}
