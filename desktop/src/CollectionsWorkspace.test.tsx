// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { CollectionsWorkspace } from "./CollectionsWorkspace";
import { CollectionViewsProvider } from "./CollectionViews";
import { CollectionNavigation } from "./CollectionNavigation";
import { clearOperationStatus, useOperationStatus } from "./useOperationStatus";
import { runtimeCapabilities } from "./RuntimePlatform";
import { WorkspaceHeaderContext } from "./WorkspaceChrome";
const { invoke, chooseDirectory } = vi.hoisted(() => ({ invoke: vi.fn(), chooseDirectory: vi.fn(async ():Promise<string|null> => "D:/test-vault") }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: chooseDirectory }));
let container: HTMLDivElement;
let root: Root;
const initial = { items: [], total: 0, unread: 0, matched: 0, connected: true, running: false, canResume: true, status: "",sources:[{id:"bookmarks",count:0,connected:true,canResume:true,status:""},{id:"likes",count:0,connected:false,canResume:false,status:""}] };
const storage={config:{mode:"database",vaultPath:"",downloadMedia:true,autoSyncMinutes:30,localSourcesMinutes:0},running:false,status:""};

function pointer(type:string,x:number,y:number,id=7) {
  const event=new MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x,clientY:y});
  Object.defineProperties(event,{pointerId:{value:id},isPrimary:{value:true}});return event;
}
function mockBoardHit(target:Element|null) {
  const descriptor=Object.getOwnPropertyDescriptor(document,"elementFromPoint");
  Object.defineProperty(document,"elementFromPoint",{configurable:true,value:()=>target});
  return {mockRestore:()=>{if(descriptor)Object.defineProperty(document,"elementFromPoint",descriptor);else Reflect.deleteProperty(document,"elementFromPoint");}};
}
async function boardFixture(fail=false) {
  let item={...lifecycleItem,status:"unread",read:false,tags:["保留标签"]};
  invoke.mockImplementation(async(command:string,args?:{status:string;tags:string[]})=>{
    if(command==="set_collection_properties"){if(fail)throw new Error("保存状态失败");item={...item,status:args!.status,tags:args!.tags,read:args!.status==="read"||args!.status==="abandoned"};return "状态已保存";}
    return command==="list_collection_items"?{...initial,items:[{...item}],total:1,matched:1}:command==="get_collection_storage"?storage:[];
  });
  await mount();await click("看板");await act(async()=>vi.advanceTimersByTimeAsync(160));
  return {item:()=>item,editTags:(tags:string[])=>{item={...item,tags};}};
}
async function boardDrag(target:Element|null,end="pointerup") {
  const card=container.querySelector<HTMLElement>(".collection-board article")!;
  const hit=mockBoardHit(target);
  try {
    await act(async()=>card.dispatchEvent(pointer("pointerdown",10,10)));
    await act(async()=>window.dispatchEvent(pointer("pointermove",40,40)));
    await act(async()=>window.dispatchEvent(end==="blur"?new Event("blur"):end==="Escape"?new KeyboardEvent("keydown",{key:"Escape",cancelable:true}):pointer(end,40,40)));
  } finally {hit.mockRestore();}
}
it("moves a board card with the latest tags and persists the result in its new column",async()=>{
  const fixture=await boardFixture();
  expect(invoke).toHaveBeenCalledWith("list_collection_items",expect.objectContaining({filters:expect.objectContaining({includeAbandoned:true})}));
  const card=container.querySelector<HTMLElement>(".collection-board article")!;
  const target=container.querySelector<HTMLElement>('[data-reading-status="read"]')!;
  const hit=mockBoardHit(target);
  try {
    await act(async()=>card.dispatchEvent(pointer("pointerdown",10,10)));
    await act(async()=>window.dispatchEvent(pointer("pointermove",40,40)));
    expect(target.classList.contains("collection-board-drop-target")).toBe(true);
    fixture.editTags(["轮询更新的标签"]);await act(async()=>vi.advanceTimersByTimeAsync(2000));
    await act(async()=>window.dispatchEvent(pointer("pointerup",40,40)));
    expect(invoke).toHaveBeenCalledWith("set_collection_properties",{key:lifecycleItem.key,status:"read",tags:["轮询更新的标签"],expectedStatus:"unread",expectedTags:["轮询更新的标签"]});
    expect(container.querySelector('[data-reading-status="read"] article')?.textContent).toContain(lifecycleItem.post.text);
    expect(container.querySelector('[data-reading-status="unread"] article')).toBeNull();
    expect(document.body.classList.contains("dragging-reading-card")).toBe(false);
    expect(container.querySelector(".collection-board-drag-preview")).toBeNull();
  } finally {hit.mockRestore();}
});
it("ignores same-column and outside-board drops and simple clicks",async()=>{
  await boardFixture();
  await boardDrag(container.querySelector('[data-reading-status="unread"]'));
  const outside=document.createElement("div");outside.dataset.readingStatus="read";document.body.appendChild(outside);
  try{await boardDrag(outside);}finally{outside.remove();}
  const card=container.querySelector<HTMLElement>(".collection-board article")!;
  await act(async()=>card.dispatchEvent(pointer("pointerdown",10,10)));
  await act(async()=>window.dispatchEvent(pointer("pointerup",11,11)));
  expect(invoke.mock.calls.filter(([command])=>command==="set_collection_properties")).toHaveLength(0);
});
it.each(["pointercancel","Escape","blur"])("cancels board dragging on %s without writing",async end=>{
  await boardFixture();await boardDrag(container.querySelector('[data-reading-status="read"]'),end);
  expect(invoke.mock.calls.filter(([command])=>command==="set_collection_properties")).toHaveLength(0);
  expect(document.body.classList.contains("dragging-reading-card")).toBe(false);
  expect(container.querySelector(".collection-board-drag-preview")).toBeNull();
});
it("keeps a failed board move in the original column and reports failure in the footer",async()=>{
  await boardFixture(true);await boardDrag(container.querySelector('[data-reading-status="read"]'));
  expect(container.querySelector('[data-reading-status="unread"] article')).not.toBeNull();
  expect(container.querySelector('[data-reading-status="read"] article')).toBeNull();
  expect(container.querySelector('.test-footer-operation[role="alert"]')?.textContent).toContain("保存状态失败");
});
it("provides a keyboard board move and ignores repeated input while saving",async()=>{
  await boardFixture();let resolve!:(value:string)=>void;
  const implementation=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,args?:unknown)=>command==="set_collection_properties"?new Promise<string>(done=>{resolve=done;}):implementation(command,args));
  const handle=container.querySelector<HTMLButtonElement>(".collection-board-drag")!;
  await act(async()=>{handle.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}));handle.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true}));});
  expect(invoke.mock.calls.filter(([command])=>command==="set_collection_properties")).toHaveLength(1);
  expect(invoke).toHaveBeenCalledWith("set_collection_properties",{key:lifecycleItem.key,status:"in_progress",tags:["保留标签"],expectedStatus:"unread",expectedTags:["保留标签"]});
  await act(async()=>resolve("页面待补写"));
  expect(container.querySelector('.test-footer-operation')?.textContent).toContain("页面待补写");
});
it("refreshes the current source after a pending board save rather than restoring the old filter",async()=>{
  await boardFixture();let finishSave!:()=>void;
  const implementation=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,args?:{source?:string;status:string;tags:string[]})=>{
    if(command==="set_collection_properties")return new Promise(done=>{finishSave=()=>{void Promise.resolve(implementation(command,args)).then(done);};});
    if(command==="list_collection_items"&&args?.source==="telegram")return Promise.resolve({...initial,items:[],matched:0});
    return implementation(command,args);
  });
  const handle=container.querySelector<HTMLButtonElement>(".collection-board-drag")!;
  await act(async()=>handle.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true})));
  const chip=container.querySelector<HTMLButtonElement>(".collection-chip-telegram")!;
  await act(async()=>chip.click());await act(async()=>vi.advanceTimersByTimeAsync(160));
  expect(container.querySelector(".collection-board article")).toBeNull();
  await act(async()=>finishSave());
  const requests=invoke.mock.calls.filter(([command])=>command==="list_collection_items");
  expect(requests[requests.length-1]?.[1]).toEqual(expect.objectContaining({source:"telegram"}));
  expect(container.querySelector(".collection-board article")).toBeNull();
});
it("keeps abandoned cards on the all-state board and explains the existing X cancellation rule",async()=>{
  await boardFixture();
  const handle=container.querySelector<HTMLButtonElement>(".collection-board-drag")!;
  await act(async()=>handle.dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true,cancelable:true})));
  expect(invoke).toHaveBeenCalledWith("set_collection_properties",{key:lifecycleItem.key,status:"abandoned",tags:["保留标签"],expectedStatus:"unread",expectedTags:["保留标签"]});
  expect(container.querySelector('[data-reading-status="abandoned"] article')).not.toBeNull();
  expect(container.querySelector('.test-footer-operation')?.textContent).toContain("下次同步时取消 X 原收藏");
});

