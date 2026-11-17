// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentActivity,type ActivityEvent,type ActivityRun} from "./AgentActivity";
import {ActivityIdentity,activityOperation,activitySites} from "./AgentActivityIdentity";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
it("distinguishes public file acquisition from browser interaction",()=>{
 expect(activityOperation({kind:"tool",operation:"fetchFile"} as ActivityEvent)).toBe("download");
 expect(activityOperation({kind:"tool",operation:"analyzeFiles"} as ActivityEvent)).toBe("compute");
});
vi.mock("@tauri-apps/api/core",()=>({invoke}));
let host:HTMLDivElement,root:Root;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);invoke.mockReset();invoke.mockResolvedValue(null);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const event=(patch:Partial<ActivityEvent>={}):ActivityEvent=>({id:"search",kind:"tool",operation:"search",label:"读取（旧标题）",state:"completed",createdAt:3000,sequence:1,...patch});
const run=(events:ActivityEvent[]):ActivityRun=>({runId:"r",revision:1,state:"completed",running:false,startedAt:0,finishedAt:5000,steps:events.length,events});
it("uses structured operation for both collapsed heading and expanded row",async()=>{
 const e=event();expect(activityOperation(e)).toBe("search");
 await act(async()=>root.render(<AgentActivity value={run([e])}/>));
 await act(async()=>host.querySelector<HTMLButtonElement>('.agent-activity-toggle')!.click());
 const group=host.querySelector<HTMLDetailsElement>('.agent-operation-group')!;
 expect(group.querySelector('summary [data-activity-icon]')?.getAttribute('data-activity-icon')).toBe('search');
 await act(async()=>group.querySelector('summary')!.click());
 expect(group.querySelector('.agent-activity-step [data-activity-icon]')?.getAttribute('data-activity-icon')).toBe('search');
 expect(group.textContent).toContain('已搜索资料');
});
it("keeps first sequence and user disclosure when a streamed item has a later update time",async()=>{
 const early=event({id:"early",createdAt:9000,sequence:1,label:"首次事件"});
 const later=event({id:"later",kind:"message",createdAt:2000,sequence:2,label:"后续说明"});
 await act(async()=>root.render(<AgentActivity value={{...run([later,early]),running:true}}/>));
 const group=host.querySelector<HTMLDetailsElement>('.agent-operation-group')!;
 await act(async()=>group.querySelector('summary')!.click());expect(group.open).toBe(true);
 await act(async()=>root.render(<AgentActivity value={{...run([later,{...early,updatedAt:20000,label:"首次事件更新"}]),running:true}}/>));
 expect(host.querySelector('.agent-activity-events')?.firstElementChild).toBe(group);
 expect(group.open).toBe(true);expect(group.textContent).toContain('首次事件更新');
});
it("deduplicates real public origins and refuses unsafe website references",()=>{
 const sites=activitySites([event({url:"https://github.com/a",sourceRefs:[{url:"https://github.com/b"},{url:"http://127.0.0.1/x"},{url:"https://user:secret@example.com"},{url:"https://notion.so/doc"}]})]);
 expect(sites.map(s=>new URL(s.url).hostname)).toEqual(["github.com","notion.so"]);
});
it("keeps a fixed fallback on icon failure and derives avatars only from actual identities",async()=>{
 invoke.mockRejectedValue(new Error("offline"));
 await act(async()=>root.render(<ActivityIdentity workId="identity-failure" events={[event({url:"https://github.com/a",agentIds:["actual-child"]}),event({url:"https://github.com/b",label:"两个代理已完成"})]}/>));
 expect(invoke).toHaveBeenCalledTimes(1);expect(invoke).toHaveBeenCalledWith("agent_investigation",{args:expect.objectContaining({action:"websiteIcon",id:"identity-failure",url:"https://github.com/a"})});expect(host.querySelectorAll('.agent-site-icon')).toHaveLength(1);
 expect(host.querySelectorAll('.agent-avatar')).toHaveLength(1);expect(host.querySelector('.agent-site-icon img')).toBeNull();
 expect(host.querySelector('svg[aria-label="子代理 -child"]')).not.toBeNull();
});

const tinyPng="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6JXsAAAAASUVORK5CYII=";
it.each([[tinyPng,true],["data:image/svg+xml;base64,PHN2Zy8+",false],["https://untrusted.example/icon.png",false]])("accepts only an inert host-approved raster icon (%s)",async(dataUrl,accepted)=>{
 invoke.mockResolvedValue({dataUrl});
 await act(async()=>root.render(<ActivityIdentity workId={'raster-'+dataUrl} events={[event({url:'https://github.com/a'})]}/>));
 const img=host.querySelector('.agent-site-icon img');
 expect(!!img).toBe(accepted);
 if(img){expect(img.getAttribute('width')).toBe('16');expect(img.getAttribute('height')).toBe('16');expect(img.getAttribute('alt')).toBe('');}
});
it("does not let an old icon request replace the current work or survive scope removal",async()=>{
 let resolveOld!:(value:{dataUrl:string})=>void;
 invoke.mockImplementation((_command,{args})=>args.id==='late-icon-old'?new Promise(resolve=>{resolveOld=resolve;}):Promise.resolve({dataUrl:tinyPng}));
 await act(async()=>root.render(<ActivityIdentity workId="late-icon-old" events={[event({url:'https://github.com/a'})]}/>));
 await act(async()=>root.render(<ActivityIdentity workId="late-icon-current" events={[event({url:'https://developers.openai.com/a'})]}/>));
 await act(async()=>resolveOld({dataUrl:'data:image/x-icon;base64,AAAA'}));
 expect(host.querySelector('.agent-site-icon')?.getAttribute('aria-label')).toBe('developers.openai.com');
 expect(host.querySelector('.agent-site-icon img')?.getAttribute('src')).toBe(tinyPng);
 await act(async()=>root.render(<ActivityIdentity events={[event({url:'https://developers.openai.com/a'})]}/>));
 expect(host.querySelector('.agent-site-icon img')).toBeNull();
});
