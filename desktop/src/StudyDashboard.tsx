import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Activity, BarChart3, CalendarDays, ChevronRight, Flame, Layers3, RotateCcw, Target, TrendingUp } from "lucide-react";
import type { FlashcardDashboardStats, FlashcardDeckSummary } from "./FlashcardTypes";
import { deckWorkload, studyStreak, studyTimeline } from "./StudyChartData";
import { StudyArea, StudyBars, StudyDonut, StudyProgress } from "./charts/evilcharts/StudyCharts";
import "./StudyDashboard.css";

export { StudyProgress };

export function StudyDashboard({ stats, decks, dueCount, dailyNewLimit, onOpenDeck }: {
  stats: FlashcardDashboardStats;
  decks: FlashcardDeckSummary[];
  dueCount: number;
  dailyNewLimit: number;
  onOpenDeck: (id: string) => void;
}) {
  const [range, setRange] = useState<7 | 30 | 90>(30);
  const [showData, setShowData] = useState(false);
  const reduced = useReducedMotion();
  const year = useMemo(() => studyTimeline(stats.dailyActivity, 364), [stats.dailyActivity]);
  const activity = year.slice(-range);
  const periodTotal = activity.reduce((total, day) => total + day.count, 0);
  const previousTotal = year.slice(-range * 2, -range).reduce((total, day) => total + day.count, 0);
  const activeDays = activity.filter((day) => day.count > 0).length;
  const change = previousTotal > 0 ? Math.round((periodTotal - previousTotal) / previousTotal * 100) : null;
  const workload = deckWorkload(decks);
  const maxDue = Math.max(1, ...workload.map((deck) => deck.value));
  const maxActivity = Math.max(1, ...year.map((day) => day.count));
  const firstDate = new Date(`${year[0].date}T12:00:00`);
  const leadingDays = (firstDate.getDay() + 6) % 7;
  const states = [
    { label: "未学习", value: stats.newCards, color: "#9ac5fa" },
    { label: "学习中", value: stats.learningCards, color: "#3888ed" },
    { label: "长期复习", value: stats.masteredCards, color: "#39a881" },
    { label: "暂停学习", value: stats.suspendedCards ?? 0, color: "#adb6c3" },
  ];
  const ratings = ["重来", "困难", "记得", "轻松"].map((label, index) => ({ label, value: stats.ratingCounts[index] ?? 0, color: ["#dc7b73", "#dca75a", "#3888ed", "#39a881"][index] }));
  const metrics = [
    { label: "今日复习", value: stats.reviewedToday, suffix: "次", detail: dueCount > 0 ? `今日还有 ${dueCount} 张待复习` : "今日没有待复习卡片", Icon: RotateCcw, tone: "blue" },
    { label: "自评记得比例", value: stats.totalReviews ? `${Math.round(stats.retentionRate * 100)}%` : "—", suffix: "", detail: "累计选择“记得 / 轻松”的比例", Icon: Target, tone: "green" },
    { label: "连续学习", value: studyStreak(stats.dailyActivity), suffix: "天", detail: "今天尚未学习时，保留截至昨天的连续记录", Icon: Flame, tone: "amber" },
    { label: "累计复习", value: stats.totalReviews, suffix: "次", detail: `牌库共 ${stats.totalCards} 张卡片`, Icon: Layers3, tone: "violet" },
  ];
  return <section className="study-dashboard" aria-label="学习统计图表">
    <div className="study-metrics">{metrics.map(({ label, value, suffix, detail, Icon, tone }, index) => <motion.article key={label} initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .25, delay: reduced ? 0 : index * .035 }}><span className={`study-metric-icon ${tone}`}><Icon size={18} /></span><span>{label}</span><strong>{value}<small>{suffix}</small></strong><p title={detail}>{detail}</p></motion.article>)}</div>
    <div className="study-grid">
      <article className="study-panel study-trend">
        <header><span><TrendingUp size={18} /><strong>复习趋势</strong></span><div className="study-range" role="group" aria-label="复习趋势时间范围">{([7, 30, 90] as const).map((days) => <button key={days} aria-pressed={range === days} onClick={() => setRange(days)}>{days} 天</button>)}</div></header>
        <div className="study-period-summary"><strong>{periodTotal}<small>次复习</small></strong><span>{activeDays} 天有学习记录{change !== null ? ` · 较前 ${range} 天${change >= 0 ? "增加" : "减少"} ${Math.abs(change)}%` : ""}</span></div>
        <div className="study-chart-wrap"><StudyArea key={range} data={activity} />{periodTotal === 0 && <p className="study-chart-empty">这段时间还没有复习记录，完成一次复习后会显示趋势。</p>}</div>
      </article>
      <article className="study-panel study-quota"><header><span><Target size={18} /><strong>今日新卡</strong></span></header><StudyProgress completed={stats.newStudiedToday ?? 0} limit={dailyNewLimit} /><p>{dailyNewLimit > 0 ? `每日额度 ${dailyNewLimit} 张，今天还可学习 ${Math.max(0, dailyNewLimit - (stats.newStudiedToday ?? 0))} 张新卡。` : "未设置每日新卡上限，按自己的节奏安排学习。"}</p><small>已学卡片的到期复习不占用新卡额度。</small></article>
      <article className="study-panel"><header><span><Layers3 size={18} /><strong>卡片状态</strong></span><small>当前牌库</small></header><StudyDonut data={states} total={stats.totalCards} /></article>
      <article className="study-panel"><header><span><BarChart3 size={18} /><strong>评分分布</strong></span><small>累计 {stats.totalReviews} 次</small></header><div className="study-chart-wrap"><StudyBars data={ratings} />{stats.totalReviews === 0 && <p className="study-chart-empty">复习后，这里会显示你的自评分布。</p>}</div><div className="study-rating-values">{ratings.map((item) => <span key={item.label}><i style={{ background: item.color }} />{item.label}<b>{item.value}</b></span>)}</div></article>
      <article className="study-panel study-wide"><header><span><CalendarDays size={18} /><strong>学习日历</strong></span><small>过去 52 周 · 每天的复习次数</small></header><div className="study-calendar-scroll"><div className="study-weekdays" aria-hidden="true"><span>一</span><span>三</span><span>五</span><span>日</span></div><div className="study-calendar" role="img" aria-label={`过去 52 周有 ${year.filter((day) => day.count > 0).length} 天学习记录，可在下方数据表查看日期与次数。`}>
        {Array.from({ length: leadingDays }, (_, index) => <i className="blank" key={`blank-${index}`} />)}
        {year.map((day) => <i key={day.date} className={`level-${day.count === 0 ? 0 : Math.min(4, Math.ceil(day.count / maxActivity * 4))}`} title={`${day.date}：${day.count} 次复习`} />)}
      </div></div><footer className="study-calendar-footer"><span>{year[0].date} — {year[year.length - 1].date}</span><span>少{[0,1,2,3,4].map((level) => <i key={level} className={`level-${level}`} />)}多</span></footer></article>
      <article className="study-panel study-wide"><header><span><Activity size={18} /><strong>牌组待复习量</strong></span><small>最多显示 8 个牌组 · 点击打开</small></header>{workload.length ? <div className="study-deck-load">{workload.map((deck, index) => <button key={deck.id} onClick={() => onOpenDeck(deck.id)} aria-label={`打开${deck.label}，${deck.value} 张待复习`}><span className="study-deck-rank">{String(index + 1).padStart(2, "0")}</span><span className="study-deck-name" title={deck.label}>{deck.label}</span><span className="study-deck-bar"><motion.i initial={false} animate={{ width: `${deck.value / maxDue * 100}%` }} transition={{ duration: reduced ? 0 : .5, ease: [0, .7, .5, 1] }} /></span><strong>{deck.value}<small> / {deck.total} 张</small></strong><ChevronRight size={15} /></button>)}</div> : <p className="study-empty-copy">牌组中还没有卡片。从收件箱移入卡片后，这里会显示待复习量。</p>}<p className="study-panel-note">按全部到期卡片统计，包含尚未学习的新卡；今日计划另受每日新卡额度限制。</p></article>
    </div>
    <details className="study-data-table" open={showData} onToggle={(event) => setShowData(event.currentTarget.open)}><summary>查看每日复习数据</summary>{showData && <div data-selectable="true"><table><thead><tr><th>日期</th><th>复习次数</th></tr></thead><tbody>{[...year].reverse().map((day) => <tr key={day.date}><td>{day.date}</td><td>{day.count}</td></tr>)}</tbody></table></div>}</details>
  </section>;
}
