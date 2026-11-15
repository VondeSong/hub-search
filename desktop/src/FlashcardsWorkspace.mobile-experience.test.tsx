// @vitest-environment jsdom
import {act,useEffect} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import type {Flashcard,FlashcardDashboardStats} from "./FlashcardTypes";
import {flashcardPageFixture,flashcardReviewPlanFixture} from "./FlashcardQuery.fixture";
const {invokeMock}=vi.hoisted(()=>({invokeMock:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:invokeMock}));
import {FlashcardsWorkspace} from "./FlashcardsWorkspace";
import {useFlashcardReviewSession} from "./FlashcardReviewSession";
function ResetSession(){const {session}=useFlashcardReviewSession();useEffect(()=>{session.discard();},[session]);return null;}
const card:Flashcard={id:"mobile-card",deckId:"mobile-deck",question:"A real transport fixture",answer:"Answer",explanation:"",cardType:"qa",cardData:{},sourceLibraryId:"",sourceDocumentId:"",sourceBlockId:"",sourceTitle:"",sourcePath:"",sourceHash:"",media:[],tags:[],evidence:"",customFields:{},generation:{},createdAt:1,updatedAt:1,dueAt:1,intervalDays:0,ease:2.5,repetitions:0,lapses:0,sourceChanged:false};
let host:HTMLDivElement,root:Root,stats:FlashcardDashboardStats,available:Flashcard[];
const notices=vi.fn();
const find=(label:string)=>Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button=>button.textContent?.trim()===label || button.getAttribute("aria-label")===label)!;
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});};
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;document.documentElement.dataset.runtimePlatform="android";
  localStorage.clear();sessionStorage.clear();vi.clearAllMocks();available=[{...card}];
  stats={totalCards:1,dueCards:1,newDueCards:1,newCards:1,learningCards:0,masteredCards:0,newStudiedToday:5,totalReviews:5,reviewedToday:5,retentionRate:1,ratingCounts:[0,0,5,0],dailyActivity:[],studyDay:"2026-11-15",extraNewAllowance:0,timedReviewCount:5,averageReviewMs:20000,futureDue:[]};
  invokeMock.mockImplementation(async(command:string,args?:Record<string,unknown>)=>{
    if(command==="list_flashcard_decks")return [{id:"mobile-deck",name:"Mobile deck",cardCount:1,dueCount:1,newCount:1,updatedAt:1}];
    if(command==="list_flashcard_deck_folders"||command==="list_flashcard_drafts")return [];
    if(command==="get_flashcard_dashboard_stats")return {...stats};
    if(command==="get_flashcard_study_settings")return {dailyNewLimit:5,updatedAt:1};
    if(command==="get_flashcard_sync_settings")return {configured:false,autoSync:false};
    if(command==="list_flashcards_page")return flashcardPageFixture(available,args);
    if(command==="flashcard_review_plan")return flashcardReviewPlanFixture(available,args,5+(stats.extraNewAllowance??0),5);
    if(command==="get_flashcards_by_ids")return available.filter(c=>(args?.cardIds as string[]).includes(c.id));
    if(command==="update_flashcard_study_settings"){stats={...stats,extraNewAllowance:Number(args?.extraNewCount)};return {dailyNewLimit:5,updatedAt:1};}
    if(command==="set_flashcard_stage"){available=available.map(c=>({...c,status:"suspended"}));return available[0];}
    throw new Error(`Unhandled native command: ${command}`);
  });
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.render(<ResetSession/>));await act(async()=>root.unmount());host.remove();localStorage.clear();sessionStorage.clear();delete document.documentElement.dataset.runtimePlatform;delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
const render=async()=>{await act(async()=>root.render(<FlashcardsWorkspace onClose={()=>undefined} onStatusMessage={notices}/>));await settle();};
it("grants through the native guard without changing preferences or submitting a rating",async()=>{
  await render();const add=find("今日临时增加 1 张新卡额度");expect(add.disabled).toBe(false);
  await act(async()=>add.click());await settle();
  expect(invokeMock).toHaveBeenCalledWith("update_flashcard_study_settings",{dailyNewLimit:5,extraNewCount:1,extraNewDay:"2026-11-15"});
  expect(stats.extraNewAllowance).toBe(1);expect(host.querySelector('.flashcards-review-card')?.textContent).toContain(card.question);
  expect(invokeMock.mock.calls.some(([command])=>command==="review_flashcard")).toBe(false);
});
it("does not claim extra quota works with an older native backend",async()=>{
  delete stats.extraNewAllowance;delete stats.studyDay;
  await render();expect(find("今日临时增加 1 张新卡额度").disabled).toBe(true);
  expect(host.textContent).toContain("更新安卓原生程序");
});
it("retains the native grant error and leaves preferences and card data intact",async()=>{
  const original=invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((command,args)=>command==="update_flashcard_study_settings"?Promise.reject(new Error("write failed")):original(command,args));
  await render();await act(async()=>find("今日临时增加 1 张新卡额度").click());await settle();
  expect(notices).toHaveBeenCalledWith(expect.stringContaining("write failed"),"error",8000);expect(stats.extraNewAllowance).toBe(0);expect(available[0].status).toBeUndefined();
  expect(invokeMock.mock.calls.filter(([command])=>command==="get_flashcard_dashboard_stats").length).toBeGreaterThan(1);
});
it("starts a chosen deck and pauses its card without submitting a review",async()=>{
  available=[{...card,repetitions:1}];stats.newDueCards=0;stats.newCards=0;
  await render();await act(async()=>find("牌库").click());await settle();
  await act(async()=>find("开始复习 Mobile deck").click());await settle();
  expect(invokeMock).toHaveBeenCalledWith("flashcard_review_plan",expect.objectContaining({deckId:"mobile-deck"}));
  expect(host.textContent).toContain("暂停此卡");
  await act(async()=>find("暂停此卡").click());await settle();
  expect(invokeMock).toHaveBeenCalledWith("set_flashcard_stage",{cardId:card.id,stage:"suspended"});
  expect(invokeMock.mock.calls.some(([command])=>command==="review_flashcard")).toBe(false);
});

