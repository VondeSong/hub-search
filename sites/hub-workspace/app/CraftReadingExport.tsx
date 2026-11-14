"use client";
import {useState} from 'react';

// Interaction sample only; native desktop export reads verified local objects.
export function CraftReadingExport(){
 const[copy,setCopy]=useState(false);const[status,setStatus]=useState('');
 const[scenario,setScenario]=useState('partial');
 return <details className="cs-details craft-reading-export"><summary>Craft 备份与阅读副本</summary>
  <p>交互示例，不访问真实 Craft 或本地文件。完整备份和阅读副本分别核对。</p>
  <label className="setting-label">示例状态 <select value={scenario} onChange={e=>{setScenario(e.target.value);setCopy(false);setStatus('');}}>
   <option value="partial">附件有缺项，尚无完整恢复点</option><option value="old">保留旧恢复点，阅读库已移动</option><option value="complete">已完成，阅读库存在</option>
  </select></label>
  <div className="setting-row"><div><strong>最后采集</strong><p>11 月 13 日 · 示例资料 · {scenario==='complete'?'完整':'附件有缺项'}</p></div></div>
  <div className="setting-row"><div><strong>完整恢复点</strong><p>{scenario==='partial'?'尚无有效完整恢复点':scenario==='old'?'11 月 10 日 · 打开前仍需核验原始对象':'11 月 13 日 · 打开前仍需核验原始对象'}</p></div></div>
  <div className="setting-row"><div><strong>正常阅读库</strong><p>{scenario==='complete'?'示例路径 / Craft 阅读库 · 已生成':'当前配置路径未找到已生成的阅读库'}</p></div><button className="secondary-button" disabled={scenario!=='complete'} onClick={()=>setStatus('演示：打开已显示的正常阅读库路径；桌面端会再次检查目录。')}>打开阅读库</button></div>
  <p>采集失败时不更新正常阅读库、不发布新恢复点。已有文件保留，不表示它们已通过当前核验。</p>
  {scenario!=='complete'&&<><hr/><h4>阅读已保存内容（有缺项）</h4><p>仅从本地可校验的正文和原件生成独立副本。正文附近标出未保存附件；未解析链接保留并报告，不猜同名目标、不创建空页。</p>
   <button className="secondary-button" onClick={()=>{setCopy(true);setStatus('演示完成：独立阅读副本已生成，正常阅读库与自动备份设置未改变。');}}>生成阅读副本（有缺项）…</button>
   {copy&&<div className="about-note"><strong>阅读副本（有缺项）· 不是完整备份</strong><p>示例路径 / Craft - 阅读副本（有缺项）</p><button className="secondary-button" onClick={()=>setStatus('演示：打开副本说明、逐页附件提示和链接报告。')}>查看副本与缺项说明</button></div>}</>}
  <p>重复生成会核对文件；本地修改保留，冲突另存为“Craft 更新”。集合为静态内容，白板需 Excalidraw，不能完全恢复 Craft 布局与交互。</p>
  {status&&<p role="status">{status}</p>}
 </details>;
}
