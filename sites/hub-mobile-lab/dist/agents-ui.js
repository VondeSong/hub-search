'use strict';

// The Agents prototype renders only local demo state. No model or host is contacted.
let agentListQuery = '';
let agentListScope = 'active';
let agentMaterialPicker = null;
let agentPairingDraft = null;
let agentComposerObserver = null;
let agentComposerObserved = null;
let agentLastVisibleThread = null;
let agentLastAnnouncement = '';
let agentAttachmentReading = false;

function agentUiConnection() { return st.agents.connection; }
function agentUiRun(thread) { return thread?.activeRunId ? st.agents.runs[thread.activeRunId] : agentLastRun(thread); }
function agentUiRunning(run) { return run && ['queued', 'accepted', 'running', 'unknown', 'stop_pending'].includes(run.phase); }
function agentUiRevoked() { return agentUiConnection().device === 'revoked'; }
function agentUiConnectionLabel() {
  const c = agentUiConnection();
  if (c.device === 'revoked') return '此设备访问已撤销';
  if (c.network === 'offline') return '手机离线';
  if (c.server === 'offline') return '云端暂不可达';
  if (c.auth === 'expired') return '订阅登录已失效';
  if (c.quota === 'exhausted') return '订阅额度不足';
  return '个人云端 · 演示在线';
}
function agentUiStamp(at) {
  if (!at) return '';
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString('zh-CN', today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric' });
}
function agentUiActionButton(label, action, className, iconName, disabled = false) {
  return '<button type="button" class="' + className + '" data-act="' + esc(action) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '" ' + (disabled ? 'disabled' : '') + '>' + (iconName ? ico(iconName, 20) : '') + '<span>' + esc(label) + '</span></button>';
}
function agentUiFeedback(result, success) {
  if (!result?.ok) { tell(result?.error || '操作暂未完成，请保留当前页面后重试。'); return false; }
  if (success) tell(success);
  return true;
}
function agentUiAccessBlock() {
  return '<section class="agent-access-block"><span class="tile">' + ico('info', 26) + '</span><h2>这台手机已失去访问权限</h2><p>云端会话暂不可查看，也不会继续发送。重新配对后，再回到原来的会话。</p>' + btn('查看连接与设备', 'go:agent-connection', 'secondary') + '<p class="agent-demo-note">交互演示 · 未连接真实服务</p></section>';
}
function agentUiConnectionCard() {
  const c = agentUiConnection(), warning = c.network !== 'online' || c.server !== 'online' || c.auth !== 'valid' || c.quota === 'exhausted' || c.device !== 'active';
  return '<button type="button" class="agent-connection-card' + (warning ? ' is-warning' : '') + '" data-act="go:agent-connection"><span class="agent-status-dot" aria-hidden="true"></span><span class="agent-connection-copy"><strong>' + esc(agentUiConnectionLabel()) + '</strong><small>' + (warning ? '查看状态与恢复方式' : 'ChatGPT 订阅 · Windows 可关机') + '</small></span>' + ico('chev', 17) + '</button>';
}
function agentThreadRows() {
  const threads = [...st.agents.threads].sort((a, b) => b.updatedAt - a.updatedAt).filter(thread =>
    (agentListScope === 'all' || Boolean(thread.archivedAt) === (agentListScope === 'archived')) &&
    (thread.title + ' ' + thread.messages.map(m => m.text || '').join(' ')).toLowerCase().includes(agentListQuery.toLowerCase()));
  if (!threads.length) return '<div class="empty-state">' + ico('chat', 28) + '<h2>' + (agentListScope === 'archived' && !agentListQuery ? '还没有归档会话' : '没有找到这段对话') + '</h2><p>' + (agentListScope === 'archived' ? '归档只收起会话，不删除消息或材料。' : '换一个词，或切换到“全部”查找归档会话。') + '</p>' + (agentListScope !== 'all' ? plain('查看全部会话', 'agent-list-scope:all', 'search') : btn('新建对话', 'agent-new', 'secondary', 'plus')) + '</div>';
  return threads.map(thread => {
    const last = thread.messages.at(-1), run = agentUiRun(thread);
    const preview = agentUiRunning(run) ? agentPhaseLabel(run) : (last?.text || thread.draft || (thread.attachments.length ? '已选好材料，写下你的问题。' : '从一个问题开始。'));
    return '<button type="button" class="agent-thread-row" data-act="go:agent-chat/' + esc(thread.id) + '"><span class="agent-thread-icon">' + ico(thread.id.includes('harness') ? 'folder' : thread.id.includes('reading') ? 'book' : 'chat', 20) + '</span><span class="agent-thread-copy"><strong>' + esc(thread.title) + '</strong><small>' + esc(preview.replace(/\s+/g, ' ').slice(0, 58)) + '</small></span><span class="agent-thread-meta"><time>' + esc(agentUiStamp(thread.updatedAt)) + '</time>' + (thread.archivedAt ? '<span class="agent-phase">已归档</span>' : agentUiRunning(run) ? '<span class="agent-phase">' + esc(agentPhaseLabel(run)) + '</span>' : ico('chev', 15)) + '</span></button>';
  }).join('');
}
function agentUiListScopes() {
  const archived = st.agents.threads.filter(t => t.archivedAt).length;
  return [['active', '当前', st.agents.threads.length - archived], ['archived', '已归档', archived], ['all', '全部', st.agents.threads.length]]
    .map(([id, label, count]) => chip(label + ' ' + count, 'agent-list-scope:' + id, agentListScope === id)).join('');
}
function agentsPage() {
  if (agentUiRevoked()) return '<div class="agents-page">' + intro('Agents', '你的云端对话') + agentUiAccessBlock() + '</div>';
  return '<div class="agents-page"><div class="agents-heading"><h1>Agents</h1><span class="fine">交互原型</span></div><p class="lede">在手机上开始，随时接着聊。</p><div id="agent-list-connection">' + agentUiConnectionCard() + '</div><p class="agent-demo-note">交互演示 · 对话与附件保存在当前浏览器</p><div class="agent-list-search">' + ico('search', 19) + '<input type="search" id="agent-list-query" aria-label="搜索会话标题与消息" placeholder="搜索标题或消息" value="' + esc(agentListQuery) + '"></div><div class="filter" id="agent-list-scopes" aria-label="会话范围">' + agentUiListScopes() + '</div>' + section('会话', '<div id="agent-thread-list">' + agentThreadRows() + '</div>', plain('新对话', 'agent-new', 'plus')) + '<p class="settings-note">这里展示新建云端会话的使用方式。已有桌面聊天和资料库不会自动迁入。归档会话可在“已归档”或“全部”中搜索、查看与恢复。</p></div>';
}
function agentsHeader(page, id) {
  if (page === 'agent-chat') {
    const thread = agentThread(id);
    return iconBtn('返回', 'back', 'back') + '<button type="button" class="agent-header-main" data-act="go:agent-connection" aria-label="查看云端连接与设备"><span class="agent-header-title">' + esc(agentUiRevoked() ? 'Agents' : thread?.title || '对话') + '</span><span class="agent-header-subtitle">交互演示 · ' + esc(agentUiConnectionLabel()) + '</span></button>' + iconBtn('会话选项', 'agent-thread-menu:' + id, 'more');
  }
  if (page === 'agent-connection') return iconBtn('返回', 'back', 'back') + '<span class="top-title">连接与设备</span><span class="agent-header-spacer" aria-hidden="true"></span>';
  return '<span class="brand"><img src="hub.svg" alt="">Hub <span class="sample-label">示例资料</span></span><div class="top-actions">' + iconBtn('外观与设置', 'go:settings', 'settings') + iconBtn('新建对话', 'agent-new', 'plus') + '</div>';
}
function agentUiBanner(thread) {
  const c = agentUiConnection(), run = agentUiRun(thread);
  const archive = thread.archivedAt ? '<div class="agent-banner"><strong>这段会话已归档</strong><p>消息、材料和成果均保留。恢复后可继续提问。</p>' + plain('恢复会话', 'agent-restore:' + thread.id, 'sync') + '</div>' : '';
  let title = '', copy = '', action = '';
  if (c.network === 'offline') { title = '手机离线'; copy = run?.phase === 'queued' ? '这条消息仅暂存在本机，还没有送达云端。' : '保留已收到的内容。已接收的任务不会因断网自动停止。'; action = plain('恢复演示网络', 'agent-connection:network:online', 'sync'); }
  else if (c.server === 'offline') { title = '暂时连不上个人云端'; copy = '执行结果尚未确认。恢复后查询原请求，不会再次发起生成。'; action = plain('恢复演示服务', 'agent-connection:server:online', 'sync'); }
  else if (c.auth === 'expired') { title = 'ChatGPT 登录已失效'; copy = '新消息尚未执行。请在执行端重新登录，再继续原请求。'; action = plain('查看登录恢复', 'agent-login-help', 'link'); }
  else if (c.quota === 'exhausted') { title = '订阅额度不足'; copy = '新消息尚未执行。不会切换其他账号或启用按量 API。'; action = plain('查看额度', 'agent-quota', 'info'); }
  else if (run?.phase === 'unknown') { title = '正在确认原请求'; copy = '恢复连接后补齐同一次运行的结果。'; action = plain('查询原结果', 'agent-recover', 'sync'); }
  if (!title) return archive + '<p class="agent-demo-note">交互演示 · 固定示例回复 · 仅保留本次对话与选定材料</p>';
  return archive + '<div class="agent-banner is-warning"><strong>' + title + '</strong><p>' + copy + '</p>' + action + '</div>';
}
function agentUiText(text) {
  return String(text || '').split(/\n\s*\n/).filter(Boolean).map(paragraph => {
    if (/^#{1,3}\s/.test(paragraph)) return '<h3>' + esc(paragraph.replace(/^#{1,3}\s/, '')) + '</h3>';
    return '<p>' + esc(paragraph).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>') + '</p>';
  }).join('');
}
function agentUiAttachmentLabel(a) { return a.name || (a.docId && docs[a.docId]?.t) || '选定材料'; }
function agentUiAttachment(a, threadId, removable = false) {
  const isImage = ['image', 'frame'].includes(a.kind);
  const safeImage = /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(a.dataUrl || '');
  const thumb = a.kind === 'frame' ? '<span class="agent-frame" data-frame="' + esc(a.color || ['red', 'green', 'blue'][Number(a.time) % 3] || 'red') + '"><small>' + esc(a.time ?? 0) + 's</small></span>' : safeImage ? '<img class="agent-attachment-image" src="' + esc(a.dataUrl) + '" alt="' + esc(agentUiAttachmentLabel(a)) + '">' : '<span class="tile">' + ico(isImage ? 'image' : 'note', 18) + '</span>';
  return '<div class="agent-attachment' + (isImage ? ' is-image' : '') + '"><button type="button" class="agent-attachment-open" data-act="agent-material:' + esc(threadId) + ':' + esc(a.id) + '">' + thumb + '<span class="agent-attachment-copy"><strong>' + esc(agentUiAttachmentLabel(a)) + '</strong><small>' + (a.kind === 'frame' ? '关键帧示例' : a.kind === 'image' ? '图片 · 仅本机预览' : '已选资料') + '</small></span></button>' + (removable ? '<button type="button" class="agent-remove-attachment" data-act="agent-remove:' + esc(threadId) + ':' + esc(a.id) + '" aria-label="移除 ' + esc(agentUiAttachmentLabel(a)) + '">' + ico('close', 15) + '</button>' : '') + '</div>';
}
function agentUiAttachments(items, threadId, removable = false) { return items?.length ? '<div class="agent-attachments">' + items.map(a => agentUiAttachment(a, threadId, removable)).join('') + '</div>' : ''; }
function agentUiReceipt(run) {
  if (!run) return '';
  let copy = '', action = '';
  switch (run.phase) {
    case 'queued': copy = '已暂存本机 · 尚未送达云端'; action = plain('发送这条', 'agent-retry:' + run.id, 'sync') + plain('撤回暂存', 'agent-stop:' + run.id, 'close'); break;
    case 'accepted': copy = '云端已接收，正在准备回复'; break;
    case 'running': copy = '正在回复'; break;
    case 'unknown': copy = '连接中断 · 运行结果待确认'; action = plain('查询原结果', 'agent-recover', 'sync'); break;
    case 'stop_pending': copy = run.stopSentAt ? '停止已送达，等待确认' : '停止请求待送达，云端可能仍在运行'; break;
    case 'stopped': copy = run.cancelledBeforeSend ? '已撤销 · 未发送到云端' : '已停止 · 保留已收到的部分'; break;
    case 'failed': copy = run.error || '本次请求未能完成'; action = plain('重试原请求', 'agent-retry:' + run.id, 'sync'); break;
    case 'completed': copy = '已完成'; break;
  }
  return '<span class="agent-run-label' + (['failed', 'unknown', 'queued', 'stop_pending'].includes(run.phase) ? ' is-warning' : '') + '">' + esc(copy) + '</span>' + action;
}
function agentUiProcess(run) {
  if (!run) return '';
  return '<details class="agent-process" data-agent-process="' + esc(run.id) + '"><summary>运行过程 <span>' + esc(agentPhaseLabel(run)) + '</span></summary><dl><div><dt>执行位置</dt><dd>个人云端 · VPS</dd></div><div><dt>模型</dt><dd>gpt-6.1-sol</dd></div><div><dt>输入范围</dt><dd>本次对话与明确选定的材料</dd></div><div><dt>接收状态</dt><dd class="agent-process-accepted">' + (run.acceptedAt ? '云端已接收 · ' + esc(agentUiStamp(run.acceptedAt)) : '尚未收到云端接收回执') + '</dd></div></dl><p class="fine">以上为交互演示，没有调用真实模型。</p></details>';
}
function agentUiMessageBody(message, run) {
  const text = run ? run.text : message.text;
  if (text) return agentUiText(text);
  return '<p class="agent-waiting">' + (run?.phase === 'queued' ? '连上云端后，可以继续发送。' : run?.phase === 'failed' ? '这次没有生成回答。输入和材料已保留。' : run?.phase === 'stopped' ? (run.cancelledBeforeSend ? '这条暂存消息已撤回，没有启动云端生成。' : '已在生成开始前停止。') : '正在等待回复…') + '</p>';
}
function agentUiCitations(message, run) {
  const ids = [...new Set(message.citations || run?.citations || [])].filter(id => docs[id] || st.notes.some(n => n.id === id));
  if (!ids.length || run && !['completed', 'stopped'].includes(run.phase)) return '';
  return '<div class="agent-citations"><span class="fine">引用资料</span>' + ids.map((id, index) => '<button type="button" data-act="go:doc/' + esc(id) + '"><span>' + (index + 1) + '</span>' + esc(docs[id]?.t || st.notes.find(n => n.id === id)?.title || '本地记录') + ico('chev', 14) + '</button>').join('') + '</div>';
}
function agentUiMessageActions(message, run) {
  if (!run || !['completed', 'stopped'].includes(run.phase) || !(run.text || message.text)) return '';
  const copy = plain(run.phase === 'stopped' ? '复制已收到的内容' : '复制回答', 'agent-copy:' + run.id, 'copy');
  if (run.phase !== 'completed') return copy;
  const task = typeof workspaceTaskFromAgent === 'function' ? plain('转为任务', 'agent-result-task:' + run.threadId + ':' + message.id, 'task') : '';
  return copy + plain(run.resultNoteId ? '查看已存笔记' : '保存为笔记', 'agent-save:' + run.id, 'note') + task + (agentThread(run.threadId)?.archivedAt ? '' : plain('继续追问', 'agent-followup:' + run.threadId, 'chat'));
}
function agentUiMessage(message, threadId) {
  const assistant = message.role === 'assistant', run = message.runId ? st.agents.runs[message.runId] : null;
  return '<article class="agent-message ' + (assistant ? 'is-assistant' : 'is-user') + '" data-agent-message="' + esc(message.id) + '"><div class="agent-message-meta">' + (assistant ? ico('spark', 16) + '<strong>Hub</strong><span>示例回复</span>' : '<span>你</span>') + '<time>' + esc(agentUiStamp(message.at)) + '</time></div>' + agentUiAttachments(message.attachments, threadId) + '<div class="agent-message-body">' + (assistant ? agentUiMessageBody(message, run) : agentUiText(message.text)) + '</div>' + (assistant ? '<div class="agent-run-receipt">' + agentUiReceipt(run) + '</div><div class="agent-message-citations">' + agentUiCitations(message, run) + '</div><div class="agent-message-actions">' + agentUiMessageActions(message, run) + '</div>' + agentUiProcess(run) : '') + '</article>';
}
function agentUiEmptyChat(thread) {
  return '<section class="agent-empty-chat"><span class="agent-empty-mark">' + ico('spark', 31) + '</span><h2>从一个问题开始</h2><p>' + (thread.attachments.length ? '材料已放好。想从哪里开始看？' : '写下想法，或带上一张照片、几条资料。') + '</p><div class="agent-suggestions">' + [['validation', '核对项目的下一步', 'task'], ['reading', '让一条阅读笔记更好用', 'book'], ['image', '试试图片提问', 'image']].map(([key, label, icon]) => agentUiActionButton(label, 'agent-suggest:' + thread.id + ':' + key, 'agent-suggestion', icon)).join('') + '</div></section>';
}
function agentUiMessages(thread) { return thread.messages.length ? thread.messages.map(m => agentUiMessage(m, thread.id)).join('') : agentUiEmptyChat(thread); }
function agentUiMaterials(thread) {
  const materials = [...(thread.materials || []), ...(thread.attachments || [])];
  const unique = [...new Map(materials.map(a => [a.id, a])).values()];
  if (!unique.length) return '<div class="empty-state">' + ico('folder', 27) + '<h2>还没有附上材料</h2><p>只会使用这段对话和你明确选中的内容。</p>' + btn('添加材料', 'agent-attach:' + thread.id, 'secondary', 'plus') + '</div>';
  return '<div class="agent-material-grid">' + unique.map(a => '<div class="agent-material-card">' + agentUiAttachment(a, thread.id) + '<p class="fine">' + (thread.attachments.some(item => item.id === a.id) ? '待发送 · 可以在输入区移除' : '已随消息发送 · 保留本轮材料') + '</p></div>').join('') + '</div><p class="settings-note">未接入整库检索。电脑上的其他文件不会自动加入这段对话。</p>';
}
function agentUiResults(thread) {
  const runs = Object.values(st.agents.runs).filter(run => run.threadId === thread.id && run.phase === 'completed').sort((a, b) => b.finishedAt - a.finishedAt);
  if (!runs.length) return '<div class="empty-state">' + ico('note', 27) + '<h2>完成的回答会留在这里</h2><p>可以回看依据，再保存成一条本地笔记。</p>' + plain('回到对话', 'agent-view:' + thread.id + ':chat', 'chat') + '</div>';
  return runs.map(run => '<article class="agent-result-card"><span class="eyebrow">示例成果 · ' + esc(agentUiStamp(run.finishedAt)) + '</span><h2>' + esc(thread.title) + '</h2><div class="agent-result-body">' + agentUiText(run.text || run.answer) + '</div>' + agentUiCitations({ citations: run.citations || [] }, run) + '<div class="actions">' + agentUiMessageActions({ id: run.messageId, text: run.text }, run) + '</div></article>').join('');
}
function agentUiSendControl(thread) {
  const run = thread.activeRunId && st.agents.runs[thread.activeRunId];
  if (run && ['accepted', 'running', 'unknown', 'stop_pending'].includes(run.phase)) return agentUiActionButton(run.phase === 'stop_pending' ? '等待停止确认' : '停止', 'agent-stop:' + run.id, 'agent-stop-button', 'stop', run.phase === 'stop_pending');
  if (run?.phase === 'queued') return agentUiActionButton('发送原请求', 'agent-retry:' + run.id, 'agent-send-button', 'arrowUp');
  return '<button type="submit" class="agent-send-button" aria-label="发送消息" ' + (agentAttachmentReading ? 'disabled' : '') + '>' + ico('arrowUp', 21) + '<span>发送</span></button>';
}
function agentUiComposer(thread) {
  if (thread.archivedAt) return '<div id="agent-composer" class="agent-composer agent-archived-composer"><span>已归档 · 内容完整保留</span>' + btn('恢复并继续', 'agent-restore:' + thread.id, 'secondary', 'sync') + '</div>';
  return '<div id="agent-composer" class="agent-composer"><div id="agent-draft-attachments">' + agentUiAttachments(thread.attachments, thread.id, true) + '</div><form id="agent-send-form" data-thread="' + esc(thread.id) + '"><label class="agent-sr-only" for="agent-prompt">给 Agents 的消息</label><textarea id="agent-prompt" name="message" rows="2" maxlength="6000" placeholder="问一个问题，或接着聊…" enterkeyhint="enter">' + esc(thread.draft || '') + '</textarea><div class="agent-composer-tools">' + iconBtn('添加照片或资料', 'agent-attach:' + thread.id, 'plus') + '<button type="button" class="agent-model-trigger" data-act="agent-model" aria-label="查看模型与原型说明"><span>Codex</span><small>演示说明</small>' + ico('info', 13) + '</button><div id="agent-send-control">' + agentUiSendControl(thread) + '</div></div></form><div class="agent-composer-hint"><span id="agent-draft-status">' + (thread.draft ? '草稿已保留' : '交互演示 · 未调用模型') + '</span><span>固定示例回复</span></div></div>';
}
function agentChatPage(id) {
  const thread = agentThread(id);
  if (!thread) return '<div class="agent-chat-page">' + intro('这段对话暂不可用', '返回列表，选择一段已保存的会话。') + btn('返回 Agents', 'go:agents', 'secondary') + '</div>';
  if (agentUiRevoked()) return '<div class="agent-chat-page">' + agentUiAccessBlock() + '</div>';
  const view = ['chat', 'materials', 'results'].includes(thread.view) ? thread.view : 'chat';
  return '<div class="agent-chat-page" data-thread="' + esc(id) + '"><div class="agent-view-tabs" aria-label="会话视图">' + [['chat', '对话'], ['materials', '材料'], ['results', '成果']].map(([key, label]) => '<button type="button" data-act="agent-view:' + esc(id) + ':' + key + '" aria-pressed="' + (key === view) + '">' + label + '</button>').join('') + '</div><div id="agent-connection-banner">' + agentUiBanner(thread) + '</div><div id="agent-chat-panel" ' + (view !== 'chat' ? 'hidden' : '') + '><div id="agent-messages" role="log" aria-label="会话消息" aria-live="off">' + agentUiMessages(thread) + '</div><div id="agent-message-end"></div>' + agentUiComposer(thread) + '</div><div id="agent-materials-panel" ' + (view !== 'materials' ? 'hidden' : '') + '>' + agentUiMaterials(thread) + '</div><div id="agent-results-panel" ' + (view !== 'results' ? 'hidden' : '') + '>' + agentUiResults(thread) + '</div><p id="agent-live-announcement" class="agent-sr-only" role="status" aria-live="polite"></p></div>';
}
function agentConnectionPage() {
  const c = agentUiConnection(), profile = st.agents.setup;
  const stateRow = (label, value, action, icon = 'info') => row(label, value, icon, action);
  return '<div class="agent-connection-page">' + intro('个人云端', '手机上的对话，交给云端继续。') + '<div id="agent-connection-overview">' + agentUiConnectionCard() + '</div>' +
    section('首次连接', group(stateRow('连接向导 · 仅演示', profile?.demo ? profile.deviceNickname + ' · 已完成演示配对' : '设置服务地址、设备名，体验校验与配对', 'agent-setup', 'link')) + '<p class="settings-note">不会联系服务或验证真实登录。请勿输入真实密钥、令牌或密码。</p>') +
    section('连接与订阅', '<div class="agent-settings-list">' + group(stateRow('执行位置', c.server === 'online' ? '个人 VPS · 服务可达（演示）' : '个人 VPS · 暂不可达（演示）', 'agent-service-info', 'sync') + stateRow('ChatGPT 订阅', c.auth === 'valid' ? '已登录（演示）· 凭据保留在执行端' : '登录失效 · 需要在执行端重新登录', 'agent-login-help', 'star') + stateRow('额度信息', c.quota === 'exhausted' ? '额度不足（演示）· 新请求未执行' : c.quota === 'available' ? '可用（演示）· 不展示虚构百分比' : '未知 · 服务未提供余额信息', 'agent-quota', 'info') + stateRow('这台手机', c.device === 'active' ? (profile?.demo ? profile.deviceNickname + ' · 已完成演示配对' : '示例设备 · 可体验首次配对向导') : '访问已撤销（演示）· 无法读取云端会话', 'agent-device-info', 'settings')) + '</div>') +
    section('电脑与资料', group(stateRow('Windows 电脑', c.windows === 'offline' ? '当前关机 · 不影响新云端对话' : '当前在线 · 云端会话仍在 VPS 执行', 'agent-windows-info', 'folder'))) +
    '<p class="settings-note">新云端会话可供后续桌面 Hub 回读。已有桌面聊天、电脑资料库与桌面工具不会自动接入。</p>' +
    section('体验不同状态', '<p class="fine">以下仅切换原型演示，不会修改实际服务器或账号。</p><div class="agent-scenarios">' +
      [['network', c.network === 'offline' ? 'online' : 'offline', c.network === 'offline' ? '恢复手机网络' : '手机断网'], ['server', c.server === 'offline' ? 'online' : 'offline', c.server === 'offline' ? '恢复云端服务' : 'VPS 暂不可达'], ['auth', c.auth === 'expired' ? 'valid' : 'expired', c.auth === 'expired' ? '模拟登录恢复' : '登录失效'], ['quota', c.quota === 'exhausted' ? 'unknown' : 'exhausted', c.quota === 'exhausted' ? '恢复可发送状态' : '额度不足'], ['device', c.device === 'revoked' ? 'active' : 'revoked', c.device === 'revoked' ? '模拟重新配对' : '撤销设备'], ['windows', c.windows === 'offline' ? 'online' : 'offline', c.windows === 'offline' ? 'Windows 开机' : 'Windows 关机']].map(([key, value, label]) => btn(label, 'agent-connection:' + key + ':' + value, 'outline')).join('') + '</div><div class="actions">' + plain('恢复全部演示连接', 'agent-reset-connection', 'sync') + '</div>') +
    '<p class="agent-demo-note">本原型不连接真实 VPS，不保存 Codex 登录凭据，不产生模型调用费用。</p></div>';
}

function agentUiInputLimits() {
  const l = AGENT_INPUT_LIMITS;
  return '<details class="agent-input-limits"><summary>源码限制与本原型的区别</summary><dl><div><dt>当前服务源码</dt><dd>图片与关键帧合计最多 ' + l.serviceImages + ' 张；每张 ≤ ' + l.serviceImageMiB + ' MiB，合计 ≤ ' + l.serviceTotalMiB + ' MiB。短视频 ≤ ' + l.serviceVideoSeconds + ' 秒，按关键帧处理，不等于完整视频理解。</dd></div><div><dt>当前网页原型</dt><dd>本机图片预览最多 ' + l.demoImages + ' 张，每张 ≤ ' + l.demoImageMiB + ' MiB。浏览器容量不足时会拒绝保存并保留原材料，不代表真实服务拒绝。视频只提供合成关键帧示例，不上传视频或处理声音。</dd></div></dl><p class="fine">本页不会发送图片、资料或密钥到任何服务。</p></details>';
}
function agentUiSetupSheet() {
  agentPairingDraft = null;
  const profile = st.agents.setup || {};
  sheet('连接向导 · 演示', '<p class="info">这是流程演示，不连接真实 VPS。请勿输入真实密钥、令牌或密码；此处也没有凭据输入框。</p><form id="agent-setup-form"><label class="agent-field" for="agent-service-address">服务地址<input type="url" id="agent-service-address" name="address" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="300" placeholder="https://hub.example.test" value="' + esc(profile.serviceAddress || 'https://hub.example.test') + '" required></label><label class="agent-field" for="agent-device-nickname">设备昵称<input type="text" id="agent-device-nickname" name="nickname" maxlength="40" autocomplete="off" value="' + esc(profile.deviceNickname || '我的 Android 手机') + '" required></label><label class="agent-field" for="agent-setup-scenario">这次校验的模拟结果<select id="agent-setup-scenario" name="scenario"><option value="success">成功 · 体验配对确认</option><option value="unreachable">失败 · 服务暂不可达</option></select></label><p class="fine">只校验地址格式并展示所选的模拟结果，不检测网络、TLS 或服务器身份。</p><div class="actions"><button class="btn secondary" type="submit">模拟校验</button></div><div id="agent-setup-result" role="status" aria-live="polite"></div></form><p class="settings-note">完成后仅把地址与设备名保存在当前浏览器。真实配对、鉴权与设备凭据仍需正式服务，不会因这次演示自动开通。</p>');
}
function agentUiInvalidateSetup() {
  agentPairingDraft = null;
  const result = document.querySelector('#agent-setup-result');
  if (result) result.innerHTML = '<p class="fine">信息已修改，请重新模拟校验。</p>';
}
function agentUiTestSetup(form) {
  agentPairingDraft = null;
  const result = agentValidateDemoConnection(form.elements.address.value, form.elements.nickname.value);
  const target = document.querySelector('#agent-setup-result');
  if (!target) return;
  if (!result.ok) { target.innerHTML = '<p class="info">' + esc(result.error) + '</p>'; return; }
  if (form.elements.scenario.value !== 'success') { target.innerHTML = '<p class="info">模拟失败：服务暂不可达。未保存设置，也未发送网络请求。可修改模拟结果后重试。</p>'; return; }
  agentPairingDraft = result.profile;
  target.innerHTML = '<div class="agent-banner"><strong>格式校验通过 · 模拟连接成功</strong><p>这不表示真实服务可达或身份已验证。确认后只保存演示配置。</p></div><div class="actions">' + btn('完成演示配对', 'agent-setup-confirm', 'wide', 'check') + '</div>';
}

// Public integration hook for the source detail, reading and task flows. A click
// starts a draft with precisely one chosen record; it does not send that draft.
function agentStartWithMaterial(record) {
  const material = agentMaterialFromRecord(record);
  if (!material) { const result = agentFailure('这份内容暂时无法加入对话，请返回来源重新选择。', 'invalid'); agentUiFeedback(result); return result; }
  const result = agentCreateThread({ title: '关于 ' + material.name, attachments: [material], prompt: typeof record.prompt === 'string' ? record.prompt : '' });
  if (agentUiFeedback(result)) { go('agent-chat/' + result.threadId); tell('已带入 1 份选定材料，尚未发送'); }
  return result;
}
async function agentUiCopyAnswer(runId) {
  if (agentUiRevoked()) { tell('请先恢复演示设备访问。'); return; }
  const run = st.agents.runs[runId];
  if (!run || !['completed', 'stopped'].includes(run.phase) || !run.text) { tell('这条回答暂时没有可复制的内容。'); return; }
  const text = run.text + '\n\n— Agents 交互原型示例回复（未调用真实模型）';
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    tell(run.phase === 'stopped' ? '已复制收到的部分，并保留示例标记' : '已复制回答，并保留示例标记');
  } catch {
    sheet('手动复制回答', '<p class="info">浏览器未允许写入剪贴板。可以长按下方文字，全选并复制。</p><label class="agent-field" for="agent-copy-text">示例回答<textarea id="agent-copy-text" class="agent-copy-text" readonly rows="9">' + esc(text) + '</textarea></label><div class="actions">' + btn('完成', 'close', 'secondary') + '</div>');
  }
}
function agentUiRenameSheet(threadId) {
  const thread = agentThread(threadId);
  if (!thread || agentUiRevoked()) return;
  sheet('重命名会话', '<form id="agent-rename-form" data-thread="' + esc(threadId) + '"><label class="agent-field" for="agent-thread-title">会话名称<input id="agent-thread-title" name="title" type="text" maxlength="80" value="' + esc(thread.title) + '" required></label><p class="fine">仅修改标题；消息、材料、原请求和归档状态保持不变。</p><div class="actions"><button class="btn" type="submit">保存名称</button>' + btn('取消', 'close', 'outline') + '</div></form>');
}

function agentUiDocAttachment(id) {
  return agentDocMaterial(id);
}
function agentUiAttachDocument(threadId, docId) {
  const thread = agentThread(threadId), a = agentUiDocAttachment(docId);
  if (!thread || !a || agentUiRevoked()) return;
  if (thread.attachments.some(x => x.kind === 'doc' && x.docId === docId)) { tell('这份资料已在待发送材料中'); return; }
  if (!agentUiFeedback(agentAttachMaterials(threadId, [a]))) return;
  close(); refreshAgentView(); tell('已附上这份资料');
}
function agentUiAttachmentSheet(threadId) {
  const thread = agentThread(threadId);
  if (!thread || agentUiRevoked()) return;
  if (thread.archivedAt) { tell('先恢复会话，再添加材料。'); return; }
  sheet('添加材料', '<div class="agent-attachment-menu">' + group(row('拍照', '使用系统相机，返回后可预览', 'camera', 'agent-pick:' + threadId + ':camera') + row('从相册选择', '图片保留在此浏览器，不上传模型', 'image', 'agent-pick:' + threadId + ':photos') + row('选择资料', '搜索资料、本地记录和阅读 · 支持多选', 'note', 'agent-select-doc:' + threadId) + row('关键帧示例', '实验交互 · 0、1、2 秒三帧', 'video', 'agent-frame-example:' + threadId)) + '</div><input type="file" id="agent-camera-input" data-thread="' + esc(threadId) + '" accept="image/jpeg,image/png,image/webp,image/gif" capture="environment" hidden><input type="file" id="agent-photo-input" data-thread="' + esc(threadId) + '" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden><p id="agent-attachment-feedback" class="fine" role="status"></p><p class="settings-note">当前仅是本机预览：最多 3 张，每张 ≤ 2 MiB。真实服务的限制不同，见下方说明。</p>' + agentUiInputLimits());
}
function agentUiSelectDocSheet(threadId) {
  const thread = agentThread(threadId);
  if (!thread || thread.archivedAt || agentUiRevoked()) return;
  agentMaterialPicker = { threadId, query: '', type: 'all', selected: new Set(), catalog: agentMaterialCatalog() };
  sheet('选择资料', '<p class="lede">搜索并多选，只把确认的内容加入待发送材料。</p><div class="agent-list-search">' + ico('search', 19) + '<input type="search" id="agent-material-query" aria-label="搜索资料标题、正文或来源" placeholder="搜索标题、正文或来源"></div><div class="filter" id="agent-material-filters">' + agentUiPickerFilters() + '</div><p id="agent-material-selected" class="fine" role="status" aria-live="polite">已选 0 项 · 不会自动读取整个资料库</p><div id="agent-material-rows" class="agent-material-choices">' + agentUiPickerRows() + '</div><div class="agent-picker-footer"><button id="agent-material-apply" type="button" class="btn" data-act="agent-material-apply:' + esc(threadId) + '" disabled>加入 0 项</button>' + plain('清空选择', 'agent-material-clear', 'close') + '</div><p class="settings-note">标为“已附上”的材料已在当前草稿中，不会重复添加；已发送的材料仍留在会话历史里。</p>');
}
function agentUiPickerFilters() {
  return [['all', '全部'], ['doc', '资料'], ['note', '本地记录'], ['reading', '阅读'], ['selected', '已选']]
    .map(([id, label]) => chip(label, 'agent-material-filter:' + id, agentMaterialPicker?.type === id)).join('');
}
function agentUiPickerRows() {
  if (!agentMaterialPicker) return '';
  const p = agentMaterialPicker, thread = agentThread(p.threadId), query = p.query.trim().toLowerCase();
  const matches = p.catalog.filter(item => (p.type === 'all' || p.type === 'selected' && p.selected.has(item.id) || item.materialType === p.type) &&
    (item.name + ' ' + item.source + ' ' + item.text).toLowerCase().includes(query));
  if (!matches.length) return '<div class="empty-state"><h3>' + (p.type === 'selected' ? '还没有符合条件的已选材料' : '没有匹配的材料') + '</h3><p>试试更短的词，或切换来源；其他筛选下的勾选会保留。</p></div>';
  return matches.map(item => {
    const attached = thread?.attachments.some(a => a.id === item.id), selected = p.selected.has(item.id);
    return '<label class="agent-material-choice' + (attached ? ' is-attached' : '') + '"><input type="checkbox" data-agent-material="' + esc(item.id) + '" ' + (attached || selected ? 'checked ' : '') + (attached ? 'disabled ' : '') + '><span><strong>' + esc(item.name) + '</strong><small>' + esc(item.source + (item.demo ? ' · 示例' : ' · 本地')) + (attached ? ' · 已附上' : '') + '</small><span class="agent-material-excerpt">' + esc(item.text.replace(/\s+/g, ' ').slice(0, 85)) + '</span></span></label>';
  }).join('');
}
function agentUiUpdatePicker(rows = true) {
  if (!agentMaterialPicker) return;
  const count = agentMaterialPicker.selected.size;
  const list = document.querySelector('#agent-material-rows'); if (list && rows) list.innerHTML = agentUiPickerRows();
  const filters = document.querySelector('#agent-material-filters'); if (filters) filters.innerHTML = agentUiPickerFilters();
  const status = document.querySelector('#agent-material-selected'); if (status) status.textContent = '已选 ' + count + ' 项 · 只加入这些内容，不会上传整库';
  const apply = document.querySelector('#agent-material-apply'); if (apply) { apply.textContent = '加入 ' + count + ' 项'; apply.disabled = count === 0; }
}
function agentUiFindAttachment(threadId, id) {
  if (agentUiRevoked()) return null;
  const thread = agentThread(threadId);
  if (!thread) return null;
  return [...thread.attachments, ...thread.materials, ...thread.messages.flatMap(m => m.attachments || [])].find(a => a.id === id);
}
function agentUiShowAttachment(threadId, id) {
  const a = agentUiFindAttachment(threadId, id);
  if (!a) { tell('找不到这份材料'); return; }
  if (a.kind === 'doc') { go('doc/' + a.docId); return; }
  if (a.kind === 'material') {
    const target = /^(doc|note|article|task)\/[A-Za-z0-9_-]+$/.test(a.route || '') ? a.route : '';
    sheet(a.name, '<p class="eyebrow">' + esc(a.source) + (a.demo ? ' · 示例' : ' · 本地材料') + '</p><div class="agent-message-body">' + agentUiText(a.text) + '</div><p class="settings-note">这是加入会话时保留的内容快照，不代表模型已经分析。</p>' + (target ? '<div class="actions">' + btn('打开原内容', 'go:' + target, 'secondary', 'link') + '</div>' : ''));
    return;
  }
  const safe = /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(a.dataUrl || '');
  sheet(agentUiAttachmentLabel(a), a.kind === 'frame' ? '<div class="agent-frame-strip"><div class="agent-frame" data-frame="' + esc(a.color || ['red', 'green', 'blue'][Number(a.time) % 3] || 'red') + '"><strong>' + esc(a.time ?? 0) + ' 秒</strong></div></div><p class="settings-note">合成关键帧示例。回答只能覆盖采样帧，不能判断帧间的短暂动作。</p>' : (safe ? '<img class="agent-image-preview" src="' + esc(a.dataUrl) + '" alt="' + esc(agentUiAttachmentLabel(a)) + '">' : '<p class="info">此图片预览暂不可用。</p>') + '<p class="settings-note">仅在本机预览，本原型没有分析图片内容。</p>');
}
async function agentUiReadImages(input) {
  const files = [...(input.files || [])], threadId = input.dataset.thread, thread = agentThread(threadId);
  if (!files.length || !thread || agentUiRevoked()) return;
  if (agentAttachmentReading) return;
  const imageCount = thread.attachments.filter(a => ['image', 'frame'].includes(a.kind)).length;
  if (thread.archivedAt) { tell('先恢复会话，再添加图片。'); return; }
  if (imageCount + files.length > AGENT_INPUT_LIMITS.demoImages) { tell('本机预览一次最多附 3 张图片，请减少选择；这不是服务端的 6 张限额。'); return; }
  if (files.some(file => !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type))) { tell('原型支持 JPG、PNG、WebP 或 GIF 图片。'); return; }
  if (files.some(file => file.size > AGENT_INPUT_LIMITS.demoImageMiB * 1024 * 1024)) { tell('这张图片超过本机预览的 2 MiB 限制，请选择较小的图片；服务源码上限为每张 4 MiB。'); return; }
  agentAttachmentReading = true;
  const feedback = document.querySelector('#agent-attachment-feedback');
  if (feedback) feedback.textContent = '正在准备本机图片预览…';
  refreshAgentView();
  try {
    const loaded = await Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ id: 'img-' + crypto.randomUUID(), kind: 'image', name: file.name || '手机照片', mime: file.type, bytes: file.size, dataUrl: reader.result, demo: false });
      reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
      reader.readAsDataURL(file);
    })));
    const live = agentThread(threadId);
    if (!live || live.archivedAt || agentUiRevoked()) throw new Error('会话或设备访问状态已变化，图片没有加入会话。');
    if (live.attachments.filter(a => ['image', 'frame'].includes(a.kind)).length + loaded.length > AGENT_INPUT_LIMITS.demoImages) throw new Error('已选图片发生变化，请减少数量后重试。');
    const previous = [...live.attachments];
    live.attachments.push(...loaded);
    if (!save()) { live.attachments = previous; throw new Error('浏览器暂时无法保存图片。文字草稿保留，可换较小图片后重试。'); }
    input.value = '';
    if (input.isConnected && document.querySelector('#sheet')?.contains(input)) close();
    tell('图片已附上，仅保存在当前浏览器');
  } catch (error) { tell(error.message || '图片暂未加入，请重试。'); }
  finally { agentAttachmentReading = false; refreshAgentView(); }
}
function agentUiFrames(threadId) {
  if (!agentThread(threadId) || agentThread(threadId).archivedAt || agentUiRevoked()) return;
  sheet('关键帧示例', '<p class="prose">只把 0、1、2 秒的三张采样帧送入对话，明确保留时间戳。</p><div class="agent-frame-strip">' + ['red', 'green', 'blue'].map((color, index) => '<div class="agent-frame" data-frame="' + color + '"><strong>' + index + ' 秒</strong></div>').join('') + '</div><p class="info">这不是完整视频理解。采样之间发生的动作可能被遗漏，声音也没有被转写。</p><div class="actions">' + btn('附上这 3 帧示例', 'agent-add-frames:' + threadId, '', 'plus') + '</div>');
}
function handleAgentAction(action, key, value) {
  if (!action.startsWith('agent-')) return false;
  const thread = agentThread(key);
  if (action === 'agent-new') { const result = agentCreateThread(); if (agentUiFeedback(result)) go('agent-chat/' + result.threadId); return true; }
  if (action === 'agent-list-scope') { if (['active', 'archived', 'all'].includes(key)) { agentListScope = key; render(); } return true; }
  if (action === 'agent-rename') { agentUiRenameSheet(key); return true; }
  if (action === 'agent-archive') {
    if (thread && !agentUiRevoked()) sheet('归档这段会话？', '<p class="prose">' + esc(thread.title) + '</p><p class="info">只从“当前”列表收起。消息、材料与成果完整保留，可从“已归档”或“全部”找到并恢复。进行中或待发送的请求需先完成、停止或撤回。</p><div class="actions">' + btn('确认归档', 'agent-archive-confirm:' + key, 'secondary') + btn('取消', 'close', 'outline') + '</div>');
    return true;
  }
  if (action === 'agent-archive-confirm') { if (agentUiFeedback(agentArchiveThread(key, true))) { go('agents'); tell('已归档，消息和材料仍保留，可随时恢复'); } return true; }
  if (action === 'agent-restore') { if (agentUiFeedback(agentArchiveThread(key, false))) { close(); render(); tell('会话已恢复，可以接着聊'); } return true; }
  if (action === 'agent-copy') { void agentUiCopyAnswer(key); return true; }
  if (action === 'agent-result-task') { if (!agentUiRevoked() && typeof workspaceTaskFromAgent === 'function') workspaceTaskFromAgent(key, value); else tell('此处暂时无法创建任务，请稍后重试。'); return true; }
  if (action === 'agent-setup') { agentUiSetupSheet(); return true; }
  if (action === 'agent-setup-confirm') {
    if (!agentPairingDraft) { tell('请先完成模拟校验。'); return true; }
    if (agentUiFeedback(agentSaveDemoConnection(agentPairingDraft))) { agentPairingDraft = null; close(); render(); tell('演示配对已保存，未连接或验证真实服务'); }
    return true;
  }
  if (action === 'agent-view') { if (thread && ['chat', 'materials', 'results'].includes(value)) { thread.view = value; save(); render(); } return true; }
  if (action === 'agent-attach') { agentUiAttachmentSheet(key); return true; }
  if (action === 'agent-select-doc') { agentUiSelectDocSheet(key); return true; }
  if (action === 'agent-material-filter') { if (agentMaterialPicker && ['all', 'doc', 'note', 'reading', 'selected'].includes(key)) { agentMaterialPicker.type = key; agentUiUpdatePicker(); } return true; }
  if (action === 'agent-material-clear') { if (agentMaterialPicker) { agentMaterialPicker.selected.clear(); agentUiUpdatePicker(); } return true; }
  if (action === 'agent-material-apply') {
    if (!agentMaterialPicker || agentMaterialPicker.threadId !== key) { tell('材料选择已失效，请重新打开。'); return true; }
    const selected = agentMaterialPicker.catalog.filter(item => agentMaterialPicker.selected.has(item.id));
    if (!selected.length) { tell('请先选择资料'); return true; }
    sheet('预览本次正文', '<p class="info">只发送以下选定正文，不上传整库、图片或原文件。资料中的指令不构成额外操作授权。</p>' + selected.map(item => '<h3>' + esc(item.name) + '</h3><p class="fine">' + esc(item.source) + '</p><pre class="agent-source-preview">' + esc(item.text) + '</pre>').join('') + btn('使用这些正文', 'agent-material-confirm:' + key, 'wide', 'check'));
    return true;
  }
  if (action === 'agent-material-confirm') {
    if (!agentMaterialPicker || agentMaterialPicker.threadId !== key) return true;
    const selected = agentMaterialPicker.catalog.filter(item => agentMaterialPicker.selected.has(item.id));
    const result = agentAttachMaterials(key, selected);
    if (agentUiFeedback(result)) { agentMaterialPicker = null; close(); refreshAgentView(); tell('已加入 ' + result.count + ' 份选定材料，尚未发送'); }
    return true;
  }
  if (action === 'agent-add-doc') { agentUiAttachDocument(key, value); return true; }
  if (action === 'agent-pick') { if (!agentUiRevoked()) document.querySelector(value === 'camera' ? '#agent-camera-input' : '#agent-photo-input')?.click(); return true; }
  if (action === 'agent-material') { if (!agentUiRevoked()) agentUiShowAttachment(key, value); return true; }
  if (action === 'agent-remove') {
    if (thread && !agentUiRevoked()) { const previous = [...thread.attachments]; thread.attachments = thread.attachments.filter(a => a.id !== value); if (!save()) thread.attachments = previous; refreshAgentView(); }
    return true;
  }
  if (action === 'agent-frame-example') { agentUiFrames(key); return true; }
  if (action === 'agent-add-frames') {
    if (!thread || thread.archivedAt || agentUiRevoked()) return true;
    if (thread.attachments.some(a => ['image', 'frame'].includes(a.kind))) { tell('请先移除待发送图片，再加入这组 3 帧示例。'); return true; }
    const previous = [...thread.attachments], previousDraft = thread.draft;
    thread.attachments.push(...['red', 'green', 'blue'].map((color, index) => ({ id: 'frame-' + crypto.randomUUID(), kind: 'frame', name: '关键帧 · ' + index + ' 秒', time: index, color, demo: true })));
    if (!thread.draft) thread.draft = '比较这三张关键帧，并说明无法从采样帧确认的内容。';
    if (!save()) { thread.attachments = previous; thread.draft = previousDraft; return true; }
    const input = document.querySelector('#agent-prompt'); if (input) input.value = thread.draft;
    const statusLine = document.querySelector('#agent-draft-status'); if (statusLine) statusLine.textContent = '草稿已保留';
    close(); refreshAgentView(); tell('已附上 3 张带时间戳的示例关键帧'); return true;
  }
  if (action === 'agent-suggest') {
    if (!thread || thread.archivedAt || agentUiRevoked()) return true;
    const prompts = { validation: ['根据这份项目周回顾，帮我整理实机验证的下一步。', 'd5'], reading: ['这条阅读笔记怎样变成一个可实践的小步骤？', 'd3'] };
    if (value === 'image') { agentUiAttachmentSheet(key); return true; }
    if (prompts[value]) {
      const [prompt, docId] = prompts[value], previousDraft = thread.draft, previousAttachments = [...thread.attachments];
      thread.draft = prompt;
      if (!thread.attachments.some(a => a.docId === docId)) thread.attachments.push(agentUiDocAttachment(docId));
      if (!save()) { thread.draft = previousDraft; thread.attachments = previousAttachments; return true; }
      refreshAgentView();
      const input = document.querySelector('#agent-prompt'); if (input) { input.value = thread.draft; input.focus(); agentUiResizeComposer(); }
      const statusLine = document.querySelector('#agent-draft-status'); if (statusLine) statusLine.textContent = '草稿已保留';
    }
    return true;
  }
  if (action === 'agent-stop') { agentUiFeedback(agentStop(key)); refreshAgentView(); return true; }
  if (action === 'agent-retry') { agentUiFeedback(agentRetry(key)); refreshAgentView(); return true; }
  if (action === 'agent-recover') { agentUiFeedback(agentRecover()); refreshAgentView(); return true; }
  if (action === 'agent-save') {
    const run = agentState().runs[key];
    if (!run || run.phase !== 'completed' || agentUiRevoked()) return true;
    if (run.resultNoteId) { go('doc/' + run.resultNoteId); return true; }
    sheet('保存回答为速记', '<p class="fine">确认后保存本条完整回答，重复操作不会创建第二份。</p><pre class="agent-source-preview">' + esc(run.answer) + '</pre><p class="info">原型只保存到此浏览器；未上传云端，也未写入 OS。正式客户端分别显示本机保存、云端上传和 OS 写入回执。</p>' + btn('确认保存速记', 'agent-save-confirm:' + key, 'wide', 'check'));
    return true;
  }
  if (action === 'agent-save-confirm') { const result = agentSaveResult(key); if (agentUiFeedback(result)) { close(); refreshAgentView(); tell('已存本机 · 原型未上传云端或写入 OS'); } return true; }
  if (action === 'agent-followup') { if (thread) { thread.view = 'chat'; save(); render(); document.querySelector('#agent-prompt')?.focus(); } return true; }
  if (action === 'agent-connection') { agentUiFeedback(agentSetConnection(key, value)); refreshAgentView(); if (route()[0] === 'agent-connection') render(); return true; }
  if (action === 'agent-reset-connection') { for (const [k, v] of Object.entries({ network: 'online', server: 'online', auth: 'valid', quota: 'unknown', device: 'active', windows: 'offline' })) agentSetConnection(k, v); agentRecover(); render(); tell('演示连接已恢复，待发送消息仍由你确认发送'); return true; }
  if (action === 'agent-model') { sheet('模型与原型说明', '<div class="agent-model-card"><span class="eyebrow">演示执行端标识 · 非实时模型列表</span><h3>' + esc(AGENT_MODEL) + '</h3><p class="prose">本网页使用固定示例回复，没有调用此模型，也不提供会产生真实效果的模型或模式切换。</p>' + tag('未调用模型', 'blue') + '</div><p class="settings-note">正式接入后，模型与模式需以执行端实际返回为准。登录失效或额度不足时，不会自动换账号或启用按量 API。</p>' + agentUiInputLimits() + '<div class="actions">' + btn('完成', 'close', 'wide') + '</div>'); return true; }
  if (action === 'agent-login-help') { sheet('订阅登录', '<p class="prose">Codex 使用执行端的 ChatGPT 登录。手机只连接 Hub，不保存或复制 Codex 登录令牌。</p><p class="info">登录失效时，先在 VPS 完成官方授权，再回到手机继续原请求。</p><div class="actions">' + btn('模拟登录恢复', 'agent-login-restore', 'secondary') + '</div><p class="settings-note">本按钮只恢复演示状态，不会登录任何真实账号。</p>'); return true; }
  if (action === 'agent-login-restore') { if (agentUiFeedback(agentSetConnection('auth', 'valid'))) { close(); refreshAgentView(); if (route()[0] === 'agent-connection') render(); tell('演示登录已恢复，可以重试原请求'); } return true; }
  if (action === 'agent-quota') { const c = agentUiConnection(); sheet('订阅额度', '<div class="agent-model-card"><span class="eyebrow">ChatGPT 订阅 · 演示</span><h3>' + (c.quota === 'exhausted' ? '额度不足' : '暂无可展示的额度读数') + '</h3><p class="prose">' + (c.quota === 'exhausted' ? '新请求尚未执行，原消息与材料保留。额度恢复后再重试。' : '只有执行端能读取的额度信息才会显示。未知不会显示成 100% 或无限。') + '</p></div><p class="settings-note">不自动切换账号，不启用按量 API。单次请求的具体扣额以可获取的实际信息为准。</p>' + (c.quota === 'exhausted' ? '<div class="actions">' + btn('模拟额度恢复', 'agent-quota-restore', 'secondary') + '</div>' : '')); return true; }
  if (action === 'agent-quota-restore') { if (agentUiFeedback(agentSetConnection('quota', 'unknown'))) { close(); refreshAgentView(); if (route()[0] === 'agent-connection') render(); tell('已恢复演示可发送状态，额度读数仍未知'); } return true; }
  if (action === 'agent-device-info') { sheet('这台手机', '<p class="prose">正式手机端使用可撤销的 Hub 设备凭据。当前网页不持有或保存真实设备凭据。</p><p class="info">可以通过连接向导体验首次配对，也可在“体验不同状态”中模拟撤销与恢复。撤销演示后不能读取会话或发新消息，但数据没有被删除。</p><div class="actions">' + btn('体验连接向导', 'agent-setup', 'secondary') + btn('完成', 'close', 'outline') + '</div>'); return true; }
  if (action === 'agent-service-info') { sheet('个人云端', '<p class="prose">手机连接 VPS 上的 Hub 服务，由 VPS 内部运行 Codex app-server。会话、附件和运行状态由正式云端服务保存。</p><p class="info">本原型仅在浏览器演示这些交互，没有连接真实 VPS。</p><div class="actions">' + btn('完成', 'close', 'wide') + '</div>'); return true; }
  if (action === 'agent-windows-info') { sheet('Windows 与云端', '<p class="prose">新云端对话在 VPS 执行，所以 Windows 关机也不影响继续提问。</p><p class="info">访问电脑上的私有资料与桌面工具仍是后续范围；现有桌面聊天不会自动迁移。</p><div class="actions">' + btn('完成', 'close', 'wide') + '</div>'); return true; }
  if (action === 'agent-thread-menu') { sheet('会话选项', group((thread && !agentUiRevoked() ? row('重命名会话', thread.title, 'note', 'agent-rename:' + key) + row(thread.archivedAt ? '恢复会话' : '归档会话', thread.archivedAt ? '恢复后继续提问；历史完整保留' : '从当前列表收起，不删除任何消息', 'folder', (thread.archivedAt ? 'agent-restore:' : 'agent-archive:') + key) : '') + row('连接与设备', '查看云端、订阅与恢复方式', 'sync', 'go:agent-connection') + row('返回会话列表', '运行状态会保留', 'chat', 'go:agents')) + '<p class="settings-note">可以离开这页再回来。原型按同一次请求恢复演示结果，不重复启动生成。</p>'); return true; }
  return false;
}
function handleAgentInput(event) {
  const input = event.target;
  if (input.id === 'agent-list-query') { agentListQuery = input.value; const list = document.querySelector('#agent-thread-list'); if (list) list.innerHTML = agentThreadRows(); return true; }
  if (input.id === 'agent-material-query') { if (agentMaterialPicker) { agentMaterialPicker.query = input.value; agentUiUpdatePicker(); } return true; }
  if (input.form?.id === 'agent-setup-form') { agentUiInvalidateSetup(); return true; }
  if (input.id !== 'agent-prompt') return false;
  const thread = agentThread(input.form?.dataset.thread);
  if (!thread || agentUiRevoked()) return true;
  thread.draft = input.value;
  const ok = save();
  const statusLine = document.querySelector('#agent-draft-status');
  if (statusLine) statusLine.textContent = ok ? '草稿已保留' : '草稿暂未保存，请保留当前页面';
  agentUiResizeComposer();
  return true;
}
function handleAgentChange(event) {
  const input = event.target;
  if (input.dataset.agentMaterial) {
    if (agentMaterialPicker && !input.disabled && agentMaterialPicker.catalog.some(item => item.id === input.dataset.agentMaterial)) {
      if (input.checked) agentMaterialPicker.selected.add(input.dataset.agentMaterial); else agentMaterialPicker.selected.delete(input.dataset.agentMaterial);
      agentUiUpdatePicker(agentMaterialPicker.type === 'selected');
    }
    return true;
  }
  if (input.form?.id === 'agent-setup-form') { agentUiInvalidateSetup(); return true; }
  if (['agent-camera-input', 'agent-photo-input'].includes(event.target.id)) { void agentUiReadImages(event.target); return true; }
  return false;
}
function handleAgentSubmit(form) {
  if (form.id === 'agent-setup-form') { agentUiTestSetup(form); return true; }
  if (form.id === 'agent-rename-form') { if (agentUiFeedback(agentRenameThread(form.dataset.thread, form.elements.title.value))) { close(); render(); tell('会话名称已保存'); } return true; }
  if (form.id !== 'agent-send-form') return false;
  const thread = agentThread(form.dataset.thread);
  if (!thread || agentUiRevoked()) return true;
  if (thread.archivedAt) { tell('请先恢复这段会话，再继续输入。'); return true; }
  const prompt = form.querySelector('#agent-prompt');
  if (prompt) thread.draft = prompt.value;
  const result = agentSend(thread.id);
  if (!agentUiFeedback(result)) return true;
  if (prompt) prompt.value = agentThread(thread.id)?.draft || '';
  const statusLine = document.querySelector('#agent-draft-status');
  if (statusLine) statusLine.textContent = prompt?.value ? '草稿已保留' : '交互演示 · 未调用模型';
  refreshAgentView(); agentUiResizeComposer();
  requestAnimationFrame(() => agentUiScrollToEnd(thread.id));
  return true;
}
function agentUiScrollToEnd(threadId) {
  const [page, id] = route();
  if (page !== 'agent-chat' || id !== threadId || agentThread(id)?.view !== 'chat' || document.querySelector('#sheet')?.open) return;
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
}
function agentUiResizeComposer() {
  const input = document.querySelector('#agent-prompt');
  if (input) { input.style.height = 'auto'; input.style.height = Math.min(138, Math.max(56, input.scrollHeight)) + 'px'; }
  const composer = document.querySelector('#agent-composer');
  const height = composer && !composer.closest('[hidden]') ? composer.getBoundingClientRect().height : 0;
  document.documentElement.style.setProperty('--agent-composer-height', Math.ceil(height) + 'px');
}
function agentUIAfterRender() {
  const composer = document.querySelector('#agent-composer');
  if (composer !== agentComposerObserved) {
    agentComposerObserver?.disconnect(); agentComposerObserved = composer;
    if (composer && typeof ResizeObserver === 'function') { agentComposerObserver = new ResizeObserver(() => { const height = composer.closest('[hidden]') ? 0 : composer.getBoundingClientRect().height; document.documentElement.style.setProperty('--agent-composer-height', Math.ceil(height) + 'px'); }); agentComposerObserver.observe(composer); }
  }
  agentUiResizeComposer();
  const [page, id] = route();
  if (page === 'agent-chat' && id !== agentLastVisibleThread) {
    agentLastVisibleThread = id;
    if (scrolls['agent-chat/' + id] === undefined && agentThread(id)?.messages.length) requestAnimationFrame(() => agentUiScrollToEnd(id));
  }
}
function refreshAgentView() {
  const [page, id] = route();
  if (['agents', 'agent'].includes(page)) {
    if (agentUiRevoked()) { if (!document.querySelector('.agent-access-block')) render(); return; }
    if (!document.querySelector('#agent-thread-list')) { render(); return; }
    const list = document.querySelector('#agent-thread-list'); if (list) { const html = agentThreadRows(); if (list.innerHTML !== html) list.innerHTML = html; }
    const scopes = document.querySelector('#agent-list-scopes'); if (scopes) { const html = agentUiListScopes(); if (scopes.innerHTML !== html) scopes.innerHTML = html; }
    const card = document.querySelector('#agent-list-connection'); if (card) { const html = agentUiConnectionCard(); if (card.innerHTML !== html) card.innerHTML = html; }
    return;
  }
  if (page !== 'agent-chat') return;
  const thread = agentThread(id); if (!thread) return;
  if (agentUiRevoked()) { if (!document.querySelector('.agent-access-block')) render(); return; }
  const composer = document.querySelector('#agent-composer');
  if (composer && Boolean(thread.archivedAt) !== composer.classList.contains('agent-archived-composer')) { render(); return; }
  const messages = document.querySelector('#agent-messages');
  if (!messages) { render(); return; }
  const followsEnd = document.documentElement.scrollHeight - innerHeight - window.scrollY < 180;
  const expectedIds = thread.messages.map(m => m.id).join('|');
  const existingIds = [...messages.querySelectorAll('[data-agent-message]')].map(el => el.dataset.agentMessage).join('|');
  if (expectedIds !== existingIds || !thread.messages.length) {
    const html = agentUiMessages(thread);
    if (messages.innerHTML !== html) {
      const expanded = [...messages.querySelectorAll('details[open][data-agent-process]')].map(el => el.dataset.agentProcess);
      messages.innerHTML = html;
      for (const details of messages.querySelectorAll('[data-agent-process]')) if (expanded.includes(details.dataset.agentProcess)) details.open = true;
    }
  }
  else for (const message of thread.messages) {
    if (message.role !== 'assistant') continue;
    const node = [...messages.querySelectorAll('[data-agent-message]')].find(el => el.dataset.agentMessage === message.id);
    const run = message.runId && st.agents.runs[message.runId];
    for (const [selector, html] of [['.agent-message-body', agentUiMessageBody(message, run)], ['.agent-run-receipt', agentUiReceipt(run)], ['.agent-message-citations', agentUiCitations(message, run)], ['.agent-message-actions', agentUiMessageActions(message, run)]]) { const target = node?.querySelector(selector); if (target && target.innerHTML !== html) target.innerHTML = html; }
    const process = node?.querySelector('.agent-process');
    if (process && run) {
      const summary = process.querySelector('summary span'); if (summary) summary.textContent = agentPhaseLabel(run);
      const accepted = process.querySelector('.agent-process-accepted');
      if (accepted) accepted.textContent = run.acceptedAt ? '云端已接收 · ' + agentUiStamp(run.acceptedAt) : '尚未收到云端接收回执';
    }
  }
  const banner = document.querySelector('#agent-connection-banner'); if (banner) { const html = agentUiBanner(thread); if (banner.innerHTML !== html) banner.innerHTML = html; }
  const subtitle = document.querySelector('.agent-header-subtitle'); if (subtitle) subtitle.textContent = '交互演示 · ' + agentUiConnectionLabel();
  const title = document.querySelector('.agent-header-title'); if (title) title.textContent = thread.title;
  const attachments = document.querySelector('#agent-draft-attachments'); if (attachments) { const html = agentUiAttachments(thread.attachments, thread.id, true); if (attachments.innerHTML !== html) attachments.innerHTML = html; }
  const send = document.querySelector('#agent-send-control'); if (send) { const html = agentUiSendControl(thread); if (send.innerHTML !== html) send.innerHTML = html; }
  const materials = document.querySelector('#agent-materials-panel'); if (materials && thread.view === 'materials') { const html = agentUiMaterials(thread); if (materials.innerHTML !== html) materials.innerHTML = html; }
  const results = document.querySelector('#agent-results-panel'); if (results && thread.view === 'results') { const html = agentUiResults(thread); if (results.innerHTML !== html) results.innerHTML = html; }
  const run = agentUiRun(thread), announcement = run ? agentPhaseLabel(run) : '';
  if (announcement !== agentLastAnnouncement) { agentLastAnnouncement = announcement; const live = document.querySelector('#agent-live-announcement'); if (live) live.textContent = announcement; }
  agentUiResizeComposer();
  if (followsEnd && thread.view === 'chat' && !document.querySelector('#sheet')?.open) requestAnimationFrame(() => agentUiScrollToEnd(id));
}
function setupAgentUI() {
  addEventListener('hub-agent-update', refreshAgentView);
  addEventListener('resize', agentUiResizeComposer);
  window.visualViewport?.addEventListener('resize', agentUiResizeComposer);
}
