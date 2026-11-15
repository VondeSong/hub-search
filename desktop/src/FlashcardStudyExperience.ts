import type { FlashcardDashboardStats } from "./FlashcardTypes";
import { studyDateKey } from "./StudyChartData";

export function effectiveNewLimit(limit: number, extra = 0) {
  return limit === 0 ? 0 : limit + Math.max(0, extra);
}

export function estimatedStudyMinutes(stats: FlashcardDashboardStats, count: number): number | null {
  if ((stats.timedReviewCount ?? 0) < 5 || !stats.averageReviewMs || stats.averageReviewMs <= 0 || count <= 0) return null;
  return Math.max(1, Math.ceil(stats.averageReviewMs * count / 60_000));
}

export function futureStudyDays(stats: FlashcardDashboardStats) {
  if (!stats.studyDay || !stats.futureDue) return [];
  const counts = new Map(stats.futureDue.map(day => [day.date, day.count]));
  return Array.from({length: 7}, (_, index) => {
    const date = new Date(`${stats.studyDay}T12:00:00`);
    date.setDate(date.getDate() + index);
    const key = studyDateKey(date);
    return {date: key, count: counts.get(key) ?? 0};
  });
}

export function nextStudyDue(stats: FlashcardDashboardStats | null) {
  return stats?.nextDueAt ? new Intl.DateTimeFormat("zh-CN", {month:"long",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(stats.nextDueAt * 1000)) : null;
}
