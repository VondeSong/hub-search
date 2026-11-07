// Adapted from EvilCharts, Copyright (c) 2026 Gurbinder, MIT. See LICENSE/README.md.
import { useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const REVEAL_EASE: [number, number, number, number] = [0, 0.7, 0.5, 1];
export type ChartDatum = { label: string; value: number; color?: string };

function StudyTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: readonly { name?: string | number; value?: unknown; color?: string; payload?: Record<string, unknown> }[];
  label?: unknown;
}) {
  if (!active || !payload?.length) return null;
  const item = payload[0];
  return <div className="study-chart-tooltip"><strong>{String(item.payload?.date ?? item.payload?.label ?? label ?? "")}</strong>{payload.map((entry, index) => <span key={index}><i style={{ background: entry.color ?? "#3888ed" }} />{entry.name === "count" || entry.name === "value" ? "数量" : entry.name}<b>{String(entry.value ?? 0)}</b></span>)}</div>;
}

export function StudyArea({ data }: { data: { date: string; label: string; count: number }[] }) {
  const id = `study-area-${useId().replace(/:/g, "")}`;
  const reduced = useReducedMotion();
  return <div className="study-chart-canvas" role="img" aria-label={`复习趋势，共 ${data.reduce((n, item) => n + item.count, 0)} 次。下方可查看数据表。`}>
    <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 400, height: 220 }}>
      <AreaChart data={data} margin={{ top: 12, right: 12, left: -22, bottom: 0 }} accessibilityLayer>
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3888ed" stopOpacity={.3} /><stop offset="100%" stopColor="#3888ed" stopOpacity={.015} /></linearGradient>
          {!reduced && <mask id={`${id}-reveal`} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%"><motion.rect x="0" y="0" width="100%" height="100%" fill="white" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: .7, ease: REVEAL_EASE }} style={{ originX: 0 }} /></mask>}
        </defs>
        <CartesianGrid vertical={false} stroke="var(--study-grid)" strokeDasharray="3 5" />
        <XAxis dataKey="label" axisLine={false} tickLine={false} minTickGap={34} tick={{ fontSize: 11, fill: "var(--study-muted)" }} />
        <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "var(--study-muted)" }} domain={[0, (max: number) => Math.max(4, max)]} />
        <Tooltip content={<StudyTooltip />} cursor={{ stroke: "#8dbbf5", strokeDasharray: "3 3" }} />
        <Area type="monotone" dataKey="count" name="复习次数" stroke="#3888ed" strokeWidth={2.5} fill={`url(#${id}-fill)`} isAnimationActive={false} dot={false} activeDot={{ r: 5, fill: "#3888ed", stroke: "#fff", strokeWidth: 3 }} style={reduced ? undefined : { mask: `url(#${id}-reveal)` }} />
      </AreaChart>
    </ResponsiveContainer>
  </div>;
}

type BarShape = { x?: number; y?: number; width?: number; height?: number; index?: number; fill?: string };
function GrowingBar({ x = 0, y = 0, width = 0, height = 0, index = 0, fill, startedAt, reduced }: BarShape & { startedAt: number; reduced: boolean }) {
  const start = index * 45;
  const elapsed = Date.now() - startedAt;
  const end = start + 500;
  const rect = <rect x={x} y={y} width={Math.max(0, width)} height={Math.max(0, height)} rx={5} fill={fill} />;
  // Recharts may remount shapes on hover. Anchor to the chart's first render so
  // interactions never replay the entrance (the EvilCharts one-shot pattern).
  if (reduced || elapsed >= end) return rect;
  return <motion.g initial={{ scaleY: elapsed <= start ? 0 : (elapsed - start) / 500 }} animate={{ scaleY: 1 }} transition={{ duration: (end - Math.max(elapsed, start)) / 1000, delay: Math.max(0, start - elapsed) / 1000, ease: REVEAL_EASE }} style={{ originY: 1 }}>{rect}</motion.g>;
}

export function StudyBars({ data }: { data: ChartDatum[] }) {
  const [startedAt] = useState(Date.now);
  const reduced = Boolean(useReducedMotion());
  const id = `study-bars-${useId().replace(/:/g, "")}`;
  return <div className="study-chart-canvas" role="img" aria-label={data.map((item) => `${item.label} ${item.value} 次`).join("，")}>
    <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 400, height: 220 }}>
      <BarChart data={data} margin={{ top: 16, right: 4, left: -22, bottom: 0 }} accessibilityLayer barCategoryGap="26%">
        <defs>{data.map((item, index) => <linearGradient key={index} id={`${id}-${index}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={item.color ?? "#3888ed"} /><stop offset="100%" stopColor={item.color ?? "#3888ed"} stopOpacity={.45} /></linearGradient>)}</defs>
        <CartesianGrid vertical={false} stroke="var(--study-grid)" strokeDasharray="3 5" />
        <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "var(--study-muted)" }} />
        <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: "var(--study-muted)" }} domain={[0, (max: number) => Math.max(4, max)]} />
        <Tooltip content={<StudyTooltip />} cursor={{ fill: "var(--study-hover)" }} />
        <Bar dataKey="value" name="复习次数" maxBarSize={54} isAnimationActive={false} shape={(props: unknown) => <GrowingBar {...props as BarShape} startedAt={startedAt} reduced={reduced} />}>
          {data.map((_, index) => <Cell key={index} fill={`url(#${id}-${index})`} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  </div>;
}

export function StudyDonut({ data, total }: { data: ChartDatum[]; total: number }) {
  const reduced = Boolean(useReducedMotion());
  const [active, setActive] = useState<number | null>(null);
  const nonempty = data.filter((item) => item.value > 0);
  return <div className="study-donut-layout">
    <div className="study-donut-canvas" role="img" aria-label={data.map((item) => `${item.label} ${item.value} 张`).join("，")}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 200, height: 200 }}>
        <PieChart accessibilityLayer><Pie data={nonempty.length ? nonempty : [{ label: "暂无卡片", value: 1, color: "#e9edf2" }]} dataKey="value" nameKey="label" innerRadius="67%" outerRadius="89%" paddingAngle={nonempty.length > 1 ? 3 : 0} cornerRadius={5} stroke="none" isAnimationActive={!reduced} animationDuration={650} onMouseEnter={(_, index) => setActive(index)} onMouseLeave={() => setActive(null)}>
          {(nonempty.length ? nonempty : [{ color: "#e9edf2" }]).map((item, index) => <Cell key={index} fill={item.color} opacity={active === null || active === index ? 1 : .35} />)}
        </Pie>{nonempty.length > 0 && <Tooltip content={<StudyTooltip />} />}</PieChart>
      </ResponsiveContainer>
      <span className="study-donut-center"><strong>{active !== null && nonempty[active] ? nonempty[active].value : total}</strong><small>{active !== null && nonempty[active] ? nonempty[active].label : "总卡片"}</small></span>
    </div>
    <div className="study-legend">{data.map((item) => <div key={item.label}><i style={{ background: item.color }} /><span>{item.label}</span><strong>{item.value}</strong><small>{total ? `${Math.round(item.value / total * 100)}%` : "—"}</small></div>)}</div>
  </div>;
}
export { StudyProgress } from "../../StudyProgress";