it.each(["bookmarks","telegram","dida"])("keeps the original open action only for existing %s sources",async source=>{
  const item={...lifecycleItem,key:`${source}:one`,read:false,tags:["已有标签"],post:{...lifecycleItem.post,id:"one",source,text:"阅读资料\n\n原始正文",authorName:"作者",url:source==="dida"?"https://dida365.com/webapp/#p/project/tasks/one":"https://example.invalid/original",publishedAt:"2026-10-07"}};
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[item],total:1,matched:1}:command==="get_collection_storage"?storage:[]);
  await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());
  const toolbar=container.querySelector('.collection-preview [aria-label="预览操作"]') || container.querySelector('[aria-label="预览操作"]');
  expect(toolbar).toBeTruthy();
  expect(toolbar!.querySelector('[aria-label="打开原文"]')!==null).toBe(source!=="dida");
  expect(toolbar!.querySelector('[aria-label="更新内容"]')).toBeTruthy();
  expect(toolbar!.querySelector('[aria-label="复制结果链接"]')).toBeTruthy();
});
beforeEach(() => {
  chooseDirectory.mockReset().mockResolvedValue("D:/test-vault");
  clearOperationStatus();
  vi.useFakeTimers(); localStorage.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  invoke.mockImplementation(async (command: string) => command === "list_collection_items" ? initial : command === "get_collection_storage" ? storage : "已开始后台保存");
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); invoke.mockReset(); });
function FooterNoticeProbe(){const {operationStatus}=useOperationStatus();return operationStatus?<div className="test-footer-operation" role={operationStatus.tone==="error"?"alert":"status"}>{operationStatus.text}</div>:null;}
async function mount() { await act(async () => root.render(<CollectionViewsProvider><CollectionNavigation /><CollectionsWorkspace /><FooterNoticeProbe/></CollectionViewsProvider>)); await act(async () => vi.advanceTimersByTimeAsync(160)); }
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(b => b.textContent === label || b.getAttribute("aria-label")===label)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
async function expand(label: string) {
  const summary=[...container.querySelectorAll("summary")].find(node=>node.textContent?.trim()===label)!;
  expect(summary).toBeTruthy();await act(async()=>summary.click());
}
async function input(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,value: string) {
  await act(async()=>{ Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element),"value")!.set!.call(element,value);element.dispatchEvent(new Event(element instanceof HTMLSelectElement?"change":"input",{bubbles:true})); });
}
const lifecycleItem={key:"x:local",collectedAt:1791165600000,read:false,status:"in_progress",tags:["资料"],lifecycle:"active",post:{id:"1",text:"需要整理的收藏",authorName:"作者",authorHandle:"reader",publishedAt:"2026-10-05",url:"https://x.com/reader/status/1",quotedText:"",contentStatus:"complete",links:[],media:[],source:"bookmarks"}};
it("opens an exact search target outside the current reading page and restores the list",async()=>{
 const handled=vi.fn();
 invoke.mockImplementation(async(command:string,args?:{filters?:{itemKey?:string}})=>command==="list_collection_items"?{...initial,items:args?.filters?.itemKey?[lifecycleItem]:[],total:65,matched:args?.filters?.itemKey?1:65}:command==="get_collection_storage"?storage:[]);
 await act(async()=>root.render(<CollectionViewsProvider><CollectionsWorkspace initialItemKey={lifecycleItem.key} onSearchTargetHandled={handled}/></CollectionViewsProvider>));
 await act(async()=>vi.advanceTimersByTimeAsync(160));
 expect(handled).toHaveBeenCalledOnce();
 expect(invoke).toHaveBeenCalledWith("list_collection_items",expect.objectContaining({offset:0,filters:{itemKey:lifecycleItem.key}}));
 expect(container.textContent).toContain(lifecycleItem.post.text);
 await click("返回阅读列表");await act(async()=>vi.advanceTimersByTimeAsync(160));
 const calls=invoke.mock.calls.filter(([command])=>command==="list_collection_items");
 expect(calls[calls.length-1][1].filters.itemKey).toBeUndefined();
});
it("separates sync, processing records and advanced settings into visible tabs",async()=>{
 const longStatus="长同步日志 ".repeat(100);
 invoke.mockImplementation(async command=>command==="list_collection_items"?{...initial,sources:initial.sources.map(source=>({...source,status:longStatus}))}:command==="get_collection_storage"?storage:[]);
 await mount();await click("同步与连接");
 expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
 expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("同步");
 expect(container.querySelector('[aria-label="保存位置与同步频率"]')).toBeNull();
 expect(container.querySelector('.collection-source-detail')?.hasAttribute("open")).toBe(false);
 await click("处理记录");expect(container.querySelector('.collection-source-sync')).toBeNull();
 expect(container.querySelector('[role="tabpanel"]')?.textContent).toContain("暂无待处理");
 await click("设置");expect(container.querySelector('[aria-label="保存位置与同步频率"]')).toBeTruthy();
 expect(container.querySelector('.collection-sync-connections')?.hasAttribute("open")).toBe(false);
 const tab=container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="设置"]')!;
 await act(async()=>tab.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true,cancelable:true})));
 expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("同步");
});
it("surfaces Dida authentication and preservation policy without offering an unverified cleanup",async()=>{
 const dida={id:"dida",count:40,connected:true,canResume:false,status:"32项来源保留",lastCheckedAt:1791505800,didaCleanup:{mode:"cloud-preserve",pending:32,verified:0,deleted:8,authRequired:true,reasons:[{message:"滴答网页登录未通过（401），请重新登录；原项已保留",count:32}]}};
 invoke.mockImplementation(async command=>command==="list_collection_items"?{...initial,sources:[...initial.sources,dida]}:command==="get_collection_storage"?storage:command==="get_dida_reading_login_status"?{connected:false,accountMatched:false,checkedAt:1791505801,loginWindowOpen:false,state:"authentication",message:"滴答网页登录未通过（401）；原项已保留"}:[]);
 await mount();await click("同步与连接");
 const first=container.querySelector('.collection-sync-source-card')!;
 expect(first.classList.contains("dida")).toBe(true);expect(first.textContent).toContain("滴答里的原内容：保留 32 条");
 expect(first.textContent).toContain("同步后删除：未开启");expect(first.textContent).toContain("最近检查");
 expect(first.querySelector('[role="status"]')?.textContent).toContain("（401）");
 await click("重新登录滴答");expect(invoke).toHaveBeenCalledWith("open_dida_attachment_login");
 expect(first.querySelector('[aria-label="滴答网页登录验证结果"]')?.textContent).toContain("窗口打开不代表验证成功");
 expect(invoke.mock.calls.some(([command])=>/delete|cleanup|approve/.test(command))).toBe(false);
});
it("pages identifiable library records and keeps cancelled history closed and non-retryable",async()=>{
 const records=Array.from({length:11},(_,index)=>({key:`record:${index}`,itemTitle:`文章 ${index}`,target:"craft-main",targetName:"Main",updatedAt:1791505800-index,action:"move",phase:index===0||index===10?"cancelled":index===8?"cleanup":index===9?"queued":"partial",error:"正文与附件尚未完成核验",parked:index>0&&index<5,plan:{status:"planned",libraryName:"Main",destinationPath:"Main / 阅读",summary:"",reason:"",title:"",markdown:"",tasks:[],attachments:[],warnings:[]}}));
 invoke.mockImplementation(async command=>command==="list_collection_items"?initial:command==="get_collection_storage"?storage:command==="collection_library_operations"?records:[]);
 await mount();await click("同步与连接");await click("处理记录");
 expect(container.querySelectorAll('.collection-sync-operations>.collection-operation-list article')).toHaveLength(5);
 const first=container.querySelector('.collection-sync-operations>.collection-operation-list article')!;
 expect(first.textContent).toContain("文章 1");expect(first.textContent).toContain("Main");expect(first.querySelector('time')?.getAttribute("datetime")).toBeTruthy();
 expect(container.querySelector('.collection-operation-history')?.hasAttribute("open")).toBe(false);
 await click("继续处理");expect(invoke).toHaveBeenCalledWith("move_collection_to_library",{key:"record:1",destination:"craft-main"});
 await click("下一页");expect(container.querySelectorAll('.collection-sync-operations>.collection-operation-list article')).toHaveLength(4);
 await click("重试");expect(invoke).toHaveBeenCalledWith("retry_collection_library_operation",{key:"record:8",expectedTarget:"craft-main"});
 await act(async()=>container.querySelector<HTMLElement>('.collection-operation-history>summary')!.click());
 const history=container.querySelector('.collection-operation-history')!;
 expect(history.querySelectorAll('article')).toHaveLength(2);
 expect([...history.querySelectorAll('button')].some(button=>["重试","继续处理"].includes(button.textContent||""))).toBe(false);
 expect(invoke.mock.calls.some(([command])=>command==="approve_collection_conversion")).toBe(false);
});
it("shows a paused fetch as paused rather than still reading pages",async()=>{
 invoke.mockImplementation(async command=>command==="list_collection_items"?initial:command==="get_collection_storage"?{...storage,job:{id:1,running:false,phase:"fetching",source:"bookmarks",processed:0,total:0,downloadedBytes:0,fileBytes:0,message:"请求已暂停",outcome:"paused"}}:[]);
 await mount();await click("同步与连接");
 expect(container.querySelector('[aria-label="后台保存进度"]')?.textContent).toContain("读取已暂停");
 expect(container.querySelector('[aria-label="后台保存进度"]')?.textContent).not.toContain("正在分页读取");
 await click("继续同步");expect(invoke).toHaveBeenCalledWith("sync_x_bookmarks",{source:"bookmarks",restart:false});
});
it("does not report cancelled history as an active processing warning",async()=>{
 const record={key:"cancelled:old",itemTitle:"已取消的旧文章",target:"craft-main",targetName:"Main",action:"move",phase:"cancelled",error:"方案已取消，已保存内容保留"};
 invoke.mockImplementation(async command=>command==="list_collection_items"?initial:command==="get_collection_storage"?storage:command==="collection_library_operations"?[record]:[]);
 await mount();expect(container.querySelector('.test-footer-operation')).toBeNull();
 await click("同步与连接");await click("处理记录");
 expect(container.querySelector('.collection-sync-operations')?.textContent).toContain("0 项待处理");
 expect(container.querySelector('.collection-operation-history')?.hasAttribute("open")).toBe(false);
});
it("archives from the status menu and exposes an independent archive view without a fetch",async()=>{
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[lifecycleItem],total:1,matched:1}:command==="get_collection_storage"?storage:[]);
 await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());await click("阅读状态");await act(async()=>[...container.querySelectorAll<HTMLButtonElement>('[aria-label="选择阅读状态"] [role="option"]')].find(b=>b.textContent==="归档")!.click());
 expect(invoke).toHaveBeenCalledWith("set_collection_lifecycle",{key:"x:local",state:"archived"});
 const archive=container.querySelector<HTMLButtonElement>('[aria-label="阅读导航"] [aria-label="归档"]')!;expect(archive).toBeTruthy();await act(async()=>archive.click());await act(async()=>vi.advanceTimersByTimeAsync(160));
 expect(invoke).toHaveBeenCalledWith("list_collection_items",expect.objectContaining({status:"archived"}));
 expect(invoke).not.toHaveBeenCalledWith("sync_x_bookmarks",expect.anything());
});
it("reviews deletion scope before sending the deletion action",async()=>{
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[lifecycleItem],total:1,matched:1}:command==="get_collection_storage"?storage:command==="collection_delete_preview"?["测试库 / own.md"]:[]);
 await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());await click("阅读状态");await click("删除");
 expect(container.querySelector('dialog[open]')?.textContent).toContain("测试库 / own.md");expect(invoke).not.toHaveBeenCalledWith("set_collection_lifecycle",expect.anything());
 await click("删除页面和附件");expect(invoke).toHaveBeenCalledWith("set_collection_lifecycle",{key:"x:local",state:"deleting"});
});

