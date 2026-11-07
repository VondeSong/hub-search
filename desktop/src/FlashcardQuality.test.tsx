// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Flashcard } from "./FlashcardTypes";
const { invokeMock, saveMock }=vi.hoisted(()=>({invokeMock:vi.fn(),saveMock:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:invokeMock}));
vi.mock("@tauri-apps/plugin-dialog",()=>({save:saveMock}));
import { FlashcardQuality } from "./FlashcardQuality";
let host:HTMLDivElement,root:Root;
const card={id:"card",deckId:"deck",question:"Configuration value?",answer:"42",explanation:"",media:[]} as unknown as Flashcard;
const saved=vi.fn(),changed=vi.fn().mockResolvedValue(undefined),closed=vi.fn();
const button=(label:string)=>{const b=Array.from(host.querySelectorAll("button")).find(b=>b.textContent===label);if(!b)throw Error(label);return b;};
beforeEach(()=>{vi.clearAllMocks();Object.defineProperty(HTMLDialogElement.prototype,"showModal",{configurable:true,value(){this.setAttribute("open","");}});host=document.createElement("div");document.body.append(host);root=createRoot(host);invokeMock.mockResolvedValue({records:[],document:"",revision:"r"});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete document.documentElement.dataset.runtimePlatform;});
it("records and pauses separately from review ratings",async()=>{
  await act(async()=>root.render(<FlashcardQuality target={{card,draft:false}} decks={[]} onSaved={saved} onChanged={changed} onClose={closed} onOpenCard={()=>{}}/>));
  await act(async()=>button("记录并暂停此卡").click());
  expect(invokeMock).toHaveBeenCalledWith("submit_flashcard_feedback",{input:expect.objectContaining({cardId:"card",action:"pause",draft:false})});
  expect(saved).toHaveBeenCalledWith("pause",{card,draft:false});expect(closed).toHaveBeenCalledOnce();
  expect(invokeMock.mock.calls.some(([name])=>String(name).includes("review_flashcard"))).toBe(false);
});
it("shows both versions and requires explicit acceptance with a schedule choice",async()=>{
  invokeMock.mockImplementation(async(name:string)=>name==="get_flashcard_quality"?{records:[{id:"p",kind:"proposal",type:"rewrite",updatedAt:123,status:"pending",reason:"Learn principle",before:{question:"Old question",answer:"Old answer"},after:{question:"New question",answer:"New answer"}}],document:"",revision:"r"}:{resultCardId:"new-card"});
  await act(async()=>root.render(<FlashcardQuality decks={[]} onSaved={saved} onChanged={changed} onClose={closed} onOpenCard={()=>{}}/>));
  await act(async()=>button("AI 改进").click());
  expect(host.textContent).toContain("Old question");expect(host.textContent).toContain("New question");
  expect(invokeMock.mock.calls.some(([name])=>name==="resolve_flashcard_quality_proposal")).toBe(false);
  await act(async()=>button("接受建议").click());
  expect(invokeMock).toHaveBeenCalledWith("resolve_flashcard_quality_proposal",{id:"p",expectedUpdatedAt:123,accept:true,schedule:"new"});expect(changed).toHaveBeenCalledWith("new-card");
});
it("surfaces stale proposal errors without claiming acceptance",async()=>{
  invokeMock.mockImplementation(async(name:string)=>{if(name==="resolve_flashcard_quality_proposal")throw Error("原卡片已被编辑");return {records:[{id:"p",kind:"proposal",type:"rule",updatedAt:123,status:"pending",rule:{text:"Prefer principles",scopeType:"global"}}],document:"",revision:"r"};});
  await act(async()=>root.render(<FlashcardQuality decks={[]} onSaved={saved} onChanged={changed} onClose={closed} onOpenCard={()=>{}}/>));await act(async()=>button("AI 改进").click());await act(async()=>button("接受建议").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("原卡片已被编辑");expect(changed).not.toHaveBeenCalled();
});

it("shows cloud status, last success and permits retry",async()=>{
  invokeMock.mockImplementation(async(name:string)=>name==="get_flashcard_quality"?{records:[],document:"",revision:"r",sync:{enabled:true,pending:false,error:"",lastSuccess:1700000000}}:{state:"synced"});
  await act(async()=>root.render(<FlashcardQuality decks={[]} onSaved={saved} onChanged={changed} onClose={closed} onOpenCard={()=>{}}/>));
  expect(host.textContent).toContain("已同步至云端，其他设备将在同步后收到");
  expect(host.textContent).toContain("上次成功");
  invokeMock.mockClear();
  await act(async()=>button("立即同步").click());
  expect(invokeMock).toHaveBeenCalledWith("sync_flashcards");
});
it("refreshes local quality state without starting periodic cloud transfers",async()=>{
  vi.useFakeTimers();
  try {
    invokeMock.mockResolvedValue({records:[],document:"",revision:"r",sync:{enabled:true,pending:false,error:"",lastSuccess:1}});
    await act(async()=>root.render(<FlashcardQuality decks={[]} onSaved={saved} onChanged={changed} onClose={closed} onOpenCard={()=>{}}/>));
    await act(async()=>{await vi.advanceTimersByTimeAsync(120000);});
    expect(invokeMock.mock.calls.some(([name])=>name==="sync_flashcard_quality_if_enabled"||name==="sync_flashcards")).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("get_flashcard_quality");
  } finally { vi.useRealTimers(); }
});
it("shows the learning goal before accepting a rule",async()=>{
  invokeMock.mockResolvedValue({records:[{id:"p",kind:"proposal",type:"rule",updatedAt:1,status:"pending",rule:{text:"Prefer principles",scopeType:"global",learningGoal:"理解原理"}}],document:"",revision:"r"});
  await act(async()=>root.render(<FlashcardQuality decks={[]} onSaved={saved} onChanged={changed} onClose={closed} onOpenCard={()=>{}}/>));
  await act(async()=>button("AI 改进").click());
  expect(host.textContent).toContain("学习目标：理解原理");
});
it("starts Android's durable native export without claiming the document is already saved",async()=>{
  document.documentElement.dataset.runtimePlatform="android";
  await act(async()=>root.render(<FlashcardQuality decks={[]} onSaved={saved} onChanged={changed} onClose={closed} onOpenCard={()=>{}}/>));
  await act(async()=>button("质量文档").click());
  await act(async()=>button("导出文档").click());
  expect(invokeMock).toHaveBeenCalledWith("export_flashcard_quality",{destination:""});
  expect(saveMock).not.toHaveBeenCalled();
  expect(host.textContent).toContain("请在系统对话框中完成保存");
  expect(host.textContent).not.toContain("质量文档已导出");
});
it("keeps desktop export waiting for the chosen file and the completed write",async()=>{
  document.documentElement.dataset.runtimePlatform="windows";
  saveMock.mockResolvedValue("D:/exports/quality.md");
  await act(async()=>root.render(<FlashcardQuality decks={[]} onSaved={saved} onChanged={changed} onClose={closed} onOpenCard={()=>{}}/>));
  await act(async()=>button("质量文档").click());
  await act(async()=>button("导出文档").click());
  expect(saveMock).toHaveBeenCalledOnce();
  expect(invokeMock).toHaveBeenCalledWith("export_flashcard_quality",{destination:"D:/exports/quality.md"});
  expect(host.textContent).toContain("质量文档已导出");
});
