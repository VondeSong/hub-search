// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentConversation, type Conversation, type Report } from "./AgentDelivery";
import saved from "./AgentSavedReport.fixture.json";

let host: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host=document.createElement("div");document.body.append(host);root=createRoot(host); });
afterEach(async () => { await act(async () => root.unmount());host.remove(); });
const conversation = (): Conversation => ({ hasEarlier:false,messages:[{id:"saved-actual-C5-report",role:"assistant",createdAt:1,runId:saved.runId,report:structuredClone(saved.report) as Report,evidence:structuredClone(saved.evidence)}] });
const render = (value: Conversation, onOpenCitation=vi.fn(), recordVersion=1, revoked=false) => act(async () => root.render(<AgentConversation workId="saved-actual-work" conversation={value} recordVersion={recordVersion} revoked={revoked} onOpenCitation={onOpenCitation} />));

it("keeps the actual saved comparison table, citation nodes and keyboard focus across an unrelated status refresh", async () => {
  await render(conversation());
  const table=host.querySelector("table")!; const citation=host.querySelector<HTMLButtonElement>(".agent-inline-citation")!;
  expect(table.textContent).toContain("甲、乙、丙"); expect(citation).not.toBeNull(); citation.focus();
  const tables: Node[]=[]; const observer=new MutationObserver(records=>records.forEach(r=>r.addedNodes.forEach(n=>{if(n instanceof Element){if(n.matches("table"))tables.push(n);tables.push(...n.querySelectorAll("table"));}})));
  observer.observe(host,{subtree:true,childList:true});
  await render(conversation(),vi.fn(),2); observer.disconnect();
  expect(host.querySelector("table")).toBe(table);
  expect(host.querySelector(".agent-inline-citation")).toBe(citation);
  expect(document.activeElement).toBe(citation);
  expect(tables).toHaveLength(0);
});

it("uses the latest citation handler and eligibility even when the saved markdown is unchanged", async () => {
  const old=vi.fn(),latest=vi.fn(); await render(conversation(),old);
  await render(conversation(),latest,2);
  await act(async () => host.querySelector<HTMLButtonElement>(".agent-inline-citation")!.click());
  const ref=saved.report.prose!.citations[0];
  expect(old).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledWith(saved.runId,Number(ref.evidenceId.slice(1))-1,ref.quote);
  const denied=conversation();denied.messages[0].evidence=[];await render(denied,latest,3);
  expect([...host.querySelectorAll<HTMLButtonElement>(".agent-inline-citation")].every(b=>b.disabled)).toBe(true);
  await render(denied,latest,4,true); expect(host.textContent).toBe("");
});

it("updates changed saved prose while preserving table and citation behavior", async () => {
  await render(conversation());const changed=conversation();changed.messages[0].report!.prose!.markdown+="\n\n新要求的后续说明。";
  const latest=vi.fn();await render(changed,latest,2);
  expect(host.textContent).toContain("新要求的后续说明。"); expect(host.querySelector("table")?.textContent).toContain("5 次");
  await act(async () => host.querySelector<HTMLButtonElement>(".agent-inline-citation")!.click());expect(latest).toHaveBeenCalledTimes(1);
});

it("keeps only numbered source navigation and gates it on source availability",async()=>{
 const open=vi.fn();await render(conversation(),open);const ref=saved.report.prose!.citations[0];
 expect(host.querySelector('.agent-citation-book')).toBeNull();await act(async()=>host.querySelector<HTMLButtonElement>('.agent-inline-citation')!.click());expect(open).toHaveBeenLastCalledWith(saved.runId,Number(ref.evidenceId.slice(1))-1,ref.quote);
 const denied=conversation();denied.messages[0].evidence=[];await render(denied,open,2);expect([...host.querySelectorAll<HTMLButtonElement>('.agent-inline-citation')].every(button=>button.disabled)).toBe(true);
 await render(denied,open,3,true);expect(host.querySelector('.agent-citation-book')).toBeNull();
});

it("renders fenced code with its language and copies the exact code without rewriting array indexes as citations",async()=>{
  const value=conversation();
  const script="$scores = 58, 72, 91, 60, 45\n\n  $scores[1]";
  value.messages[0].report!.prose!.markdown="关联说明 [1]。行内代码 `$scores[1]`。\n\n```powershell\n"+script+"\n```";
  const writeText=vi.fn().mockResolvedValue(undefined);
  const clipboard=Object.getOwnPropertyDescriptor(navigator,"clipboard");
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
  try {
    await render(value);
    expect(host.querySelectorAll(".agent-inline-citation")).toHaveLength(1);
    expect(host.querySelector(".agent-report p code")?.textContent).toBe("$scores[1]");
    const block=host.querySelector(".agent-markdown-code")!;
    expect(block.querySelector(".agent-markdown-code-language")?.textContent).toBe("PowerShell");
    expect(block.querySelector("pre code")?.textContent).toBe(script+"\n");
    await act(async()=>block.querySelector<HTMLButtonElement>('button[aria-label="自动换行"]')!.click());
    expect(block.getAttribute("data-wrap")).toBe("true");
    await act(async()=>block.querySelector<HTMLButtonElement>('button[aria-label="复制代码"]')!.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(script+"\n");
  } finally {
    if(clipboard)Object.defineProperty(navigator,"clipboard",clipboard);
    else Reflect.deleteProperty(navigator,"clipboard");
  }
});
