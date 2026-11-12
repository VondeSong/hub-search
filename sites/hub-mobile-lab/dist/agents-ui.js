'use strict';

// The Agents prototype renders only local demo state. No model or host is contacted.
let agentListQuery = '';
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
  return '个人云端 · 在线';
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
  const threads = [...st.agents.threads].sort((a, b) => b.updatedAt - a.updatedAt).filter(thread => (thread.title + ' ' + thread.messages.map(m => m.text || '').join(' ')).toLowerCase().includes(agentListQuery.toLowerCase()));
  if (!threads.length) return '<div class="empty-state">' + ico('chat', 28) + '<h2>没有找到这段对话</h2><p>换一个词，或从一个新问题开始。</p>' + btn('新建对话', 'agent-new', 'secondary', 'plus') + '</div>';
  return threads.map(thread => {
    const last = thread.messages.at(-1), run = agentUiRun(thread);
    const preview = agentUiRunning(run) ? agentPhaseLabel(run) : (last?.text || thread.draft || (thread.attachments.length ? '已选好材料，写下你的问题。' : '从一个问题开始。'));
    return '<button type="button" class="agent-thread-row" data-act="go:agent-chat/' + esc(thread.id) + '"><span class="agent-thread-icon">' + ico(thread.id.includes('harness') ? 'folder' : thread.id.includes('reading') ? 'book' : 'chat', 20) + '</span><span class="agent-thread-copy"><strong>' + esc(thread.title) + '</strong><small>' + esc(preview.replace(/\s+/g, ' ').slice(0, 58)) + '</small></span><span class="agent-thread-meta"><time>' + esc(agentUiStamp(thread.updatedAt)) + '</time>' + (agentUiRunning(run) ? '<span class="agent-phase">' + esc(agentPhaseLabel(run)) + '</span>' : ico('chev', 15)) + '</span></button>';
  }).join('');
}
function agentsPage() {
  if (agentUiRevoked()) return '<div class="agents-page">' + intro('Agents', '你的云端对话') + agentUiAccessBlock() + '</div>';
  return '<div class="agents-page"><div class="agents-heading"><h1>Agents</h1><span class="fine">标准模式</span></div><p class="lede">在手机上开始，随时接着聊。</p><div id="agent-list-connection">' + agentUiConnectionCard() + '</div><p class="agent-demo-note">交互演示 · 对话与附件保存在当前浏览器</p><div class="agent-list-search">' + ico('search', 19) + '<input type="search" id="agent-list-query" aria-label="搜索云端对话" placeholder="搜索对话" value="' + esc(agentListQuery) + '"></div>' + section('最近对话', '<div id="agent-thread-list">' + agentThreadRows() + '</div>', plain('新对话', 'agent-new', 'plus')) + '<p class="settings-note">这里展示新建云端会话的使用方式。已有桌面聊天和资料库不会自动迁入。</p></div>';
}
function agentsHeader(page, id) {
  if (page === 'agent-chat') {
    const thread = agentThread(id);
    return iconBtn('返回', 'back', 'back') + '<button type="button" class="agent-header-main" data-act="go:agent-connection" aria-label="查看云端连接与设备"><span class="agent-header-title">' + esc(agentUiRevoked() ? 'Agents' : thread?.title || '对话') + '</span><span class="agent-header-subtitle">交互演示 · ' + esc(agentUiConnectionLabel()) + '</span></button>' + iconBtn('会话选项', 'agent-thread-menu:' + id, 'more');
  }
  if (page === 'agent-connection') return iconBtn('返回', 'back', 'back') + '<span class="top-title">连接与设备</span><span class="agent-header-spacer" aria-hidden="true"></span>';
  return iconBtn('返回', 'back', 'back') + '<span class="top-title">Hub</span>' + iconBtn('新建对话', 'agent-new', 'plus');
}
function agentUiBanner(thread) {
  const c = agentUiConnection(), run = agentUiRun(thread);
  let title = '', copy = '', action = '';
  if (c.network === 'offline') { title = '手机离线'; copy = run?.phase === 'queued' ? '这条消息仅暂存在本机，还没有送达云端。' : '保留已收到的内容。已接收的任务不会因断网自动停止。'; action = plain('恢复演示网络', 'agent-connection:network:online', 'sync'); }
  else if (c.server === 'offline') { title = '暂时连不上个人云端'; copy = '执行结果尚未确认。恢复后查询原请求，不会再次发起生成。'; action = plain('恢复演示服务', 'agent-connection:server:online', 'sync'); }
  else if (c.auth === 'expired') { title = 'ChatGPT 登录已失效'; copy = '新消息尚未执行。请在执行端重新登录，再继续原请求。'; action = plain('查看登录恢复', 'agent-login-help', 'link'); }
  else if (c.quota === 'exhausted') { title = '订阅额度不足'; copy = '新消息尚未执行。不会切换其他账号或启用按量 API。'; action = plain('查看额度', 'agent-quota', 'info'); }
  else if (run?.phase === 'unknown') { title = '正在确认原请求'; copy = '恢复连接后补齐同一次运行的结果。'; action = plain('查询原结果', 'agent-recover', 'sync'); }
  if (!title) return '<p class="agent-demo-note">交互演示 · 使用本次对话与选定材料</p>';
  return '<div class="agent-banner is-warning"><strong>' + title + '</strong><p>' + copy + '</p>' + action + '</div>';
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
  if (!run || run.phase !== 'completed') return '';
  return plain(run.resultNoteId ? '查看已存笔记' : '保存为笔记', 'agent-save:' + run.id, 'note') + plain('继续追问', 'agent-followup:' + run.threadId, 'chat');
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
  return runs.map(run => '<article class="agent-result-card"><span class="eyebrow">示例成果 · ' + esc(agentUiStamp(run.finishedAt)) + '</span><h2>' + esc(thread.title) + '</h2><div class="agent-result-body">' + agentUiText(run.text || run.answer) + '</div>' + agentUiCitations({ citations: run.citations || [] }, run) + '<div class="actions">' + btn(run.resultNoteId ? '查看已存笔记' : '保存为笔记', 'agent-save:' + run.id, 'secondary', 'note') + '</div></article>').join('');
}
function agentUiSendControl(thread) {
  const run = thread.activeRunId && st.agents.runs[thread.activeRunId];
  if (run && ['accepted', 'running', 'unknown', 'stop_pending'].includes(run.phase)) return agentUiActionButton(run.phase === 'stop_pending' ? '等待停止确认' : '停止', 'agent-stop:' + run.id, 'agent-stop-button', 'stop', run.phase === 'stop_pending');
  if (run?.phase === 'queued') return agentUiActionButton('发送原请求', 'agent-retry:' + run.id, 'agent-send-button', 'arrowUp');
  return '<button type="submit" class="agent-send-button" aria-label="发送消息" ' + (agentAttachmentReading ? 'disabled' : '') + '>' + ico('arrowUp', 21) + '<span>发送</span></button>';
}
function agentUiComposer(thread) {
  return '<div id="agent-composer" class="agent-composer"><div id="agent-draft-attachments">' + agentUiAttachments(thread.attachments, thread.id, true) + '</div><form id="agent-send-form" data-thread="' + esc(thread.id) + '"><label class="agent-sr-only" for="agent-prompt">给 Agents 的消息</label><textarea id="agent-prompt" name="message" rows="2" maxlength="6000" placeholder="问一个问题，或接着聊…" enterkeyhint="enter">' + esc(thread.draft || '') + '</textarea><div class="agent-composer-tools">' + iconBtn('添加照片或资料', 'agent-attach:' + thread.id, 'plus') + '<button type="button" class="agent-model-trigger" data-act="agent-model"><span>Codex</span><small>标准</small>' + ico('chev', 13) + '</button><div id="agent-send-control">' + agentUiSendControl(thread) + '</div></div></form><div class="agent-composer-hint"><span id="agent-draft-status">' + (thread.draft ? '草稿已保留' : '交互演示 · 未调用模型') + '</span><span>ChatGPT 订阅</span></div></div>';
}
function agentChatPage(id) {
  const thread = agentThread(id);
  if (!thread) return '<div class="agent-chat-page">' + intro('这段对话暂不可用', '返回列表，选择一段已保存的会话。') + btn('返回 Agents', 'go:agents', 'secondary') + '</div>';
  if (agentUiRevoked()) return '<div class="agent-chat-page">' + agentUiAccessBlock() + '</div>';
  const view = ['chat', 'materials', 'results'].includes(thread.view) ? thread.view : 'chat';
  return '<div class="agent-chat-page" data-thread="' + esc(id) + '"><div class="agent-view-tabs" aria-label="会话视图">' + [['chat', '对话'], ['materials', '材料'], ['results', '成果']].map(([key, label]) => '<button type="button" data-act="agent-view:' + esc(id) + ':' + key + '" aria-pressed="' + (key === view) + '">' + label + '</button>').join('') + '</div><div id="agent-connection-banner">' + agentUiBanner(thread) + '</div><div id="agent-chat-panel" ' + (view !== 'chat' ? 'hidden' : '') + '><div id="agent-messages" role="log" aria-label="会话消息" aria-live="off">' + agentUiMessages(thread) + '</div><div id="agent-message-end"></div>' + agentUiComposer(thread) + '</div><div id="agent-materials-panel" ' + (view !== 'materials' ? 'hidden' : '') + '>' + agentUiMaterials(thread) + '</div><div id="agent-results-panel" ' + (view !== 'results' ? 'hidden' : '') + '>' + agentUiResults(thread) + '</div><p id="agent-live-announcement" class="agent-sr-only" role="status" aria-live="polite"></p></div>';
}
function agentConnectionPage() {
  const c = agentUiConnection();
  const stateRow = (label, value, action, icon = 'info') => row(label, value, icon, action);
  return '<div class="agent-connection-page">' + intro('个人云端', '手机上的对话，交给云端继续。') + '<div id="agent-connection-overview">' + agentUiConnectionCard() + '</div>' +
    section('连接与订阅', '<div class="agent-settings-list">' + group(stateRow('执行位置', c.server === 'online' ? '个人 VPS · 服务可达（演示）' : '个人 VPS · 暂不可达（演示）', 'agent-service-info', 'sync') + stateRow('ChatGPT 订阅', c.auth === 'valid' ? '已登录（演示）· 凭据保留在执行端' : '登录失效 · 需要在执行端重新登录', 'agent-login-help', 'star') + stateRow('额度信息', c.quota === 'exhausted' ? '额度不足（演示）· 新请求未执行' : c.quota === 'available' ? '可用（演示）· 不展示虚构百分比' : '未知 · 服务未提供余额信息', 'agent-quota', 'info') + stateRow('这台手机', c.device === 'active' ? '已配对（演示）· 仅持有 Hub 设备身份' : '访问已撤销（演示）· 无法读取云端会话', 'agent-device-info', 'settings')) + '</div>') +
    section('电脑与资料', group(stateRow('Windows 电脑', c.windows === 'offline' ? '当前关机 · 不影响新云端对话' : '当前在线 · 云端会话仍在 VPS 执行', 'agent-windows-info', 'folder'))) +
    '<p class="settings-note">新云端会话可供后续桌面 Hub 回读。已有桌面聊天、电脑资料库与桌面工具不会自动接入。</p>' +
    section('体验不同状态', '<p class="fine">以下仅切换原型演示，不会修改实际服务器或账号。</p><div class="agent-scenarios">' +
      [['network', c.network === 'offline' ? 'online' : 'offline', c.network === 'offline' ? '恢复手机网络' : '手机断网'], ['server', c.server === 'offline' ? 'online' : 'offline', c.server === 'offline' ? '恢复云端服务' : 'VPS 暂不可达'], ['auth', c.auth === 'expired' ? 'valid' : 'expired', c.auth === 'expired' ? '模拟登录恢复' : '登录失效'], ['quota', c.quota === 'exhausted' ? 'unknown' : 'exhausted', c.quota === 'exhausted' ? '恢复可发送状态' : '额度不足'], ['device', c.device === 'revoked' ? 'active' : 'revoked', c.device === 'revoked' ? '模拟重新配对' : '撤销设备'], ['windows', c.windows === 'offline' ? 'online' : 'offline', c.windows === 'offline' ? 'Windows 开机' : 'Windows 关机']].map(([key, value, label]) => btn(label, 'agent-connection:' + key + ':' + value, 'outline')).join('') + '</div><div class="actions">' + plain('恢复全部演示连接', 'agent-reset-connection', 'sync') + '</div>') +
    '<p class="agent-demo-note">本原型不连接真实 VPS，不保存 Codex 登录凭据，不产生模型调用费用。</p></div>';
}

