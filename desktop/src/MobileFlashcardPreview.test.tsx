// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {MobileFlashcardPreview} from "./MobileFlashcardPreview";
import {FlashcardTodayProgress} from "./FlashcardTodayProgress";
import type {FlashcardDashboardStats} from "./FlashcardTypes";
const {plan,cards}=vi.hoisted(()=>({plan:vi.fn(),cards:vi.fn()}));
vi.mock("./FlashcardQueries",()=>({loadFlashcardReviewPlan:plan,loadFlashcardsByIds:cards}));
let host:HTMLDivElement,root:Root;
const button=(label:string)=>Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent===label)!;
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
  plan.mockResolvedValue({sessionIds:["a","b"]});cards.mockResolvedValue([{id:"a",question:"First",answer:"Hidden A",cardType:"qa"},{id:"b",question:"Second",answer:"Hidden B",cardType:"qa"}]);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
it("fetches only the requested native preview and hides every new card answer without rating",async()=>{
  await act(async()=>root.render(<MobileFlashcardPreview disabled={false}/>));
  expect(plan).not.toHaveBeenCalled();
  await act(async()=>button("卡片堆预览").click());
  expect(plan).toHaveBeenCalledWith(null,5);expect(cards).toHaveBeenCalledWith(["a","b"]);
  expect(host.textContent).toContain("First");expect(host.textContent).not.toContain("Hidden A");
  await act(async()=>button("揭晓答案").click());expect(host.textContent).toContain("Hidden A");
  await act(async()=>button("下一张").click());expect(host.textContent).toContain("Second");expect(host.textContent).not.toContain("Hidden B");
  await act(async()=>button("关闭").click());expect(host.querySelector("dialog")).toBeNull();
});
it("keeps a failed native read visible and allows retry",async()=>{
  plan.mockRejectedValueOnce(new Error("offline"));
  await act(async()=>root.render(<MobileFlashcardPreview disabled={false}/>));
  await act(async()=>button("卡片堆预览").click());expect(host.querySelector('[role="alert"]')?.textContent).toContain("offline");
  await act(async()=>button("卡片堆预览").click());expect(host.querySelector("dialog")?.open).toBe(true);
});
it("renders exact rhythm counts and date details while keeping sparse timings explicit",async()=>{
  const stats:FlashcardDashboardStats={totalCards:3,dueCards:3,newCards:0,learningCards:3,masteredCards:0,totalReviews:321,reviewedToday:320,retentionRate:0,ratingCounts:[0,0,0,0],studyDay:"2026-11-15",dailyActivity:[{date:"2026-11-14",count:1},{date:"2026-11-15",count:320}],futureDue:[{date:"2026-11-16",count:2}],timedReviewCount:4,averageReviewMs:10000};
  await act(async()=>root.render(<FlashcardTodayProgress stats={stats} dailyNewLimit={5} mobile onOpenStats={()=>undefined}/>));
  expect(host.textContent).toContain("不预测未学新卡");
  const day=host.querySelector<HTMLButtonElement>('button[aria-label="2026-11-15，复习 320 次，查看明细"]')!;
  await act(async()=>day.click());expect(host.querySelector('[role="status"]')?.textContent).toContain("320 次复习");
  expect(host.querySelectorAll('.flashcard-study-forecast li')).toHaveLength(7);
});
