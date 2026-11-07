import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { codexSelectionLabel, type CodexSettings } from "./CodexSuite";

type Changes = { schemaVersion: number; topicId: string; topicRevision: number; workId: string; workRevision: number; authorizationVersion: number; period: string;
  state: "changed" | "unchanged" | "unverified"; sources: { status: string; beforeCount: number | null; currentCount: number; added: number | null; removed: number | null; changed: number | null; uncomparable: number | null; reason?: string };
  baseline: { origin: string; runId: string | null; configRevision: number | null; methodVersion: string | null; methodUse: { loadedThisRun: boolean; sentToRuntime: boolean } | null };
  selectedMethod: string; methodChanged: boolean | null; parametersChanged: boolean | null; sourceRuleChanged: boolean | null; requestedModelChanged: boolean | null;
  previousRequestedModel: CodexSettings | null; currentRequestedModel: CodexSettings; methodCompatible: boolean; methodUnavailableReason: string | null;
};
const difference = (value: boolean | null) => value === null ? "旧记录不足以判断" : value ? "有变化" : "在已核对记录中未变";
const count = (value: number | null) => value === null ? "未知" : value;
export function AgentTopicChanges({ topicId, topicRevision, workId, workRevision, authorizationVersion, disabled }: {
  topicId: string; topicRevision: number; workId: string; workRevision: number; authorizationVersion: number; disabled: boolean;
}) {
  const [view, setView] = useState<Changes | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const sequence = useRef(0), scope = JSON.stringify([topicId, topicRevision, workId, workRevision, authorizationVersion]), currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => { sequence.current++; setView(null); setError(""); setLoading(false); return () => { sequence.current++; }; }, [scope]);
  async function inspect() {
    const ticket = ++sequence.current; setView(null); setError(""); setLoading(true);
    try {
      const value = await invoke<Changes>("agent_investigation", { args: { action: "topicChanges", topicId, expectedRevision: topicRevision, workId, expectedWorkRevision: workRevision, expectedAuthorizationVersion: authorizationVersion } });
      if (ticket !== sequence.current || currentScope.current !== scope) return;
      if (value.schemaVersion !== 1 || value.topicId !== topicId || value.topicRevision !== topicRevision || value.workId !== workId || value.workRevision !== workRevision || value.authorizationVersion !== authorizationVersion || !["changed", "unchanged", "unverified"].includes(value.state)) throw new Error("变化说明身份或版本不一致，请重新核对当前状态");
      setView(value);
    } catch (reason) { if (ticket === sequence.current && currentScope.current === scope) setError(String(reason)); }
    finally { if (ticket === sequence.current && currentScope.current === scope) setLoading(false); }
  }
  return <section aria-label="本期变化核对">
    <button type="button" disabled={disabled || loading} onClick={() => void inspect()}>检查本期材料与方法变化（不运行）</button>
    {loading && <p role="status">正在核对已保存绑定与当前本地资料，不启动分析…</p>}
    {error && <p role="alert">{error}</p>}
    {view && view.topicId === topicId && view.topicRevision === topicRevision && view.workId === workId && view.workRevision === workRevision && view.authorizationVersion === authorizationVersion && <>
      <p role="status">{view.period}：{view.state === "changed" ? "发现已记录的变化。" : view.state === "unchanged" ? "在已核对的缓存版本与配置中未发现变化。" : "历史记录不足，部分变化尚不能判断。"}本次没有运行模型、重算、发布或重新授权。</p>
      <p>材料：原有 {count(view.sources.beforeCount)} 篇，当前规则选中 {view.sources.currentCount} 篇；新增 {count(view.sources.added)}、移出 {count(view.sources.removed)}、内容或元信息版本变化 {count(view.sources.changed)}、版本不可比 {count(view.sources.uncomparable)}。</p>
      {view.sources.reason && <p>{view.sources.reason}</p>}
      <ul><li>固定方法：{difference(view.methodChanged)}。</li><li>本期参数与默认问题：{difference(view.parametersChanged)}。</li><li>来源选择规则：{difference(view.sourceRuleChanged)}。</li><li>请求的模型配置：{difference(view.requestedModelChanged)}。实际服务端模型身份未知。</li></ul>
      {!view.methodCompatible && <p role="alert">{view.methodUnavailableReason || "当前方法与工具不兼容，请在原工作核对。"}</p>}
      <p>{view.baseline.methodUse?.loadedThisRun && view.baseline.methodUse.sentToRuntime ? "该轮有方法正文加载与发送记录；语义采用仍未由此证明。" : "旧记录没有本轮方法正文加载与发送的完整证明；选择方法不等于实际采用。"}</p>
      <details><summary>查看所比较的绑定与版本</summary><p>基线：{view.baseline.runId ? "已有运行 " + view.baseline.runId : "尚无对应运行，或旧绑定缺失"}；配置第 {view.baseline.configRevision ?? "未知"} 版 → 第 {view.topicRevision} 版。</p><p>原方法：{view.baseline.methodVersion || "未知"}<br />当前固定方法：{view.selectedMethod}</p><p>原请求模型：{view.previousRequestedModel ? codexSelectionLabel(view.previousRequestedModel) : "未保存"}<br />当前请求模型：{codexSelectionLabel(view.currentRequestedModel)}</p></details>
      <p className="agent-note">只核对本地缓存，未向远端确认；变化记录不直接解释报告数字为何改变。需要更新时回原工作核对范围与预算，再沿原数据校验、重算和发布流程处理，旧成果与用量保留。</p>
    </>}
  </section>;
}
