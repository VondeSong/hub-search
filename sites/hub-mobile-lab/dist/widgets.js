'use strict';

// Browser-only widget interaction lab. No Android installation or host calls.
const widgetKinds = {
  recall: { title: '回顾一条', detail: '重新遇见值得留下的想法', icon: 'book', sizes: ['2x2', '4x2', '4x4'] },
  review: { title: '今日复习', detail: '从桌面接着复习', icon: 'cards', sizes: ['2x2', '4x2'] },
  capture: { title: '记一条', detail: '想到的时候，随手记下', icon: 'plus', sizes: ['2x2', '4x2'] }
};
let widgetScenariosOpen = false;

function widgetPreferences() {
  const raw = st.widgetPreview && typeof st.widgetPreview === 'object' ? st.widgetPreview : {};
  const kind = Object.hasOwn(widgetKinds, raw.kind) ? raw.kind : 'recall';
  return {
    kind,
    host: raw.host === 'desktop' ? 'desktop' : 'vault',
    tone: raw.tone === 'dark' ? 'dark' : 'light',
    size: widgetKinds[kind].sizes.includes(raw.size) ? raw.size : '4x2',
    scenario: ['ready', 'offline', 'empty', 'locked'].includes(raw.scenario) && !(kind === 'capture' && raw.scenario === 'empty') ? raw.scenario : 'ready',
    scopes: Array.isArray(raw.scopes) ? [...new Set(raw.scopes.filter(x => ['samples', 'local'].includes(x)))] : ['samples'],
    recallKey: typeof raw.recallKey === 'string' ? raw.recallKey : '',
    deck: raw.deck === '全部' || reviewDecks().includes(raw.deck) ? raw.deck : 'current'
  };
}

function widgetSet(patch, focusAction = '') {
  const old = st.widgetPreview;
  st.widgetPreview = { ...widgetPreferences(), ...patch };
  if (!save()) { st.widgetPreview = old; render(); return false; }
  render();
  if (focusAction) document.querySelector('[data-act="' + focusAction + '"]')?.focus({ preventScroll: true });
  return true;
}

function widgetRecallPool(p = widgetPreferences()) {
  const examples = p.scopes.includes('samples') ? ['d3', 'd5', 'd6', 'd8'].filter(id => docs[id]).map(id => ({
    key: 'doc/' + id, route: 'doc/' + id, text: docs[id].body, title: docs[id].t,
    date: docs[id].date, source: docs[id].s + ' · 示例', tag: docs[id].tag
  })) : [];
  const local = p.scopes.includes('local') ? st.notes.map(n => ({
    key: 'note/' + n.id, route: 'note/' + n.id,
    text: n.text || (recordAttachments(n).length ? '附件记录：' + recordAttachments(n).map(a => a.name).join('、') : n.title || '无正文记录'),
    title: n.title || '本机速记', date: recordDay(n), source: '此浏览器 · 本机速记', tag: journalTags(n.text)[0] || '随手记'
  })) : [];
  return [...local, ...examples];
}

function widgetReviewModel(p = widgetPreferences()) {
  const activeDeck = st.studyDeck === '全部' || reviewDecks().includes(st.studyDeck) ? st.studyDeck : '全部';
  const deck = p.deck === 'current' ? activeDeck : p.deck;
  const all = allReviewCards().filter(c => deck === '全部' || c.deck === deck);
  const remaining = all.filter(c => !st.reviewed.includes(c.id));
  return { deck, all, remaining, completed: all.length - remaining.length, resume: deck === st.studyDeck && (face || cardIndex > 0 || all.some(c => st.reviewed.includes(c.id))) };
}

function widgetScopeLabel(p) {
  return p.scopes.length === 2 ? '示例笔记 + 本机速记' : p.scopes[0] === 'local' ? '本机速记' : p.scopes[0] === 'samples' ? '示例笔记' : '未选择内容';
}

function widgetControl(label, action, active, extra = '') {
  return '<button type="button" data-act="' + action + '" aria-pressed="' + Boolean(active) + '"' + extra + '>' + label + '</button>';
}

function widgetCardHeader(name) {
  return '<div class="widget-card-header"><span class="widget-brand"><img src="hub.svg" alt="">Hub</span><span class="widget-card-name">' + esc(name) + '</span></div>';
}

function widgetPrimary(label, action, icon = 'chev') {
  return '<button type="button" class="widget-primary" data-act="' + action + '"><span>' + esc(label) + '</span>' + ico(icon, 16) + '</button>';
}

