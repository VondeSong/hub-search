import { useEffect, useRef, useState } from "react";
import { Minus, Plus, RotateCcw, X } from "lucide-react";
import "./LibraryIconCrop.css";

export function iconCropRect(width:number,height:number,zoom:number,x:number,y:number) {
  const side=Math.min(width,height)/Math.max(1,Math.min(4,zoom));
  return {sx:(width-side)/2*(1-Math.max(-1,Math.min(1,x))),sy:(height-side)/2*(1-Math.max(-1,Math.min(1,y))),side};
}

export function LibraryIconCrop({source,name,onSave,onCancel}:{source:string;name:string;onSave:(png:string)=>Promise<void>;onCancel:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null),image=useRef<HTMLImageElement>(null),viewport=useRef<HTMLDivElement>(null);
  const drag=useRef<{x:number;y:number;ox:number;oy:number}|null>(null);
  const [dimensions,setDimensions]=useState({width:0,height:0});
  const [zoom,setZoom]=useState(1),[offset,setOffset]=useState({x:0,y:0}),[viewSize,setViewSize]=useState(280);
  const [saving,setSaving]=useState(false),[error,setError]=useState("");
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setViewSize(entry.contentRect.width);
    });
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  const crop=iconCropRect(dimensions.width||1,dimensions.height||1,zoom,offset.x,offset.y);
  const scale=viewSize/crop.side;
  const maxX=(dimensions.width*scale-viewSize)/2,maxY=(dimensions.height*scale-viewSize)/2;
  const clamp=(n:number)=>Math.max(-1,Math.min(1,n));
  const reset=()=>{setZoom(1);setOffset({x:0,y:0});};
  async function save(){
    if(!image.current||!dimensions.width||saving)return;
    setSaving(true);setError("");
    try{
      const canvas=document.createElement("canvas");canvas.width=canvas.height=256;
      const context=canvas.getContext("2d");if(!context)throw new Error("无法生成裁剪图标");
      context.drawImage(image.current,crop.sx,crop.sy,crop.side,crop.side,0,0,256,256);
      await onSave(canvas.toDataURL("image/png"));
    }catch(reason){setError(String(reason));setSaving(false);}
  }
  return <dialog ref={dialog} className="library-icon-crop-dialog" aria-labelledby="library-icon-crop-title" onCancel={e=>{e.preventDefault();if(!saving)onCancel();}}>
    <header><h2 id="library-icon-crop-title">裁剪资料库图标</h2><button aria-label="关闭图标裁剪" disabled={saving} onClick={onCancel}><X size={18}/></button></header>
    <p>{name} · 拖动图片调整位置，缩放选择保留的区域。</p>
    <div ref={viewport} className="library-icon-crop-viewport" role="application" aria-label="图标裁剪区域，可拖动或使用方向键调整" tabIndex={0}
      onPointerDown={e=>{if(saving||!dimensions.width)return;e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,ox:offset.x,oy:offset.y};}}
      onPointerMove={e=>{if(!drag.current)return;setOffset({x:maxX>0?clamp(drag.current.ox+(e.clientX-drag.current.x)/maxX):0,y:maxY>0?clamp(drag.current.oy+(e.clientY-drag.current.y)/maxY):0});}}
      onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}
      onKeyDown={e=>{if(saving)return;const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!delta)return;e.preventDefault();setOffset({x:maxX>0?clamp(offset.x+delta[0]*12/maxX):0,y:maxY>0?clamp(offset.y+delta[1]*12/maxY):0});}}
    >
      <img ref={image} src={source} alt="待裁剪的资料库图标" draggable={false} onLoad={e=>setDimensions({width:e.currentTarget.naturalWidth,height:e.currentTarget.naturalHeight})} onError={()=>setError("图片无法打开，请重新选择图标。")}
        style={{width:dimensions.width*scale,height:dimensions.height*scale,left:-crop.sx*scale,top:-crop.sy*scale,visibility:dimensions.width?"visible":"hidden"}}/>
      <span className="library-icon-crop-grid" aria-hidden="true"/>
    </div>
    <div className="library-icon-crop-zoom"><Minus size={15}/><input aria-label="图标缩放" type="range" min="1" max="4" step="0.01" value={zoom} disabled={saving} onChange={e=>setZoom(Number(e.target.value))}/><Plus size={15}/><button aria-label="重置图标裁剪" disabled={saving} onClick={reset}><RotateCcw size={16}/></button></div>
    <p className="library-icon-crop-hint">保存后，所有位置统一使用裁剪后的图标。</p>
    {error&&<p className="library-icon-crop-error" role="alert">{error}</p>}
    <footer><button disabled={saving} onClick={onCancel}>取消</button><button className="library-icon-crop-save" disabled={saving||!dimensions.width} onClick={()=>void save()}>{saving?"正在保存…":"保存图标"}</button></footer>
  </dialog>;
}
