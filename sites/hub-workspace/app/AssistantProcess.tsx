"use client";
import {useState} from 'react';
import {BookOpen,ChevronDown,FileText,FolderOpen,Globe2,Search,Terminal,TriangleAlert} from 'lucide-react';

const examples = [
  ['short', '简短问答'],
  ['read', '读取与恢复'],
  ['web', '网页检索'],
  ['tools', '浏览器与应用'],
  ['files', '分批分析'],
] as const;

const batches = Array.from({length:14}, (_, index) => {
  const first = index * 1100 + 1;
  const last = first + 1099;
  return {first, last, file: `analysis_${first}_${last}.csv`};
});

function ProcessGroup({title, icon: Icon, children}: {
  title: string;
  icon: typeof FileText;
  children: React.ReactNode;
}) {
  return <details className="ha-process-group">
    <summary><Icon size={16} aria-hidden="true"/><span className="ha-process-label">{title}</span><ChevronDown size={13} aria-hidden="true"/></summary>
    <div className="ha-process-children">{children}</div>
  </details>;
}

export function AssistantProcessDemo({onClose}: {onClose: () => void}) {
  const [scenario,setScenario] = useState<(typeof examples)[number][0]>('read');
  const [readAgain,setReadAgain] = useState(false);
  const [visibleBatches,setVisibleBatches] = useState(5);
  return <section className="ha-process-review ha-process-demo" aria-label="工作过程示例">
    <header><h2>工作过程示例</h2><button type="button" onClick={onClose}>返回对话</button></header>
    <div className="ha-process-examples" role="group" aria-label="选择示例">
      {examples.map(([id,label]) => <button type="button" key={id} aria-pressed={scenario===id} onClick={()=>setScenario(id)}>{label}</button>)}
    </div>
    <div key={scenario} className="ha-process-example">
      {scenario === 'short' && <><p className="ha-process-meta">用时 12 秒</p><p>这份清单按资料、核对项和待确认问题分成三部分。</p></>}
      {scenario === 'read' && <>
        <p className="ha-process-commentary">先核对资料版本，再找出需要复查的段落。</p>
        <ProcessGroup title={readAgain ? '读取原文 · 重读成功' : '读取原文 · 版本已变化'} icon={readAgain ? FileText : TriangleAlert}>
          <div className="ha-process-row"><FileText size={15} aria-hidden="true"/><span>工程交接说明</span></div>
          <p>{readAgain ? '已按当前版本读取开头 2,000 字。' : '原有的阅读位置属于旧版本。'}</p>
          {!readAgain && <button type="button" onClick={()=>setReadAgain(true)}>重新读取当前版本</button>}
          <details className="ha-process-technical"><summary>技术记录</summary><pre>{JSON.stringify({event:'read', status:'stale', recovery:readAgain?'completed':'pending'},null,2)}</pre></details>
        </ProcessGroup>
        <p role="status">{readAgain ? '当前版本已读取，可以继续核对。' : '正在等待重新核对这份资料。'}</p>
      </>}
      {scenario === 'web' && <AssistantProcess webEnabled seconds={36}/>}
      {scenario === 'tools' && <>
        <div className="ha-process-time"><span className="ha-process-meta">用时 2 分 4 秒</span>
          <details><summary>本轮工具与权限</summary><ul><li>GitHub · 读取议题、准备评论草稿</li><li>独立浏览器 · developers.openai.com</li><li>内置网页搜索关闭</li></ul></details>
        </div>
        <ProcessGroup title="读取 GitHub 议题 · 浏览网页" icon={Globe2}>
          <details className="ha-process-batch"><summary>打开网页 <ChevronDown size={12} aria-hidden="true"/></summary><p>Skills · developers.openai.com</p><p>打开成功</p><details className="ha-process-technical"><summary>技术记录</summary><p>浏览器导航回执 · 展示示例</p></details></details>
        </ProcessGroup>
        <ProcessGroup title="准备 GitHub 评论草稿" icon={FileText}><p>草稿已准备，等待确认发布。</p></ProcessGroup>
      </>}
      {scenario === 'files' && <>
        <p className="ha-process-meta">用时 1 分 22 秒</p>
        <ProcessGroup title="已复用 14 批分析结果" icon={Terminal}><p>沿用已有记录并核对了批次范围。</p></ProcessGroup>
        <p>已汇总 15,400 条记录，按原批次保留文件。</p>
        <ProcessGroup title="分析成果 · 14 批" icon={FolderOpen}>
          {batches.slice(0,visibleBatches).map((batch) => <details className="ha-process-batch" key={batch.first}>
            <summary><FileText size={15} aria-hidden="true"/><span>{batch.file}</span><ChevronDown size={12} aria-hidden="true"/></summary>
            <p className="ha-process-meta">第 {batch.first.toLocaleString()}–{batch.last.toLocaleString()} 条 · 第 1 版</p>
            <a download={batch.file} href={'data:text/csv;charset=utf-8,'+encodeURIComponent(`start,end\n${batch.first},${batch.last}\n`)}>下载批次摘要</a>
          </details>)}
          {visibleBatches < batches.length && <button type="button" onClick={()=>setVisibleBatches(value=>value+5)}>显示更多批次</button>}
        </ProcessGroup>
      </>}
    </div>
  </section>;
}