function widgetEmpty(icon, title, description, label, action) {
  return '<div class="widget-state-empty">' + ico(icon, 24) + '<h3>' + esc(title) + '</h3><p>' + esc(description) + '</p>' + widgetPrimary(label, action) + '</div>';
}

function widgetCard(p) {
  let body = '';
  const cacheNote = p.scenario === 'offline' ? '<p class="widget-cache-note">' + ico('cloud', 13) + (p.kind === 'capture' ? '离线状态预览 · 仍可记下' : '离线状态预览 · 显示本机内容') + '</p>' : '';
  if (p.scenario === 'locked') {
    body = widgetEmpty('link', '先打开 Hub', '设置好内容，再回来看看。', '查看连接说明', 'widget-connection');
  } else if (p.kind === 'recall') {
    const pool = widgetRecallPool(p), note = pool.find(n => n.key === p.recallKey) || pool[0];
    if (p.scenario === 'empty' || !note) {
      body = widgetEmpty('book', '留一点想法在这里', '这个范围还没有可回顾的内容。', '调整内容范围', 'widget-scope');
    } else {
      body = '<button type="button" class="widget-note-open" data-act="widget-open:' + encodeURIComponent(note.key) + '" aria-label="查看原文：' + esc(note.title) + '"><span class="widget-note-text">' + esc(note.text) + '</span><span class="widget-note-meta">' + esc([note.date, note.source].filter(Boolean).join(' · ')) + '</span></button>' +
        '<div class="widget-card-footer"><span class="widget-card-tag"># ' + esc(note.tag) + '</span><button type="button" class="widget-next" data-act="widget-next"' + (pool.length < 2 ? ' disabled' : '') + '>' + ico('sync', 15) + '<span>换一条</span></button></div>';
    }
  } else if (p.kind === 'review') {
    const m = widgetReviewModel(p), empty = p.scenario === 'empty' || !m.remaining.length;
    if (empty) {
      body = widgetEmpty('check', '今天复习好了', '给记忆一点时间，明天再见。', '查看牌库', 'widget-library');
    } else {
      body = '<div class="widget-review-count"><strong>' + m.remaining.length + '</strong><span>张待复习</span></div><p class="widget-review-copy">' + esc(m.deck === '全部' ? '全部牌组' : m.deck) + ' · 本轮已完成 ' + m.completed + ' / ' + m.all.length + '</p><div class="widget-progress-track" aria-hidden="true"><span style="width:' + (m.all.length ? Math.round(m.completed / m.all.length * 100) : 0) + '%"></span></div>' + widgetPrimary(m.resume ? '继续复习' : '开始复习', 'widget-study');
    }
  } else {
    const draft = workflowDraft('note');
    const hasDraft = Boolean(draft.text || recordAttachments(draft).length);
    body = '<div class="widget-capture-mark" aria-hidden="true">' + ico('plus', 27) + '</div><div class="widget-capture-copy"><h3>' + (hasDraft ? '接着写下去' : '记下刚刚想到的') + '</h3><p>' + (hasDraft ? '有一份还没记下的草稿' : '一句话，也值得留下。') + '</p></div>' + widgetPrimary(hasDraft ? '继续草稿' : '记一条', 'quick-capture:note', 'plus');
  }
  return '<article class="hub-widget" data-kind="' + p.kind + '" data-size="' + p.size + '" aria-label="' + esc(widgetKinds[p.kind].title) + '小组件预览">' + widgetCardHeader(widgetKinds[p.kind].title) + body + cacheNote + '</article>';
}

function widgetPhone(p) {
  const date = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  const companion = p.kind !== 'capture' ? '<button type="button" class="widget-companion" data-act="quick-capture:note"><span class="widget-brand"><img src="hub.svg" alt="">Hub</span><span class="widget-capture-mark">' + ico('plus', 23) + '</span><strong>记一条</strong><small>留住此刻的想法</small></button>' : '';
  return '<div class="widget-phone" data-host="' + p.host + '" data-tone="' + p.tone + '" data-size="' + p.size + '"><div class="widget-statusbar" aria-hidden="true"><span>9:41</span><span>' + ico('wifi', 16) + '<svg width="24" height="13" viewBox="0 0 24 13" fill="none"><rect x="1" y="1" width="19" height="11" rx="3" stroke="currentColor"/><rect x="3" y="3" width="15" height="7" rx="1.5" fill="currentColor"/><path d="M22 4v5" stroke="currentColor" stroke-width="2"/></svg></span></div><div class="widget-host-heading"><p>' + esc(date) + '</p><h2>' + (p.host === 'vault' ? '负一屏' : '我的桌面') + '</h2><span>留一点空间给自己</span></div><div class="widget-grid">' + widgetCard(p) + companion + '</div><div class="widget-home-indicator" aria-hidden="true"></div></div>';
}