it("mobile keeps reading controls and cloud settings while hiding source and library writes",async()=>{
 const previous=runtimeCapabilities.mobile;runtimeCapabilities.mobile=true;
 const openCloud=vi.fn();window.addEventListener("hub:open-cloud-sync-settings",openCloud);
 try {
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[{...lifecycleItem,cloudImported:true}],total:1,matched:1}:command==="get_collection_storage"?storage:[]);
  HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};
  await mount();await click("阅读筛选");await act(async()=>(document.querySelector('[aria-label="云同步设置"]') as HTMLElement).click());await act(async()=>vi.advanceTimersByTimeAsync(40));expect(openCloud).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[aria-label="同步与连接"]')).toBeNull();
  await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());
  expect(container.querySelector('[aria-label="选择保存资料库"]')).toBeNull();
  expect(container.querySelector('[aria-label="更新内容"]')).toBeNull();
  expect(container.textContent).toContain("在桌面端管理资料库副本");
  expect(container.querySelector('[aria-label="编辑标签"]')).toBeTruthy();
  await click("阅读状态");
  const menu=container.querySelector('[aria-label="选择阅读状态"]')!;
  expect(menu.textContent).toContain("原收藏保留");expect(menu.textContent).not.toContain("删除");
  expect(menu.textContent).toContain("归档");
 } finally {runtimeCapabilities.mobile=previous;window.removeEventListener("hub:open-cloud-sync-settings",openCloud);}
});
it("keeps one mobile reading filter entrance with staged fields and reachable saved views",async()=>{
 const previous=runtimeCapabilities.mobile;runtimeCapabilities.mobile=true;
 HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};
 try {
  await mount();expect(container.querySelector('[aria-label="切换侧边栏"]')).toBeNull();
  expect(container.querySelector('.collection-header')).toBeNull();
  expect(container.querySelector('[aria-label="搜索阅读内容"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="阅读状态"]')).toBeTruthy();
  await click("阅读筛选");
  const dialog=document.querySelector('dialog[aria-label="阅读筛选"]')!;
  expect(dialog.querySelector('[aria-label="阅读来源"]')).toBeTruthy();
  expect(dialog.querySelector('[aria-label="阅读收集时间"]')).toBeTruthy();
  const advanced=dialog.querySelector('details')!;await act(async()=>{advanced.open=true;});
  const layout=dialog.querySelector('[aria-label="阅读布局"]')!;
  expect([...layout.querySelectorAll("button")].map(button=>button.textContent)).toEqual(["列表","表格","看板","画廊"]);
  expect(dialog.querySelector('[aria-label="新建视图"]')).toBeTruthy();
  expect(dialog.querySelector('[aria-label="排序"]')).toBeTruthy();
  expect(dialog.querySelector('[aria-label="云同步设置"]')).toBeTruthy();
 } finally {runtimeCapabilities.mobile=previous;}
});
it("keeps desktop sidebar and window controls when the reading area becomes narrow",async()=>{
 const measure=vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(()=>({width:580} as DOMRect));
 const toggleSidebar=vi.fn();
 invoke.mockImplementation(async command=>command==="list_collection_items"?{...initial,items:[lifecycleItem],total:1,matched:1}:command==="get_collection_storage"?storage:[]);
 try {
  await act(async()=>root.render(<CollectionViewsProvider><WorkspaceHeaderContext.Provider value={{actions:<button aria-label="最小化窗口">最小化</button>,onMouseDown:()=>{}}}><CollectionsWorkspace onToggleDesktopSidebar={toggleSidebar}/></WorkspaceHeaderContext.Provider></CollectionViewsProvider>));
  await act(async()=>vi.advanceTimersByTimeAsync(160));
  expect(container.querySelector('[aria-label="阅读布局"]')).toBeTruthy();
  expect(container.querySelector('[aria-label="最小化窗口"]')).toBeTruthy();
  const previewToggle=container.querySelector<HTMLButtonElement>('[aria-label="切换预览侧栏"]')!;
  expect(previewToggle).toBeTruthy();
  await act(async()=>previewToggle.click());expect(previewToggle.getAttribute("aria-pressed")).toBe("false");
  await act(async()=>previewToggle.click());expect(previewToggle.getAttribute("aria-pressed")).toBe("true");
  await click("切换侧边栏");expect(toggleSidebar).toHaveBeenCalledTimes(1);
  await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());
  expect(container.querySelector('.collection-detail-desktop-header [aria-label="最小化窗口"]')).toBeTruthy();
  const sidebar=container.querySelector<HTMLButtonElement>('.collection-detail-desktop-header [aria-label="切换侧边栏"]')!;
  expect(sidebar).toBeTruthy();await act(async()=>sidebar.click());expect(toggleSidebar).toHaveBeenCalledTimes(2);
 } finally {measure.mockRestore();}
});
it("opens mobile reading full screen and returns to the saved list position",async()=>{
 const previous=runtimeCapabilities.mobile;runtimeCapabilities.mobile=true;
 const measure=vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(()=>({width:1100} as DOMRect));
 const goBack=vi.spyOn(window.history,"back").mockImplementation(()=>{});
 const originalState=window.history.state;
 invoke.mockImplementation(async command=>command==="list_collection_items"?{...initial,items:[lifecycleItem],total:1,matched:1}:command==="get_collection_storage"?storage:[]);
 try {
  await mount();
  const database=container.querySelector<HTMLElement>(".collection-database")!;
  database.scrollTop=260;await act(async()=>database.dispatchEvent(new Event("scroll",{bubbles:true})));
  await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());
  expect(container.querySelector(".collections-workspace")?.classList.contains("collection-detail-open")).toBe(true);
  expect(container.querySelector<HTMLElement>(".collection-browse-controls")?.hidden).toBe(true);
  expect(database.getAttribute("inert")).not.toBeNull();
  expect(container.querySelector('[aria-label="返回阅读列表"] .lucide-arrow-left')).toBeTruthy();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("返回阅读列表");
  expect(container.querySelector('.preview-actions [aria-label="更多阅读操作"]')).toBeTruthy();
  database.scrollTop=0;await act(async()=>database.dispatchEvent(new Event("scroll",{bubbles:true})));
  await click("返回阅读列表");
  expect(container.querySelector('[aria-label="阅读详情"]')).toBeNull();
  expect(container.querySelector<HTMLElement>(".collection-browse-controls")?.hidden).toBe(false);
  expect(database.getAttribute("inert")).toBeNull();
  expect(database.scrollTop).toBe(260);
  expect(document.activeElement).toBe(container.querySelector(".collection-row.selected"));
  expect(goBack).toHaveBeenCalledTimes(1);
 } finally {runtimeCapabilities.mobile=previous;measure.mockRestore();goBack.mockRestore();window.history.replaceState(originalState,"");}
});
it("consumes the mobile history step when returning from a reading detail",async()=>{
 const previous=runtimeCapabilities.mobile;runtimeCapabilities.mobile=true;
 const originalState=window.history.state;
 const readingRoute={hubMobileRoute:"collections"};
 window.history.replaceState(readingRoute,"");
 invoke.mockImplementation(async command=>command==="list_collection_items"?{...initial,items:[lifecycleItem],total:1,matched:1}:command==="get_collection_storage"?storage:[]);
 try {
  await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());
  expect(window.history.state).toEqual({...readingRoute,hubReadingPreview:true});
  window.history.replaceState(readingRoute,"");
  await act(async()=>window.dispatchEvent(new PopStateEvent("popstate",{state:readingRoute})));
  expect(container.querySelector('[aria-label="阅读详情"]')).toBeNull();
  expect(container.querySelector<HTMLElement>(".collection-browse-controls")?.hidden).toBe(false);
 } finally {runtimeCapabilities.mobile=previous;window.history.replaceState(originalState,"");}
});
it("returns to the reading list after changing mobile modules without navigating history on unmount",async()=>{
 const previous=runtimeCapabilities.mobile;runtimeCapabilities.mobile=true;
 const originalState=window.history.state;
 const goBack=vi.spyOn(window.history,"back").mockImplementation(()=>{});
 function Route(){const [reading,setReading]=useState(true);return <><button onClick={()=>setReading(!reading)}>{reading?"离开阅读":"回到阅读"}</button>{reading&&<CollectionsWorkspace/>}</>;}
 invoke.mockImplementation(async command=>command==="list_collection_items"?{...initial,items:[lifecycleItem],total:1,matched:1}:command==="get_collection_storage"?storage:[]);
 try {
  window.history.replaceState({hubMobileRoute:"collections"},"");
  await act(async()=>root.render(<CollectionViewsProvider><Route/></CollectionViewsProvider>));
  await act(async()=>vi.advanceTimersByTimeAsync(160));
  const database=container.querySelector<HTMLElement>(".collection-database")!;
  database.scrollTop=180;await act(async()=>database.dispatchEvent(new Event("scroll",{bubbles:true})));
  await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());
  expect(container.querySelector('[aria-label="阅读详情"]')).toBeTruthy();
  window.history.replaceState({hubMobileRoute:"tasks"},"");
  await click("离开阅读");expect(goBack).not.toHaveBeenCalled();
  window.history.replaceState({hubMobileRoute:"collections"},"");
  await click("回到阅读");await act(async()=>vi.advanceTimersByTimeAsync(160));
  expect(container.querySelector('[aria-label="阅读详情"]')).toBeNull();
  expect(container.querySelector<HTMLElement>(".collection-browse-controls")?.hidden).toBe(false);
  expect(container.querySelector<HTMLElement>(".collection-database")?.scrollTop).toBe(180);
  expect(goBack).not.toHaveBeenCalled();
 } finally {runtimeCapabilities.mobile=previous;goBack.mockRestore();window.history.replaceState(originalState,"");}
});
it("adds a library copy while retaining the local default and existing copy",async()=>{
 const libraries=[{id:"notes",name:"知识库",provider:"obsidian",connected:true,documentCount:0},{id:"tasks",name:"滴答",provider:"dida365",connected:true,documentCount:0}];
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[{...lifecycleItem,destinationId:"notes"}],total:1,matched:1}:command==="get_collection_storage"?storage:command==="list_libraries"?libraries:[]);
 await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());await click("选择保存资料库");
 const selected=container.querySelectorAll('.collection-destination-menu [aria-selected="true"]');expect(selected.length).toBe(2);expect(selected[0].textContent).toContain("本地默认");expect(selected[1].textContent).toContain("知识库");
 await act(async()=>[...container.querySelectorAll<HTMLButtonElement>(".collection-destination-menu button")].find(b=>b.textContent==="滴答")!.click());
 expect(invoke).toHaveBeenCalledWith("move_collection_to_library",{key:"x:local",destination:"tasks"});
 expect(invoke).not.toHaveBeenCalledWith("approve_collection_conversion",expect.anything());
});
it("puts Telegram after X sources and filters the shared collection without starting a fetch",async()=>{
  const page={...initial,total:3,matched:0,sources:[{...initial.sources[0],count:2},initial.sources[1],{id:"telegram",count:1,connected:false,canResume:false,status:""}]};
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?page:command==="get_collection_storage"?storage:"");
  await mount();
  const chips=[...container.querySelectorAll<HTMLButtonElement>(".task-source-chip")];
  expect(chips.map(b=>b.textContent)).toEqual(["全部 3","X 书签2","X 喜欢0","Telegram1","滴答稍后读0"]);
  await act(async()=>chips[3].click());await act(async()=>vi.advanceTimersByTimeAsync(160));
  expect(invoke).toHaveBeenCalledWith("list_collection_items",expect.objectContaining({source:"telegram"}));
  expect(invoke.mock.calls.some(([c])=>c==="sync_x_bookmarks"||c==="sync_telegram")).toBe(false);
});
it("saves a bot token only through its connection command and clears it before pairing",async()=>{
  let connected=false;
  invoke.mockImplementation(async(command:string)=>{
    if(command==="save_telegram_connection"){connected=true;return "请打开机器人确认";}
    if(command==="list_collection_items")return {...initial,sources:[...initial.sources,{id:"telegram",count:0,connected,canResume:false,status:"",pairingUrl:connected?"https://t.me/test_bot?start=hub_pair":""}]};
    return command==="get_collection_storage"?storage:"";
  });
  await mount();await click("同步与连接");await click("设置");await expand("连接管理");await click("连接 Telegram");
  const field=container.querySelector<HTMLInputElement>("#telegram-token")!;expect(field.type).toBe("password");
  await input(field,"7:LOCAL_TEST_TOKEN_ONLY");await click("保存连接");
  expect(invoke).toHaveBeenCalledWith("save_telegram_connection",{token:"7:LOCAL_TEST_TOKEN_ONLY"});expect(field.value).toBe("");
  expect(container.textContent).not.toContain("LOCAL_TEST_TOKEN_ONLY");
  await click("打开机器人确认");expect(invoke).toHaveBeenCalledWith("open_external_url",{url:"https://t.me/test_bot?start=hub_pair"});
});
it("keeps Telegram connection and save available while X is fetching or exporting",async()=>{
  const activeStorage={...storage,running:true,telegramRunning:false,job:{id:7,running:true,phase:"saving",source:"bookmarks",processed:1,total:10,outcome:""}};
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,running:true}:command==="get_collection_storage"?activeStorage:"请打开机器人确认");
  await mount();await click("同步与连接");
  await click("设置");await expand("连接管理");
  const connect=[...container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="连接 Telegram")!;
  expect(connect.disabled).toBe(false);
  await click("连接 Telegram");
  await input(container.querySelector<HTMLInputElement>("#telegram-token")!,"7:LOCAL_TEST_TOKEN_ONLY");
  const save=container.querySelector<HTMLButtonElement>("dialog[open] .collections-primary")!;
  expect(save.disabled).toBe(false);
  await click("保存连接");
  expect(invoke).toHaveBeenCalledWith("save_telegram_connection",{token:"7:LOCAL_TEST_TOKEN_ONLY"});
});
it("shows bot validation progress, prevents duplicate saves and keeps failures retryable",async()=>{
  let rejectSave!:(reason:string)=>void;
  invoke.mockImplementation((command:string)=>command==="save_telegram_connection"?new Promise((_,reject)=>{rejectSave=reject;}):Promise.resolve(command==="list_collection_items"?initial:command==="get_collection_storage"?storage:""));
  await mount();await click("同步与连接");await click("设置");await expand("连接管理");await click("连接 Telegram");
  const field=container.querySelector<HTMLInputElement>("#telegram-token")!;
  await input(field,"7:LOCAL_TEST_TOKEN_ONLY");await click("保存连接");
  const dialog=container.querySelector<HTMLDialogElement>("dialog[open]")!;
  const save=dialog.querySelector<HTMLButtonElement>(".collections-primary")!;
  expect(save.disabled).toBe(true);expect(field.disabled).toBe(true);
  expect(save.textContent).toContain("校验并保存…");
  expect(dialog.querySelector('[role="status"]')?.textContent).toContain("正在校验 Telegram 机器人连接");
  await act(async()=>save.click());
  expect(invoke.mock.calls.filter(([command])=>command==="save_telegram_connection")).toHaveLength(1);
  await act(async()=>rejectSave("无法连接 Telegram，请检查网络或代理后重试"));
  expect(dialog.open).toBe(true);expect(save.disabled).toBe(false);expect(field.disabled).toBe(false);
  expect(field.value).toBe("7:LOCAL_TEST_TOKEN_ONLY");
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("无法连接 Telegram");
  expect(dialog.querySelector('[role="status"]')).toBeNull();
});
it("explains when Telegram's own receiver temporarily blocks connection changes",async()=>{
  let receiving=false;
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?initial:command==="get_collection_storage"?{...storage,telegramRunning:receiving}:"");
  await mount();await click("同步与连接");await click("设置");await expand("连接管理");await click("连接 Telegram");
  await input(container.querySelector<HTMLInputElement>("#telegram-token")!,"7:LOCAL_TEST_TOKEN_ONLY");
  receiving=true;await act(async()=>vi.advanceTimersByTimeAsync(2000));
  const dialog=container.querySelector<HTMLDialogElement>("dialog[open]")!;
  expect(dialog.querySelector<HTMLButtonElement>(".collections-primary")!.disabled).toBe(true);
  expect(dialog.textContent).toContain("Telegram 正在收件，本轮结束后即可保存连接");
  receiving=false;await act(async()=>vi.advanceTimersByTimeAsync(2000));
  expect(dialog.querySelector<HTMLButtonElement>(".collections-primary")!.disabled).toBe(false);
  expect(dialog.textContent).not.toContain("Telegram 正在收件，本轮结束后即可保存连接");
});
it("renders Telegram notes in the same preview and routes refresh to the inbox",async()=>{
  const item={key:"telegram:7:42:9",collectedAt:1700000000000,read:false,status:"unread",tags:["学习"],savedMedia:[],post:{id:"9",source:"telegram",text:"Telegram collected note",authorName:"Research",authorHandle:"research",publishedAt:"2026-10-05T00:00:00Z",url:"https://t.me/research/9",media:[],links:[],quotedText:"",contentStatus:"text",origin:{name:"Research",url:"https://t.me/research/9"}}};
  const page={...initial,total:1,matched:1,items:[item],sources:[...initial.sources,{id:"telegram",count:1,connected:true,canResume:false,status:""}]};
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?page:command==="get_collection_storage"?storage:"");
  await mount();await act(async()=>container.querySelector<HTMLElement>('article[aria-label="阅读：Telegram collected note"]')!.click());
  expect(container.querySelector(".collection-detail .collection-source-badge")?.textContent).toBe("Telegram");
  expect(container.querySelector(".collection-origin")?.textContent).toContain("转发自 Research");
  await click("更新内容");expect(invoke).toHaveBeenCalledWith("sync_x_bookmarks",{source:"telegram",restart:false});
  expect(invoke.mock.calls.some(([command])=>command==="refresh_collection_content")).toBe(false);
});
it("keeps source restart and resume distinct and surfaces command failures", async () => {
  await mount(); await click("同步与连接");
  invoke.mockImplementation(async (command: string) => {
    if (command === "sync_x_bookmarks") throw "X 登录失效";
    return command === "get_collection_storage" ? storage : initial;
  });
  await click("继续上次"); expect(invoke).toHaveBeenCalledWith("sync_x_bookmarks", {source:"bookmarks", restart: false });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("X 登录失效");
  await click("X 书签"); expect(invoke).toHaveBeenCalledWith("sync_x_bookmarks", {source:"bookmarks", restart: true });
});
it("opens the default browser and clears the sensitive request after saving", async () => {
  await mount(); await click("同步与连接"); await click("设置");await expand("连接管理");await click("更新连接");
  await click("用默认浏览器打开 X 书签");
  expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "https://x.com/i/bookmarks" });
  const textarea = container.querySelector("textarea")!;
  await input(textarea,"curl fake-sensitive-request");
  await click("保存连接");
  expect(invoke).toHaveBeenCalledWith("save_x_bookmark_connection", {source:"bookmarks", request: "curl fake-sensitive-request" });
  expect(textarea.value).toBe(""); expect(container.querySelector("dialog")!.open).toBe(false);
});
it("saves the chosen vault and custom interval, closes immediately and shows background progress", async () => {
  await mount(); await click("同步与连接"); await click("设置");await click("保存位置与同步频率");
  const radio = container.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
  await act(async () => radio.click()); await click("选择文件夹");
  expect(container.querySelector<HTMLInputElement>("#collection-vault")!.value).toBe("D:/test-vault");
  expect(container.textContent).toContain("X/书签/每条推文.md");
  expect(container.textContent).toContain("99_Meta/assets/X_assets/");
  expect(container.textContent).toContain("不设本地大小上限");
  expect(container.textContent).toContain("Telegram 超过 20 MB");
  expect(container.querySelector<HTMLInputElement>("#collection-interval")!.value).toBe("30");
  await input(container.querySelector<HTMLInputElement>("#collection-interval")!,"45");
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?initial:command==="get_collection_storage"?{...storage,running:true,job:{id:1,running:true,phase:"saving",processed:24,total:564,downloadedBytes:2000000,fileBytes:1000000,fileTotal:5000000,message:"正在写入",outcome:""}}:"设置已保存");
  await click("保存设置");
  expect(invoke).toHaveBeenCalledWith("save_collection_storage", {config:{mode:"obsidian",vaultPath:"D:/test-vault",downloadMedia:true,autoSyncMinutes:45,localSourcesMinutes:0}});
  expect(container.querySelectorAll("dialog")[1].open).toBe(false);
  expect(container.querySelector('[aria-label="后台保存进度"]')).toBeNull();
  await click("同步与连接");
  expect(container.querySelector('.collection-sync-popover [aria-label="后台保存进度"]')?.textContent).toContain("24 / 564 条");
  expect(container.querySelector('progress')?.value).toBe(24);
  await click("同步与连接");
  await click("表格"); // View changes remain available during download.
  await click("同步与连接");
  await click("暂停"); expect(invoke).toHaveBeenCalledWith("cancel_x_bookmark_sync");
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?initial:{...storage,job:{id:1,running:false,phase:"saving",processed:564,total:564,downloadedBytes:2000000,fileBytes:0,message:"保存结束",outcome:"completed"}});
  await act(async()=>vi.advanceTimersByTimeAsync(2000));
  expect(container.querySelector(".collection-notice")).toBeNull();
  expect(container.querySelector('[aria-label="后台保存进度"]')).toBeNull();
  await click("设置");expect(container.textContent).toContain("最近保存结果");
});
const renamedVaultStorage={...storage,config:{...storage.config,mode:"obsidian",vaultPath:"D:/Obsidian/ZhiHu"},vaultRelocation:{rootExists:false,candidates:[{path:"D:/Obsidian/Sources",name:"Sources"}]}};
async function openVaultSettings(state=renamedVaultStorage){
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?initial:command==="get_collection_storage"?state:[]);
  await mount();await click("同步与连接");await click("设置");await click("保存位置与同步频率");
}
it("offers missing-vault recovery without automatically adopting a suggested folder",async()=>{
  await openVaultSettings();
  expect(container.querySelector('.collection-vault-recovery [role="status"]')?.textContent).toContain("原库位置不可用");
  expect(container.querySelector('.collection-vault-candidates')?.textContent).toContain("Sources");
  expect(invoke.mock.calls.some(([command])=>command==="relocate_collection_vault")).toBe(false);
  await input(container.querySelector<HTMLInputElement>("#collection-interval")!,"45");
  await input(container.querySelector<HTMLInputElement>("#collection-vault")!,"D:/some-new-default");
  const currentInvoke=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command:string,args?:unknown)=>{
    if(command==="relocate_collection_vault")return {location:"D:/Obsidian/Sources",warning:null};
    if(command==="get_collection_storage")return {...renamedVaultStorage,config:{...renamedVaultStorage.config,vaultPath:"D:/Obsidian/Sources"},vaultRelocation:{rootExists:true,candidates:[]}};
    return currentInvoke(command,args);
  });
  await act(async()=>container.querySelector<HTMLButtonElement>(".collection-vault-candidates button")!.click());
  expect(invoke).toHaveBeenCalledWith("relocate_collection_vault",{expectedVaultPath:"D:/Obsidian/ZhiHu",path:"D:/Obsidian/Sources"});
  expect(container.querySelector<HTMLInputElement>("#collection-vault")!.value).toBe("D:/Obsidian/Sources");
  expect(container.querySelector<HTMLInputElement>("#collection-interval")!.value).toBe("45");
  expect(container.querySelector('.collection-vault-candidates')).toBeNull();
  expect(container.querySelectorAll("dialog")[1].open).toBe(true);
  expect(invoke.mock.calls.some(([command])=>command==="save_collection_storage"||command==="export_collections_to_obsidian")).toBe(false);
});
it("permits manual recovery cancellation and skips an unavailable default picker path",async()=>{
  await openVaultSettings();chooseDirectory.mockResolvedValueOnce(null);
  await click("重新定位原库");
  expect(chooseDirectory).toHaveBeenCalledWith({directory:true,multiple:false,title:"选择原 Obsidian 库改名或移动后的文件夹"});
  expect(invoke.mock.calls.some(([command])=>command==="relocate_collection_vault")).toBe(false);
  expect(container.querySelector<HTMLInputElement>("#collection-vault")!.value).toBe("D:/Obsidian/ZhiHu");
  await click("选择文件夹");
  expect(chooseDirectory).toHaveBeenLastCalledWith({directory:true,multiple:false,title:"选择新内容的默认保存库"});
});
it("retains the old directory and surfaces a rejected unrelated folder",async()=>{
  await openVaultSettings();
  const currentInvoke=invoke.getMockImplementation()!;
  invoke.mockImplementation(async(command:string,args?:unknown)=>{if(command==="relocate_collection_vault")throw "所选文件夹不是原库";return currentInvoke(command,args);});
  await click("重新定位原库");
  expect(container.querySelector<HTMLInputElement>("#collection-vault")!.value).toBe("D:/Obsidian/ZhiHu");
  expect(container.querySelector('dialog[open] [role="alert"]')?.textContent).toContain("不是原库");
  expect(container.querySelectorAll("dialog")[1].open).toBe(true);
});
it("blocks directory recovery while an export is writing",async()=>{
  await openVaultSettings({...renamedVaultStorage,running:true});
  const button=[...container.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent==="重新定位原库")!;
  expect(button.disabled).toBe(true);
  await act(async()=>button.click());
  expect(invoke.mock.calls.some(([command])=>command==="relocate_collection_vault")).toBe(false);
});
it("coalesces repeated recovery clicks while native relocation is pending",async()=>{
  await openVaultSettings();let finish!:(value:{location:string;warning:null})=>void;
  const currentInvoke=invoke.getMockImplementation()!;
  invoke.mockImplementation((command:string,args?:unknown)=>command==="relocate_collection_vault"?new Promise(done=>{finish=done;}):currentInvoke(command,args));
  const button=container.querySelector<HTMLButtonElement>(".collection-vault-candidates button")!;
  await act(async()=>{button.click();button.click();});
  expect(invoke.mock.calls.filter(([command])=>command==="relocate_collection_vault")).toHaveLength(1);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="关闭保存位置设置"]')!.disabled).toBe(true);
  await act(async()=>finish({location:"D:/Obsidian/Sources",warning:null}));
});
it("keeps invalid settings open and permits disabling the interval", async () => {
  await mount(); await click("同步与连接"); await click("设置");await click("保存位置与同步频率"); await input(container.querySelector<HTMLInputElement>("#collection-interval")!,"0");
  invoke.mockImplementation(async(command:string)=>{if(command==="save_collection_storage")throw "目录不可写";return command==="get_collection_storage"?storage:initial;});
  await click("保存设置");
  expect(invoke).toHaveBeenCalledWith("save_collection_storage",{config:{...storage.config,autoSyncMinutes:0}});
  expect(container.querySelectorAll("dialog")[1].open).toBe(true);
  expect(container.querySelector('dialog[open] [role="alert"]')?.textContent).toBe("目录不可写");
});
it("keeps likes connections separate from bookmarks", async () => {
  await mount();await click("同步与连接");
  expect(container.querySelector(".collection-sync-log")?.textContent).toContain("X 喜欢");
  await click("设置");await expand("连接管理");await click("连接 X");
  expect(container.querySelector("dialog h2")?.textContent).toBe("连接 X 喜欢");
  const textarea = container.querySelector("textarea")!;await input(textarea,"curl fake-likes-request");
  await click("保存连接");
  expect(invoke).toHaveBeenCalledWith("save_x_bookmark_connection",{request:"curl fake-likes-request",source:"likes"});
  expect(textarea.value).toBe("");
});
it("persists custom views and applies filters and sort to backend pagination", async () => {
  await mount();
  await click("筛选");
  await input(container.querySelector<HTMLSelectElement>('[aria-label="阅读状态筛选"]')!,"unread");
  await input(container.querySelector<HTMLSelectElement>('[aria-label="内容类型筛选"]')!,"video");
  await click("排序");
  await input(container.querySelector<HTMLSelectElement>('[aria-label="排序方式"]')!,"published");
  await act(async()=>vi.advanceTimersByTimeAsync(160));
  expect(invoke).toHaveBeenCalledWith("get_collection_storage");
  expect(invoke).toHaveBeenCalledWith("list_collection_items",expect.objectContaining({status:"unread",media:"video",sort:"published",source:"all",offset:0}));
  await click("新建视图");
  await input(container.querySelector<HTMLInputElement>('[aria-label="新视图名称"]')!,"视频待读");
  await click("创建视图");
  await act(async()=>root.unmount());root=createRoot(container);await mount();
  expect(container.querySelector('[aria-label="阅读导航"]')?.textContent).toContain("视频待读");
  expect(container.querySelector('[aria-label="当前筛选条件"]')?.textContent).toContain("有视频");
});
it("opens a reading pane without changing read status", async()=>{
  const item={key:"x:1",collectedAt:1791165600000,read:false,savedMedia:[],post:{id:"1",text:"收藏标题\n正文内容 https://example.com/article",authorName:"作者",authorHandle:"reader",publishedAt:"2026-10-05",url:"https://x.com/reader/status/1",quotedText:"",contentStatus:"complete",links:[],media:[],source:"bookmarks"}};
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[item],total:1,matched:1,unread:1}:storage);
  await mount(); const row=container.querySelector<HTMLElement>('[aria-label="阅读：收藏标题"]')!;await act(async()=>row.click());
  expect(container.querySelector('[aria-label="阅读详情"]')?.textContent).toContain("正文内容");
  const bodyLink=container.querySelector<HTMLAnchorElement>('.collection-post-text a.preview-text-link')!;
  expect(bodyLink.href).toBe("https://example.com/article");
  await act(async()=>bodyLink.click());expect(invoke).toHaveBeenCalledWith("open_external_url",{url:"https://example.com/article"});
  expect(invoke).not.toHaveBeenCalledWith("set_collection_read",expect.anything());
  const writeText=vi.fn(async()=>{});
  Object.defineProperty(navigator,"clipboard",{value:{writeText},configurable:true});
  await click("复制结果链接");expect(writeText).toHaveBeenCalledWith(item.post.url);
  expect(container.querySelector('.preview-copy-action')?.getAttribute("aria-label")).toBe("已复制");
  await act(async()=>vi.advanceTimersByTimeAsync(1800));
  await click("打开原文");expect(invoke).toHaveBeenCalledWith("open_external_url",{url:item.post.url});
  writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
  await click("复制结果链接");expect(container.querySelector('[role="alert"]')?.textContent).toContain("复制链接失败");
  expect(invoke).not.toHaveBeenCalledWith("set_collection_read",expect.anything());
  await click("切换预览侧栏");expect(container.querySelector('[aria-label="阅读详情"]')).toBeNull();
  await click("切换预览侧栏");expect(container.querySelector('[aria-label="阅读详情"]')).toBeTruthy();
  Reflect.deleteProperty(navigator,"clipboard");
});

