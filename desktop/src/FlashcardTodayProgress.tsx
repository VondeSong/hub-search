import { useState } from "react";
import { BarChart3, BookOpenCheck, ChevronRight, Flame, Check } from "lucide-react";
import { effectiveNewLimit, futureStudyDays } from "./FlashcardStudyExperience";
import type { FlashcardDashboardStats } from "./FlashcardTypes";
import { StudyProgress } from "./StudyProgress";
import { studyStreak, studyTimeline } from "./StudyChartData";
import "./FlashcardToday.css";

export function FlashcardTodayProgress({ stats, dailyNewLimit, onOpenStats, mobile = false }: {
  stats: FlashcardDashboardStats;
  dailyNewLimit: number;
  onOpenStats: () => void;
  mobile?: boolean;
}) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const timeline = studyTimeline(stats.dailyActivity, 7, stats.studyDay ? new Date(`${stats.studyDay}T12:00:00`) : new Date());
  const limit = effectiveNewLimit(dailyNewLimit, stats.extraNewAllowance);
  const future = futureStudyDays(stats);
  const total = timeline.reduce((sum, day) => sum + day.count, 0);
  const activeDays = timeline.filter(day => day.count > 0).length;
  const maximum = Math.max(1, ...timeline.map(day => day.count));
  const studied = stats.newStudiedToday ?? 0;
  const quotaComplete = dailyNewLimit > 0 && studied >= dailyNewLimit;
  const streak = studyStreak(stats.dailyActivity);

  return <section className="flashcard-today-progress" aria-label="今日学习概览">
    <header className="flashcard-today-heading">
      <h2>今日进展</h2>
      <button type="button" onClick={onOpenStats}><BarChart3 size={16} aria-hidden="true" />查看完整统计<ChevronRight size={15} aria-hidden="true" /></button>
    </header>
    <div className="flashcard-today-metrics">
      <article>
        <div className="flashcard-today-metric-heading"><h3>今日完成</h3><BookOpenCheck size={20} aria-hidden="true" /></div>
        <div className="flashcard-today-value"><strong>{stats.reviewedToday}</strong><span>次复习</span></div>
        <p>{stats.reviewedToday > 0 ? "每次回想，都在加深记忆" : "从今天的第一张开始"}</p>
      </article>
      <article className={`flashcard-today-new${quotaComplete ? " quota-complete" : ""}`}>
        <div className="flashcard-today-metric-heading"><h3>今日新卡</h3>{quotaComplete ? <Check size={20} aria-hidden="true" /> : <BookOpenCheck size={20} aria-hidden="true" />}</div>
        <StudyProgress completed={studied} limit={mobile ? limit : dailyNewLimit} />
        <p>{mobile && (stats.extraNewAllowance ?? 0) > 0 ? `每日偏好 ${dailyNewLimit} 张 · 本机今日临时增加 ${stats.extraNewAllowance} 张` : quotaComplete ? "新卡目标已完成" : dailyNewLimit > 0 ? `还可学习 ${Math.max(0, dailyNewLimit - studied)} 张新卡` : "按自己的节奏学习"}</p>
      </article>
      <article>
        <div className="flashcard-today-metric-heading"><h3>连续学习</h3><Flame size={20} aria-hidden="true" /></div>
        <div className="flashcard-today-value"><strong>{streak}</strong><span>天</span></div>
        <p>{streak > 1 ? "保持节奏，积累会留下来" : streak === 1 ? "今天是一个好的开始" : "今天开始新的学习节奏"}</p>
      </article>
    </div>
    <section className="flashcard-today-rhythm" aria-label="最近七天学习节奏">
      <header><div><h2>学习节奏</h2><p>{total > 0 ? `近 7 天复习 ${total} 次 · 学习 ${activeDays} 天` : "完成复习后，这里会记录每天的积累"}</p></div><span>最近 7 天</span></header>
      <ol>
        {timeline.map((day, index) => <li key={day.date} className={index === 6 ? "today" : undefined} aria-label={`${day.date}，复习 ${day.count} 次`}>
          {mobile ? <button type="button" className="flashcard-rhythm-day" aria-label={`${day.date}，复习 ${day.count} 次，查看明细`} aria-pressed={selectedDay === day.date} onClick={() => setSelectedDay(day.date)}><strong>{day.count}</strong><span className="flashcard-today-bar-track" aria-hidden="true"><span style={{height:day.count > 0 ? `${Math.max(10, Math.log1p(day.count) / Math.log1p(maximum) * 100)}%` : "3px"}} /></span></button> : <><strong aria-hidden="true">{day.count}</strong><div className="flashcard-today-bar-track" aria-hidden="true"><span style={{ height: day.count > 0 ? `${Math.max(10, day.count / maximum * 100)}%` : "3px" }} /></div></>}
          <span aria-hidden="true">{index === 6 ? "今日" : day.label}</span>
        </li>)}
      </ol>
      {mobile && selectedDay && <p className="flashcard-study-detail" role="status">{selectedDay} · {timeline.find(day => day.date === selectedDay)?.count ?? 0} 次复习</p>}
    </section>
    {mobile && <section className="flashcard-today-rhythm flashcard-study-forecast" aria-label="未来七天已学卡到期">
      <header><div><h2>接下来 7 天</h2><p>只汇总已学卡片当前已安排的到期，不预测未学新卡。</p></div></header>
      {future.length ? <ol>{future.map((day,index) => <li key={day.date}><strong>{day.count}</strong><span>{index === 0 ? "今日稍后" : day.date.slice(5).replace("-", "/")}</span></li>)}</ol> : <p>正在等待原生到期统计，暂不显示预测。</p>}
    </section>}
  </section>;
}