function widgetPreviewPage() {
  const p = widgetPreferences();
  const readyNote = p.kind === 'capture' ? '点击记一条，打开现有速记输入。' : p.kind === 'review' ? '进入现有复习流程；预览本身不会产生评分。' : widgetRecallPool(p).length ? '点正文看原文，换一条重新遇见旧想法。' : '选择更多内容，或先记下一条。';
  const stateNote = { ready: readyNote, offline: '离线状态示意；使用本站已有内容，不切断网络。', empty: p.kind === 'review' ? '完成状态示意；现有牌库和复习进度保持原样。' : '空内容状态示意；已有记录仍然保留。', locked: '首次使用状态示意；本站不连接真实账户。' }[p.scenario];
  const scopes = p.kind === 'recall' ? '<div class="widget-control-group"><h3>回顾范围</h3><button type="button" class="widget-scope-button" data-act="widget-scope"><span>' + ico('folder', 17) + esc(widgetScopeLabel(p)) + '</span>' + ico('chev', 16) + '</button></div>' : p.kind === 'review' ? '<div class="widget-control-group"><label for="widget-deck">复习范围</label><select id="widget-deck"><option value="current"' + (p.deck === 'current' ? ' selected' : '') + '>沿用当前复习</option>' + ['全部', ...reviewDecks()].map((deck, i) => '<option value="' + i + '"' + (p.deck === deck ? ' selected' : '') + '>' + esc(deck === '全部' ? '全部牌组' : deck) + '</option>').join('') + '</select></div>' : '<p class="widget-selection-note">打开 Hub 的速记输入，自动接上未写完的草稿。</p>';
  return '<div class="widget-lab"><div class="widget-intro"><span class="eyebrow">HUB · 随手可及</span><h1>小组件预览</h1><p>让记录与回顾，离你近一点。</p></div><div class="widget-workbench"><div class="widget-preview-column"><div class="widget-host-switch widget-segment" role="group" aria-label="预览位置">' + widgetControl('小米负一屏', 'widget-host:vault', p.host === 'vault') + widgetControl('手机桌面', 'widget-host:desktop', p.host === 'desktop') + '</div>' + widgetPhone(p) + '<p class="widget-preview-caption">交互预览 · 布局示意 · 未添加到系统</p></div><aside class="widget-controls" aria-label="小组件选项"><div class="widget-control-group"><h2>选一个，试试看</h2><div class="widget-type-options" role="group" aria-label="小组件类型">' + Object.entries(widgetKinds).map(([key, kind]) => widgetControl(ico(kind.icon, 21) + '<span><strong>' + kind.title + '</strong><small>' + kind.detail + '</small></span>' + ico('check', 17), 'widget-kind:' + key, p.kind === key)).join('') + '</div></div><div class="widget-control-group"><h3>尺寸</h3><div class="widget-size-options" role="group" aria-label="组件尺寸">' + widgetKinds[p.kind].sizes.map(size => widgetControl('<span>' + size.replace('x', ' × ') + '</span>', 'widget-size:' + size, p.size === size)).join('') + '</div></div><div class="widget-control-group"><h3>外观</h3><div class="widget-tone-options" role="group" aria-label="预览主题">' + widgetControl('<span class="widget-tone-dot" data-tone="light"></span>浅色', 'widget-tone:light', p.tone === 'light') + widgetControl('<span class="widget-tone-dot" data-tone="dark"></span>深色', 'widget-tone:dark', p.tone === 'dark') + '</div></div>' + scopes + '<details class="widget-scenarios"' + (widgetScenariosOpen ? ' open' : '') + '><summary>体验不同状态</summary><div class="widget-state-options">' + [['ready', '正常'], ['offline', '离线缓存'], ...(p.kind === 'capture' ? [] : [['empty', p.kind === 'review' ? '复习完成' : '暂无内容']]), ['locked', '首次使用']].map(([value, title]) => widgetControl(title, 'widget-state:' + value, p.scenario === value)).join('') + '</div></details><p class="widget-selection-note" role="status">' + stateNote + '</p><button type="button" class="widget-help" data-act="widget-help">' + ico('info', 16) + '怎样放到手机上？' + ico('chev', 14) + '</button></aside></div></div>';
}

