// INITIAL DOMAIN DATA: 6 Realistic Insights + 3 Extra Load-More Items
let insights = [
  {
    id: 'INS-01',
    title: '图纸字段在纸面已经核对，仍缺实机台架验证',
    status: 'DONE', // Processing status: 已处理
    evidenceState: 'NEED_REVIEW', // Evidence state: 待复核 (Orthogonal state!)
    perspective: 'WORK',
    starred: true,
    followed: false,
    revision: 'v2',
    hasHistory: true,
    workId: 'Work #W-2026-1102',
    updatedAt: '2026-11-20 14:32',
    body: '根据《工程交付图纸规范 v2.4》及 11 月 02 日现场盘点记录，各控制柜接线图纸中的编码规则已完成全量比对，符号与端子号符合 2026 工业桌面标准。\n\n但需要注意的是，目前核对仅停留在纸面与静态 CAD 规则层面。对于高频震动及极端工况下的物理接线稳定性，仍缺少台架实测数据的直接印证。',
    quote: '图纸比对无误，已归档。台架测试预定于下个周期补充，目前无实机数据。',
    sourceNote: '《实机台架202611.md》',
    sourcePath: 'Craft Local Vault / Works / Hardware',
    diffOriginal: '图纸比对无误，已归档。台架测试预定于下个周期补充，目前无实机数据。',
    diffUpdated: '台架测试已于11-21完成首轮振动试验，发现接线端子在 40Hz 发生微幅偏移。'
  },
  {
    id: 'INS-02',
    title: 'Craft 与 Local-first 状态解耦可在低带宽环境下维持高响应',
    status: 'PENDING',
    evidenceState: 'VERIFIED',
    perspective: 'WORK',
    starred: true,
    followed: true,
    revision: 'v1',
    hasHistory: false,
    workId: 'Work #W-2026-1099',
    updatedAt: '2026-11-19 11:15',
    body: '本地优先架构避免了高频 RPC 阻塞主UI。所有协同编辑状态先落本地 SQLite FTS5，后台静默补齐差异。',
    quote: 'UI 响应延迟控制在 16ms 以内，弱网条件下无需阻断用户操作。',
    sourceNote: '《Local-first架构设计.md》',
    sourcePath: 'Obsidian / Architecture'
  },
  {
    id: 'INS-03',
    title: '决定采用 SQLite FTS5 替代全内存索引以控制崩溃内存峰值',
    status: 'LATER',
    laterDate: '11-25',
    evidenceState: 'VERIFIED',
    perspective: 'DECISION',
    starred: false,
    followed: false,
    revision: 'v2',
    hasHistory: true,
    workId: 'Work #W-2026-1080',
    updatedAt: '2026-11-18 16:40',
    body: '经过压测发现，在大文本全量载入内存时内存占用突破 800MB；改用 FTS5 磁盘分页后内存平稳维持在 45MB 左右。',
    quote: '决定于 11-18 完成技术选型决策，放弃全内存方案。',
    sourceNote: '《FTS5索引优化观察.md》',
    sourcePath: 'Craft Local / Database'
  },
  {
    id: 'INS-04',
    title: 'Prompt 预算与 Context 窗口边界需设定硬性拦截阈值',
    status: 'PENDING',
    evidenceState: 'NEED_REVIEW',
    perspective: 'WORK',
    starred: false,
    followed: true,
    revision: 'v1',
    hasHistory: false,
    workId: 'Work #W-2026-1045',
    updatedAt: '2026-11-17 09:20',
    body: '当长上下文突破 128k 时，模型幻觉率上升 14%。必须在前端截断阶段显式提示用户授权扩展。',
    quote: '建议在 80% 阈值处触发 SweepBar 提示。',
    sourceNote: '《Prompt budget.md》',
    sourcePath: 'Obsidian / AI'
  },
  {
    id: 'INS-05',
    title: '第三方敏感服务对接授权凭证安全离线化',
    status: 'DONE',
    evidenceState: 'RESTRICTED', // Security Masking!
    perspective: 'WORK',
    starred: false,
    followed: false,
    revision: 'v1',
    hasHistory: false,
    workId: 'Work #W-2026-0999',
    updatedAt: '2026-11-15 18:00',
    body: '【受限内容】原笔记权限已撤回或来源停用，正文已安全隐藏。',
    quote: '【受限引文】',
    sourceNote: '《已撤权笔记.md》',
    sourcePath: 'Restricted Vault'
  },
  {
    id: 'INS-06',
    title: '每周复盘节奏切换为 30 分钟精简流可降低认知负荷',
    status: 'PENDING',
    evidenceState: 'VERIFIED',
    perspective: 'LIFE',
    starred: false,
    followed: false,
    revision: 'v1',
    hasHistory: false,
    workId: 'Work #W-2026-0950',
    updatedAt: '2026-11-14 20:10',
    body: '缩短单次回顾时长，依靠“按需发现”替代全量扫读，注意力集中度明显提升。',
    quote: '连续三周的满意度打分维持在 4.8 / 5.0。',
    sourceNote: '《周报与认知负荷记录.md》',
    sourcePath: 'Personal / Review'
  }
];

let extraLoadMoreData = [
  {
    id: 'INS-07',
    title: '前端虚拟滚动列表在突破 5000 条时需开启硬件加速',
    status: 'PENDING',
    evidenceState: 'VERIFIED',
    perspective: 'WORK',
    starred: true,
    followed: false,
    revision: 'v1',
    hasHistory: false,
    workId: 'Work #W-2026-0910',
    updatedAt: '2026-11-12 10:00',
    body: 'DOM 节点过多会导致 Paint 时间上升。开启 translate3d 渲染后帧率稳定在 60fps。',
    quote: '优化后滚动手感无卡顿。',
    sourceNote: '《前端性能基准.md》',
    sourcePath: 'Craft / Dev'
  },
  {
    id: 'INS-08',
    title: '关于建立跨事项知识重用机制的思考',
    status: 'DONE',
    evidenceState: 'VERIFIED',
    perspective: 'DECISION',
    starred: false,
    followed: false,
    revision: 'v1',
    hasHistory: false,
    workId: 'Work #W-2026-0880',
    updatedAt: '2026-11-10 15:30',
    body: '跨事项的知识沉淀应通过原子化洞察卡片进行建立，避免重复核对。',
    quote: '统一原子卡片规格。',
    sourceNote: '《知识复用指南.md》',
    sourcePath: 'Obsidian / PKM'
  },
  {
    id: 'INS-09',
    title: '极端温度测试条件下各控制模组的降频响应曲线',
    status: 'PENDING',
    evidenceState: 'NEED_REVIEW',
    perspective: 'WORK',
    starred: false,
    followed: false,
    revision: 'v1',
    hasHistory: false,
    workId: 'Work #W-2026-0840',
    updatedAt: '2026-11-08 17:00',
    body: '75度环境持续运行 2 小时后自动切入保护频率。',
    quote: '降频延迟 200ms。',
    sourceNote: '《温控测试记录.md》',
    sourcePath: 'Works / Test'
  }
];

