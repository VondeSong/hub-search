export type GoalAssessment = {
  workFulfillment: "fulfilled" | "partial" | "blocked" | "cancelled";
  reason?: string;
  semanticStatusSource?: string;
  completionEvidence: { requirementId: string; criterion: string; status: string; explanation: string }[];
};

const labels = { fulfilled: "目标已完成", partial: "目标尚未全部完成", blocked: "目标受阻", cancelled: "目标已取消" };
const itemLabels: Record<string, string> = { satisfied: "已满足", unfulfilled: "未完成", blocked: "受阻", notApplicable: "已被后续要求替代" };

export function AgentGoalAssessment({ value, answered = false }: { value: GoalAssessment; answered?: boolean }) {
  const unreviewed = value.workFulfillment === "partial" && value.semanticStatusSource === "notProvided";
  return <section className="agent-progress" aria-label="目标完成核对">
    <p><strong>{unreviewed ? answered ? "已回答" : "目标待核对" : labels[value.workFulfillment]}</strong>{!unreviewed && value.reason && ` · ${value.reason}`}</p>
    {!!value.completionEvidence.length && <details><summary>查看逐项核对</summary>
      <ul>{value.completionEvidence.map((item, index) => <li key={`${item.requirementId}-${index}`}>
        <strong>{unreviewed && item.status === "unfulfilled" ? "待核对" : itemLabels[item.status] || "待核对"}：{item.criterion}</strong><p>{item.explanation}</p>
      </li>)}</ul>
      <p className="agent-note">{value.semanticStatusSource === "modelRequirementReview" ? "系统已核对要求覆盖与实际成果证据；内容是否符合要求由模型逐项评估，仍可继续纠正。" : "未提供逐项核对；这不表示回答失败，也不代表所有操作已经完成。"}</p>
    </details>}
  </section>;
}
