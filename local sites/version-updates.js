function initVersionUpdates(readPageSource) {
  const snapshotDate = '2026-11-22';
  const snapshot = [
    ['version-updates', '新增版本更新入口', '在主站查看更新记录、辨认未读版本和源码改动。'],
    ['87adf96', '精简主站全局工具栏', '将快速跳转、设置、同步状态和原型对照归入侧栏和底部状态栏。'],
    ['9b3e0c5', '修复 Agents 示例菜单点击', '打开菜单时使选项显示在助手面板上方，三个示例可正常切换。'],
    ['1ae178d', '优化三栏布局和阅读顶栏', '停靠助手时自动收折左侧导航，阅读视图在单行顶栏切换筛选。'],
    ['e5c5ccf', '移植「搜索与全部」', '移植九条示例、筛选、文档预览和多处命中跳转，并默认打开搜索页。'],
    ['882a95b', '统一停靠助手与主站样式', '使用 Base White 纸面风格统一停靠助手、画布和标题栏。'],
    ['b2e04b4', '收纳助手示例切换入口', '将示例切换移到右下角状态栏。'],
    ['dd4d62c', '接入完整 Agents 面板', '移植三个案例、原文定位和三种窗口形态，保留当前资料入口。']
  ].map(([id, title, summary]) => ({ id, date: snapshotDate, title, summary }));

  const trigger = document.getElementById('btn-version-updates');
  const panel = document.getElementById('version-updates');
  const list = document.getElementById('version-update-list');
  const pending = document.getElementById('version-update-pending');
  const pendingFiles = document.getElementById('version-update-files');
  const status = document.getElementById('version-update-source');
  const isFile = location.protocol === 'file:';
  const seenKey = 'hub.version-updates.seen';
  const sourceKey = 'hub.version-updates.page-source';
  let lastRead = read(seenKey);
  let updates = {
    records: snapshot,
    files: isFile ? changedPageFiles() : [],
    mode: isFile ? 'file' : 'checking'
  };
  let refreshing = false;

  function read(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function save(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  }

  function changedPageFiles() {
    const source = readPageSource();
    let hash = 2166136261;
    for (let i = 0; i < source.length; i++) {
      hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
    }
    const version = snapshot[0].id;
    const stamp = version + ':' + (hash >>> 0).toString(16);
    const previous = read(sourceKey);
    if (previous?.startsWith(version + ':')) {
      return previous === stamp ? [] : ['index.html'];
    }
    save(sourceKey, stamp);
    return [];
  }

  function render() {
    const { records, files, mode } = updates;
    const readIndex = records.findIndex(record => record.id === lastRead);
    const unreadCount = records.length && readIndex < 0 ? 1 : Math.max(0, readIndex);
    const label = files.length ? '有未记录的本地改动' : unreadCount ? unreadCount + ' 条未读更新' : '';
    trigger.dataset.updateState = files.length ? 'pending' : unreadCount ? 'new' : '';
    trigger.setAttribute('aria-label', label ? '版本更新，' + label : '版本更新');

    pending.hidden = files.length === 0;
    pendingFiles.textContent = files.join(' · ');
    status.textContent = {
      local: '本地提交与源码状态',
      file: '站点记录 · 刷新时检查主页源码',
      checking: '正在读取本地版本',
      snapshot: '站点记录 · 本地源码状态暂不可用'
    }[mode];

    const fragment = document.createDocumentFragment();
    records.forEach((record, index) => {
      const row = document.createElement('li');
      row.className = 'version-record';
      row.dataset.unread = String(index < unreadCount);

      const meta = document.createElement('div');
      meta.className = 'version-record-meta';
      const date = document.createElement('time');
      date.dateTime = record.date;
      date.textContent = record.date;
      meta.append(date);
      if (index === 0 || index < unreadCount) {
        const marker = document.createElement('span');
        marker.className = 'version-record-marker';
        marker.textContent = index === 0 ? (index < unreadCount ? '最新 · 未读' : '最新版本') : '未读';
        meta.append(marker);
      }

      const title = document.createElement('h3');
      title.textContent = record.title;
      row.append(meta, title);
      if (record.summary) {
        const summary = document.createElement('p');
        summary.textContent = record.summary;
        row.append(summary);
      }
      fragment.append(row);
    });
    const scrollTop = list.parentElement.scrollTop;
    list.replaceChildren(fragment);
    list.parentElement.scrollTop = scrollTop;
  }

  async function refresh() {
    if (isFile || refreshing || document.hidden) return;
    refreshing = true;
    try {
      const response = await fetch('__hub/updates', { cache: 'no-store' });
      if (!response.ok) throw new Error('Local version history unavailable');
      const actual = await response.json();
      if (!Array.isArray(actual.records) || !Array.isArray(actual.files)) return;
      const next = { records: actual.records.length ? actual.records : snapshot, files: actual.files, mode: 'local' };
      if (JSON.stringify(updates) !== JSON.stringify(next)) {
        updates = next;
        render();
      }
    } catch {
      if (updates.mode !== 'snapshot') {
        updates = { ...updates, files: [], mode: 'snapshot' };
        render();
      }
    } finally {
      refreshing = false;
    }
  }

  panel.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') {
      refresh();
    } else if (updates.records.length) {
      lastRead = updates.records[0].id;
      save(seenKey, lastRead);
      render();
    }
  });
  render();
  if (!isFile) {
    document.addEventListener('visibilitychange', refresh);
    setInterval(refresh, 8000);
    refresh();
  }
}