// STATE MANAGEMENT
let selectedId = 'INS-01';
let currentFilterStatus = 'ALL'; // ALL, PENDING, LATER, DONE
let currentScope = 'ALL'; // ALL, NEED_REVIEW, STARRED
let currentPerspective = 'ALL'; // ALL, WORK, LIFE, DECISION
let layoutView = 'STREAM'; // STREAM, TABLE
let activeModule = 'INSIGHTS'; // INSIGHTS, CHECKING, REVIEW, TOPICS, AUDIT
let activeDrawer = null; // QUOTE, INSPECTOR, ASSISTANT, or null
let selectedItemIds = new Set();
let currentViewRevision = null;
let sortOldestFirst = false;
let compactDetailOpen = false;
const narrowViewport = window.matchMedia('(max-width: 760px)');
const initialReview = structuredClone(insights[0]);
const revisionHistory = new Map([
  ['INS-01', [{ revision: 'v1', body: '旧版图纸比对记录：初步盘点完成，尚待现场复核。', quote: insights[0].quote }]],
  ['INS-03', [{ revision: 'v1', body: '早期方案使用全内存索引，仍需对比磁盘分页在大文本场景中的内存占用。', quote: '内存峰值与切换条件仍待验证。' }]],
]);
let searchKeyword = '';
const LINK_STORAGE_KEY = 'hub-proto-insight-task-links-v1';
let syncedTasks = [
  { id: 'd-review', title: '确认评审会时间并发送日程', project: '线束项目', status: 'doing', due: '' },
  { id: 'd-supplier-confirm', title: '核对线束端子最新阶梯报价', project: '线束项目', status: 'waiting', due: '' },
  { id: 'd-inbox-task', title: '整理台架振动测试补充条款', project: '收件箱', status: 'todo', due: '' },
];
let linkedTaskDrawerOpen = false;
let linkedTaskTab = 'create';

function readProtoTaskLinks() {
  try {
    const raw = localStorage.getItem(LINK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveProtoTaskLink(link) {
  const current = readProtoTaskLinks();
  const exists = current.some(
    row => row.insightId === link.insightId && row.taskId === link.taskId && row.libraryId === link.libraryId
  );
  const next = exists
    ? current.map(row =>
        row.insightId === link.insightId && row.taskId === link.taskId && row.libraryId === link.libraryId
          ? { ...row, ...link }
          : row
      )
    : [{ ...link, createdAt: new Date().toISOString() }, ...current];
  try {
    localStorage.setItem(LINK_STORAGE_KEY, JSON.stringify(next));
  } catch {}
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'hub:insight-links-updated' }, window.location.origin);
  }
  return next;
}

function selectInsightByExternalId(targetId) {
  if (!targetId) return;
  if (!insights.some(item => item.id === targetId) && typeof extraInsights !== 'undefined') {
    const extra = extraInsights.find(item => item.id === targetId);
    if (extra) insights.push(extra);
  }
  if (!insights.some(item => item.id === targetId)) return;
  activeModule = 'INSIGHTS';
  if (typeof switchModule === 'function') switchModule('INSIGHTS');
  currentFilterStatus = 'ALL';
  currentScope = 'ALL';
  currentPerspective = 'ALL';
  searchKeyword = '';
  const searchEl = document.getElementById('ipt-search');
  if (searchEl) searchEl.value = '';
  selectedId = targetId;
  currentViewRevision = null;
  renderAll();
}

function renderLinkedTasksSection(item) {
  const section = document.getElementById('section-linked-tasks');
  if (!section || !item) return;
  const restricted = item.evidenceState === 'RESTRICTED';
  const versions = restricted ? [] : revisionHistory.get(item.id) || [];
  const historical = versions.find(version => version.revision === currentViewRevision);
  section.classList.toggle('hidden', restricted);
  if (restricted) return;

  const links = readProtoTaskLinks().filter(row => row.insightId === item.id);
  const countEl = document.getElementById('linked-tasks-count');
  if (countEl) countEl.textContent = `${links.length} 项`;
  const toggleBtn = document.getElementById('btn-toggle-task-drawer');
  if (toggleBtn) toggleBtn.disabled = Boolean(historical);

  const listEl = document.getElementById('linked-tasks-list');
  if (listEl) {
    const statusLabel = s => (s === 'done' ? '已完成' : s === 'doing' ? '进行中' : s === 'waiting' ? '等待中' : '待办');
    const statusCls = s =>
      s === 'done'
        ? 'bg-emerald-50 text-emerald-700'
        : s === 'waiting'
          ? 'bg-amber-50 text-amber-800'
          : 'bg-blue-50 text-blue-700';
    listEl.replaceChildren(
      ...links.map(link => {
        const live = syncedTasks.find(t => t.id === link.taskId);
        const card = document.createElement('div');
        card.className = 'flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-[var(--paper-well)] border border-[var(--hair)] text-xs';
        const left = document.createElement('div');
        left.className = 'min-w-0 flex-1';
        const top = document.createElement('div');
        top.className = 'flex items-center gap-1.5';
        const badge = document.createElement('span');
        const st = live ? live.status : 'todo';
        badge.className = `px-1.5 py-0.5 rounded-full text-[10px] font-medium shrink-0 ${statusCls(st)}`;
        badge.textContent = statusLabel(st);
        const title = document.createElement('strong');
        title.className = 'truncate text-[var(--ink)]';
        title.textContent = live?.title || link.taskTitle || `滴答任务 ${link.taskId}`;
        top.append(badge, title);
        const sub = document.createElement('div');
        sub.className = 'text-[10px] text-[var(--ink-muted)] mt-0.5';
        sub.textContent = `滴答清单 · ${live?.project || link.listName || '收件箱'}${live?.due ? ` · 截止 ${live.due}` : ''}`;
        left.append(top, sub);

        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'px-2 py-1 bg-white hover:bg-black/5 border border-[var(--hair-strong)] rounded-md text-[11px] text-[var(--ink)] shrink-0';
        jump.textContent = '前往任务 →';
        jump.addEventListener('click', () => {
          if (window.parent !== window) {
            window.parent.postMessage({ type: 'hub:open-task', taskId: link.taskId, insightId: item.id }, window.location.origin);
          } else {
            showToast(`已定位任务「${title.textContent}」（独立打开模式）`, 'info');
          }
        });
        card.append(left, jump);
        return card;
      })
    );
  }

  const drawer = document.getElementById('linked-task-drawer');
  if (drawer) drawer.classList.toggle('hidden', !linkedTaskDrawerOpen || Boolean(historical));
  const toggleTxt = document.getElementById('txt-toggle-task-drawer');
  if (toggleTxt) toggleTxt.textContent = linkedTaskDrawerOpen ? '收起' : '创建 / 关联滴答任务';

  const titleInput = document.getElementById('ipt-link-task-title');
  if (titleInput && titleInput.dataset.forInsight !== item.id) {
    titleInput.value = item.title;
    titleInput.dataset.forInsight = item.id;
  }
  const listSel = document.getElementById('sel-link-task-list');
  const sourceConfirm = document.getElementById('txt-link-task-source');
  if (sourceConfirm) {
    sourceConfirm.textContent = `来源洞察：${item.title}（${item.workId} · ${item.revision} · 依据 ${item.sourceNote}）。确认后写入滴答清单「${listSel?.value || '线束项目'}」并建立双向关联。`;
  }
  const existingSource = document.getElementById('txt-link-existing-source');
  if (existingSource) {
    existingSource.textContent = `将洞察「${item.title}」（${item.revision}）与所选滴答任务双向关联，不改动滴答原任务内容。`;
  }
  const existingSel = document.getElementById('sel-link-existing-task');
  if (existingSel) {
    const prevVal = existingSel.value;
    existingSel.replaceChildren(
      ...[
        (() => {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = '选择已有滴答任务…';
          return opt;
        })(),
        ...syncedTasks.map(t => {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = `${t.title} · ${t.project || '收件箱'} · ${t.status === 'done' ? '已完成' : '待办'}`;
          return opt;
        }),
      ]
    );
    if (prevVal && syncedTasks.some(t => t.id === prevVal)) existingSel.value = prevVal;
  }
}

function toggleLinkedTaskDrawer(forceState) {
  const item = insights.find(i => i.id === selectedId);
  if (!item || item.evidenceState === 'RESTRICTED' || currentViewRevision) return;
  linkedTaskDrawerOpen = typeof forceState === 'boolean' ? forceState : !linkedTaskDrawerOpen;
  renderLinkedTasksSection(item);
}

