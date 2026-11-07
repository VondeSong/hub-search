type Grounded = { text: string; sourceRefs: string[] };
type Clause = Grounded & { itemId: string };
export type GoalRevision = {
  revision: number; state: "notInterpreted" | "current" | "needsRevision" | "historical";
  effectiveGoal: Grounded | null; constraints: Clause[]; acceptanceCriteria: Clause[];
  unresolvedAmbiguities: Clause[]; sourceRefs?: string[];
  sources: { requirementId: string; text: string }[];
  retirements?: { itemId: string; reason: string; sourceCommandId: string }[];
  history: { revision: number; rationale: string }[];
};
export function AgentGoalRevision({ value }: { value: GoalRevision }) {
  if (!value.revision || !value.effectiveGoal) return null;
  const items = (title: string, entries: Clause[]) => entries.length > 0 && <div><strong>{title}</strong><ul>{entries.map(item => <li key={item.itemId}>{item.text}</li>)}</ul></div>;
  return <section className="agent-progress" aria-label="当前目标理解">
    <p><strong>当前目标理解 · 第 {value.revision} 版</strong></p>
    {value.state === "needsRevision" && <p role="status">收到新的用户要求，当前解释待修订。</p>}
    <p>{value.effectiveGoal.text}</p>
    {items("约束", value.constraints)}
    {items("验收条件", value.acceptanceCriteria)}
    {items("待澄清", value.unresolvedAmbiguities)}
    <p className="agent-note">这是模型对用户指令的解释；原始要求和实际授权继续有效。</p>
    <details><summary>查看原始指令与修订依据</summary>
      <ul>{value.sources.filter(source => value.sourceRefs?.includes(source.requirementId)).map(source => <li key={source.requirementId}>{source.text}</li>)}</ul>
      {!!value.retirements?.length && <ul>{value.retirements.map(item => <li key={item.itemId}>{item.reason}<p>{value.sources.find(source => source.requirementId === item.sourceCommandId)?.text}</p></li>)}</ul>}
      <ol>{value.history.map(item => <li key={item.revision}>第 {item.revision} 版：{item.rationale}</li>)}</ol>
    </details>
  </section>;
}