it("opens gallery cards without marking them read and uses task status icons", async()=>{
  const item={key:"x:2",collectedAt:1791165600000,read:false,savedMedia:[],post:{id:"2",text:"画廊内容",authorName:"作者",authorHandle:"reader",publishedAt:"2026-10-05",url:"https://x.com/reader/status/2",quotedText:"",contentStatus:"complete",links:[],media:[],source:"bookmarks"}};
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[item],total:1,matched:1,unread:1}:storage);
  await mount(); await click("画廊");
  const card=container.querySelector<HTMLElement>(".collection-gallery-card")!;
  expect(card).toBeTruthy(); await act(async()=>card.click());
  expect(container.querySelector('[aria-label="阅读详情"]')).toBeTruthy();
  expect(container.querySelector('.collection-status-picker .lucide-circle')).toBeTruthy();
  expect(container.querySelector('[aria-label="关闭详情"]')).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("set_collection_read",expect.anything());
  await click("阅读状态"); await act(async()=>container.querySelector<HTMLButtonElement>('[role="option"]:nth-of-type(2)')!.click());
  expect(invoke).toHaveBeenCalledWith("set_collection_properties",expect.objectContaining({status:"in_progress",tags:[]}));
  await click("编辑标签");
  await input(container.querySelector<HTMLInputElement>('[aria-label="搜索或创建标签"]')!,"阅读笔记");
  await click("创建 阅读笔记");
  expect(invoke).toHaveBeenCalledWith("set_collection_properties",expect.objectContaining({tags:["阅读笔记"]}));
  expect(invoke).not.toHaveBeenCalledWith("sync_x_bookmarks",expect.anything());

});

