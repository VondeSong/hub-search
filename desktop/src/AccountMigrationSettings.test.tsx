// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountMigrationSettings } from "./AccountMigrationSettings";
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke}));
let host:HTMLDivElement,root:Root;
const onPrepared=vi.fn(),onBusy=vi.fn();
const render=async(hasAccountCopy=false)=>{await act(async()=>root.render(<AccountMigrationSettings blocked={false} hasAccountCopy={hasAccountCopy} onBusyChange={onBusy} onPrepared={onPrepared}/>));};
const click=async(text:string)=>{const button=[...host.querySelectorAll("button")].find(b=>b.textContent===text);expect(button).toBeDefined();await act(async()=>button!.click());};
const type=async(input:HTMLInputElement,value:string)=>{await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});};
beforeEach(()=>{(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;onPrepared.mockClear();onBusy.mockClear();mocks.invoke.mockReset();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it("explains direct folder copy without a preparation action or credential read",async()=>{
 await render();
 expect(mocks.invoke).not.toHaveBeenCalled();
 expect(host.textContent).toContain("复制整个文件夹到新电脑");expect(host.textContent).toContain("Obsidian 原始库单独移动并重新加载");
 expect(host.textContent).not.toContain("检查并准备复制");
 expect(host.textContent).not.toContain("更新加密授权副本");expect(onPrepared).not.toHaveBeenCalled();
});
it("places only selected available credentials inside the data folder and clears the migration password",async()=>{
 mocks.invoke.mockImplementation(async(_command,{args})=>args.action==="account_catalog"?{entries:[{id:"oauth:one",label:"Craft",available:true},{id:"oauth:missing",label:"Unavailable",available:false}]}:{root:"D:/Hub Data",ready:true,warnings:[],hasAccountCopy:true});
 await render();await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
 const fields=host.querySelectorAll<HTMLInputElement>('input[type="password"]');await type(fields[0],"synthetic test password");await type(fields[1],"synthetic test password");await click("更新加密授权副本");
 expect(mocks.invoke.mock.calls[mocks.invoke.mock.calls.length-1]).toEqual(["data_portability",{args:{action:"prepare_accounts",ids:["oauth:one"],password:"synthetic test password"}}]);
 expect([...host.querySelectorAll<HTMLInputElement>('input[type="password"]')].every(input=>input.value==="")).toBe(true);
 expect(host.textContent).toContain("账号授权已加密放在同一目录中");
});
it("unlocks credentials from the copied folder, preserves existing accounts by default and never selects unknown accounts",async()=>{
 mocks.invoke.mockImplementation(async(_command,{args})=>args.action==="inspect_accounts"?{token:"checked",targetRoot:"E:/Copied Hub",entries:[{id:"oauth:new",label:"New",supported:true,conflict:false},{id:"oauth:old",label:"Existing",supported:true,conflict:true},{id:"unknown",label:"Unavailable",supported:false}]}:{results:[{label:"New",status:"imported"}],warnings:[]});
 await render(true);await type(host.querySelector<HTMLInputElement>('input[type="password"]')!,"synthetic test password");await click("解锁并检查授权");
 await click("恢复所选授权");expect(mocks.invoke.mock.calls[mocks.invoke.mock.calls.length-1]).toEqual(["data_portability",{args:{action:"import_accounts",token:"checked",targetRoot:"E:/Copied Hub",password:"synthetic test password",ids:["oauth:new"],overwrite:false}}]);
 expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");expect(host.textContent).toContain("New：已恢复");
});
