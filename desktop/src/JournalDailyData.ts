import { useMemo } from "react";
import { taskMatchesLibraryScope, type UnifiedTask } from "./TaskWorkspacePresentation";
import { useUnifiedTasks } from "./UnifiedTaskData";
export { canSetUnifiedTaskStatus as canSetJournalTaskStatus } from "./UnifiedTaskData";

export type JournalDailyOptions = {
  from: string;
  /** Exclusive local civil date, independent of the host's UTC offset. */
  to: string;
  scope: string[] | null;
  query: string;
  enabled: boolean;
  dataVersion?: string;
};

export type JournalDailyTaskReason = "计划" | "开始" | "进行中" | "截止" | "提醒" | "新建";
export type JournalDailyTaskEntry = {
  task: UnifiedTask;
  reasons: JournalDailyTaskReason[];
  completedAt?: string;
  completedSource?: "source" | "hub";
  /** Completion history is retained in the task; open tasks leave this bucket. */
  reopened?: boolean;
};
export type JournalDailyTaskGroups = {
  scheduled: JournalDailyTaskEntry[];
  completed: JournalDailyTaskEntry[];
  created: JournalDailyTaskEntry[];
};

export function journalLocalDateKey(date: Date): string {
  if (!Number.isFinite(date.getTime())) return "";
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localCivilDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match || Number(match[1]) === 0) return null;
  const date = new Date(0);
  date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setHours(0, 0, 0, 0);
  return journalLocalDateKey(date) === value ? date : null;
}

export function validJournalDailyRange(from: string, to: string): boolean {
  return !!localCivilDate(from) && !!localCivilDate(to) && from < to;
}

/** Civil schedules keep their provider day; timed events use the local instant. */
export function journalTaskTimestampDate(value: string | undefined, allDay = false, timeZone?: string): string {
  const input = value?.trim();
  if (!input) return "";
  const civil = input.slice(0, 10);
  if (!localCivilDate(civil)) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return civil;
  if (allDay) {
    // TickTick can serialize its all-day midnight in UTC while retaining the
    // intended calendar timezone separately. A date-only Craft/Obsidian field
    // is already civil and never passes through this conversion.
    if (timeZone && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)) {
      const instant = new Date(input);
      if (!Number.isFinite(instant.getTime())) return "";
      try {
        const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
        const part = (type: string) => parts.find(part => part.type === type)?.value || "";
        const sourceDate = `${part("year")}-${part("month")}-${part("day")}`;
        return localCivilDate(sourceDate) ? sourceDate : "";
      } catch {
        // An unsupported provider timezone must not shift an existing civil day.
      }
    }
    return civil;
  }
  return journalLocalDateKey(new Date(input));
}

/** Kept for callers that need a single representative schedule; grouping uses every date. */
export function journalTaskDateKey(task: UnifiedTask): string {
  return journalTaskTimestampDate(task.dueAt, task.isAllDay, task.timeZone)
    || journalTaskTimestampDate(task.scheduledAt, task.isAllDay, task.timeZone)
    || journalTaskTimestampDate(task.startAt, task.isAllDay, task.timeZone);
}

function taskScheduleReasons(task: UnifiedTask, range: Pick<JournalDailyOptions, "from" | "to">): Map<string, JournalDailyTaskReason[]> {
  const dates = new Map<string, JournalDailyTaskReason[]>();
  const add = (value: string | undefined, reason: JournalDailyTaskReason, allDay = task.isAllDay) => {
    const date = journalTaskTimestampDate(value, allDay, task.timeZone);
    if (!date) return;
    const reasons = dates.get(date) || [];
    if (!reasons.includes(reason)) reasons.push(reason);
    dates.set(date, reasons);
  };
  add(task.scheduledAt, "计划");
  const scheduledDay = journalTaskTimestampDate(task.scheduledAt, task.isAllDay, task.timeZone);
  const startDay = journalTaskTimestampDate(task.startAt, task.isAllDay, task.timeZone);
  // Craft's compatibility field can repeat its scheduled day as startAt.
  const scheduledCivil = task.isAllDay || /^\d{4}-\d{2}-\d{2}$/.test(task.scheduledAt?.trim() || "");
  const startCivil = task.isAllDay || /^\d{4}-\d{2}-\d{2}$/.test(task.startAt?.trim() || "");
  const sameSchedule = !!scheduledDay && !!startDay && (scheduledCivil && startCivil
    ? scheduledDay === startDay
    : !scheduledCivil && !startCivil && new Date(task.scheduledAt!).getTime() === new Date(task.startAt!).getTime());
  if (!sameSchedule) add(task.startAt, "开始");
  add(task.dueAt, "截止");
  const rangeStart = startDay || scheduledDay;
  const rangeEnd = journalTaskTimestampDate(task.dueAt, task.isAllDay, task.timeZone);
  if (task.status === "open" && rangeStart && rangeEnd && rangeStart < rangeEnd) {
    // A task occupies every civil day of its real start–end interval. Expand
    // only the visible intersection, never a guessed period or an overdue tail.
    let day = rangeStart > range.from ? rangeStart : range.from;
    while (day <= rangeEnd && day < range.to) {
      if (day > rangeStart && day < rangeEnd) {
        const reasons = dates.get(day) || [];
        if (!reasons.includes("进行中")) reasons.push("进行中");
        dates.set(day, reasons);
      }
      const next = localCivilDate(day)!;
      next.setDate(next.getDate() + 1);
      day = journalLocalDateKey(next);
    }
  }
  for (const reminder of task.reminderAt || []) add(reminder, "提醒", false);
  return dates;
}

