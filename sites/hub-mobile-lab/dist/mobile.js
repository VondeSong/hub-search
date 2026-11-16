'use strict';

// Shared mobile shell: appearance, viewport, draft-safe dialogs, and reading tools.
let mobileSheetFocus = null;
let mobileLockedScroll = null;
let mobileClosingSheet = false;
let mobileViewportBaseline = 0;
let mobileViewTimer;

function mobilePreferences() {
  const defaults = { theme: 'light', accent: 'blue', largeText: false, reduceTransparency: false };
  st.preferences = { ...defaults, ...st.preferences };
  return st.preferences;
}
function applyAppearance() {
  const p = mobilePreferences();
  const root = document.documentElement;
  root.dataset.theme = ['light', 'dark', 'paper'].includes(p.theme) ? p.theme : 'light';
  root.dataset.accent = ['blue', 'sage', 'violet'].includes(p.accent) ? p.accent : 'blue';
  root.dataset.reduceTransparency = String(Boolean(p.reduceTransparency));
  root.style.setProperty('--reader-font-size', p.largeText ? '19px' : '17px');
  document.querySelector('meta[name="theme-color"]').content = p.theme === 'dark' ? '#090a0b' : p.theme === 'paper' ? '#f6f3ed' : '#ffffff';
}
function appearancePage() {
  const p = mobilePreferences();
  const theme = (key, title, description) => '<button type="button" class="theme-option" data-preview="' + key + '" data-act="theme:' + key + '" aria-pressed="' + (p.theme === key) + '"><span class="theme-preview" aria-hidden="true"><span></span><span></span><span></span></span><strong>' + title + '</strong><small>' + description + '</small></button>';
  return intro('外观与阅读', '让内容和你习惯的节奏相配。') +
    section('页面底色', '<div class="theme-options">' + theme('light', '纯白', '清晰、轻盈') + theme('dark', '纯黑', '安静地夜读') + theme('paper', '暖纸', '柔和一点') + '</div>') +
    section('强调色', '<div class="accent-options">' + [['blue', '湖蓝'], ['sage', '鼠尾草'], ['violet', '鸢尾紫']].map(([key, label]) => '<button type="button" class="accent-swatch" data-color="' + key + '" data-act="accent:' + key + '" aria-pressed="' + (p.accent === key) + '"><span aria-hidden="true"></span>' + label + (p.accent === key ? ico('check', 16) : '') + '</button>').join('') + '</div>') +
    section('阅读偏好', group('<label class="setting-switch"><span><strong>较大正文</strong><small>文档和阅读内容使用更大字号</small></span><input type="checkbox" data-pref="largeText" ' + (p.largeText ? 'checked' : '') + '></label><label class="setting-switch"><span><strong>减少透明效果</strong><small>导航和工具条使用实色背景</small></span><input type="checkbox" data-pref="reduceTransparency" ' + (p.reduceTransparency ? 'checked' : '') + '></label>')) +
    '<div class="reader-preview"><span class="eyebrow">阅读预览</span><h2>留出可回看的记录</h2><p class="prose">先记下一句它与当前问题的关系。下一次打开时，这句话就能带你回到当时的思路。</p></div>';
}
function settingsPage() {
  return intro('设置', '连接、数据与阅读偏好。') +
    section('数据', group(row('连接总览', '内容同步与 Agents 会话分别查看', 'cloud', 'go:connections') + row('同步状态与范围', '速记、阅读、闪卡与异常重试', 'sync', 'go:sync') + row('资料库', '资料库、空间与分组的多选范围', 'folder', 'go:libraries'))) +
    section('偏好', group(row('外观与阅读', '页面底色、字号与透明效果', 'settings', 'go:appearance') + row('小组件预览', '在桌面和负一屏体验回顾、复习与速记', 'cards', 'go:widgets'))) +
    section('关于', group(row('后续功能', '桌面协作、工作专题与历史演示', 'spark', 'go:future') + row('功能与边界', '已实现交互、演示能力与后续验收', 'info', 'go:guide'))) +
    '<p class="settings-note">手机交互原型。记录与附件保存在当前浏览器，不读取实际云连接，不写入个人 OS。</p><div class="actions">' + plain('重置演示数据','reset') + '</div>';
}
function mobileRootHeader(page) {
  const action=page==='tasks'?btn('新任务','task-new','header-create','plus'):page==='agents'?btn('新对话','agent-new','header-create','plus'):iconBtn('快速速记','quick-capture:note','plus');
  return '<div class="root-heading"><h1 class="root-title">'+esc(routes[page])+'</h1><span class="sample-label">示例</span></div><div class="top-actions">'+iconBtn('空间与设置','mobile-space','settings')+action+'</div>';
}
function mobileSpaceSheet() {
  sheet('Hub · 示例空间','<p class="space-description">在同一个地方找回内容、记下想法，接着处理手头的事。</p><div class="space-menu">'+group(row('快速速记','保留当前草稿与附件','plus','quick-capture:note')+row('资料库','','folder','go:libraries')+row('连接总览','','cloud','go:connections')+row('外观与阅读','','settings','go:appearance')+row('设置','','more','go:settings')+row('功能与边界','','info','go:guide'))+'</div><p class="fine">本原型使用示例资料；本机记录保存在当前浏览器。</p>');
}
function mobileHandleAction(a, k) {
  if(a==='mobile-space'){mobileSpaceSheet();return true;}
  if (a === 'theme' || a === 'accent') {
    const allowed = a === 'theme' ? ['light', 'dark', 'paper'] : ['blue', 'sage', 'violet'];
    if (!allowed.includes(k)) return true;
    mobilePreferences()[a] = k;
    const saved = save();
    applyAppearance(); render();
    document.querySelector('[data-act="' + a + ':' + k + '"]')?.focus({ preventScroll: true });
    if (!saved) tell('外观已切换，浏览器暂时无法保存偏好。');
    return true;
  }
  if (a === 'tab') {
    if (!navs.some(x => x[0] === k)) return true;
    if (route()[0] === k) {
      if (k === 'search') $('#query')?.focus(); else window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } else go(k);
    return true;
  }
  if (a === 'clear-query') { query = ''; render(); $('#query')?.focus(); mobileRememberView(); return true; }
  if (a === 'clear-search') { query = ''; source = '全部资料库'; searchDate = '不限日期'; searchFolder = '全部分组'; searchType = '全部类型'; render(); mobileRememberView(); return true; }
  if (a === 'doc-source') {
    const noteOnly = route()[0] === 'note' || k.startsWith('note/'), id = k.startsWith('note/') ? k.slice(5) : k;
    const d = noteOnly ? null : docs[id], local = d ? null : st.notes.find(n => n.id === id);
    sheet('资料出处', '<p class="prose">' + esc(d ? d.s + ' · ' + d.t : local?.title || '本地快速记录') + '</p><p class="info">' + (d ? '这是一份示例资料，保留了来源与日期，没有连接真实资料库。' : '此内容由你保存在当前浏览器。') + '</p>' + (local?.url && /^https?:\/\//i.test(local.url) ? '<p class="prose"><a href="' + esc(local.url) + '" target="_blank" rel="noopener noreferrer">打开保存的链接 ' + ico('link', 16) + '</a></p>' : ''));
    return true;
  }
  if (a === 'doc-tools') {
    const starred = st.stars[k] ?? k === 'd3';
    sheet('这篇资料', group(row(starred ? '取消收藏' : '收藏', '保存在当前浏览器', 'star', 'reader-star:' + k) + row('复制文字', '复制这篇资料的正文', 'note', 'copy-doc:' + k) + row('带着资料提问', '仅附上这篇资料，开始云端会话', 'chat', 'ask:' + k)));
    return true;
  }
  if (a === 'reader-star') { st.stars[k] = !(st.stars[k] ?? k === 'd3'); close(); changed(st.stars[k] ? '已收藏' : '已取消收藏'); return true; }
  if (a === 'copy-doc') {
    const noteOnly = k.startsWith('note/') || route()[0] === 'note', id = k.startsWith('note/') ? k.slice(5) : k;
    const d = noteOnly ? null : docs[id], local = d ? null : st.notes.find(n => n.id === id);
    const text = d ? d.t + '\n\n' + d.body : local?.text || '';
    if (!navigator.clipboard?.writeText) { sheet('复制正文', '<div class="field"><label for="copy-text">长按文字即可选择并复制</label><textarea id="copy-text" readonly>' + esc(text) + '</textarea></div>'); return true; }
    navigator.clipboard.writeText(text).then(() => { close(); tell('正文已复制'); }).catch(() => { sheet('复制正文', '<p class="fine">浏览器未允许直接复制。可以选择下方文字。</p><div class="field"><label for="copy-text">正文</label><textarea id="copy-text" readonly>' + esc(text) + '</textarea></div>'); });
    return true;
  }
  if (a === 'exit-study') { if(history.state?.from==='review'&&history.state?.hubDepth>0)history.back();else{history.replaceState({...history.state,tab:'review'},'','#review');render(true)} tell('复习进度已保留'); return true; }
  return false;
}
function pageScroll() { return mobileLockedScroll ?? window.scrollY; }
function lockMobilePage() {
  if (mobileLockedScroll !== null) return;
  mobileLockedScroll = window.scrollY;
  document.body.style.position = 'fixed';
  document.body.style.top = -mobileLockedScroll + 'px';
  document.body.style.width = '100%';
  document.body.classList.add('sheet-open');
}
function unlockMobilePage() {
  if (mobileLockedScroll === null) return;
  const y = mobileLockedScroll;
  mobileLockedScroll = null;
  document.body.style.position = ''; document.body.style.top = ''; document.body.style.width = '';
  document.body.classList.remove('sheet-open');
  window.scrollTo(0, y);
}
function snapshotMobileSheet() {
  const id = history.state?.sheet, d = $('#sheet'), body = d.querySelector('.sheet-body');
  if (!id || !d.open || !body) return;
  const clone = body.cloneNode(true);
  const from = body.querySelectorAll('input,textarea,select');
  const to = clone.querySelectorAll('input,textarea,select');
  from.forEach((el, i) => {
    if (el.tagName === 'TEXTAREA') to[i].textContent = el.value;
    else if (el.tagName === 'SELECT') [...to[i].options].forEach((o, index) => o.toggleAttribute('selected', el.options[index].selected));
    else { to[i].setAttribute('value', el.value); to[i].toggleAttribute('checked', el.checked); }
  });
  sheets.set(id, [$('#sheet-title').textContent, clone.innerHTML]);
}
function dismissMobileSheet(restoreFocus = false) {
  const d = $('#sheet');
  if (d.open) d.close();
  unlockMobilePage();
  mobileUpdateViewport();
  if (restoreFocus) requestAnimationFrame(() => {
    const candidates = [...document.querySelectorAll('[data-act]')];
    const target = candidates.find(el => el.dataset.act === mobileSheetFocus && !el.closest('dialog'));
    (target || $('#content')).focus({ preventScroll: true });
  });
}
function mobileUpdateViewport() {
  const vv = window.visualViewport;
  if (vv && Math.abs(vv.scale - 1) > .05) return;
  const height = vv?.height || innerHeight, offset = vv?.offsetTop || 0;
  const editable = document.activeElement?.matches('input:not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true]');
  if (!editable) mobileViewportBaseline = Math.max(innerHeight, height);
  mobileViewportBaseline = Math.max(mobileViewportBaseline, innerHeight);
  const bottom = Math.max(0, innerHeight - height - offset);
  document.documentElement.style.setProperty('--viewport-height', height + 'px');
  document.documentElement.style.setProperty('--viewport-bottom', bottom + 'px');
  document.body.classList.toggle('keyboard-open', Boolean(editable && mobileViewportBaseline - height > 140));
  const studyActions=document.querySelector('.study-actions');
  if(studyActions)document.documentElement.style.setProperty('--study-actions-height',Math.ceil(studyActions.getBoundingClientRect().height)+'px');
  if(typeof workspaceRevealActiveType==='function'){workspaceRevealActiveType();requestAnimationFrame(workspaceRevealActiveType);}
}
function mobileRememberView() {
  clearTimeout(mobileViewTimer);
  mobileViewTimer = setTimeout(mobileWriteView, 120);
}
function mobileWriteView() {
  try { sessionStorage.setItem('hub-mobile-view-v2', JSON.stringify({ query, source, searchDate, searchType, searchFolder, readingQuery, readingFilter, readingSource, readingView, taskFilter, taskDate, taskTools: typeof taskToolsViewState==='function'?taskToolsViewState():undefined, agentListQuery, agentListScope, filter, scrolls: { ...scrolls, [activeRoute]: pageScroll() } })); } catch {}
}
function mobileRestoreView() {
  // Applied filters persist across visits; legacy per-tab view state still takes precedence.
  const search=workspacePrefs();
  if(WORKSPACE_SOURCES.includes(search.source))source=search.source;
  if(WORKSPACE_DATES.includes(search.date))searchDate=search.date;
  if(WORKSPACE_TYPES.includes(search.type))searchType=search.type;
  if(['全部分组',...allMobileLabels()].includes(search.folder))searchFolder=search.folder;
  try {
    const v = JSON.parse(sessionStorage.getItem('hub-mobile-view-v2') || '{}');
    if (typeof v.query === 'string') query = v.query;
    if (WORKSPACE_SOURCES.includes(v.source)) source = v.source;
    if (WORKSPACE_DATES.includes(v.searchDate)) searchDate = v.searchDate;
    if (WORKSPACE_TYPES.includes(v.searchType)) searchType = v.searchType;
    if (['全部分组', ...allMobileLabels()].includes(v.searchFolder)) searchFolder = v.searchFolder;
    if (typeof v.readingQuery === 'string') readingQuery = v.readingQuery;
    if (['全部', '未读', '阅读中', '已读'].includes(v.readingFilter)) readingFilter = v.readingFilter;
    if (['全部来源', ...reading.map(x => x.src)].includes(v.readingSource)) readingSource = v.readingSource;
    if (['全部内容', '继续阅读', '离线内容'].includes(v.readingView)) readingView = v.readingView;
    if (['待办', '已完成', '全部'].includes(v.taskFilter)) taskFilter = v.taskFilter;
    if (['所有日期', '今天', '明天', '昨天', '已逾期', '未来7天', '未安排'].includes(v.taskDate)) taskDate = v.taskDate;
    if(typeof taskToolsRestoreView==='function')taskToolsRestoreView(v.taskTools);
    if(typeof v.agentListQuery==='string')agentListQuery=v.agentListQuery;
    if(['active','archived','all'].includes(v.agentListScope))agentListScope=v.agentListScope;
    if (['待关注', '稍后', '已处理', '待复核'].includes(v.filter)) filter = v.filter;
    if (v.scrolls && typeof v.scrolls === 'object') for (const [key, value] of Object.entries(v.scrolls)) if (Number.isFinite(value) && value >= 0) scrolls[key] = value;
  } catch {}
}
function setupMobile() {
  applyAppearance(); mobileRestoreView(); mobileUpdateViewport();
  if (history.state?.sheet) { const s = { ...history.state }; delete s.sheet; s.hubDepth = Math.max(0, (s.hubDepth || 1) - 1); history.replaceState(s, ''); }
  window.visualViewport?.addEventListener('resize', mobileUpdateViewport);
  window.visualViewport?.addEventListener('scroll', mobileUpdateViewport);
  addEventListener('resize', mobileUpdateViewport);
  addEventListener('orientationchange', () => { mobileViewportBaseline = 0; requestAnimationFrame(mobileUpdateViewport); });
  document.addEventListener('focusin', mobileUpdateViewport);
  document.addEventListener('focusout', () => requestAnimationFrame(mobileUpdateViewport));
  document.addEventListener('input', () => { snapshotMobileSheet(); mobileRememberView(); });
  document.addEventListener('change', event => {
    const key = event.target.dataset.pref;
    if (['largeText', 'reduceTransparency'].includes(key)) { mobilePreferences()[key] = event.target.checked; const ok = save(); applyAppearance(); if (!ok) tell('设置已应用，但暂时无法保存在浏览器。'); }
    snapshotMobileSheet(); mobileRememberView();
  });
  document.addEventListener('click', mobileRememberView);
  addEventListener('scroll', mobileRememberView, { passive: true });
  addEventListener('pagehide', mobileWriteView);
  const dialog = $('#sheet');
  let backdropDown = false;
  dialog.addEventListener('pointerdown', e => { const r = dialog.getBoundingClientRect(); backdropDown = e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom); });
  dialog.addEventListener('click', e => { const r = dialog.getBoundingClientRect(); if (backdropDown && e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) close(); backdropDown = false; });
}
