// @vitest-environment jsdom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { it,expect,vi,beforeEach,afterEach } from "vitest";
import { useMobileOverlayHistory } from "./useMobileOverlayHistory";
let host:HTMLDivElement,root:Root,owner:ReturnType<typeof useMobileOverlayHistory>;
const setters={setCaptureOpen:vi.fn(),setFiltersOpen:vi.fn(),setSettingsOpen:vi.fn(),setPreviewOpen:vi.fn(),setFlashcardsOpen:vi.fn(),setSelectedTag:vi.fn(),consumeSearchBack:vi.fn(()=>false)};
function Harness({enabled=true,filtersOpen=false,settingsOpen=false,captureOpen=false}:{enabled?:boolean;filtersOpen?:boolean;settingsOpen?:boolean;captureOpen?:boolean}){owner=useMobileOverlayHistory({enabled,filtersOpen,settingsOpen,captureOpen,...setters});return null;}
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;vi.clearAllMocks();window.history.replaceState({},"");host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
it("uses one preview history entry and closes it before applying the base route",async()=>{
  const push=vi.spyOn(window.history,"pushState"),route=vi.fn();
  await act(async()=>root.render(<Harness/>)); owner.bindRoute(route);
  await act(async()=>{owner.openPreview();owner.openPreview();});expect(push).toHaveBeenCalledTimes(1);
  await act(async()=>window.dispatchEvent(new PopStateEvent("popstate",{state:{hubMobileRoute:"search"}})));
  expect(setters.setPreviewOpen).toHaveBeenLastCalledWith(false);expect(route).not.toHaveBeenCalled();
  await act(async()=>window.dispatchEvent(new PopStateEvent("popstate",{state:{hubMobileRoute:"journals",hubMobileTag:"tag"}})));
  expect(route).toHaveBeenCalledWith("journals");expect(setters.setSelectedTag).toHaveBeenCalledWith("tag");
});
it("keeps native back handling ahead of route navigation and removes its listener on unmount",async()=>{
  const route=vi.fn();await act(async()=>root.render(<Harness/>));owner.bindRoute(route);setters.consumeSearchBack.mockReturnValueOnce(true);
  await act(async()=>window.dispatchEvent(new PopStateEvent("popstate",{state:{hubMobileRoute:"history"}})));expect(route).not.toHaveBeenCalled();
  await act(async()=>root.unmount());root=createRoot(host);
  window.dispatchEvent(new PopStateEvent("popstate",{state:{hubMobileRoute:"history"}}));expect(route).not.toHaveBeenCalled();
});
it("does not modify desktop history when opening or closing an overlay",async()=>{
  const push=vi.spyOn(window.history,"pushState"),back=vi.spyOn(window.history,"back");await act(async()=>root.render(<Harness enabled={false}/>));
  await act(async()=>{owner.openFlashcards();owner.closeFlashcards();});expect(push).not.toHaveBeenCalled();expect(back).not.toHaveBeenCalled();expect(setters.setFlashcardsOpen).toHaveBeenLastCalledWith(false);
});
it("opens reading from a search preview without leaving a stale preview Back owner",async()=>{
 const route=vi.fn();await act(async()=>root.render(<Harness/>));owner.bindRoute(route);
 window.history.replaceState({hubMobileRoute:"search"},"");
 await act(async()=>owner.openPreview());
 await act(async()=>{expect(owner.openRouteFromPreview("collections")).toBe(true);});
 expect(window.history.state).toEqual({hubMobileRoute:"collections"});expect(route).toHaveBeenLastCalledWith("collections");
 await act(async()=>{window.history.back();await new Promise(r=>setTimeout(r,30));});
 expect(route).toHaveBeenLastCalledWith("search");
});
it("replaces the preview layer when a search result opens a flashcard",async()=>{
 const route=vi.fn();await act(async()=>root.render(<Harness/>));owner.bindRoute(route);
 window.history.replaceState({hubMobileRoute:"search"},"");await act(async()=>owner.openPreview());
 const length=window.history.length;await act(async()=>owner.openFlashcards());
 expect(window.history.length).toBe(length);expect(window.history.state.hubFlashcards).toBe(true);
 await act(async()=>{window.history.back();await new Promise(r=>setTimeout(r,30));});
 expect(setters.setFlashcardsOpen).toHaveBeenLastCalledWith(false);
});

it.each(["agents", "connections"])("replaces standalone review with %s and releases its Back owner", async destination => {
  const route = vi.fn(); await act(async () => root.render(<Harness />)); owner.bindRoute(route);
  window.history.replaceState({ hubMobileRoute: "browse" }, "");
  await act(async () => owner.openFlashcards());
  const length = window.history.length;
  await act(async () => expect(owner.openRouteFromFlashcards(destination)).toBe(true));
  expect(window.history.length).toBe(length);
  expect(window.history.state).toEqual({ hubMobileRoute: destination });
  expect(setters.setFlashcardsOpen).toHaveBeenLastCalledWith(false);
  expect(route).toHaveBeenLastCalledWith(destination);
  await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(route).toHaveBeenLastCalledWith("browse");
});

it("closes capture on Android back without navigating the underlying page", async()=>{
  const route=vi.fn(); await act(async()=>root.render(<Harness captureOpen/>)); owner.bindRoute(route);
  expect(window.history.state.hubQuickCapture).toBe(true);
  window.history.replaceState({hubMobileRoute:"browse"},"");
  await act(async()=>window.dispatchEvent(new PopStateEvent("popstate",{state:window.history.state})));
  expect(setters.setCaptureOpen).toHaveBeenLastCalledWith(false); expect(route).not.toHaveBeenCalled();
});
it("does not pop the destination when saving replaces the capture entry", async()=>{
  const back=vi.spyOn(window.history,"back"); await act(async()=>root.render(<Harness captureOpen/>));
  window.history.replaceState({hubMobileRoute:"journals"},"");
  await act(async()=>root.render(<Harness/>)); expect(back).not.toHaveBeenCalled();
});
it("hands capture to sync settings without creating another entry", async()=>{
  const push=vi.spyOn(window.history,"pushState"),back=vi.spyOn(window.history,"back");
  await act(async()=>root.render(<Harness captureOpen/>));
  window.history.replaceState({hubMobileRoute:"browse",hubSettings:true},"");
  await act(async()=>root.render(<Harness settingsOpen/>));
  expect(push).toHaveBeenCalledTimes(1); expect(back).not.toHaveBeenCalled();
  window.history.replaceState({hubMobileRoute:"browse"},"");
  await act(async()=>window.dispatchEvent(new PopStateEvent("popstate",{state:window.history.state})));
  expect(setters.setSettingsOpen).toHaveBeenLastCalledWith(false);
});
