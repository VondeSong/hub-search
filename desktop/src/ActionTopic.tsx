import { useMemo, useState } from "react";
import type { QuickJournalItem } from "./JournalRecords";
import type { SearchResult } from "./SearchTypes";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import { archiveAction } from "./ActionJournal";
import { generate, type Material } from "./ActionEvidence";
import { read, write, identity, type ActionMeta, type Draft, type Topic } from "./ActionState";
import { assembleMaterials, Materials, useRecall } from "./ActionMaterials";
import { DraftView } from "./ActionDetail";

export function ActionTopic({
  topic,
  tasks,
  meta,
  journals,
  scope,
  day,
  onOpen,
  children,
}: {
  topic: Topic;
  tasks: UnifiedTask[];
  meta: (t: UnifiedTask) => ActionMeta;
  journals: QuickJournalItem[];
  scope: string[] | null;
  day: string;
  onOpen?: (r: SearchResult) => void;
  children: React.ReactNode;
}) {
  const [wall, setWall] = useState(false),
    [report, setReport] = useState(() =>
      read<{ version: string; draft: Draft } | null>("report." + topic.key, null),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [archived, setArchived] = useState("");
  const recall = useRecall(topic.name, scope);
  const wait = tasks.filter((t) => t.status === "open").flatMap((t) => meta(t).waits.filter((w) => !w.resolved));
  const blockers = wait.filter((w) => w.blocking),
    parallel = wait.filter((w) => !w.blocking);
  const describe = (items: typeof wait) =>
    items.length ? "（" + items.map((w) => w.who + " · " + w.what).join("、") + "）" : "";
  const summary = `当前${blockers.length ? "有 " + blockers.length + " 项阻塞" + describe(blockers) : "无阻塞项"}，${parallel.length ? "仍有 " + parallel.length + " 项并行等回复" + describe(parallel) : "无并行等待"}。`;
  const base = tasks.map((t) => ({
    id: identity(t),
    title: t.title,
    text: [
      t.title,
      t.completed ? "已闭环" : "待办",
      ...meta(t).waits.map((w) =>
        [w.who, w.what, w.resolved ? "已收到" : w.blocking ? "阻塞" : "并行等待", w.review].join(" · "),
      ),
    ].join("\n"),
  }));
  const links = tasks.flatMap((t) => meta(t).links);
  const pack = useMemo(
    () =>
      assembleMaterials(
        [
          topic.name,
          ...tasks
            .filter((t) => !t.completed)
            .slice(0, 5)
            .map((t) => t.title),
        ].join(" "),
        journals,
        recall.items,
        links,
        day,
      ),
    [topic, tasks, journals, recall, links, day],
  );
  const evidence: Material[] = [
    {
      id: "status",
      title: "专题当前状态",
      text: `${tasks.length} 项行动，已闭环 ${tasks.filter((t) => t.completed).length} 项。${summary} 附列 ${Math.min(30, tasks.length)} 项行动明细。`,
    },
    ...base.slice(0, 30),
    ...pack.all.slice(0, 15),
  ];
  const version = JSON.stringify([base.map((m) => [m.id, m.text]), pack.all.map((m) => [m.id, m.text])]);
  const current = report?.version === version ? report.draft : null;
  const liveLines = [
    "已闭环 · " +
      (tasks
        .filter((t) => t.completed)
        .map((t) => t.title)
        .join("、") || "暂无"),
    "下一步 · " +
      (tasks
        .filter((t) => !t.completed && !meta(t).waits.some((w) => !w.resolved && w.blocking))
        .map((t) => t.title)
        .join("、") || "暂无"),
  ];
  const reportText = [
    topic.name,
    summary,
    ...(current
      ? current.claims.map((c) => (c.verify ? "待核实 · " : "") + c.text + "\n依据：" + c.quote)
      : liveLines),
  ].join("\n");
  async function produce() {
    setBusy(true);
    setError("");
    try {
      const claims = await generate("report", evidence);
      if (!claims.length) throw Error("暂无有依据的可用通报。");
      const saved = { version, draft: { mode: "report", claims, sources: evidence } };
      await write("report." + topic.key, saved);
      setReport(saved);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="aw-topic">
        <h2><i className="aw-topic-dot" /> {topic.name}</h2>
        <small>
          <span className="aw-stage">{blockers.length?"等待外部交付":tasks.some(t=>!t.completed)?"进行中":tasks.length?"已闭环":"暂无行动"}</span> {tasks.filter((t) => t.status === "open").length} 待办 · {tasks.filter((t) => t.completed).length} 已闭环
          · {blockers.length} 项阻塞 · {parallel.length} 项等回复
        </small>
        <div className="aw-tools">
          <button id="aw-report" disabled={busy || !tasks.length} onClick={() => void produce()}>
            {busy ? "正在起草…" : "生成阶段通报"}
          </button>
        </div>
        <div className="aw-progress">
          <i
            style={{
              width: (tasks.length ? (tasks.filter((t) => t.completed).length / tasks.length) * 100 : 0) + "%",
            }}
          />
        </div>
        <div className="aw-summary">
          <small>✦ 实时专题汇总（随等待回复动态刷新）</small>
          <p>{summary}</p>
        </div>
        {current && (
          <>
            <DraftView draft={current} journals={journals} onOpen={onOpen} />
            <button
              onClick={() => void navigator.clipboard.writeText(reportText).catch((e) => setError(String(e)))}
            >
              复制通报
            </button>
          </>
        )}
        {report && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setArchived(await archiveAction("topic." + topic.key, reportText));
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            归档至今日日志
          </button>
        )}
        {report && !current && (
          <section>
            <h3>最新阶段通报</h3>
            <p>{summary}</p>
            {liveLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <small>状态已实时更新，可重新生成带来源的文字。</small>
          </section>
        )}
        {error && <p role="alert">{error}</p>}
        {archived && <p role="status">{archived}</p>}
      </section>
      <div className="aw-tabs">
        <button aria-pressed={!wall} onClick={() => setWall(false)}>
          行动与卡点
        </button>
        <button aria-pressed={wall} onClick={() => setWall(true)}>
          专题素材与证据墙
        </button>
      </div>
      {wall ? (
        <>
          {recall.error && <p role="alert">{recall.error}</p>}
          <Materials items={pack.all} journals={journals} onOpen={onOpen} />
          {!pack.all.length && <p>当前专题暂无匹配材料。</p>}
        </>
      ) : (
        children
      )}
    </>
  );
}
