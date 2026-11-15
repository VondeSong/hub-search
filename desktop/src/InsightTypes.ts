export type InsightMethodDependency={kind:string;title:string};
export function insightSourceChanged(eventName:string,payload:unknown,libraryIds?:string[]){
 // The native automatic-backup poll emits null even when no source changed.
 if(eventName==="data-portability-updated"&&payload===null)return false;
 if(eventName==="library-runtime-updated"&&libraryIds?.length&&payload&&typeof payload==="object"&&"libraryId" in payload&&typeof payload.libraryId==="string"&&"state" in payload&&(payload.state==="idle"||payload.state==="running"))return libraryIds.includes(payload.libraryId);
 return true;
}
import type { Evidence } from "./AgentDelivery";
export type InsightSource={ evidenceId:string;quote?:string;excerpt:Evidence & {locator:unknown;version:unknown;facts?:{provider?:string;unreadImageCount?:number}} };
export type InsightOrigin={workId:string;runId:string;deliveryRecordId:string;deliveryHash:string;generatedAt:number};
export type InsightSnapshot={text:string;methodDependencies?:InsightMethodDependency[];reviewOutcome?:{kind:"maintain"|"revise";comparison:string;previousRevision:number;origin:InsightOrigin};reviewDependency?:{nature:"fact"|"selfReported"|"coOccurrence"|"inference";dependencies:{kind:string;quote:string;nature?:string;version?:number}[]};origin:InsightOrigin;sourceCitations:InsightSource[];contextDependencies:InsightSource[];userContextRefs:{feedbackId:string;text:string;nature:string}[]};
export type InsightReason={id:string;kind:string;active:boolean;reference?:{feedbackId?:string}};
export type InsightEvent={id:string;kind:string;targetRevision:number;createdAt:number;restricted?:boolean;body?:{text?:string;kind?:string;feedbackId?:string;withdrawn?:boolean;[key:string]:unknown}|null};
export type Insight={id:string;workId:string;workTitle?:string;headRevision:number;rowRevision:number;createdAt:number;updatedAt:number;processingState:"attention"|"later"|"done";snoozeUntil:number|null;followed:boolean;starred?:boolean;perspective?:string;validity:"available"|"review"|"unavailable";reasons:InsightReason[];snapshot?:InsightSnapshot;events?:InsightEvent[];contentRevision?:number;restorePending?:boolean;checking?:boolean;supersedes?:string[]};
export type InsightCandidate={methodDependencies?:InsightMethodDependency[];reviewDependency?:InsightSnapshot["reviewDependency"];findingPointer:string;eligibility:"verifiedSources"|"unavailable";text?:string;sourceCitations?:InsightSource[];reason?:string};
export type InsightCandidates={origin:InsightOrigin;candidates:InsightCandidate[];contextOptions?:{evidenceId:string;title:string;locator:unknown;version:unknown}[];reason?:string};
export type InsightDelivery={deliveryRecordId:string;deliveryHash:string;runId:string;generatedAt:number;findingCount:number;status:string};
export type InsightList={items:Insight[];hasMore:boolean;nextBefore?:{createdAt:number;id:string}|null};
