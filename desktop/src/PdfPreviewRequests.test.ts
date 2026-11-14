import {expect,it,vi} from "vitest";
import {PdfPreviewRequests} from "./PdfPreviewRequests";
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
it("renders one active page and only the latest pending page",async()=>{
 const queue=new PdfPreviewRequests<string>();const old=deferred<string>();const runOld=vi.fn(()=>old.promise),runDiscarded=vi.fn(async()=>"discarded"),runLast=vi.fn(async()=>"latest");
 const first=queue.request("doc:1",runOld);
 expect(queue.request("doc:1",runOld)).toBe(first);
 const discarded=queue.request("doc:2",runDiscarded).catch(error=>error.name);
 const last=queue.request("doc:110",runLast);
 expect(runOld).toHaveBeenCalledTimes(1);expect(runLast).not.toHaveBeenCalled();
 expect(await discarded).toBe("AbortError");old.resolve("old");
 expect(await first).toBe("old");expect(await last).toBe("latest");expect(runDiscarded).not.toHaveBeenCalled();
});
it("cancels pending work on a source switch and continues after an active failure",async()=>{
 const queue=new PdfPreviewRequests<string>();const active=deferred<string>();
 const first=queue.request("old",()=>active.promise);const pending=queue.request("old2",async()=>"never").catch(error=>error.name);
 queue.cancelPending();expect(await pending).toBe("AbortError");
 const next=queue.request("new",async()=>{throw new Error("read failed");}).catch(error=>error.message);
 active.resolve("done");await first;expect(await next).toBe("read failed");
 expect(await queue.request("new2",async()=>"ok")).toBe("ok");
});
it("drops an obsolete pending page when returning to the active page",async()=>{
 const queue=new PdfPreviewRequests<string>();const active=deferred<string>();
 const first=queue.request("page1",()=>active.promise);
 const skipped=vi.fn(async()=>"page2");const pending=queue.request("page2",skipped).catch(error=>error.name);
 expect(queue.request("page1",async()=>"duplicate")).toBe(first);
 expect(await pending).toBe("AbortError");active.resolve("page1");await first;
 expect(skipped).not.toHaveBeenCalled();
});
