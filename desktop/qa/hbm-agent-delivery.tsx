import { createRoot } from "react-dom/client";
import { AgentDelivery } from "../src/AgentDelivery";
import "../src/App.css";
import "../src/AgentInvestigation.css";

const params = new URLSearchParams(location.search);
const scenario = ["related", "empty", "conflict"].includes(params.get("case") ?? "") ? params.get("case")! : "related";
const state = params.get("state") ?? "actual";
const root = createRoot(document.getElementById("root")!);
fetch(`/.local/hbm-20261018/quick-${scenario}.json`).then(response => {
  if (!response.ok) throw new Error("真实模型验收报告尚未生成");
  return response.json();
}).then(receipt => {
  const view = receipt.view;
  const simulated = state !== "actual";
  root.render(<main style={{ maxWidth: 650, margin: "24px auto", padding: "0 14px" }}>
    <p>HBM-01A 呈现检查 · {scenario} · 原运行 {receipt.durationMs} 毫秒</p>
    {simulated && <p role="note">此处模拟“{state === "revoked" ? "撤回授权" : "终轮中断"}”状态，仅核对呈现；材料来自同一真实模型运行。</p>}
    <section className="agent-investigation"><div className="agent-body">
      <p className="agent-goal">{view.work.goal}</p>
      <AgentDelivery report={simulated ? null : view.work.report} evidence={view.evidence} progress={view.progress} history={view.history} running={false} revoked={state === "revoked" || view.work.state === "revoked"} />
    </div></section>
  </main>);
}).catch(error => root.render(<p role="alert">{String(error.message)}</p>));
