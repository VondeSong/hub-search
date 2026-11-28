import { userProfileStorage, flushUserProfileStorage } from "./UserProfileStorage";
import { loadPlanningRecords, localDateKey, taskIdentity } from "./TaskPlanning";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import type { Claim, Material } from "./ActionEvidence";

export type Wait = {
  id: string;
  who: string;
  what: string;
  review: string;
  blocking?: boolean;
  resolved?: string;
};
export type Step = { id: string; text: string; done: boolean };
export type Draft = { mode: string; claims: Claim[]; sources: Material[]; revision?: string; waitId?: string };
export type ActionMeta = {
  day?: string;
  reviewDate?: string;
  waits: Wait[];
  topics?: string[];
  links: Material[];
  steps: Step[];
  draft?: Draft;
  note?: string;
};
export type Topic = { key: string; name: string; libraryId: string; collection?: string; tag?: string };
export type Decision = {
  state: "ignored" | "linked" | "creating" | "unknown" | "linking";
  clue?: { key: string; title: string; material: Material };
  taskKey?: string;
  noteText?: string;
  noteId?: string;
  requestId?: string;
  sourceId?: string;
  libraryId?: string;
  projectId?: string;
  priority?: number;
  title?: string;
  day?: string;
  wait?: Wait;
};
export const TODAY_PLAN_LIMIT = 5;
export const identity = (task: UnifiedTask) => JSON.stringify([task.libraryId, task.sourceId]);
export const emptyMeta = (): ActionMeta => ({ waits: [], links: [], steps: [] });
export const hasBlockingWait = (meta: ActionMeta) => meta.waits.some((wait) => wait.blocking && !wait.resolved);
const prefix = "hub.tasks.workbench.v1.";
export function read<T>(key: string, fallback: T): T {
  const text = userProfileStorage.getItem(prefix + key);
  return text === null ? fallback : (JSON.parse(text) as T);
}
export async function write<T>(key: string, value: T) {
  userProfileStorage.setItem(prefix + key, JSON.stringify(value));
  await flushUserProfileStorage();
}
export function readTopicReviews(): Record<string, string> {
  return read<Record<string, string>>("topic.reviews", {});
}
export async function saveTopicReview(topicKey: string, reviewDate: string): Promise<Record<string, string>> {
  const current = readTopicReviews();
  const next = { ...current };
  if (!reviewDate) delete next[topicKey];
  else next[topicKey] = reviewDate;
  await write("topic.reviews", next);
  return next;
}
export function legacyRecords() {
  return new Map(loadPlanningRecords().map((r) => [r.identity, r]));
}
export function metaFor(task: UnifiedTask, legacy: ReturnType<typeof legacyRecords>): ActionMeta {
  const prev =
    legacy.get(taskIdentity(task)) ||
    task.sourceRefs
      ?.map((ref) =>
        legacy.get(JSON.stringify([task.id, ref.provider, ref.libraryId, ref.sourceId, ref.documentId])),
      )
      .find(Boolean);
  const old = prev as
    | { day?: string; note?: string; waiting?: { who: string; condition: string; followUp?: string } }
    | undefined;
  const initial = {
    ...emptyMeta(),
    day: old?.day,
    note: old?.note,
    waits: old?.waiting
      ? [{ id: "previous", who: old.waiting.who, what: old.waiting.condition, review: old.waiting.followUp || "" }]
      : [],
  };
  return read("task." + identity(task), initial);
}
export function topicOf(task: UnifiedTask): Topic {
  const collection = task.collectionId || task.documentTitle;
  return {
    key: JSON.stringify([task.libraryId, "list", collection]),
    name: task.collectionName || task.documentTitle || "收件箱",
    libraryId: task.libraryId,
    collection,
  };
}
export function inTopic(task: UnifiedTask, topic: Topic, meta?: ActionMeta) {
  if (meta?.topics?.includes(topic.key)) return true;
  return (
    task.libraryId === topic.libraryId &&
    (topic.tag ? task.tags?.includes(topic.tag) === true : topicOf(task).key === topic.key)
  );
}
export function groupsFor(tasks: UnifiedTask[], meta: (t: UnifiedTask) => ActionMeta, day: string) {
  const groups: {
    due: UnifiedTask[];
    plan: UnifiedTask[];
    waiting: UnifiedTask[];
    next: UnifiedTask[];
    done: UnifiedTask[];
  } = { due: [], plan: [], waiting: [], next: [], done: [] };
  for (const t of tasks) {
    if (t.status === "abandoned" || t.isProject) continue;
    if (t.completed) {
      groups.done.push(t);
      continue;
    }
    const m = meta(t),
      active = m.waits.filter((w) => !w.resolved);
    const due = dueDay(t);
    if ((due && due <= day) || active.some((w) => w.review && w.review <= day)) groups.due.push(t);
    else if (m.day === day) groups.plan.push(t);
    else if (active.length) groups.waiting.push(t);
    else groups.next.push(t);
  }
  return groups;
}
const dueDateFormatters = new Map<string, Intl.DateTimeFormat>();
export function dueDay(task: UnifiedTask) {
  if (!task.dueAt) return "";
  const value = task.dueAt;
  if (/^\d{4}-\d\d-\d\d$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  if (!task.isAllDay || !task.timeZone) return localDateKey(date);
  let formatter = dueDateFormatters.get(task.timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: task.timeZone });
    } catch {
      return localDateKey(date);
    }
    dueDateFormatters.set(task.timeZone, formatter);
  }
  return formatter.format(date);
}
