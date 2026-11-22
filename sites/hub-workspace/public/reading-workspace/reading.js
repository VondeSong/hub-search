    // =========================================================================
    // 1. DATA MODEL (Fictional Samples & Marked Mock Receipts)
    // =========================================================================
    const SOURCES = [
      { id: 'all', label: '全部', base: 1248 },
      { id: 'x_bookmark', label: 'X 书签', base: 1084 },
      { id: 'x_like', label: 'X 喜欢', base: 42 },
      { id: 'telegram', label: 'Telegram', base: 109 },
      { id: 'dida', label: '滴答', base: 13 }
    ];

    const DESTINATIONS = [
      { id: 'obsidian_main', name: 'Obsidian · Research', short: 'Obsidian', type: 'obsidian', isDefault: true },
      { id: 'craft_arch', name: 'Craft · 架构笔记', short: 'Craft 架构', type: 'craft' },
      { id: 'craft_life', name: 'Craft · 灵感库', short: 'Craft 灵感', type: 'craft' },
      { id: 'dida_inbox', name: '滴答清单 · 阅读行动', short: '滴答清单', type: 'dida' }
    ];

    const ALL_TAGS = ['交互设计', '本地优先', 'Rust架构', 'AI工作流', '性能优化', '待拆解'];

    const STATUS_META = {
      unread: { label: '待读', dot: 'bg-blue-600', ring: 'border-neutral-300 bg-white', text: 'text-neutral-600' },
      reading: { label: '进行中', dot: 'bg-amber-500', ring: 'border-amber-500 bg-amber-500', text: 'text-amber-700' },
      read: { label: '已读', dot: 'bg-teal-600', ring: 'border-teal-600 bg-teal-600', text: 'text-teal-700' },
      abandoned: { label: '放弃', dot: 'bg-neutral-400', ring: 'border-neutral-300 bg-neutral-300', text: 'text-neutral-500' }
    };

    function seedItems() {
      return [
        {
          id: 'item-101',
          source: 'x_bookmark',
          title: '本地优先应用的状态机设计：为什么离线写入必须拆分为四层事实',
          author: '林澈',
          handle: '@linche_dev',
          url: 'https://x.com/linche_dev/status/900101',
          publishedAt: '11-20',
          collectedAt: '2026-11-21',
          daysAgo: 1,
          status: 'unread',
          prevStatus: 'unread',
          lifecycle: 'normal',
          tags: ['交互设计', '本地优先'],
          hasImage: true, hasVideo: false, hasLink: true,
          excerpt: '把本机可读、云端可恢复、资料库副本与原平台状态混成一个“已同步”勾号，是所有知识管理工具产生焦虑的根源。',
          body: [
            '在做一个跨设备知识阅读器时，最容易踩的坑，就是试图用一颗绿色的“已同步”小圆点来概括一切。用户看到绿点以为万事大吉，结果一断网发现附件没下下来，或者去 Craft 里找发现其实写入超时了。',
            '真正稳健的工程模型应该严格拆分四个正交事实：本机是否完整可读、云端快照是否已校验、目标资料库副本是否拿到确定回执、以及原平台（比如 X 书签或滴答）是否做了清理或回写。',
            '界面上平时把这四层安静地收在“本文管理”抽屉里，只有在部分成功或结果不明时，才在文章顶部亮起一条克制的工程提示带，把判断权交还给用户。'
          ],
          attachments: [
            { id: 'att-1', name: 'state-machine-layers.png', kind: 'image', sizeMb: 1.4, localReady: true, cloudState: 'verified', thumbReady: true },
            { id: 'att-2', name: 'sync-sequence-spec.pdf', kind: 'pdf', sizeMb: 3.2, localReady: true, cloudState: 'verified', thumbReady: true }
          ],
          destinations: {
            obsidian_main: { state: 'saved', receipt: 'MOCK-OBS-8821', note: '默认本机库' },
            craft_arch: { state: 'saved', receipt: 'MOCK-CRF-4410', note: '已校验页面' }
          },
          cloudRecovery: { checkedAt: '2026-11-21 15:40', bodyOk: true, attOk: 2, attTotal: 2, missing: [] },
          pendingRemoteUndo: false,
          triage: null
        },
        {
          id: 'item-102',
          source: 'telegram',
          title: '桌面端毛玻璃与悬浮白纸的微交互实录（含 18.4 MB 原视频）',
          author: '设计工程频道',
          handle: '@ui_craft_lab',
          url: 'https://t.me/ui_craft_lab/482',
          publishedAt: '11-19',
          collectedAt: '2026-11-20',
          daysAgo: 2,
          status: 'unread',
          prevStatus: 'unread',
          lifecycle: 'normal',
          tags: ['交互设计'],
          hasImage: true, hasVideo: true, hasLink: false,
          forwardedFrom: '@ui_craft_lab · 桌面动效观察',
          excerpt: '对比了 Craft 与 macOS 原生窗口在同心圆角与 8px 槽道下的视觉呼吸感，附带 1 张截图与 1 段未下载的原画质演示视频。',
          body: [
            '很多人模仿 macOS 或 Craft 只学了圆角，却忘了“底板退后、纸面浮起”的明度差。当侧栏和主内容区都是纯白 `#FFFFFF` 时，再怎么调边框颜色都像电子表格。',
            '这段转发录屏展示了把侧栏降到冷灰半透明基底、再给流式列表与阅读画布分别留出呼吸槽道后的变化。下方原视频体积较大，默认仅保留预览缩略图，需要离线看清细节时可按需下载。'
          ],
          attachments: [
            { id: 'att-21', name: 'elevation-compare.png', kind: 'image', sizeMb: 0.9, localReady: true, cloudState: 'verified', thumbReady: true },
            { id: 'att-22', name: 'glass-transition-demo.mp4', kind: 'video', sizeMb: 18.4, localReady: false, cloudState: 'cloud_only', thumbReady: true }
          ],
          destinations: {
            obsidian_main: { state: 'saved', receipt: 'MOCK-OBS-8829', note: '默认本机库' }
          },
          cloudRecovery: { checkedAt: '2026-11-20 20:10', bodyOk: true, attOk: 1, attTotal: 2, missing: ['glass-transition-demo.mp4（本机未下载，云端仅存缩略图）'] },
          pendingRemoteUndo: false,
          triage: null
        },
        {
          id: 'item-103',
          source: 'x_bookmark',
          title: 'SQLite FTS5 在 10 万条本地书签下的亚毫秒检索与无闪烁切换',
          author: '周默',
          handle: '@zhoumo_rs',
          url: 'https://x.com/zhoumo_rs/status/900103',
          publishedAt: '11-18',
          collectedAt: '2026-11-19',
          daysAgo: 3,
          status: 'reading',
          prevStatus: 'reading',
          lifecycle: 'normal',
          tags: ['Rust架构', '性能优化'],
          hasImage: true, hasVideo: false, hasLink: true,
          excerpt: '拆解 Tauri + Rust 客户端如何彻底消除切换侧栏时的白屏重载：查询缓存、FTS5 触发器与乐观列表过渡。',
          body: [
            '桌面阅读器最破坏沉浸感的细节，不是功能少，而是每次点一下侧栏分类都要清空白屏闪出“正在加载本地列表…”。',
            '在本地 SQLite 只有几千条记录时，查询本身耗时不到 3ms。造成闪烁的往往是前端状态切换时先重置了空数组。改成原地 Stale-While-Revalidate 并把侧栏计数常驻内存后，切换几乎是零延迟的。'
          ],
          attachments: [
            { id: 'att-31', name: 'fts5-bench.png', kind: 'image', sizeMb: 0.6, localReady: true, cloudState: 'verified', thumbReady: true }
          ],
          destinations: {
            obsidian_main: { state: 'saved', receipt: 'MOCK-OBS-8834', note: '默认本机库' },
            craft_arch: { state: 'saved', receipt: 'MOCK-CRF-4418', note: '已校验页面' },
            dida_inbox: { state: 'needs_confirm', receipt: null, note: '待确认任务转换方案' }
          },
          cloudRecovery: { checkedAt: '2026-11-19 11:20', bodyOk: true, attOk: 1, attTotal: 1, missing: [] },
          pendingRemoteUndo: false,
          triage: { track: 'confirm', targetId: 'dida_inbox', targetName: '滴答清单 · 阅读行动', kind: 'save_plan', summary: '待确认滴答任务转换方案（含 2 条检查项）' }
        },
        {
          id: 'item-104',
          source: 'x_bookmark',
          title: '多端知识库写入幂等性：当网络超时导致“结果不明”时如何避免重复建页',
          author: '苏衡',
          handle: '@suheng_sys',
          url: 'https://x.com/suheng_sys/status/900104',
          publishedAt: '11-17',
          collectedAt: '2026-11-18',
          daysAgo: 4,
          status: 'reading',
          prevStatus: 'reading',
          lifecycle: 'normal',
          tags: ['本地优先', 'AI工作流'],
          hasImage: false, hasVideo: false, hasLink: true,
          excerpt: '当 Craft API 在写入返回前超时，客户端绝不能直接允许盲目重试，而应先查候选页面并引导用户核对关联。',
          body: [
            '向外部资料库（如 Craft 或滴答）写入副本时，最棘手的不是明确的 401 或 500，而是请求已发出但在收到回执前连接中断——即“结果不明”。',
            '此时如果 UI 只给一个“重试”按钮，大概率会在目标空间里造出两篇一模一样的文章。正确的做法是锁定再次写入，提供“核对并关联已有页面”入口，把疑似已生成的页面列出来给用户确认绑定。'
          ],
          attachments: [],
          destinations: {
            obsidian_main: { state: 'saved', receipt: 'MOCK-OBS-8840', note: '默认本机库' },
            craft_life: { state: 'uncertain', receipt: null, note: '写入超时，需核对目标库页面' }
          },
          cloudRecovery: { checkedAt: '2026-11-18 09:15', bodyOk: true, attOk: 0, attTotal: 0, missing: [] },
          pendingRemoteUndo: false,
          triage: { track: 'confirm', targetId: 'craft_life', targetName: 'Craft · 灵感库', kind: 'craft_uncertain', summary: 'Craft 写入结果不明，需核对并关联已有页面' }
        },
        {
          id: 'item-105',
          source: 'dida',
          title: '整理 Q4 阅读清单与离线归档策略',
          author: '滴答稍后读',
          handle: '收集箱 · 稍后读',
          url: '',
          publishedAt: '11-16',
          collectedAt: '2026-11-18',
          daysAgo: 4,
          status: 'unread',
          prevStatus: 'unread',
          lifecycle: 'normal',
          tags: ['AI工作流', '待拆解'],
          hasImage: true, hasVideo: false, hasLink: true,
          excerpt: '正文与检查项已保存到 Hub 本机，但同账号附件网页会话已过期，滴答原任务已受保护保留。',
          body: [
            '1. 检查近三个月从 X 与 Telegram 收藏的长文，按“架构 / 交互 / 工具”打标归档。',
            '2. 开启阅读云同步后，确认滴答来源清理处于保护关闭状态，避免未核验云恢复前误删原任务。',
            '参考资料链接：https://hub-docs.example.local/reading-workflow（正文内链接仍可直接访问）'
          ],
          attachments: [
            { id: 'att-51', name: 'q4-reading-checklist.png', kind: 'image', sizeMb: 0.8, localReady: false, cloudState: 'missing', thumbReady: false, error: '附件网页会话已过期' }
          ],
          destinations: {
            obsidian_main: { state: 'saved', receipt: 'MOCK-OBS-8852', note: '正文已保存在 Hub 本机' }
          },
          cloudRecovery: { checkedAt: '2026-11-18 18:05', bodyOk: true, attOk: 0, attTotal: 1, missing: ['q4-reading-checklist.png（尚未采集到本机）'] },
          sourceRetention: {
            retained: true,
            reason: '同账号附件网页会话过期，缺 1 个原附件；且云同步模块已启用，原项受保护保留。',
            resolvedKeepBoth: false,
            checks: { cloudComplete: false, originCredential: true, preDeleteReview: false }
          },
          pendingRemoteUndo: false,
          triage: { track: 'error', targetId: 'dida_source', targetName: '滴答稍后读', kind: 'dida_session', summary: '正文已导入，但附件网页会话过期；原项已保留' }
        },
        {
          id: 'item-106',
          source: 'x_bookmark',
          title: 'Claude Desktop 排版细节拆解：行宽、暖灰底色与低噪元数据',
          author: '程岚',
          handle: '@chenglan_ux',
          url: 'https://x.com/chenglan_ux/status/900106',
          publishedAt: '11-17',
          collectedAt: '2026-11-19',
          daysAgo: 3,
          status: 'read',
          prevStatus: 'read',
          lifecycle: 'normal',
          tags: ['交互设计', '本地优先'],
          hasImage: true, hasVideo: false, hasLink: false,
          excerpt: '把阅读区行宽锁定在 60–68ch、正文行高 1.82，并拿掉顶部冗长的 6 行属性表，是提升长文阅读舒适度最见效的改动。',
          body: [
            '许多效率工具的右侧预览面板之所以读不下去，是因为直接把数据库表单贴在了文章正上方。用户的眼睛刚准备进入阅读心流，就被一堆日期、标签下拉框和边框线打断了。',
            '采用 Notion 的内联减法，把属性收成标题下方一行安静的文字元信息，悬停才浮现极淡底色，正文居中留白，读完一篇三千字长文的心理阻力会立刻下降一半。'
          ],
          attachments: [
            { id: 'att-61', name: 'claude-reading-grid.png', kind: 'image', sizeMb: 1.1, localReady: true, cloudState: 'verified', thumbReady: true },
            { id: 'att-62', name: 'line-height-comparison.png', kind: 'image', sizeMb: 0.7, localReady: false, cloudState: 'cloud_only', thumbReady: true }
          ],
          destinations: {
            obsidian_main: { state: 'saved', receipt: 'MOCK-OBS-8860', note: '默认本机库' },
            craft_arch: { state: 'saved', receipt: 'MOCK-CRF-4429', note: '已校验页面' }
          },
          cloudRecovery: { checkedAt: '2026-11-21 10:12', bodyOk: true, attOk: 1, attTotal: 2, missing: ['line-height-comparison.png（云端未校验）'] },
          pendingRemoteUndo: false,
          triage: { track: 'recoverable', targetId: 'att-62', targetName: '附件下载队列', kind: 'att_paused', summary: '1 个原图待补下载（0.7 MB），联网后自动续传' }
        },
        {
          id: 'item-107',
          source: 'x_like',
          title: '用 Rust 写增量备份：为何应取消按日流量额度门禁',
          author: '季远',
          handle: '@jiyuan_ops',
          url: 'https://x.com/jiyuan_ops/status/900107',
          publishedAt: '11-12',
          collectedAt: '2026-11-14',
          daysAgo: 8,
          status: 'unread',
          prevStatus: 'unread',
          lifecycle: 'normal',
          tags: ['Rust架构'],
          hasImage: false, hasVideo: false, hasLink: true,
          excerpt: '取消按轮/按日流量额度门禁，改由设备网络策略、文件类型与单文件硬上限共同约束传输，逻辑更透明。',
          body: [
            '早期同步工具喜欢做复杂的“每日剩余额度”进度条，结果用户换新电脑初次恢复时反复撞墙。',
            '更符合直觉的规则是直接用网络环境、格式白名单和单文件体积上限控制，状态清晰且不会莫名卡死。'
          ],
          attachments: [],
          destinations: {
            obsidian_main: { state: 'saved', receipt: 'MOCK-OBS-8871', note: '默认本机库' }
          },
          cloudRecovery: { checkedAt: '2026-11-15 08:30', bodyOk: true, attOk: 0, attTotal: 0, missing: [] },
          pendingRemoteUndo: false,
          triage: null
        },
        {
          id: 'item-108',
          source: 'x_bookmark',
          title: '2026 桌面端键盘导航与焦点恢复无障碍清单',
          author: 'A11y 实践录',
          handle: '@a11y_notes',
          url: 'https://x.com/a11y_notes/status/900108',
          publishedAt: '11-01',
          collectedAt: '2026-11-03',
          daysAgo: 19,
          status: 'read',
          prevStatus: 'read',
          lifecycle: 'archived',
          tags: ['交互设计'],
          hasImage: false, hasVideo: false, hasLink: true,
          excerpt: '从独立阅读面或本文管理抽屉返回列表时，必须将键盘焦点精确还给原先打开的条目行。',
          body: [
            '无障碍与极客效率其实是同一件事：当你按 Enter 打开一篇文章、按 Esc 关掉抽屉、再按 Esc 返回列表时，如果焦点丢失回到页面顶部，键盘流就彻底断了。',
            '记住打开前的滚动位置与条目 ID，返回后立刻高亮并恢复焦点，是桌面级应用的基本功。'
          ],
          attachments: [],
          destinations: {
            obsidian_main: { state: 'saved', receipt: 'MOCK-OBS-8801', note: '默认本机库' },
            craft_arch: { state: 'saved', receipt: 'MOCK-CRF-4390', note: '归档仍保留已保存副本' }
          },
          cloudRecovery: { checkedAt: '2026-11-04 12:00', bodyOk: true, attOk: 0, attTotal: 0, missing: [] },
          pendingRemoteUndo: false,
          triage: null
        }
      ];
    }

    const INITIAL_VIEWS = [
      { id: 'v-stream', name: '精简阅读流', layout: 'stream', hidden: false, config: { source: 'all', scope: 'all', time: 'all', media: 'all', tags: [] } },
      { id: 'v-recent7', name: '最近 7 天导入', layout: 'stream', hidden: false, config: { source: 'all', scope: 'all', time: '7', media: 'all', tags: [] } },
      { id: 'v-table', name: '全宽属性表格', layout: 'table', hidden: false, config: { source: 'all', scope: 'all', time: 'all', media: 'all', tags: [] } },
      { id: 'v-board', name: '阅读进度看板', layout: 'board', hidden: false, config: { source: 'all', scope: 'all', time: 'all', media: 'all', tags: [] } },
      { id: 'v-gallery', name: '视觉灵感画廊', layout: 'gallery', hidden: false, config: { source: 'all', scope: 'all', time: 'all', media: 'image', tags: [] } },
      { id: 'v-hidden', name: '已隐藏的深读清单', layout: 'stream', hidden: true, config: { source: 'x_bookmark', scope: 'reading', time: '30', media: 'all', tags: ['本地优先'] } }
    ];

    const state = {
      items: seedItems(),
      views: JSON.parse(JSON.stringify(INITIAL_VIEWS)),
      activeViewId: null,
      scope: 'all',
      source: 'all',
      layout: 'stream', // stream (default calm split) | table (full-width) | board (full-width) | gallery (full-width)
      search: '',
      searchOpen: false,
      filterTime: 'all',
      filterMedia: 'all',
      filterTags: [],
      sortField: 'collectedAt',
      sortDir: 'desc',
      selectedItemId: 'item-101',
      readingOverlayOpen: false, // Used when clicking an item inside full-width Table / Board / Gallery / Triage / Narrow
      sidebarOpen: true,
      mobileSidebarOpen: false,
      copiesExpanded: true,
      inspectorOpen: false,
      assistantOpen: false,
      assistantMode: 'new',
      assistantThread: [{ role: 'system', text: '已准备就绪。发送问题后将结合当前绑定条目的正文与上下文回答。' }],
      checkedIds: new Set(),
      emptyMode: false,
      offlineMode: false,
      narrowMode: false,
      simBoardFail: false,
      activeDemoName: '',
      browseWidthPx: 356,
      scrollTop: 0,
      cloudSync: { enabled: true, lastSync: '15:58', network: '仅 Wi-Fi 下载大文件', error: '' },
      sourceSync: {
        x_bookmark: { status: 'ok', last: '15:52' },
        x_like: { status: 'ok', last: '15:50' },
        telegram: { status: 'ok', last: '15:55', tdl: '已连接个人号（支持大附件补全）' },
        dida: { status: 'warn', last: '15:40', note: '附件网页会话过期', verifiedAt: '', error: '', waitingForLogin: false },
        obsidian: { status: 'ok', last: '15:30', path: 'D:\\Vaults\\Research\\Sources' }
      }
    };

    // =========================================================================
    // 2. QUERIES & COUNTS
    // =========================================================================
    function getSourceCount(srcId) {
      if (state.emptyMode) return 0;
      const meta = SOURCES.find(s => s.id === srcId) || SOURCES[0];
      const normal = state.items.filter(i => i.lifecycle === 'normal' && i.status !== 'abandoned');
      const cur = srcId === 'all' ? normal.length : normal.filter(i => i.source === srcId).length;
      const base = srcId === 'all' ? 7 : ({ x_bookmark: 4, x_like: 1, telegram: 1, dida: 1 }[srcId] || 0);
      return Math.max(0, meta.base + (cur - base));
    }

    function getScopeCount(scopeKey) {
      if (state.emptyMode) return 0;
      const pool = state.source === 'all' ? state.items : state.items.filter(i => i.source === state.source);
      if (scopeKey === 'all') return getSourceCount(state.source);
      if (['unread', 'reading', 'read'].includes(scopeKey)) return pool.filter(i => i.lifecycle === 'normal' && i.status === scopeKey).length;
      if (scopeKey === 'archived') return pool.filter(i => i.lifecycle === 'archived').length;
      if (scopeKey === 'abandoned') return pool.filter(i => i.lifecycle === 'normal' && i.status === 'abandoned').length;
      if (scopeKey === 'triage') return pool.filter(i => i.triage !== null).length;
      if (scopeKey.startsWith('copy:')) {
        const dId = scopeKey.slice(5);
        return pool.filter(i => i.destinations[dId]?.state === 'saved').length;
      }
      return 0;
    }

    function getFilteredItems() {
      if (state.emptyMode) return [];
      let list = state.items.filter(i => i.lifecycle !== 'deleted');
      if (state.source !== 'all') list = list.filter(i => i.source === state.source);

      if (state.scope === 'all') list = list.filter(i => i.lifecycle === 'normal' && i.status !== 'abandoned');
      else if (['unread', 'reading', 'read'].includes(state.scope)) list = list.filter(i => i.lifecycle === 'normal' && i.status === state.scope);
      else if (state.scope === 'archived') list = list.filter(i => i.lifecycle === 'archived');
      else if (state.scope === 'abandoned') list = list.filter(i => i.lifecycle === 'normal' && i.status === 'abandoned');
      else if (state.scope === 'triage') list = list.filter(i => i.triage !== null);
      else if (state.scope.startsWith('copy:')) {
        const dId = state.scope.slice(5);
        list = list.filter(i => i.destinations[dId]?.state === 'saved');
      }

      if (state.filterTime !== 'all') list = list.filter(i => i.daysAgo <= Number(state.filterTime));
      if (state.filterMedia === 'image') list = list.filter(i => i.hasImage);
      if (state.filterMedia === 'video') list = list.filter(i => i.hasVideo);
      if (state.filterMedia === 'link') list = list.filter(i => i.hasLink);
      if (state.filterTags.length) list = list.filter(i => state.filterTags.every(t => i.tags.includes(t)));
      if (state.search.trim()) {
        const q = state.search.trim().toLowerCase();
        list = list.filter(i => i.title.toLowerCase().includes(q) || i.author.toLowerCase().includes(q) || i.excerpt.toLowerCase().includes(q));
      }

      list.sort((a, b) => {
        let va = state.sortField === 'attachments' ? a.attachments.length : a[state.sortField];
        let vb = state.sortField === 'attachments' ? b.attachments.length : b[state.sortField];
        if (va < vb) return state.sortDir === 'asc' ? -1 : 1;
        if (va > vb) return state.sortDir === 'asc' ? 1 : -1;
        return 0;
      });
      return list;
    }

    function isViewDirty() {
      const v = state.views.find(x => x.id === state.activeViewId);
      if (!v) return false;
      const c = v.config;
      return c.source !== state.source || c.time !== state.filterTime || c.media !== state.filterMedia || v.layout !== state.layout || JSON.stringify([...c.tags].sort()) !== JSON.stringify([...state.filterTags].sort());
    }

    function isSplitReadingActive() {
      return !state.narrowMode && !state.emptyMode && state.layout === 'stream' && state.scope !== 'triage';
    }

    function sweepProgress() {
      const el = document.getElementById('sweep-bar');
      el.classList.remove('hidden');
      clearTimeout(sweepProgress._t);
      sweepProgress._t = setTimeout(() => el.classList.add('hidden'), 280);
    }

    function escapeHtml(value) {
      const element = document.createElement('span');
      element.textContent = value;
      return element.innerHTML;
    }

    function toast(msg, tone = 'dark', action = null) {
      const root = document.getElementById('toast-root');
      const el = document.createElement('div');
      const cls = {
        dark: 'bg-neutral-900 text-white',
        ok: 'bg-teal-800 text-white',
        warn: 'bg-amber-700 text-white',
        err: 'bg-red-700 text-white'
      }[tone] || 'bg-neutral-900 text-white';
      el.className = `pointer-events-auto px-3.5 py-2 rounded-[10px] shadow-xl text-[12.5px] flex items-center gap-3 ${cls}`;
      el.innerHTML = `<span>${escapeHtml(msg)}</span>`;
      if (action) {
        const b = document.createElement('button');
        b.className = 'underline font-medium text-white whitespace-nowrap';
        b.textContent = action.label;
        b.addEventListener('click', () => { action.onClick(); el.remove(); });
        el.appendChild(b);
      }
      root.appendChild(el);
      setTimeout(() => el.remove(), action ? 5200 : 2600);
    }

    // =========================================================================
    // 3. RENDERERS
    // =========================================================================
    function renderAll() {
      renderTitlebar();
      renderSidebar();
      renderStageLayout();
      renderBrowseHeader();
      renderFilterStrip();
      renderSystemBanner();
      renderBrowseBody();
      renderBatchPill();
      renderReadingPaper();
      if (window.lucide) lucide.createIcons();
    }

    function renderTitlebar() {
      document.getElementById('app').classList.toggle('shell-narrow', state.narrowMode);
      const srcIco = { all: 'layers', x_bookmark: 'bookmark', x_like: 'heart', telegram: 'send', dida: 'check-circle-2' };
      document.getElementById('source-segmented').innerHTML = SOURCES.map(s => {
        const active = state.source === s.id;
        const cnt = getSourceCount(s.id);
        return `
          <button data-source="${s.id}" class="px-2.5 py-1 rounded-[7.5px] text-[12px] flex items-center gap-1.5 whitespace-nowrap transition ${active ? 'mac-seg-active' : 'text-neutral-600 hover:text-neutral-900'}">
            <i data-lucide="${srcIco[s.id]}" class="w-3 h-3 ${active ? 'text-blue-600' : 'text-neutral-400'}"></i>
            <span>${s.label}</span>
            <span class="font-mono-tech text-[11px] ${active ? 'text-neutral-500' : 'text-neutral-400'}">${cnt.toLocaleString()}</span>
          </button>`;
      }).join('');

      document.getElementById('btn-search-open').classList.toggle('hidden', state.searchOpen);
      document.getElementById('search-pill').classList.toggle('hidden', !state.searchOpen);
      if (state.searchOpen) document.getElementById('search-input').value = state.search;

      document.getElementById('dot-sync-warn').classList.toggle('hidden', !(state.sourceSync.dida.status === 'warn' || state.offlineMode));
      document.getElementById('dot-cloud-state').className = state.offlineMode
        ? 'absolute bottom-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-amber-500'
        : 'absolute bottom-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-teal-600';

      document.getElementById('demo-btn-label').textContent = state.activeDemoName || '验收演示';
    }

    function renderSidebar() {
      const scopes = [
        { id: 'all', label: '全部内容', icon: 'inbox', bg: 'bg-slate-200/75 text-slate-700', abg: 'bg-blue-600 text-white' },
        { id: 'unread', label: '待读', icon: 'circle-dot', bg: 'bg-blue-100/80 text-blue-600', abg: 'bg-blue-600 text-white' },
        { id: 'reading', label: '进行中', icon: 'clock-3', bg: 'bg-amber-100/80 text-amber-700', abg: 'bg-amber-500 text-white' },
        { id: 'read', label: '已读', icon: 'check-circle-2', bg: 'bg-teal-100/80 text-teal-700', abg: 'bg-teal-600 text-white' }
      ];
      document.getElementById('nav-scopes').innerHTML = scopes.map(s => {
        const active = state.scope === s.id && !state.activeViewId;
        return `
          <button data-scope="${s.id}" class="sb-item w-full px-2 py-1.5 flex items-center justify-between text-[13px] ${active ? 'is-active' : 'text-neutral-700'}">
            <span class="flex items-center gap-2.5">
              <span class="sb-ico ${active ? s.abg : s.bg}"><i data-lucide="${s.icon}" class="w-3.5 h-3.5"></i></span>
              <span>${s.label}</span>
            </span>
            <span class="text-[11.5px] font-mono-tech ${active ? 'text-neutral-700 font-medium' : 'text-neutral-400'}">${getScopeCount(s.id).toLocaleString()}</span>
          </button>`;
      }).join('');

      const layIcon = { stream: 'align-left', table: 'table-2', board: 'kanban', gallery: 'layout-grid' };
      document.getElementById('nav-views').innerHTML = state.views.filter(v => !v.hidden).map(v => {
        const active = state.activeViewId === v.id;
        return `
          <button data-view-id="${v.id}" class="sb-item w-full px-2 py-1.5 flex items-center justify-between text-[12.5px] ${active ? 'is-active' : 'text-neutral-600'}">
            <span class="flex items-center gap-2.5 truncate">
              <span class="sb-ico ${active ? 'bg-neutral-900 text-white' : 'bg-black/[0.04] text-neutral-500'}"><i data-lucide="${layIcon[v.layout] || 'list'}" class="w-3 h-3"></i></span>
              <span class="truncate">${v.name}</span>
            </span>
            ${active && isViewDirty() ? '<span class="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0"></span>' : ''}
          </button>`;
      }).join('');

      document.getElementById('ico-copies-fold').style.transform = state.copiesExpanded ? '' : 'rotate(-90deg)';
      const copiesEl = document.getElementById('nav-copies');
      copiesEl.classList.toggle('hidden', !state.copiesExpanded);
      const brandTone = {
        obsidian: { bg: 'bg-purple-100/80 text-purple-700', ico: 'gem' },
        craft: { bg: 'bg-indigo-100/80 text-indigo-700', ico: 'file-text' },
        dida: { bg: 'bg-sky-100/80 text-sky-700', ico: 'check-square' }
      };
      copiesEl.innerHTML = DESTINATIONS.map(d => {
        const key = `copy:${d.id}`;
        const active = state.scope === key;
        const bt = brandTone[d.type] || { bg: 'bg-neutral-200 text-neutral-600', ico: 'folder' };
        return `
          <button data-scope="${key}" class="sb-item w-full px-2 py-1.5 flex items-center justify-between text-[12.5px] ${active ? 'is-active' : 'text-neutral-600'}">
            <span class="flex items-center gap-2.5 truncate">
              <span class="sb-ico ${bt.bg}"><i data-lucide="${bt.ico}" class="w-3 h-3"></i></span>
              <span class="truncate">${d.name}</span>
            </span>
            <span class="text-[11.5px] font-mono-tech text-neutral-400">${getScopeCount(key)}</span>
          </button>`;
      }).join('');

      const specials = [
        { id: 'archived', label: '归档', icon: 'archive', bg: 'bg-stone-200/70 text-stone-600' },
        { id: 'abandoned', label: '放弃', icon: 'ban', bg: 'bg-neutral-200/70 text-neutral-500' },
        { id: 'triage', label: '需要处理', icon: 'alert-circle', bg: 'bg-amber-100 text-amber-700' }
      ];
      document.getElementById('nav-special').innerHTML = specials.map(s => {
        const active = state.scope === s.id;
        const cnt = getScopeCount(s.id);
        return `
          <button data-scope="${s.id}" class="sb-item w-full px-2 py-1.5 flex items-center justify-between text-[12.5px] ${active ? 'is-active' : 'text-neutral-600'}">
            <span class="flex items-center gap-2.5">
              <span class="sb-ico ${s.bg}"><i data-lucide="${s.icon}" class="w-3.5 h-3.5"></i></span>
              <span>${s.label}</span>
            </span>
            <span class="text-[11px] font-mono-tech ${s.id === 'triage' && cnt > 0 ? 'px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-800 font-semibold' : 'text-neutral-400'}">${cnt}</span>
          </button>`;
      }).join('');
    }

    function renderStageLayout() {
      const sb = document.getElementById('sidebar');
      const bd = document.getElementById('sidebar-backdrop');
      const bp = document.getElementById('browse-paper');
      const rp = document.getElementById('reading-paper');
      const gutter = document.getElementById('paper-gutter');

      if (state.narrowMode) {
        sb.className = state.mobileSidebarOpen
          ? 'fixed inset-y-0 left-0 w-[248px] z-40 mac-vibrancy p-3 flex flex-col shadow-2xl border-r border-black/10'
          : 'hidden';
        bd.classList.toggle('hidden', !state.mobileSidebarOpen);
        gutter.classList.add('hidden');

        if (state.readingOverlayOpen && state.selectedItemId && !state.emptyMode) {
          bp.classList.add('hidden');
          rp.className = 'claude-paper flex-1 flex flex-col min-w-0 overflow-hidden relative';
        } else {
          bp.className = 'craft-paper flex-1 flex flex-col min-w-0 overflow-hidden relative';
          bp.style.width = '';
          rp.className = 'hidden';
        }
        return;
      }

      // Desktop Wide Mode
      bd.classList.add('hidden');
      sb.className = state.sidebarOpen ? 'w-[206px] shrink-0 flex flex-col pr-2 pt-1 pb-1 overflow-hidden' : 'hidden';

      if (isSplitReadingActive()) {
        // Default Calm Split: Stream (left) + Spacious Claude Reading Paper (right)
        bp.className = 'craft-paper flex flex-col min-w-0 overflow-hidden relative shrink-0';
        bp.style.width = state.browseWidthPx + 'px';
        gutter.classList.remove('hidden');
        rp.className = 'claude-paper flex-1 flex flex-col min-w-0 overflow-hidden relative';
      } else {
        // Full-Width Mode for Table / Board / Gallery / Triage / Empty!
        bp.className = 'craft-paper flex-1 flex flex-col min-w-0 overflow-hidden relative';
        bp.style.width = '';
        gutter.classList.add('hidden');
        if (state.readingOverlayOpen && state.selectedItemId && !state.emptyMode) {
          // Craft-style Slide-Over Reading Sheet on top of full-width view
          rp.className = 'claude-paper flex flex-col min-w-0 overflow-hidden absolute inset-y-0 right-0 w-[56%] max-w-[740px] z-20';
          rp.style.boxShadow = 'var(--shadow-sheet)';
        } else {
          rp.className = 'hidden';
        }
      }
    }

    function renderBrowseHeader() {
      const scopeNames = {
        all: '全部内容', unread: '待读', reading: '进行中', read: '已读',
        archived: '归档', abandoned: '放弃', triage: '需要处理'
      };
      let title = scopeNames[state.scope] || '阅读';
      if (state.scope.startsWith('copy:')) {
        const d = DESTINATIONS.find(x => x.id === state.scope.slice(5));
        title = d ? d.name : '已保存副本';
      }
      const activeView = state.views.find(v => v.id === state.activeViewId);
      if (activeView) title = activeView.name;

      document.getElementById('sheet-title').textContent = title;

      const items = getFilteredItems();
      const hasFilters = state.filterTime !== 'all' || state.filterMedia !== 'all' || state.filterTags.length > 0 || state.search.trim().length > 0;
      const base = getSourceCount(state.source);
      const countEl = document.getElementById('sheet-count');
      if (state.emptyMode) countEl.textContent = '0';
      else if (hasFilters) countEl.textContent = `命中 ${items.length} / ${base.toLocaleString()}`;
      else countEl.textContent = state.scope === 'all' ? base.toLocaleString() : `${items.length}`;

      // Dirty View Actions
      const dirtyBox = document.getElementById('dirty-view-actions');
      if (activeView && isViewDirty()) {
        dirtyBox.className = 'inline-flex items-center gap-1';
        dirtyBox.innerHTML = `
          <button id="btn-view-update" class="px-1.5 py-0.5 rounded bg-blue-600 text-white text-[11px] font-medium hover:bg-blue-700">更新</button>
          <button id="btn-view-saveas" class="px-1.5 py-0.5 rounded bg-black/[0.05] text-neutral-700 text-[11px] font-medium hover:bg-black/10">另存</button>
          <button id="btn-view-revert" class="p-0.5 text-neutral-400 hover:text-neutral-800" title="还原"><i data-lucide="rotate-ccw" class="w-3 h-3"></i></button>`;
      } else {
        dirtyBox.className = 'hidden';
        dirtyBox.innerHTML = '';
      }

      // Layout Bar (4 layouts: Stream / Table / Board / Gallery)
      const layoutEl = document.getElementById('layout-bar');
      if (state.scope === 'triage' || state.emptyMode) {
        layoutEl.innerHTML = '';
      } else {
        const modes = [
          { id: 'stream', icon: 'align-left', title: '精简阅读流（双栏分屏）' },
          { id: 'table', icon: 'table-2', title: '全宽属性表格' },
          { id: 'board', icon: 'kanban', title: '阅读进度看板' },
          { id: 'gallery', icon: 'layout-grid', title: '视觉灵感画廊' }
        ];
        layoutEl.innerHTML = modes.map(m => `
          <button data-layout="${m.id}" class="w-6 h-6 rounded-[5px] flex items-center justify-center transition ${state.layout === m.id ? 'bg-white text-neutral-900 shadow-sm' : 'text-neutral-400 hover:text-neutral-700'}" title="${m.title}">
            <i data-lucide="${m.icon}" class="w-3.5 h-3.5"></i>
          </button>`).join('');
      }

      document.getElementById('dot-filter').classList.toggle('hidden', !hasFilters);
    }

    function renderFilterStrip() {
      const chips = [];
      if (state.filterTime !== 'all') chips.push({ k: 'time', l: `近 ${state.filterTime} 天` });
      if (state.filterMedia !== 'all') chips.push({ k: 'media', l: { image: '含图片', video: '含视频', link: '含外链' }[state.filterMedia] });
      state.filterTags.forEach(t => chips.push({ k: `tag:${t}`, l: `#${t}` }));
      if (state.search.trim()) chips.push({ k: 'search', l: `“${state.search.trim()}”` });

      const strip = document.getElementById('filter-strip');
      if (!chips.length) { strip.classList.add('hidden'); return; }
      strip.classList.remove('hidden');
      document.getElementById('filter-chips').innerHTML = chips.map(c => `
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white border border-black/[0.08] text-neutral-700 text-[11.5px]">
          ${escapeHtml(c.l)}
          <button data-rm-filter="${c.k}" aria-label="移除此筛选" class="text-neutral-400 hover:text-neutral-800"><i data-lucide="x" class="w-2.5 h-2.5"></i></button>
        </span>`).join('');
    }

    function renderSystemBanner() {
      const b = document.getElementById('system-banner');
      const pendingUndo = state.items.find(i => i.pendingRemoteUndo && i.status === 'abandoned');
      if (state.offlineMode) {
        b.className = 'px-3.5 py-2 hair-b bg-amber-50/70 text-amber-900 text-[12px] flex items-center justify-between gap-2 shrink-0';
        b.innerHTML = `
          <span class="flex items-center gap-1.5 truncate"><i data-lucide="wifi-off" class="w-3.5 h-3.5 text-amber-600 shrink-0"></i><span class="truncate">已断网 · 本机正文可读，下载已暂停</span></span>
          <button id="btn-reconnect" class="px-2 py-0.5 rounded bg-white border border-amber-300 text-amber-900 font-medium text-[11.5px] whitespace-nowrap">恢复联网</button>`;
        return;
      }
      if (pendingUndo) {
        b.className = 'px-3.5 py-2 hair-b bg-neutral-100/90 text-neutral-800 text-[12px] flex items-center justify-between gap-2 shrink-0';
        b.innerHTML = `
          <span class="truncate">下次同步将取消 X 原收藏（尚未发出）</span>
          <button data-undo-abandon="${pendingUndo.id}" class="px-2 py-0.5 rounded bg-white border border-black/10 text-neutral-800 font-medium text-[11.5px] whitespace-nowrap">改回待读</button>`;
        return;
      }
      b.className = 'hidden';
      b.innerHTML = '';
    }

    function sourceShort(src) {
      return { x_bookmark: 'X 书签', x_like: 'X 喜欢', telegram: 'Telegram', dida: '滴答' }[src] || src;
    }

    function attBadge(item) {
      if (!item.attachments.length) return '';
      const ok = item.attachments.filter(a => a.localReady).length;
      const tot = item.attachments.length;
      const isVid = item.attachments.some(a => a.kind === 'video');
      const cls = ok === tot ? 'text-neutral-400' : 'text-amber-700 font-medium';
      return `<span class="inline-flex items-center gap-0.5 font-mono-tech text-[11px] ${cls}" title="本机附件 ${ok}/${tot}"><i data-lucide="${isVid ? 'film' : 'paperclip'}" class="w-3 h-3"></i>${ok}/${tot}</span>`;
    }

    function renderBrowseBody() {
      const el = document.getElementById('browse-body');
      if (state.emptyMode) {
        el.innerHTML = `
          <div class="h-full flex flex-col items-center justify-center p-10 text-center max-w-md mx-auto">
            <div class="w-11 h-11 rounded-[12px] bg-neutral-100 flex items-center justify-center text-neutral-700 mb-4"><i data-lucide="bookmark-plus" class="w-5 h-5"></i></div>
            <h3 class="text-[16px] font-semibold text-neutral-900 mb-2">还没有连接任何阅读来源</h3>
            <p class="text-[13.5px] text-neutral-500 leading-relaxed mb-6">连接 X 书签、Telegram、滴答稍后读或本地 Obsidian 目录，把分散的内容汇入这片安静的离线阅读区。</p>
            <div class="flex items-center gap-2.5">
              <button id="btn-empty-sync" class="px-4 py-2 rounded-[9px] bg-neutral-900 hover:bg-neutral-800 text-white text-[13px] font-medium transition">连接第一个来源</button>
              <button id="btn-empty-demo" class="px-4 py-2 rounded-[9px] bg-white border border-black/10 hover:bg-neutral-50 text-neutral-700 text-[13px] font-medium transition">载入 1,248 条示例库</button>
            </div>
          </div>`;
        return;
      }

      if (state.scope === 'triage') { renderTriage(el); return; }

      const items = getFilteredItems();
      if (!items.length) {
        el.innerHTML = `
          <div class="h-full flex flex-col items-center justify-center p-8 text-center max-w-xs mx-auto">
            <p class="text-[14px] font-medium text-neutral-800 mb-1">当前条件下没有匹配内容</p>
            <p class="text-[12.5px] text-neutral-400 mb-4">阅读库中仍有 ${getSourceCount('all').toLocaleString()} 条内容</p>
            <button id="btn-empty-reset" class="px-3.5 py-1.5 rounded-[8px] bg-neutral-900 text-white text-[12.5px] font-medium">清除筛选条件</button>
          </div>`;
        return;
      }

      if (state.layout === 'stream') renderStream(el, items);
      else if (state.layout === 'table') renderTable(el, items);
      else if (state.layout === 'board') renderBoard(el, items);
      else if (state.layout === 'gallery') renderGallery(el, items);
    }

    // Default Layout: Tactile Craft / Apple Mail Stream Well with Elevated Selected Card
    function renderStream(el, items) {
      el.innerHTML = `
        <div class="min-h-full stream-well p-2.5 space-y-1.5">
          ${items.map(item => {
            const sel = state.selectedItemId === item.id;
            const checked = state.checkedIds.has(item.id);
            const unread = item.status === 'unread';
            return `
              <div data-open-item="${item.id}" tabindex="0" class="stream-item focus-ring group relative px-3.5 py-3 rounded-[11px] cursor-pointer transition ${sel ? 'is-selected stream-card-active' : 'hover:bg-white/70'}">
                <div class="flex items-start gap-2.5">
                  <div class="w-4 pt-[5px] flex items-center justify-center shrink-0">
                    <input type="checkbox" data-check="${item.id}" ${checked ? 'checked' : ''} class="hub-chk ${checked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}" />
                    ${!checked && unread ? '<span class="w-[6px] h-[6px] rounded-full bg-blue-600 group-hover:hidden"></span>' : ''}
                    ${!checked && item.status === 'reading' ? '<span class="w-[6px] h-[6px] rounded-full bg-amber-500 group-hover:hidden"></span>' : ''}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-start justify-between gap-2">
                      <h3 class="text-[13.5px] leading-[1.45] tracking-[-0.005em] line-clamp-2 ${item.status === 'read' ? 'text-neutral-500 font-normal' : 'text-[#141413] font-medium'}">${item.title}</h3>
                      ${item.triage ? '<span class="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title="有待处理项"></span>' : ''}
                    </div>
                    <p class="text-[12px] text-neutral-500/85 line-clamp-1 mt-1 leading-relaxed">${item.excerpt}</p>
                    <div class="flex items-center justify-between gap-2 mt-2 text-[11.5px] text-neutral-400">
                      <div class="flex items-center gap-1.5 truncate">
                        <span class="text-neutral-600 font-medium">${item.author}</span>
                        <span class="text-neutral-300">·</span>
                        <span>${sourceShort(item.source)}</span>
                        <span class="text-neutral-300">·</span>
                        <span class="font-mono-tech">${item.publishedAt}</span>
                      </div>
                      <div class="flex items-center gap-1.5 shrink-0">
                        ${attBadge(item)}
                        ${item.tags[0] ? `<span class="px-1.5 py-0.2 rounded bg-black/[0.04] text-neutral-500 text-[10.5px]">${item.tags[0]}</span>` : ''}
                      </div>
                    </div>
                  </div>
                </div>
              </div>`;
          }).join('')}
          <div class="pt-3 pb-2 text-[11px] text-neutral-400 text-center font-mono-tech">第 1 页 · 每页 60 条（演示样本 ${items.length} 条）</div>
        </div>`;
    }

    // Full-Width Table (Never Cramped!)
    function renderTable(el, items) {
      el.innerHTML = `
        <table class="w-full table-fixed text-left border-collapse">
          <thead class="sticky top-0 bg-white/95 backdrop-blur-sm z-10 hair-b text-[11.5px] text-neutral-400 font-medium">
            <tr>
              <th class="py-2.5 pl-4 pr-1 w-9"></th>
              <th class="py-2.5 px-2 w-16 whitespace-nowrap">状态</th>
              <th class="py-2.5 px-2">内容</th>
              <th class="py-2.5 px-2 w-24">来源</th>
              <th class="py-2.5 px-2 w-28">作者</th>
              <th class="py-2.5 px-2 w-28">收集时间</th>
              <th class="py-2.5 pr-4 pl-2 text-right w-24">附件</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-black/[0.045] text-[13px]">
            ${items.map(item => {
              const sm = STATUS_META[item.status] || STATUS_META.unread;
              const checked = state.checkedIds.has(item.id);
              return `
                <tr data-open-item="${item.id}" class="cursor-pointer hover:bg-black/[0.02] transition ${state.selectedItemId === item.id && state.readingOverlayOpen ? 'bg-blue-50/60' : ''}">
                  <td class="py-3 pl-4 pr-1"><input type="checkbox" data-check="${item.id}" ${checked ? 'checked' : ''} class="hub-chk" /></td>
                  <td class="py-3 px-2">
                    <button data-quick-status="${item.id}" class="inline-flex items-center gap-1.5 text-[12px] ${sm.text} hover:underline whitespace-nowrap">
                      <span class="w-2 h-2 rounded-full border ${sm.ring}"></span>${sm.label}
                    </button>
                  </td>
                  <td class="py-3 px-2">
                    <div class="font-medium text-neutral-900 truncate">${item.title}</div>
                    <div class="text-[11.5px] text-neutral-400 flex items-center gap-2 mt-0.5">${item.tags.map(t => `<span>#${t}</span>`).join('')}</div>
                  </td>
                  <td class="py-3 px-2 text-[12px] text-neutral-500">${sourceShort(item.source)}</td>
                  <td class="py-3 px-2 text-[12.5px] text-neutral-600 truncate">${item.author}</td>
                  <td class="py-3 px-2 font-mono-tech text-[12px] text-neutral-400">${item.collectedAt}</td>
                  <td class="py-3 pr-4 pl-2 text-right">${attBadge(item)}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    }

    // Full-Width Kanban Board
    function renderBoard(el, items) {
      const cols = [
        { id: 'unread', label: '待读', dot: 'bg-blue-600' },
        { id: 'reading', label: '进行中', dot: 'bg-amber-500' },
        { id: 'read', label: '已读', dot: 'bg-teal-600' },
        { id: 'abandoned', label: '放弃', dot: 'bg-neutral-400' }
      ];
      const pool = state.scope === 'all'
        ? state.items.filter(i => i.lifecycle === 'normal' && (state.source === 'all' || i.source === state.source))
        : items;

      el.innerHTML = `
        <div class="px-4 py-2 hair-b bg-neutral-50/70 flex items-center justify-between text-[12px]">
          <span class="text-neutral-500">拖拽卡片或点微调箭头切换状态（保留原有标签）</span>
          <label class="inline-flex items-center gap-1.5 cursor-pointer text-neutral-700 font-medium">
            <input type="checkbox" id="chk-board-fail" ${state.simBoardFail ? 'checked' : ''} class="rounded border-neutral-300 text-amber-600" />
            <span>模拟下次保存失败（验证回弹）</span>
          </label>
        </div>
        <div class="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5 h-[calc(100%-38px)] overflow-y-auto">
          ${cols.map(c => {
            const list = pool.filter(i => i.status === c.id);
            return `
              <div data-board-col="${c.id}" class="rounded-[12px] bg-[#F7F8FA] p-2.5 flex flex-col gap-2.5 min-h-[240px]">
                <div class="flex items-center justify-between px-1.5 pt-0.5">
                  <span class="text-[12.5px] font-semibold text-neutral-800 flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full ${c.dot}"></span>${c.label}</span>
                  <span class="font-mono-tech text-[11.5px] text-neutral-400">${list.length}</span>
                </div>
                <div class="space-y-2 flex-1">
                  ${list.map(item => `
                    <div data-board-card="${item.id}" draggable="true" class="bg-white rounded-[10px] p-3 hair-box shadow-[0_1px_2px_rgba(0,0,0,0.03)] cursor-grab hover:shadow-md transition">
                      <div class="text-[13px] font-medium text-neutral-900 leading-snug line-clamp-2 mb-2">${item.title}</div>
                      <div class="flex items-center justify-between text-[11.5px] text-neutral-400">
                        <span>${item.author} · ${sourceShort(item.source)}</span>
                        ${attBadge(item)}
                      </div>
                      <div class="flex items-center justify-between pt-2 mt-2 hair-t">
                        <span class="text-[11px] text-neutral-400 truncate">${item.tags.map(t => `#${t}`).join(' ')}</span>
                        <div class="flex items-center gap-0.5">
                          <button data-move-col="${item.id}:prev" class="p-1 rounded hover:bg-neutral-100 text-neutral-400 hover:text-neutral-800"><i data-lucide="chevron-left" class="w-3 h-3"></i></button>
                          <button data-move-col="${item.id}:next" class="p-1 rounded hover:bg-neutral-100 text-neutral-400 hover:text-neutral-800"><i data-lucide="chevron-right" class="w-3 h-3"></i></button>
                        </div>
                      </div>
                    </div>`).join('')}
                </div>
              </div>`;
          }).join('')}
        </div>`;
    }

    // Full-Width Gallery
    function renderGallery(el, items) {
      el.innerHTML = `
        <div class="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          ${items.map(item => {
            const hasVid = item.attachments.some(a => a.kind === 'video');
            const vidMissing = item.attachments.some(a => a.kind === 'video' && !a.localReady);
            return `
              <article data-open-item="${item.id}" class="rounded-[12px] hair-box bg-white overflow-hidden cursor-pointer hover:shadow-md transition flex flex-col">
                ${item.hasImage || item.hasVideo ? `
                  <div class="h-36 p-4 flex flex-col justify-between ${hasVid ? 'bg-neutral-900 text-white' : 'bg-[#F5F7FA] text-neutral-700'}">
                    <div class="flex items-center justify-between text-[11px]">
                      <span class="px-2 py-0.5 rounded-full ${hasVid ? 'bg-white/15 text-white' : 'bg-white text-neutral-600'}">${hasVid ? '视频 + 图片' : '图文'}</span>
                      ${vidMissing ? '<span class="px-2 py-0.5 rounded-full bg-amber-500 text-white font-medium">原视频未下载</span>' : ''}
                    </div>
                    <div class="flex items-center gap-2 text-[12px] opacity-80">
                      <i data-lucide="${hasVid ? 'play-circle' : 'image'}" class="w-4 h-4"></i>
                      <span class="truncate">${item.attachments[0]?.name || '媒体预览'}</span>
                    </div>
                  </div>
                ` : `
                  <div class="h-36 p-5 bg-[#FCFBF9] hair-b flex items-center">
                    <p class="text-[13px] text-neutral-600 leading-relaxed line-clamp-4">“${item.excerpt}”</p>
                  </div>
                `}
                <div class="p-3.5 flex-1 flex flex-col justify-between gap-2.5">
                  <h3 class="text-[13.5px] font-medium text-neutral-900 leading-snug line-clamp-2">${item.title}</h3>
                  <div class="flex items-center justify-between text-[11.5px] text-neutral-400">
                    <span>${item.author} · ${sourceShort(item.source)}</span>
                    ${attBadge(item)}
                  </div>
                </div>
              </article>`;
          }).join('')}
        </div>`;
    }

    // 3-Track Codex Triage View
    function renderTriage(el) {
      const list = state.items.filter(i => i.triage !== null);
      if (!list.length) {
        el.innerHTML = `<div class="h-full flex flex-col items-center justify-center p-10 text-center"><p class="text-[14.5px] font-medium text-neutral-900">所有待处理项已清零</p><p class="text-[12.5px] text-neutral-400 mt-1">当前没有待确认方案、未核对回执或同步异常。</p></div>`;
        return;
      }
      const tracks = [
        { id: 'confirm', title: '待你确认', sub: '需人工决策方案或核对外部页面，避免重复写入', bar: 'border-l-amber-500' },
        { id: 'recoverable', title: '后台可恢复', sub: '正常排队或下载中断，联网后复用已完成部分续传', bar: 'border-l-blue-500' },
        { id: 'error', title: '需重连与会话故障', sub: '来源凭证或附件会话过期，已自动保护原内容', bar: 'border-l-red-500' }
      ];
      el.innerHTML = `
        <div class="p-5 max-w-3xl mx-auto space-y-6">
          ${tracks.map(tr => {
            const sub = list.filter(i => i.triage.track === tr.id);
            if (!sub.length) return '';
            return `
              <div>
                <div class="flex items-baseline justify-between mb-2.5">
                  <div>
                    <span class="text-[13.5px] font-semibold text-neutral-900">${tr.title}</span>
                    <span class="text-[12px] text-neutral-400 ml-2">${tr.sub}</span>
                  </div>
                  <span class="font-mono-tech text-[12px] text-neutral-400">${sub.length}</span>
                </div>
                <div class="space-y-2">
                  ${sub.map(item => `
                    <div class="p-3.5 rounded-[10px] bg-white hair-box border-l-2 ${tr.bar} flex items-center justify-between gap-4">
                      <div data-open-item="${item.id}" class="min-w-0 flex-1 cursor-pointer">
                        <div class="text-[12px] text-neutral-500 mb-0.5"><strong class="font-medium text-neutral-800">${item.triage.targetName}</strong> · ${item.triage.summary}</div>
                        <div class="text-[13.5px] font-medium text-neutral-900 truncate">${item.title}</div>
                      </div>
                      <div class="flex items-center gap-1.5 shrink-0">
                        ${item.triage.kind === 'save_plan' ? `<button data-open-plan="${item.id}" class="px-3 py-1 rounded-[7px] bg-neutral-900 hover:bg-neutral-800 text-white text-[12px] font-medium">查看方案</button>` : ''}
                        ${item.triage.kind === 'craft_uncertain' ? `<button data-open-reconcile="${item.id}" class="px-3 py-1 rounded-[7px] bg-amber-600 hover:bg-amber-700 text-white text-[12px] font-medium">核对并关联</button>` : ''}
                        ${item.triage.kind === 'att_paused' ? `<button data-resume-att="${item.id}" class="px-3 py-1 rounded-[7px] bg-neutral-100 hover:bg-neutral-200 text-neutral-800 text-[12px] font-medium">续传附件</button>` : ''}
                        ${item.triage.kind === 'dida_session' ? `
                          <button data-recheck-dida="${item.id}" class="px-2.5 py-1 rounded-[7px] bg-neutral-100 hover:bg-neutral-200 text-neutral-700 text-[12px] font-medium">重新检查</button>
                          <button data-keep-both="${item.id}" class="px-2.5 py-1 rounded-[7px] border border-black/10 hover:bg-neutral-50 text-neutral-700 text-[12px] font-medium">保留两边</button>` : ''}
                      </div>
                    </div>`).join('')}
                </div>
              </div>`;
          }).join('')}
        </div>`;
    }

    function renderBatchPill() {
      const p = document.getElementById('batch-pill');
      if (state.checkedIds.size >= 2) {
        p.classList.remove('hidden');
        document.getElementById('batch-count').textContent = `已选 ${state.checkedIds.size} 条`;
      } else {
        p.classList.add('hidden');
      }
    }

    // Claude Desktop + Craft Editorial Reading Paper
    function renderReadingPaper() {
      const item = state.items.find(i => i.id === state.selectedItemId);
      if (!item) return;

      const sm = STATUS_META[item.status] || STATUS_META.unread;
      const destNames = Object.entries(item.destinations)
        .filter(([, v]) => v.state !== 'removed')
        .map(([k, v]) => {
          const d = DESTINATIONS.find(x => x.id === k);
          const warn = v.state !== 'saved' ? ' · 待处理' : '';
          return (d ? d.short : k) + warn;
        });

      const showBackBtn = state.narrowMode || !isSplitReadingActive();

      document.getElementById('reading-topbar').innerHTML = `
        <div class="flex items-center gap-2 min-w-0">
          ${showBackBtn ? `<button id="btn-reading-back" class="inline-flex items-center gap-1 px-2 py-1 -ml-2 rounded-[7px] text-[12.5px] font-medium text-neutral-700 hover:bg-black/[0.05] transition"><i data-lucide="arrow-left" class="w-3.5 h-3.5"></i>${state.narrowMode ? '返回列表' : '收起阅读'}</button>` : ''}
          <span class="text-[12px] text-neutral-400 truncate">${sourceShort(item.source)} · ${item.handle}</span>
        </div>
        <div class="flex items-center gap-0.5 shrink-0">
          ${item.source !== 'dida' && item.url ? `<button id="btn-copy-url" class="w-7 h-7 rounded-[7px] flex items-center justify-center text-neutral-400 hover:bg-black/[0.05] hover:text-neutral-800 transition" title="复制来源链接"><i data-lucide="link-2" class="w-3.5 h-3.5"></i></button>` : ''}
          <button id="btn-open-asst" class="h-7 px-2.5 rounded-[7px] text-[12px] font-medium text-neutral-600 hover:bg-black/[0.05] hover:text-neutral-950 inline-flex items-center gap-1.5 transition" title="用 Hub 助手讨论当前文章">
            <i data-lucide="sparkles" class="w-3.5 h-3.5 text-blue-600"></i><span>询问助手</span>
          </button>
          <button id="btn-open-insp" class="w-7 h-7 rounded-[7px] flex items-center justify-center text-neutral-400 hover:bg-black/[0.05] hover:text-neutral-800 transition relative" title="本文管理与核验">
            <i data-lucide="shield-check" class="w-4 h-4"></i>
            ${item.triage ? '<span class="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-amber-500"></span>' : ''}
          </button>
          <button id="btn-item-more" class="w-7 h-7 rounded-[7px] flex items-center justify-center text-neutral-400 hover:bg-black/[0.05] hover:text-neutral-800 transition" title="归档 / 永久删除">
            <i data-lucide="more-horizontal" class="w-4 h-4"></i>
          </button>
        </div>`;

      // Codex Contextual Engineering Strip (Only appears when item has archive/retention/triage state)
      let codexBar = '';
      if (item.lifecycle === 'archived') {
        codexBar = `
          <div class="mb-6 px-3.5 py-2.5 rounded-[10px] bg-neutral-100/90 border-l-2 border-l-neutral-500 flex items-center justify-between gap-3 text-[12.5px] text-neutral-700">
            <span>已归档 · 已保存的资料库副本保持不变</span>
            <button id="btn-unarchive" class="px-2.5 py-1 rounded-[7px] bg-white border border-black/10 font-medium text-neutral-900 hover:bg-neutral-50 whitespace-nowrap">恢复到${STATUS_META[item.prevStatus].label}</button>
          </div>`;
      } else if (item.sourceRetention?.retained && !item.sourceRetention.resolvedKeepBoth) {
        codexBar = `
          <div class="mb-6 px-3.5 py-3 rounded-[10px] bg-amber-50/75 border-l-2 border-l-amber-500 space-y-2 text-[12.5px] text-amber-950">
            <div class="font-medium">滴答原任务已受保护保留</div>
            <p class="text-amber-900/80 text-[12px] leading-relaxed">${item.sourceRetention.reason}</p>
            <div class="flex items-center gap-2 pt-0.5">
              <button data-recheck-dida="${item.id}" class="px-2.5 py-1 rounded-[7px] bg-white border border-amber-300 text-amber-950 font-medium text-[12px]">重新检查</button>
              <button data-keep-both="${item.id}" class="px-2.5 py-1 rounded-[7px] bg-neutral-900 text-white font-medium text-[12px]">保留两边并结束处理</button>
            </div>
          </div>`;
      } else if (item.triage && item.triage.kind === 'craft_uncertain') {
        codexBar = `
          <div class="mb-6 px-3.5 py-2.5 rounded-[10px] bg-amber-50/75 border-l-2 border-l-amber-500 flex items-center justify-between gap-3 text-[12.5px] text-amber-950">
            <span>Craft · 灵感库写入结果不明，已锁定重复写入</span>
            <button data-open-reconcile="${item.id}" class="px-2.5 py-1 rounded-[7px] bg-amber-600 text-white font-medium text-[12px] whitespace-nowrap">核对并关联</button>
          </div>`;
      }

      document.getElementById('reading-scroll').innerHTML = `
        <article class="max-w-[62ch] mx-auto">
          ${codexBar}

          ${item.forwardedFrom ? `<div class="mb-3 text-[12px] text-neutral-400 flex items-center gap-1.5"><i data-lucide="forward" class="w-3.5 h-3.5"></i>转发自 ${item.forwardedFrom}</div>` : ''}

          <div class="mb-2.5 flex items-center gap-2 text-[11.5px] text-neutral-400 font-mono-tech">
            <span class="uppercase tracking-wider text-neutral-500 font-sans font-medium">${sourceShort(item.source)}</span>
            <span>·</span>
            <span>约 ${Math.max(1, item.body.length)} 分钟阅读</span>
          </div>
          <h1 class="text-[23px] sm:text-[25px] font-semibold text-[#141413] leading-[1.36] tracking-[-0.02em] mb-4">${item.title}</h1>

          <!-- Notion Inline Subtraction: One whisper-quiet metadata line (zero clunky boxes until hovered!) -->
          <div class="flex items-center gap-x-3 gap-y-1.5 flex-wrap pb-6 mb-7 hair-b text-[12.5px] text-neutral-500">
            <span class="text-neutral-800 font-medium">${item.author}</span>
            <span class="font-mono-tech text-neutral-400" title="收集于 ${item.collectedAt}">${item.collectedAt}</span>
            <span class="text-neutral-300">·</span>
            <button id="btn-status-inline" class="inline-ghost inline-flex items-center gap-1.5 ${sm.text} font-medium">
              <span class="w-1.5 h-1.5 rounded-full ${sm.dot}"></span>${sm.label}
            </button>
            <span class="text-neutral-300">·</span>
            <button id="btn-dest-inline" class="inline-ghost inline-flex items-center gap-1 text-neutral-600">
              <i data-lucide="folder-output" class="w-3.5 h-3.5 text-neutral-400"></i>
              <span>${destNames.join(' / ')}</span>
            </button>
            <span class="text-neutral-300">·</span>
            <div class="inline-flex items-center gap-2 flex-wrap">
              ${item.tags.map(t => `<span class="inline-flex items-center gap-0.5 text-neutral-500">#${t}<button data-rm-tag="${t}" class="text-neutral-300 hover:text-neutral-700 ml-0.5"><i data-lucide="x" class="w-2.5 h-2.5"></i></button></span>`).join('')}
              <button id="btn-tag-inline" class="inline-ghost text-neutral-400 hover:text-neutral-800">+ 标签</button>
            </div>
          </div>

          <!-- Claude Desktop Comfortable Reading Flow (Attachments Interleaved Inline in Natural Order) -->
          <div class="claude-prose">
            ${item.body.map((p, idx) => {
              const att = item.attachments[idx];
              let inlineAttHtml = '';
              if (att) {
                if (att.kind === 'image') {
                  inlineAttHtml = `
                    <figure class="my-6 rounded-[12px] overflow-hidden bg-white hair-box shadow-[0_1px_3px_rgba(0,0,0,0.03)]">
                      <div class="h-44 px-6 flex flex-col items-center justify-center bg-gradient-to-br from-[#F6F8FC] via-[#F2F5FA] to-[#EDF1F7] relative">
                        <div class="w-full max-w-[320px] space-y-2 opacity-80">
                          <div class="h-2.5 w-24 rounded-full bg-blue-500/20"></div>
                          <div class="grid grid-cols-3 gap-2">
                            <div class="h-12 rounded-[7px] bg-white border border-black/[0.06]"></div>
                            <div class="h-12 rounded-[7px] bg-white border border-black/[0.06]"></div>
                            <div class="h-12 rounded-[7px] bg-white border border-black/[0.06]"></div>
                          </div>
                          <div class="h-2 w-40 rounded-full bg-neutral-400/20"></div>
                        </div>
                        ${!att.localReady ? `
                          <div class="absolute inset-0 bg-white/75 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2 p-4 text-center">
                            <span class="text-[12.5px] font-medium text-amber-800">${att.error || (state.offlineMode ? '断网暂停下载' : '原图尚未下载到本机')}</span>
                            <button data-dl-att="${item.id}:${att.id}" class="px-3 py-1 rounded-[7px] bg-neutral-900 hover:bg-neutral-800 text-white text-[12px] font-medium whitespace-nowrap transition">下载原图 (${att.sizeMb} MB)</button>
                          </div>` : ''}
                      </div>
                      <figcaption class="px-3.5 py-2 hair-t bg-white flex items-center justify-between gap-2 text-[11.5px] text-neutral-400">
                        <span class="truncate">${att.name}</span>
                        <span class="font-mono-tech whitespace-nowrap shrink-0">${att.sizeMb} MB${att.localReady ? '' : ' · 未下载'}</span>
                      </figcaption>
                    </figure>`;
                } else if (att.kind === 'video') {
                  inlineAttHtml = `
                    <figure class="my-6 rounded-[12px] overflow-hidden bg-neutral-900 text-white hair-box shadow-sm">
                      <div class="h-48 p-5 flex flex-col items-center justify-center gap-2.5 bg-gradient-to-br from-neutral-800 to-neutral-950 relative">
                        <div class="w-11 h-11 rounded-full bg-white/15 backdrop-blur-sm flex items-center justify-center">
                          <i data-lucide="play" class="w-5 h-5 text-white ml-0.5"></i>
                        </div>
                        <div class="text-[12.5px] text-white/90 font-medium">${att.localReady ? '原视频已就绪，点击播放' : '缩略图预览 · 原视频未下载'}</div>
                        ${!att.localReady ? `<button data-dl-att="${item.id}:${att.id}" class="mt-0.5 px-3 py-1 rounded-[7px] bg-white text-neutral-900 hover:bg-neutral-100 text-[12px] font-medium whitespace-nowrap transition">下载原视频 (${att.sizeMb} MB)</button>` : ''}
                      </div>
                      <figcaption class="px-3.5 py-2 border-t border-white/10 flex items-center justify-between gap-2 text-[11.5px] text-white/60">
                        <span class="truncate">${att.name}</span>
                        <span class="font-mono-tech whitespace-nowrap shrink-0">${att.sizeMb} MB</span>
                      </figcaption>
                    </figure>`;
                } else {
                  inlineAttHtml = `
                    <div class="my-5 px-3.5 py-2.5 rounded-[10px] bg-white hair-box flex items-center justify-between gap-3">
                      <div class="flex items-center gap-2.5 min-w-0">
                        <span class="w-8 h-8 rounded-[7px] bg-rose-50 text-rose-600 flex items-center justify-center shrink-0"><i data-lucide="file-text" class="w-4 h-4"></i></span>
                        <div class="min-w-0">
                          <div class="text-[13px] font-medium text-neutral-900 truncate">${att.name}</div>
                          <div class="text-[11.5px] font-mono-tech text-neutral-400">${att.sizeMb} MB · ${att.localReady ? '本机可用' : '未下载'}</div>
                        </div>
                      </div>
                      ${!att.localReady ? `<button data-dl-att="${item.id}:${att.id}" class="px-2.5 py-1 rounded-[7px] bg-neutral-900 text-white text-[12px] font-medium whitespace-nowrap shrink-0">下载</button>` : ''}
                    </div>`;
                }
              }
              return `<p>${p}</p>${inlineAttHtml}`;
            }).join('')}
          </div>

          <!-- Whisper-Quiet End-of-Reading Closure Bar (No J/K, No Line Wrapping) -->
          <div class="mt-10 pt-5 hair-t flex items-center justify-center gap-2 text-[12.5px]">
            <button data-quick-status="${item.id}" class="h-8 px-3.5 rounded-full whitespace-nowrap inline-flex items-center gap-1.5 transition ${item.status === 'read' ? 'bg-teal-50 text-teal-800 font-medium' : 'text-neutral-600 hover:bg-black/[0.045] hover:text-neutral-950'}">
              <i data-lucide="check" class="w-3.5 h-3.5"></i><span>${item.status === 'read' ? '已读' : '标为已读'}</span>
            </button>
            <span class="text-neutral-200">·</span>
            <button data-act-archive="${item.id}" class="h-8 px-3.5 rounded-full whitespace-nowrap inline-flex items-center gap-1.5 text-neutral-600 hover:bg-black/[0.045] hover:text-neutral-950 transition">
              <i data-lucide="archive" class="w-3.5 h-3.5 text-neutral-400"></i><span>${item.lifecycle === 'archived' ? '恢复到阅读' : '归档'}</span>
            </button>
          </div>
        </article>`;

      // Inspector & Assistant panels
      document.getElementById('inspector-panel').classList.toggle('hidden', !state.inspectorOpen);
      if (state.inspectorOpen) renderInspector(item);

      document.getElementById('assistant-panel').classList.toggle('hidden', !state.assistantOpen);
      if (state.assistantOpen) renderAssistant(item);
    }

    function renderInspector(item) {
      const ready = item.attachments.filter(a => a.localReady).length;
      const tot = item.attachments.length;
      const cr = item.cloudRecovery;
      const cloudFull = cr.bodyOk && cr.attOk === cr.attTotal;
      const destEntries = Object.entries(item.destinations);

      document.getElementById('inspector-body').innerHTML = `
        <!-- 4 Clean Hairline Truth Rows (No loud colored boxes!) -->
        <div class="divide-y divide-black/[0.05] text-[12.5px] rounded-[10px] bg-[#FAFAFA] hair-box px-3.5">
          <div class="py-2.5 flex items-center justify-between">
            <span class="text-neutral-500">1. 本机可读</span>
            <span class="font-medium text-teal-700">正文 ✓ ${tot ? `· 附件 ${ready}/${tot}` : ''}</span>
          </div>
          <div class="py-2.5 flex items-center justify-between">
            <span class="text-neutral-500">2. 云端可恢复</span>
            <span class="font-medium ${cloudFull ? 'text-teal-700' : 'text-amber-700'}">${cloudFull ? '完整已校验' : `正文 ✓ · 附件 ${cr.attOk}/${cr.attTotal}`}</span>
          </div>
          <div class="py-2.5 flex items-center justify-between">
            <span class="text-neutral-500">3. 资料库副本</span>
            <span class="font-medium text-neutral-800">${destEntries.filter(([,v]) => v.state === 'saved').length} / ${destEntries.length} 已保存</span>
          </div>
          <div class="py-2.5 flex items-center justify-between">
            <span class="text-neutral-500">4. 原平台状态</span>
            <span class="font-medium text-neutral-800">${item.pendingRemoteUndo ? '待取消原收藏' : '原项保留'}</span>
          </div>
        </div>

        <!-- Cloud Recovery Verification -->
        <div class="space-y-2 text-[12.5px]">
          <div class="flex items-center justify-between">
            <span class="font-semibold text-neutral-900">云端恢复检查</span>
            <button id="btn-verify-cloud" class="text-[12px] text-blue-600 hover:underline font-medium">重新校验</button>
          </div>
          <div class="text-[12px] text-neutral-500 font-mono-tech">上次核验：${cr.checkedAt}</div>
          <p class="text-[12.5px] text-neutral-600">正文校验通过；原附件 ${cr.attOk}/${cr.attTotal} 通过。</p>
          ${cr.missing.length ? `<div class="p-2.5 rounded-[8px] bg-amber-50/80 text-amber-900 text-[12px]">缺项：${cr.missing.join('；')}（未达完整恢复）</div>` : ''}
        </div>

        <!-- Destinations -->
        <div class="pt-3 hair-t space-y-2 text-[12.5px]">
          <div class="font-semibold text-neutral-900">资料库副本记录</div>
          <div class="divide-y divide-black/[0.05]">
            ${destEntries.map(([dId, rec]) => {
              const d = DESTINATIONS.find(x => x.id === dId);
              return `
                <div class="py-2 flex items-center justify-between gap-2">
                  <div>
                    <div class="font-medium text-neutral-800">${d ? d.name : dId}</div>
                    <div class="text-[11.5px] text-neutral-400 font-mono-tech">${rec.receipt || rec.note}</div>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="text-[11.5px] font-medium ${rec.state === 'saved' ? 'text-teal-700' : 'text-amber-700'}">${rec.state === 'saved' ? '已校验' : rec.state === 'uncertain' ? '结果不明' : '待确认'}</span>
                    ${rec.state === 'uncertain' ? `<button data-open-reconcile="${item.id}" class="text-blue-600 underline text-[11.5px]">核对</button>` : ''}
                    ${rec.state === 'needs_confirm' ? `<button data-open-plan="${item.id}" class="text-blue-600 underline text-[11.5px]">方案</button>` : ''}
                  </div>
                </div>`;
            }).join('')}
          </div>
        </div>

        ${item.sourceRetention ? `
          <div class="pt-3 hair-t space-y-1.5 text-[12px] text-neutral-600">
            <div class="font-semibold text-[12.5px] text-neutral-900">来源恢复凭证（滴答清理门禁）</div>
            <div>· 完整云恢复结果：${item.sourceRetention.checks.cloudComplete ? '通过' : '未通过（缺附件）'}</div>
            <div>· 原采集设备凭证：有效</div>
            <div>· 删除前复核：云同步保护开启中</div>
          </div>` : ''}
      `;
    }

    function renderAssistant(item) {
      document.getElementById('asst-context-bar').innerHTML = `
        <span class="truncate">当前绑定：<strong class="font-medium text-neutral-900">${item.title}</strong></span>
        <span class="text-[11px] text-neutral-400 whitespace-nowrap">${state.assistantMode === 'new' ? '新对话' : '沿用对话'}</span>`;
      document.getElementById('asst-messages').innerHTML = state.assistantThread.map(m => {
        if (m.role === 'user') return `<div class="ml-8 p-2.5 rounded-[10px] bg-neutral-900 text-white text-[13px] leading-relaxed">${escapeHtml(m.text)}</div>`;
        if (m.role === 'assistant') return `<div class="mr-4 p-3 rounded-[10px] bg-[#F7F8FA] text-neutral-800 text-[13px] leading-relaxed">${escapeHtml(m.text)}</div>`;
        return `<div class="text-center text-[12px] text-neutral-400 py-2">${escapeHtml(m.text)}</div>`;
      }).join('');
    }

    // =========================================================================
    // 4. POPOVERS & MODALS
    // =========================================================================
    let popoverOpener = null;
    let readingModalOpener = null;

    function focusReadingControl(card, label, modal) {
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', label);
      card.setAttribute('tabindex', '-1');
      if (modal) card.setAttribute('aria-modal', 'true');
      card.focus({preventScroll: true});
    }

    function openPopover(anchor, html, width = 260) {
      const root = document.getElementById('popover-root');
      const card = document.getElementById('popover-card');
      card.innerHTML = html;
      card.style.width = width + 'px';
      root.classList.remove('hidden');
      const r = anchor.getBoundingClientRect();
      let left = r.left;
      let top = r.bottom + 6;
      if (left + width > window.innerWidth - 12) left = Math.max(12, window.innerWidth - width - 12);
      if (top + 340 > window.innerHeight) top = Math.max(12, r.top - 300);
      card.style.left = left + 'px';
      card.style.top = top + 'px';
      if (anchor.id === 'btn-filter' || anchor.id === 'btn-sort') {
        popoverOpener = anchor;
        anchor.setAttribute('aria-expanded', 'true');
        focusReadingControl(card, anchor.title, false);
      }
      if (window.lucide) lucide.createIcons();
    }
    function closePopover() {
      document.getElementById('popover-root').classList.add('hidden');
      const card = document.getElementById('popover-card');
      card.removeAttribute('role');
      card.removeAttribute('aria-label');
      card.removeAttribute('tabindex');
      if (popoverOpener) {
        popoverOpener.setAttribute('aria-expanded', 'false');
        popoverOpener.focus({preventScroll: true});
        popoverOpener = null;
      }
    }

    function openModal(html, maxW = 540, label = "") {
      const root = document.getElementById('modal-root');
      const card = document.getElementById('modal-card');
      const wasOpen = !root.classList.contains('hidden');
      card.style.maxWidth = maxW + 'px';
      card.innerHTML = html;
      root.classList.remove('hidden');
      if (label) {
        if (!wasOpen) readingModalOpener = document.activeElement;
        focusReadingControl(card, label, true);
      }
      if (window.lucide) lucide.createIcons();
    }
    function closeModal() {
      document.getElementById('modal-root').classList.add('hidden');
      const card = document.getElementById('modal-card');
      ['role','aria-label','aria-modal','tabindex'].forEach(name => card.removeAttribute(name));
      if (readingModalOpener) {
        readingModalOpener.focus({preventScroll: true});
        readingModalOpener = null;
      }
    }

    const SCENARIOS = [
      { id: 1, title: '1. 空库首次进入 vs 1,248 条高密度态', run: () => { state.emptyMode = true; state.activeDemoName = '场景 1 · 空库'; renderAll(); } },
      { id: 2, title: '2. X 书签 + 近 7 天 + 有图片 + 双标签筛选', run: () => { state.emptyMode = false; state.scope = 'all'; state.source = 'x_bookmark'; state.filterTime = '7'; state.filterMedia = 'image'; state.filterTags = ['交互设计', '本地优先']; state.layout = 'stream'; state.activeDemoName = '场景 2 · 复合筛选'; renderAll(); } },
      { id: 3, title: '3. 全宽表格视图探索态 & 切画廊保留查询', run: () => { state.emptyMode = false; state.activeViewId = 'v-table'; state.source = 'x_bookmark'; state.filterMedia = 'image'; state.layout = 'gallery'; state.readingOverlayOpen = false; state.activeDemoName = '场景 3 · 视图探索'; renderAll(); toast('已保留筛选切至全宽画廊；标题旁可更新或另存'); } },
      { id: 4, title: '4. Telegram 转发（视频未下载 + 缩略图）', run: () => { state.emptyMode = false; state.scope = 'all'; state.source = 'all'; state.layout = 'stream'; state.selectedItemId = 'item-102'; state.inspectorOpen = false; state.assistantOpen = false; state.activeDemoName = '场景 4 · TG 转发'; renderAll(); } },
      { id: 5, title: '5. 全宽看板移到进行中 & 模拟保存失败回弹', run: () => { state.emptyMode = false; state.scope = 'all'; state.source = 'all'; state.layout = 'board'; state.readingOverlayOpen = false; state.simBoardFail = true; state.activeDemoName = '场景 5 · 看板回弹'; renderAll(); toast('已开启保存失败模拟，拖动卡片体验原地回弹', 'warn'); } },
      { id: 6, title: '6. 放弃 X 书签 & 请求发出前撤销回写', run: () => { state.emptyMode = false; const it = state.items.find(x => x.id === 'item-101'); it.status = 'abandoned'; it.pendingRemoteUndo = true; state.scope = 'abandoned'; state.layout = 'stream'; state.selectedItemId = 'item-101'; state.activeDemoName = '场景 6 · 放弃撤销'; renderAll(); } },
      { id: 7, title: '7. 归档恢复 & 独立永久删除确认', run: () => { state.emptyMode = false; state.scope = 'archived'; state.layout = 'stream'; state.selectedItemId = 'item-108'; state.activeDemoName = '场景 7 · 归档恢复'; renderAll(); } },
      { id: 8, title: '8. 同时保存到两库（1 成功 + 1 待确认方案）', run: () => { state.emptyMode = false; state.scope = 'triage'; state.selectedItemId = 'item-103'; state.activeDemoName = '场景 8 · 多库方案'; renderAll(); openSavePlanModal('item-103'); } },
      { id: 9, title: '9. Craft 写入结果不明核对与关联', run: () => { state.emptyMode = false; state.scope = 'triage'; state.selectedItemId = 'item-104'; state.activeDemoName = '场景 9 · Craft 核对'; renderAll(); openCraftReconcileModal('item-104'); } },
      { id: 10, title: '10. 断网可读 & 附件下载中断恢复', run: () => { state.emptyMode = false; state.offlineMode = true; state.scope = 'all'; state.layout = 'stream'; state.selectedItemId = 'item-106'; state.activeDemoName = '场景 10 · 断网可读'; renderAll(); } },
      { id: 11, title: '11. 滴答正文已导入但附件会话过期', run: () => { state.emptyMode = false; state.offlineMode = false; state.scope = 'all'; state.source = 'all'; state.layout = 'stream'; state.selectedItemId = 'item-105'; state.inspectorOpen = true;
        Object.assign(state.sourceSync.dida, { status: 'warn', note: '附件网页会话过期', verifiedAt: '', error: '', waitingForLogin: false });
        state.activeDemoName = '场景 11 · 滴答保留'; renderAll(); } },
      { id: 12, title: '12. 云端恢复检查（正文通过 + 部分附件）', run: () => { state.emptyMode = false; state.layout = 'stream'; state.selectedItemId = 'item-106'; state.inspectorOpen = true; state.assistantOpen = false; state.activeDemoName = '场景 12 · 部分恢复'; renderAll(); } },
      { id: 13, title: '13. 用 Hub 助手讨论当前文章', run: () => { state.emptyMode = false; state.layout = 'stream'; state.selectedItemId = 'item-101'; state.inspectorOpen = false; state.assistantOpen = true; state.activeDemoName = '场景 13 · 助手绑定'; renderAll(); } },
      { id: 14, title: '14. 窄屏移动端单栏钻取与焦点返回', run: () => { state.emptyMode = false; state.narrowMode = true; state.readingOverlayOpen = true; state.selectedItemId = 'item-102'; state.inspectorOpen = false; state.activeDemoName = '场景 14 · 窄屏态'; renderAll(); } }
    ];

    function openSavePlanModal(id) {
      const item = state.items.find(i => i.id === id);
      if (!item) return;
      openModal(`
        <div class="px-5 py-4 hair-b flex items-center justify-between">
          <div>
            <div class="text-[14px] font-semibold text-neutral-900">保存到滴答清单 · 转换方案</div>
            <div class="text-[12px] text-neutral-500 mt-0.5">目标：滴答清单 · 阅读行动（识别到明确行动，建议存为任务）</div>
          </div>
          <button data-close-modal class="p-1 text-neutral-400 hover:text-neutral-800"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
        <div class="p-5 space-y-4 text-[13px] overflow-y-auto">
          <div class="p-4 rounded-[10px] bg-[#FAFAFA] hair-box space-y-2">
            <div class="font-medium text-neutral-900">${item.title}</div>
            <p class="text-neutral-600 text-[12.5px] leading-relaxed">${item.excerpt}</p>
            <div class="pt-2 hair-t text-[12px] text-neutral-700 space-y-1">
              <div>☐ 验证 SQLite FTS5 增量索引与内存计数缓存</div>
              <div>☐ 将列表切换改为 Stale-While-Revalidate 无闪烁过渡</div>
            </div>
          </div>
          <div class="text-[12px] text-amber-800 bg-amber-50/70 px-3 py-2.5 rounded-[8px]">其他已保存副本（Craft · 架构笔记、Obsidian）不受此操作影响。</div>
          <details class="text-[12px] text-neutral-500">
            <summary class="cursor-pointer hover:text-neutral-800">查看技术依据（附件与标签映射）</summary>
            <div class="mt-2 font-mono-tech text-[11.5px] text-neutral-500">附件 fts5-bench.png (0.6 MB · 本机已就绪) · 复用标签 #Rust架构 #性能优化</div>
          </details>
        </div>
        <div class="px-5 py-3 hair-t flex items-center justify-between bg-[#FAFAFA]">
          <button data-uncheck-dest="${item.id}:dida_inbox" class="text-[12px] text-neutral-500 hover:text-neutral-900">取消此库后续复制</button>
          <div class="flex items-center gap-2">
            <button data-close-modal class="px-3 py-1.5 rounded-[8px] border border-black/10 bg-white text-neutral-700 text-[12.5px]">稍后</button>
            <button data-approve-plan="${item.id}:dida_inbox" class="px-3.5 py-1.5 rounded-[8px] bg-neutral-900 hover:bg-neutral-800 text-white text-[12.5px] font-medium">确认保存为任务</button>
          </div>
        </div>`);
    }

    function openCraftReconcileModal(id) {
      const item = state.items.find(i => i.id === id);
      if (!item) return;
      openModal(`
        <div class="px-5 py-4 hair-b flex items-center justify-between">
          <div>
            <div class="text-[14px] font-semibold text-neutral-900">Craft · 灵感库 写入结果不明核对</div>
            <div class="text-[12px] text-amber-700 mt-0.5">已锁定直接重试，请先核对目标空间中已发现的候选页面</div>
          </div>
          <button data-close-modal class="p-1 text-neutral-400 hover:text-neutral-800"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
        <div class="p-5 space-y-4 text-[13px]">
          <div class="p-3.5 rounded-[10px] bg-[#FAFAFA] hair-box flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="font-medium text-neutral-900 truncate">${item.title}</div>
              <div class="text-[11.5px] font-mono-tech text-neutral-400 mt-0.5">MOCK-CRF-9012 · 创建于 2026-11-18 09:14</div>
            </div>
            <button data-bind-craft="${item.id}:MOCK-CRF-9012" class="px-3 py-1.5 rounded-[8px] bg-neutral-900 hover:bg-neutral-800 text-white text-[12px] font-medium whitespace-nowrap">关联此页面</button>
          </div>
          <div class="flex items-center justify-between text-[12px] text-neutral-500">
            <span>确认目标库内没有对应页面？</span>
            <button data-rewrite-craft="${item.id}" class="underline text-neutral-700 hover:text-neutral-950">解锁并重新写入</button>
          </div>
        </div>`);
    }

    function openDeleteModal(id) {
      const item = state.items.find(i => i.id === id);
      if (!item) return;
      openModal(`
        <div class="px-5 py-4 hair-b flex items-center justify-between">
          <span class="text-[14px] font-semibold text-red-700">永久删除收藏</span>
          <button data-close-modal class="p-1 text-neutral-400"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
        <div class="p-5 space-y-3 text-[13px] text-neutral-600">
          <p>删除「<strong class="text-neutral-900">${item.title}</strong>」后将移出 Hub，且重新同步不会当作新内容再次导入。</p>
          <div class="p-3 rounded-[9px] bg-[#FAFAFA] hair-box text-[12px] space-y-1">
            <div>· 清理：Hub 本地正文、索引与未被引用的受管附件（${item.attachments.length} 个）</div>
            <div class="text-teal-700">· 保护：其他内容引用的附件与只读原件不会被删除</div>
          </div>
        </div>
        <div class="px-5 py-3 hair-t bg-[#FAFAFA] flex justify-end gap-2">
          <button data-close-modal class="px-3 py-1.5 rounded-[8px] border border-black/10 bg-white text-neutral-700 text-[12.5px]">取消</button>
          <button data-confirm-del="${item.id}" class="px-3.5 py-1.5 rounded-[8px] bg-red-600 hover:bg-red-700 text-white text-[12.5px] font-medium">确认永久删除</button>
        </div>`, 460);
    }

    function syncRetryFeedback(message, kind) {
      if (!message) return '';
      const feedback = state.offlineMode ? message : kind === 'cloud'
        ? '网络已恢复，可以重试同步。' : '网络已恢复，可以继续核验滴答会话。';
      return `<div class="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-amber-900">
        <span role="${state.offlineMode ? 'alert' : 'status'}">${feedback}</span>
        ${state.offlineMode ? `<button data-restore-sync-network="${kind}" class="px-2 py-1 rounded-[7px] border border-black/10">恢复演示网络</button>` : ''}
      </div>`;
    }

    function openSyncModal() {
      const list = [
        { k: 'x_bookmark', n: 'X 书签', d: '采集正文、引用与附件；支持放弃回写' },
        { k: 'x_like', n: 'X 喜欢', d: '独立连接与同步入口' },
        { k: 'telegram', n: 'Telegram + tdl 个人号', d: state.sourceSync.telegram.tdl },
        { k: 'dida', n: '滴答稍后读', d: '精确采集「稍后读」标签；附件会话独立检查' },
        { k: 'obsidian', n: 'Obsidian 本地素材', d: state.sourceSync.obsidian.path }
      ];
      openModal(`
        <div class="px-5 py-4 hair-b flex items-center justify-between">
          <div><div class="text-[14px] font-semibold text-neutral-900">来源同步与连接</div><div class="text-[12px] text-neutral-400">独立于跨设备云同步</div></div>
          <button data-close-modal aria-label="关闭" class="p-1 text-neutral-400"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
        <div class="p-4 divide-y divide-black/[0.05] text-[13px] overflow-y-auto">
          ${list.map(r => {
            const st = state.sourceSync[r.k];
            const isDida = r.k === 'dida';
            const status = st.status === 'warn' ? st.note : st.verifiedAt ? '附件会话已核验' : '已连接';
            const action = st.status !== 'warn' ? '立即同步' : st.error && !st.waitingForLogin ? '重试重连' : '重连会话';
            return `
              <div class="py-3">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="font-medium text-neutral-900 flex items-center gap-2">${r.n} <span class="text-[11px] font-normal ${st.status==='warn'?'text-amber-700':'text-teal-700'}">${status}</span></div>
                    <div class="text-[12px] text-neutral-400 mt-0.5">${r.d} · 上次 ${st.last}${st.verifiedAt ? ' · 最近核验 ' + st.verifiedAt : ''}
                      ${isDida && st.status !== 'warn' ? '<button data-dida-session class="ml-2 text-neutral-600 underline">检查会话</button>' : ''}
                    </div>
                  </div>
                  <button data-run-sync="${r.k}" class="px-3 py-1 rounded-[7px] border border-black/10 hover:bg-neutral-50 text-[12px] text-neutral-700 font-medium whitespace-nowrap">${action}</button>
                </div>
                ${isDida ? syncRetryFeedback(st.error, 'dida') : ''}
                ${isDida && st.waitingForLogin ? `<div class="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
                  <span role="status">演示：在滴答窗口完成登录后，回到这里核验。</span>
                  <button data-dida-verify class="px-2 py-1 rounded-[7px] border border-black/10">我已登录，立即检查</button>
                </div>` : ''}
              </div>`;
          }).join('')}
        </div>`, 540, '来源同步与连接');
    }

    function openCloudModal() {
      openModal(`
        <div class="px-5 py-4 hair-b flex items-center justify-between">
          <div><div class="text-[14px] font-semibold text-neutral-900">云同步</div><div class="text-[12px] text-neutral-400">已取消每轮/每日流量额度门禁，按网络与文件规则传输</div></div>
          <button data-close-modal aria-label="关闭" class="p-1 text-neutral-400"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
        <div class="p-5 space-y-4 text-[13px]">
          <div class="p-3.5 rounded-[10px] bg-[#FAFAFA] hair-box flex items-center justify-between">
            <div><div class="font-medium text-neutral-900">阅读云同步 · 已开启</div><div class="text-[12px] text-neutral-400 mt-0.5">上次同步 ${state.cloudSync.lastSync} · ${state.cloudSync.network}</div></div>
            <button id="btn-cloud-now" class="px-3 py-1.5 rounded-[8px] bg-neutral-900 text-white text-[12px] font-medium">${state.cloudSync.error ? '重试同步' : '立即同步'}</button>
          </div>
          ${syncRetryFeedback(state.cloudSync.error, 'cloud')}
          <div class="text-[12.5px] text-neutral-600 leading-relaxed">
            <strong class="text-neutral-900">滴答来源清理保护：</strong>云同步启用时默认关闭自动清理，需完整云恢复 + 原设备凭证 + 删除前复核全部通过。
          </div>
        </div>`, 480, '云同步');
    }

    function openViewsMgr() {
      openModal(`
        <div class="px-5 py-4 hair-b flex items-center justify-between">
          <div><div class="text-[14px] font-semibold text-neutral-900">管理命名视图</div><div class="text-[12px] text-neutral-400">删除配置不影响阅读条目与副本（上限 30 个）</div></div>
          <button data-close-modal class="p-1 text-neutral-400"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
        <div class="p-4 divide-y divide-black/[0.05] text-[13px] max-h-[60vh] overflow-y-auto">
          ${state.views.map(v => `
            <div class="py-2.5 flex items-center justify-between gap-2">
              <div><div class="font-medium text-neutral-900">${v.name} ${v.hidden ? '<span class="text-[11px] text-neutral-400 font-normal">(已隐藏)</span>' : ''}</div><div class="text-[11.5px] text-neutral-400">布局：${v.layout}</div></div>
              <div class="flex items-center gap-1.5">
                <button data-hide-view="${v.id}" class="px-2 py-1 rounded-[6px] border border-black/10 text-[11.5px] text-neutral-600 hover:bg-neutral-50">${v.hidden ? '恢复显示' : '隐藏'}</button>
                <button data-del-view="${v.id}" class="px-2 py-1 rounded-[6px] text-[11.5px] text-red-600 hover:bg-red-50">删除</button>
              </div>
            </div>`).join('')}
        </div>`, 460);
    }

    // =========================================================================
    // 5. EVENTS & KEYBOARD TRIAGE
    // =========================================================================
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button, [data-open-item], [data-board-card], [data-close-modal]');
      if (!t) return;
      if (t.hasAttribute('data-close-modal')) { closeModal(); return; }

      // Demo / Scenarios Unified Popover
      if (t.id === 'btn-demo-menu') {
        openPopover(t, `
          <div class="pb-2 mb-2 hair-b flex items-center justify-between gap-1.5">
            <button data-demo-toggle="wide" class="flex-1 py-1 rounded-[7px] text-[12px] font-medium ${!state.narrowMode ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-700'}">宽屏桌面</button>
            <button data-demo-toggle="narrow" class="flex-1 py-1 rounded-[7px] text-[12px] font-medium ${state.narrowMode ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-700'}">窄屏移动</button>
          </div>
          <div class="pb-2 mb-2 hair-b flex items-center justify-between gap-1.5">
            <button data-demo-toggle="offline" class="flex-1 py-1 rounded-[7px] text-[12px] ${state.offlineMode ? 'bg-amber-100 text-amber-900 font-medium' : 'bg-neutral-100 text-neutral-700'}">${state.offlineMode ? '恢复联网' : '模拟断网'}</button>
            <button data-demo-toggle="empty" class="flex-1 py-1 rounded-[7px] text-[12px] ${state.emptyMode ? 'bg-blue-100 text-blue-900 font-medium' : 'bg-neutral-100 text-neutral-700'}">${state.emptyMode ? '载入 1,248 条' : '切至空库态'}</button>
          </div>
          <div class="text-[11px] font-medium text-neutral-400 px-1.5 mb-1">14 个验收场景速测</div>
          <div class="space-y-0.5">
            ${SCENARIOS.map(s => `<button data-run-scen="${s.id}" class="w-full text-left px-2 py-1.5 rounded-[7px] hover:bg-neutral-100 text-[12px] text-neutral-700 transition">${s.title}</button>`).join('')}
          </div>`, 300);
        return;
      }
      if (t.dataset.demoToggle) {
        const m = t.dataset.demoToggle;
        if (m === 'wide') { state.narrowMode = false; state.mobileSidebarOpen = false; }
        if (m === 'narrow') { state.narrowMode = true; state.mobileSidebarOpen = false; }
        if (m === 'offline') state.offlineMode = !state.offlineMode;
        if (m === 'empty') state.emptyMode = !state.emptyMode;
        closePopover();
        renderAll();
        return;
      }
      if (t.dataset.runScen) {
        const s = SCENARIOS.find(x => x.id === Number(t.dataset.runScen));
        closePopover();
        if (s) s.run();
        return;
      }

      // Sidebar toggle
      if (t.id === 'btn-toggle-sidebar') {
        if (state.narrowMode) state.mobileSidebarOpen = !state.mobileSidebarOpen;
        else state.sidebarOpen = !state.sidebarOpen;
        renderStageLayout();
        return;
      }

      // Sources & Scopes & Views
      if (t.dataset.source) { sweepProgress(); state.source = t.dataset.source; renderAll(); return; }
      if (t.dataset.scope) {
        sweepProgress();
        state.scope = t.dataset.scope;
        state.activeViewId = null;
        state.mobileSidebarOpen = false;
        state.readingOverlayOpen = false;
        renderAll();
        return;
      }
      if (t.dataset.viewId) {
        sweepProgress();
        const v = state.views.find(x => x.id === t.dataset.viewId);
        if (v) {
          state.activeViewId = v.id;
          state.scope = v.config.scope;
          state.source = v.config.source;
          state.filterTime = v.config.time;
          state.filterMedia = v.config.media;
          state.filterTags = [...v.config.tags];
          state.layout = v.layout;
          state.mobileSidebarOpen = false;
          state.readingOverlayOpen = false;
          renderAll();
        }
        return;
      }
      if (t.dataset.layout) {
        state.layout = t.dataset.layout;
        state.readingOverlayOpen = false;
        renderAll();
        return;
      }
      if (t.id === 'btn-copies-fold') { state.copiesExpanded = !state.copiesExpanded; renderSidebar(); if (window.lucide) lucide.createIcons(); return; }
      if (t.id === 'btn-views-mgr') { openViewsMgr(); return; }
      if (t.id === 'btn-view-add' || t.id === 'btn-view-saveas') {
        const nv = { id: 'v-' + Date.now(), name: `自定义视图 ${state.views.length + 1}`, layout: state.layout, hidden: false, config: { source: state.source, scope: 'all', time: state.filterTime, media: state.filterMedia, tags: [...state.filterTags] } };
        state.views.push(nv); state.activeViewId = nv.id; renderAll(); toast(`已保存视图「${nv.name}」`, 'ok'); return;
      }
      if (t.id === 'btn-view-update') {
        const v = state.views.find(x => x.id === state.activeViewId);
        if (v) { v.layout = state.layout; v.config = { ...v.config, source: state.source, time: state.filterTime, media: state.filterMedia, tags: [...state.filterTags] }; renderAll(); toast(`已更新视图「${v.name}」`, 'ok'); }
        return;
      }
      if (t.id === 'btn-view-revert') {
        const v = state.views.find(x => x.id === state.activeViewId);
        if (v) { state.source = v.config.source; state.filterTime = v.config.time; state.filterMedia = v.config.media; state.filterTags = [...v.config.tags]; state.layout = v.layout; renderAll(); }
        return;
      }
      if (t.dataset.hideView) { const v = state.views.find(x => x.id === t.dataset.hideView); if (v) { v.hidden = !v.hidden; renderAll(); openViewsMgr(); } return; }
      if (t.dataset.delView) { state.views = state.views.filter(x => x.id !== t.dataset.delView); if (state.activeViewId === t.dataset.delView) state.activeViewId = null; renderAll(); openViewsMgr(); toast('已删除视图配置，条目均保留'); return; }

      // Search / Filter / Sort
      if (t.id === 'btn-search-open') { state.searchOpen = true; renderTitlebar(); document.getElementById('search-input').focus(); if (window.lucide) lucide.createIcons(); return; }
      if (t.id === 'btn-search-close') { state.search = ''; state.searchOpen = false; renderAll(); return; }
      if (t.id === 'btn-filter') {
        openPopover(t, `
          <div class="space-y-3">
            <div>
              <div class="text-[11px] font-medium text-neutral-400 mb-1.5">收集时间</div>
              <div class="flex gap-1 flex-wrap">${[['all','不限'],['7','近 7 天'],['30','近 30 天'],['90','近 90 天']].map(([k,l])=>`<button data-f-time="${k}" class="px-2 py-1 rounded-[6px] text-[12px] ${state.filterTime===k?'bg-neutral-900 text-white':'bg-neutral-100 text-neutral-700'}">${l}</button>`).join('')}</div>
            </div>
            <div>
              <div class="text-[11px] font-medium text-neutral-400 mb-1.5">内容类型</div>
              <div class="flex gap-1 flex-wrap">${[['all','全部'],['image','有图片'],['video','有视频'],['link','有外链']].map(([k,l])=>`<button data-f-media="${k}" class="px-2 py-1 rounded-[6px] text-[12px] ${state.filterMedia===k?'bg-neutral-900 text-white':'bg-neutral-100 text-neutral-700'}">${l}</button>`).join('')}</div>
            </div>
            <div>
              <div class="text-[11px] font-medium text-neutral-400 mb-1.5">多标签（同时满足）</div>
              <div class="flex gap-1 flex-wrap">${ALL_TAGS.map(tg=>`<button data-f-tag="${tg}" class="px-2 py-1 rounded-[6px] text-[12px] ${state.filterTags.includes(tg)?'bg-neutral-900 text-white':'bg-neutral-100 text-neutral-700'}">#${tg}</button>`).join('')}</div>
            </div>
          </div>`, 276);
        return;
      }
      if (t.dataset.fTime) { state.filterTime = t.dataset.fTime; renderAll(); closePopover(); return; }
      if (t.dataset.fMedia) { state.filterMedia = t.dataset.fMedia; renderAll(); closePopover(); return; }
      if (t.dataset.fTag) {
        const tg = t.dataset.fTag;
        state.filterTags = state.filterTags.includes(tg) ? state.filterTags.filter(x => x !== tg) : [...state.filterTags, tg];
        renderAll(); closePopover(); return;
      }
      if (t.dataset.rmFilter) {
        const k = t.dataset.rmFilter;
        if (k === 'time') state.filterTime = 'all';
        else if (k === 'media') state.filterMedia = 'all';
        else if (k === 'search') { state.search = ''; state.searchOpen = false; }
        else if (k.startsWith('tag:')) state.filterTags = state.filterTags.filter(x => x !== k.slice(4));
        renderAll(); return;
      }
      if (t.id === 'btn-clear-filters' || t.id === 'btn-empty-reset') { state.filterTime = 'all'; state.filterMedia = 'all'; state.filterTags = []; state.search = ''; state.searchOpen = false; renderAll(); return; }
      if (t.id === 'btn-sort') {
        openPopover(t, `
          <div class="text-[11px] font-medium text-neutral-400 mb-1.5">排序方式</div>
          <div class="space-y-0.5">${[['collectedAt','收集时间'],['publishedAt','发布时间'],['title','标题'],['attachments','附件数量']].map(([f,l])=>`<button data-set-sort="${f}" class="w-full px-2 py-1.5 rounded-[7px] flex justify-between text-[12.5px] ${state.sortField===f?'bg-neutral-100 font-medium text-neutral-900':'text-neutral-600 hover:bg-neutral-50'}"><span>${l}</span>${state.sortField===f?`<span>${state.sortDir==='desc'?'↓':'↑'}</span>`:''}</button>`).join('')}</div>`, 190);
        return;
      }
      if (t.dataset.setSort) {
        if (state.sortField === t.dataset.setSort) state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
        else { state.sortField = t.dataset.setSort; state.sortDir = 'desc'; }
        renderAll(); closePopover(); return;
      }

      // Open Item
      if (t.dataset.openItem || t.dataset.boardCard) {
        if (e.target.tagName === 'INPUT') return;
        state.scrollTop = document.getElementById('browse-body').scrollTop;
        state.selectedItemId = t.dataset.openItem || t.dataset.boardCard;
        state.readingOverlayOpen = true;
        renderAll();
        return;
      }
      if (t.id === 'btn-reading-back') {
        state.readingOverlayOpen = false;
        state.inspectorOpen = false;
        state.assistantOpen = false;
        renderAll();
        document.getElementById('browse-body').scrollTop = state.scrollTop;
        return;
      }

      // Quick Status & Board Move
      if (t.dataset.quickStatus) {
        e.stopPropagation();
        const it = state.items.find(x => x.id === t.dataset.quickStatus);
        if (it) { it.status = it.status === 'read' ? 'unread' : 'read'; it.pendingRemoteUndo = false; renderAll(); }
        return;
      }
      if (t.dataset.moveCol) {
        e.stopPropagation();
        const [id, dir] = t.dataset.moveCol.split(':');
        const order = ['unread', 'reading', 'read', 'abandoned'];
        const it = state.items.find(x => x.id === id);
        if (!it) return;
        const idx = order.indexOf(it.status);
        const nxt = dir === 'next' ? Math.min(3, idx + 1) : Math.max(0, idx - 1);
        if (nxt !== idx) moveBoardItem(it, order[nxt]);
        return;
      }

      // Reading Inline Controls
      if (t.id === 'btn-copy-url') { toast('已复制原文链接', 'ok'); return; }
      if (t.id === 'btn-open-insp') { state.inspectorOpen = !state.inspectorOpen; state.assistantOpen = false; renderReadingPaper(); if (window.lucide) lucide.createIcons(); return; }
      if (t.id === 'btn-close-inspector') { state.inspectorOpen = false; renderReadingPaper(); return; }
      if (t.id === 'btn-open-asst') { state.assistantOpen = !state.assistantOpen; state.inspectorOpen = false; renderReadingPaper(); if (window.lucide) lucide.createIcons(); return; }
      if (t.id === 'btn-close-assistant') { state.assistantOpen = false; renderReadingPaper(); return; }
      if (t.id === 'btn-asst-new') { state.assistantMode = 'new'; state.assistantThread = [{ role: 'system', text: '已围绕当前文章开启新对话，等待你输入并发送。' }]; renderReadingPaper(); return; }
      if (t.id === 'btn-asst-send') {
        const inp = document.getElementById('asst-input');
        const txt = inp.value.trim();
        if (!txt) return;
        const item = state.items.find(i => i.id === state.selectedItemId);
        state.assistantThread.push({ role: 'user', text: txt });
        state.assistantThread.push({ role: 'assistant', text: `结合「${item.title}」的正文要点：核心在于把日常阅读心流与底层同步/写入状态解耦，只在需要决策或核验时亮出工程控制面。` });
        inp.value = '';
        renderReadingPaper();
        return;
      }

      if (t.id === 'btn-status-inline') {
        openPopover(t, Object.entries(STATUS_META).map(([k, m]) => `
          <button data-set-st="${k}" class="w-full px-2.5 py-1.5 rounded-[7px] hover:bg-neutral-100 flex items-center justify-between text-[12.5px]">
            <span class="flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full ${m.dot}"></span>${m.label}</span>
            ${k === 'abandoned' ? '<span class="text-[11px] text-amber-700">可回写 X</span>' : ''}
          </button>`).join(''), 200);
        return;
      }
      if (t.dataset.setSt) {
        const it = state.items.find(x => x.id === state.selectedItemId);
        const nxt = t.dataset.setSt;
        if (it) {
          it.status = nxt;
          if (nxt === 'abandoned' && (it.source === 'x_bookmark' || it.source === 'x_like')) {
            it.pendingRemoteUndo = true;
            toast('已放弃 · 下次同步将取消 X 原收藏（发送前改回可撤销）', 'warn');
          } else {
            if (it.pendingRemoteUndo) toast('已改回普通状态，待取消动作已撤销', 'ok');
            it.pendingRemoteUndo = false;
          }
          closePopover(); renderAll();
        }
        return;
      }
      if (t.dataset.undoAbandon) {
        const it = state.items.find(x => x.id === t.dataset.undoAbandon);
        if (it) { it.status = 'unread'; it.pendingRemoteUndo = false; renderAll(); toast('已改回待读并撤销 X 取消收藏', 'ok'); }
        return;
      }

      if (t.id === 'btn-dest-inline') {
        const it = state.items.find(x => x.id === state.selectedItemId);
        openPopover(t, `
          <div class="text-[11px] font-medium text-neutral-400 px-1 mb-1.5">保存到资料库（独立排队与核验）</div>
          ${DESTINATIONS.map(d => {
            const rec = it.destinations[d.id];
            return `<button data-tog-dest="${d.id}" class="w-full px-2 py-1.5 rounded-[7px] hover:bg-neutral-100 flex items-center justify-between text-left">
              <div><div class="text-[12.5px] font-medium text-neutral-800">${d.name}</div><div class="text-[11px] text-neutral-400">${rec ? rec.note : '加入保存队列'}</div></div>
              <span class="text-[12px] ${rec ? 'text-blue-600 font-semibold' : 'text-neutral-300'}">${rec ? '✓' : '+'}</span>
            </button>`;
          }).join('')}
          <div class="mt-2 pt-2 hair-t text-[11px] text-neutral-400 px-1">取消勾选仅停止后续复制，已成功副本保留。</div>`, 270);
        return;
      }
      if (t.dataset.togDest) {
        const it = state.items.find(x => x.id === state.selectedItemId);
        const dId = t.dataset.togDest;
        if (it) {
          if (it.destinations[dId]) {
            if (dId === 'obsidian_main') { toast('默认本机库保持启用'); return; }
            delete it.destinations[dId];
            if (it.triage?.targetId === dId) it.triage = null;
            toast('已停止该库后续复制，已有副本保留');
          } else {
            it.destinations[dId] = { state: 'saved', receipt: 'MOCK-NEW-' + Math.floor(1000 + Math.random()*8999), note: '已校验保存' };
            toast('已保存并获得模拟回执', 'ok');
          }
          closePopover(); renderAll();
        }
        return;
      }

      if (t.id === 'btn-tag-inline') {
        const it = state.items.find(x => x.id === state.selectedItemId);
        openPopover(t, `<div class="flex flex-wrap gap-1.5">${ALL_TAGS.map(tg => `<button data-tog-tag="${tg}" class="px-2 py-1 rounded-[6px] text-[12px] ${it.tags.includes(tg)?'bg-neutral-900 text-white':'bg-neutral-100 text-neutral-700'}">#${tg}</button>`).join('')}</div>`, 230);
        return;
      }
      if (t.dataset.togTag) {
        const it = state.items.find(x => x.id === state.selectedItemId);
        const tg = t.dataset.togTag;
        if (it) { it.tags = it.tags.includes(tg) ? it.tags.filter(x => x !== tg) : [...it.tags, tg]; closePopover(); renderAll(); }
        return;
      }
      if (t.dataset.rmTag) {
        const it = state.items.find(x => x.id === state.selectedItemId);
        if (it) { it.tags = it.tags.filter(x => x !== t.dataset.rmTag); renderAll(); }
        return;
      }

      if (t.id === 'btn-item-more') {
        const it = state.items.find(x => x.id === state.selectedItemId);
        openPopover(t, `
          <button data-act-archive="${it.id}" class="w-full text-left px-2.5 py-1.5 rounded-[7px] hover:bg-neutral-100 text-[12.5px] text-neutral-700">${it.lifecycle==='archived'?'恢复到阅读':'归档此条目'}</button>
          <button data-act-delete="${it.id}" class="w-full text-left px-2.5 py-1.5 rounded-[7px] hover:bg-red-50 text-[12.5px] text-red-600">永久删除收藏…</button>`, 170);
        return;
      }
      if (t.dataset.actArchive || t.id === 'btn-unarchive') {
        const it = state.items.find(x => x.id === (t.dataset.actArchive || state.selectedItemId));
        if (it) {
          if (it.lifecycle === 'archived') { it.lifecycle = 'normal'; it.status = it.prevStatus; toast(`已恢复到「${STATUS_META[it.status].label}」`, 'ok'); }
          else { it.prevStatus = it.status; it.lifecycle = 'archived'; toast('已归档，资料库副本保留'); }
          closePopover(); renderAll();
        }
        return;
      }
      if (t.dataset.actDelete) { closePopover(); openDeleteModal(t.dataset.actDelete); return; }
      if (t.dataset.confirmDel) {
        const it = state.items.find(x => x.id === t.dataset.confirmDel);
        if (it) { it.lifecycle = 'deleted'; state.selectedItemId = getFilteredItems()[0]?.id || null; state.readingOverlayOpen = false; closeModal(); renderAll(); toast('已移出 Hub，后台清理受管文件'); }
        return;
      }

      // Triage & Inspector & Modals actions
      if (t.dataset.dlAtt) {
        if (state.offlineMode) { toast('已断网，联网后将自动续传', 'warn'); return; }
        const [itemId, attId] = t.dataset.dlAtt.split(':');
        const it = state.items.find(x => x.id === itemId);
        const att = it?.attachments.find(a => a.id === attId);
        if (att) { att.localReady = true; att.cloudState = 'verified'; it.cloudRecovery.attOk = it.attachments.filter(a=>a.localReady).length; it.cloudRecovery.missing = []; if (it.triage?.kind==='att_paused') it.triage = null; renderAll(); toast(`已下载：${att.name}`, 'ok'); }
        return;
      }
      if (t.dataset.openPlan) { openSavePlanModal(t.dataset.openPlan); return; }
      if (t.dataset.approvePlan) {
        const [id, dId] = t.dataset.approvePlan.split(':');
        const it = state.items.find(x => x.id === id);
        if (it) { it.destinations[dId] = { state: 'saved', receipt: 'MOCK-DIDA-5519', note: '已存为滴答任务' }; it.triage = null; closeModal(); renderAll(); toast('已保存为滴答任务', 'ok'); }
        return;
      }
      if (t.dataset.uncheckDest) {
        const [id, dId] = t.dataset.uncheckDest.split(':');
        const it = state.items.find(x => x.id === id);
        if (it) { delete it.destinations[dId]; it.triage = null; closeModal(); renderAll(); toast('已取消滴答目标，Craft 副本保留'); }
        return;
      }
      if (t.dataset.openReconcile) { openCraftReconcileModal(t.dataset.openReconcile); return; }
      if (t.dataset.bindCraft) {
        const [id, pid] = t.dataset.bindCraft.split(':');
        const it = state.items.find(x => x.id === id);
        if (it) { it.destinations.craft_life = { state: 'saved', receipt: pid, note: '已关联已有页面' }; it.triage = null; closeModal(); renderAll(); toast(`已关联 ${pid}，避免重复写入`, 'ok'); }
        return;
      }
      if (t.dataset.rewriteCraft) {
        const it = state.items.find(x => x.id === t.dataset.rewriteCraft);
        if (it) { it.destinations.craft_life = { state: 'saved', receipt: 'MOCK-CRF-NEW2', note: '已重新写入' }; it.triage = null; closeModal(); renderAll(); toast('已重新写入 Craft', 'ok'); }
        return;
      }
      if (t.dataset.resumeAtt) {
        if (state.offlineMode) { toast('请先恢复网络连接', 'warn'); return; }
        const it = state.items.find(x => x.id === t.dataset.resumeAtt);
        if (it) { it.attachments.forEach(a => a.localReady = true); it.cloudRecovery.attOk = it.attachments.length; it.cloudRecovery.missing = []; it.triage = null; renderAll(); toast('已续传并补齐剩余附件', 'ok'); }
        return;
      }
      if (t.dataset.recheckDida) { toast('重新检查：附件网页会话仍过期，已继续保留滴答原项', 'warn'); return; }
      if (t.dataset.keepBoth) {
        const it = state.items.find(x => x.id === t.dataset.keepBoth);
        if (it?.sourceRetention) { it.sourceRetention.resolvedKeepBoth = true; it.triage = null; renderAll(); toast('已保留两边并结束此项处理', 'ok'); }
        return;
      }
      if (t.id === 'btn-verify-cloud') {
        const it = state.items.find(x => x.id === state.selectedItemId);
        if (it) { it.cloudRecovery.checkedAt = '2026-11-22 15:20'; renderInspector(it); toast(`核验完成：正文 ✓，附件 ${it.cloudRecovery.attOk}/${it.cloudRecovery.attTotal}`, it.cloudRecovery.missing.length ? 'warn' : 'ok'); }
        return;
      }

      // Batch
      if (t.dataset.batch) {
        const a = t.dataset.batch;
        if (a === 'clear') { state.checkedIds.clear(); renderAll(); return; }
        state.checkedIds.forEach(id => {
          const it = state.items.find(x => x.id === id);
          if (!it) return;
          if (a === 'archive') { it.prevStatus = it.status; it.lifecycle = 'archived'; } else it.status = a;
        });
        const n = state.checkedIds.size; state.checkedIds.clear(); renderAll(); toast(`已批量更新 ${n} 条`, 'ok'); return;
      }

      // Global Modals
      if (t.id === 'btn-sync-modal' || t.id === 'btn-empty-sync') { openSyncModal(); return; }
      if (t.id === 'btn-empty-demo') { state.emptyMode = false; state.activeDemoName = ''; renderAll(); return; }
      if (t.id === 'btn-cloud-modal') { openCloudModal(); return; }
      if (t.dataset.restoreSyncNetwork) {
        state.offlineMode = false;
        renderAll();
        if (t.dataset.restoreSyncNetwork === 'cloud') {
          openCloudModal();
          document.getElementById('btn-cloud-now').focus();
        } else {
          openSyncModal();
          (document.querySelector('[data-dida-verify], [data-dida-session]') || document.querySelector('[data-run-sync="dida"]')).focus();
        }
        return;
      }
      if (t.id === 'btn-cloud-now') {
        if (state.offlineMode) {
          state.cloudSync.error = '当前离线，联网后可重试云同步';
          openCloudModal();
          document.getElementById('btn-cloud-now').focus();
          return;
        }
        state.cloudSync.error = '';
        state.cloudSync.lastSync = '刚刚';
        closeModal(); renderAll(); toast('阅读云同步已完成', 'ok'); return;
      }
      const dida = state.sourceSync.dida;
      const reconnectDida = t.dataset.runSync === 'dida' && dida.status === 'warn';
      if (reconnectDida || t.hasAttribute('data-dida-session') || t.hasAttribute('data-dida-verify')) {
        if (state.offlineMode) {
          dida.error = '当前离线，联网后可重试滴答会话核验';
          openSyncModal();
          (document.querySelector('[data-dida-verify], [data-dida-session]') || document.querySelector('[data-run-sync="dida"]')).focus();
          return;
        }
        dida.error = '';
        if (reconnectDida) {
          dida.waitingForLogin = true;
          openSyncModal();
          document.querySelector('[data-dida-verify]').focus();
          return;
        }
        dida.waitingForLogin = false;
        dida.status = 'ok';
        dida.note = '';
        dida.verifiedAt = '刚刚';
        closeModal(); renderAll(); toast('滴答附件会话已核验', 'ok'); return;
      }
      if (t.dataset.runSync) {
        const k = t.dataset.runSync;
        if (state.offlineMode && k !== 'obsidian') { toast('当前离线，联网后可重试来源同步', 'warn'); return; }
        state.sourceSync[k].last = '刚刚';
        closeModal(); renderAll(); toast('阶段：读来源 → 存本机 → 补附件（已完成）', 'ok'); return;
      }
      if (t.id === 'btn-collect-cfg') {
        openModal(`
          <div class="px-5 py-4 hair-b flex items-center justify-between"><span class="text-[14px] font-semibold">收集与保存设置</span><button data-close-modal class="p-1 text-neutral-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
          <div class="p-5 space-y-3 text-[13px]">
            <div class="text-neutral-500 text-[12px]">默认本机保存位置</div>
            <div class="p-2.5 rounded-[8px] bg-[#FAFAFA] hair-box font-mono-tech text-[12px] text-neutral-700">${state.sourceSync.obsidian.path}</div>
            <div class="flex gap-2 pt-1">
              <button data-cfg-msg="重新定位原库：延续已有条目身份与文件关联" class="px-3 py-1.5 rounded-[8px] border border-black/10 text-[12px] font-medium hover:bg-neutral-50">重新定位原库</button>
              <button data-cfg-msg="选择文件夹：仅变更未来新内容的保存位置" class="px-3 py-1.5 rounded-[8px] border border-black/10 text-[12px] font-medium hover:bg-neutral-50">选择文件夹</button>
            </div>
          </div>`, 460);
        return;
      }
      if (t.dataset.cfgMsg) { toast(t.dataset.cfgMsg); return; }
      if (t.id === 'btn-kbd-help') {
        openModal(`
          <div class="px-5 py-4 hair-b flex items-center justify-between"><span class="text-[14px] font-semibold">键盘分诊快捷键</span><button data-close-modal class="p-1 text-neutral-400"><i data-lucide="x" class="w-4 h-4"></i></button></div>
          <div class="p-5 grid grid-cols-2 gap-3 text-[13px] text-neutral-700">
            <div><kbd class="px-1.5 py-0.5 bg-neutral-100 rounded font-mono-tech text-[12px]">J</kbd> / <kbd class="px-1.5 py-0.5 bg-neutral-100 rounded font-mono-tech text-[12px]">K</kbd> 上下条目</div>
            <div><kbd class="px-1.5 py-0.5 bg-neutral-100 rounded font-mono-tech text-[12px]">1</kbd> / <kbd class="px-1.5 py-0.5 bg-neutral-100 rounded font-mono-tech text-[12px]">2</kbd> / <kbd class="px-1.5 py-0.5 bg-neutral-100 rounded font-mono-tech text-[12px]">3</kbd> 切换状态</div>
            <div><kbd class="px-1.5 py-0.5 bg-neutral-100 rounded font-mono-tech text-[12px]">E</kbd> 归档当前条目</div>
            <div><kbd class="px-1.5 py-0.5 bg-neutral-100 rounded font-mono-tech text-[12px]">Esc</kbd> 逐层关闭抽屉 / 返回</div>
          </div>`, 420);
        return;
      }
      if (t.id === 'btn-reconnect') { state.offlineMode = false; renderAll(); toast('已恢复联网并续传剩余附件', 'ok'); return; }
    });

    document.addEventListener('change', (e) => {
      if (e.target.dataset.check) {
        const id = e.target.dataset.check;
        if (e.target.checked) state.checkedIds.add(id); else state.checkedIds.delete(id);
        renderBatchPill();
      }
      if (e.target.id === 'chk-board-fail') state.simBoardFail = e.target.checked;
    });

    document.getElementById('search-input').addEventListener('input', (e) => {
      state.search = e.target.value;
      renderBrowseHeader(); renderFilterStrip(); renderBrowseBody();
      if (window.lucide) lucide.createIcons();
    });

    document.getElementById('popover-bg').addEventListener('click', closePopover);
    document.getElementById('modal-root').addEventListener('click', (e) => { if (e.target.id === 'modal-root') closeModal(); });
    document.getElementById('sidebar-backdrop').addEventListener('click', () => { state.mobileSidebarOpen = false; renderStageLayout(); });

    // Board Drag & Drop
    let dragId = null;
    document.addEventListener('dragstart', (e) => { const c = e.target.closest('[data-board-card]'); if (c) dragId = c.dataset.boardCard; });
    document.addEventListener('dragover', (e) => { if (e.target.closest('[data-board-col]')) e.preventDefault(); });
    document.addEventListener('drop', (e) => {
      const col = e.target.closest('[data-board-col]');
      if (!col || !dragId) return;
      e.preventDefault();
      const it = state.items.find(x => x.id === dragId); dragId = null;
      if (it && it.status !== col.dataset.boardCol) moveBoardItem(it, col.dataset.boardCol);
    });

    function moveBoardItem(it, nxt) {
      if (state.simBoardFail) {
        const el = document.querySelector(`[data-board-card="${it.id}"]`);
        if (el) { el.classList.add('shake-x'); setTimeout(() => el.classList.remove('shake-x'), 350); }
        toast('状态保存失败（模拟），卡片保留原列', 'err');
        return;
      }
      it.status = nxt;
      it.pendingRemoteUndo = nxt === 'abandoned' && (it.source === 'x_bookmark' || it.source === 'x_like');
      renderAll();
      toast(`已移至「${STATUS_META[nxt].label}」`, 'ok');
    }

    // Draggable Split Gutter
    const gutter = document.getElementById('paper-gutter');
    let draggingGutter = false;
    gutter.addEventListener('mousedown', () => { draggingGutter = true; gutter.classList.add('dragging'); });
    gutter.addEventListener('dblclick', () => { state.browseWidthPx = 356; renderStageLayout(); });
    window.addEventListener('mousemove', (e) => {
      if (!draggingGutter) return;
      const stageRect = document.getElementById('stage').getBoundingClientRect();
      state.browseWidthPx = Math.max(280, Math.min(520, e.clientX - stageRect.left));
      document.getElementById('browse-paper').style.width = state.browseWidthPx + 'px';
    });
    window.addEventListener('mouseup', () => { if (draggingGutter) { draggingGutter = false; gutter.classList.remove('dragging'); } });

    // Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && readingModalOpener) {
        const card = document.getElementById('modal-card');
        const buttons = Array.from(card.querySelectorAll('button:not(:disabled)'));
        const first = buttons[0], last = buttons.at(-1);
        if (first && ((e.shiftKey && (document.activeElement === first || document.activeElement === card)) || (!e.shiftKey && document.activeElement === last))) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
        return;
      }
      if (e.key !== 'Escape' && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      if (e.key === 'Escape') {
        if (!document.getElementById('modal-root').classList.contains('hidden')) { closeModal(); return; }
        if (!document.getElementById('popover-root').classList.contains('hidden')) { closePopover(); return; }
        if (state.inspectorOpen) { state.inspectorOpen = false; renderReadingPaper(); return; }
        if (state.assistantOpen) { state.assistantOpen = false; renderReadingPaper(); return; }
        if (state.readingOverlayOpen) { state.readingOverlayOpen = false; renderAll(); return; }
        return;
      }
      const items = getFilteredItems();
      if (!items.length) return;
      const idx = items.findIndex(i => i.id === state.selectedItemId);
      if (e.key === 'j' || e.key === 'J') { state.selectedItemId = items[Math.min(items.length - 1, idx + 1)].id; renderAll(); }
      else if (e.key === 'k' || e.key === 'K') { state.selectedItemId = items[Math.max(0, idx - 1)].id; renderAll(); }
      else if (['1', '2', '3'].includes(e.key)) {
        const it = state.items.find(x => x.id === state.selectedItemId);
        if (it) { it.status = { '1': 'unread', '2': 'reading', '3': 'read' }[e.key]; renderAll(); toast(`标为「${STATUS_META[it.status].label}」`); }
      } else if (e.key === 'e' || e.key === 'E') {
        const it = state.items.find(x => x.id === state.selectedItemId);
        if (it && it.lifecycle === 'normal') { it.prevStatus = it.status; it.lifecycle = 'archived'; renderAll(); toast('已归档'); }
      }
    });

    const narrowViewport = window.matchMedia('(max-width: 860px)');
    function fitViewport() {
      state.narrowMode = narrowViewport.matches;
      state.mobileSidebarOpen = false;
      renderAll();
    }
    narrowViewport.addEventListener('change', fitViewport);
    fitViewport();