function setLinkedTaskTab(tab) {
  linkedTaskTab = tab;
  const createBtn = document.getElementById('tab-task-create');
  const linkBtn = document.getElementById('tab-task-link');
  const createPanel = document.getElementById('panel-task-create');
  const linkPanel = document.getElementById('panel-task-link');
  if (createBtn && linkBtn && createPanel && linkPanel) {
    createBtn.setAttribute('aria-selected', String(tab === 'create'));
    linkBtn.setAttribute('aria-selected', String(tab === 'link'));
    createBtn.className = tab === 'create' ? 'px-2.5 py-1 rounded-md bg-white text-[var(--ink)] font-medium shadow-sm' : 'px-2.5 py-1 rounded-md text-[var(--ink-secondary)]';
    linkBtn.className = tab === 'link' ? 'px-2.5 py-1 rounded-md bg-white text-[var(--ink)] font-medium shadow-sm' : 'px-2.5 py-1 rounded-md text-[var(--ink-secondary)]';
    createPanel.classList.toggle('hidden', tab !== 'create');
    linkPanel.classList.toggle('hidden', tab !== 'link');
  }
}

function showLinkedTaskFeedback(text) {
  const el = document.getElementById('linked-tasks-feedback');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
}

function confirmCreateLinkedTask() {
  const item = insights.find(i => i.id === selectedId);
  if (!item) return;
  const title = (document.getElementById('ipt-link-task-title')?.value || '').trim();
  const project = document.getElementById('sel-link-task-list')?.value || '收件箱';
  if (!title) {
    showToast('请先确认滴答任务标题', 'warn');
    return;
  }
  const sourceLabel = `${item.workId} · ${item.revision} · ${item.sourceNote}`;
  if (window.parent !== window) {
    window.parent.postMessage(
      {
        type: 'hub:create-dida-task',
        payload: {
          title,
          project,
          body: `来自洞察「${item.title}」（${sourceLabel}）\n${item.quote || ''}`,
          insightId: item.id,
          insightTitle: item.title,
          workId: item.workId,
          sourceLabel,
        },
      },
      window.location.origin
    );
  } else {
    const taskId = 'dida-ref-' + Date.now().toString(36);
    syncedTasks = [{ id: taskId, title, project, status: 'todo', due: '' }, ...syncedTasks];
    saveProtoTaskLink({
      insightId: item.id,
      taskId,
      libraryId: 'dida',
      insightTitle: item.title,
      taskTitle: title,
      listName: project,
      sourceLabel,
    });
  }
  linkedTaskDrawerOpen = false;
  showLinkedTaskFeedback(`已创建滴答任务「${title}」至「${project}」，并建立双向关联。`);
  logAudit('发现转行动', `${item.id} 创建并关联滴答任务「${title}」（${project}）`);
  renderLinkedTasksSection(item);
}

function confirmLinkExistingTask() {
  const item = insights.find(i => i.id === selectedId);
  if (!item) return;
  const taskId = document.getElementById('sel-link-existing-task')?.value || '';
  const picked = syncedTasks.find(t => t.id === taskId);
  if (!picked) {
    showToast('请先选择一项要关联的滴答任务', 'warn');
    return;
  }
  saveProtoTaskLink({
    insightId: item.id,
    taskId: picked.id,
    libraryId: 'dida',
    insightTitle: item.title,
    taskTitle: picked.title,
    listName: picked.project || '收件箱',
    sourceLabel: `${item.workId} · ${item.revision} · ${item.sourceNote}`,
  });
  linkedTaskDrawerOpen = false;
  showLinkedTaskFeedback(`已关联滴答任务「${picked.title}」（${picked.project || '收件箱'}）。`);
  logAudit('发现关联行动', `${item.id} 关联已有滴答任务「${picked.title}」`);
  renderLinkedTasksSection(item);
}

// INITIALIZATION
window.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  setupSplitResizer();
  setupKeyboardShortcuts();
  document.getElementById('open-original-workflow').addEventListener('click', event => {
    if (window.parent === window) return;
    event.preventDefault();
    window.parent.postMessage('hub:open-insight-workflow', window.location.origin);
  });
  document.getElementById('sel-link-task-list')?.addEventListener('change', () => {
    const item = insights.find(i => i.id === selectedId);
    if (item) renderLinkedTasksSection(item);
  });
  window.addEventListener('message', event => {
    if (event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'hub:tasks-sync' && Array.isArray(data.tasks)) {
      syncedTasks = data.tasks;
      const item = insights.find(i => i.id === selectedId);
      if (item) renderLinkedTasksSection(item);
    } else if (data.type === 'hub:select-insight' && typeof data.insightId === 'string') {
      selectInsightByExternalId(data.insightId);
    }
  });
  window.addEventListener('storage', event => {
    if (event.key === LINK_STORAGE_KEY) {
      const item = insights.find(i => i.id === selectedId);
      if (item) renderLinkedTasksSection(item);
    }
  });
  narrowViewport.addEventListener('change', updateCompactLayout);
  updateCompactLayout();
  const initialInsightParam = new URLSearchParams(window.location.search).get('insightId');
  if (initialInsightParam) {
    selectInsightByExternalId(initialInsightParam);
  } else {
    renderAll();
  }
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'hub:insights-ready' }, window.location.origin);
  }
  logAudit('系统启动', 'Hub 洞察工作区 v4 初始化完成');
});

// RENDER ROUTINER
function renderAll() {
  const visible = getFilteredInsights();
  if (!visible.some(item => item.id === selectedId)) {
    selectedId = visible[0]?.id ?? null;
    currentViewRevision = null;
    activeDrawer = null;
  }
  document.getElementById('app-shell').classList.toggle('empty-insights', visible.length === 0);
  updateCounters();
  renderFilterIndicator();
  renderStreamAndTable();
  renderDetailView();
  updateDrawerState();
  lucide.createIcons();
}

// UPDATE COUNTERS IN SIDEBAR AND TITLEBAR
function updateCounters() {
  const allCount = insights.length;
  const pendingCount = insights.filter(i => i.status === 'PENDING').length;
  const laterCount = insights.filter(i => i.status === 'LATER').length;
  const doneCount = insights.filter(i => i.status === 'DONE').length;
  const needReviewCount = insights.filter(i => i.evidenceState === 'NEED_REVIEW').length;
  const starredCount = insights.filter(i => i.starred).length;

  document.getElementById('cnt-ALL').innerText = allCount;
  document.getElementById('cnt-PENDING').innerText = pendingCount;
  document.getElementById('cnt-LATER').innerText = laterCount;
  document.getElementById('cnt-DONE').innerText = doneCount;

  document.getElementById('sb-cnt-all').innerText = allCount;
  document.getElementById('sb-cnt-review').innerText = needReviewCount;
  document.getElementById('sb-cnt-starred').innerText = starredCount;

  const filtered = getFilteredInsights();
  document.getElementById('txt-filtered-count').innerText = `命中 ${filtered.length} / 总计 ${insights.length} 条`;
}

// FILTER LOGIC
function getFilteredInsights() {
  return insights.filter(item => {
    // Filter Status
    if (currentFilterStatus !== 'ALL' && item.status !== currentFilterStatus) return false;
    // Scope
    if (currentScope === 'NEED_REVIEW' && item.evidenceState !== 'NEED_REVIEW') return false;
    if (currentScope === 'STARRED' && !item.starred) return false;
    // Perspective
    if (currentPerspective !== 'ALL' && item.perspective !== currentPerspective) return false;
    // Search Keyword
    if (searchKeyword.trim() !== '') {
      const kw = searchKeyword.trim().toLowerCase();
      const matchTitle = item.title.toLowerCase().includes(kw);
      const matchWork = item.workId.toLowerCase().includes(kw);
      const matchBody = item.evidenceState !== 'RESTRICTED' &&
        [item.body, item.quote, item.sourceNote].some(value => value.toLowerCase().includes(kw));
      if (!matchTitle && !matchWork && !matchBody) return false;
    }
    return true;
  }).sort((first, second) => sortOldestFirst
    ? first.updatedAt.localeCompare(second.updatedAt)
    : second.updatedAt.localeCompare(first.updatedAt));
}

