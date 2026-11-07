export type MaterialBudget = {schemaVersion:number;imageWireBytes?:number;imageRawBytes?:number;protocolEnvelopeBytes?:number;initialTaskAndOtherBytes:number;toolDefinitionsBytes:number;instructionBytes:number;fullRulesBytes:number;ruleReferenceBytes:number;toolBusinessBytes:number;chargedBytes:number;limitBytes:number;remainingBytes:number;overrunBytes:number;singlePayloadLimitBytes:number;preflight?:{initialBytes:number;expectedAdditionalBytes:number|null;shortfallBytes?:number;allowed:boolean;estimateOnly?:boolean}};
import {formatFileSize} from "./FileFormatting";
export function AgentMaterialBudget({value}:{value:MaterialBudget|null|undefined}){
 if(!value || value.schemaVersion!==1)return null;
 const rows:[string,number][]=[["初始任务、材料及历史",value.initialTaskAndOtherBytes],["工具定义",value.toolDefinitionsBytes],["系统指令",value.instructionBytes],["完整规则",value.fullRulesBytes],["规则引用",value.ruleReferenceBytes],["工具业务结果",value.toolBusinessBytes],["图片编码载荷",value.imageWireBytes??0],["协议封装",value.protocolEnvelopeBytes??0]];
 const number=(n:number)=>n.toLocaleString("zh-CN");
 const usedPercent=value.limitBytes>0?Math.round(value.chargedBytes/value.limitBytes*100):null;
 return <details className="agent-progress"><summary>资料处理容量：{value.overrunBytes>0?"已超出上限":usedPercent===null?"上限未知":`累计已用约 ${usedPercent}%`}</summary>
  <p>累计使用 {formatFileSize(value.chargedBytes)}，上限 {formatFileSize(value.limitBytes)}，剩余 {formatFileSize(value.remainingBytes)}。</p>
  <p className="agent-note">包括资料、对话记录和运行所需的指令，用于限制单个任务的处理规模；不代表费用或模型的上下文占用。继续对话时会累计，整理上下文不会清零。</p>
  {value.preflight?.allowed===false && <p role="status">启动前空间不足：初始占用 {number(value.preflight.initialBytes)} 字节，预计还需 {number(value.preflight.expectedAdditionalBytes??0)} 字节，还差 {number(value.preflight.shortfallBytes??0)} 字节。任务已保留，未请求模型。</p>}
  <details><summary>技术明细</summary><dl>{rows.map(([label,n])=><div key={label}><dt>{label}</dt><dd>{number(n)} 字节</dd></div>)}</dl>
  <p>累计 {number(value.chargedBytes)} 字节；剩余 {number(value.remainingBytes)} 字节{value.overrunBytes>0?"；超出 "+number(value.overrunBytes)+" 字节":""}。</p>
  <p className="agent-note">以上分项互不重叠，基础开销和业务材料共同计入累计上限。单个载荷上限为 {number(value.singlePayloadLimitBytes)} 字节。提供方 Token 用量另计；压缩不会清零累计用量。</p>
  {value.preflight?.allowed && value.preflight.expectedAdditionalBytes!==null && <p className="agent-note">启动时预计后续还需 {number(value.preflight.expectedAdditionalBytes)} 字节；这是估算，运行中仍会检查累计上限。</p>}</details>
 </details>;
}
