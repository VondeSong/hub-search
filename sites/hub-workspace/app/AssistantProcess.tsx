"use client";
import {useEffect,useRef,useState} from 'react';
import {AppWindow,BookOpen,Check,ChevronDown,FilePenLine,FileText,FolderOpen,Globe2,Images,MessagesSquare,Search,SquareTerminal as Terminal,TriangleAlert} from 'lucide-react';

const examples = [
  ['timeline', '同题回放'],
  ['short', '简短问答'],
  ['read', '读取与恢复'],
  ['web', '网页检索'],
  ['tools', '浏览器与应用'],
  ['receipts', '文件与图像'],
  ['script', '脚本检查'],
  ['files', '分批分析'],
] as const;

const attachmentScript = `from pathlib import Path
from struct import unpack_from

data = Path("quazip.dll").read_bytes()
pe_offset = unpack_from("<I", data, 0x3c)[0]
assert data[pe_offset:pe_offset + 4] == b"PE\\0\\0"
machine = unpack_from("<H", data, pe_offset + 4)[0]
magic = unpack_from("<H", data, pe_offset + 24)[0]
print(f"Machine: 0x{machine:04X}")
print(f"Optional header: 0x{magic:04X}")
print(f"Size: {len(data):,} bytes")`;

const batches = Array.from({length:14}, (_, index) => {
  const first = index * 1100 + 1;
  const last = first + 1099;
  return {first, last, file: `analysis_${first}_${last}.csv`};
});

function GitHubMark() {
  return <span className="ha-process-brand" aria-hidden="true"/>;
}

const toolKinds = {
  github: {icon: GitHubMark, caption: '使用了 GitHub'},
  browser: {icon: AppWindow, caption: '浏览了网页'},
  command: {icon: Terminal, caption: '运行了命令'},
  edit: {icon: FilePenLine, caption: '编辑了文件'},
  readChat: {icon: MessagesSquare, caption: '读取了聊天'},
  renameChat: {icon: FilePenLine, caption: '重命名了聊天'},
};

const toolSteps = [
  {kind:'command', title:'检查工作区', receipt:'执行成功 · 退出码 0'},
  {kind:'edit', title:'编辑工作区文件', receipt:'已更新说明文档'},
  {kind:'browser', title:'打开网页', receipt:'打开成功 · developers.openai.com'},
  {kind:'readChat', title:'读取聊天', receipt:'读取成功'},
  {kind:'renameChat', title:'重命名聊天', receipt:'重命名成功'},
  {kind:'github', title:'准备 GitHub 评论草稿', receipt:'草稿已准备，等待确认发布。'},
  {kind:'github', title:'读取 GitHub 评论', receipt:'已读取评论。'},
] as const;

function ProcessGroup({title, icon: Icon, children}: {
  title: string;
  icon: typeof FileText | typeof GitHubMark;
  children: React.ReactNode;
}) {
  return <details className="ha-process-group">
    <summary><Icon size={16} aria-hidden="true"/><span className="ha-process-label">{title}</span><ChevronDown size={13} aria-hidden="true"/></summary>
    <div className="ha-process-children">{children}</div>
  </details>;
}

type SearchSource = {domain:string; title?:string; query?:string};

function SearchReceipt({queries, sources}: {queries:string[]; sources:SearchSource[]}) {
  const title = `搜索网页 · ${queries[0]}${queries.length > 1 ? ` · 另 ${queries.length-1} 条查询` : ''}`;
  const chips = (items:SearchSource[]) => <ul className="ha-search-sources">{items.map(source=>
    <li key={source.domain}><a href={`https://${source.domain}`} target="_blank" rel="noreferrer"><Globe2 size={14} aria-hidden="true"/>{source.title && !/^\s*</.test(source.title) ? source.title : source.domain}</a></li>
  )}</ul>;
  const batch = queries.length === 1 ? [] : sources.filter(source => !queries.includes(source.query ?? ''));
  return <details className="ha-process-batch">
    <summary title={title}><Search size={15} aria-hidden="true"/><span className="ha-process-label">{title}</span><ChevronDown size={12} aria-hidden="true"/></summary>
    {queries.map(query => {
      const matches = queries.length === 1 ? sources : sources.filter(source => source.query === query);
      return <div key={query}><p>{query}</p>{matches.length > 0 && chips(matches)}</div>;
    })}
    {batch.length > 0 && <details open><summary>本批来源 · {batch.length} 项</summary>{chips(batch)}</details>}
  </details>;
}

