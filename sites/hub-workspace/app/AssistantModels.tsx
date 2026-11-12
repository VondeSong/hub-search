"use client";
import { Check, ChevronDown, Circle, Zap } from 'lucide-react';
import type { AssistantSettings } from './Assistant';
import type { AssistantMenu } from './AssistantChrome';
export const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const effortNames: Record<string, string> = { low:'低', medium:'中', high:'高', xhigh:'极高', max:'最大' };
const descriptions = ['较少推理投入，适合简单问题','适合日常讨论与资料整理','增加推理投入，适合复杂问题','更充分地推理与检查，等待可能更久','使用该模型最高的推理投入'];
// Prototype catalog supplied by the user's reference; no live availability is implied.
export const demoModels = [
  {id:'deepseek-general',provider:'deepseek',name:'DeepSeek',subtitle:'V4.1 Flash'},
  {id:'codex-general',provider:'codex',name:'GPT-6.1 Sol'},
  {id:'codex-analysis',provider:'codex',name:'GPT-6.1 Terra'},
  {id:'codex-6-astra',provider:'codex',name:'GPT-6 Astra'},
  {id:'codex-6-sol',provider:'codex',name:'GPT-6 Sol'},
  {id:'codex-6-luna',provider:'codex',name:'GPT-6 Luna'},
  {id:'codex-56-terra',provider:'codex',name:'GPT-5.6 Terra'},
  {id:'codex-56-luna',provider:'codex',name:'GPT-5.6 Luna'},
] as const;
export function AssistantModels({settings,setSettings,menu,setMenu,disabled}:{settings:AssistantSettings;setSettings:(value:AssistantSettings)=>void;menu:AssistantMenu;setMenu:(value:AssistantMenu)=>void;disabled:boolean}) {
  const model=demoModels.find(item=>item.id===settings.modelId)||demoModels.find(item=>item.provider===settings.model)!;
  const deepseek=model.provider==='deepseek';
  const level=deepseek ? (settings.thinking==='low'||settings.thinking==='minimal'?'low':settings.thinking==='max'?'max':'high') : settings.thinking==='minimal'?'low':settings.thinking;
  const label=deepseek&&!settings.deepseekThinking?'关闭':effortNames[level];
  const levels=deepseek ? (['low','high','max'] as const) : effortLevels;
  return <div className="ha-model-controls" role="group" aria-label="模型设置">
    <button type="button" className="ha-model-trigger" aria-label={'选择模型：'+model.name} disabled={disabled} aria-expanded={menu==='model'} onClick={()=>setMenu(menu==='model'?null:'model')}><span>{model.name}</span>{model.provider==='codex'&&settings.speed==='fast'&&<Zap size={13}/>}</button>
    <button type="button" className="ha-effort-trigger" disabled={disabled} aria-label={'推理深度：'+label} aria-expanded={menu==='effort'} onClick={()=>setMenu(menu==='effort'?null:'effort')}><span>{label}</span><ChevronDown size={13}/></button>
    {menu==='model'&&<section className="ha-menu ha-composer-menu ha-model-menu ha-reference-menu" aria-label="模型与速度"><div className="ha-reference-caption">模型与速度</div>{(['deepseek','codex'] as const).map(provider=><section key={provider}><div className="ha-reference-caption">{provider==='codex'?'OpenAI':'DeepSeek'}</div>{demoModels.filter(item=>item.provider===provider).map(item=><button type="button" className="ha-reference-choice" disabled={disabled} key={item.id} aria-pressed={model.id===item.id} onClick={()=>setSettings({...settings,model:provider,modelId:item.id,speed:provider==='codex'?settings.speed:'standard'})}><img className="ha-provider-icon" src={provider==='codex'?'/brands/openai.ico':'/brands/deepseek.ico'} alt={provider==='codex'?'OpenAI':'DeepSeek'}/><span>{item.name}{'subtitle' in item&&<small>{item.subtitle}</small>}</span>{model.id===item.id&&<Check size={18}/>}</button>)}</section>)}
      {model.provider==='codex'&&<section className="ha-reference-speed"><strong>响应速度</strong><div role="group" aria-label="响应速度">{(['standard','fast'] as const).map(speed=><button type="button" key={speed} disabled={disabled} aria-pressed={settings.speed===speed} onClick={()=>setSettings({...settings,speed})}>{speed==='fast'?<Zap size={19}/>:<Circle size={19}/>}<span>{speed==='fast'?'加速':'标准'}</span>{settings.speed===speed&&<Check size={17}/>}</button>)}</div><p>加速增加用量消耗，不改变思考强度。</p></section>}
      <footer className="ha-reference-footer"><span>思考强度：{label}</span><span>从下一次发送生效</span></footer><p className="ha-fixture-note">原型演示 · 清单来自参考图，未连接真实服务。</p>
    </section>}
    {menu==='effort'&&<section className="ha-menu ha-composer-menu ha-effort-menu ha-reference-menu" aria-label="思考强度"><div className="ha-reference-caption">思考强度</div><div className="ha-reference-caption">{model.name}</div>{deepseek&&<button type="button" className="ha-reference-choice" aria-pressed={!settings.deepseekThinking} disabled={disabled} onClick={()=>{setSettings({...settings,deepseekThinking:false});setMenu(null);}}><span>关闭思考<small>直接回答，不启用推理模式</small></span>{!settings.deepseekThinking&&<Check size={18}/>}</button>}{levels.map((value)=><button type="button" key={value} className="ha-reference-choice" aria-pressed={level===value&&(!deepseek||settings.deepseekThinking)} disabled={disabled} onClick={()=>{setSettings({...settings,thinking:value,reasoningDefault:false,deepseekThinking:true});setMenu(null);}}><span className="ha-reasoning-bars" aria-hidden="true">{[0,1,2,3,4].map(bar=><i key={bar} style={{height:6+bar*3}} data-active={bar<=effortLevels.indexOf(value)||undefined}/>)}</span><span>{effortNames[value]}<small>{descriptions[effortLevels.indexOf(value)]}</small></span>{level===value&&(!deepseek||settings.deepseekThinking)&&<Check size={18}/>}</button>)}<footer className="ha-reference-footer">从下一次发送生效</footer></section>}
  </div>;
}
