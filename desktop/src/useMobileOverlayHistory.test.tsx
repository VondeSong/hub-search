// @vitest-environment jsdom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { it,expect,vi,beforeEach,afterEach } from "vitest";
import { useMobileOverlayHistory } from "./useMobileOverlayHistory";
let host:HTMLDivElement,root:Root,owner:ReturnType<typeof useMobileOverlayHistory>;
const setters={setFiltersOpen:vi.fn(),setSettingsOpen:vi.fn(),setPreviewOpen:vi.fn(),setFlashcardsOpen:vi.fn(),setSelectedTag:vi.fn(),consumeSearchBack:vi.fn(()=>false)};
function Harness({enabled=true,filtersOpen=false,settingsOpen=false}:{enabled?:boolean;filtersOpen?:boolean;settingsOpen?:boolean}){owner=useMobileOverlayHistory({enabled,filtersOpen,settingsOpen,...setters});return null;}
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
