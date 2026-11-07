// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import {AgentImages,type ImageGrant} from "./AgentImages";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
let host:HTMLDivElement,root:Root;
const grant=(n:number):ImageGrant=>({libraryId:"notes",documentId:"doc",sourceItemId:`image${n}`,inputVersion:`v${n}`,blobHash:String(n).repeat(64)});
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);vi.mocked(invoke).mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function click(text:string){await act(async()=>{[...host.querySelectorAll("button")].find(b=>b.textContent===text)!.click();});}
it("CN05B listing metadata does not grant pixels; explicit save sends pinned identities",async()=>{
 const save=vi.fn().mockResolvedValue(undefined);vi.mocked(invoke).mockResolvedValue({images:[{grant:grant(1),title:"图片一",mime:"image/png"}],hasMore:false});
 await act(async()=>root.render(<AgentImages current={[]} disabled={false} onApply={save}/>));await click("查找缓存图片");expect(save).not.toHaveBeenCalled();expect(host.querySelector("img")).toBeNull();
 await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());expect(save).not.toHaveBeenCalled();await click("添加到问题");expect(save.mock.calls[0][0].addImages).toEqual([grant(1)]);expect(save.mock.calls[0][0].removeImages).toEqual([]);expect(save.mock.calls[0][0].clientMessageId).toBeTruthy();
});
it("CN05B failed save preserves selection and retry identity, and withdrawal is explicit",async()=>{
 const save=vi.fn().mockRejectedValue("版本已变化");await act(async()=>root.render(<AgentImages current={[grant(1)]} disabled={false} onApply={save}/>));await click("移除原图");expect(host.textContent).toContain("旧回答将不可用");await click("添加到问题");expect(host.textContent).toContain("版本已变化");await click("添加到问题");expect(save.mock.calls[0][0]).toEqual(save.mock.calls[1][0]);expect(save.mock.calls[0][0].removeImages).toEqual([grant(1)]);
});
it("CN05B running work cannot change scope and the third image cannot be selected",async()=>{
 const save=vi.fn();vi.mocked(invoke).mockResolvedValue({images:[1,2,3].map(n=>({grant:grant(n),title:`图${n}`,mime:"image/png"})),hasMore:true});await act(async()=>root.render(<AgentImages current={[grant(1),grant(2)]} disabled={false} onApply={save}/>));await click("查找缓存图片");expect(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[2].disabled).toBe(true);expect(host.textContent).toContain("缩小标题范围");await act(async()=>root.render(<AgentImages current={[grant(1),grant(2)]} disabled={true} onApply={save}/>));expect([...host.querySelectorAll("button")].every(b=>b.disabled)).toBe(true);expect(save).not.toHaveBeenCalled();
});
