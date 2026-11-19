import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {ImageGrant} from "./AgentImages";
import type {AgentMaterial,NoteLocator} from "./AgentMaterials";
import {AgentMaterialCard} from "./AgentMaterialCard";

export const isTextAttachment=(locator:{libraryId?:string})=>locator.libraryId==="__hub_chat_text";
export function fileUseHint(item:AgentMaterial, deepseek:boolean){
 if(!deepseek || item.fileBytes===undefined)return undefined;
 return item.libraryPdf ? "DeepSeek 只能读资料库已提取的 PDF 文字" : "DeepSeek 当前无法打开原件";
}
export function AgentTextFileCard({locator,disabled,onRemove,deepseek=false}:{locator:NoteLocator;disabled:boolean;onRemove:()=>void;deepseek?:boolean}){
 const [item,setItem]=useState<AgentMaterial|null>(null);
 useEffect(()=>{let alive=true;void invoke<AgentMaterial>("agent_investigation",{args:{action:"textFileMetadata",locator}}).then(value=>{if(alive)setItem(value);},()=>{});return()=>{alive=false;};},[JSON.stringify(locator)]);
 const subtitle = item?.fileBytes !== undefined ? fileUseHint(item,deepseek) ?? `原文件 · ${(item.fileBytes/1024).toLocaleString(undefined,{maximumFractionDigits:1})} KiB · 按需读取` : item ? `已添加 · ${item.totalChars?.toLocaleString()} 字符 · 读取范围见工作过程` : "附件信息暂不可用";
 return <AgentMaterialCard kind="page" title={item?.title||"文件附件"} subtitle={subtitle} disabled={disabled} onRemove={onRemove} removeLabel={`撤回文件附件 ${item?.title||"文件附件"}`}/>;
}
// Leave room for two encoded images and the question within the native transport limit.
const imageTargetBytes=128*1024;
export function readDataUrl(file:Blob):Promise<string>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error("无法读取文件"));reader.readAsDataURL(file);});}
export async function prepareImage(file:File):Promise<{mime:string;base64:string}>{
 if(file.size>20*1024*1024)throw new Error("图片超过20 MiB，请先缩小图片。");
 const original=await readDataUrl(file);
 const image=new Image();
 await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error("图片无法解码，请选择 PNG、JPEG 或 WebP。"));image.src=original;});
 if(!image.naturalWidth||!image.naturalHeight||image.naturalWidth*image.naturalHeight>32_000_000)throw new Error("图片像素过大，请先缩小图片。");
 if(file.size<=imageTargetBytes&&image.naturalWidth<=8192&&image.naturalHeight<=8192&&image.naturalWidth*image.naturalHeight<=16_000_000)return {mime:file.type,base64:original.split(",")[1]};
 const canvas=document.createElement("canvas");const context=canvas.getContext("2d");if(!context)throw new Error("无法处理图片");
 for(let edge=2048;edge>=512;edge=Math.floor(edge*.75)){
  const scale=Math.min(1,edge/Math.max(image.naturalWidth,image.naturalHeight));canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));context.fillStyle="#fff";context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
  for(const quality of [.85,.65,.45]){const url=canvas.toDataURL("image/jpeg",quality);const encoded=url.split(",")[1];if(Math.ceil(encoded.length*3/4)<=imageTargetBytes)return {mime:"image/jpeg",base64:encoded};}
 }
 throw new Error("图片压缩后仍过大，请选择较小图片。");
}
export async function readTextFile(file:File):Promise<string>{
 if(!/\.(txt|md|csv|json)$/i.test(file.name))throw new Error("此文件需要使用原件读取方式。");
 if(file.size>2*1024*1024)throw new Error("文本附件最多2 MiB，请拆分文件后添加。");
 const url=await readDataUrl(file);const raw=atob(url.split(",")[1]);let text:string;
 try{text=new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(raw,c=>c.charCodeAt(0)));}catch{throw new Error("文本编码无法识别，请另存为 UTF-8 后添加。");}
 if(!text.trim()||text.includes("\0"))throw new Error("文件没有可读取的文本。");
 if(Array.from(text).length>500_000)throw new Error("文本附件最多50万字符，请拆分文件后添加；原文未截断。");
 return text;
}
export function AgentImageCards({images,disabled,pending,onRemove}:{images:ImageGrant[];disabled:boolean;pending:boolean;onRemove:(grant:ImageGrant)=>void}){
 return <div className="agent-image-cards" aria-label="图片资料">{images.map(grant=><ImageCard key={JSON.stringify(grant)} grant={grant} disabled={disabled} pending={pending} onRemove={()=>onRemove(grant)}/>)}</div>;
}
function ImageCard({grant,disabled,pending,onRemove}:{grant:ImageGrant;disabled:boolean;pending:boolean;onRemove:()=>void}){
 const [preview,setPreview]=useState<{title:string;url:string}|null>(null),[error,setError]=useState("");
 useEffect(()=>{let alive=true;void invoke<{title:string;url:string}>("agent_investigation",{args:{action:"imagePreview",grant}}).then(value=>{if(alive)setPreview(value);},()=>{if(alive)setError("预览不可用，请重新添加");});return()=>{alive=false;};},[JSON.stringify(grant)]);
 return <div className="agent-image-card">{preview?.url&&<img src={preview.url} alt={preview.title}/>}<span><strong>{preview?.title||"图片"}</strong><small>{error||(pending?"随问题发送 · 图片分析":"已添加 · 图片分析")}</small></span><button type="button" disabled={disabled} aria-label={`移除图片 ${preview?.title||"图片"}`} onClick={onRemove}>×</button></div>;
}
