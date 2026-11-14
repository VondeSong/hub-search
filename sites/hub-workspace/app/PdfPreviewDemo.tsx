"use client";
import {useState} from 'react';
import {ChevronLeft,ChevronRight,Minus,Plus} from 'lucide-react';
import {adjacentPdfPage,closestPdfHit,parsePdfPage,pdfZoomStep,type PdfMode} from './pdf-preview-model';
import './pdf-preview.css';

export function PdfPreviewDemo(){
 const[scenario,setScenario]=useState('ready'),[page,setPage]=useState(14),[input,setInput]=useState('14');
 const[mode,setMode]=useState<PdfMode>('all'),[zoom,setZoom]=useState<number|null>(null),[error,setError]=useState('');
 const[query,setQuery]=useState('接口'),[searched,setSearched]=useState('接口'),[note,setNote]=useState('');
 const total=scenario==='single'?1:120;
 const hits=!searched||scenario==='failed'||scenario==='empty'?[]:scenario==='single'?[1]:scenario==='partial'?[3,14,57]:[3,14,57,120];
 const indexed=scenario==='failed'?0:scenario==='partial'?24:total;
 function go(next:number){setPage(next);setInput(String(next));setError('');}
 const previous=adjacentPdfPage(page,total,hits,mode,-1),next=adjacentPdfPage(page,total,hits,mode,1);
 function changeScenario(value:string){setScenario(value);setMode('all');setNote('');setError('');go(value==='single'?1:14);if(value==='unsearched'){setQuery('');setSearched('');}else{setQuery('接口');setSearched('接口');}}
 return <section className="pdf-reader" aria-label="PDF 预览交互示例">
  <p className="pdf-reader-note">交互示例 · 页面为示意，命中为预设；不读取实际 PDF 或索引。</p>
  <div className="pdf-query"><label>PDF 正文关键词<input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){setSearched(query.trim());setMode('all');}}}/></label><button onClick={()=>{setSearched(query.trim());setMode('all');setNote('已更新示例查询；实际桌面按页级索引检索。');}}>检索示例</button></div>
  <div className="pdf-controls">
   <form onSubmit={e=>{e.preventDefault();const r=parsePdfPage(input,total);if(r.error){setError(r.error);return;}if(mode==='hits'&&!hits.includes(r.page!)){setMode('all');setNote(`已切换全文查看第 ${r.page} 页。`);}go(r.page!);}}>
    <button type="button" aria-label="上一页" disabled={previous===undefined} onClick={()=>go(previous!)}><ChevronLeft size={15}/></button>
    <label>第<input aria-label="PDF 页码" inputMode="numeric" value={input} onChange={e=>setInput(e.target.value)} aria-invalid={!!error}/></label><span>/ {total} 页</span><button type="submit">跳转</button>
    <button type="button" aria-label="下一页" disabled={next===undefined} onClick={()=>go(next!)}><ChevronRight size={15}/></button>
   </form>
   <div className="pdf-zoom"><button aria-label="缩小 PDF" disabled={zoom===50} onClick={()=>setZoom(pdfZoomStep(zoom??100,-1))}><Minus size={14}/></button><select aria-label="PDF 缩放" value={zoom??'fit'} onChange={e=>setZoom(e.target.value==='fit'?null:Number(e.target.value))}><option value="fit">适合宽度</option>{[50,75,100,125,150,175,200,225,250,275,300].map(n=><option key={n} value={n}>{n}%</option>)}</select><button aria-label="放大 PDF" disabled={zoom===300} onClick={()=>setZoom(pdfZoomStep(zoom??100,1))}><Plus size={14}/></button><button onClick={()=>setZoom(null)}>恢复适配</button><button onClick={()=>setNote(`原文目标：阅读摘录样例.pdf · 第 ${page} 页。此处为交互示例，不打开真实文件。`)}>打开原 PDF</button></div>
   <div className="pdf-mode" aria-label="PDF 浏览范围"><button aria-pressed={mode==='all'} onClick={()=>{setMode('all');setNote(`已切换全文，停留第 ${page} 页。`);}}>全文</button><button aria-pressed={mode==='hits'} disabled={!hits.length} onClick={()=>{setMode('hits');go(closestPdfHit(page,hits)!);setNote('按原文页码浏览命中页；切回全文保留当前页。');}}>仅命中页{searched&&` · ${hits.length}`}</button></div>
  </div>
  {error&&<p role="alert" className="pdf-reader-error">{error}</p>}
  <p className="pdf-reader-status" role="status">{scenario==='failed'?'提取失败，尚无可检索页，不能判断是否有命中。':!searched?'尚未搜索；可以按原文页码浏览。':`${indexed}/${total} 页已建立可检索文字；${hits.length} 个命中页${mode==='hits'?`，当前第 ${hits.indexOf(page)+1}/${hits.length} 个，原文第 ${page} 页`:''}。`}{scenario==='partial'&&'其余 96 页未纳入页级检索，不代表没有命中。'}</p>
  {note&&<p className="pdf-reader-note">{note}</p>}
  <div className="pdf-image-viewport" tabIndex={0} aria-label="PDF 页面示意；PageUp 和 PageDown 翻页" onKeyDown={e=>{if(e.key==='PageDown'&&next!==undefined){e.preventDefault();go(next);}if(e.key==='PageUp'&&previous!==undefined){e.preventDefault();go(previous);}}}>
   <article className="pdf-page-sample" style={{width:zoom?`${zoom*5}px`:'100%'}}><small>页面示意 · 原文第 {page} 页</small><h3>阅读摘录样例</h3><p>这一页用来检查阅读空间、页码和缩放控件。<mark>{hits.includes(page)?'接口':'页面示意'}</mark> 的突出显示仅是交互演示。</p><hr/><p>切换“仅命中页”会跳过未命中的页，但始终保留原文页码。不会把第 2 个命中误叫成原文第 2 页。</p><footer>{page} / {total}</footer></article>
  </div>
  <details className="pdf-boundaries"><summary>边界状态演示</summary><label>示例状态<select value={scenario} onChange={e=>changeScenario(e.target.value)}><option value="ready">已索引，可浏览命中</option><option value="partial">仅部分页有可检索文字</option><option value="failed">提取失败</option><option value="unsearched">尚未搜索</option><option value="empty">已搜索，无匹配</option><option value="single">只有一页</option></select></label><p>实际预览沿用单页渲染；缩放仅改变显示，不新增 OCR 或整份转图。未提取与失败不能当作零命中。</p></details>
 </section>;
}