it("persists gallery display controls and applies property visibility and conditional colors",async()=>{
 const item={key:"x:3",collectedAt:1791165600000,read:false,savedMedia:[],post:{id:"3",text:"卡片配置验证",authorName:"测试作者",authorHandle:"reader",publishedAt:"2026-10-05",url:"https://x.com/reader/status/3",quotedText:"",contentStatus:"complete",links:[],media:[],source:"bookmarks"}};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[item],total:1,matched:1,unread:1}:storage);
 await mount();await click("画廊");await click("大卡片");
 expect(container.querySelector(".card-size-spacious")).toBeTruthy();
 await click("卡片配置");
 async function section(label:string){const button=[...container.querySelectorAll<HTMLButtonElement>(".collection-config-menu button")].find(b=>b.textContent?.includes(label))!;await act(async()=>button.click());}
 await section("画廊设置");
 const cover=[...container.querySelectorAll(".collection-config-content label")].find(e=>e.textContent==="图片作为封面")!.querySelector<HTMLInputElement>("input")!;
 await act(async()=>cover.click());expect(container.querySelector(".collection-gallery-cover")).toBeNull();
 await click("返回卡片配置");await section("属性是否可见");await click("全部隐藏");
 expect(container.querySelector(".collection-gallery-properties")?.children.length).toBe(0);
 await click("返回卡片配置");await section("条件颜色");await click("继续添加");
 expect(container.querySelector<HTMLElement>(".collection-gallery-card")?.style.background).toBe("rgb(238, 245, 255)");
 await act(async()=>root.unmount());root=createRoot(container);await mount();
 expect(container.querySelector(".card-size-spacious")).toBeTruthy();expect(container.querySelector(".collection-gallery-cover")).toBeNull();
});

it("keeps frequency in the unified menu and syncs each source independently",async()=>{
 const page={...initial,sources:[...initial.sources.map(s=>({...s,connected:true})),{id:"telegram",count:0,connected:true,paired:true,canResume:false,status:""}]};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?page:command==="get_collection_storage"?storage:"");
 await mount();expect(container.querySelector(".collection-auto-label")).toBeNull();await click("同步与连接");
 expect(container.querySelector(".collection-sync-popover .collection-auto-label")?.textContent).toContain("30");
 expect(container.querySelectorAll(".collection-sync-log").length).toBe(1);
 const actions=[...container.querySelectorAll<HTMLButtonElement>('.collection-source-sync button[aria-label^="立即同步"]')];
 expect(actions.map(b=>b.textContent)).toEqual(["X 喜欢","X 书签","Telegram","滴答稍后读"]);
 for(const [index,source] of ["likes","bookmarks","telegram"].entries()){
   await act(async()=>actions[index].click());expect(invoke).toHaveBeenCalledWith("sync_x_bookmarks",{source,restart:true});
 }
 expect(invoke).not.toHaveBeenCalledWith("sync_x_bookmarks",expect.objectContaining({source:"all"}));
});

it("allows local status and tag edits while X is fetching and exporting",async()=>{
 const item={key:"x:editing",collectedAt:1700000000000,read:false,status:"unread",tags:[] as string[],savedMedia:[],post:{id:"10",source:"bookmarks",text:"同步时编辑",authorName:"作者",authorHandle:"reader",publishedAt:"2026-10-05",url:"https://x.com/reader/status/10",media:[],links:[],quotedText:"",contentStatus:"complete"}};
 invoke.mockImplementation(async(command:string,args?:{status:string;tags:string[]})=>{
   if(command==="set_collection_properties"){item.status=args!.status;item.tags=args!.tags;return "已保存";}
   return command==="list_collection_items"?{...initial,items:[item],total:1,matched:1,running:true}:command==="get_collection_storage"?{...storage,running:true,job:{id:1,running:true,phase:"saving",source:"bookmarks",outcome:""}}:"";
 });
 await mount();await act(async()=>container.querySelector<HTMLElement>('[aria-label="阅读：同步时编辑"]')!.click());
 expect(container.querySelector<HTMLButtonElement>('button[aria-label="阅读状态"]')!.disabled).toBe(false);
 await click("阅读状态");await act(async()=>[...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(b=>b.textContent?.includes("进行中"))!.click());
 expect(item.status).toBe("in_progress");await click("编辑标签");await input(container.querySelector<HTMLInputElement>('[aria-label="搜索或创建标签"]')!,"后台编辑");await click("创建 后台编辑");
 expect(item.tags).toEqual(["后台编辑"]);expect(invoke).not.toHaveBeenCalledWith("sync_x_bookmarks",expect.anything());
 expect(container.querySelector<HTMLButtonElement>(".collection-read-control")!.disabled).toBe(false);
});

it("allows frequency changes while protecting the active save destination",async()=>{
 const active={...storage,running:true,job:{id:1,running:true,phase:"saving",source:"bookmarks",outcome:""}};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,running:true}:command==="get_collection_storage"?active:"频率已保存");
 await mount();await click("同步与连接");await click("设置");await click("保存位置与同步频率");
 const dialog=container.querySelector<HTMLDialogElement>("dialog[open]")!;
 expect(dialog.querySelector<HTMLInputElement>('input[type="radio"]')!.disabled).toBe(true);
 const interval=dialog.querySelector<HTMLInputElement>("#collection-interval")!;expect(interval.disabled).toBe(false);
 await input(interval,"15");await click("保存同步频率");
 expect(invoke).toHaveBeenCalledWith("save_collection_storage",{config:{...storage.config,autoSyncMinutes:15}});
});

it("keeps Telegram manual sync and tdl setup available during an X run",async()=>{
 const page={...initial,running:true,sources:[...initial.sources,{id:"telegram",count:1,connected:true,paired:true,canResume:false,status:""}]};
 const active={...storage,running:true,telegramRunning:false,tdl:{installed:true,version:"0.20.4",enabled:false,ready:false,running:false,phase:"",status:"",bytes:0,proxy:""}};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?page:command==="get_collection_storage"?active:"");
 await mount();await click("同步与连接");
 const actions=[...container.querySelectorAll<HTMLButtonElement>('.collection-source-sync button[aria-label^="立即同步"]')];expect(actions[0].disabled).toBe(true);expect(actions[1].disabled).toBe(true);expect(actions[2].disabled).toBe(false);
 await act(async()=>actions[2].click());expect(invoke).toHaveBeenCalledWith("sync_x_bookmarks",{source:"telegram",restart:true});
 await click("设置");await expand("Telegram 历史与大附件");await click("登录 Telegram 账号");expect(invoke).toHaveBeenCalledWith("login_telegram_tdl",{method:"qr"});
 await click("补取历史与附件");expect(invoke).toHaveBeenCalledWith("sync_telegram_tdl",undefined);
});

it("keeps storage settings in sync management and removes duplicate toolbar controls",async()=>{
 await mount();
 expect(container.querySelector('.collection-header-tools>[aria-label="保存位置与同步频率"]')).toBeNull();
 expect(container.querySelector(".collection-count")).toBeNull();
 expect(container.querySelector('[aria-label="补写与重试附件"]')).toBeNull();
 const filter=container.querySelector('[aria-label="筛选"]')!;
 expect(filter.querySelector(".lucide-list-filter")).toBeTruthy();expect(filter.querySelector("small")).toBeNull();
 await click("同步与连接");await click("设置");expect(container.querySelector('.collection-sync-popover [aria-label="保存位置与同步频率"]')).toBeTruthy();
 await click("保存位置与同步频率");expect(container.querySelectorAll("dialog")[1].open).toBe(true);
});
it("resizes each table column without changing its neighbors and persists widths per view",async()=>{
 const item={key:"x:width",collectedAt:1791165600000,read:false,savedMedia:[],post:{id:"width",text:"表格列宽验证",authorName:"作者",authorHandle:"reader",publishedAt:"2026-10-05",url:"https://x.com/reader/status/width",quotedText:"",contentStatus:"complete",links:[],media:[],source:"bookmarks"}};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[item],total:1,matched:1,unread:1}:storage);
 await mount();await click("表格");
 const handles=container.querySelectorAll('[role="separator"]');expect(handles.length).toBe(7);
 const resize=container.querySelector<HTMLElement>('[aria-label="调整内容列宽"]')!;
 async function pointer(type:string,x:number){await act(async()=>{const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,button:0});Object.defineProperty(event,"pointerId",{value:1});(type==="pointerdown"?resize:document).dispatchEvent(event);});}
 await pointer("pointerdown",100);await pointer("pointermove",220);await pointer("pointerup",220);
 expect(document.body.style.cursor).toBe("");expect(document.body.style.userSelect).toBe("");
 const columns=container.querySelectorAll<HTMLTableColElement>("col");expect(columns[1].style.width).toBe("540px");expect(columns[3].style.width).toBe("200px");
 expect(container.querySelector('[aria-label="阅读详情"]')).toBeNull();
 await pointer("pointermove",500);expect(columns[1].style.width).toBe("540px");
 await act(async()=>root.unmount());root=createRoot(container);await mount();
 expect(container.querySelectorAll<HTMLTableColElement>("col")[1].style.width).toBe("540px");
 await click("列表");await click("表格");expect(container.querySelectorAll<HTMLTableColElement>("col")[1].style.width).toBe("540px");
 const current=container.querySelector<HTMLElement>('[aria-label="调整内容列宽"]')!;
 await act(async()=>current.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true})));
 expect(container.querySelectorAll<HTMLTableColElement>("col")[1].style.width).toBe("524px");
});