function MixedToolExample() {
  const orderedKinds = Object.keys(toolKinds) as (keyof typeof toolKinds)[];
  const kinds = orderedKinds.filter(kind => toolSteps.some(step => step.kind === kind));
  const header = kinds.map(kind => toolKinds[kind].caption).join('、');
  return <div className="ha-replay-body">
    <details className="ha-replay-process" open>
      <summary>用时 2 分 4 秒<ChevronDown size={13} aria-hidden="true"/></summary>
      <div className="ha-replay-activity">
        <p>先核对工作区和聊天，再回读 GitHub 记录。</p>
        <ProcessGroup title={header} icon={toolKinds[kinds[0]].icon}>
          {toolSteps.map(step => {
            const Icon = toolKinds[step.kind].icon;
            return <details key={step.title} className="ha-process-batch">
              <summary><Icon size={15} aria-hidden="true"/><span>{step.title}</span><ChevronDown size={12} aria-hidden="true"/></summary>
              <p>{step.receipt}</p>
            </details>;
          })}
        </ProcessGroup>
      </div>
    </details>
    <details className="ha-process-permissions"><summary>本轮工具与权限</summary><ul><li>GitHub · 读取评论、准备评论草稿</li><li>独立浏览器 · developers.openai.com</li><li>内置网页搜索关闭</li></ul></details>
  </div>;
}

function WorkspaceReceiptsExample() {
  const dialog = useRef<HTMLDialogElement>(null);
  const thumbnail = useRef<HTMLButtonElement>(null);
  return <div className="ha-replay-body">
    <p className="ha-process-meta">工作区回执示例</p>
    <details className="ha-replay-process" open>
      <summary>用时 34 秒<ChevronDown size={13} aria-hidden="true"/></summary>
      <p>先检查配置，再回读预览。</p>
      <ProcessGroup title="编辑了文件、运行了命令、查看了图像" icon={FilePenLine}>
        {[['compact: false', 'compact: true'], ['compact: true', 'compact: auto']].map(([before, after], index) => <details className="ha-process-batch" key={after}>
          <summary><FilePenLine size={15} aria-hidden="true"/>编辑 settings.yml · 第 {index + 1} 次<ChevronDown size={12} aria-hidden="true"/></summary>
          <details className="ha-receipt-diff"><summary>config/settings.yml · +1 −1</summary><pre tabIndex={0} aria-label="文件差异"><span className="ha-diff-deleted">- {before}</span>{'\n'}<span className="ha-diff-added">+ {after}</span></pre></details>
        </details>)}
        <details className="ha-process-batch">
          <summary><Terminal size={15} aria-hidden="true"/>运行了配置检查<ChevronDown size={12} aria-hidden="true"/></summary>
          <p className="ha-script-status">执行成功 · 退出码 0</p>
          <div className="ha-script-region"><pre tabIndex={0} aria-label="命令输出">已读取配置。检查通过。</pre></div>
        </details>
        <details className="ha-process-batch">
          <summary><Images size={15} aria-hidden="true"/>已查看 1 张图像<ChevronDown size={12} aria-hidden="true"/></summary>
          <button ref={thumbnail} type="button" className="ha-receipt-thumbnail" onClick={() => dialog.current?.showModal()} aria-label="放大工作台预览"><img src="/hub-workspace-preview.jpg" alt="工作台预览"/></button>
        </details>
      </ProcessGroup>
      <p>配置已通过检查，预览已回读。</p>
    </details>
    <p>配置文件已更新，并已核对预览。</p>
    <details className="ha-process-permissions"><summary>本轮文件变更 · 1 个文件 · +1 −1</summary><p>config/settings.yml</p></details>
    <dialog ref={dialog} className="ha-receipt-dialog" aria-label="工作台预览" onClose={() => thumbnail.current?.focus()}>
      <form method="dialog"><button type="submit">关闭图片</button></form><img src="/hub-workspace-preview.jpg" alt="工作台预览"/>
    </dialog>
  </div>;
}