// RENDER STREAM & TABLE
function renderStreamAndTable() {
  const list = getFilteredInsights();
  const streamContainer = document.getElementById('stream-container');
  const tableTbody = document.getElementById('table-tbody');

  // 1. Render Stream Cards
  streamContainer.innerHTML = '';
  if (list.length === 0) {
    streamContainer.innerHTML = `<div class="p-8 text-center text-xs text-[var(--ink-muted)]">未找到符合条件的洞察记录</div>`;
  } else {
    list.forEach(item => {
      const isSelected = item.id === selectedId;
      const isChecked = selectedItemIds.has(item.id);

      let statusBadge = '';
      if (item.status === 'PENDING') statusBadge = `<span class="w-2 h-2 rounded-full bg-amber-500" title="待关注"></span>`;
      else if (item.status === 'LATER') statusBadge = `<span class="text-[10px] text-blue-600 bg-blue-50 px-1 rounded font-mono-tech">稍后 ${item.laterDate || ''}</span>`;
      else if (item.status === 'DONE') statusBadge = `<span class="w-2 h-2 rounded-full bg-emerald-500" title="已处理"></span>`;

      let evidenceBadge = '';
      if (item.evidenceState === 'NEED_REVIEW') {
        evidenceBadge = `<span class="px-1.5 py-0.2 bg-amber-100 text-amber-800 rounded font-semibold text-[10px] flex items-center gap-1">
          <i data-lucide="alert-triangle" class="w-3 h-3"></i> 待复核
        </span>`;
      } else if (item.evidenceState === 'RESTRICTED') {
        evidenceBadge = `<span class="px-1.5 py-0.2 bg-red-100 text-red-700 rounded text-[10px]">来源不可用</span>`;
      }

      const card = document.createElement('div');
      card.className = `stream-card p-3 rounded-xl border border-[var(--hair)] cursor-pointer relative group ${isSelected ? 'stream-card-active' : 'bg-white/90'}`;
      card.onclick = (e) => {
        if (e.target.classList.contains('hub-chk')) return;
        selectInsight(item.id);
        openCompactDetail();
      };

      card.innerHTML = `
        <div class="flex items-start gap-2">
          <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleSelectItem('${item.id}', this.checked)" aria-label="选择洞察 ${item.id}" class="hub-chk mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 ${isChecked ? 'opacity-100' : ''}">
          <div class="flex-1 space-y-1.5 min-w-0">
            <div class="flex items-center justify-between gap-1">
              <span class="text-[10px] font-mono-tech text-[var(--ink-muted)] truncate">${item.workId}</span>
              <div class="flex items-center gap-1 shrink-0">
                ${statusBadge}
                ${item.starred ? '<i data-lucide="star" class="w-3 h-3 text-amber-500 fill-amber-500"></i>' : ''}
              </div>
            </div>
            <h4 class="font-bold text-xs text-[var(--ink)] leading-snug line-clamp-2"><button type="button" class="text-left" aria-current="${isSelected}">${item.title}</button></h4>
            <div class="flex items-center justify-between text-[10px] text-[var(--ink-muted)] pt-0.5">
              ${evidenceBadge || `<span class="text-emerald-700">依据已核对</span>`}
              <span class="font-mono-tech">${item.revision}</span>
            </div>
          </div>
        </div>
      `;
      streamContainer.appendChild(card);
    });
  }

  // 2. Render Table Rows
  tableTbody.innerHTML = '';
  list.forEach(item => {
    const isSelected = item.id === selectedId;
    const isChecked = selectedItemIds.has(item.id);
    const tr = document.createElement('tr');
    tr.className = `hover:bg-blue-50/50 cursor-pointer transition-colors ${isSelected ? 'bg-blue-50/80 font-medium' : ''}`;
    tr.onclick = (e) => {
      if (e.target.classList.contains('hub-chk')) return;
      selectInsight(item.id);
      if (layoutView === 'TABLE') openSheetInTableMode();
      openCompactDetail();
    };

    let statusTxt = item.status === 'PENDING' ? '待关注' : (item.status === 'LATER' ? `稍后 ${item.laterDate||''}` : '已处理');
    let statusColor = item.status === 'PENDING' ? 'text-amber-700 bg-amber-50' : (item.status === 'LATER' ? 'text-blue-700 bg-blue-50' : 'text-emerald-700 bg-emerald-50');

    let evBadge = item.evidenceState === 'NEED_REVIEW'
      ? `<span class="px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded font-bold text-[10px] flex items-center gap-1"><i data-lucide="alert-triangle" class="w-3 h-3"></i> 待复核</span>`
      : (item.evidenceState === 'RESTRICTED' ? `<span class="px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-[10px]">来源不可用</span>` : `<span class="text-emerald-700 text-[10px]">已核对</span>`);

    let persTxt = item.perspective === 'WORK' ? '知识与工作' : (item.perspective === 'LIFE' ? '生活与进展' : '决定与变化');

    tr.innerHTML = `
      <td class="p-2 text-center" onclick="event.stopPropagation()">
        <input type="checkbox" ${isChecked ? 'checked' : ''} onchange="toggleSelectItem('${item.id}', this.checked)" aria-label="选择洞察 ${item.id}" class="hub-chk">
      </td>
      <td class="p-2"><span class="px-1.5 py-0.5 rounded text-[10px] ${statusColor}">${statusTxt}</span></td>
      <td class="p-2 font-medium text-[var(--ink)]"><button type="button" class="text-left" aria-current="${isSelected}">${item.title}</button> ${item.starred ? '<i data-lucide="star" class="w-3 h-3 inline text-amber-500 fill-amber-500 ml-1"></i>' : ''}</td>
      <td class="p-2">${evBadge}</td>
      <td class="p-2 text-[var(--ink-secondary)]">${persTxt}</td>
      <td class="p-2 font-mono-tech text-[var(--ink-muted)]">${item.revision}</td>
      <td class="p-2 font-mono-tech text-[var(--ink-muted)]">${item.workId}</td>
      <td class="p-2 font-mono-tech text-[var(--ink-muted)] text-right pr-3">${item.updatedAt.split(' ')[0]}</td>
    `;
    tableTbody.appendChild(tr);
  });

  updateBatchPill();
}

// SELECT AN INSIGHT
function selectInsight(id) {
  selectedId = id;
  currentViewRevision = null;
  if (insights.find(item => item.id === id)?.evidenceState === 'RESTRICTED') activeDrawer = null;
  renderAll();
}

