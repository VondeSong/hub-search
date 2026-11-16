import {useState} from "react";
import {AgentMaterialCard} from "./AgentMaterialCard";
import {skillTitle,skillPurpose} from "./AgentSkills";
import type {ConversationMessage,MessageMaterial} from "./AgentDelivery";

export type MessageSkill={name:string;title:string;description?:string};
// Compatibility is limited to the leading selection syntax; dollar signs in prose/code remain intact.
export function requestPresentation(message:Pick<ConversationMessage,"text"|"displayText"|"skills">){
 const raw=message.text||"",prefix=raw.match(/^(?:\$[a-z0-9]+(?:-[a-z0-9]+)*(?:\s+|$))+/)?.[0]||"";
 const skills=message.skills??[...new Set(prefix.match(/\$[a-z0-9]+(?:-[a-z0-9]+)*/g)||[])].map(token=>({name:token.slice(1),title:skillTitle(token.slice(1)),description:skillPurpose(token.slice(1))}));
 return {body:message.displayText??raw.slice(prefix.length),skills};
}
export function AgentRequestContent({message,onOpenMaterial}:{message:ConversationMessage;onOpenMaterial?:(item:MessageMaterial)=>void}){
 const [expanded,setExpanded]=useState(false),{body,skills}=requestPresentation(message),materials=message.materials||[],visible=expanded?materials:materials.slice(0,2);
 return <>{message.kind==="decision"&&<small>已确认的决定</small>}{body&&<p>{body}</p>}{(materials.length>0||skills.length>0)&&<div className="agent-message-references" aria-label="本轮附带资料与技能">
  {visible.map((item,index)=><AgentMaterialCard key={index} kind={item.kind} title={item.title} subtitle={item.available?item.sourcePath||"本条消息选择的资料":"已不在当前资料范围"} onOpen={item.available&&item.locator&&onOpenMaterial?()=>onOpenMaterial(item):undefined}/>)}
  {materials.length>2&&<button type="button" className="agent-token-more" onClick={()=>setExpanded(!expanded)}>{expanded?"收起":`另 ${materials.length-2} 项`}</button>}
  {skills.map(skill=><AgentMaterialCard key={skill.name} kind="skill" title={skill.title} identifier={skill.name} subtitle={skill.description||skillPurpose(skill.name)||"本条请求选择的技能"}/>)}
 </div>}</>;
}
