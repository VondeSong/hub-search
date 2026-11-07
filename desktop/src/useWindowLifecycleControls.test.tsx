// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke,listen,windowApi,capabilities } = vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn(),windowApi:vi.fn(),capabilities:{windowState:true,tray:false,mobile:false}}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen}));
vi.mock("@tauri-apps/api/window",()=>({getCurrentWindow:windowApi}));
vi.mock("./RuntimePlatform",()=>({runtimeCapabilities:capabilities}));
import { useWindowLifecycleControls } from "./useWindowLifecycleControls";
import { DEFAULT_APP_SETTINGS } from "./AppSettings";
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(finish=>{resolve=finish;});return {promise,resolve};};
let root:Root,host:HTMLDivElement;
const native={isVisible:vi.fn(),isMinimized:vi.fn(),outerPosition:vi.fn(),outerSize:vi.fn(),onMoved:vi.fn(),onResized:vi.fn(),onFocusChanged:vi.fn(),startDragging:vi.fn()};
beforeEach(()=>{
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT:boolean }).IS_REACT_ACT_ENVIRONMENT=true;
  Object.defineProperty(document,"hidden",{configurable:true,value:false}); window.localStorage.clear();
  invoke.mockReset();invoke.mockResolvedValue(undefined); listen.mockReset();listen.mockResolvedValue(vi.fn()); windowApi.mockReset();windowApi.mockReturnValue(native);
  Object.values(native).forEach(mock=>mock.mockReset()); native.isVisible.mockResolvedValue(true);native.isMinimized.mockResolvedValue(false);native.outerPosition.mockResolvedValue({x:10,y:20});native.outerSize.mockResolvedValue({width:1040,height:720});
  native.onMoved.mockResolvedValue(vi.fn());native.onResized.mockResolvedValue(vi.fn());
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();Reflect.deleteProperty(document,"hidden");delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?:boolean }).IS_REACT_ACT_ENVIRONMENT;});
const settings={...DEFAULT_APP_SETTINGS,rememberWindowPosition:false,hideOnFocusLost:false,resultsPanePercent:60};
it("keeps Hub visible on native focus loss while its assistant is open",async()=>{
  capabilities.tray=true;
  let focusChanged!:(event:{payload:boolean})=>void;
  native.onFocusChanged.mockImplementation(handler=>{focusChanged=handler;return Promise.resolve(vi.fn());});
  function Controls(){useWindowLifecycleControls({appSettings:{...settings,hideOnFocusLost:true},loadAppSettings:async()=>settings,searchInput:{current:null}});return <aside className="agent-panel"/>;}
  try {
    await act(async()=>root.render(<Controls/>));
    await act(async()=>focusChanged({payload:false}));
    expect(invoke).not.toHaveBeenCalled();
    host.querySelector<HTMLElement>("aside")!.hidden=true;
    await act(async()=>focusChanged({payload:false}));
    expect(invoke).toHaveBeenCalledExactlyOnceWith("hide_window");
  } finally {capabilities.tray=false;}
});

it("late startup settings cannot replace a split the user has already changed",async()=>{
  const load=deferred<typeof settings>();let owner!:ReturnType<typeof useWindowLifecycleControls>;
  function Controls(){owner=useWindowLifecycleControls({appSettings:settings,loadAppSettings:()=>load.promise,searchInput:{current:null}});return <output>{owner.resultsPanePercent}</output>;}
  await act(async()=>root.render(<Controls/>)); act(()=>owner.setResultsPanePercent(42));
  await act(async()=>load.resolve({...settings,resultsPanePercent:56})); expect(host.textContent).toBe("42");expect(invoke).not.toHaveBeenCalled();
});
it("splitter completions coalesce behind one physical window persistence producer",async()=>{
  const nativeReply=deferred<void>(),load=vi.fn().mockResolvedValue(settings);let owner!:ReturnType<typeof useWindowLifecycleControls>;
  invoke.mockImplementationOnce(()=>nativeReply.promise).mockResolvedValue(undefined);
  function Controls(){owner=useWindowLifecycleControls({appSettings:settings,loadAppSettings:load,searchInput:{current:null}});return <output>{owner.resultsPanePercent}</output>;}
  await act(async()=>root.render(<Controls/>));
  act(()=>{owner.savePreviewSplit(35);owner.savePreviewSplit(45);owner.savePreviewSplit(55);});
  await act(async()=>{await Promise.resolve();await Promise.resolve();});expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0][1].resultsPanePercent).toBe(35);
  await act(async()=>{nativeReply.resolve();await Promise.resolve();await Promise.resolve();await Promise.resolve();});
  expect(invoke).toHaveBeenCalledTimes(2);expect(invoke.mock.calls[1][1].resultsPanePercent).toBe(55);expect(host.textContent).toBe("55");expect(localStorage.getItem("craft-search-preview-split-v1")).toBe("55");
});
it("late native geometry subscriptions are disposed after owner unmount and scheduled saves stop",async()=>{
  vi.useFakeTimers();const moved=deferred<()=>void>(),resized=deferred<()=>void>(),disposeMoved=vi.fn(),disposeResized=vi.fn(),load=deferred<typeof settings>();
  native.onMoved.mockReturnValue(moved.promise);native.onResized.mockReturnValue(resized.promise);
  function Controls(){useWindowLifecycleControls({appSettings:{...settings,rememberWindowPosition:true},loadAppSettings:()=>load.promise,searchInput:{current:null}});return null;}
  await act(async()=>root.render(<Controls/>));await act(async()=>root.render(null));
  await act(async()=>{moved.resolve(disposeMoved);resized.resolve(disposeResized);await vi.advanceTimersByTimeAsync(1000);});
  expect(disposeMoved).toHaveBeenCalledOnce();expect(disposeResized).toHaveBeenCalledOnce();expect(invoke).not.toHaveBeenCalled();
});

it("header dragging ignores portaled assistant menus and keeps its own title draggable",async()=>{
  native.startDragging.mockResolvedValue(undefined);
  function Header(){const owner=useWindowLifecycleControls({appSettings:settings,loadAppSettings:async()=>settings,searchInput:{current:null}});return <header onMouseDown={owner.startWindowDrag}><span>窗口标题</span>{createPortal(<details><summary>添加资料</summary><p>资料菜单</p></details>,document.body)}</header>;}
  await act(async()=>root.render(<Header/>));
  const menuDown=new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0});
  await act(async()=>{document.querySelector('summary')!.dispatchEvent(menuDown);});
  expect(menuDown.defaultPrevented).toBe(false);expect(native.startDragging).not.toHaveBeenCalled();
  const titleDown=new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:0});
  await act(async()=>{host.querySelector('span')!.dispatchEvent(titleDown);});
  expect(titleDown.defaultPrevented).toBe(true);expect(native.startDragging).toHaveBeenCalledOnce();
});
