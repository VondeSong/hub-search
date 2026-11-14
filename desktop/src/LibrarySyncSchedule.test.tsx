// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { LibrarySyncSchedule } from "./LibrarySyncSchedule";
const mocks=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn(),stop:vi.fn(),onRuntime:undefined as undefined|((event:{payload:{libraryId:string;activeOperations:number}})=>void)}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:mocks.listen}));
vi.mock("./CodexSuite",()=>({publishCodexNotice:vi.fn()}));
let root:Root,host:HTMLDivElement;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);mocks.invoke.mockReset();mocks.stop.mockReset();mocks.onRuntime=undefined;mocks.listen.mockImplementation(async(_name,callback)=>{mocks.onRuntime=callback;return mocks.stop;});mocks.invoke.mockImplementation(async(_command,{args})=>({libraryId:args.libraryId,minutes:args.action==="get"?null:args.minutes,globalMinutes:15,effectiveMinutes:args.minutes??15,stoppedAfterFailures:false}));});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function choose(value:string){await act(async()=>{const s=host.querySelector("select")!;s.value=value;s.dispatchEvent(new Event("change",{bubbles:true}));});}
it("saves just the selected library and restores inheritance explicitly",async()=>{
  await act(async()=>root.render(<><LibrarySyncSchedule libraryId="a" name="A"/><LibrarySyncSchedule libraryId="b" name="B"/></>));
  await choose("30");expect(mocks.invoke).toHaveBeenCalledWith("library_sync_schedule",{args:{action:"save",libraryId:"a",minutes:30}});
  expect(host.querySelectorAll("select")[1].value).toBe("inherit");
  await choose("0");expect(host.querySelector("select")!.value).toBe("0");
  await choose("inherit");expect(mocks.invoke).toHaveBeenLastCalledWith("library_sync_schedule",{args:{action:"save",libraryId:"a",minutes:null}});
});
it("validates custom intervals before saving and keeps failed changes reviewable",async()=>{
  await act(async()=>root.render(<LibrarySyncSchedule libraryId="a" name="A"/>));await choose("custom");
  const input=host.querySelector("input")!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"1441");input.dispatchEvent(new Event("input",{bubbles:true}));});
  expect([...host.querySelectorAll("button")].find(b=>b.textContent==="保存")!.disabled).toBe(true);
});
it("clears the old retry warning after this library finishes syncing without resetting an open interval draft",async()=>{
  mocks.invoke.mockResolvedValueOnce({libraryId:"a",minutes:null,globalMinutes:15,effectiveMinutes:15,stoppedAfterFailures:true});
  await act(async()=>root.render(<LibrarySyncSchedule libraryId="a" name="A"/>));
  expect(host.textContent).toContain("连续失败三次");
  await choose("custom");
  const input=host.querySelector("input")!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"45");input.dispatchEvent(new Event("input",{bubbles:true}));});
  const calls=mocks.invoke.mock.calls.length;
  await act(async()=>{mocks.onRuntime!({payload:{libraryId:"b",activeOperations:0}});mocks.onRuntime!({payload:{libraryId:"a",activeOperations:1}});});
  expect(mocks.invoke).toHaveBeenCalledTimes(calls);
  await act(async()=>mocks.onRuntime!({payload:{libraryId:"a",activeOperations:0}}));
  expect(host.textContent).not.toContain("连续失败三次");
  expect(host.querySelector("input")!.value).toBe("45");
});
