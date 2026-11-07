// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { useLibraryRegistry } from "./useLibraryRegistry";
import { useLibraryConnections } from "./useLibraryConnections";
import { useManagedLibraryOperations } from "./useManagedLibraryOperations";
import type { LibrarySummary } from "./SearchTypes";
import type { useLibraryManagement } from "./LibraryManagement";
const library = (id: string):LibrarySummary => ({id,name:id,provider:"craft",connected:true,documentCount:0,lastSync:"0",excludedPaths:[]});
const deferred = <T,>() => { let resolve!: (value:T) => void; const promise = new Promise<T>(finish => {resolve=finish;}); return {promise,resolve}; };
let root:Root, host:HTMLDivElement;
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT:boolean }).IS_REACT_ACT_ENVIRONMENT=true;
  invoke.mockReset(); host=document.createElement("div"); document.body.append(host); root=createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?:boolean }).IS_REACT_ACT_ENVIRONMENT; });

it("publishes the local registry before slow restore and starts its producer once in StrictMode", async () => {
  const restore=deferred<void>(); let owner!:ReturnType<typeof useLibraryRegistry>;
  invoke.mockImplementation(command => command === "list_libraries" ? Promise.resolve([library("local")]) : restore.promise);
  function Registry(){owner=useLibraryRegistry(); return <output>{owner.ready ? owner.spaces.map(item=>item.id).join(",") : "loading"}</output>;}
  await act(async()=>root.render(<StrictMode><Registry/></StrictMode>)); await settle();
  expect(host.textContent).toBe("local"); expect(invoke.mock.calls.filter(call=>call[0]==="restore_connections")).toHaveLength(1);
  expect(invoke.mock.calls.filter(call=>call[0]==="list_libraries")).toHaveLength(1);
  await act(async()=>restore.resolve()); await settle();
  expect(owner.spaces.map(item=>item.id)).toEqual(["local"]);
});

it("an older list reply cannot replace a newer explicit reload", async () => {
  const old=deferred<LibrarySummary[]>(), newer=deferred<LibrarySummary[]>(), restore=deferred<void>();
  let owner!:ReturnType<typeof useLibraryRegistry>, count=0;
  invoke.mockImplementation(command=>command==="list_libraries" ? (++count===1 ? old.promise : newer.promise) : restore.promise);
  function Registry(){owner=useLibraryRegistry(); return <output>{owner.spaces.map(item=>item.id).join(",")}</output>;}
  await act(async()=>root.render(<Registry/>)); let reload!:Promise<LibrarySummary[]>;
  act(()=>{reload=owner.reloadSpaces();});
  await act(async()=>{newer.resolve([library("new")]); await reload;});
  await act(async()=>old.resolve([library("old")])); await settle();
  expect(host.textContent).toBe("new");
});

function connectionOptions(){return {spaces:[] as LibrarySummary[],ready:false,registryError:"",reloadSpaces:vi.fn().mockResolvedValue([]),refreshStatus:vi.fn().mockResolvedValue(undefined),libraryManagement:{libraries:{},accepting:{},refresh:vi.fn().mockResolvedValue(undefined),act:vi.fn()} as ReturnType<typeof useLibraryManagement>,selectOnlyLibrary:vi.fn(),selectLibraries:vi.fn(),searchInput:{current:null},showOperationStatus:vi.fn()};}
it("one admitted connection keeps the action locked until its native producer and refresh finish", async () => {
  const native=deferred<{spaceId:string}>(), options=connectionOptions(); let owner!:ReturnType<typeof useLibraryConnections>;
  invoke.mockReturnValue(native.promise);
  function Connections(){owner=useLibraryConnections(options); return <output>{owner.connectingAction ?? "idle"}</output>;}
  await act(async()=>root.render(<Connections/>)); act(()=>owner.setMcpUrl(" https://owned.test/mcp "));
  let run!:Promise<void>;
  act(()=>{run=owner.connect(); void owner.connectDida365();});
  expect(invoke).toHaveBeenCalledTimes(1); expect(host.textContent).toBe("craft");
  await act(async()=>{native.resolve({spaceId:"added"}); await run;});
  expect(options.selectOnlyLibrary).toHaveBeenCalledWith("added"); expect(options.libraryManagement.refresh).toHaveBeenCalledOnce(); expect(host.textContent).toBe("idle");
});