function agentUiDocAttachment(id) {
  return agentDocMaterial(id);
}
function agentUiAttachDocument(threadId, docId) {
  const thread = agentThread(threadId), a = agentUiDocAttachment(docId);
  if (!thread || !a || agentUiRevoked()) return;
  if (thread.attachments.some(x => x.kind === 'doc' && x.docId === docId)) { tell('这份资料已在待发送材料中'); return; }
  const previous = [...thread.attachments];
  thread.attachments.push(a);
  if (!save()) { thread.attachments = previous; return; }
  close(); refreshAgentView(); tell('已附上这份资料');
}
function agentUiAttachmentSheet(threadId) {
  const thread = agentThread(threadId);
  if (!thread || agentUiRevoked()) return;
  sheet('添加材料', '<div class="agent-attachment-menu">' + group(row('拍照', '使用系统相机，返回后可预览', 'camera', 'agent-pick:' + threadId + ':camera') + row('从相册选择', '图片保留在此浏览器，不上传模型', 'image', 'agent-pick:' + threadId + ':photos') + row('选择一份资料', '只带入你明确选中的内容', 'note', 'agent-select-doc:' + threadId) + row('关键帧示例', '实验交互 · 0、1、2 秒三帧', 'video', 'agent-frame-example:' + threadId)) + '</div><input type="file" id="agent-camera-input" data-thread="' + esc(threadId) + '" accept="image/jpeg,image/png,image/webp,image/gif" capture="environment" hidden><input type="file" id="agent-photo-input" data-thread="' + esc(threadId) + '" accept="image/jpeg,image/png,image/webp,image/gif" multiple hidden><p id="agent-attachment-feedback" class="fine" role="status"></p><p class="settings-note">原型最多附 3 张图片，每张不超过 2 MB。视频入口只提供关键帧示例，不上传或理解完整视频。</p>');
}
function agentUiSelectDocSheet(threadId) {
  if (!agentThread(threadId) || agentUiRevoked()) return;
  const local = st.notes.slice(0, 5), ids = ['d5', 'd3', 'd7', 'd1', 'd2'];
  sheet('选择资料', '<p class="lede">只把选中的这一份内容带入对话。</p><div class="agent-doc-choice">' + group(ids.map(id => row(docs[id].t, docs[id].s + ' · ' + docs[id].date, 'note', 'agent-add-doc:' + threadId + ':' + id)).join('') + local.map(n => row(n.title || n.text.slice(0, 40), '本地记录 · ' + n.date, 'note', 'agent-add-doc:' + threadId + ':' + n.id)).join('')) + '</div>');
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
  const safe = /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(a.dataUrl || '');
  sheet(agentUiAttachmentLabel(a), a.kind === 'frame' ? '<div class="agent-frame-strip"><div class="agent-frame" data-frame="' + esc(a.color || ['red', 'green', 'blue'][Number(a.time) % 3] || 'red') + '"><strong>' + esc(a.time ?? 0) + ' 秒</strong></div></div><p class="settings-note">合成关键帧示例。回答只能覆盖采样帧，不能判断帧间的短暂动作。</p>' : (safe ? '<img class="agent-image-preview" src="' + esc(a.dataUrl) + '" alt="' + esc(agentUiAttachmentLabel(a)) + '">' : '<p class="info">此图片预览暂不可用。</p>') + '<p class="settings-note">仅在本机预览，本原型没有分析图片内容。</p>');
}
async function agentUiReadImages(input) {
  const files = [...(input.files || [])], threadId = input.dataset.thread, thread = agentThread(threadId);
  if (!files.length || !thread || agentUiRevoked()) return;
  if (agentAttachmentReading) return;
  const imageCount = thread.attachments.filter(a => ['image', 'frame'].includes(a.kind)).length;
  if (imageCount + files.length > 3) { tell('原型一次最多附 3 张图片，请减少选择。'); return; }
  if (files.some(file => !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type))) { tell('原型支持 JPG、PNG、WebP 或 GIF 图片。'); return; }
  if (files.some(file => file.size > 2 * 1024 * 1024)) { tell('这张图片超过原型的 2 MB 限制，请选择较小的图片。'); return; }
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
    if (!live || agentUiRevoked()) throw new Error('设备访问状态已变化，图片没有加入会话。');
    if (live.attachments.filter(a => ['image', 'frame'].includes(a.kind)).length + loaded.length > 3) throw new Error('已选图片发生变化，请减少数量后重试。');
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
  if (!agentThread(threadId) || agentUiRevoked()) return;
  sheet('关键帧示例', '<p class="prose">只把 0、1、2 秒的三张采样帧送入对话，明确保留时间戳。</p><div class="agent-frame-strip">' + ['red', 'green', 'blue'].map((color, index) => '<div class="agent-frame" data-frame="' + color + '"><strong>' + index + ' 秒</strong></div>').join('') + '</div><p class="info">这不是完整视频理解。采样之间发生的动作可能被遗漏，声音也没有被转写。</p><div class="actions">' + btn('附上这 3 帧示例', 'agent-add-frames:' + threadId, '', 'plus') + '</div>');
}
function handleAgentAction(action, key, value) {
  if (!action.startsWith('agent-')) return false;
  const thread = agentThread(key);
  if (action === 'agent-new') { const result = agentCreateThread(); if (agentUiFeedback(result)) go('agent-chat/' + result.threadId); return true; }
  if (action === 'agent-view') { if (thread && ['chat', 'materials', 'results'].includes(value)) { thread.view = value; save(); render(); } return true; }
  if (action === 'agent-attach') { agentUiAttachmentSheet(key); return true; }
  if (action === 'agent-select-doc') { agentUiSelectDocSheet(key); return true; }
  if (action === 'agent-add-doc') { agentUiAttachDocument(key, value); return true; }
  if (action === 'agent-pick') { if (!agentUiRevoked()) document.querySelector(value === 'camera' ? '#agent-camera-input' : '#agent-photo-input')?.click(); return true; }
  if (action === 'agent-material') { if (!agentUiRevoked()) agentUiShowAttachment(key, value); return true; }
  if (action === 'agent-remove') {
    if (thread && !agentUiRevoked()) { const previous = [...thread.attachments]; thread.attachments = thread.attachments.filter(a => a.id !== value); if (!save()) thread.attachments = previous; refreshAgentView(); }
    return true;
  }
  if (action === 'agent-frame-example') { agentUiFrames(key); return true; }
  if (action === 'agent-add-frames') {
    if (!thread || agentUiRevoked()) return true;
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
    if (!thread || agentUiRevoked()) return true;
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
  if (action === 'agent-save') { const result = agentSaveResult(key); if (agentUiFeedback(result, result?.reused ? '' : '已保存为本地笔记')) { if (result.reused) go('doc/' + result.noteId); else refreshAgentView(); } return true; }
  if (action === 'agent-followup') { if (thread) { thread.view = 'chat'; save(); render(); document.querySelector('#agent-prompt')?.focus(); } return true; }
  if (action === 'agent-connection') { agentUiFeedback(agentSetConnection(key, value)); refreshAgentView(); if (route()[0] === 'agent-connection') render(); return true; }
  if (action === 'agent-reset-connection') { for (const [k, v] of Object.entries({ network: 'online', server: 'online', auth: 'valid', quota: 'unknown', device: 'active', windows: 'offline' })) agentSetConnection(k, v); agentRecover(); render(); tell('演示连接已恢复，待发送消息仍由你确认发送'); return true; }
  if (action === 'agent-model') { sheet('模型与模式', '<div class="agent-model-card"><span class="eyebrow">ChatGPT 订阅</span><h3>gpt-6.1-sol</h3><p class="prose">标准模式，适合手机上的文字、图片和多轮对话。</p>' + tag('当前模型', 'blue') + '</div><p class="settings-note">正式接入后，模型列表以执行端返回为准。登录失效或额度不足时，不会自动换账号或启用按量 API。</p><div class="actions">' + btn('完成', 'close', 'wide') + '</div>'); return true; }
  if (action === 'agent-login-help') { sheet('订阅登录', '<p class="prose">Codex 使用执行端的 ChatGPT 登录。手机只连接 Hub，不保存或复制 Codex 登录令牌。</p><p class="info">登录失效时，先在 VPS 完成官方授权，再回到手机继续原请求。</p><div class="actions">' + btn('模拟登录恢复', 'agent-login-restore', 'secondary') + '</div><p class="settings-note">本按钮只恢复演示状态，不会登录任何真实账号。</p>'); return true; }
  if (action === 'agent-login-restore') { if (agentUiFeedback(agentSetConnection('auth', 'valid'))) { close(); refreshAgentView(); if (route()[0] === 'agent-connection') render(); tell('演示登录已恢复，可以重试原请求'); } return true; }
  if (action === 'agent-quota') { const c = agentUiConnection(); sheet('订阅额度', '<div class="agent-model-card"><span class="eyebrow">ChatGPT 订阅 · 演示</span><h3>' + (c.quota === 'exhausted' ? '额度不足' : '暂无可展示的额度读数') + '</h3><p class="prose">' + (c.quota === 'exhausted' ? '新请求尚未执行，原消息与材料保留。额度恢复后再重试。' : '只有执行端能读取的额度信息才会显示。未知不会显示成 100% 或无限。') + '</p></div><p class="settings-note">不自动切换账号，不启用按量 API。单次请求的具体扣额以可获取的实际信息为准。</p>' + (c.quota === 'exhausted' ? '<div class="actions">' + btn('模拟额度恢复', 'agent-quota-restore', 'secondary') + '</div>' : '')); return true; }
  if (action === 'agent-quota-restore') { if (agentUiFeedback(agentSetConnection('quota', 'unknown'))) { close(); refreshAgentView(); if (route()[0] === 'agent-connection') render(); tell('已恢复演示可发送状态，额度读数仍未知'); } return true; }
  if (action === 'agent-device-info') { sheet('这台手机', '<p class="prose">手机使用可撤销的 Hub 设备凭据。撤销后不能读取云端会话或发送新消息。</p><p class="info">原型中可通过“体验不同状态”模拟撤销和重新配对。</p><div class="actions">' + btn('完成', 'close', 'wide') + '</div>'); return true; }
  if (action === 'agent-service-info') { sheet('个人云端', '<p class="prose">手机连接 VPS 上的 Hub 服务，由 VPS 内部运行 Codex app-server。会话、附件和运行状态由正式云端服务保存。</p><p class="info">本原型仅在浏览器演示这些交互，没有连接真实 VPS。</p><div class="actions">' + btn('完成', 'close', 'wide') + '</div>'); return true; }
  if (action === 'agent-windows-info') { sheet('Windows 与云端', '<p class="prose">新云端对话在 VPS 执行，所以 Windows 关机也不影响继续提问。</p><p class="info">访问电脑上的私有资料与桌面工具仍是后续范围；现有桌面聊天不会自动迁移。</p><div class="actions">' + btn('完成', 'close', 'wide') + '</div>'); return true; }
  if (action === 'agent-thread-menu') { sheet('会话选项', group(row('连接与设备', '查看云端、订阅与恢复方式', 'sync', 'go:agent-connection') + row('返回会话列表', '运行状态会保留', 'chat', 'go:agents')) + '<p class="settings-note">可以离开这页再回来。原型按同一次请求恢复演示结果，不重复启动生成。</p>'); return true; }
  return false;
}
function handleAgentInput(event) {
  const input = event.target;
  if (input.id === 'agent-list-query') { agentListQuery = input.value; const list = document.querySelector('#agent-thread-list'); if (list) list.innerHTML = agentThreadRows(); return true; }
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
  if (['agent-camera-input', 'agent-photo-input'].includes(event.target.id)) { void agentUiReadImages(event.target); return true; }
  return false;
}
function handleAgentSubmit(form) {
  if (form.id !== 'agent-send-form') return false;
  const thread = agentThread(form.dataset.thread);
  if (!thread || agentUiRevoked()) return true;
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
    const card = document.querySelector('#agent-list-connection'); if (card) { const html = agentUiConnectionCard(); if (card.innerHTML !== html) card.innerHTML = html; }
    return;
  }
  if (page !== 'agent-chat') return;
  const thread = agentThread(id); if (!thread) return;
  if (agentUiRevoked()) { if (!document.querySelector('.agent-access-block')) render(); return; }
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
