import assert from "node:assert/strict";
import {decodeDiscovery,discoveryExamples,hasDiscovery,newDiscovery,transitionDiscovery as step} from "../app/insight-discovery.ts";
let checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
for(const scope of ["work","life"]){
 let s=newDiscovery(scope);
 check(!step(s,{type:"save"}).saved,"未开始不能保存");
 check(!step(s,{type:"add"}).added,"未保留不能添加后续");
 s=step(s,{type:"start"});check(hasDiscovery(s),"两侧资料形成候选");
 s=step(s,{type:"save"});s=step(s,{type:"add"});
 check(!step(s,{type:"confirm",outcome:"revise"}).history.length,"新增记录不自动改判");
 s=step(s,{type:"compare"});
 const maintained=step(s,{type:"confirm",outcome:"maintain"});
 check(maintained.history[0].text===discoveryExamples[scope].finding,"维持保留原判断");
 const revised=step(s,{type:"confirm",outcome:"revise"});
 check(revised.history[0].text===discoveryExamples[scope].revised,"明确采用才修订");
 check(step(revised,{type:"confirm",outcome:"revise"}).history.length===1,"重复确认不重复修订");
 assert.deepEqual(decodeDiscovery(JSON.stringify(revised)),revised);checks++;
 const corrected=step(s,{type:"correct",reason:"输入条件不同"});
 check(!step(corrected,{type:"confirm",outcome:"revise"}).history.length,"纠正后停止旧关系");
 let missing=step(newDiscovery(scope),{type:"select",id:discoveryExamples[scope].records[1].id});
 missing=step(missing,{type:"select",id:discoveryExamples[scope].records[2].id});
 missing=step(missing,{type:"start"});
 check(!hasDiscovery(missing)&&!step(missing,{type:"save"}).saved,"同词干扰不代替必要证据");
}
check(decodeDiscovery('{"scope":"__proto__"}')===null,"未知范围无效");
check(decodeDiscovery(JSON.stringify({...newDiscovery(),saved:true}))===null,"拒绝不完整保存状态");
check(decodeDiscovery("not-json")===null,"损坏状态可恢复");
console.log(`洞察新流程：${checks} 项检查通过（固定示例，不代表真实资料／模型验收）`);
