// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {it,expect,vi,beforeEach,afterEach} from "vitest";
import {useFlashcardStudyPlan} from "./useFlashcardStudyPlan";
const {planMock,cardsMock}=vi.hoisted(()=>({planMock:vi.fn(),cardsMock:vi.fn()}));
vi.mock("./FlashcardQueries",()=>({loadFlashcardReviewPlan:planMock,loadFlashcardsByIds:cardsMock}));
let host:HTMLDivElement,root:Root,owner:ReturnType<typeof useFlashcardStudyPlan>;
const started=vi.fn(),failed=vi.fn();
const metadata={sessionIds:[] as string[],sessionCount:1201,eligibleCount:1201,newAvailable:1201,newWaiting:0,revision:"1",asOf:100};
function Harness({includeSubdecks=false,enabled=true,refreshToken=1}:{includeSubdecks?:boolean;enabled?:boolean;refreshToken?:number}){owner=useFlashcardStudyPlan({deckId:"parent",scopeName:"Parent",includeSubdecks,sessionLimit:0,enabled,quota:0,refreshToken,decksToken:1,onStart:started,onError:failed});return null;}
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;vi.clearAllMocks();planMock.mockResolvedValue(metadata);cardsMock.mockResolvedValue([]);host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
async function render(includeSubdecks=false,enabled=true){await act(async()=>root.render(<Harness includeSubdecks={includeSubdecks} enabled={enabled}/>));}
it("requests counts without allocating an unlimited ID list until review starts",async()=>{
  await render();expect(planMock).toHaveBeenCalledWith("parent",0,false,false);expect(cardsMock).not.toHaveBeenCalled();expect(owner.plan.sessionCount).toBe(1201);
  planMock.mockResolvedValueOnce({...metadata,sessionIds:["tail"]});await act(async()=>{await owner.start();});
  expect(planMock).toHaveBeenLastCalledWith("parent",0,false);expect(cardsMock).toHaveBeenCalledWith(["tail"]);expect(started).toHaveBeenCalledTimes(1);
});
it("discards a full review plan if the descendant scope changes while it is pending",async()=>{
  await render();let resolve!:(value:typeof metadata)=>void;planMock.mockImplementationOnce(()=>new Promise(value=>{resolve=value;}));
  let pending!:Promise<boolean>;await act(async()=>{pending=owner.start();});
  await render(true);
  await act(async()=>{resolve({...metadata,sessionIds:["tail"]});await pending;});
  expect(cardsMock).not.toHaveBeenCalled();expect(started).not.toHaveBeenCalled();expect(owner.starting).toBe(false);
});
it("does not plan while inactive and drops replies after unmount",async()=>{
  await render(false,false);expect(planMock).not.toHaveBeenCalled();
  let resolve!:(value:typeof metadata)=>void;planMock.mockImplementationOnce(()=>new Promise(value=>{resolve=value;}));await render();
  await act(async()=>root.unmount());root=createRoot(host);resolve(metadata);await act(async()=>{await Promise.resolve();});expect(cardsMock).not.toHaveBeenCalled();expect(started).not.toHaveBeenCalled();expect(failed).not.toHaveBeenCalled();
});

it("keeps a requested round alive across a count-only background refresh",async()=>{
  await render();let resolve!:(value:typeof metadata)=>void;planMock.mockImplementationOnce(()=>new Promise(value=>{resolve=value;}));
  let pending!:Promise<boolean>;await act(async()=>{pending=owner.start();});
  await act(async()=>root.render(<Harness refreshToken={2}/>));
  await act(async()=>{resolve({...metadata,sessionIds:["tail"]});await pending;});
  expect(cardsMock).toHaveBeenCalledWith(["tail"]);expect(started).toHaveBeenCalledTimes(1);
});

it("starts an explicitly chosen deck from the library with the same native quota plan",async()=>{
  await render(false,false);
  planMock.mockResolvedValueOnce({...metadata,sessionIds:["chosen"]});
  cardsMock.mockResolvedValueOnce([{id:"chosen",status:"active"}]);
  await act(async()=>{await owner.start({deckId:"chosen-deck",scopeName:"Chosen",includeSubdecks:false});});
  expect(planMock).toHaveBeenCalledWith("chosen-deck",0,false);
  expect(started).toHaveBeenCalledWith([{id:"chosen",status:"active"}],"Chosen");
});