it("does not misreport a committed grant as a failed write when later statistics fail",async()=>{
  await render();const original=invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((command,args)=>command==="get_flashcard_dashboard_stats"?Promise.reject(new Error("stats unavailable")):original(command,args));
  await act(async()=>find("今日临时增加 1 张新卡额度").click());await settle();
  expect(stats.extraNewAllowance).toBe(1);
  expect(notices).toHaveBeenCalledWith(expect.stringContaining("临时额度已保存，但复习或统计刷新失败"),"error",8000);
});

it("does not offer another deck's waiting new cards when the selected deck is empty",async()=>{
  available=[];stats.newDueCards=8;
  await render();await act(async()=>find("牌库").click());await settle();
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-deck-drop-before="mobile-deck"]')!.click());await settle();
  expect(host.querySelector('.flashcards-session-actions')?.textContent).not.toContain("再学");
  expect(invokeMock.mock.calls.some(([command])=>command==="update_flashcard_study_settings")).toBe(false);
});

it("does not start a round in the background after leaving while a grant is pending",async()=>{
  await render();const original=invokeMock.getMockImplementation()!;let finish!:(value:unknown)=>void;
  const before=invokeMock.mock.calls.filter(([command])=>command==="get_flashcards_by_ids").length;
  invokeMock.mockImplementation((command,args)=>command==="update_flashcard_study_settings"?new Promise(resolve=>{finish=()=>{void Promise.resolve(original(command,args)).then(resolve);};}):original(command,args));
  await act(async()=>find("今日临时增加 1 张新卡额度").click());
  await act(async()=>find("牌库").click());await settle();
  await act(async()=>{finish(null);await Promise.resolve();});await settle();
  expect(stats.extraNewAllowance).toBe(1);expect(host.querySelector('.mobile-page-library')).not.toBeNull();
  expect(invokeMock.mock.calls.filter(([command])=>command==="get_flashcards_by_ids").length).toBe(before);
  expect(host.querySelector('.is-reviewing')).toBeNull();
});