// RENDER DETAIL CANVAS (PAPER B)
function renderDetailView() {
  const item = insights.find(i => i.id === selectedId);
  if (!item) return;
  const restricted = item.evidenceState === 'RESTRICTED';
  const versions = restricted ? [] : revisionHistory.get(item.id) || [];
  const historical = versions.find(version => version.revision === currentViewRevision);

  document.getElementById('detail-work-id').innerText = item.workId;
  document.getElementById('detail-date').innerText = item.updatedAt;
  document.getElementById('detail-title').innerText = item.title;

  // Inline Metadata Subtraction Strip
  const statusTxt = item.status === 'PENDING' ? '待关注' : (item.status === 'LATER' ? `稍后 · ${item.laterDate || ''}` : '已处理');
  const statusDotColor = item.status === 'PENDING' ? 'bg-amber-500' : (item.status === 'LATER' ? 'bg-blue-500' : 'bg-emerald-500');
  document.getElementById('txt-inline-status').innerText = statusTxt;
  document.getElementById('dot-inline-status').className = `w-2 h-2 rounded-full ${statusDotColor}`;

  const persTxt = item.perspective === 'WORK' ? '知识与工作' : (item.perspective === 'LIFE' ? '生活与进展' : '决定与变化');
  document.getElementById('txt-inline-pers').innerText = persTxt;

  document.getElementById('txt-inline-rev').textContent = historical
    ? `${historical.revision} (历史只读)` : `${item.revision} (当前)`;
  document.getElementById('btn-inline-rev').disabled = versions.length === 0;
  renderRevisionOptions(item, versions);

  // Star & Follow
  const starIco = document.getElementById('ico-inline-star');
  if (item.starred) {
    starIco.classList.add('fill-amber-500', 'text-amber-500');
    document.getElementById('txt-inline-star').innerText = '已星标';
  } else {
    starIco.classList.remove('fill-amber-500', 'text-amber-500');
    document.getElementById('txt-inline-star').innerText = '星标';
  }

  const followIco = document.getElementById('ico-inline-follow');
  if (item.followed) {
    followIco.classList.add('fill-blue-500', 'text-blue-500');
    document.getElementById('txt-inline-follow').innerText = '已关注';
  } else {
    followIco.classList.remove('fill-blue-500', 'text-blue-500');
    document.getElementById('txt-inline-follow').innerText = '关注';
  }

  // Readonly Warning Banner
  const readonlyBanner = document.getElementById('banner-readonly-history');
  const feedbackSection = document.getElementById('section-feedback');
  if (historical) {
    document.getElementById('view-version').textContent = historical.revision;
    document.getElementById('head-version').textContent = item.revision;
    readonlyBanner.classList.remove('hidden');
    feedbackSection.classList.add('opacity-40', 'pointer-events-none');
  } else {
    readonlyBanner.classList.add('hidden');
    feedbackSection.classList.remove('opacity-40', 'pointer-events-none');
  }

  // Security Masked Banner (INS-05)
  const securityBanner = document.getElementById('banner-security-masked');
  const proseBody = document.getElementById('detail-prose-body');
  const quoteBox = document.getElementById('detail-quote-box');
  if (item.evidenceState === 'RESTRICTED') {
    securityBanner.classList.remove('hidden');
    proseBody.innerHTML = `<div class="p-6 bg-red-50/50 border border-red-100 rounded-xl text-center text-red-700 text-xs">正文因安全隔离已受限隐藏。</div>`;
    quoteBox.innerText = '【受限引文】';
  } else {
    securityBanner.classList.add('hidden');
    const revision = historical || item;
    proseBody.replaceChildren(...revision.body.split('\n\n').map(text => {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      if (historical) paragraph.className = 'text-gray-500 font-mono-tech';
      return paragraph;
    }));
    quoteBox.textContent = `"${revision.quote}"`;
  }

  // Codex Review Strip (Orthogonal NEED_REVIEW)
  const reviewStrip = document.getElementById('codex-review-strip');
  if (item.evidenceState === 'NEED_REVIEW' && !historical) {
    document.getElementById('review-source-note').textContent = `关联的本地笔记${item.sourceNote}已被修改。`;
    document.getElementById('btn-upgrade-revision').classList.toggle('hidden', !item.diffUpdated);
    reviewStrip.classList.remove('hidden');
  } else {
    reviewStrip.classList.add('hidden');
  }

  for (const id of ['btn-inline-status', 'btn-inline-pers', 'btn-inline-star', 'btn-inline-follow']) {
    document.getElementById(id).disabled = Boolean(historical);
  }
  for (const id of ['btn-drawer-QUOTE', 'btn-drawer-INSPECTOR', 'btn-drawer-ASSISTANT', 'btn-open-original', 'ipt-feedback']) {
    document.getElementById(id).disabled = restricted || Boolean(historical);
  }
  document.getElementById('btn-open-original').classList.toggle('hidden', restricted || Boolean(historical));
  feedbackSection.classList.toggle('hidden', restricted);
  document.getElementById('quote-note').textContent = restricted ? '' : item.sourceNote;
  document.getElementById('quote-path').textContent = restricted ? '' : item.sourcePath;
  document.getElementById('quote-snippet').textContent = restricted ? '' : item.quote;
  document.getElementById('quote-snippet').classList.toggle('hidden', restricted || item.id === 'INS-01');
  document.getElementById('quote-example').classList.toggle('hidden', restricted || item.id !== 'INS-01');
  document.getElementById('drawer-diff-block').classList.toggle('hidden', restricted || !item.diffUpdated);
  renderLinkedTasksSection(item);
}

function renderRevisionOptions(item, history) {
  const container = document.getElementById('popover-revision');
  container.replaceChildren(...[{ revision: item.revision, current: true }, ...history].map(entry => {
    const button = document.createElement('button');
    button.className = 'w-full text-left px-2.5 py-1.5 hover:bg-black/5 rounded flex items-center justify-between font-mono-tech';
    const name = document.createElement('span');
    name.textContent = `${entry.revision} (${entry.current ? '当前 Head' : '历史只读'})`;
    const badge = document.createElement('span');
    badge.className = entry.current ? 'text-[10px] bg-emerald-100 text-emerald-800 px-1 rounded' : 'text-[10px] bg-gray-100 text-gray-600 px-1 rounded';
    badge.textContent = entry.current ? 'Active' : 'ReadOnly';
    button.append(name, badge);
    button.addEventListener('click', () => switchRevision(entry.current ? null : entry.revision));
    return button;
  }));
}

// RESOLVE PENDING REVIEW (TWO BRANCH REVISION)
function resolveReview(branch) {
  const item = insights.find(i => i.id === selectedId);
  if (!item || currentViewRevision || item.evidenceState !== 'NEED_REVIEW') return;

  if (branch === 'MAINTAIN') {
    item.evidenceState = 'VERIFIED';
    showToast('已完成校验：维持原判断并增加本次核对记录', 'ok');
    logAudit('复核完成', `${item.id} 维持原判断 (v2)，校验通过`);
  } else if (branch === 'UPGRADE' && item.diffUpdated) {
    revisionHistory.set(item.id, [
      { revision: item.revision, body: item.body, quote: item.quote },
      ...(revisionHistory.get(item.id) || []),
    ]);
    item.quote = item.diffUpdated;
    item.evidenceState = 'VERIFIED';
    item.revision = 'v3';
    item.title = item.title + ' (v3 已根据台架新试验数据修订)';
    item.body = item.body + '\n\n【v3 补充修订】结合 11-21 首轮台架振动试验，发现接线端子在 40Hz 发生微幅偏移，已补齐物理约束条款。';
    showToast('已应用新修订：卡片升级至 v3', 'ok');
    logAudit('修订升级', `${item.id} 升级至 v3，正文与依据同步更新`);
  }

  triggerSweepBar();
  renderAll();
}

// SWITCH VIEW REVISION (v2 vs v1)
function switchRevision(rev) {
  currentViewRevision = rev;
  closeDrawers();
  closePopovers();
  renderAll();
  showToast(rev ? `已切换至版本 ${rev}` : '已返回当前版本', 'info');
}

// DRAWERS CONTROL (3 Mutually Exclusive)
function toggleDrawer(drawerName) {
  const item = insights.find(record => record.id === selectedId);
  if (!item || item.evidenceState === 'RESTRICTED' || currentViewRevision) return;
  if (activeDrawer === drawerName) {
    activeDrawer = null;
  } else {
    activeDrawer = drawerName;
  }
  updateDrawerState();
}

function closeDrawers() {
  activeDrawer = null;
  updateDrawerState();
}

function updateDrawerState() {
  ['QUOTE', 'INSPECTOR', 'ASSISTANT'].forEach(d => {
    const el = document.getElementById(`drawer-${d}`);
    const btn = document.getElementById(`btn-drawer-${d}`);
    btn.setAttribute('aria-expanded', String(activeDrawer === d));
    if (activeDrawer === d) {
      el.classList.remove('hidden');
      btn.classList.add('bg-black/10', 'text-black');
    } else {
      el.classList.add('hidden');
      btn.classList.remove('bg-black/10', 'text-black');
    }
  });
}

