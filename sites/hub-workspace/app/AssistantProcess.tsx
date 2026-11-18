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
    {webEnabled && <>
      <details className="ha-process-group">
        <summary><Search size={16} aria-hidden="true"/><span className="ha-process-label">已搜索网页</span><span className="ha-process-sites"><img src="/agent-icons/github.svg" alt="GitHub"/><img src="/agent-icons/notion.svg" alt="Notion"/></span><small>另 2 个站点</small><ChevronDown size={12} aria-hidden="true"/></summary>
        <div>
          <p>本批返回 8 项搜索结果。</p>
          <details><summary>返回来源 · 4 个站点</summary><ul><li>github.com</li><li>docs.github.com</li><li>notion.so</li><li>developers.openai.com</li><li>modelcontextprotocol.io</li></ul></details>
        </div>
      </details>
      <details className="ha-process-group">
        <summary><Globe2 size={16} aria-hidden="true"/><span className="ha-process-label">{failed ? '打开网页 · 1 项未获取' : '已打开网页'}</span>{failed && <TriangleAlert size={14} aria-hidden="true"/>}<ChevronDown size={12} aria-hidden="true"/></summary>
        <div>
          <div className="ha-process-row"><img src="/agent-icons/github.svg" alt="" width="16" height="16"/><span>github.com · 已打开</span></div>
          <div className="ha-process-row"><img src="/agent-icons/notion.svg" alt="" width="16" height="16"/><span>notion.so · {failed ? '访问未完成' : '已打开'}</span></div>
          <button type="button" onClick={() => setFailed(value => !value)}>{failed ? '恢复正常示例' : '查看部分失败示例'}</button>
        </div>
      </details>
    </>}
    <div className="ha-process-row"><Terminal size={16}/><span>运行工作区命令 · 展示示例</span></div>
    <div className="ha-process-row"><svg width="16" height="16" viewBox="0 0 16 16" aria-label="子代理示例" role="img">{Array.from({length:6},(_,i)=><path key={i} d="M8 8 6 1h4Z" fill="currentColor" opacity={i%2?0.6:1} transform={`rotate(${i*60} 8 8)`}/>)}</svg><span>子代理已完成 · 展示示例</span></div>
    <details className="ha-process-group ha-process-runtime">
      <summary><span>运行详情</span><ChevronDown size={12} aria-hidden="true"/></summary>
      <div><p>本轮可用 {webEnabled ? '网页搜索和 Hub 工具' : 'Hub 工具'}</p></div>
    </details>
    <div className="ha-answer-table" role="region" aria-label="成果表格排版示例，可横向滚动" tabIndex={0}><table><caption>窄窗表格排版 · 演示，非本轮执行结果</caption><thead><tr><th scope="col">内容</th><th scope="col">版本依据</th><th scope="col">可用范围</th><th scope="col">继续操作</th></tr></thead><tbody><tr><td>原始资料</td><td>当前明确授权的来源版本</td><td>保留原表的行列与来源</td><td>来源变化后重新核对相关成果</td></tr><tr><td>分析成果</td><td>实际执行时使用的输入</td><td>只沿用仍有效的结果</td><td>保留历史版本，修订生成新版本</td></tr></tbody></table></div>
  </details>;
}
