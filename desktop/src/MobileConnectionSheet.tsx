import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useModalFocus } from "./useModalFocus";
import { todayKey } from "./ActionEvidence";
import type { QuickJournalItem } from "./JournalRecords";
import { QUICK_JOURNAL_UPDATED } from "./QuickJournalEvents";
import type { MobileLinkStatus } from "./MobileHeader";

export type QuickJournalReceiptSummary = {
  today: number;
  localOnly: number;
  uploadedOnly: number;
  applied: number;
};

export type MobileConnectionSnapshot = {
  status: MobileLinkStatus;
  ossText: string;
  vpsText: string;
  receiptsText: string;
  journalSummary: QuickJournalReceiptSummary | null;
};

let latestSnapshot: MobileConnectionSnapshot = {
  status: { oss: false, vps: false, pendingUpload: 0 },
  ossText: "读取中",
  vpsText: "核对中",
  receiptsText: "",
  journalSummary: null,
};
let activeProbeEpoch = 0;
let inFlightProbe: Promise<MobileConnectionSnapshot> | null = null;
const listeners = new Set<(snapshot: MobileConnectionSnapshot) => void>();

function publishSnapshot(patch: Partial<MobileConnectionSnapshot> & { statusPatch?: Partial<MobileLinkStatus> }) {
  const { statusPatch, ...rest } = patch;
  latestSnapshot = {
    ...latestSnapshot,
    ...rest,
    status: { ...latestSnapshot.status, ...(statusPatch ?? {}) },
  };
  for (const listener of listeners) listener(latestSnapshot);
}

export function getLatestMobileConnectionSnapshot(): MobileConnectionSnapshot {
  return latestSnapshot;
}

export function subscribeMobileConnectionSnapshot(listener: (snapshot: MobileConnectionSnapshot) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function probeMobileConnections(force = false): Promise<MobileConnectionSnapshot> {
  if (inFlightProbe && !force) return inFlightProbe;
  const ticket = ++activeProbeEpoch;
  const contentProbe = (async () => {
    const config = await invoke<{ cloudEnabled?: boolean; settings?: { sync?: boolean } }>("get_quick_journal_settings");
    if (activeProbeEpoch !== ticket) return;
    const syncActive = Boolean(config.cloudEnabled && config.settings?.sync !== false);
    const ossText = !config.cloudEnabled ? "未启用 OSS" : syncActive ? "已配置 OSS" : "已暂停同步";
    publishSnapshot({ ossText, statusPatch: { oss: syncActive } });
    const result = await invoke<{ items: QuickJournalItem[]; error?: string }>("list_quick_journal");
    if (activeProbeEpoch !== ticket) return;
    if (result.error) {
      publishSnapshot({ receiptsText: "暂时无法核对速记回执", journalSummary: null });
      return;
    }
    const rows = result.items.filter(item => !item.deleted);
    const today = rows.filter(item => item.record.date === todayKey()).length;
    const applied = rows.filter(item => item.applied).length;
    const uploadedOnly = rows.filter(item => item.uploaded && !item.applied).length;
    const localOnly = rows.length - applied - uploadedOnly;
    const receiptsText = rows.length
      ? `本机 ${localOnly} 条 · 已上传 ${uploadedOnly} 条 · 桌面已写入 ${applied} 条`
      : "暂无速记回执";
    publishSnapshot({
      receiptsText,
      journalSummary: { today, localOnly, uploadedOnly, applied },
      statusPatch: { pendingUpload: localOnly },
    });
  })().catch(() => {
    if (activeProbeEpoch === ticket) {
      publishSnapshot({ ossText: "状态未知", statusPatch: { oss: false } });
    }
  });

  const agentProbe = (async () => {
    const config = await invoke<{ binding?: string } | null>("cloud_agents", { action: { op: "config" } });
    if (activeProbeEpoch !== ticket) return;
    if (!config?.binding) {
      publishSnapshot({ vpsText: "未配置", statusPatch: { vps: false, vpsLabel: "未配置" } });
      return;
    }
    const result = await invoke<{ cached?: boolean; error?: string; accessDenied?: boolean }>("cloud_agents", { action: { op: "list", query: "" } });
    if (activeProbeEpoch !== ticket) return;
    const ok = !result.cached && !result.error && !result.accessDenied;
    const vpsText = result.accessDenied ? "访问受限" : result.cached ? "离线缓存" : ok ? "在线" : "连接异常";
    publishSnapshot({ vpsText, statusPatch: { vps: ok, vpsLabel: vpsText } });
  })().catch(() => {
    if (activeProbeEpoch === ticket) {
      publishSnapshot({ vpsText: "连接不可用", statusPatch: { vps: false, vpsLabel: "连接不可用" } });
    }
  });

  const combined = Promise.all([contentProbe, agentProbe]).then(() => latestSnapshot).finally(() => {
    if (inFlightProbe === combined) inFlightProbe = null;
  });
  inFlightProbe = combined;
  return combined;
}

export function useMobileConnectionStatus(enabled: boolean, onStatus: (value: MobileLinkStatus) => void) {
  const latest = useRef(onStatus);
  latest.current = onStatus;
  useEffect(() => {
    if (!enabled) return;
    const unsub = subscribeMobileConnectionSnapshot(snapshot => latest.current(snapshot.status));
    const refresh = () => { void probeMobileConnections(true); };
    void probeMobileConnections(false);
    window.addEventListener(QUICK_JOURNAL_UPDATED, refresh);
    return () => {
      unsub();
      window.removeEventListener(QUICK_JOURNAL_UPDATED, refresh);
    };
  }, [enabled]);
}

type Props = { onClose: () => void; onAgents: () => void; onContent: () => void; onStatus: (value: MobileLinkStatus) => void };

export function MobileConnectionSheet({onClose,onAgents,onContent,onStatus}: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [snap, setSnap] = useState<MobileConnectionSnapshot>(getLatestMobileConnectionSnapshot);
  useModalFocus({active:true,containerRef:panel,onDismiss:onClose});
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    const unsub = subscribeMobileConnectionSnapshot(next => {
      setSnap(next);
      onStatus(next.status);
    });
    void probeMobileConnections(true);
    return () => { unsub(); element?.close(); };
  },[onStatus]);
  return createPortal(<dialog ref={dialog} className="mobile-space-layer" aria-label="连接总览" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <section ref={panel} tabIndex={-1} className="mobile-space-menu bw-connections-sheet">
      <header><div><h2>连接总览 · 双链路独立状态</h2><small>内容同步（OSS）与云端助手（VPS）互不阻塞</small></div><button onClick={onClose}>完成</button></header>
      <div className="bw-connection-cards">
        <button onClick={onContent}>
          <strong>1. 内容同步（阿里云 OSS ↔ 桌面 OS）</strong>
          <b className={`bw-receipt-pill ${snap.ossText === "已配置 OSS" ? "is-os" : "is-local"}`}>{snap.ossText}</b>
          <small>{snap.receiptsText || "查看同步设置与上传队列；桌面关机时速记仍安全保存在本机与 OSS。"}</small>
        </button>
        <button onClick={onAgents}>
          <strong>2. 云端助手（个人 Linux VPS · Codex）</strong>
          <b className={`bw-receipt-pill ${snap.vpsText === "在线" ? "is-cloud" : "is-local"}`}>{snap.vpsText}</b>
          <small>手机直连个人 VPS 执行端，Windows 电脑关机不影响发起新会话 · 点击打开助手</small>
        </button>
      </div>
    </section></dialog>,document.body);
}
