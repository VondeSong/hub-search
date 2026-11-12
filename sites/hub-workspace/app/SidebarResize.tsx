"use client";
import {useEffect,useRef,useState} from "react";
import {SIDEBAR_MIN,SIDEBAR_MAX,clampSidebarWidth,defaultSidebarWidth,parseSidebarWidths} from "./layout-data";
const KEY="hub-navigation-widths-v1";
export function useSidebarWidths(panel:string){
 const [widths,setWidths]=useState<Record<string,number>>({}),[ready,setReady]=useState(false);
 useEffect(()=>{try{setWidths(parseSidebarWidths(localStorage.getItem(KEY)));}catch{}setReady(true);},[]);
 useEffect(()=>{if(ready)try{localStorage.setItem(KEY,JSON.stringify(widths));}catch{}},[ready,widths]);
 return {width:widths[panel]??defaultSidebarWidth(panel),setWidth:(width:number)=>setWidths(old=>({...old,[panel]:clampSidebarWidth(width)})),resetAll:()=>setWidths({})};
}
export default function SidebarResize({panel,width,onChange,className=""}:{panel:string;width:number;onChange:(width:number)=>void;className?:string}){
 const drag=useRef<{x:number;width:number}|null>(null),[active,setActive]=useState(false);
 useEffect(()=>()=>{document.body.classList.remove("hub-resizing-navigation");},[]);
 function end(){drag.current=null;setActive(false);document.body.classList.remove("hub-resizing-navigation");}
 return <div className={"sidebar-resizer "+className+(active?" is-dragging":"")} role="separator" aria-label="调整左侧栏宽度" aria-controls="hub-module-navigation" aria-orientation="vertical" aria-valuenow={width} aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} aria-valuetext={width+" 像素"} title="拖动调整宽度，双击恢复默认" tabIndex={0}
 onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();drag.current={x:e.clientX,width};e.currentTarget.setPointerCapture(e.pointerId);document.body.classList.add("hub-resizing-navigation");setActive(true);}}
 onPointerMove={e=>{if(drag.current)onChange(clampSidebarWidth(drag.current.width+e.clientX-drag.current.x));}}
 onPointerUp={e=>{end();if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
 onPointerCancel={end} onLostPointerCapture={end} onDoubleClick={()=>onChange(defaultSidebarWidth(panel))}
 onKeyDown={e=>{const step=e.shiftKey?20:10;const value=e.key==="ArrowLeft"?width-step:e.key==="ArrowRight"?width+step:e.key==="Home"?SIDEBAR_MIN:e.key==="End"?SIDEBAR_MAX:undefined;if(value!==undefined){e.preventDefault();onChange(clampSidebarWidth(value));}}}/>;
}
