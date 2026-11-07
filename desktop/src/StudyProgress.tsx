// Adapted from EvilCharts, Copyright (c) 2026 Gurbinder, MIT. See charts/evilcharts/LICENSE/README.md.
import { motion, useReducedMotion } from "motion/react";
import "./StudyDashboard.css";
const REVEAL_EASE: [number, number, number, number] = [0, 0.7, 0.5, 1];

export function StudyProgress({ completed, limit }: { completed: number; limit: number }) {
  const reduced = useReducedMotion();
  const progress = limit > 0 ? Math.min(1, Math.max(0, completed / limit)) : 0;
  return <div className="study-progress" aria-label={limit > 0 ? `今日新卡 ${completed} 张，每日额度 ${limit} 张` : `今日新卡 ${completed} 张，不设每日上限`}>
    <svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="26" fill="none" stroke="var(--study-grid,#e8edf4)" strokeWidth="5" /><motion.circle cx="32" cy="32" r="26" fill="none" stroke={progress === 1 ? "#36a47b" : "#3888ed"} strokeWidth="5" strokeLinecap="round" pathLength="1" strokeDasharray="1" initial={false} animate={{ strokeDashoffset: 1 - progress }} transition={{ duration: reduced ? 0 : .6, ease: REVEAL_EASE }} transform="rotate(-90 32 32)" /></svg>
    <span><strong>{completed}</strong><small>{limit > 0 ? `/ ${limit} 张新卡` : "张新卡 · 不限额"}</small></span>
  </div>;
}
