import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FlashcardDeckSummary } from "./FlashcardTypes";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const entries = (value: unknown): RecordValue[] => Array.isArray(value) ? value.filter(v => v && typeof v === "object" && !Array.isArray(v)) as RecordValue[] : [];
const text = (value: unknown) => typeof value === "string" ? value : "";

export function FlashcardGenerationDetails({ generation, decks }: { generation: unknown; decks: FlashcardDeckSummary[] }) {
  const context = object(object(generation).qualityContext);
  const scope = object(context.scope);
  const ruleIds = Array.isArray(context.ruleIds) ? context.ruleIds.filter((v): v is string => typeof v === "string") : [];
  const snapshots = entries(context.ruleSnapshots);
  const excluded = entries(context.excludedTargets);
  const applications = entries(context.ruleApplications);
  const [open, setOpen] = useState(false);
  const [currentRules, setCurrentRules] = useState<RecordValue[]>([]);
  const [lookupError, setLookupError] = useState(false);
  const legacy = ruleIds.length > 0 && !Array.isArray(context.ruleSnapshots);
  const lookupKey = ruleIds.join("|");
  useEffect(() => {
    if (!open || !legacy) return;
    let cancelled = false;
    setLookupError(false);
    void invoke<{ records: RecordValue[] }>("get_flashcard_quality")
      .then(data => { if (!cancelled) setCurrentRules(entries(data.records).filter(r => r.kind === "rule")); })
      .catch(() => { if (!cancelled) setLookupError(true); });
    return () => { cancelled = true; };
  }, [open, legacy, lookupKey]);
  if (!Object.keys(context).length) return null;
  const rules: RecordValue[] = legacy ? ruleIds.map(id => currentRules.find(r => r.id === id) ?? { id }) : snapshots;
  const scopeLabel = (rule: RecordValue) => rule.scopeType === "global" ? "全部制卡任务"
    : rule.scopeType === "deck" ? text(rule.scopeLabel) || decks.find(d => d.id === rule.scopeValue)?.name || "原牌组"
    : rule.scopeType === "topic" ? `主题：${text(rule.scopeValue)}` : "未记录范围";
  return <details className="flashcards-generation-details" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>制卡依据 · {legacy ? ruleIds.length : snapshots.length} 条参考规则{excluded.length > 0 ? ` · ${excluded.length} 个排除目标` : ""}</summary>
    <div data-selectable="true">
      {text(scope.learningGoal) && <p><b>本次学习目标：</b>{text(scope.learningGoal)}</p>}
      <p><b>参考规则：</b>{rules.length ? (legacy ? "提交时正文未记录，以下为当前规则，可能已修改" : "提交时保存的规则版本") : "本次未匹配生效规则"}</p>
      {lookupError && <p role="status">当前规则暂时无法读取，原提交记录仍保留。</p>}
      {rules.map(rule => {
        const application = applications.find(a => a.ruleId === rule.id);
        return <section key={text(rule.id)}>
          <b>{text(rule.title) || "参考规则（正文未记录）"}</b>
          {!legacy && typeof rule.updatedAt === "number" && <p>规则更新时间：{new Date(rule.updatedAt).toLocaleString()}</p>}
          {text(rule.text) && <p>{text(rule.text)}</p>}
          {text(rule.text) && <p>范围：{scopeLabel(rule)} · 学习目标：{text(rule.learningGoal) || "不限制"}</p>}
          {text(rule.exceptions) && <p>例外条件：{text(rule.exceptions)}</p>}
          {application && <p><b>AI 处理说明 · {application.decision === "exception" ? "按例外处理" : "采用规则"}：</b>{text(application.reason)}</p>}
        </section>;
      })}
      {excluded.length > 0 && <><p><b>本批次排除的目标：</b></p>{excluded.map((target, i) => <section key={i}>
        <b>{text(target.recallTarget) || text(target.target) || "未提供目标名称"}</b>
        {text(target.reason) && <p>原因：{text(target.reason)}</p>}
        {text(target.sourceLocation) && <p>来源位置：{text(target.sourceLocation)}</p>}
      </section>)}</>}
    </div>
  </details>;
}
