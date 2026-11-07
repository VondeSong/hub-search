import {useState} from "react";
import {createRoot} from "react-dom/client";
import {AgentImageCards,prepareImage} from "../src/AgentFileInputs";
import type {ImageGrant} from "../src/AgentImages";
import "../src/App.css";
import "../src/AgentInvestigation.css";
let image={title:"测试截图.png",url:""};
Object.assign(window,{__TAURI_INTERNALS__:{invoke:async()=>image}});
function App(){const [images,setImages]=useState<ImageGrant[]>([]),[result,setResult]=useState("");async function sample(){const canvas=document.createElement("canvas");canvas.width=2400;canvas.height=1600;const context=canvas.getContext("2d")!;context.fillStyle="#fff";context.fillRect(0,0,2400,1600);context.fillStyle="#204060";context.font="48px sans-serif";for(let y=80;y<1600;y+=80)context.fillText("图片输入测试 · 内容仅用于界面核验 123456",80,y);const blob=await new Promise<Blob>(r=>canvas.toBlob(b=>r(b!)));const prepared=await prepareImage(new File([blob],"测试截图.png",{type:"image/png"}));image={title:"测试截图.png",url:`data:${prepared.mime};base64,${prepared.base64}`};setImages([{libraryId:"preview",documentId:"demo",sourceItemId:"demo",inputVersion:"1",blobHash:"demo"}]);setResult(`图片准备完成：${Math.round(prepared.base64.length*.75/1024)} KiB，尚未发送`);}return <main className="agent-body" style={{width:360,maxWidth:"100%",margin:"24px auto"}}><h3>添加图片或文件</h3><p>图片也可拖入或粘贴，随问题发送。</p><button onClick={()=>void sample()}>生成测试截图</button><p role="status">{result}</p><div className="agent-composer"><AgentImageCards images={images} disabled={false} pending onRemove={()=>setImages([])}/><textarea aria-label="问题" placeholder="询问 Hub 助手…"/></div></main>}
createRoot(document.getElementById("root")!).render(<App/>);