it("keeps sorting independent from filters and layout while persisting the current view",async()=>{
 await mount();await click("筛选");
 expect(container.querySelector('.collection-query-tools [aria-label="排序方式"]')).toBeNull();
 expect(container.querySelector('.collection-query-tools [aria-label="切换排序方向"]')).toBeNull();
 const filter=container.querySelector('[aria-label="筛选"]')!;
 expect(filter.nextElementSibling?.querySelector('[aria-label="排序"]')).toBeTruthy();
 await input(container.querySelector<HTMLSelectElement>('[aria-label="阅读状态筛选"]')!,"unread");
 await click("排序");
 expect(container.querySelector('[role="dialog"][aria-label="排序设置"]')).toBeTruthy();
 await input(container.querySelector<HTMLSelectElement>('[aria-label="排序方式"]')!,"published");
 await input(container.querySelector<HTMLSelectElement>('[aria-label="排序方向"]')!,"asc");
 await act(async()=>vi.advanceTimersByTimeAsync(160));
 expect(invoke).toHaveBeenCalledWith("list_collection_items",expect.objectContaining({sort:"published",ascending:true,status:"unread",offset:0}));
 await click("清除筛选");await act(async()=>vi.advanceTimersByTimeAsync(160));
 expect(invoke).toHaveBeenCalledWith("list_collection_items",expect.objectContaining({sort:"published",ascending:true,status:"all",offset:0}));
 await click("表格");expect(container.querySelector('[aria-label="排序设置"]')).toBeNull();
 await click("排序");expect(container.querySelector<HTMLSelectElement>('[aria-label="排序方式"]')?.value).toBe("published");
 await click("列表");await click("排序");
 expect(container.querySelector<HTMLSelectElement>('[aria-label="排序方式"]')?.value).toBe("published");
 expect(container.querySelector<HTMLSelectElement>('[aria-label="排序方向"]')?.value).toBe("asc");
 await act(async()=>root.unmount());root=createRoot(container);await mount();await click("排序");
 expect(container.querySelector<HTMLSelectElement>('[aria-label="排序方式"]')?.value).toBe("published");
 expect(container.querySelector<HTMLSelectElement>('[aria-label="排序方向"]')?.value).toBe("asc");
 await click("重置排序");await act(async()=>vi.advanceTimersByTimeAsync(160));
 expect(invoke).toHaveBeenCalledWith("list_collection_items",expect.objectContaining({sort:"collected",ascending:false,status:"all"}));
});

it("dismisses the sort popover on escape or outside input and restores trigger focus",async()=>{
 await mount();await click("排序");
 const field=container.querySelector<HTMLSelectElement>('[aria-label="排序方式"]')!;
 expect(document.activeElement).toBe(field);
 await act(async()=>field.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
 expect(container.querySelector('[aria-label="排序设置"]')).toBeNull();
 expect(document.activeElement).toBe(container.querySelector('[aria-label="排序"]'));
 await click("排序");
 await act(async()=>container.querySelector('[aria-label="筛选"]')!.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true})));
 expect(container.querySelector('[aria-label="排序设置"]')).toBeNull();
 expect(container.querySelector('[aria-label="排序"]')?.getAttribute("aria-expanded")).toBe("false");
});

it("supports all fields and persists several ordered sort conditions",async()=>{
 await mount();await click("排序");
 const field=container.querySelector<HTMLSelectElement>('[aria-label="排序方式"]')!;
 expect([...field.options].map(option=>option.textContent)).toEqual(["内容","状态","标签","来源","作者","发布时间","收藏时间","附件","喜欢","保存到"]);
 await input(field,"status");await input(container.querySelector<HTMLSelectElement>('[aria-label="排序方向"]')!,"asc");
 await click("添加排序");await input(container.querySelector<HTMLSelectElement>('[aria-label="第 2 条排序属性"]')!,"author");
 await click("添加排序");await input(container.querySelector<HTMLSelectElement>('[aria-label="第 3 条排序属性"]')!,"published");
 await input(container.querySelector<HTMLSelectElement>('[aria-label="第 3 条排序方向"]')!,"desc");
 await act(async()=>vi.advanceTimersByTimeAsync(160));
 const expected=[{field:"status",ascending:true},{field:"author",ascending:true},{field:"published",ascending:false}];
 expect(invoke).toHaveBeenCalledWith("list_collection_items",expect.objectContaining({sorts:expected,offset:0}));
 expect(container.querySelector<HTMLSelectElement>('[aria-label="第 2 条排序属性"]')?.querySelector<HTMLOptionElement>('option[value="status"]')?.disabled).toBe(true);
 await act(async()=>container.querySelector('[aria-label="调整第 3 条排序优先级"]')!.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true})));
 await act(async()=>vi.advanceTimersByTimeAsync(160));
 expect(invoke).toHaveBeenCalledWith("list_collection_items",expect.objectContaining({sorts:[expected[0],expected[2],expected[1]]}));
 await act(async()=>root.unmount());root=createRoot(container);await mount();await click("排序");
 expect(container.querySelector<HTMLSelectElement>('[aria-label="第 2 条排序属性"]')?.value).toBe("published");
 await click("删除第 2 条排序");await act(async()=>vi.advanceTimersByTimeAsync(160));
 expect(invoke).toHaveBeenCalledWith("list_collection_items",expect.objectContaining({sorts:[expected[0],expected[1]]}));
});

it("keeps failed tdl installation retryable and blocks duplicate installation",async()=>{
 let rejectInstall!:(reason:string)=>void;
 invoke.mockImplementation((command:string)=>command==="install_telegram_tdl"?new Promise((_,reject)=>{rejectInstall=reject;}):Promise.resolve(command==="list_collection_items"?initial:command==="get_collection_storage"?storage:""));
 await mount();await click("同步与连接");await click("设置");await expand("Telegram 历史与大附件");await click("安装 tdl");
 const installing=[...container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="正在处理…")!;
 expect(installing.disabled).toBe(true);await act(async()=>installing.click());
 expect(invoke.mock.calls.filter(([name])=>name==="install_telegram_tdl")).toHaveLength(1);
 await act(async()=>rejectInstall("下载中断，请重试"));
 expect(container.querySelector('[role="alert"]')?.textContent).toContain("下载中断");
 expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="安装 tdl")?.disabled).toBe(false);
});

it("shows tdl login handoff while allowing its separate pause action",async()=>{
 const active={...storage,tdl:{installed:true,version:"0.20.4",enabled:true,ready:false,running:true,phase:"login",status:"请完成登录",bytes:0,proxy:""}};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?initial:command==="get_collection_storage"?active:"");
 await mount();await click("同步与连接");
 await click("设置");await expand("Telegram 历史与大附件");
 expect(container.textContent).toContain("已打开 tdl 验证码登录窗口");
 expect(container.querySelector<HTMLSelectElement>('[aria-label="tdl 登录方式"]')?.disabled).toBe(true);
 await click("暂停 tdl");expect(invoke).toHaveBeenCalledWith("cancel_telegram_tdl",undefined);
});

it("updates one post's thread content explicitly without launching bookmark or likes sync",async()=>{
 const post={id:"100",text:"主帖",authorName:"作者",authorHandle:"reader",publishedAt:"2026-10-05",url:"https://x.com/reader/status/100",quotedText:"",contentStatus:"complete",links:[],media:[],source:"bookmarks"};
 const item={key:"x:100",collectedAt:1791165600000,read:false,savedMedia:[],post:{...post,thread:[{...post,id:"101",text:"楼主续帖正文",url:"https://x.com/reader/status/101",quote:{...post,id:"90",text:"引用原帖正文",authorName:"另一位作者",url:"https://x.com/other/status/90"}}]}};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[item],total:1,matched:1,unread:1}:command==="get_collection_storage"?storage:"更新已开始");
 await mount();await act(async()=>container.querySelector<HTMLElement>('[aria-label="阅读：主帖"]')!.click());
 expect(container.querySelector('[aria-label="阅读详情"]')?.textContent).toContain("楼主续帖正文");
 expect(container.querySelector('.collection-quote')?.textContent).toContain("另一位作者");
 expect(invoke).not.toHaveBeenCalledWith("refresh_collection_content",expect.anything());
 await click("更新内容");expect(invoke).toHaveBeenCalledWith("refresh_collection_content",{key:"x:100"});
 expect(invoke).not.toHaveBeenCalledWith("sync_x_bookmarks",expect.anything());
 expect(invoke).not.toHaveBeenCalledWith("set_collection_properties",expect.anything());
});

it("requires reviewing a grounded task plan before executing the transfer",async()=>{
 const plan={status:"planned",libraryName:"滴答",destinationPath:"工作 / 整理",summary:"整理资料",reason:"来自用户行动",title:"",markdown:"",tasks:[{title:"整理收藏",projectName:"整理",content:"读取正文与附件",evidence:"用户要求整理",completion:"笔记已归档",checklist:["核对来源"]}],attachments:[{name:"资料.pdf",bytes:1024,readStatus:"read"}],warnings:[]};
 const operation={key:lifecycleItem.key,action:"move",target:"tasks",phase:"needs_review",error:"",plan};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[{...lifecycleItem,operation}],total:1,matched:1}:command==="get_collection_storage"?storage:command==="collection_library_operations"?[operation]:[]);
 await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());await click("查看处理方案");
 const dialog=container.querySelector('dialog[open]')!;expect(dialog.textContent).toContain("工作 / 整理");expect(dialog.textContent).toContain("笔记已归档");expect(dialog.textContent).toContain("资料.pdf");
 expect(invoke).not.toHaveBeenCalledWith("approve_collection_conversion",expect.anything());
 await click("按方案保存副本");expect(invoke).toHaveBeenCalledWith("approve_collection_conversion",{key:lifecycleItem.key,expectedTarget:operation.target});
});
it("does not submit unresolved scheduling requirements and lets the user revise them",async()=>{
 const operation={key:lifecycleItem.key,action:"move",target:"tasks",phase:"needs_review",error:"",plan:{status:"needs_input",libraryName:"滴答",destinationPath:"",summary:"需要调整约束",reason:"要求原生循环，但当前适配器尚未支持",title:"",markdown:"",tasks:[],attachments:[],warnings:[]}};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[{...lifecycleItem,operation}],total:1,matched:1}:command==="get_collection_storage"?storage:command==="collection_library_operations"?[operation]:[]);
 await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());await click("查看处理方案");
 expect(container.querySelector('dialog[open]')?.textContent).not.toContain("按方案保存副本");
 await input(container.querySelector<HTMLTextAreaElement>('[aria-label="补充处理目标"]')!,"先保存为一次性任务，不设置循环");await click("重新生成方案");
 expect(invoke).toHaveBeenCalledWith("regenerate_collection_conversion",{key:lifecycleItem.key,goal:"先保存为一次性任务，不设置循环",expectedTarget:operation.target});
 expect(invoke).not.toHaveBeenCalledWith("approve_collection_conversion",expect.anything());
});
it("shows reference saving as automatic and reuses the existing attachment session",async()=>{
 const url="https://x.com/i/status/2107184548169543693";
 const plan={provider:"dida365",status:"planned",libraryName:"滴答",destinationPath:"参考资料",summary:"保存原文和附件供查阅",reason:"保留参考内容",title:"",markdown:"",tasks:[{kind:"reference",title:url,content:"原文第一段\n\n最后一条回复",evidence:"保存请求",completion:"供查阅",checklist:[]}],attachments:[{name:"原始图片.jpg",bytes:2048,readStatus:"image"}],warnings:[]};
 const operation={key:lifecycleItem.key,action:"move",target:"tasks",phase:"ready",error:"",plan};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[{...lifecycleItem,operation}],total:1,matched:1}:command==="get_collection_storage"?storage:command==="collection_library_operations"?[operation]:[]);
 await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());
 await click("同步与连接");await click("处理记录");await click("查看方案");
 const dialog=container.querySelector('dialog[open]')!;
 expect(dialog.textContent).toContain("保存为滴答笔记");expect(dialog.textContent).toContain(url);
 expect(dialog.querySelector("pre")?.textContent).toBe("原文第一段\n\n最后一条回复");
 expect(dialog.textContent).not.toContain("按方案保存副本");expect(dialog.textContent).not.toContain("检查滴答网页登录");
 expect(dialog.querySelector('[aria-label="补充处理目标"]')).toBeNull();
 expect(invoke).not.toHaveBeenCalledWith("approve_collection_conversion",expect.anything());
 expect(invoke).not.toHaveBeenCalledWith("open_dida_attachment_login",expect.anything());
});
it("shows archived videos as preserved files instead of an analysis failure",async()=>{
 const plan={provider:"craft",status:"planned",libraryName:"Car",destinationPath:"Car / 日记 / 2026-10-06 / 原始资料",summary:"保存到今日页面，保留原文和附件",reason:"未确定合适的主题分类",title:"原始资料",markdown:"原文和视频来源",tasks:[],attachments:[{name:"video.mp4",bytes:4096,readStatus:"upload_only",mime:"video/mp4"},{name:"legacy.MOV",bytes:4096,readStatus:"unread_media"}],warnings:[]};
 const operation={key:lifecycleItem.key,action:"move",target:"car",phase:"ready",error:"",plan};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[{...lifecycleItem,operation}],total:1,matched:1}:command==="get_collection_storage"?storage:command==="collection_library_operations"?[operation]:[]);
 await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());
 await click("同步与连接");await click("处理记录");await click("查看方案");
 const dialog=container.querySelector('dialog[open]')!;
 expect(dialog.textContent).toContain("Car / 日记 / 2026-10-06");
 expect(dialog.querySelectorAll("li")).toHaveLength(2);
 expect(dialog.textContent?.match(/原视频，随正文保存/g)).toHaveLength(2);
 expect(dialog.textContent).not.toContain("尚未识别正文");
 expect(dialog.textContent).not.toContain("请补充目标");
});

