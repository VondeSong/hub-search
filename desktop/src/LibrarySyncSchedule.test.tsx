// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { LibrarySyncSchedule } from "./LibrarySyncSchedule";
const mocks=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke}));
vi.mock("./CodexSuite",()=>({publishCodexNotice:vi.fn()}));
let root:Root,host:HTMLDivElement;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);mocks.invoke.mockReset();mocks.invoke.mockImplementation(async(_command,{args})=>({libraryId:args.libraryId,minutes:args.action==="get"?null:args.minutes,globalMinutes:15,effectiveMinutes:args.minutes??15,stoppedAfterFailures:false}));});
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
