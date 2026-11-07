import { useEffect, useRef } from "react";
export function CollectionColumnResize({name,column,width,min=72,onStart,onChange}:{name:string;column:string;width:number;min?:number;onStart:()=>number;onChange:(width:number)=>void}){
 const cleanup=useRef<(()=>void)|null>(null);
 useEffect(()=>()=>cleanup.current?.(),[]);
 return <span className="collection-column-resize" role="separator" aria-label={`调整${name}列宽`} aria-orientation="vertical" aria-valuenow={Math.round(width)} aria-valuemin={min} aria-valuemax={1600} tabIndex={0} data-column={column} title="拖拽调整列宽" onPointerDown={event=>{
 if(event.button!==0)return;event.preventDefault();event.stopPropagation();cleanup.current?.();event.currentTarget.focus();
 const startX=event.clientX,startWidth=onStart(),pointer=event.pointerId;
 const cursor=document.body.style.cursor,select=document.body.style.userSelect;
 document.body.style.cursor="col-resize";document.body.style.userSelect="none";
 const move=(moveEvent:PointerEvent)=>{if(moveEvent.pointerId!==pointer)return;onChange(Math.min(1600,Math.max(min,Math.round(startWidth+moveEvent.clientX-startX))));};
 const finish=()=>{document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",finish);document.removeEventListener("pointercancel",finish);window.removeEventListener("blur",finish);document.body.style.cursor=cursor;document.body.style.userSelect=select;cleanup.current=null;};
 cleanup.current=finish;document.addEventListener("pointermove",move);document.addEventListener("pointerup",finish,{once:true});document.addEventListener("pointercancel",finish,{once:true});window.addEventListener("blur",finish,{once:true});
 }} onKeyDown={event=>{if(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")return;event.preventDefault();event.stopPropagation();onStart();onChange(Math.min(1600,Math.max(min,width+(event.key==="ArrowRight"?16:-16))));}}/>;
}
