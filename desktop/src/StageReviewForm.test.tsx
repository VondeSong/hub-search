// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,expect,it,vi} from "vitest";
import {StageReviewForm,initialReviewPlan,type ReviewView} from "./StageReviewForm";
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root,host:HTMLDivElement;
const loadWorks=async()=>[{id:"w",goal:"已有事项"}];
function button(text:string){return [...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent?.includes(text))!;}
async function click(text:string){await act(async()=>button(text).click());}
async function mount(){host=document.createElement("div");document.body.append(host);root=createRoot(host);const prepare=vi.fn(async(plan)=>({workId:"w",revision:3,config:{...plan,windows:[],methodVersion:"v1",asOf:"2026-11-14"},scope:{description:"已选资料",count:1},inputs:[]} as ReviewView));const open=vi.fn();await act(async()=>root.render(<StageReviewForm loadWorks={loadWorks} read={async()=>null} prepare={prepare} onOpenWork={open}/>));return {prepare,open};}
afterEach(async()=>{await act(async()=>root?.unmount());host?.remove();});
it("defaults to open exploration without themes or a forced time window",async()=>{await mount();expect(button("直接提问").getAttribute("aria-pressed")).toBe("true");expect(host.querySelector('[aria-label="回顾月份"]')).toBeNull();for(const theme of ["消费","健康","阅读","影视娱乐"])expect(button(theme).getAttribute("aria-pressed")).toBe("false");expect(button("保存范围").disabled).toBe(true);});
it("switching presets changes the question lens without selecting sources or invoking analysis",async()=>{const {prepare,open}=await mount();await click("对比去年同期");expect(host.querySelector('[aria-label="回顾月份"]')).not.toBeNull();expect((host.querySelector('[aria-label="回顾资料事项"]') as HTMLSelectElement).value).toBe("");await click("消费");await click("直接提问");expect(button("消费").getAttribute("aria-pressed")).toBe("true");expect(prepare).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();});
it("preparing an existing Work saves configuration but opens the assistant only explicitly",async()=>{const {prepare,open}=await mount();const select=host.querySelector('[aria-label="回顾资料事项"]') as HTMLSelectElement;await act(async()=>{select.value="w";select.dispatchEvent(new Event("change",{bubbles:true}));});await click("保存范围");expect(prepare).toHaveBeenCalledOnce();expect(prepare.mock.calls[0][0].themes).toEqual([]);expect(open).not.toHaveBeenCalled();await click("在助手中开始回顾");expect(open).toHaveBeenCalledWith("w");});
it("uses Shanghai calendar values independent of the browser timezone",()=>{expect(initialReviewPlan(new Date("2026-10-31T18:00:00Z")).month).toBe("2026-11");expect(initialReviewPlan(new Date("2026-10-31T18:00:00Z")).cutoff).toBe("2026-11-01T02:00:00+08:00");});
