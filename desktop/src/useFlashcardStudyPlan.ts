import {useCallback,useEffect,useRef,useState} from "react";
import {loadFlashcardReviewPlan,loadFlashcardsByIds,type FlashcardReviewPlan} from "./FlashcardQueries";
import type {Flashcard} from "./FlashcardTypes";

const empty=():FlashcardReviewPlan=>({sessionIds:[],sessionCount:0,eligibleCount:0,newAvailable:0,newWaiting:0,revision:"0",asOf:0});
type Options={
  deckId:string|null;scopeName:string;includeSubdecks:boolean;sessionLimit:number;enabled:boolean;
  quota:number;refreshToken:unknown;decksToken:unknown;
  onStart:(cards:Flashcard[],scopeName:string)=>void;onError:(message:string)=>void;
};

/** Owns plan metadata and admission of a review round. Full IDs/bodies are
 * requested only after Start; stale scope replies cannot start another scope. */
export function useFlashcardStudyPlan(options:Options){
  const scopeKey=JSON.stringify([options.deckId,options.scopeName,options.includeSubdecks,options.sessionLimit,options.enabled,options.quota]);
  const latest=useRef(options);latest.current=options;
  const owner=useRef({key:scopeKey,generation:0,planGeneration:0,mounted:true,starting:false});
  if(owner.current.key!==scopeKey){owner.current.key=scopeKey;owner.current.generation++;owner.current.planGeneration++;}
  const [plan,setPlan]=useState<FlashcardReviewPlan>(empty);
  const [starting,setStarting]=useState(false);
  useEffect(()=>{owner.current.mounted=true;return()=>{owner.current.mounted=false;owner.current.generation++;owner.current.planGeneration++;};},[]);
  useEffect(()=>{
    const generation=++owner.current.planGeneration;
    setPlan(empty());
    if(!options.enabled)return;
    let active=true;
    void loadFlashcardReviewPlan(options.deckId,options.sessionLimit,options.includeSubdecks,false)
      .then(value=>{if(active&&owner.current.mounted&&owner.current.planGeneration===generation)setPlan(value);})
      .catch(reason=>{if(active&&owner.current.mounted&&owner.current.planGeneration===generation)latest.current.onError(String(reason));});
    return()=>{active=false;};
  },[scopeKey,options.quota,options.refreshToken,options.decksToken]);
  const start=useCallback(async()=>{
    if(owner.current.starting||!latest.current.enabled)return false;
    const config=latest.current,key=owner.current.key,generation=owner.current.generation;
    const current=()=>owner.current.mounted&&owner.current.key===key&&owner.current.generation===generation;
    owner.current.starting=true;setStarting(true);
    try{
      const planned=await loadFlashcardReviewPlan(config.deckId,config.sessionLimit,config.includeSubdecks);
      if(!current())return false;
      const cards=await loadFlashcardsByIds(planned.sessionIds);
      if(!current())return false;
      config.onStart(cards.filter(card=>card.status!=="suspended"),config.scopeName);
      return true;
    }catch(reason){if(current())latest.current.onError(String(reason));return false;}
    finally{owner.current.starting=false;if(owner.current.mounted)setStarting(false);}
  },[]);
  return {plan,starting,start};
}
