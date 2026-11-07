import type { Conversation, Report } from "./AgentDelivery";

/**
 * Hand-authored, deterministic unit-test data for conversation rendering.
 * This is not a recording of a provider run and does not reconstruct the
 * untracked agent-live-dialogue-20261104 acceptance artifact.
 *
 * The first two plain-text answers became stale only because the user followed
 * up. Tests separately apply source withdrawal, source changes and chart
 * dependencies to verify that those stricter display rules remain intact.
 */
const followedUp = "用户要求已更新；新增或纠正的要求需要重新核对，旧回答仅供历史查阅。";
const start = Date.UTC(2026, 10, 4, 0, 0);

function answer(markdown: string): Report {
  return {
    status: "completed",
    summary: markdown,
    findings: [],
    nextSteps: [],
    questions: [],
    limitations: [],
    waitCondition: "",
    prose: { markdown, citations: [] },
  };
}

const fixture: Conversation = {
  hasEarlier: false,
  nextCursor: null,
  messages: [
    {
      id: "synthetic-user-1", role: "user", kind: "request", revision: 1,
      createdAt: start,
      text: "比较合成测试方案，并说明是否满足条件。",
    },
    {
      id: "synthetic-answer-1", role: "assistant", revision: 1,
      runId: "synthetic-run-1", createdAt: start + 10_000,
      artifactState: "stale", artifactRefs: [], validity: followedUp,
      report: answer("目前没有合适方案。合成测试方案 A 尚未满足全部条件。"),
      evidence: [],
    },
    {
      id: "synthetic-user-2", role: "user", kind: "request", revision: 2,
      createdAt: start + 20_000,
      text: "补充条件：至少质保3年。",
    },
    {
      id: "synthetic-answer-2", role: "assistant", revision: 2,
      runId: "synthetic-run-2", createdAt: start + 30_000,
      artifactState: "stale", artifactRefs: [], validity: followedUp,
      report: answer("本轮新增：按质保3年的条件重新核对。合成测试方案 A 仍需补充报价。"),
      evidence: [],
    },
    {
      id: "synthetic-user-3", role: "user", kind: "request", revision: 3,
      createdAt: start + 40_000,
      text: "保留原判断，列出还需要核对的内容。",
    },
    {
      id: "synthetic-answer-3", role: "assistant", revision: 3,
      runId: "synthetic-run-3", createdAt: start + 50_000,
      artifactState: "current", artifactRefs: [], validity: "",
      report: answer("需要核对合成报价的质保条款后再选择方案。"),
      evidence: [],
    },
  ],
};

export default fixture;
