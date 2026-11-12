import {REPORT_FIXTURES,SOURCE_FIXTURES} from "./insight-reports";
import {isSourceAccessible,type LedgerState} from "./insight-ledger";
export function recallFixture(state:LedgerState,work:string,query:string){
 const term=query.trim().toLowerCase();if(!term||term.length>120)return [];
 const ids=new Set(REPORT_FIXTURES.filter(r=>r.workId===work).flatMap(r=>r.findings.flatMap(f=>f.evidence.filter(e=>e.origin==="record").map(e=>e.sourceId))));
 return SOURCE_FIXTURES.filter(s=>ids.has(s.id)&&isSourceAccessible(s.id,state)).flatMap(s=>{
  const version=s.versions.find(v=>v.version===state.sources[s.id]?.version);
  return version&&(s.title+"\n"+version.content).toLowerCase().includes(term)?[{id:s.id,title:s.title,content:version.content}]:[];
 }).slice(0,10);
}