it("shows Craft oversized files as skipped instead of upload failures",async()=>{
 const plan={provider:"craft",status:"planned",libraryName:"Car",destinationPath:"Car / 日记 / 2026-10-06 / 原始资料",summary:"保存到今日页面，保留原文和附件",reason:"未确定合适的主题分类",title:"原始资料",markdown:"原文和视频来源",tasks:[],attachments:[{name:"video.mp4",bytes:11100000,readStatus:"upload_only",mime:"video/mp4"},{name:"legacy.MOV",bytes:11100000,readStatus:"unread_media"}],warnings:[]};
 const operation={key:lifecycleItem.key,action:"move",target:"car",phase:"ready",error:"",plan};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[{...lifecycleItem,operation}],total:1,matched:1}:command==="get_collection_storage"?storage:command==="collection_library_operations"?[operation]:[]);
 await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());
 await click("同步与连接");await click("处理记录");await click("查看方案");
 const dialog=container.querySelector('dialog[open]')!;
 expect(dialog.textContent).toContain("Car / 日记 / 2026-10-06");
 expect(dialog.querySelectorAll("li")).toHaveLength(2);
 expect(dialog.textContent?.match(/超过 5 MB，跳过上传并保留原链接/g)).toHaveLength(2);
 expect(dialog.textContent).not.toContain("尚未识别正文");
 expect(dialog.textContent).not.toContain("请补充目标");
});

it("cancels an older failed reference save and removes its processing record",async()=>{
 const plan={provider:"dida365",status:"planned",libraryName:"滴答",destinationPath:"参考资料",summary:"保存参考内容",reason:"",title:"",markdown:"",tasks:[{kind:"reference",title:"https://source",content:"原文",evidence:"",completion:"",checklist:[]}],attachments:[],warnings:[]};
 const operation={key:lifecycleItem.key,action:"move",target:"tasks",phase:"partial",error:"资料库尚未连接",plan};
 let cancelled=false;let complete!:()=>void;
 invoke.mockImplementation((command:string)=>command==="cancel_collection_conversion"?new Promise<void>(resolve=>{complete=()=>{cancelled=true;resolve();};}):Promise.resolve(command==="list_collection_items"?{...initial,items:[{...lifecycleItem,operation:cancelled?null:operation}],total:1,matched:1}:command==="get_collection_storage"?storage:command==="collection_library_operations"?(cancelled?[]:[operation]):[]));
 await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());await click("查看处理记录");
 await click("取消方案");
 const cancel=[...container.querySelectorAll<HTMLButtonElement>("dialog[open] button")].find(b=>b.textContent==="取消方案")!;
 expect(cancel.disabled).toBe(true);await act(async()=>cancel.click());
 expect(invoke.mock.calls.filter(([command])=>command==="cancel_collection_conversion")).toHaveLength(1);
 await act(async()=>complete());
 expect(container.querySelector("dialog[open]")).toBeNull();
 await click("同步与连接");
 expect(container.textContent).toContain("方案已取消，原内容和附件保留");
 expect(container.textContent).not.toContain("查看处理记录");
 expect(invoke).not.toHaveBeenCalledWith("approve_collection_conversion",expect.anything());
});

it("routes cancellation failures to the bottom information bar while keeping the plan actionable",async()=>{
 const operation={key:lifecycleItem.key,action:"move",target:"tasks",phase:"partial",error:"旧错误",plan:{status:"planned",libraryName:"滴答",destinationPath:"参考资料",summary:"保存",reason:"",title:"",markdown:"",tasks:[],attachments:[],warnings:[]}};
 const message="方案状态已改变，请刷新后重试";
 invoke.mockImplementation(async(command:string)=>{if(command==="cancel_collection_conversion")throw message;return command==="list_collection_items"?{...initial,items:[{...lifecycleItem,operation}],total:1,matched:1}:command==="get_collection_storage"?storage:command==="collection_library_operations"?[operation]:[];});
 await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());await click("查看处理记录");await click("取消方案");
 const dialog=container.querySelector<HTMLDialogElement>("dialog[open]")!;
 expect(dialog.open).toBe(true);expect(dialog.querySelector('footer [role="alert"]')?.textContent).toBe(message);expect(dialog.querySelector('pre [role="alert"]')).toBeNull();expect(container.querySelector('.test-footer-operation[role="alert"]')?.textContent).toBe(message);
 expect([...dialog.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent==="取消方案")?.disabled).toBe(false);
});
it.each([{auth:false,error:"附件超过上传上限"},{auth:true,error:"滴答附件登录失效"}])("offers attachment login only for an actual authentication failure ($auth)",async({auth,error})=>{
 const plan={provider:"dida365",status:"planned",libraryName:"滴答",destinationPath:"参考资料",summary:"保存参考内容",reason:"",title:"",markdown:"",tasks:[{kind:"reference",title:"https://source",content:"原文",evidence:"保存请求",completion:"供查阅",checklist:[]}],attachments:[{name:"图片.jpg",bytes:2048,readStatus:"image"}],warnings:[]};
 const operation={key:lifecycleItem.key,action:"move",target:"tasks",phase:"partial",error,attachmentLoginRequired:auth,plan};
 invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?{...initial,items:[{...lifecycleItem,operation}],total:1,matched:1}:command==="get_collection_storage"?storage:command==="collection_library_operations"?[operation]:[]);
 await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());await click("查看处理记录");
 const login=[...container.querySelectorAll<HTMLButtonElement>("dialog[open] button")].find(b=>b.textContent==="检查滴答网页登录");
 expect(!!login).toBe(auth);
 if(auth){await click("检查滴答网页登录");expect(invoke).toHaveBeenCalledWith("open_dida_attachment_login");}
 else{expect(invoke).not.toHaveBeenCalledWith("open_dida_attachment_login",expect.anything());}
});

it("cancels a partially written task while keeping a nonblocking retained-copy record",async()=>{
 const message="方案已取消；已写入的内容和附件保留，后续不再自动补齐";
 const plan={provider:"dida365",status:"planned",libraryName:"滴答",destinationPath:"参考资料",summary:"保存原文",reason:"",title:"",markdown:"",tasks:[{kind:"reference",title:"https://source",content:"原文",evidence:"",completion:"",checklist:[]}],attachments:[],warnings:[]};
 let cancelled=false;
 const operation=()=>({key:lifecycleItem.key,action:"move",target:"tasks",phase:cancelled?"cancelled":"partial",error:cancelled?message:"滴答附件读回失败（HTTP 500）",plan});
 invoke.mockImplementation(async(command:string)=>{if(command==="cancel_collection_conversion"){cancelled=true;return message;}return command==="list_collection_items"?{...initial,items:[{...lifecycleItem,operation:operation()}],total:1,matched:1}:command==="get_collection_storage"?storage:command==="collection_library_operations"?[operation()]:[];});
 await mount();await act(async()=>container.querySelector<HTMLElement>(".collection-row")!.click());await click("查看处理记录");await click("取消方案");
 expect(container.querySelector("dialog[open]")).toBeNull();
 expect(container.querySelector<HTMLButtonElement>('[aria-label="选择保存资料库"]')?.disabled).toBe(false);
 await click("查看已取消记录");
 const dialog=container.querySelector<HTMLDialogElement>("dialog[open]")!;
 expect(dialog.textContent).toContain("已取消的保存记录");expect(dialog.querySelector('footer [role="status"]')?.textContent).toBe(message);expect(container.querySelector('.test-footer-operation')?.textContent).toBe(message);
 expect(dialog.textContent).not.toContain("继续补齐");expect(dialog.textContent).not.toContain("取消方案");expect(dialog.textContent).not.toContain("检查滴答网页登录");
 await click("关闭记录");await click("选择保存资料库");
 expect(container.querySelector<HTMLButtonElement>('[aria-label="默认保存位置"]')?.disabled).toBe(true);
 expect(invoke).not.toHaveBeenCalledWith("approve_collection_conversion",expect.anything());
});

