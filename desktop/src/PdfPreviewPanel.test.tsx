// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {PdfPreviewPanel,type PdfSearchPages} from "./PdfPreviewPanel";
import type {SearchResult} from "./SearchTypes";
const mock=vi.hoisted(()=>({invoke:vi.fn()}));vi.mock("@tauri-apps/api/core",()=>({invoke:mock.invoke}));
let root:Root,box:HTMLDivElement;
const selected={id:"p14",sourceItemId:"pdf1",title:"Manual",contentType:"pdf_page",provider:"craft",spaceId:"space",documentId:"doc"}as SearchResult;
const metadata:PdfSearchPages={sourceId:"pdf1",query:"signal",pageCount:120,indexedPageCount:24,availableTextPageCount:24,hitPages:[2,14,110],extractionStatus:"partial",failedPageCount:1,revisionStatus:"legacy",truncated:false};
const pageChange=vi.fn();
function props(overrides:Record<string,unknown>={}){return {selected,query:"signal",page:14,preview:{text:"signal",pageNumber:14,pageCount:120,sourceType:"pdf_native" as const,textStatus:"indexed"as const,imageDataUrl:"data:image/png;base64,AA=="},loading:false,terms:["signal"],onPageChange:pageChange,...overrides};}
beforeEach(()=>{vi.useFakeTimers();mock.invoke.mockReset();pageChange.mockReset();(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;box=document.createElement("div");document.body.append(box);root=createRoot(box);mock.invoke.mockResolvedValue(metadata);});
afterEach(async()=>{await act(async()=>root.unmount());box.remove();vi.useRealTimers();});
async function render(overrides:Record<string,unknown>={}){await act(async()=>root.render(<PdfPreviewPanel {...props(overrides)}/>));await act(async()=>vi.advanceTimersByTimeAsync(250));}
async function click(text:string){const b=[...box.querySelectorAll("button")].find(b=>b.textContent===text)!;await act(async()=>b.click());}
it("uses original page numbers in hit navigation and preserves page on full mode",async()=>{
 await render();expect(box.textContent).toContain("24/120");expect(box.textContent).toContain("不能当作无命中");expect(box.textContent).toContain("历史页文字");
 await click("仅命中页 · 3");expect(pageChange).toHaveBeenLastCalledWith(14);expect(box.textContent).toContain("第 2/3 个命中，原文第 14 页");
 await act(async()=>box.querySelector<HTMLButtonElement>('[aria-label="下一个命中页"]')!.click());expect(pageChange).toHaveBeenLastCalledWith(110);
 await click("全文");expect(box.textContent).toContain("保留原文第 14 页");
});
it("validates page entry and zooms without requesting another native render",async()=>{
 await render();const input=box.querySelector<HTMLInputElement>('[aria-label="PDF 页码"]')!;
 const setValue=(value:string)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));};
 await act(async()=>{setValue("121");});await act(async()=>box.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(box.querySelector('[role="alert"]')?.textContent).toContain("1–120");expect(pageChange).not.toHaveBeenCalled();
 await act(async()=>{setValue("57");});await act(async()=>box.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));expect(pageChange).toHaveBeenLastCalledWith(57);
 const before=mock.invoke.mock.calls.length;await act(async()=>box.querySelector<HTMLButtonElement>('[aria-label="放大 PDF"]')!.click());expect(box.querySelector<HTMLSelectElement>('[aria-label="PDF 缩放"]')!.value).toBe("125");
 await click("恢复适配");expect(mock.invoke).toHaveBeenCalledTimes(before);
});
it("distinguishes no search and missing extraction from no match",async()=>{
 mock.invoke.mockResolvedValue({...metadata,query:"",indexedPageCount:0,hitPages:[]});await render({query:""});expect(box.textContent).toContain("尚未搜索");
 mock.invoke.mockResolvedValue({...metadata,query:"signal",indexedPageCount:0,hitPages:[],extractionStatus:"failed"});await render();expect(box.textContent).toContain("不能据此判断 PDF 没有命中");expect(box.textContent).toContain("原生文字提取失败");
 expect([...box.querySelectorAll("button")].find(b=>b.textContent?.startsWith("仅命中页"))!.disabled).toBe(true);
});
it("ignores old document metadata responses and keeps full viewing after lookup failure",async()=>{
 let finish!:(value:PdfSearchPages)=>void;mock.invoke.mockImplementation((_cmd:string,args:{resultId:string})=>args.resultId==="p14"?new Promise<PdfSearchPages>(yes=>{finish=yes;}):Promise.resolve({...metadata,sourceId:"pdf2",hitPages:[7]}));
 await render();await render({selected:{...selected,id:"new",sourceItemId:"pdf2"},page:7});
 await act(async()=>finish(metadata));expect(box.textContent).toContain("1 个命中页");expect(box.textContent).not.toContain("3 个命中页");
 mock.invoke.mockRejectedValue(new Error("offline index read failed"));await render({selected:{...selected,id:"failed",sourceItemId:"pdf2"}});expect(box.textContent).toContain("全文浏览仍可使用");expect(box.querySelector('[aria-label="PDF 页码"]')).not.toBeNull();
});