function widgetScopeSheet() {
  const p = widgetPreferences();
  sheet('回顾哪些内容', '<form id="widget-scope-form"><p class="lede">只从你选择的范围里换一条。</p><div class="group">' + [['samples', '本站示例笔记', '4 条已有示例，用来体验回顾'], ['local', '本机速记', st.notes.length + ' 条，保存在当前浏览器']].map(([value, title, desc]) => '<label class="setting-switch"><span><strong>' + title + '</strong><small>' + desc + '</small></span><input type="checkbox" name="widget-scope" value="' + value + '"' + (p.scopes.includes(value) ? ' checked' : '') + '></label>').join('') + '</div><p class="settings-note">均不勾选时显示空内容；不会自动改成全部资料。</p><div class="actions"><button type="submit" class="btn">应用范围</button>' + plain('取消', 'close') + '</div></form>');
}

function widgetSubmit(form) {
  if (form.id !== 'widget-scope-form') return false;
  const scopes = [...form.querySelectorAll('input[name="widget-scope"]:checked')].map(el => el.value);
  if (widgetSet({ scopes, recallKey: '', scenario: 'ready' })) { close(); tell('回顾范围已保存到此浏览器'); }
  return true;
}

function widgetChange(event) {
  if (event.target.id !== 'widget-deck') return false;
  const value = event.target.value;
  const deck = value === 'current' ? 'current' : ['全部', ...reviewDecks()][Number(value)];
  if (deck) { widgetSet({ deck }); document.querySelector('#widget-deck')?.focus({ preventScroll: true }); }
  return true;
}

function widgetAction(action, key) {
  if (!action.startsWith('widget-')) return false;
  const p = widgetPreferences(), actionKey = action + (key ? ':' + key : '');
  if (action === 'widget-kind' && Object.hasOwn(widgetKinds, key)) widgetSet({ kind: key, size: widgetKinds[key].sizes.includes(p.size) ? p.size : '4x2', scenario: key === 'capture' && p.scenario === 'empty' ? 'ready' : p.scenario }, actionKey);
  else if (action === 'widget-host' && ['vault', 'desktop'].includes(key)) widgetSet({ host: key }, actionKey);
  else if (action === 'widget-tone' && ['light', 'dark'].includes(key)) widgetSet({ tone: key }, actionKey);
  else if (action === 'widget-size' && widgetKinds[p.kind].sizes.includes(key)) widgetSet({ size: key }, actionKey);
  else if (action === 'widget-state' && ['ready', 'offline', 'empty', 'locked'].includes(key)) widgetSet({ scenario: key }, actionKey);
  else if (action === 'widget-next') {
    const pool = widgetRecallPool(p), index = Math.max(0, pool.findIndex(n => n.key === p.recallKey));
    if (pool.length > 1 && widgetSet({ recallKey: pool[(index + 1) % pool.length].key }, action)) tell('已换一条回顾');
  } else if (action === 'widget-open') {
    let decoded; try { decoded = decodeURIComponent(key); } catch { return true; }
    const note = widgetRecallPool(p).find(n => n.key === decoded);
    if (note) { if (p.recallKey !== note.key) widgetSet({ recallKey: note.key }); go(note.route); }
  } else if (action === 'widget-study') {
    const m = widgetReviewModel(p);
    if (!m.remaining.length) { go('review'); return true; }
    if (m.deck !== st.studyDeck) {
      const prior = { deck: st.studyDeck, face, index: cardIndex };
      st.studyDeck = m.deck; face = false; cardIndex = 0;
      if (!save()) { st.studyDeck = prior.deck; face = prior.face; cardIndex = prior.index; return true; }
    }
    go('study');
  } else if (action === 'widget-library') { reviewTab = 'library'; go('review'); }
  else if (action === 'widget-scope') widgetScopeSheet();
  else if (action === 'widget-connection') sheet('先在 Hub 中准备内容', '<p class="prose">正式小组件需要先打开 Hub，选好本机内容或完成同步设置。</p><p class="settings-note">当前是首次使用状态的网页示意，不会连接真实账户。</p><div class="actions">' + btn('查看连接总览', 'go:connections') + plain('返回预览', 'close') + '</div>');
  else if (action === 'widget-help') sheet('从预览到手机小组件', '<p class="prose">这里可以体验外观、换一条、查看原文，以及进入速记和复习。</p>' + section('下一步', '<p class="prose">实际放到手机上，需要把小组件实现到 Hub Android 测试包，再在桌面和小米负一屏分别验证添加、点击与刷新。</p><p class="settings-note">先测试，再考虑公开上架。当前 HyperOS 负一屏的未发布组件测试入口仍待确认；本网页不能完成系统添加。</p>') + '<div class="actions">' + btn('继续体验', 'close') + '</div>');
  return true;
}
