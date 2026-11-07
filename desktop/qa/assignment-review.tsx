import { createRoot } from "react-dom/client";
import { TagAssignmentInbox } from "../src/TagAssignmentInbox";
import { useState } from "react";
import type { SearchResult } from "../src/SearchTypes";
const sourceInfo = { available: true, entityId: "obsidian:lib:sample", provider: "obsidian", libraryId: "lib", libraryName: "Main", documentId: "sample", title: "项目复盘：从想法到实际成果", path: "工作/项目复盘.md" };
const craftSource = { ...sourceInfo, entityId: "craft:craft:doc:child", provider: "craft", libraryId: "craft", documentId: "doc", pageId: "child", blockId: "child", path: "项目 / 2026 / 复盘" };
let status = "pending";
const definition = { description: "通过行动产生了可核对的实际成果。", include: "已完成的项目、交付物和实际进展", exclude: "尚未执行的愿望和计划", libraryIds: ["lib"] };
const proposal = { proposalId: "sample", tag: "成果", version: 1, proposal: { title: "项目复盘：从想法到实际成果", decision: "recommend_add", quote: "本周完成了第一版原型，并收到了三位用户的反馈。", rationale: "已有完成的交付物和具体反馈，符合成果的纳入条件。", risks: "", confidence: .9, definitionVersion: 1, definition } };
(window as any).__TAURI_INTERNALS__ = { invoke: async (_: string, { args }: any) => {
  switch (args.action) {
    case "definition_models": return { models: [] };
    case "definition": return { definition: { version: 1, definition }, libraries: [{ libraryId: "lib", name: "Main", provider: "obsidian" }] };
    case "discovery_status": return { counts: { retrievedHits: 42, returnedCandidates: 30 }, readEntities: 5, processedCount: 5, remainingCount: 25, charsRead: 6000, libraryIds: ["lib"], queries: ["成果"], submitted: [{ proposalId: "sample", title: proposal.proposal.title, decision: "recommend_add", preview: { stale: false, reviewBlocked: false, reviewBlockers: [] } }], unjudged: [], coverage: "本次检查仅覆盖候选内容。" };
    case "list": return { proposals: args.status === status ? [{ ...proposal, status, sourceInfo }, { ...proposal, proposalId: "sample-craft", status, sourceInfo: craftSource }] : [], nextCursor: null };
    case "preview": return { reviewToken: "mock", stale: false, reviewBlocked: false, reviewBlockers: [], evidence: args.proposalId === "sample-craft" ? craftSource : sourceInfo };
    case "resolve": status = args.resolution === "accept" ? "accepted" : args.resolution === "withdraw" ? "withdrawn" : "rejected"; return { internalTagsChanged: true };
    case "exclusion_review_due": return { count: 0, hasMore: false, asOf: 1 };
    case "source_writeback_list": return { items: [{ id: "note", title: proposal.proposal.title, path: "工作/项目复盘.md", libraryName: "Main", provider: "obsidian", pageId: "sample", addTag: "成果", removeTag: "" }], total: 1, nextOffset: null };
    default: throw Error("示例页未实现此操作");
  }
} };
function QA() {
  const [opened, setOpened] = useState<SearchResult | null>(null);
  return <main><h1>补标建议的审核与写回</h1><p>示例数据 · 这里的操作仅改变示例状态，不会修改真实笔记。</p>{opened && <section role="status"><strong>已打开：{opened.title}</strong><p>{opened.provider} · {opened.libraryName} · {opened.path}</p><p>{proposal.proposal.quote}</p><button onClick={() => setOpened(null)}>关闭示例预览</button></section>}<TagAssignmentInbox tagId="成果" onOpenEvidence={setOpened} /></main>;
}
createRoot(document.getElementById("root")!).render(<QA />);
