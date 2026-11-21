export type WorkSummary = {
  id: string;
  goal: string;
  title?: string | null;
  state: string;
  messageCount?: number;
  updatedAt?: number;
  pinned?: boolean;
  archived?: boolean;
};

export type HistoryChange = { pinned?: boolean; deleted?: boolean; archived?: boolean; title?: string };
export type HistoryGroup = { key: "pinned" | "today" | "recent" | "earlier"; label: string; works: WorkSummary[] };

function validTime(time?: number): time is number {
  return typeof time === "number" && time > 0 && Number.isFinite(new Date(time).getTime());
}

export function conversationTitle(work: WorkSummary) {
  return (work.title || work.goal).replace(/\s+/g, " ").trim() || "未命名对话";
}

export function groupConversations(works: WorkSummary[], now = Date.now(), archived = false): HistoryGroup[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const recent = new Date(today);
  recent.setDate(recent.getDate() - 30);
  const groups: HistoryGroup[] = [
    { key: "pinned", label: "已固定", works: [] },
    { key: "today", label: "今天", works: [] },
    { key: "recent", label: "过去 30 天", works: [] },
    { key: "earlier", label: "更早", works: [] },
  ];
  const unique = [...new Map(works.map(work => [work.id, work])).values()];
  unique.sort((a, b) => {
    const difference = (validTime(b.updatedAt) ? b.updatedAt : 0) - (validTime(a.updatedAt) ? a.updatedAt : 0);
    return difference || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  for (const work of unique) {
    const group = !archived && work.pinned ? 0
      : validTime(work.updatedAt) && work.updatedAt >= today.getTime() ? 1
      : validTime(work.updatedAt) && work.updatedAt >= recent.getTime() ? 2 : 3;
    groups[group].works.push(work);
  }
  return groups.filter(group => group.works.length > 0);
}

export function conversationTime(time?: number, now = Date.now()) {
  if (!validTime(time)) return "";
  const elapsed = Math.max(0, now - time);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时`;
  const current = new Date(now), date = new Date(time);
  // Compare local calendar dates rather than assuming twenty-four-hour days.
  const days = Math.round((Date.UTC(current.getFullYear(), current.getMonth(), current.getDate())
    - Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())) / 86_400_000);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天`;
  if (days < 30) return `${Math.floor(days / 7)} 周`;
  return date.getFullYear() === current.getFullYear()
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export function conversationDate(time?: number) {
  return validTime(time)
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(time)
    : "更新时间未知";
}
