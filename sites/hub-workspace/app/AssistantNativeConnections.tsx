"use client";
import {useState} from 'react';

export function AssistantNativeConnections({disabled}:{disabled:boolean}) {
  const [app,setApp]=useState(false),[read,setRead]=useState(false),[sites,setSites]=useState('https://developers.openai.com'),[browse,setBrowse]=useState(false),[applied,setApplied]=useState(''),[error,setError]=useState('');
  function apply(){try{const origins=sites.trim().split(/\s+/).map(raw=>{const url=new URL(raw);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port)throw Error('请填写不含路径的 HTTPS 网站地址。');return url.origin;});setApplied([read?'GitHub · 读取 Issue':'',browse?'浏览器 · '+origins.join('、'):''].filter(Boolean).join('；')||'未授权外部工具');setError('');}catch(reason){setError(String(reason));}}
  return <fieldset disabled={disabled} className="ha-native-connections"><legend>应用与浏览器 · 原型示例</legend>
    <p>应用按当前 Codex 账号、服务与工具选择。此处仅演示授权，不读取真实连接。</p>
    <button type="button" onClick={()=>setApp(true)}>查看应用示例</button>
    {app&&<label className="ha-detail-setting"><span>GitHub · 读取 Issue（只读）</span><input type="checkbox" checked={read} onChange={e=>setRead(e.target.checked)}/></label>}
    <label className="ha-native-site"><span>允许浏览的网站</span><input aria-label="允许浏览的网站" value={sites} onChange={e=>setSites(e.target.value)}/></label>
    <label className="ha-detail-setting"><span>授权导航、快照与元素交互</span><input type="checkbox" checked={browse} onChange={e=>setBrowse(e.target.checked)}/></label>
    <p>独立临时浏览器，不继承登录态；仅所选网站，写请求、文件和脚本不开放。本轮结束关闭。写插件需另有确认与回读。</p>
    <button type="button" onClick={apply}>应用到本对话（示例）</button>
    {applied&&<p role="status">{applied}</p>}{error&&<p role="alert">{error}</p>}
  </fieldset>;
}