it("Feishu multi-source addition preserves every selected library and retires unmounted completions", async () => {
  const native=deferred<{spaceId:string}[]>(), options=connectionOptions(); let owner!:ReturnType<typeof useLibraryConnections>;
  invoke.mockReturnValue(native.promise);
  function Connections(){owner=useLibraryConnections(options); return null;}
  await act(async()=>root.render(<Connections/>));
  act(()=>{owner.setFeishuAuthorization({authorizationId:"owned-auth",spaces:[]});owner.setSelectedFeishuSpaceIds(["one","two"]);});
  let run!:Promise<void>; act(()=>{run=owner.addSelectedFeishuSpaces();});
  await act(async()=>{native.resolve([{spaceId:"one"},{spaceId:"two"}]);await run;});
  expect(options.selectLibraries).toHaveBeenCalledWith(["one","two"]);
  const late=deferred<{spaceId:string}>(); invoke.mockReturnValue(late.promise);
  act(()=>owner.setMcpUrl("https://owned.test/mcp")); act(()=>{run=owner.connect();});
  await act(async()=>root.render(null)); const refreshes=options.reloadSpaces.mock.calls.length;
  late.resolve({spaceId:"late"}); await run;
  expect(options.reloadSpaces).toHaveBeenCalledTimes(refreshes); expect(options.selectOnlyLibrary).not.toHaveBeenCalled();
});

function managedOptions(){return {libraryManagement:{libraries:{},accepting:{},refresh:vi.fn(),act:vi.fn().mockResolvedValue(undefined)} as ReturnType<typeof useLibraryManagement>,reloadSpaces:vi.fn().mockResolvedValue([]),refreshStatus:vi.fn().mockResolvedValue(undefined),removeLibrarySelection:vi.fn(),setConnectionError:vi.fn(),setConnectionErrorProvider:vi.fn(),setMaintenanceMessage:vi.fn()};}
it("rename accepts once and a late successful reply preserves a newly opened editor", async () => {
  const native=deferred<void>(), options=managedOptions(); let owner!:ReturnType<typeof useManagedLibraryOperations>;
  invoke.mockReturnValue(native.promise);
  function Managed(){owner=useManagedLibraryOperations(options);return <output>{owner.renamingLibraryId}:{owner.libraryNameDraft}</output>;}
  await act(async()=>root.render(<Managed/>)); act(()=>owner.beginRenameLibrary(library("one"))); act(()=>owner.setLibraryNameDraft("One renamed"));
  let run!:Promise<void>; act(()=>{run=owner.saveLibraryName();void owner.saveLibraryName();});
  expect(invoke).toHaveBeenCalledExactlyOnceWith("rename_library",{libraryId:"one",name:"One renamed"});
  act(()=>owner.beginRenameLibrary(library("two")));
  await act(async()=>{native.resolve();await run;}); expect(host.textContent).toBe("two:two");
});

it("library removal delegates once to the injected lifecycle and preserves selection semantics", async () => {
  const native=deferred<void>(), options=managedOptions(); let owner!:ReturnType<typeof useManagedLibraryOperations>;
  invoke.mockResolvedValue(undefined); vi.mocked(options.libraryManagement.act).mockImplementation(async()=>{await native.promise;return {libraryId:"one",state:"removing",phase:"",detail:"",activeOperations:0,pending:0,updatedAt:1};});
  vi.spyOn(window,"confirm").mockReturnValue(true);
  function Managed(){owner=useManagedLibraryOperations(options);return null;}
  await act(async()=>root.render(<Managed/>)); let run!:Promise<void>;
  act(()=>{run=owner.removeSpace(library("one"));void owner.removeSpace(library("one"));}); await settle();
  expect(options.libraryManagement.act).toHaveBeenCalledExactlyOnceWith("one","remove");
  expect(invoke).toHaveBeenCalledExactlyOnceWith("get_collection_storage");
  await act(async()=>{native.resolve();await run;}); expect(options.removeLibrarySelection).toHaveBeenCalledExactlyOnceWith("one");
});
