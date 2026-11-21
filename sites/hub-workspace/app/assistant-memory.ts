export type MemoryScope = 'general' | 'hub';
export type MemoryUse = 'always' | 'relevant';
export type MemoryPreference = { memoryEnabled: boolean; memoryScope: MemoryScope };
export type MemoryContent = { id: string; title: string; body: string; scope: MemoryScope; use: MemoryUse; source: string };
export type MemoryRevision = { at: number; before: Pick<MemoryContent, 'title' | 'body' | 'use'>; after: Pick<MemoryContent, 'title' | 'body' | 'use'> };
export type MemoryEntry = MemoryContent & { state: 'active' | 'inactive'; history?: MemoryRevision[] };
export type MemoryState = { version: 1; entries: MemoryEntry[]; proposals: MemoryContent[] };
export type MemoryAction =
  | { type: 'accept'; id: string; title?: string; body?: string; use?: MemoryUse }
  | { type: 'dismiss'; id: string }
  | { type: 'edit'; id: string; title: string; body: string; use: MemoryUse }
  | { type: 'toggle'; id: string }
  | { type: 'forget'; id: string };

export const memoryStorageKey = 'hub-proto-memory-content-v1';
export const memoryPreferenceKey = 'hub-proto-memory-preference-v1';

export function readMemoryPreference(value: unknown): MemoryPreference {
  if (value && typeof value === 'object') {
    const raw = value as Record<string, unknown>;
    if (typeof raw.memoryEnabled === 'boolean' && (raw.memoryScope === 'general' || raw.memoryScope === 'hub')) {
      return { memoryEnabled: raw.memoryEnabled, memoryScope: raw.memoryScope };
    }
  }
  return { memoryEnabled: false, memoryScope: 'general' };
}

export function loadMemoryPreference(): MemoryPreference {
  try { return readMemoryPreference(JSON.parse(localStorage.getItem(memoryPreferenceKey) || 'null')); }
  catch { return readMemoryPreference(null); }
}

export function rememberMemoryPreference(value: MemoryPreference): boolean {
  try { localStorage.setItem(memoryPreferenceKey, JSON.stringify(readMemoryPreference(value))); return true; }
  catch { return false; }
}

export function memoryScopeLabel(scope: string) { return scope === 'hub' ? 'Hub 开发' : '个人通用'; }
export function memoryUseLabel(enabled: boolean, scope: string) {
  return enabled ? scope === 'hub' ? '个人＋Hub 开发' : '个人通用' : '已关闭';
}

export function createMemoryDemoState(): MemoryState {
  return { version: 1, entries: [
    { id: 'sample-response-style', title: '回答的表达方式', body: '先给结论，再列出依据。', scope: 'general', use: 'always', state: 'active', source: '示例：用户明确确认的表达偏好。' },
    { id: 'sample-mobile-focus', title: '移动端近期重点', body: '移动端优先完成 Agents 的基础对话能力。', scope: 'hub', use: 'relevant', state: 'active', source: '示例：项目规划讨论，经确认保存。' },
  ], proposals: [
    { id: 'sample-skills-source', title: '技能来源', body: 'Skills 以本地文件夹＋GitHub 为主要来源。', scope: 'hub', use: 'relevant', source: '示例：来自「技能来源方案」讨论，尚未确认。' },
  ] };
}

function readContent(value: unknown): MemoryContent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 100 ||
      typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 90 ||
      typeof raw.body !== 'string' || !raw.body.trim() || raw.body.length > 1800 ||
      (raw.scope !== 'general' && raw.scope !== 'hub') ||
      (raw.use !== 'always' && raw.use !== 'relevant') || typeof raw.source !== 'string' || raw.source.length > 400) return null;
  return { id: raw.id, title: raw.title, body: raw.body, scope: raw.scope, use: raw.use, source: raw.source };
}

export function readMemoryState(value: unknown): MemoryState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.entries) || !Array.isArray(raw.proposals) || raw.entries.length > 80 || raw.proposals.length > 20) return null;
  const entries: MemoryEntry[] = [], proposals: MemoryContent[] = [];
  for (const candidate of raw.entries) {
    const item = readContent(candidate);
    if (!item || !candidate || (candidate.state !== 'active' && candidate.state !== 'inactive') || entries.some(entry => entry.id === item.id)) return null;
    const history: MemoryRevision[] = [];
    if (candidate.history !== undefined) {
      if (!Array.isArray(candidate.history) || candidate.history.length > 20) return null;
      for (const revision of candidate.history) {
        if (!revision || !Number.isSafeInteger(revision.at) || revision.at < 0 || !revision.before || !revision.after) return null;
        const before = readContent({ ...item, title: revision.before.title, body: revision.before.body, use: revision.before.use }), after = readContent({ ...item, title: revision.after.title, body: revision.after.body, use: revision.after.use });
        if (!before || !after) return null;
        history.push({ at: revision.at, before: { title: before.title, body: before.body, use: before.use }, after: { title: after.title, body: after.body, use: after.use } });
      }
    }
    entries.push({ ...item, state: candidate.state, ...(history.length ? { history } : {}) });
  }
  for (const candidate of raw.proposals) {
    const item = readContent(candidate);
    if (!item || proposals.some(proposal => proposal.id === item.id)) return null;
    proposals.push(item);
  }
  return { version: 1, entries, proposals };
}

export function changeMemoryState(state: MemoryState, action: MemoryAction): MemoryState {
  if (action.type === 'accept') {
    const proposal = state.proposals.find(item => item.id === action.id);
    if (!proposal) return state;
    const content = readContent({ ...proposal, title: action.title === undefined ? proposal.title : action.title.trim(), body: action.body === undefined ? proposal.body : action.body.trim(), use: action.use || proposal.use });
    if (!content) return state;
    const id = 'saved-' + proposal.id;
    if (id.length > 100 || state.entries.length >= 80 || state.entries.some(item => item.id === id)) return state;
    return { ...state, proposals: state.proposals.filter(item => item.id !== action.id), entries: [...state.entries, { ...content, id, source: proposal.source.replace('尚未确认', '已由你确认').slice(0, 400), state: 'active' }] };
  }
  if (action.type === 'dismiss') return state.proposals.some(item => item.id === action.id) ? { ...state, proposals: state.proposals.filter(item => item.id !== action.id) } : state;
  const entry = state.entries.find(item => item.id === action.id);
  if (!entry) return state;
  if (action.type === 'forget') return { ...state, entries: state.entries.filter(item => item.id !== action.id) };
  if (action.type === 'toggle') return { ...state, entries: state.entries.map(item => item.id === action.id ? { ...item, state: item.state === 'active' ? 'inactive' : 'active' } : item) };
  const content = readContent({ ...entry, title: action.title.trim(), body: action.body.trim(), use: action.use });
  if (!content || (content.title === entry.title && content.body === entry.body && content.use === entry.use)) return state;
  const revision: MemoryRevision = { at: Date.now(), before: { title: entry.title, body: entry.body, use: entry.use }, after: { title: content.title, body: content.body, use: content.use } };
  return { ...state, entries: state.entries.map(item => item.id === action.id ? { ...content, state: item.state, history: [...(item.history || []), revision].slice(-20) } : item) };
}