// CONCURRENCY CONFLICT SIMULATION
function triggerConflictSimulation() {
  const paperB = document.getElementById('paper-b');
  paperB.classList.add('shake-x');
  setTimeout(() => paperB.classList.remove('shake-x'), 400);

  showToast('⚠️ 写入冲突拦截: 后台 rowRevision 已改变，请刷新对照', 'err');
  logAudit('并发冲突', '检测到 rowRevision 不一致，操作被拦截');
}

// LAYOUT VIEW SWITCHING (STREAM VS TABLE)
function setLayoutView(view) {
  layoutView = view;
  const paperA = document.getElementById('paper-a');
  const paperB = document.getElementById('paper-b');
  const gutter = document.getElementById('split-gutter');
  const streamContainer = document.getElementById('stream-container');
  const tableContainer = document.getElementById('table-container');
  const btnCloseSheet = document.getElementById('btn-close-sheet');

  const btnStream = document.getElementById('btn-layout-stream');
  const btnTable = document.getElementById('btn-layout-table');

  btnStream.setAttribute('aria-pressed', String(view === 'STREAM'));
  btnTable.setAttribute('aria-pressed', String(view === 'TABLE'));
  compactDetailOpen = false;
  updateCompactLayout();
  if (view === 'STREAM') {
    btnStream.className = 'mac-seg-active p-1 rounded transition-all';
    btnTable.className = 'p-1 rounded text-[var(--ink-secondary)] hover:text-[var(--ink)] transition-all';

    paperA.style.width = '360px';
    paperA.classList.remove('w-full');
    paperB.classList.remove('hidden', 'absolute', 'right-0', 'top-0', 'bottom-0', 'z-30', 'w-[58%]', 'max-w-[740px]', 'shadow-[var(--shadow-sheet)]');
    gutter.classList.remove('hidden');
    streamContainer.classList.remove('hidden');
    tableContainer.classList.add('hidden');
    btnCloseSheet.classList.add('hidden');
  } else {
    btnTable.className = 'mac-seg-active p-1 rounded transition-all';
    btnStream.className = 'p-1 rounded text-[var(--ink-secondary)] hover:text-[var(--ink)] transition-all';

    paperA.style.width = '100%';
    gutter.classList.add('hidden');
    streamContainer.classList.add('hidden');
    tableContainer.classList.remove('hidden');

    // Hide detail paper B by default until a row is clicked
    paperB.classList.add('hidden');
  }

  triggerSweepBar();
  renderAll();
}

function openSheetInTableMode() {
  if (layoutView !== 'TABLE') return;
  const paperB = document.getElementById('paper-b');
  const btnCloseSheet = document.getElementById('btn-close-sheet');

  paperB.classList.remove('hidden');
  paperB.classList.add('absolute', 'right-0', 'top-0', 'bottom-0', 'z-30', 'w-[58%]', 'max-w-[740px]', 'shadow-[var(--shadow-sheet)]');
  btnCloseSheet.classList.remove('hidden');
}

function closeSheetInTableMode() {
  if (layoutView !== 'TABLE') return;
  const paperB = document.getElementById('paper-b');
  paperB.classList.add('hidden');
}

// BATCH TRIAGE LOGIC
function toggleSelectItem(id, checked) {
  if (checked) selectedItemIds.add(id);
  else selectedItemIds.delete(id);
  updateBatchPill();
}

function toggleSelectAll(checked) {
  const list = getFilteredInsights();
  if (checked) {
    list.forEach(i => selectedItemIds.add(i.id));
  } else {
    selectedItemIds.clear();
  }
  renderStreamAndTable();
}

function updateBatchPill() {
  const pill = document.getElementById('batch-pill');
  const countLabel = document.getElementById('batch-pill-count');
  if (selectedItemIds.size >= 2) {
    pill.classList.remove('hidden');
    countLabel.innerText = `已选 ${selectedItemIds.size} 条`;
  } else {
    pill.classList.add('hidden');
  }
}

function clearSelection() {
  selectedItemIds.clear();
  renderStreamAndTable();
}

function applyBatchStatus(statusCmd) {
  selectedItemIds.forEach(id => {
    const item = insights.find(i => i.id === id);
    if (item) {
      if (statusCmd === 'DONE') item.status = 'DONE';
      else if (statusCmd === 'LATER') { item.status = 'LATER'; item.laterDate = '11-25'; }
      else if (statusCmd === 'UNFOLLOW') item.followed = false;
    }
  });
  showToast(`已批量更新 ${selectedItemIds.size} 条洞察`, 'ok');
  logAudit('批量分诊', `批量更新 ${selectedItemIds.size} 条洞察状态为 ${statusCmd}`);
  selectedItemIds.clear();
  renderAll();
}

function renderFilterIndicator() {
  const status = { PENDING: '待关注', LATER: '稍后', DONE: '已处理' };
  const scope = { NEED_REVIEW: '待复核', STARRED: '星标发现' };
  const perspective = { WORK: '知识与工作', LIFE: '生活与进展', DECISION: '决定与变化' };
  const filters = [status[currentFilterStatus], scope[currentScope], perspective[currentPerspective], searchKeyword.trim()].filter(Boolean);
  document.getElementById('filter-indicator-bar').classList.toggle('hidden', filters.length === 0);
  document.getElementById('filter-indicator-text').textContent = '筛选：' + filters.join(' · ');
}

function resetFilters() {
  searchKeyword = '';
  document.getElementById('global-search').value = '';
  setFilterStatus('ALL');
  setScope('ALL');
  setPerspective('ALL');
}

// SIDEBAR SCOPE & PERSPECTIVE SWITCHING
function setFilterStatus(status) {
  if (activeModule !== 'INSIGHTS') switchModule('INSIGHTS');
  currentFilterStatus = status;
  ['ALL', 'PENDING', 'LATER', 'DONE'].forEach(s => {
    const btn = document.getElementById(`seg-${s}`);
    if (s === status) btn.className = 'mac-seg-active px-3 py-1 rounded-md transition-all flex items-center gap-1.5';
    else btn.className = 'px-3 py-1 rounded-md text-[var(--ink-secondary)] hover:text-[var(--ink)] transition-all flex items-center gap-1.5';
  });
  triggerSweepBar();
  renderAll();
}

function setScope(scope) {
  if (activeModule !== 'INSIGHTS') switchModule('INSIGHTS');
  currentScope = scope;
  ['ALL', 'NEED_REVIEW', 'STARRED'].forEach(s => {
    const btn = document.getElementById(`sb-scope-${s}`);
    if (s === scope) btn.classList.add('is-active');
    else btn.classList.remove('is-active');
  });
  document.getElementById('txt-current-scope').innerText = scope === 'ALL' ? '全部洞察' : (scope === 'NEED_REVIEW' ? '待复核洞察' : '星标发现');
  triggerSweepBar();
  renderAll();
}

function setPerspective(pers) {
  if (activeModule !== 'INSIGHTS') switchModule('INSIGHTS');
  currentPerspective = pers;
  ['ALL', 'WORK', 'LIFE', 'DECISION'].forEach(p => {
    const btn = document.getElementById(`sb-pers-${p}`);
    if (p === pers) btn.classList.add('is-active');
    else btn.classList.remove('is-active');
  });
  triggerSweepBar();
  renderAll();
}

// MODULE SWITCHING (FULL WIDTH OVERLAYS)
function switchModule(modName) {
  activeModule = modName;
  ['INSIGHTS', 'CHECKING', 'REVIEW', 'TOPICS', 'AUDIT'].forEach(m => {
    const el = document.getElementById(`module-${m}`);
    const sbBtn = document.getElementById(`sb-mod-${m}`);
    if (m === modName) {
      el.classList.remove('hidden');
      if (sbBtn) sbBtn.classList.add('is-active');
    } else {
      el.classList.add('hidden');
      if (sbBtn) sbBtn.classList.remove('is-active');
    }
  });
  if (document.body.classList.contains('compact-insights')) setSidebarExpanded(false);
  renderAll();
}

