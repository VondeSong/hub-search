"use client";
import {useState} from 'react';
export function AssistantCloudHandoff(){
 const names=['报告.md','汇总.csv','分类图.png','核对.xlsx'];
 const [selected,setSelected]=useState(['报告.md','汇总.csv']),[preview,setPreview]=useState(false),[phase,setPhase]=useState('select');
 return <section aria-label="手机继续查看演示"><h4>发送到个人云端</h4><p className="ha-scope-hint">交互演示 · 只发送勾选成果的副本。手机可阅读报告、保存文件，并继续讨论已有分析。</p>
 {names.map(name=><label className="ha-resource-choice" key={name}><input type="checkbox" checked={selected.includes(name)} disabled={phase==='published'} onChange={e=>{setSelected(v=>e.target.checked?[...v,name]:v.filter(n=>n!==name));setPreview(false);setPhase('select');}}/><span><strong>{name}</strong><small>材料汇总 · 当前版 · 示例文件</small></span></label>)}
 {phase==='published'?<p role="status">交接示例已发布。手机打开同名会话，可查看桌面报告和已选文件。此原型没有上传文件或调用真实模型。</p>:<>
 <button type="button" className="ha-secondary-button" disabled={!selected.includes('报告.md')} onClick={()=>setPreview(true)}>预览交接内容</button>
 {preview&&<div><p>目标：个人 VPS（示例）</p><p>将交接 {selected.length} 个文件：{selected.join('、')}。后续云端对话只读取报告正文；其他文件供你取回。</p><p className="ha-scope-hint">这是固定版本副本。后续桌面资料变化不会自动更新云端；撤回本地授权也不会删除已导出的云端副本。云端可另行撤回，已保存的副本及历史回答会保留。</p>
 {phase==='interrupted'?<p role="status">连接中断，交接编号与已传文件保留。重试后继续核对，完整前手机不会看到半份成果。</p>:null}
 <button type="button" className="ha-secondary-button" onClick={()=>setPhase('published')}>{phase==='interrupted'?'用原编号继续交接':'确认发送（演示）'}</button> <button type="button" className="ha-secondary-button" onClick={()=>setPhase('interrupted')}>体验传输中断</button></div>}
 </>}
 {phase==='published'&&<a href="https://hub-mobile-lab-von11.song02211368537057.chatgpt.site/#agents" target="_blank" rel="noreferrer">打开手机原型，在助手中查看桌面交接示例</a>}
 </section>;
}
