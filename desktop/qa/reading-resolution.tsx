import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/App.css";
import "../src/CollectionsWorkspace.css";
import "../src/WorkspaceRefresh.css";
import "../src/InterfaceSelection.css";
import "../src/LiquidWorkspace.css";
import "../src/DisplayPreferences.css";
import "../src/MobileExperience.css";
import "../src/MobileDesign.css";
import "../src/MobileGlass.css";
import "../src/MobileNavigationDesign.css";
import "../src/CloudSyncSettingsSection.css";
import "../src/ReadingAttachments.css";
import { CollectionSyncPanel, type CollectionSyncSource } from "../src/CollectionSyncPanel";
import { ReadingMediaSettings } from "../src/ReadingMediaSettings";
const fixture={calls:[] as {command:string;args:unknown}[],events:[] as string[],async invoke(command:string,args:unknown={}){fixture.calls.push({command,args});if(command==="get_reading_media_policy")return {policy:{enabled:true,download:"onDemand",imageMb:1,documentMb:1,batchMb:64,dailyMb:100,cacheMb:512},day:"2026-10-09",reservedBytes:104857600,uploadedBytes:1048576,downloadedBytes:2097152,attachmentDownloadedBytes:1048576,metadataDownloadedBytes:1048576,legacyReservedBytes:101711872,pendingBytes:0};if(command==="get_reading_cache_status")return {bytes:1048576,pinnedBytes:0,removableBytes:1048576,removableCount:1,otherCount:0,pins:[],token:"fixture"};throw new Error("Unexpected mocked IPC: "+command);}};
Object.assign(window,{__ATTACHMENT_FIXTURE__:fixture,__TAURI_INTERNALS__:{invoke:fixture.invoke,convertFileSrc:(path:string)=>path,transformCallback:()=>0,unregisterCallback:()=>{}}});
let preserved=false,released=false;
const originalInvoke=fixture.invoke;
fixture.invoke=async(command:string,args:any={})=>{
 if(command==='list_dida_reading_resolutions')return [{key:'dida:fixture',title:'示例：两个接口返回不同版本的阅读资料',snapshot:'fixture-v1',error:preserved?'用户选择保留两边内容，已结束自动清理':'正文版本不一致',state:preserved?'preserved':'pending',updatedAt:123}] as any;
 if(command==='resolve_dida_reading'){preserved=args.preserve;return undefined as any;}
 if(command==='release_reading_legacy_reservation'){released=true;return undefined as any;}
 const result=await originalInvoke(command,args);
 if(command==='get_reading_media_policy'&&released)return {...result,legacyReservedBytes:0};
 return result;
};
Object.assign(window,{__TAURI_INTERNALS__:{invoke:fixture.invoke}});
const source:CollectionSyncSource={id:"dida",count:40,connected:true,canResume:false,status:"滴答稍后读：0 项迁移核验完成；32 项来源保留，等待重试",lastCheckedAt:1791524400,didaCleanup:{mode:"cloud-verified",cloudReading:true,cleanupEnabled:true,pending:32,verified:28,deleted:8,authRequired:false,reasons:[{message:"来源云端恢复检查未完整通过：正文：今日附件额度不足",kind:"cloud-verification",count:28},{message:"滴答任务与附件会话的正文版本不一致，来源保留",kind:"attachment-incomplete",count:3},{message:"滴答没有返回附件列表",kind:"attachment-list-unavailable",count:1}],lastRun:{attempted:32,completed:0,deferred:32,blocked:0,authenticationRequired:false}}};
const noop=()=>{};
function Fixture(){return location.search.includes("usage")?<div className="settings-category cloud cloud-sync-center" style={{maxWidth:760,margin:"16px auto",padding:16,boxSizing:"border-box",width:"100%"}}><ReadingMediaSettings blocked={false}/></div>:<div className="collections-workspace"><CollectionSyncPanel sources={[source]} operations={[]} itemTitles={{}} autoSyncMinutes={30} storageLabel="保存到本机" storageStatus="" pendingCancellations={0} jobRunning={false} jobVisible={false} sourceBusy={()=>false} sourceActive={()=>false} onClose={noop} onSettings={noop} onSync={noop} onPause={noop} onStore={noop} onConnect={noop} onOpenUrl={noop} onDidaLogin={noop} onReview={noop} onRetry={noop} onContinueCopy={noop}>{null}</CollectionSyncPanel></div>;}
document.body.style.margin="0";if(location.search.includes("usage")){for(const e of [document.documentElement,document.body,document.getElementById("root")!]){e.style.height="auto";e.style.overflow="auto";}}createRoot(document.getElementById("root")!).render(<Fixture/>);