function taskCompletions(task: UnifiedTask): Map<string, { at: string; source: "source" | "hub"; reopened: boolean }> {
  const dates = new Map<string, { at: string; source: "source" | "hub"; reopened: boolean }>();
  if (task.status === "open") return dates;
  const events = [...(task.completionHistory || [])];
  if (task.completedAt) events.push({ at: task.completedAt, source: task.completedTimeSource || "source", reopened: false });
  for (const event of events) {
    const date = journalTaskTimestampDate(event.at);
    if (!date) continue;
    const previous = dates.get(date);
    // A source day without a clock cannot replace a known precise completion time.
    const precise = !/^\d{4}-\d{2}-\d{2}$/.test(event.at.trim());
    const previousPrecise = previous && !/^\d{4}-\d{2}-\d{2}$/.test(previous.at.trim());
    const time = new Date(event.at).getTime(), previousTime = previous ? new Date(previous.at).getTime() : 0;
    const later = !previous || (precise && !previousPrecise)
      || (precise === previousPrecise && (time > previousTime
        || (time === previousTime && event.source === "source")));
    if (later) dates.set(date, event);
  }
  return dates;
}

/** Date, query and scope are projections of the shared task snapshot, never extra reads. */
export function groupJournalDailyTasks(tasks: UnifiedTask[], options: Pick<JournalDailyOptions, "from" | "to" | "scope" | "query">): Map<string, JournalDailyTaskGroups> {
  const grouped = new Map<string, JournalDailyTaskGroups>(), seen = new Set<string>();
  if (!validJournalDailyRange(options.from, options.to) || options.scope?.length === 0) return grouped;
  const needle = options.query.trim().toLocaleLowerCase();
  const visible = (date: string) => date >= options.from && date < options.to;
  for (const task of tasks) {
    if (seen.has(task.id) || task.isProject) continue;
    seen.add(task.id);
    if (!taskMatchesLibraryScope(task, options.scope)) continue;
    if (needle && !`${task.title} ${task.documentTitle} ${task.collectionName || ""} ${task.libraryName}`.toLocaleLowerCase().includes(needle)) continue;
    const schedules = taskScheduleReasons(task, options), completions = taskCompletions(task);
    const created = journalTaskTimestampDate(task.createdAt);
    const dates = new Set([...schedules.keys(), ...completions.keys(), ...(created ? [created] : [])]);
    for (const date of dates) {
      if (!visible(date)) continue;
      const reasons = [...(schedules.get(date) || [])];
      if (date === created) reasons.push("新建");
      const event = completions.get(date);
      let bucket: keyof JournalDailyTaskGroups | undefined;
      if (event) bucket = "completed";
      else if (task.status === "open" && schedules.has(date)) bucket = "scheduled";
      else if (task.status !== "abandoned" && date === created) bucket = "created";
      if (!bucket) continue;
      const groups = grouped.get(date) || { scheduled: [], completed: [], created: [] };
      groups[bucket].push({ task, reasons, ...(event ? { completedAt: event.at, completedSource: event.source, reopened: event.reopened } : {}) });
      grouped.set(date, groups);
    }
  }
  const byTitle = (a: JournalDailyTaskEntry, b: JournalDailyTaskEntry) => a.task.title.localeCompare(b.task.title, "zh-CN") || a.task.id.localeCompare(b.task.id);
  const eventTime = (value: string | undefined) => value ? new Date(value).getTime() : 0;
  for (const groups of grouped.values()) {
    groups.scheduled.sort(byTitle);
    groups.completed.sort((a, b) => eventTime(a.completedAt) - eventTime(b.completedAt) || byTitle(a, b));
    groups.created.sort((a, b) => eventTime(a.task.createdAt) - eventTime(b.task.createdAt) || byTitle(a, b));
  }
  return grouped;
}

export function useJournalDailyData(options: JournalDailyOptions) {
  const { from, to, query, enabled } = options;
  const scopeKey = JSON.stringify(options.scope === null ? null : [...new Set(options.scope)].sort());
  const scope = useMemo(() => JSON.parse(scopeKey) as string[] | null, [scopeKey]);
  const validRange = validJournalDailyRange(from, to);
  const active = enabled && validRange && scope?.length !== 0;
  const shared = useUnifiedTasks({ enabled: active });
  const tasksByDate = useMemo(() => active
    ? groupJournalDailyTasks(shared.dashboard.tasks, { from, to, scope, query })
    : new Map<string, JournalDailyTaskGroups>(), [shared.dashboard.tasks, from, to, scope, query, active]);
  return {
    tasksByDate,
    tasksLoading: active && shared.loading,
    tasksError: enabled && !validRange ? "日期范围无效" : active ? shared.error : "",
    taskBusyIds: shared.taskBusyIds,
    taskStatusTargets: shared.taskStatusTargets,
    retry: shared.refresh,
    setTaskCompleted: shared.setTaskCompleted,
    refreshSources: shared.refreshSources,
  };
}
