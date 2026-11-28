import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Layers, SquareCheck, Sparkles, TrendingUp } from "lucide-react";
import type { InsightList } from "./InsightTypes";

export function MobileSearchOverview({
  due,
  tasks,
  topics,
  onGo,
  onSearch,
}: {
  due: number;
  tasks: number;
  topics: string[];
  onGo: (tab: "review" | "tasks" | "insights" | "browse") => void;
  onSearch: (q: string) => void;
}) {
  const [insights, setInsights] = useState("—");
  useEffect(() => {
    let live = true;
    invoke<InsightList>("agent_investigation", {
      args: { action: "insightList" },
    })
      .then((result) => {
        if (live)
          setInsights(
            String(
              result.items.filter((i) => i.processingState === "attention")
                .length,
            ) + (result.hasMore ? "+" : ""),
          );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="bw-overview">
      <div className="bw-pulse">
        {(
          [
            [due, "今日待复习", Layers, "review"],
            [tasks, "待办任务", SquareCheck, "tasks"],
            [insights, "待关注洞察", Sparkles, "insights"],
          ] as const
        ).map(([count, label, Icon, dest]) => (
          <button key={dest} onClick={() => onGo(dest)}>
            <b>{count}</b>
            <small>
              <Icon size={12} />
              {label}
            </small>
          </button>
        ))}
      </div>
      <header>
        <strong>试试搜索 · 跨库高频主题</strong>
        <button onClick={() => onGo("browse")}>浏览资料库目录 →</button>
      </header>
      {!topics.length && <small className="bw-search-topic-empty">当前范围暂无已索引主题</small>}
      {!!topics.length && (
        <div className="bw-tabs bw-search-topics">
          {topics.map((q) => (
            <button key={q} onClick={() => onSearch(q)}>
              <TrendingUp size={11} aria-hidden="true" />
              <span>{q}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
