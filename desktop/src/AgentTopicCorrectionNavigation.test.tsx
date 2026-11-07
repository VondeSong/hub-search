// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentInvestigation } from "./AgentInvestigation";
import type { SearchResult } from "./SearchTypes";
const { invoke, choice } = vi.hoisted(() => ({ invoke: vi.fn(), choice: { documentId: "other" } }));
vi.mock("./CodexSuite",async importOriginal=>({...await importOriginal<object>(),loadCodexSuiteModels:vi.fn(async()=>[]),cachedCodexSuiteModels:()=>[],useCodexSuite:()=>({loaded:true,loading:false,settings:{model:"fixture-model",provider:"codex",reasoningEffort:"medium",fast:false,maxConcurrent:2}})}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, ...args: unknown[]) => command === "list_libraries" ? Promise.resolve([]) : invoke(command, ...args) }));
vi.mock("./WindowVisibility", () => ({ useDocumentVisible: () => true }));
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: { desktop: true, localVault: true } }));
vi.mock("./AgentTopics", () => ({ AgentTopics: ({ onOpenWork }: { onOpenWork: (id: string, source: unknown, draft?: string) => Promise<void> }) => <button type="button" onClick={() => void onOpenWork("saved-work", { anchor: { kind: "note", libraryId: "notes", documentId: choice.documentId, pageId: null }, title: "实际笔记", path: "daily/note.md", libraryName: "隔离" }, "请核对保存数据第2版 row-one。我的纠正：")}>进入原工作填写纠正</button> }));
const result: SearchResult = { id: "hit", entityKey: "page:notes:source", provider: "obsidian", libraryId: "notes", libraryName: "隔离", spaceId: "notes", spaceName: "隔离", documentId: "source", contentType: "markdown", sourceType: "note", title: "原笔记", path: "Draft.md", snippet: "", matchTerms: [], matchField: "", matchCount: 0, subMatches: [] };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
 Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); choice.documentId = "other";
 invoke.mockReset().mockImplementation(async (_command, { args }) => args.action === "list" ? { works: [] } : { work: { id: args.id, goal: "保存工作", revision: 2, authorizationVersion: 1, anchor: { kind: "note", libraryId: "notes", documentId: choice.documentId, pageId: null }, state: "ready", report: null, grant: { libraryIds: [], notes: [] } }, decisions: [], evidence: [], run: null, validity: "" });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
it.each(["source", "other"])("prefills an editable correction on the same saved Work for note %s without submission", async note => {
 choice.documentId = note; await act(async () => root.render(<AgentInvestigation result={result} />));
 await act(async () => [...document.body.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === "调查这篇笔记")!.click());
 await act(async () => [...document.body.querySelectorAll("button")].find(b => b.textContent === "进入原工作填写纠正")!.click());
 const input = document.body.querySelector<HTMLTextAreaElement>('[name="investigationGoal"]')!;
 expect(input.value).toContain("第2版 row-one"); expect(input.value).toContain("我的纠正："); expect(document.activeElement).toBe(input);
 expect(invoke.mock.calls.some(([, v]) => v.args.action === "status" && v.args.id === "saved-work")).toBe(true);
 expect(invoke.mock.calls.every(([, v]) => ["list", "status"].includes(v.args.action))).toBe(true);
 if (note === "other") expect(document.body.textContent).toContain("正在讨论「实际笔记」");
});