// SWEEP BAR ANIMATION
function triggerSweepBar() {
  const sweep = document.getElementById('paper-a-sweep');
  sweep.classList.remove('hidden');
  setTimeout(() => sweep.classList.add('hidden'), 1200);
}

function triggerRecheck() {
  triggerSweepBar();
  showToast('已完成全库引用与依赖校验，所有项目状态均已最新', 'info');
  logAudit('重聚焦校验', '用户触发 F5/按钮 窗口重聚焦重新校验');
}

// INLINE NOTION-STYLE POPOVERS
function toggleStatusPopover() {
  closePopovers();
  document.getElementById('popover-status').classList.remove('hidden');
}
function togglePerspectivePopover() {
  closePopovers();
  document.getElementById('popover-perspective').classList.remove('hidden');
}
function toggleRevisionPopover() {
  closePopovers();
  document.getElementById('popover-revision').classList.remove('hidden');
}
function toggleDemoPopover() {
  closePopovers();
  document.getElementById('demo-popover').classList.toggle('hidden');
}
function closePopovers() {
  ['popover-status', 'popover-perspective', 'popover-revision', 'demo-popover'].forEach(p => {
    document.getElementById(p).classList.add('hidden');
  });
}

function setInsightStatus(st) {
  if (currentViewRevision) return;
  const item = insights.find(i => i.id === selectedId);
  if (item) {
    item.status = st;
    if (st === 'LATER') item.laterDate = '11-25';
    showToast(`状态已更新为：${st}`, 'ok');
    logAudit('状态更新', `${item.id} 更改状态为 ${st}`);
  }
  closePopovers();
  renderAll();
}

function setInsightPerspective(pers) {
  if (currentViewRevision) return;
  const item = insights.find(i => i.id === selectedId);
  if (item) {
    item.perspective = pers;
    showToast(`视角已更新为：${pers}`, 'ok');
    logAudit('视角更新', `${item.id} 视角修改为 ${pers}`);
  }
  closePopovers();
  renderAll();
}

function toggleStarCurrent() {
  if (currentViewRevision) return;
  const item = insights.find(i => i.id === selectedId);
  if (item) {
    item.starred = !item.starred;
    showToast(item.starred ? '已设为星标发现' : '已取消星标', 'info');
  }
  renderAll();
}

function toggleFollowCurrent() {
  if (currentViewRevision) return;
  const item = insights.find(i => i.id === selectedId);
  if (item) {
    item.followed = !item.followed;
    showToast(item.followed ? '已开启关注，变动时主动提醒' : '已取消关注', 'info');
  }
  renderAll();
}

// KEYBOARD FLOW & NAVIGATION
function navigateInsight(direction) {
  const list = getFilteredInsights();
  if (list.length === 0) return;
  const idx = list.findIndex(i => i.id === selectedId);
  let nextIdx = idx + direction;
  if (nextIdx < 0) nextIdx = 0;
  if (nextIdx >= list.length) nextIdx = list.length - 1;
  selectInsight(list[nextIdx].id);
}

function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.defaultPrevented) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }

    if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') {
      e.preventDefault();
      navigateInsight(1);
    } else if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') {
      e.preventDefault();
      navigateInsight(-1);
    } else if (e.key === '/') {
      e.preventDefault();
      document.getElementById('global-search').focus();
    } else if (e.key === '1') {
      setInsightStatus('PENDING');
    } else if (e.key === '2') {
      setInsightStatus('LATER');
    } else if (e.key === '3') {
      setInsightStatus('DONE');
    } else if (e.key === 's' || e.key === 'S') {
      toggleStarCurrent();
    } else if (e.key === 'Escape') {
      if (activeDrawer) closeDrawers();
      else if (!document.getElementById('modal-discover').classList.contains('hidden')) closeModals();
      else if (compactDetailOpen || layoutView === 'TABLE') closeDetailSheet();
      else closePopovers();
    }
  });
}

// SEARCH & LOAD MORE
function handleSearch(val) {
  searchKeyword = val;
  if (activeModule !== 'INSIGHTS') switchModule('INSIGHTS');
  renderAll();
}

function loadMoreInsights() {
  if (extraLoadMoreData.length > 0) {
    insights.push(...extraLoadMoreData);
    extraLoadMoreData = [];
    showToast('已加载 3 条新洞察卡片', 'info');
    document.getElementById('btn-load-more').innerText = `加载更多 (当前 ${insights.length} / ${insights.length})`;
    renderAll();
  } else {
    showToast('已加载全部洞察数据', 'info');
  }
}

// DEMO SCENARIOS & VIEWPORT SWITCHING
function setDemoViewport(vp) {
  const shell = document.getElementById('app-shell');
  if (vp === 'NARROW') {
    shell.classList.add('shell-narrow');
    document.getElementById('btn-vp-narrow').className = 'p-1.5 rounded border border-blue-500 bg-blue-50 text-blue-700 font-medium text-left flex items-center gap-1.5';
    document.getElementById('btn-vp-desktop').className = 'p-1.5 rounded border border-[var(--hair-strong)] hover:bg-black/5 text-[var(--ink-secondary)] font-medium text-left flex items-center gap-1.5';
  } else {
    shell.classList.remove('shell-narrow');
    document.getElementById('btn-vp-desktop').className = 'p-1.5 rounded border border-blue-500 bg-blue-50 text-blue-700 font-medium text-left flex items-center gap-1.5';
    document.getElementById('btn-vp-narrow').className = 'p-1.5 rounded border border-[var(--hair-strong)] hover:bg-black/5 text-[var(--ink-secondary)] font-medium text-left flex items-center gap-1.5';
  }
  updateCompactLayout();
  closePopovers();
}

function runScenario(num) {
  closePopovers();
  closeDrawers();
  setFilterStatus('ALL');
  setScope('ALL');
  setPerspective('ALL');
  document.getElementById('global-search').value = '';
  searchKeyword = '';
  selectedItemIds.clear();
  switchModule('INSIGHTS');
  if ([1, 5, 6].includes(num)) {
    const index = insights.findIndex(item => item.id === initialReview.id);
    insights[index] = structuredClone(initialReview);
    revisionHistory.set(initialReview.id, revisionHistory.get(initialReview.id).filter(version => version.revision === 'v1'));
  }
  if (num === 1) {
    setLayoutView('STREAM');
    selectInsight('INS-01');
    toggleDrawer('QUOTE');
    showToast('场景 1: 正交态 (已处理+待复核) & 原文 Diff 高亮对比', 'info');
  } else if (num === 2) {
    setLayoutView('TABLE');
    selectInsight('INS-01');
    openSheetInTableMode();
    showToast('场景 2: 全宽属性表格 & Craft 详情滑出页', 'info');
  } else if (num === 3) {
    setLayoutView('STREAM');
    selectedItemIds.add('INS-01');
    selectedItemIds.add('INS-02');
    renderAll();
    showToast('场景 3: 多选批量分诊胶囊', 'info');
  } else if (num === 4) {
    setLayoutView('STREAM');
    selectInsight('INS-05');
    showToast('场景 4: 来源撤权脱敏保护 (安全遮蔽)', 'info');
  } else if (num === 5) {
    setLayoutView('STREAM');
    selectInsight('INS-01');
    switchRevision('v1');
    showToast('场景 5: 历史版本 v1 只读保护', 'info');
  } else if (num === 6) {
    setLayoutView('STREAM');
    selectInsight('INS-01');
    toggleDrawer('INSPECTOR');
    triggerConflictSimulation();
  }
  if (num !== 3) openCompactDetail();
}

