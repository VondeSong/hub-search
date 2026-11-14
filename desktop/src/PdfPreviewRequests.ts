type Request<T> = { key:string; run:()=>Promise<T>; resolve:(value:T)=>void; reject:(reason:unknown)=>void; promise:Promise<T> };
const cancelled = () => Object.assign(new Error("PDF request superseded"), {name:"AbortError"});

/** One render in flight and one latest pending page; zoom never enters this queue. */
export class PdfPreviewRequests<T> {
  private active?: Request<T>;
  private pending?: Request<T>;
  request(key:string,run:()=>Promise<T>):Promise<T> {
    if(this.active?.key===key) {this.cancelPending();return this.active.promise;}
    if(this.pending?.key===key) return this.pending.promise;
    let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;
    const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
    const entry={key,run,resolve,reject,promise};
    if(this.active){this.cancelPending();this.pending=entry;}else void this.start(entry);
    return promise;
  }
  cancelPending(){this.pending?.reject(cancelled());this.pending=undefined;}
  private async start(entry:Request<T>){
    this.active=entry;
    try{entry.resolve(await entry.run());}catch(reason){entry.reject(reason);}
    finally{this.active=undefined;const next=this.pending;this.pending=undefined;if(next)void this.start(next);}
  }
}
