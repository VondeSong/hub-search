"use client";
import {useState} from 'react';
import {BookOpen,ChevronDown,FileText,Globe2,Search,Terminal,TriangleAlert} from 'lucide-react';

export function AssistantProcess({steps,webEnabled=false}:{steps?:string[];webEnabled?:boolean}) {
  const [failed,setFailed]=useState(false);
  return <details className="ha-activity ha-process-demo">
    <summary>工作过程 · 演示<ChevronDown size={13} aria-hidden="true"/></summary>
    <p>预置活动示例，未调用真实模型或工具；耗时与网站不代表本次实际执行。</p>
    <div className="ha-process-commentary">先核对资料与技能要求，再整理可验证的结果。</div>
    <div className="ha-process-row"><BookOpen size={16}/><span>已读取技能说明</span></div>
    <details className="ha-process-group"><summary><Search size={16}/><span>已搜索并读取资料</span><ChevronDown size={12}/></summary><div>
      {(steps?.length?steps:['核对所选资料范围','读取示例材料','整理可编辑结果']).map((step,index)=><div key={index} className="ha-process-row"><FileText size={16}/><span>{step}</span></div>)}
    </div></details>
    {webEnabled&&<details className="ha-process-group"><summary><span className="ha-process-sites"><img src="/agent-icons/github.svg" alt="GitHub"/><img src="/agent-icons/notion.svg" alt="Notion"/></span><span>查阅网站来源 · 演示{failed?' · 部分未完成':''}</span>{failed&&<TriangleAlert size={14}/>}<ChevronDown size={12}/></summary><div>
      <div className="ha-process-row"><Globe2 size={16}/><span>github.com · 示例来源</span></div><div className="ha-process-row"><Globe2 size={16}/><span>notion.so · {failed?'访问未完成（示例）':'示例来源'}</span></div>
      <p>返回来源不等于已读全文；网站图标用于识别来源。</p>
      <button type="button" onClick={()=>setFailed(value=>!value)}>{failed?'恢复正常示例':'查看部分失败示例'}</button>
    </div></details>}
    <div className="ha-process-commentary">工具结果与模型说明交错呈现，折叠后保留来源和失败状态。</div>
    <div className="ha-process-row"><Terminal size={16}/><span>运行工作区命令 · 展示示例</span></div>
    <div className="ha-process-row"><svg width="16" height="16" viewBox="0 0 16 16" aria-label="子代理示例" role="img">{Array.from({length:6},(_,i)=><path key={i} d="M8 8 6 1h4Z" fill="currentColor" opacity={i%2?0.6:1} transform={`rotate(${i*60} 8 8)`}/>)}</svg><span>子代理已完成 · 展示示例</span></div>
    <p>桌面只在收到真实命令或代理事件时显示对应活动。</p>
  </details>;
}
