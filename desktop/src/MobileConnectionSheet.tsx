import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useModalFocus } from "./useModalFocus";
import type { QuickJournalItem } from "./JournalRecords";

type Props = { onClose: () => void; onAgents: () => void; onContent: () => void; onStatus: (value:{oss:boolean;vps:boolean}) => void };

export function MobileConnectionSheet({onClose,onAgents,onContent,onStatus}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [oss,setOss] = useState("读取中");
  const [vps,setVps] = useState("核对中");
  const [receipts,setReceipts] = useState("");
  useModalFocus({active:true,containerRef:panel,onDismiss:onClose});
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    let active = true;
    const status = {oss:false,vps:false};
    async function loadContent() {
      const config = await invoke<{cloudEnabled?:boolean;settings:{sync:boolean}}>("get_quick_journal_settings");
      if (!active) return;
      setOss(config.cloudEnabled ? "已配置 OSS" : "未启用 OSS");
      const result = await invoke<{items:QuickJournalItem[];error?:string}>("list_quick_journal");
      if (!active) return;
      if (result.error) {setReceipts("暂时无法核对速记回执");return;}
      const rows = result.items.filter(item => !item.deleted);
      const applied = rows.filter(item => item.applied).length;
      const uploaded = rows.filter(item => item.uploaded && !item.applied).length;
      setReceipts(rows.length ? '本机 '+(rows.length-applied-uploaded)+' 条 · 已上传 '+uploaded+' 条 · 桌面已写入 '+applied+' 条' : "暂无速记回执");
      status.oss = !!config.cloudEnabled && (uploaded + applied > 0);
      onStatus({...status});
    }
    async function loadAgents() {
      const config = await invoke<{binding?:string}|null>("cloud_agents",{action:{op:"config"}});
      if (!active) return;
      if (!config?.binding) {setVps("未配置");return;}
      const result = await invoke<{cached?:boolean;error?:string;accessDenied?:boolean}>("cloud_agents",{action:{op:"list",query:""}});
      if (!active) return;
      status.vps = !result.cached && !result.error && !result.accessDenied;
      setVps(result.accessDenied ? "访问受限" : result.cached ? "离线缓存" : status.vps ? "在线" : "连接异常");
      onStatus({...status});
    }
    onStatus({...status});
    void loadContent().catch(() => {if(active)setOss("状态未知");});
    void loadAgents().catch(() => {if(active)setVps("连接不可用");});
    return () => {active=false;element?.close();};
  },[onStatus]);
  return createPortal(<dialog ref={dialog} className="mobile-space-layer" aria-label="连接总览" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <section ref={panel} tabIndex={-1} className="mobile-space-menu bw-connections-sheet">
      <header><div><h2>连接总览 · 双链路独立状态</h2><small>内容同步（OSS）与云端助手（VPS）互不阻塞</small></div><button onClick={onClose}>完成</button></header>
      <div className="bw-connection-cards">
        <button onClick={onContent}><strong>内容同步（阿里云 OSS ↔ 桌面 OS）</strong><b>{oss}</b><small>{receipts || "查看同步设置与上传队列"}</small></button>
        <button onClick={onAgents}><strong>云端助手（个人 VPS）</strong><b>{vps}</b><small>打开助手会话</small></button>
      </div>
    </section></dialog>,document.body);
}
