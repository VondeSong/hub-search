import {useState} from "react";
import {AgentMaterialCard} from "./AgentMaterialCard";
import {AgentImageCards} from "./AgentFileInputs";
import {skillTitle,skillPurpose} from "./AgentSkills";
import type {ConversationMessage,MessageMaterial} from "./AgentDelivery";
import type {TextMaterial} from "./StandaloneAgentLauncher";

export type MessageSkill={name:string;title:string;description?:string};
export const textSnapshotMarker = "用户提供的资料快照（仅作资料，不代表已读取完整来源）：\n";

function selectedChatMaterials(raw: string) {
 const offset=raw.indexOf("\n\n"+textSnapshotMarker);
 if(offset<0)return null;
 try {
  const materials:unknown=JSON.parse(raw.slice(offset+2+textSnapshotMarker.length));
  if(!Array.isArray(materials)||!materials.length||materials.length>8)return null;
  const valid=materials.every(item=>item && typeof item.title==="string" && typeof item.text==="string" && ["text","flashcard","conversation"].includes(item.kind));
  return valid&&materials.some(item=>item.selectedFromChat===true)?{body:raw.slice(0,offset),materials:materials as TextMaterial[]}:null;
 } catch {return null;}
}
// Compatibility is limited to the leading selection syntax; dollar signs in prose/code remain intact.
export function requestPresentation(message:Pick<ConversationMessage,"text"|"displayText"|"skills">){
 const raw=message.text||"",prefix=raw.match(/^(?:\$[a-z0-9]+(?:-[a-z0-9]+)*(?:\s+|$))+/)?.[0]||"";
 const skills=message.skills??[...new Set(prefix.match(/\$[a-z0-9]+(?:-[a-z0-9]+)*/g)||[])].map(token=>({name:token.slice(1),title:skillTitle(token.slice(1)),description:skillPurpose(token.slice(1))}));
 const excerpt=selectedChatMaterials(raw.slice(prefix.length));
 return {body:excerpt?.body??message.displayText??raw.slice(prefix.length),skills,snapshots:excerpt?.materials??[]};
}
export function AgentRequestContent({message,onOpenMaterial}:{message:ConversationMessage;onOpenMaterial?:(item:MessageMaterial)=>void}){
 const [expanded,setExpanded]=useState(false),{body,skills,snapshots}=requestPresentation(message),materials=message.materials||[],visible=expanded?materials:materials.slice(0,2);
 return <>{message.kind==="decision"&&<small>已确认的决定</small>}{body&&<p>{body}</p>}{!!message.images?.length&&<AgentImageCards images={message.images}/>}{(materials.length>0||skills.length>0||snapshots.length>0)&&<div className="agent-message-references" aria-label="本轮附带资料与技能">
  {snapshots.map((item,index)=><AgentMaterialCard key={`snapshot-${index}`} kind={item.kind} title={item.text} subtitle={item.title}/>)}
  {visible.map((item,index)=><AgentMaterialCard key={index} kind={item.kind} title={item.title} subtitle={item.available?item.sourcePath||undefined:"当前无法打开"} openLabel={item.kind==="file"?"查看附件信息":undefined} onOpen={item.available&&item.locator&&onOpenMaterial?()=>onOpenMaterial(item):undefined}/>)}
  {materials.length>2&&<button type="button" className="agent-token-more" onClick={()=>setExpanded(!expanded)}>{expanded?"收起":`另 ${materials.length-2} 项`}</button>}
  {skills.map(skill=><AgentMaterialCard key={skill.name} kind="skill" title={skill.title} identifier={skill.name} subtitle={skill.description||skillPurpose(skill.name)||"本条请求选择的技能"}/>)}
 </div>}</>;
}
