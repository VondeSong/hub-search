import {invoke} from "@tauri-apps/api/core";
import {ChevronLeft,ChevronRight,Minus,Plus,ExternalLink} from "lucide-react";
import {useEffect,useRef,useState,type Dispatch,type SetStateAction} from "react";
import {HighlightedText} from "./SearchPresentation";
import type {PdfPagePreview,SearchResult} from "./SearchTypes";
import {adjacentPdfPage,closestPdfHit,parsePdfPage,pdfZoomStep,validPdfPages,type PdfMode} from "./PdfPreviewModel";
import "./PdfPreviewPanel.css";
import {PdfPreviewRequests} from "./PdfPreviewRequests";

export type PdfSearchPages = {sourceId:string;query:string;pageCount:number;pageCountNote?:string|null;indexedPageCount:number;availableTextPageCount:number;hitPages:number[];extractionStatus:string;failedPageCount:number;revisionStatus:string;truncated:boolean};
type Props={selected:SearchResult;query:string;page:number;preview:PdfPagePreview|null;loading:boolean;error?:string|null;terms:string[];onPageChange:Dispatch<SetStateAction<number>>};

export function PdfPreviewPanel({selected,query,page,preview,loading,error,terms,onPageChange}:Props){
 const[mode,setMode]=useState<PdfMode>("all"),[zoom,setZoom]=useState<number|null>(null),[input,setInput]=useState(String(page));
 const[validation,setValidation]=useState(""),[notice,setNotice]=useState(""),[rawData,setData]=useState<PdfSearchPages|null>(null);
 const[rawSearchError,setSearchError]=useState(""),[rawSearching,setSearching]=useState(false),[retry,setRetry]=useState(0),[opening,setOpening]=useState(false);
 const[naturalWidth,setNaturalWidth]=useState(1600);const viewport=useRef<HTMLDivElement>(null);const generation=useRef(0);
 const[searchRequests]=useState(()=>new PdfPreviewRequests<PdfSearchPages>());
 const responseContext=useRef("");
 const context=JSON.stringify([selected.id,selected.sourceItemId,selected.modifiedAt,query.trim()]);const currentContext=useRef(context);currentContext.current=context;
 const data=responseContext.current===context?rawData:null;const searchError=responseContext.current===context?rawSearchError:"";const searching=rawSearching||responseContext.current!==context;
 useEffect(()=>{setInput(String(page));setValidation("");viewport.current?.scrollTo?.({top:0,left:0});},[page]);
 useEffect(()=>{setMode("all");setNotice("");setOpening(false);},[selected.id,selected.modifiedAt,query]);
 useEffect(()=>{
  const ticket=++generation.current;let cancelled=false;setData(null);setSearchError("");setSearching(true);
  const timer=window.setTimeout(()=>{
   void searchRequests.request(context,()=>invoke<PdfSearchPages>("local_pdf_search_pages",{resultId:selected.id,query:query.trim()})).then(result=>{
    if(cancelled||ticket!==generation.current)return;
    responseContext.current=context;
    if(result.query!==query.trim()||(selected.sourceItemId&&result.sourceId!==selected.sourceItemId)){setSearchError("PDF 检索返回的来源不一致，请重新读取。");return;}
    setData(result);
   }).catch(reason=>{if(!cancelled&&ticket===generation.current){responseContext.current=context;setSearchError(String(reason));}}).finally(()=>{if(!cancelled&&ticket===generation.current)setSearching(false);});
  },query.trim()?250:0);
  return()=>{cancelled=true;window.clearTimeout(timer);searchRequests.cancelPending();};
 },[selected.id,selected.sourceItemId,selected.modifiedAt,query,retry]);
 const total=data?.pageCount??preview?.pageCount??0;
 const hits=validPdfPages(data?.hitPages??[],total);
 const previous=adjacentPdfPage(page,total,hits,mode,-1),next=adjacentPdfPage(page,total,hits,mode,1);
 const go=(value:number)=>{setValidation("");onPageChange(value);};
 const status=!query.trim()?`尚未搜索${data?`；${data.availableTextPageCount} 页已有提取文字`:""}。`
  :searching?"正在读取当前查询的页级命中…":searchError?"无法建立当前查询的命中页序列，全文浏览仍可使用。"
  :data&&data.indexedPageCount===0?"尚无可检索的页文字，不能据此判断 PDF 没有命中。"
  :data?`${data.indexedPageCount}/${data.pageCount} 页的现有文字索引可检索；${hits.length?`${hits.length} 个命中页`:"当前索引中未找到正文命中"}。`:"";
 const textStatus=preview?.textStatus??(preview?.text?"indexed":"not_extracted");
 const textEmpty=textStatus==="failed"?"本页文字提取失败；可继续查看原页图像。":textStatus==="stale"?"本页提取文字属于旧版本，已停止展示；请等待来源重新索引。":textStatus==="empty"?"本页已处理，未提取到文字。":"本页尚无可用提取文字；这不代表页面没有相关内容。";
 async function openPdf(){
  const key=context;setOpening(true);setNotice("正在准备原 PDF…");
  try{await invoke("open_pdf_page",{resultId:selected.id,pageNumber:page});if(currentContext.current===key)setNotice(`已请求打开原 PDF 第 ${page} 页；外部阅读器是否定位取决于其页码链接支持。`);}
  catch(reason){if(currentContext.current===key)setNotice(`打开 PDF 失败：${String(reason)}`);}
  finally{if(currentContext.current===key)setOpening(false);}
 }
 return <section className="pdf-reader" aria-label="PDF 预览">
  <div className="pdf-controls" aria-label="PDF 页码与缩放">
   <form onSubmit={event=>{event.preventDefault();const result=parsePdfPage(input,total);if(result.error){setValidation(result.error);return;}if(mode==="hits"&&!hits.includes(result.page!)){setMode("all");setNotice(`已切换全文查看原文第 ${result.page} 页。`);}go(result.page!);}}>
    <button type="button" aria-label={mode==="hits"?"上一个命中页":"上一页"} disabled={!total||previous===undefined} onClick={()=>go(previous!)}><ChevronLeft size={16}/></button>
    <label>第<input aria-label="PDF 页码" inputMode="numeric" value={input} onChange={e=>setInput(e.target.value)} aria-invalid={!!validation} aria-describedby={validation?"pdf-page-error":undefined} disabled={!total}/></label><span>/ {total||"—"} 页</span><button type="submit" disabled={!total}>跳转</button>
    <button type="button" aria-label={mode==="hits"?"下一个命中页":"下一页"} disabled={!total||next===undefined} onClick={()=>go(next!)}><ChevronRight size={16}/></button>
   </form>
   <div className="pdf-zoom"><button aria-label="缩小 PDF" disabled={zoom===50} onClick={()=>setZoom(pdfZoomStep(zoom??100,-1))}><Minus size={15}/></button><select aria-label="PDF 缩放" value={zoom??"fit"} onChange={e=>setZoom(e.target.value==="fit"?null:Number(e.target.value))}><option value="fit">适合宽度</option>{[50,75,100,125,150,175,200,225,250,275,300].map(n=><option value={n} key={n}>{n}%</option>)}</select><button aria-label="放大 PDF" disabled={zoom===300} onClick={()=>setZoom(pdfZoomStep(zoom??100,1))}><Plus size={15}/></button><button onClick={()=>setZoom(null)}>恢复适配</button></div>
   <div className="pdf-mode" aria-label="PDF 浏览范围"><button aria-pressed={mode==="all"} onClick={()=>{setMode("all");setNotice(`已切换全文，保留原文第 ${page} 页。`);}}>全文</button><button aria-pressed={mode==="hits"} disabled={searching||!query.trim()||!hits.length} onClick={()=>{setMode("hits");go(closestPdfHit(page,hits)!);setNotice("切回全文会保留当前原文页码。");}}>仅命中页{data&&query.trim()?` · ${hits.length}`:""}</button></div>
   <button disabled={opening||!total} onClick={()=>void openPdf()}><ExternalLink size={14}/>{opening?"准备中…":"打开原 PDF"}</button>
  </div>
  {validation&&<p role="alert" id="pdf-page-error" className="pdf-reader-error">{validation}</p>}
  <p role="status" className="pdf-reader-status">{status}{mode==="hits"&&` 第 ${hits.indexOf(page)+1}/${hits.length} 个命中，原文第 ${page} 页。`}</p>
  {data&&query.trim()&&data.indexedPageCount<data.pageCount&&<p className="pdf-reader-note">未纳入页级检索的页面，可能尚未提取、没有文字或处理失败；不能当作无命中。</p>}
  {data?.failedPageCount? <p className="pdf-reader-note">{data.failedPageCount} 页的 OCR 处理记录为失败；图像和已有原生文字可分别查看。</p>:null}
  {data?.extractionStatus==="failed"&&<p className="pdf-reader-error">PDF 原生文字提取失败。</p>}
  {data?.pageCountNote&&!preview?.note&&<p className="pdf-reader-note">{data.pageCountNote}</p>}
  {data?.revisionStatus==="legacy"&&<p className="pdf-reader-note">这些历史页文字未记录文件版本绑定，命中来自现有索引；请对照原页确认。</p>}
  {data?.revisionStatus==="stale"&&<p className="pdf-reader-note">已排除旧版本文字命中，索引更新完成前结果可能不完整。</p>}
  {data?.truncated&&<p className="pdf-reader-note">本轮达到文档检索上限，只显示部分页级结果；请缩小关键词范围。</p>}
  {searchError&&<p className="pdf-reader-error" role="alert">{searchError}<button onClick={()=>setRetry(n=>n+1)}>重试页级检索</button></p>}
  {notice&&<p className="pdf-reader-note" role="status">{notice}</p>}
  <div className="pdf-image-viewport" ref={viewport} tabIndex={0} aria-label="PDF 页图；PageUp、PageDown 翻页，加减键缩放，Ctrl+0 恢复适配" onKeyDown={e=>{
   const target=e.target as HTMLElement;if(target!==e.currentTarget)return;
   if(e.key==="PageDown"&&next!==undefined){e.preventDefault();go(next);}else if(e.key==="PageUp"&&previous!==undefined){e.preventDefault();go(previous);}
   else if(e.key==="Home"&&total){e.preventDefault();go(mode==="hits"?hits[0]:1);}else if(e.key==="End"&&total){e.preventDefault();go(mode==="hits"?hits[hits.length - 1]!:total);}
   else if(e.key==="+"||e.key==="="){e.preventDefault();setZoom(pdfZoomStep(zoom??100,1));}else if(e.key==="-"){e.preventDefault();setZoom(pdfZoomStep(zoom??100,-1));}else if((e.ctrlKey||e.metaKey)&&e.key==="0"){e.preventDefault();setZoom(null);}
  }}>
   {loading?<div className="pdf-page-placeholder" role="status">正在载入原文第 {page} 页…</div>:preview?.imageDataUrl?<img className="pdf-reader-image" src={preview.imageDataUrl} alt={`${selected.sourceTitle??selected.title} · 原文第 ${preview.pageNumber} 页`} style={{width:zoom?`${naturalWidth*zoom/100}px`:"100%"}} onLoad={e=>setNaturalWidth(e.currentTarget.naturalWidth||1600)}/>:<div className="pdf-page-placeholder">{error||"本页图像暂不可用，可查看下方提取状态。"}</div>}
  </div>
  {!loading&&error&&!preview&&<p className="pdf-reader-error" role="alert">{error}</p>}
  {preview?.note&&<p className="pdf-reader-note">{preview.note}</p>}
  {!loading&&preview&&<><h2>{preview.sourceType==="pdf_ocr"?"本页 OCR 文字":"本页 PDF 原生文字"}</h2>{preview.text?<div className="ocr-text"><HighlightedText text={preview.text} terms={terms} navigable/></div>:<p className="pdf-reader-note">{textEmpty}</p>}</>}
 </section>;
}
