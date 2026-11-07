// @vitest-environment jsdom
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSearchResultData } from "./useSearchResultData";
import type { SearchResult } from "./SearchTypes";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
const normalize = (value: unknown) => value as SearchResult[];
const filters = { craft:true, task:true, pdf:true, media:true, attachment:true };
const result = (id: string, libraryId="os") => ({id,entityKey:id,libraryId,title:id}) as SearchResult;
let root: Root;
let host: HTMLDivElement;
let current: {selected?: SearchResult; choose:(index:number)=>void};
const observed: string[] = [];
function Harness({query="",syncing=false,revision=0,selectionActive=true}) {
  const [,setError]=useState("");
  const {results,selectedIndex:index,setSelectedIndex:choose}=useSearchResultData({query,syncing,refreshRevision:revision,selectionActive,ready:true,hasSpaces:true,isComposing:false,
    spaceIds:null,folderId:"",updatedAfter:null,sourceFilters:filters,searchScope:"all",recentPageLimit:100,recentTaskLimit:100,
    normalizeResults:normalize,setError});
  current={selected:results[index],choose};
  observed.push(current.selected?.id ?? "empty");
  return <div>{results[index]?.title}</div>;
}
async function render(props={}) {await act(async()=>{root.render(<StrictMode><Harness {...props}/></StrictMode>);});await act(async()=>{await vi.advanceTimersByTimeAsync(300);});}
beforeEach(()=>{vi.useFakeTimers();invoke.mockReset();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();});
it.each(["recent","search"])("keeps the chosen source through background refresh and reordering: %s",async mode=>{
  const query=mode==="search"?"skill":"";
  invoke.mockResolvedValueOnce([result("first"),result("tabweave")]);
  await render({query});
  await act(async()=>current.choose(1));
  observed.length=0;
  invoke.mockResolvedValueOnce([result("tabweave"),result("first")]);
  await render({query,syncing:true});await render({query,syncing:false,revision:1});
  expect(current.selected?.id).toBe("tabweave");
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every(id => id === "tabweave")).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(2);
  invoke.mockResolvedValueOnce([result("other"),result("tabweave")]);
  await render({query:"changed query",revision:1});
  expect(current.selected?.id).toBe("other");
});
it("does not retain a removed source or substitute the same id from another library",async()=>{
  invoke.mockResolvedValueOnce([result("first"),result("tabweave")]);await render();
  await act(async()=>current.choose(1));
  invoke.mockResolvedValueOnce([result("safe"),result("tabweave","other-library")]);
  await render({revision:1});expect(current.selected?.id).toBe("safe");
});
it("leaves a sidebar selection position alone while refreshing inactive local search",async()=>{
  invoke.mockResolvedValueOnce([result("first"),result("second")]);await render();
  await act(async()=>current.choose(1));
  invoke.mockResolvedValueOnce([result("second"),result("first")]);
  await render({selectionActive:false,revision:1});
  expect(current.selected?.id).toBe("first");
});
