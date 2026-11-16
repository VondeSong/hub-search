import { Check, ChevronRight, Info, Search, X } from "lucide-react";
import { useState } from "react";
import { CloudAgentSheet } from "./CloudAgentMaterials";

export type ModelSelection = { model: string; effort?: string };
export type CloudModel = { model: string; displayName: string; description?: string; isDefault?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts: { reasoningEffort: string; description?: string }[]; inputModalities?: string[] };
export type ModelCatalog = { state: "loading" | "ready" | "error"; models: CloudModel[]; error?: string; updatedAt?: number };
export type CloudAccount = { state: "unknown" | "ready" | "login" | "quota"; plan?: string; model?: string; limits?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number }[] };
export type SkillChoice = { name: string; title: string; description?: string; methodVersion: string; paths: string[] };
export type BoundSkill = { name: string; version: string; paths: string[] };
export const effortLabel = (value?: string) => ({ none: "不使用", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大", ultra: "Ultra" })[value || ""] || value || "默认";
const effortDescription = (value: string) => ({ none: "直接回答", minimal: "适合简单问题", low: "更快地回答简单问题", medium: "平衡速度和推理深度", high: "为复杂问题投入更多推理", xhigh: "更充分地推理与检查", max: "使用模型的最大推理投入", ultra: "最高推理投入，等待可能更久" })[value] || "按执行端能力运行";
export const modelLabel = (model: string) => model.replace(/^gpt-/i, "GPT-").replace(/-(sol|astra|terra|luna)$/i, " $1").replace(/\b(sol|astra|terra|luna)\b/gi, value => value[0].toUpperCase() + value.slice(1).toLowerCase());
export const planLabel = (plan?: string) => ({ prolite: "ChatGPT Pro Lite", pro: "ChatGPT Pro", plus: "ChatGPT Plus", team: "ChatGPT Team", business: "ChatGPT Business", enterprise: "ChatGPT Enterprise", free: "ChatGPT Free" })[plan?.toLowerCase() || ""] || "ChatGPT 订阅";
export function quotaLabel(minutes?: number) {
  if (minutes === 10080) return "本周已用";
  if (minutes && minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440} 天额度已用`;
  if (minutes && minutes > 0 && minutes % 60 === 0) return `${minutes / 60} 小时额度已用`;
  return minutes && minutes > 0 ? `${minutes} 分钟额度已用` : "额度已用";
}

export function CloudModelPanel({ page, catalog, account, selection, disabled, onSelect, onPage, onRefresh }: {
  page: "model" | "effort" | "usage"; catalog?: ModelCatalog; account?: CloudAccount; selection?: ModelSelection; disabled: boolean;
  onSelect: (value: ModelSelection) => void; onPage: (page: "model" | "effort" | "usage") => void; onRefresh: () => void;
}) {
  const current = catalog?.models.find(item => item.model === selection?.model);
  if (page === "usage") return <div className="cloud-preferences-body">
    <p className="cloud-preferences-note">{planLabel(account?.plan)}</p>
    {account?.limits?.some(limit => typeof limit.usedPercent === "number" && Number.isFinite(limit.usedPercent)) ?
      account.limits.filter(limit => typeof limit.usedPercent === "number" && Number.isFinite(limit.usedPercent)).map((limit, index) => <section className="cloud-usage-window" key={index}>
        <div><span>{quotaLabel(limit.windowDurationMins)}</span><strong>{limit.usedPercent}%</strong></div>
        <progress max={100} value={Math.max(0, Math.min(100, limit.usedPercent!))} aria-label={quotaLabel(limit.windowDurationMins)}/>
        {limit.resetsAt && <small>恢复时间：{new Date(limit.resetsAt * 1000).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</small>}
      </section>) : <p>执行端暂未提供额度读数。</p>}
    <p className="cloud-preferences-note">这里显示额度统计周期，周期长度不是已使用时长。读数由 Codex 提供，可能延迟更新。</p>
  </div>;
  if (!catalog || catalog.state !== "ready") return <div className="cloud-preferences-body">
    <p role="status">{catalog?.state === "loading" ? "正在读取执行端模型…" : catalog?.error || "当前云端尚未提供模型目录，请更新云端服务。"}</p>
    <button type="button" onClick={onRefresh}>重新读取</button>
  </div>;
  if (page === "effort") return <div className="cloud-preferences-body">
    <p className="cloud-preferences-note">{current ? modelLabel(current.model) : "请先选择可用模型"} · 用于下一条消息</p>
    <div className="cloud-preferences-options">{current?.supportedReasoningEfforts.map(option => <button type="button" key={option.reasoningEffort} disabled={disabled}
      aria-pressed={selection?.effort === option.reasoningEffort} onClick={() => onSelect({ model: current.model, effort: option.reasoningEffort })}>
      <span><strong>{effortLabel(option.reasoningEffort)}</strong><small>{effortDescription(option.reasoningEffort)}{current.defaultReasoningEffort === option.reasoningEffort ? " · 默认" : ""}</small></span>
      {selection?.effort === option.reasoningEffort && <Check size={18}/>}</button>)}</div>
  </div>;
  return <>
    <div className="cloud-preferences-body cloud-preferences-options" aria-label="可用模型">{catalog.models.length ? catalog.models.map(item => <button type="button" key={item.model}
      disabled={disabled} aria-pressed={selection?.model === item.model} onClick={() => onSelect({ model: item.model, ...(item.defaultReasoningEffort && { effort: item.defaultReasoningEffort }) })}>
      <span><strong>{modelLabel(item.model)}</strong>{item.isDefault && <small>执行端默认模型</small>}</span>{selection?.model === item.model && <Check size={18}/>}</button>) : <p>执行端没有返回可用模型。</p>}</div>
    <div className="cloud-preferences-links">
      <button type="button" disabled={!current || disabled} onClick={() => onPage("effort")}><span>推理强度</span><small>{effortLabel(selection?.effort)}</small><ChevronRight size={17}/></button>
      <button type="button" onClick={() => onPage("usage")}><span>订阅用量</span><small>{planLabel(account?.plan).replace("ChatGPT ", "")}</small><ChevronRight size={17}/></button>
    </div><p className="cloud-preferences-note">用于下一条消息；当前回复继续使用发送时的选择。</p>
  </>;
}

export function CloudSkillSheet({ skills, chosen, paths, bound, loadingError, onRetry, onChoose, onClose }: {
  skills?: SkillChoice[]; chosen?: SkillChoice; paths: string[]; bound?: BoundSkill; loadingError?: string;
  onRetry: () => void; onChoose: (skill?: SkillChoice, paths?: string[]) => void | Promise<void>; onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setDetail] = useState<SkillChoice | undefined>(chosen);
  const detail = picked ?? (bound ? skills?.find(item => item.methodVersion === bound.version) : undefined);
  const [files, setFiles] = useState(paths);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const fixed = Boolean(bound);
  const referencePaths = fixed ? bound!.paths.filter(path => path !== "SKILL.md") : detail?.paths ?? [];
  const showFixed = fixed && !detail;
  const visible = skills?.filter(item => `${item.title} ${item.name} ${item.description || ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  async function choose(skill?: SkillChoice, selectedPaths: string[] = []) {
    if (adding) return;
    setAdding(true); setError("");
    try { await onChoose(skill, selectedPaths); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); if (skill) { setDetail(skill); setFiles(selectedPaths); } }
    finally { setAdding(false); }
  }
  return <CloudAgentSheet title={showFixed ? "本对话的技能" : detail ? `/${detail.name}` : "技能"} compact expanded={Boolean(detail || (skills?.length ?? 0) > 3)} busy={adding} onClose={onClose} onBack={detail && !fixed ? () => setDetail(undefined) : undefined}>
    {error && <p role="alert">{error}</p>}
    {showFixed ? <div className="cloud-preferences-body"><h3>{bound!.name}</h3><p className="cloud-preferences-note">此版本已固定到本对话。新建对话可使用其他技能或版本。</p><ul className="cloud-skill-bound-files">{bound!.paths.map(path => <li key={path}>{path}</li>)}</ul></div> : detail ? <>
      <div className="cloud-preferences-body"><h3 className="cloud-preferences-heading">{detail.title}</h3><p className="cloud-skill-description">{detail.description || "使用此技能的已保存文字方法协助回答。"}</p>
        <details className="cloud-skill-resources"><summary>配套文件 · {referencePaths.length}</summary>
          <p className="cloud-preferences-note">默认加入配套文字。正文引用的文件需保留，正文与配套文字合计最多 48 KiB。</p>
          <div className="cloud-skill-files">{referencePaths.map(path => fixed ? <div className="cloud-skill-fixed-file" key={path}><Check size={19} aria-hidden="true"/><span>{path.split("/").pop()}<small>{path.slice(0, path.lastIndexOf("/") + 1)}</small></span><small>已加入</small></div> : <label key={path}><input type="checkbox" disabled={adding} checked={files.includes(path)}
            onChange={event => setFiles(old => event.target.checked ? [...old, path] : old.filter(value => value !== path))}/><span>{path.split("/").pop()}<small>{path.slice(0, path.lastIndexOf("/") + 1)}</small></span></label>)}</div>
        </details>
        <details className="cloud-skill-version"><summary>版本信息</summary><p>{detail.methodVersion}</p></details>
      </div><footer className="cloud-preferences-footer"><p className="cloud-preferences-note">{fixed ? "本对话已固定此版本；新建对话可更换技能。" : "添加后仍需发送消息；首次发送会固定此版本。"}</p>
        {!fixed && <button type="button" className="cloud-agents-primary" disabled={adding} onClick={() => void choose(detail, files)}>{adding ? "正在检查技能文件…" : "添加到消息"}</button>}</footer>
    </> : <>
      <label className="cloud-skill-search"><Search size={18}/><input aria-label="搜索技能" placeholder="搜索技能" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button type="button" aria-label="清除技能搜索" onClick={() => setQuery("")}><X size={16}/></button>}</label>
      <div className="cloud-preferences-body cloud-skill-list">{loadingError ? <><p role="alert">{loadingError}</p><button type="button" onClick={onRetry}>重新读取技能</button></> : !skills ? <p role="status">正在读取本机技能…</p> : !visible?.length ? <p>{query ? "没有匹配的技能。" : "本机还没有可用于云端的文字技能。"}</p> : visible.map(item => <div className="cloud-skill-row" key={item.methodVersion}>
        <button type="button" disabled={adding} aria-label={`添加技能 ${item.title}`} onClick={() => void choose(item, chosen?.methodVersion === item.methodVersion ? paths : item.paths)}><span><strong>/{item.name}</strong><span>{item.description || item.title}</span><small>{item.paths.length ? `附 ${item.paths.length} 份配套文字` : "文字技能"}</small></span>{chosen?.methodVersion === item.methodVersion && <Check size={18}/>}</button>
        <button type="button" disabled={adding} className="cloud-skill-info" aria-label={`查看技能 ${item.title} 的详情`} onClick={() => { setError(""); setFiles(chosen?.methodVersion === item.methodVersion ? paths : item.paths); setDetail(item); }}><Info size={19}/></button>
      </div>)}</div>
      <p className="cloud-preferences-note">{adding ? "正在检查技能文件…" : "添加的技能与配套文字会随下一条消息发送。"}</p>
      {chosen && <button type="button" disabled={adding} onClick={() => void choose()}>移除待发送技能</button>}
    </>}
  </CloudAgentSheet>;
}
