// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {InsightHistoryLookup} from "./InsightHistoryLookup";
const {invoke,listeners}=vi.hoisted(()=>({invoke:vi.fn(),listeners:new Map<string,()=>void>()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async(name:string,fn:()=>void)=>{listeners.set(name,fn);return()=>listeners.delete(name);})}));
const current={kind:"note" as const,libraryId:"current",documentId:"now",pageId:null};
const candidate={locator:{...current,libraryId:"history",documentId:"old"},version:{kind:"document",fingerprint:"v1"},title:"旧方法",path:"old.md",libraryName:"历史库",snippet:"先核对小样",matchedTerms:["小样"]};
let host:HTMLDivElement,root:Root;const add=vi.fn(),preview=vi.fn();
const button=(name:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===name)!;
async function mount(notes=[current]){await act(async()=>root.render(<InsightHistoryLookup notes={notes} disabled={false} onAdd={add} onPreview={preview}/>));}
async function open(){await act(async()=>{host.querySelector('details')!.open=true;host.querySelector('details')!.dispatchEvent(new Event('toggle'));});}
async function search(){await open();await act(async()=>host.querySelector<HTMLInputElement>('fieldset input')!.click());await act(async()=>button('查找可能相关的旧资料').click());}
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);add.mockClear();preview.mockClear();listeners.clear();invoke.mockReset();invoke.mockImplementation(async(_,{args})=>{
 if(args.action==='insightHistoryLibraries')return {libraries:[{libraryId:'history',name:'历史库'}]};
 if(args.action==='insightHistorySearch')return {candidates:[candidate],queries:['小样'],limitReached:false,unavailableCandidates:0};
 if(args.action==='insightDiscoveryPreview')return {content:'先核对小样'};
 throw Error(args.action);
});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
it('requires explicit library choice, previews and version-checks only the selected addition without running a model',async()=>{
 await mount();await open();expect(button('查找可能相关的旧资料').disabled).toBe(true);
 await act(async()=>host.querySelector<HTMLInputElement>('fieldset input')!.click());await act(async()=>button('查找可能相关的旧资料').click());
 expect(invoke.mock.calls.find(([,v])=>v.args.action==='insightHistorySearch')?.[1].args).toMatchObject({libraryIds:['history'],notes:[current],query:''});
 await act(async()=>button('查看原文').click());expect(preview).toHaveBeenCalledWith(candidate);
 await act(async()=>button('加入本次资料').click());expect(add).toHaveBeenCalledWith(candidate);
 expect(invoke.mock.calls.every(([,v])=>!['respond','create','insightDiscoveryPrepare'].includes(v.args.action))).toBe(true);
});
it('discards a late lookup after the scope changes',async()=>{
 await mount();await open();await act(async()=>host.querySelector<HTMLInputElement>('fieldset input')!.click());let resolve!:(v:unknown)=>void;
 invoke.mockImplementationOnce(()=>new Promise(r=>resolve=r));await act(async()=>button('查找可能相关的旧资料').click());
 await mount([{...current,documentId:'different'}]);await act(async()=>resolve({candidates:[candidate],queries:['小样']}));
 expect(host.textContent).not.toContain('旧方法');expect(add).not.toHaveBeenCalled();
});
it('hides stale candidates on source invalidation and refuses an addition with changed version',async()=>{
 await mount();await search();invoke.mockRejectedValueOnce(Error('资料版本已变化'));await act(async()=>button('加入本次资料').click());
 expect(add).not.toHaveBeenCalled();expect(host.textContent).not.toContain('旧方法');expect(host.textContent).toContain('资料版本已变化');
 await act(async()=>listeners.get('library-runtime-updated')?.());expect(host.querySelectorAll('fieldset input')).toHaveLength(0);
});
it('keeps no-result honest and does not auto-select candidates',async()=>{
 await mount();await open();await act(async()=>host.querySelector<HTMLInputElement>('fieldset input')!.click());
 invoke.mockResolvedValueOnce({candidates:[],queries:['无匹配'],limitReached:false,unavailableCandidates:0});await act(async()=>button('查找可能相关的旧资料').click());
 expect(host.textContent).toContain('没有结果不表示不存在关联');expect(add).not.toHaveBeenCalled();
});
