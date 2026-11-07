type RecordValue = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value : "";
const sameVersion = (old: RecordValue, current: RecordValue) => ["updatedAt", "text", "title", "enabled", "scopeType", "scopeValue", "learningGoal", "exceptions", "positiveExample", "negativeExample", "comment", "status", "excludeTarget", "action", "reason"].every(key => old[key] === current[key]);
const date = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? new Date(value).toLocaleString() : "时间未记录";

export function FlashcardQualityHistory({ records, decks = [] }: { records: RecordValue[]; decks?: FlashcardDeckSummary[] }) {
  const history = records.filter(r => r.kind === "history");
  const ids = [...new Set(history.map(r => text(r.recordId)).filter(Boolean))];
  const renderRule = (rule: RecordValue) => <>
    {text(rule.title) && <p><b>{text(rule.title)}</b></p>}
    <p>{text(rule.text)}</p>
    <p>适用范围：{rule.scopeType === "global" ? "全部任务" : rule.scopeType === "topic" ? `主题：${text(rule.scopeValue)}` : decks.find(d => d.id === rule.scopeValue)?.name || `原牌组 ${text(rule.scopeValue)}`}</p>
    <p>{rule.enabled ? "生效" : "已停用"} · 学习目标：{text(rule.learningGoal) || "不限制"}</p>
    {text(rule.exceptions) && <p>例外：{text(rule.exceptions)}</p>}
    {text(rule.positiveExample) && <p>希望出现的例子：{text(rule.positiveExample)}</p>}
    {text(rule.negativeExample) && <p>不希望出现的例子：{text(rule.negativeExample)}</p>}
  </>;
  return <div className="quality-history">
    <p>反馈和规则的旧版本保留在这里，供核对。同步仍采用较新的更新时间；同一时刻按稳定排序选择。历史记录不会自动覆盖当前内容。</p>
    {ids.length === 0 && <p className="quality-empty">后续反馈或规则发生修改后，旧版本会显示在这里。</p>}
    {ids.map(id => {
      const current = records.find(r => r.id === id && r.kind !== "history");
      const related = history.filter(r => r.recordId === id);
      const merges = related.filter(r => r.historyType === "sync-merge");
      const versions = related.filter(r => r.historyType !== "sync-merge" && (!current || !sameVersion(r, current)))
        .filter((version, index, all) => all.findIndex(other => sameVersion(other, version)) === index)
        .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
      const sample = current ?? related.find(r => r.historyType !== "sync-merge") ?? {};
      const feedback = sample.kind === "feedback" || sample.recordKind === "feedback";
      const snapshot = sample.snapshot && typeof sample.snapshot === "object" ? sample.snapshot as RecordValue : {};
      return <article className="quality-entry" key={id}>
        <header><strong>{feedback ? text(snapshot.question) || "反馈记录" : text(sample.title) || "制卡规则"}</strong><small>{versions.length} 个旧版本</small></header>
        {merges.length > 0 && <p className="quality-history-sync" role="status">同步发现不同版本，其他内容已保留供核对。不同版本也可能来自先后修改。</p>}
        {current && <section data-selectable="true"><b>当前内容 · {date(current.updatedAt)}</b>{feedback ? <><p>{text(current.comment) || "未填写补充说明"}</p><p>{current.status === "resolved" ? "已处理" : "待处理"} · {current.excludeTarget ? "避免重复生成" : "未排除记忆目标"}</p></> : renderRule(current)}</section>}
        <details><summary>查看旧版本</summary>{versions.map(version => <section key={text(version.id)} data-selectable="true"><b>{date(version.updatedAt)}</b>{feedback ? <><p>{text(version.comment) || "未填写补充说明"}</p><p>{version.status === "resolved" ? "已处理" : "待处理"} · {version.excludeTarget ? "避免重复生成" : "未排除记忆目标"}</p></> : renderRule(version)}</section>)}</details>
      </article>;
    })}
  </div>;
}
import type { FlashcardDeckSummary } from "./FlashcardTypes";
