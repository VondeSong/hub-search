// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import type {FlashcardDeckSummary} from "./FlashcardTypes";
const {invokeMock}=vi.hoisted(()=>({invokeMock:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:invokeMock}));
import {FlashcardsWorkspace} from "./FlashcardsWorkspace";
let host:HTMLDivElement,root:Root,decks:FlashcardDeckSummary[];
const settle=()=>act(async()=>{await Promise.resolve();await Promise.resolve();});
const base=(id:string,name:string,parentDeckId=""):FlashcardDeckSummary=>({id,name,parentDeckId,folderId:"",cardCount:0,dueCount:0,newCount:0,updatedAt:1});
beforeEach(()=>{
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();sessionStorage.clear();invokeMock.mockReset();
  decks=[base("parent","Parent"),base("child","Child","parent"),base("other","Other")];
  invokeMock.mockImplementation(async(command:string,args:any)=>{
    if(command==="list_flashcard_decks")return decks;
    if(command==="list_flashcard_deck_folders"||command==="list_flashcard_drafts")return [];
    if(command==="get_flashcard_dashboard_stats")return {totalCards:0,dueCards:0,newCards:0,newDueCards:0,newStudiedToday:0,totalReviews:0,reviewedToday:0,retentionRate:0,ratingCounts:[0,0,0,0],dailyActivity:[]};
    if(command==="get_flashcard_study_settings")return {dailyNewLimit:0};
    if(command==="get_flashcard_sync_settings")return {configured:false,autoSync:false,lastError:""};
    if(command==="list_flashcards_page")return {items:[],total:0,matchedTotal:0,scopeTotal:0,revision:"1",asOf:100,tags:[],customFieldKeys:[],stageCounts:{new:0,due:0,learning:0,mastered:0,suspended:0}};
    if(command==="flashcard_review_plan")return {sessionIds:[],eligibleCount:0,newAvailable:0,newWaiting:0,revision:"1",asOf:100};
    if(command==="create_flashcard_subdeck"){decks=[...decks,base("new-child",args.name,args.parentDeckId)];return "new-child";}
    if(command==="set_flashcard_deck_parent"){decks=decks.map(deck=>deck.id===args.deckId?{...deck,parentDeckId:args.parentDeckId??""}:deck);return;}
    throw new Error(command);
  });
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();localStorage.clear();sessionStorage.clear();delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
async function open(){await act(async()=>root.render(<FlashcardsWorkspace onClose={()=>{}}/>));await settle();}
async function click(selector:string){await act(async()=>host.querySelector<HTMLButtonElement>(selector)!.click());await settle();}
async function input(selector:string,value:string){await act(async()=>{const el=host.querySelector<HTMLInputElement>(selector)!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(el,value);el.dispatchEvent(new Event("input",{bubbles:true}));});}
it("creates a child through the visible menu and selects the returned deck",async()=>{
  await open();await click('[aria-label="牌组操作：Parent"]');
  const create=[...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button=>button.textContent?.includes("新建子牌组"))!;
  await act(async()=>create.click());await input('[aria-label="牌组名称"]',"New child");await click('[aria-label="创建牌组"]');
  expect(invokeMock).toHaveBeenCalledWith("create_flashcard_subdeck",{name:"New child",parentDeckId:"parent"});
  expect(host.querySelector('[data-deck-drop-before="new-child"]')?.getAttribute("aria-current")).toBe("page");
});
it("excludes the current deck and descendants from parent choices and submits a valid move",async()=>{
  await open();await click('[aria-label="牌组操作：Parent"]');
  const select=host.querySelector<HTMLSelectElement>('[aria-label="移动到父牌组"]')!;
  expect([...select.options].map(option=>option.value)).toEqual(["","other"]);
  await act(async()=>{select.value="other";select.dispatchEvent(new Event("change",{bubbles:true}));});await settle();
  expect(invokeMock).toHaveBeenCalledWith("set_flashcard_deck_parent",{deckId:"parent",parentDeckId:"other"});
});
it("persists one descendant switch and passes it to both browser and review producers",async()=>{
  await open();await click('[data-deck-drop-before="parent"]');await click('[aria-label="卡片配置"]');
  const toggle=[...host.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent?.includes("包含子牌组"))!;
  await act(async()=>toggle.click());await settle();
  expect(invokeMock.mock.calls.filter(([command])=>command==="list_flashcards_page").slice(-1)[0][1].query.includeSubdecks).toBe(true);
  expect(invokeMock.mock.calls.filter(([command])=>command==="flashcard_review_plan").slice(-1)[0][1].includeSubdecks).toBe(true);
  expect(JSON.parse(localStorage.getItem("hub.flashcards.saved-deck-views-v1")!).parent[0].showSubdecks).toBe(true);
});
it("shows the same descendant scope in the header without fetching extra card bodies",async()=>{
  decks=[{...base("parent","Parent"),cardCount:1,dueCount:1,newCount:1},
    {...base("child","Child","parent"),cardCount:1201,dueCount:1200,newCount:1200,suspendedCount:1},
    {...base("grandchild","Grandchild","child"),cardCount:1,dueCount:1,newCount:1},
    {...base("other","Other"),cardCount:999,dueCount:999,newCount:999}];
  await open();await click('[data-deck-drop-before="parent"]');
  expect(host.querySelector('.flashcards-overview')?.textContent).toContain("1 张卡片");
  await click('[aria-label="卡片配置"]');
  const toggle=[...host.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent?.includes("包含子牌组"))!;
  await act(async()=>toggle.click());await settle();
  const summary=host.querySelector('.flashcards-overview')?.textContent;
  expect(summary).toContain("1203 张卡片");expect(summary).toContain("1202 张已到期");
  expect(summary).toContain("1202 张新卡片");expect(summary).toContain("1 张已暂停");
  expect(invokeMock.mock.calls.some(([command])=>command==="get_flashcards_by_ids")).toBe(false);
  await act(async()=>toggle.click());await settle();
  expect(host.querySelector('.flashcards-overview')?.textContent).toContain("1 张卡片");
});
