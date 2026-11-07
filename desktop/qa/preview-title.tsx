import React from "react";
import { createRoot } from "react-dom/client";
import "../src/App.css";
import "../src/CollectionsWorkspace.css";
import "../src/WorkspaceRefresh.css";
import "../src/InterfaceSelection.css";
import "../src/LiquidWorkspace.css";
import "../src/DisplayPreferences.css";
import "../src/MobileExperience.css";
import "../src/MobileDesign.css";
import { PreviewFrame, PreviewHeading, PreviewTitle, PreviewToolbar } from "../src/PreviewFrame";

const params = new URLSearchParams(location.search);
const kind = params.get("kind") || "reading";
if (params.has("mobile")) document.documentElement.dataset.runtimePlatform = "android";
const full = params.has("long") ? "完整标题：" + "中文、English、表情 📝 与标点。".repeat(18) + "最后一段也要复制。" : "互联网时代是叔本华，AI 时代是尼采。";
const workspace = kind === "reading" ? "collections-workspace" : kind === "tasks" ? "task-workspace" : "desktop-workspace";
document.body.style.margin = "0";
document.documentElement.style.setProperty("--preview-title-font-size", "16px");
document.documentElement.style.setProperty("--preview-title-weight", "520");
document.body.style.fontFamily = '"Segoe UI", "Microsoft YaHei", sans-serif';
createRoot(document.getElementById("root")!).render(<div className="app-shell desktop-app-shell" style={{display:"block",width:"100%",height:"100vh",padding:12,boxSizing:"border-box"}}>
  <section className={workspace} style={{display:"block",width:"100%",maxWidth:780,margin:"auto"}}>
    <PreviewFrame className={kind === "reading" ? "collection-detail" : ""}>
      <PreviewHeading source={<><span className="provider-badge telegram">Telegram</span><span className="preview-path">AI探索指南 / @aigc1024</span></>}
        actions={<PreviewToolbar onCopy={()=>{}} onOpen={()=>{}} openTitle="打开原文"/>}>
        <PreviewTitle text={full}>{full.slice(0,160)}</PreviewTitle>
      </PreviewHeading>
      <div className="preview-content" style={{minHeight:240}}><p>阅读正文</p></div>
    </PreviewFrame>
  </section>
</div>);
Object.assign(window,{__TITLE_FIXTURE__:{full}});
