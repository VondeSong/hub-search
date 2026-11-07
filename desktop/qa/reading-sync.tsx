import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import "../src/App.css";
import "../src/WorkspaceRefresh.css";
import "../src/InterfaceSelection.css";
import "../src/LiquidWorkspace.css";
import "../src/DisplayPreferences.css";
import "../src/MobileExperience.css";
import "../src/MobileDesign.css";
import "../src/MobileGlass.css";
import "../src/MobileNavigationDesign.css";
import { CollectionsWorkspace } from "../src/CollectionsWorkspace";
import { CollectionViewsProvider } from "../src/CollectionViews";

// Isolated visual QA. All IPC is mocked; no accounts or external requests are used.
const now=1791505800;
const plans=Array.from({length:11},(_,i)=>({provider:i%2?"craft":"dida365",status:"planned",libraryName:i%2?"Car":"滴答参考资料",destinationPath:i%2?"Car / 日记 / 2026-10-09 / 原始资料":"参考资料",title:`示例文章 ${i+1} · 复杂内容与附件的保存核验`,markdown:"仅用于界面检查的正文",summary:"保留原文和附件供后续查阅",reason:"用户保存请求",tasks:[],attachments:[],warnings:[]}));
const phases=["cancelled","partial","partial","partial","partial","partial","cleanup","queued","partial","partial","cancelled"];
const errors=["方案已取消；已写入的内容和附件保留，后续不再自动补齐。","Craft 正文读回未通过，保留原保存位置","Craft 正文读回未通过，保留原保存位置","已创建页面中的正文不完整或有修改，请核对后再继续；未重复追加","滴答正文已保存，但附件尚未登记到该笔记或任务；保留已有标识，请继续补齐","目标附件尚未完整保存，保留原页面和附件，请补写后重试","目标附件尚未完整保存，保留原页面和附件，请补写后重试","Craft POST /blocks 失败（HTTP 400 Bad Request）","滴答附件读回失败（HTTP 500 Internal Server Error）","附件登录账号与当前网页目标不一致，请登录正确账号后重试","方案已取消；已写入的内容和附件保留，后续不再自动补齐。"];
const operations=phases.map((phase,i)=>({key:`fixture:${i+1}`,itemTitle:plans[i].title,target:i%2?"craft":"dida",targetName:plans[i].libraryName,updatedAt:now-i*120,action:"move",phase,error:errors[i],parked:[1,2,3,4].includes(i),plan:plans[i]}));
const items=plans.map((plan,i)=>({key:`fixture:${i+1}`,collectedAt:(now-i*3600)*1000,read:false,status:"unread",tags:["界面样例"],post:{id:String(i),source:"bookmarks",text:plan.title,authorName:"样例作者",authorHandle:"fixture",url:`https://fixture.invalid/article/${i}`,publishedAt:"2026-10-09",links:[],media:[],quotedText:"",contentStatus:"complete"}}));
const longStatus="本轮读取结束：接收 19 条 · 新增 0 条 · 不可用 0 条 · 页面保存结束 · 本轮处理 773/773 条 · 尚未处理 0 条 · 保存 2 条 · 无变化 770 页 · 保留手动修改/同名页面 0 页 · 本轮附件待重试 2 个 · 写入失败 0 页；媒体 HTTP 403，可点击补写 / 重试";
const sources=[
  {id:"bookmarks",count:710,connected:true,canResume:true,status:"正在读取第 1 页 · 已接收 0 条 · 新增 0 条",lastSuccess:now-12*3600,nextSyncAt:now+1800},
  {id:"likes",count:19,connected:true,canResume:false,status:longStatus,lastSuccess:now-11*3600,nextSyncAt:now+1800},
  {id:"telegram",count:2,connected:true,paired:true,canResume:false,status:"Telegram 收件结束：新增 0 条 · 更新 0 条 · 忽略 0 条",lastSuccess:now-300,nextSyncAt:now+1500},
  {id:"dida",count:40,connected:true,canResume:false,status:"滴答稍后读：0 项迁移核验完成；32 项来源保留。滴答网页登录未通过（401），请重新登录；原项已保留",lastCheckedAt:now-240,didaCleanup:{mode:"cloud-preserve",pending:32,verified:0,deleted:8,authRequired:true,reasons:[{message:"滴答网页登录未通过（401），请重新登录；原项已保留",count:32}],lastRun:{attempted:1,completed:0,deferred:32,blocked:0,authenticationRequired:true}}},
];
const active=new URLSearchParams(location.search).get("running")!=="0";
const storage={config:{mode:"obsidian",vaultPath:"D:/fixture-vault",downloadMedia:true,autoSyncMinutes:30},running:active,telegramRunning:false,didaRunning:false,status:longStatus,job:{id:100,running:active,phase:"fetching",source:"bookmarks",processed:0,total:0,downloadedBytes:0,fileBytes:0,message:"正在读取第 1 页 · 已接收 0 条 · 新增 0 条",outcome:active?"":"completed"}};
const fixture={calls:[] as {command:string;args:unknown}[],unknown:[] as string[],operations,sources,
  loginChecks:0,loginOpens:0,loginCheckDelayMs:0,loginFailure:"",
  loginStatus:{connected:false,accountMatched:false,checkedAt:now,loginWindowOpen:false,state:"authentication",message:"滴答网页登录未通过（401）；原项已保留"},
  async invoke(command:string,args:Record<string,unknown>={}){
  fixture.calls.push({command,args});
  if(command==="list_collection_items")return{items,total:771,unread:770,matched:items.length,connected:true,running:active,canResume:true,status:"",sources};
  if(command==="get_collection_storage")return storage;
  if(command==="list_libraries")return[{id:"craft",provider:"craft",name:"Car",connected:true,documentCount:11},{id:"dida",provider:"dida365",name:"滴答参考资料",connected:true,documentCount:40}];
  if(command==="collection_library_operations")return operations;
  if(command==="cancel_x_bookmark_sync"){storage.running=false;storage.job.running=false;storage.job.outcome="paused";return "已暂停";}
  if(command==="move_collection_to_library")return "已恢复待处理副本，保留原内容和附件";
  if(command==="retry_collection_library_operation")return;
  if(command==="open_dida_attachment_login"){fixture.loginOpens+=1;fixture.loginStatus.loginWindowOpen=true;return "隔离检查：已请求打开滴答登录";}
  if(command==="get_dida_reading_login_status"){
    fixture.loginChecks+=1;
    if(fixture.loginCheckDelayMs)await new Promise(resolve=>setTimeout(resolve,fixture.loginCheckDelayMs));
    if(fixture.loginFailure)throw new Error(fixture.loginFailure);
    return {...fixture.loginStatus};
  }
  if(command==="sync_x_bookmarks")return "隔离检查：已请求同步";
  if(command==="save_collection_storage")return "隔离检查：设置已保存";
  if(command==="open_external_url")return;
  fixture.unknown.push(command);throw new Error(`未实现样例 IPC：${command}`);
}};
Object.assign(window,{__READING_SYNC_FIXTURE__:fixture,__TAURI_INTERNALS__:{invoke:fixture.invoke,convertFileSrc:(path:string)=>path,transformCallback:()=>0,unregisterCallback:()=>{}}});
function Fixture(){useEffect(()=>{const timer=setTimeout(()=>document.querySelector<HTMLButtonElement>('[aria-label="同步与连接"]')?.click(),400);return()=>clearTimeout(timer);},[]);return <CollectionViewsProvider><CollectionsWorkspace/></CollectionViewsProvider>;}
document.body.style.margin="0";
document.getElementById("root")!.style.height="100dvh";
createRoot(document.getElementById("root")!).render(<Fixture/>);
