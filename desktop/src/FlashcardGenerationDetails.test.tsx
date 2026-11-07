// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import { FlashcardGenerationDetails } from "./FlashcardGenerationDetails";
import { FlashcardQualityHistory } from "./FlashcardQualityHistory";
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.clearAllMocks(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("shows the stored rule version, exception reasoning and batch exclusions without reading today's rule", async () => {
  const generation = { qualityContext: { scope: { learningGoal: "理解原理，并明确要求记忆代号" }, ruleIds: ["rule"], ruleSnapshots: [{ id: "rule", title: "配置代号按需查阅", text: "Submitted rule", scopeType: "deck", scopeLabel: "Original deck", learningGoal: "理解原理", exceptions: "明确要求记忆时允许" }], ruleApplications: [{ ruleId: "rule", decision: "exception", reason: "本次明确要求记忆该代号" }], excludedTargets: [{ recallTarget: "另一个低价值目标", reason: "仅供查阅", sourceLocation: "说明二" }] } };
  await act(async () => root.render(<FlashcardGenerationDetails generation={generation} decks={[]}/>));
  expect(host.textContent).toContain("提交时保存的规则版本");
  expect(host.textContent).toContain("Submitted rule");
  expect(host.textContent).toContain("Original deck");
  expect(host.textContent).toContain("按例外处理");
  expect(host.textContent).toContain("本批次排除的目标");
  expect(host.textContent).toContain("仅供查阅");
  expect(invokeMock).not.toHaveBeenCalled();
});

it("labels old drafts as current references instead of inventing submission-time evidence", async () => {
  invokeMock.mockResolvedValue({ records: [{ kind: "rule", id: "rule", title: "Current rule", text: "Changed later", scopeType: "global" }] });
  await act(async () => root.render(<FlashcardGenerationDetails generation={{qualityContext:{ruleIds:["rule"]}}} decks={[]}/>));
  expect(invokeMock).not.toHaveBeenCalled();
  await act(async () => { const details = host.querySelector("details")!; details.open = true; details.dispatchEvent(new Event("toggle")); });
  expect(host.textContent).toContain("提交时正文未记录");
  expect(host.textContent).toContain("Changed later");
  expect(host.textContent).not.toContain("提交时保存的规则版本");
});

it("keeps manual and older imports usable without quality metadata", async () => {
  await act(async () => root.render(<FlashcardGenerationDetails generation={{source:"manual"}} decks={[]}/>));
  expect(host.textContent).toBe("");
  expect(invokeMock).not.toHaveBeenCalled();
});

it("keeps an alternative feedback version visible without treating it as current or automatically restoring it", async () => {
  const current = { id:"feedback", kind:"feedback", updatedAt:200, status:"resolved", excludeTarget:false, comment:"Current feedback", snapshot:{question:"Source-grounded question"} };
  const old = {...current,id:"old",kind:"history",recordKind:"feedback",recordId:"feedback",updatedAt:100,status:"open",excludeTarget:true,comment:"Other device's version"};
  const records = [current, old, {...old,id:"legacy-history"}, {...current,id:"same",kind:"history",recordKind:"feedback",recordId:"feedback"}, {id:"merge",kind:"history",historyType:"sync-merge",recordId:"feedback",updatedAt:200}];
  await act(async () => root.render(<FlashcardQualityHistory records={records}/>));
  expect(host.textContent).toContain("1 个旧版本");
  expect(host.textContent).toContain("Current feedback");
  expect(host.textContent).toContain("Other device's version");
  expect(host.textContent).toContain("避免重复生成");
  expect(host.textContent).toContain("不同版本也可能来自先后修改");
  expect(host.querySelector("button")).toBeNull();
  expect(invokeMock).not.toHaveBeenCalled();
});

it("shows the previous rule's scope and examples when those conditions were changed", async () => {
  const current = { id:"rule", kind:"rule", updatedAt:200, title:"Scoped rule", text:"Prefer principles", enabled:true, scopeType:"deck", scopeValue:"deck", learningGoal:"principles", positiveExample:"Design judgment" };
  const old = { ...current, id:"history", kind:"history", recordId:"rule", updatedAt:100, scopeType:"topic", scopeValue:"old topic", positiveExample:"Old supported example", exceptions:"Old exception" };
  await act(async () => root.render(<FlashcardQualityHistory records={[current,old]} decks={[{id:"deck",name:"Target deck"} as never]}/>));
  expect(host.textContent).toContain("适用范围：Target deck");
  expect(host.textContent).toContain("主题：old topic");
  expect(host.textContent).toContain("Old supported example");
  expect(host.textContent).toContain("Old exception");
});
