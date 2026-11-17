// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentPluginWriteRecord} from "./AgentPluginWriteRecord";
import type {PluginWriteAction} from "./AgentActionTypes";
let host:HTMLDivElement,root:Root;const onAction=vi.fn(async()=>{});
const draft:PluginWriteAction={id:"action",kind:"pluginWrite",state:"prepared",confirmationToken:"exact",payload:{targetUrl:"https://github.com/VondeSong/hub-search/issues/14",targetTitle:"本项目",arguments:{repo_full_name:"VondeSong/hub-search",pr_number:14,comment:"本轮实际进度"}}};
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);onAction.mockReset();});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function render(item=draft,revoked=false){await act(async()=>root.render(<AgentPluginWriteRecord item={item} disabled={false} revoked={revoked} onAction={onAction}/>));}
it("shows the immutable repository, target and comment, but never submits on render",async()=>{await render();expect(host.textContent).toContain("本轮实际进度");expect(host.textContent).toContain("VondeSong/hub-search");expect(onAction).not.toHaveBeenCalled();await act(async()=>host.querySelector<HTMLButtonElement>('button')!.click());expect(onAction).toHaveBeenCalledExactlyOnceWith({action:"submitPluginWrite",actionId:"action",confirmationToken:"exact"});});
it("offers only inspection after an unknown outcome and disables a revoked grant",async()=>{await render({...draft,state:"unknown"});expect(host.textContent).not.toContain("确认发布");await act(async()=>host.querySelector<HTMLButtonElement>('button')!.click());expect(onAction).toHaveBeenCalledExactlyOnceWith({action:"inspectPluginWrite",actionId:"action",confirmationToken:"exact"});await render(draft,true);expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);});