function AttachmentReplay() {
  const [step,setStep] = useState(0);
  const [playing,setPlaying] = useState(true);
  const [revision,setRevision] = useState(0);
  const [processOpen,setProcessOpen] = useState(true);
  const review = useRef(false);
  const replay = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!playing || step === 5) return;
    const timer = window.setTimeout(() => {
      if (step === 3) {
        const viewport = replay.current?.closest('.ha-messages');
        const following = !viewport || viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
        if (following && !review.current) setProcessOpen(false);
      }
      setStep(value => value + 1);
    }, step === 0 ? 2400 : 3200);
    return () => window.clearTimeout(timer);
  }, [step,playing,revision]);
  const seconds = step === 0 ? 0 : Math.round((2400 + (step - 1) * 3200) / 1000);

  return <>
    <div className="ha-replay-toolbar">
      <span>附件分析 · 录屏回放示例</span>
      {step < 5 && <button type="button" onClick={() => setPlaying(value => !value)}>{playing ? '暂停回放' : '继续回放'}</button>}
      <button type="button" onClick={() => { review.current = false; setRevision(value => value+1); setStep(0); setPlaying(true); setProcessOpen(true); }}>重播</button>
    </div>
    <div key={revision} ref={replay} className="ha-replay-body" onClickCapture={event => {
      if ((event.target as Element).closest('summary')) review.current = true;
    }}>
      <details className="ha-replay-process" open={processOpen} onToggle={event => setProcessOpen(event.currentTarget.open)}>
        <summary>{step < 4 ? '已处理' : '用时'} {seconds} 秒<ChevronDown size={13} aria-hidden="true"/></summary>
        <div className="ha-replay-activity">
          {step >= 1 && <p>先核对两个附件的架构、版本及签名。</p>}
          {step >= 1 && <ProcessGroup title={step === 1 ? '正在读取文件版本' : '已检查两个附件'} icon={Terminal}>
            <details className="ha-process-batch"><summary>读取文件版本 <ChevronDown size={12}/></summary>
              {step >= 2 ? <div className="ha-script-region"><p>PowerShell · 示例</p><pre tabIndex={0}><code>{'(Get-Item .\\vcruntime140.dll).VersionInfo.FileVersion\n14.29.30147.0'}</code></pre><small>退出码 0</small></div> : <p>正在读取 PowerShell 版本信息</p>}
            </details>
          </ProcessGroup>}
          {step >= 2 && <p>两个文件的版本一致。接下来查找公开的分发和使用记录。</p>}
          {step >= 2 && <ProcessGroup title={step === 2 ? '正在搜索网页' : step === 3 ? '正在核对网页来源' : '已检索网页并核对来源'} icon={Search}>
            <SearchReceipt queries={['vcruntime140_1.dll 与 vcruntime140.dll 成对分发']} sources={step >= 3 ? [
              {domain:'spotfire.com',title:'Spotfire 发布说明'},
              {domain:'learn.microsoft.com',title:'Microsoft C++ 团队'},
            ] : []}/>
            {step >= 3 && <details className="ha-process-batch"><summary><TriangleAlert size={14}/>命令未完成 <ChevronDown size={12}/></summary><p>这一步未取得结果，已保留其他来源。</p></details>}
          </ProcessGroup>}
          {step === 0 && <p role="status" className="ha-current-action"><span className={playing ? 'ha-active-ink' : ''}>正在思考</span></p>}
        </div>
      </details>
      {step >= 4 && <p>这两个附件是 x64 Visual C++ 运行库组件，文件版本均为 14.29.30147.0。</p>}
      {step === 5 && <table className="ha-replay-table"><thead><tr><th>附件</th><th>大小</th></tr></thead><tbody><tr><td>vcruntime140.dll</td><td>98,208 字节</td></tr><tr><td>vcruntime140_1.dll</td><td>38,304 字节</td></tr></tbody></table>}
    </div>
  </>;
}
export function AssistantProcessDemo({onClose}: {onClose: () => void}) {
  const [scenario,setScenario] = useState<(typeof examples)[number][0]>('timeline');
  const [readAgain,setReadAgain] = useState(false);
  const [visibleBatches,setVisibleBatches] = useState(5);
  return <section className="ha-process-review ha-process-demo" aria-label="工作过程示例">
    <header><h2>工作过程示例</h2><button type="button" onClick={onClose}>返回对话</button></header>
    <div className="ha-process-examples" role="group" aria-label="选择示例">
      {examples.map(([id,label]) => <button type="button" key={id} aria-pressed={scenario===id} onClick={()=>setScenario(id)}>{label}</button>)}
    </div>
    <div key={scenario} className="ha-process-example">
      {scenario === 'timeline' && <AttachmentReplay/>}
      {scenario === 'short' && <div className="ha-replay-body"><details className="ha-replay-process"><summary>用时 12 秒<ChevronDown size={13} aria-hidden="true"/></summary><div className="ha-replay-activity"><p className="ha-process-meta">本轮暂无可回看的公开过程。</p></div></details><p>这份清单按资料、核对项和待确认问题分成三部分。</p></div>}
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
      {scenario === 'tools' && <MixedToolExample/>}
      {scenario === 'receipts' && <WorkspaceReceiptsExample/>}
      {scenario === 'script' && <>
        <p className="ha-process-commentary">先读取附件的文件头，确认格式和架构。</p>
        <ProcessGroup title="已使用 Python 检查附件格式和架构" icon={Terminal}>
          <details className="ha-process-batch ha-process-script">
            <summary>
              <Terminal size={15} aria-hidden="true"/>
              <span>分析附件 · quazip.dll</span>
              <small>13 秒</small>
              <ChevronDown size={12} aria-hidden="true"/>
            </summary>
            <div className="ha-script-result">
              <div className="ha-script-status"><Check size={14} aria-hidden="true"/>执行成功 · 退出码 0</div>
              <div className="ha-script-region">
                <p>输出</p>
                <pre role="region" aria-label="示例输出" tabIndex={0}>{'Machine: 0x8664\nOptional header: 0x020B\nSize: 204,288 bytes'}</pre>
              </div>
              <details className="ha-process-technical">
                <summary>查看 Python 示例脚本</summary><pre role="region" aria-label="Python 示例脚本" tabIndex={0}><code>{attachmentScript}</code></pre>
              </details>
              <details className="ha-process-technical">
                <summary>技术记录 · JSON</summary>
                <pre tabIndex={0}>{JSON.stringify({file:'quazip.dll', machine:'0x8664', bytes:204288, exitCode:0}, null, 2)}</pre>
              </details>
            </div>
          </details>
        </ProcessGroup>
        <p>附件是一个 64 位 Windows DLL，文件大小为 204,288 字节。</p>
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
  return <details className="ha-activity ha-process-demo">
    <summary><Terminal size={16} aria-hidden="true"/><span>{webEnabled ? '已核对资料、检索网页并运行命令' : '已核对资料并运行工作区命令'}</span>{seconds && <small>{seconds} 秒</small>}<ChevronDown size={13} aria-hidden="true"/></summary>
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
          <SearchReceipt queries={['Codex App Server 事件','连接器权限与工具回执']} sources={[
            {domain:'developers.openai.com',title:'Codex App Server',query:'Codex App Server 事件'},
            {domain:'modelcontextprotocol.io',title:'工具定义',query:'连接器权限与工具回执'},
            {domain:'github.com',title:'<table id="example">'},
          ]}/>
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