export function AssistantProcess({steps,webEnabled=false,seconds}:{steps?:string[];webEnabled?:boolean;seconds?:number}) {
  const [required,setRequired]=useState(false);
  return <details className="ha-activity ha-process-demo" open={seconds ? true : undefined}>
    <summary>{seconds ? `用时 ${seconds} 秒` : '工作过程 · 演示'}<ChevronDown size={13} aria-hidden="true"/></summary>
    <details className="ha-process-group ha-process-permissions">
      <summary>本轮工具与权限<ChevronDown size={12} aria-hidden="true"/></summary>
      <div><p>本轮可用 Hub 工具</p><p>内置网页搜索{webEnabled ? '已开启' : '关闭'}</p></div>
    </details>
    {seconds && webEnabled && <button type="button" aria-pressed={required} onClick={()=>setRequired(value=>!value)}>指定来源示例</button>}
    {required && <p role="status">指定网页无法访问，暂未核对原文。</p>}
    <div className="ha-process-commentary">先核对资料与技能要求，再整理可验证的结果。</div>
    <div className="ha-process-row"><BookOpen size={16}/><span>已读取技能说明</span></div>
    <details className="ha-process-group"><summary><Search size={16}/><span>核对本轮资料</span><ChevronDown size={12}/></summary><div className="ha-process-children">
      {(steps?.length?steps:['核对所选资料范围','读取示例材料','整理可编辑结果']).map((step,index)=><div key={index} className="ha-process-row"><FileText size={16}/><span>{step}</span></div>)}
    </div></details>
    {webEnabled && <>
      <details className="ha-process-group">
        <summary><Search size={16} aria-hidden="true"/><span className="ha-process-label">网页检索 · 2 步</span><span className="ha-process-sites"><img src="/agent-icons/github.svg" alt="GitHub"/><img src="/agent-icons/notion.svg" alt="Notion"/></span><small>另 2 个站点</small><ChevronDown size={12} aria-hidden="true"/></summary>
        <div className="ha-process-children">
          <details className="ha-process-batch">
            <summary><Search size={15} aria-hidden="true"/><span>搜索网页</span><ChevronDown size={12} aria-hidden="true"/></summary>
            <p>本批返回 8 项搜索结果。</p>
            <details><summary>返回来源 · 4 个站点</summary><ul><li>github.com</li><li>notion.so</li><li>developers.openai.com</li><li>modelcontextprotocol.io</li></ul></details>
          </details>
          <details className="ha-process-batch">
            <summary><Globe2 size={15} aria-hidden="true"/><span>{required ? '打开指定网页' : '在网页内查找'}</span><ChevronDown size={12} aria-hidden="true"/></summary>
            {!required && <p>查找内容：页面历史。返回 4 条来源记录。</p>}
            <p>notion.so · 网站拒绝访问（403）</p>
          </details>
        </div>
      </details>
    </>}
    <div className="ha-process-row"><Terminal size={16}/><span>运行工作区命令 · 展示示例</span></div>
    <div className="ha-process-row"><svg width="16" height="16" viewBox="0 0 16 16" aria-label="子代理示例" role="img">{Array.from({length:6},(_,i)=><path key={i} d="M8 8 6 1h4Z" fill="currentColor" opacity={i%2?0.6:1} transform={`rotate(${i*60} 8 8)`}/>)}</svg><span>子代理已完成 · 展示示例</span></div>
    <div className="ha-answer-table" role="region" aria-label="成果表格排版示例，可横向滚动" tabIndex={0}><table><caption>窄窗表格排版 · 演示，非本轮执行结果</caption><thead><tr><th scope="col">内容</th><th scope="col">版本依据</th><th scope="col">可用范围</th><th scope="col">继续操作</th></tr></thead><tbody><tr><td>原始资料</td><td>当前明确授权的来源版本</td><td>保留原表的行列与来源</td><td>来源变化后重新核对相关成果</td></tr><tr><td>分析成果</td><td>实际执行时使用的输入</td><td>只沿用仍有效的结果</td><td>保留历史版本，修订生成新版本</td></tr></tbody></table></div>
  </details>;
}