function readingPointer(type: string, clientX: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 4 }, clientX: { value: clientX } });
  return event;
}
it("remembers a dragged reading preview width and keeps both panels within the available area", async () => {
  const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: 1100 } as DOMRect));
  invoke.mockImplementation(async command => command === "list_collection_items" ? { ...initial, total: 1, matched: 1, items: [lifecycleItem] } : command === "get_collection_storage" ? storage : []);
  try {
    await mount(); await act(async () => container.querySelector<HTMLElement>(".collection-row")!.click());
    const divider = container.querySelector<HTMLElement>('[aria-label="调整阅读预览宽度"]')!;
    expect(divider.getAttribute("aria-valuenow")).toBe("520");
    await act(async () => divider.dispatchEvent(readingPointer("pointerdown", 600)));
    await act(async () => window.dispatchEvent(readingPointer("pointermove", 500)));
    expect(divider.getAttribute("aria-valuenow")).toBe("620");
    await act(async () => window.dispatchEvent(readingPointer("pointerup", 500)));
    expect(localStorage.getItem("hub.collection.preview-width-v1")).toBe("620");
    expect(document.body.classList.contains("resizing-reading-preview")).toBe(false);
    await act(async () => root.render(null)); await mount();
    await act(async () => container.querySelector<HTMLElement>(".collection-row")!.click());
    expect(container.querySelector('[aria-label="调整阅读预览宽度"]')?.getAttribute("aria-valuenow")).toBe("620");
  } finally { measure.mockRestore(); }
});
it("adjusts the reading divider with the keyboard and clamps an oversized saved width", async () => {
  localStorage.setItem("hub.collection.preview-width-v1", "1400");
  const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: 1000 } as DOMRect));
  invoke.mockImplementation(async command => command === "list_collection_items" ? { ...initial, total: 1, matched: 1, items: [lifecycleItem] } : command === "get_collection_storage" ? storage : []);
  try {
    await mount(); await act(async () => container.querySelector<HTMLElement>(".collection-row")!.click());
    const divider = container.querySelector<HTMLElement>('[aria-label="调整阅读预览宽度"]')!;
    const key = async (key: string, shiftKey = false) => act(async () => divider.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true })));
    expect(divider.getAttribute("aria-valuenow")).toBe("692");
    await key("Home"); expect(divider.getAttribute("aria-valuenow")).toBe("300");
    await key("ArrowLeft"); expect(divider.getAttribute("aria-valuenow")).toBe("316");
    await key("ArrowLeft", true); expect(divider.getAttribute("aria-valuenow")).toBe("356");
    await key("End"); expect(divider.getAttribute("aria-valuenow")).toBe("692");
    await key("Enter"); expect(divider.getAttribute("aria-valuenow")).toBe("520");
    expect(localStorage.getItem("hub.collection.preview-width-v1")).toBe("520");
  } finally { measure.mockRestore(); }
});
it("switches a narrow reading area to the preview and provides a way back to the list", async () => {
  const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: 580 } as DOMRect));
  invoke.mockImplementation(async command => command === "list_collection_items" ? { ...initial, total: 1, matched: 1, items: [lifecycleItem] } : command === "get_collection_storage" ? storage : []);
  try {
    await mount(); await act(async () => container.querySelector<HTMLElement>(".collection-row")!.click());
    expect(container.querySelector(".collection-body")?.classList.contains("compact-preview")).toBe(true);
    expect(container.querySelector('[aria-label="阅读布局"]')).toBeTruthy();
    expect(container.querySelector<HTMLElement>(".collection-browse-controls")?.hidden).toBe(true);
    expect(container.querySelector('[aria-label="返回阅读列表"] .lucide-arrow-left')).toBeTruthy();
    expect(container.querySelector('[aria-label="调整阅读预览宽度"]')?.getAttribute("tabindex")).toBe("-1");
    await click("返回阅读列表");
    expect(container.querySelector('[aria-label="阅读详情"]')).toBeNull();
    expect(container.querySelector(".collection-body")?.classList.contains("has-preview")).toBe(false);
    expect(container.querySelector<HTMLElement>(".collection-browse-controls")?.hidden).toBe(false);
  } finally { measure.mockRestore(); }
});
it("removes a selected library destination without requesting remote deletion", async () => {
  const libraries = [{ id: "craft-main", name: "Main", provider: "craft", connected: true, documentCount: 0 }];
  const item = { ...lifecycleItem, destinationId: "craft-main", destinationIds: ["craft-main"], storageLocations: [{ kind: "hub", name: "Hub", isDefault: true }, { kind: "craft", name: "Main", libraryId: "craft-main", copyState: "saved" }] };
  invoke.mockImplementation(async command => command === "list_collection_items" ? { ...initial, total: 1, matched: 1, items: [item] } : command === "get_collection_storage" ? storage : command === "list_libraries" ? libraries : "已取消此库选择，已写入内容保留");
  await mount(); await act(async () => container.querySelector<HTMLElement>(".collection-row")!.click()); await click("选择保存资料库");
  const option = container.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"] .collection-library-badge')?.closest("button") as HTMLButtonElement;
  expect(option).toBeTruthy(); expect(option.disabled).toBe(false); await act(async () => option.click());
  expect(invoke).toHaveBeenCalledWith("remove_collection_library_destination", { key: item.key, destination: "craft-main" });
  expect(invoke.mock.calls.some(([command]) => ["set_collection_lifecycle", "delete_task", "delete_document"].includes(command))).toBe(false);
});
it("filters and refreshes Dida later reading through the connected library while X is running", async () => {
  const dida = { ...lifecycleItem, key: "dida:account:task", post: { ...lifecycleItem.post, source: "dida", text: "从滴答导入的阅读内容", url: "https://dida365.com/webapp/#p/inbox/tasks/task" } };
  const didaPage = { ...initial, total: 1, matched: 1, items: [dida], sources: [...initial.sources, { id: "dida", count: 1, connected: true, canResume: false, status: "" }] };
  const runningStorage = { ...storage, running: true, job: { id: 1, running: true, source: "bookmarks", outcome: "", phase: "fetching", processed: 0, total: 0, downloadedBytes: 0, fileBytes: 0 } };
  invoke.mockImplementation(async command => command === "list_collection_items" ? didaPage : command === "get_collection_storage" ? runningStorage : []);
  await mount(); await act(async () => container.querySelector<HTMLButtonElement>(".collection-chip-dida")!.click());
  await act(async () => vi.advanceTimersByTimeAsync(160));
  expect(invoke).toHaveBeenCalledWith("list_collection_items", expect.objectContaining({ source: "dida" }));
  await click("同步与连接");
  const sync = [...container.querySelectorAll<HTMLButtonElement>('.collection-source-sync button[aria-label^="立即同步"]')].find(button => button.textContent === "滴答稍后读")!;
  expect(sync.disabled).toBe(false); await act(async () => sync.click());
  expect(invoke).toHaveBeenCalledWith("sync_x_bookmarks", { source: "dida", restart: true });
  await click("设置");await expand("连接管理");expect(container.querySelector(".collection-sync-connections")?.textContent).toContain("已连接滴答资料库；网页登录状态可单独检查");
  expect(container.querySelector("dialog[open]")).toBeNull();
  await act(async () => container.querySelector<HTMLElement>(".collection-row")!.click()); await click("更新内容");
  expect(invoke).toHaveBeenCalledWith("sync_x_bookmarks", { source: "dida", restart: false });
  expect(invoke.mock.calls.some(([command]) => command === "refresh_collection_content")).toBe(false);
});

it("uses the available reading area consistently when a narrow window still fits two panels", async () => {
  let available = 620;
  const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: available } as DOMRect));
  const originalWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 650 });
  invoke.mockImplementation(async command => command === "list_collection_items" ? { ...initial, total: 1, matched: 1, items: [lifecycleItem] } : command === "get_collection_storage" ? storage : []);
  try {
    await mount(); await act(async () => container.querySelector<HTMLElement>(".collection-row")!.click());
    const body = container.querySelector<HTMLElement>(".collection-body")!;
    expect(body.classList.contains("compact-preview")).toBe(false);
    expect(body.style.getPropertyValue("--reading-preview-width")).toBe("312px");
    expect(container.querySelector('[aria-label="调整阅读预览宽度"]')?.getAttribute("tabindex")).toBe("0");
    available = 580; await act(async () => window.dispatchEvent(new Event("resize")));
    expect(body.classList.contains("compact-preview")).toBe(true);
    expect(container.querySelector('[aria-label="返回阅读列表"]')).toBeTruthy();
    available = 620; await act(async () => window.dispatchEvent(new Event("resize")));
    expect(body.classList.contains("compact-preview")).toBe(false);
    expect(container.querySelector('[aria-label="返回阅读列表"]')).toBeNull();
  } finally { measure.mockRestore(); Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth }); }
});
it("does not rewrite scroll position while scrolling and polling the reading list",async()=>{
 invoke.mockImplementation(async command=>command==="list_collection_items"?{...initial,items:[lifecycleItem],total:1,matched:1}:command==="get_collection_storage"?storage:[]);
 await mount();
 const database=container.querySelector<HTMLElement>(".collection-database")!;
 let position=0;const writes=vi.fn((value:number)=>{position=value;});
 Object.defineProperty(database,"scrollTop",{configurable:true,get:()=>position,set:writes});
 for(const value of [120,260,400,380,700]){
   position=value;await act(async()=>database.dispatchEvent(new Event("scroll",{bubbles:true})));
   await act(async()=>vi.advanceTimersByTimeAsync(2100));
   expect(position).toBe(value);
 }
 expect(writes).not.toHaveBeenCalled();
});

it("honors visible properties across list and board layouts without modifying article data", async () => {
  invoke.mockImplementation(async command => command === "list_collection_items" ? { ...initial, total: 1, matched: 1, items: [lifecycleItem] } : command === "get_collection_storage" ? storage : []);
  await mount();
  const property = (name: string) => [...container.querySelectorAll<HTMLLabelElement>(".collection-database-property")].find(label => label.textContent === name)!.querySelector<HTMLInputElement>("input")!;
  expect(container.querySelector('.collection-row [data-reading-property="author"]')?.textContent).toContain("作者");
  expect(container.querySelector(".collection-row .collection-source-badge")).toBeTruthy();
  await act(async () => { property("作者").click(); property("来源").click(); });
  expect(container.querySelector('.collection-row [data-reading-property="author"]')).toBeNull();
  expect(container.querySelector(".collection-row .collection-source-badge")).toBeNull();
  await click("看板"); await act(async () => vi.advanceTimersByTimeAsync(160));
  expect(container.querySelector('.collection-board article [data-reading-property="author"]')).toBeNull();
  expect(container.querySelector(".collection-board article .collection-source-badge")).toBeNull();
  await act(async () => property("作者").click());
  expect(container.querySelector('.collection-board article [data-reading-property="author"]')?.textContent).toBe("作者");
  expect(invoke.mock.calls.some(([command]) => /set_collection|move_collection|delete_collection/.test(command))).toBe(false);
});

it("applies saved condition colors in all four layouts while retaining the existing gallery rule priority", async () => {
  invoke.mockImplementation(async command => command === "list_collection_items" ? { ...initial, total: 1, matched: 1, items: [lifecycleItem] } : command === "get_collection_storage" ? storage : []);
  await mount();
  await input(container.querySelector<HTMLSelectElement>('[aria-label="阅读条件颜色"]')!, "status");
  expect(container.querySelector<HTMLElement>(".collection-row")?.style.background).toContain("color-mix");
  for (const [layout, selector] of [["表格", "tbody tr"], ["看板", ".collection-board article"], ["画廊", ".collection-gallery-card"]]) {
    await click(layout); await act(async () => vi.advanceTimersByTimeAsync(160));
    expect(container.querySelector<HTMLElement>(selector)?.style.background).toContain("color-mix");
  }
  await click("卡片配置");
  const colorPage = [...container.querySelectorAll<HTMLButtonElement>(".collection-config-menu button")].find(button => button.textContent?.includes("条件颜色"))!;
  await act(async () => colorPage.click()); await click("继续添加");
  await input(container.querySelector<HTMLInputElement>('[aria-label="条件值"]')!, "进行中");
  expect(container.querySelector<HTMLElement>(".collection-gallery-card")?.style.background).toBe("rgb(238, 245, 255)");
  await act(async () => root.unmount()); root = createRoot(container); await mount();
  expect(container.querySelector<HTMLElement>(".collection-gallery-card")?.style.background).toBe("rgb(238, 245, 255)");
  expect(container.querySelector<HTMLSelectElement>('[aria-label="阅读条件颜色"]')?.value).toBe("status");
  await click("列表");
  await input(container.querySelector<HTMLSelectElement>('[aria-label="阅读条件颜色"]')!, "none");
  expect(container.querySelector<HTMLElement>(".collection-row")?.style.background).toBe("");
  await click("表格"); await act(async () => vi.advanceTimersByTimeAsync(160));
  expect(container.querySelector<HTMLElement>("tbody tr")?.style.background).toBe("");
  await click("看板"); await act(async () => vi.advanceTimersByTimeAsync(160));
  expect(container.querySelector<HTMLElement>(".collection-board article")?.style.background).toBe("");
  await click("画廊"); await act(async () => vi.advanceTimersByTimeAsync(160));
  expect(container.querySelector<HTMLElement>(".collection-gallery-card")?.style.background).toBe("rgb(238, 245, 255)");
});

it("defaults local intake to manual and saves its interval separately from remote sync",async()=>{
  const localStorage={...storage,config:{...storage.config,mode:"obsidian",vaultPath:"D:/Sources"}};
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?initial:command==="get_collection_storage"?localStorage:"同步频率已保存");
  await mount();await click("同步与连接");await click("设置");await click("保存位置与同步频率");
  const input=container.querySelector<HTMLInputElement>("#local-sources-interval")!;
  expect(input.value).toBe("0");
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"120");input.dispatchEvent(new Event("input",{bubbles:true}));});
  expect(container.querySelector<HTMLInputElement>("#collection-interval")!.value).toBe("30");
  await click("保存设置");
  expect(invoke).toHaveBeenCalledWith("save_collection_storage",{config:expect.objectContaining({localSourcesMinutes:120,autoSyncMinutes:30,vaultPath:"D:/Sources"})});
  expect(invoke.mock.calls.some(([command])=>command==="check_local_reading_sources")).toBe(false);
});

it("checks local originals manually without triggering network sync or attachment exports",async()=>{
  const localStorage={...storage,config:{...storage.config,mode:"obsidian",vaultPath:"D:/Sources",localSourcesMinutes:0}};
  invoke.mockImplementation(async(command:string)=>command==="list_collection_items"?initial:command==="get_collection_storage"?localStorage:command==="check_local_reading_sources"?{files:8,changed:2,errors:0}:[]);
  await mount();await click("同步与连接");await click("设置");await click("保存位置与同步频率");
  await click("立即检查本地素材");
  expect(invoke).toHaveBeenCalledWith("check_local_reading_sources");
  expect(invoke.mock.calls.some(([command])=>["sync_x_bookmarks","save_collection_storage","export_collections_to_obsidian"].includes(command))).toBe(false);
});