// AUDIT LOG SYSTEM
function logAudit(action, desc) {
  const stream = document.getElementById('audit-log-stream');
  const time = new Date().toTimeString().split(' ')[0];
  const div = document.createElement('div');
  div.className = 'p-2.5 bg-gray-50 border border-[var(--hair)] rounded-lg flex items-center justify-between';
  div.innerHTML = `
    <div class="flex items-center gap-2">
      <span class="px-1.5 py-0.5 bg-gray-200 text-gray-800 rounded font-semibold text-[10px]">${action}</span>
      <span data-audit-description class="text-[var(--ink-body)]"></span>
    </div>
    <span class="text-[10px] text-[var(--ink-muted)]">${time}</span>
  `;
  div.querySelector('[data-audit-description]').textContent = desc;
  stream.prepend(div);
}
function clearAuditLogs() {
  document.getElementById('audit-log-stream').innerHTML = '';
}

// TOAST SYSTEM
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto px-3.5 py-2 rounded-xl shadow-xl border text-xs flex items-center gap-2 transition-all duration-200 transform translate-y-2 opacity-0 bg-white`;

  if (type === 'ok') toast.classList.add('border-emerald-200', 'text-emerald-900');
  else if (type === 'err') toast.classList.add('border-red-200', 'text-red-900', 'bg-red-50');
  else toast.classList.add('border-blue-200', 'text-blue-900');

  toast.innerHTML = `<i data-lucide="${type==='ok'?'check-circle':(type==='err'?'alert-circle':'info')}" class="w-4 h-4 shrink-0"></i><span>${msg}</span>`;
  container.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 200);
  }, 3000);
}

// SPLIT RESIZER HANDLE
function setupSplitResizer() {
  const paperA = document.getElementById('paper-a');
  const gutter = document.getElementById('split-gutter');
  let isDragging = false;

  gutter.addEventListener('mousedown', () => {
    if (layoutView === 'TABLE') return;
    isDragging = true;
    gutter.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const newW = e.clientX - paperA.getBoundingClientRect().left;
    if (newW >= 280 && newW <= 520) {
      paperA.style.width = `${newW}px`;
    }
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      gutter.classList.remove('is-dragging');
      document.body.style.cursor = 'default';
    }
  });

  gutter.addEventListener('dblclick', () => {
    if (layoutView === 'STREAM') paperA.style.width = '360px';
  });
}

// MODALS & SIDEBAR TOGGLE
function setSidebarExpanded(open) {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('w-[206px]', open);
  sidebar.classList.toggle('w-0', !open);
  sidebar.classList.toggle('opacity-0', !open);
  sidebar.inert = !open;
  document.getElementById('btn-toggle-sidebar').setAttribute('aria-expanded', String(open));
}

function toggleSidebar() {
  setSidebarExpanded(document.getElementById('sidebar').inert);
}

function openSidebarFilters() {
  setSidebarExpanded(true);
  document.getElementById(`sb-scope-${currentScope}`).focus();
}

function toggleSortOrder() {
  sortOldestFirst = !sortOldestFirst;
  document.getElementById('btn-sort-date').setAttribute('aria-pressed', String(sortOldestFirst));
  document.getElementById('txt-sort-label').textContent = sortOldestFirst ? '最早更新' : '更新时间';
  renderAll();
}

function updateCompactLayout() {
  const narrow = narrowViewport.matches || document.getElementById('app-shell').classList.contains('shell-narrow');
  if (narrow !== document.body.classList.contains('compact-insights')) {
    document.body.classList.toggle('compact-insights', narrow);
    setSidebarExpanded(!narrow);
  }
  document.body.classList.toggle('compact-detail-open', narrow && compactDetailOpen);
  if (layoutView === 'STREAM') {
    document.getElementById('btn-close-sheet').classList.toggle('hidden', !narrow || !compactDetailOpen);
  }
}

function openCompactDetail() {
  if (!document.body.classList.contains('compact-insights')) return;
  compactDetailOpen = true;
  setSidebarExpanded(false);
  updateCompactLayout();
  document.getElementById('btn-close-sheet').focus();
}

function closeDetailSheet() {
  closeDrawers();
  closeSheetInTableMode();
  compactDetailOpen = false;
  updateCompactLayout();
  const list = layoutView === 'TABLE' ? 'table-tbody' : 'stream-container';
  document.querySelector(`#${list} button[aria-current="true"]`)?.focus();
}

function openDiscoverModal() {
  document.getElementById('modal-discover').classList.remove('hidden');
}
function closeModals() {
  document.getElementById('modal-discover').classList.add('hidden');
}
function runDiscoveryProcess() {
  closeModals();
  triggerSweepBar();
  showToast('示例分析完成，请到核对台查看候选', 'ok');
  switchModule('CHECKING');
}
function openImportModal() {
  showToast('v4 使用预置样例。可从「原有洞察流程」体验导入已有分析。', 'info');
}
function openShortcutsModal() {
  showToast('快捷键: J/K 移动, 1/2/3 切状态, S 星标, / 搜索, Esc 关闭', 'info');
}
function submitFeedback() {
  const val = document.getElementById('ipt-feedback').value;
  if (currentViewRevision || insights.find(item => item.id === selectedId)?.evidenceState === 'RESTRICTED') return;
  if (val.trim()) {
    showToast('已提交纠正反馈并记入日志', 'ok');
    logAudit('反馈提交', `${selectedId}: ${val}`);
    document.getElementById('ipt-feedback').value = '';
  }
}
function sendAssistantChip(text) {
  document.getElementById('ipt-assistant').value = text;
  sendAssistantMsg();
}
function sendAssistantMsg() {
  const val = document.getElementById('ipt-assistant').value;
  if (!val.trim()) return;
  const workId = insights.find(item => item.id === selectedId)?.workId;
  const stream = document.getElementById('assistant-chat-stream');
  const msg = document.createElement('div');
  msg.className = 'p-2 bg-purple-100/60 rounded text-[11px] text-purple-950 font-medium';
  msg.innerText = `You: ${val}`;
  stream.appendChild(msg);

  setTimeout(() => {
    const reply = document.createElement('div');
    reply.className = 'p-2.5 bg-gray-50 rounded-lg text-[11px] text-gray-700 leading-relaxed';
    reply.innerText = `示例助手：已收到“${val}”，当前事项为 ${workId}。`;
    stream.appendChild(reply);
  }, 400);

  document.getElementById('ipt-assistant').value = '';
}
function acceptCandidate() {
  const candidate = {
    id: 'INS-CHECK-01',
    title: '智能终端在低电量模式下的心跳休眠间隔为 300s',
    status: 'PENDING',
    evidenceState: 'VERIFIED',
    perspective: 'WORK',
    revision: 'v1',
    workId: 'Work #W-2026-1103',
    updatedAt: '2026-11-21 14:00',
    body: '从设备规范中提取的低电量模式心跳间隔示例。',
    quote: '在低电量模式下，心跳休眠间隔设置为 300s。',
    sourceNote: '《智能终端设备规范》',
    sourcePath: '核对台示例',
  };
  if (insights.some(item => item.id === candidate.id)) return;
  insights.push(candidate);
  document.getElementById('accept-candidate').disabled = true;
  document.getElementById('accept-candidate').textContent = '已保留';
  searchKeyword = '';
  document.getElementById('global-search').value = '';
  setFilterStatus('ALL');
  setScope('ALL');
  setPerspective('ALL');
  selectInsight(candidate.id);
  logAudit('保留候选', candidate.title);
  showToast('已保留该候选洞察，自动加入全库', 'ok');
}
function rejectCandidate() {
  document.getElementById('reject-candidate').disabled = true;
  document.getElementById('reject-candidate').textContent = '已丢弃';
  logAudit('丢弃候选', '旧接口兼容层候选已丢弃');
  showToast('已丢弃该候选洞察', 'info');
}
function recheckPermission() {
  showToast('来源授权演示：当前示例维持不可用状态', 'info');
}
