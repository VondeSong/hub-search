"use client";

import { useState } from "react";
import { Check, CheckCircle2, ChevronDown, ChevronRight, Link2, Sparkles, X } from "lucide-react";

export type HarvesterPreviewClue = {
  id: string;
  title: string;
  sourceLabel: string;
  quote: string;
  targetTaskTitle: string;
  targetList: string;
  existingNote: string;
  appendBlock: string;
  resolvesWait?: string;
  nextStep?: string;
};

type SplitReceiptState = {
  clueTitle: string;
  targetTaskTitle: string;
  localStatus: "ok" | "unchanged";
  localText: string;
  remoteStatus: "ok" | "cancelled";
  remoteText: string;
};

const DEFAULT_CLUES: HarvesterPreviewClue[] = [
  {
    id: "preview-clue-quote",
    title: "整理供应商报价并补充到「客户联调报价核对」",
    sourceLabel: "工作日志 · 11-27 16:20",
    quote: "供应商已回传最新端子报价表（含 500 套阶梯价），需核对并更新评审结论。",
    targetTaskTitle: "核对线束端子最新阶梯报价",
    targetList: "项目开发",
    existingNote: "等待供应商本周四前回传 500 套阶梯报价。",
    appendBlock:
      "Hub 建议\n工作日志 · 11-27 16:20\n供应商已回传最新端子报价表（含 500 套阶梯价），需核对并更新评审结论。\n（已收到「供应商端子报价」，下一步：对比历史单价并提交评审）",
    resolvesWait: "供应商端子报价",
    nextStep: "对比历史单价并提交评审",
  },
  {
    id: "preview-clue-cad",
    title: "把台架 40Hz 振动偏移记录补充到「接线图纸复核」",
    sourceLabel: "Craft · 实机台架202611.md",
    quote: "首轮台架振动试验在 40Hz 出现微幅偏移，需在装配图纸补充固定卡扣备注。",
    targetTaskTitle: "完成控制柜接线图纸终版复核",
    targetList: "Hub 工作台",
    existingNote: "纸面端子编码 T-01 至 T-48 已核对。",
    appendBlock:
      "Hub 建议\nCraft · 实机台架202611.md\n首轮台架振动试验在 40Hz 出现微幅偏移，需在装配图纸补充固定卡扣备注。",
  },
];

/**
 * 独立可运行的行动捕手「远端追加预览 + 取消 + 分开回执」原型组件。
 * 零依赖 AssistantMemory / TaskHarvesterDemo，可直接挂载到干净的 v158 / GitHub HEAD 任务工作台基线。
 */
export default function TaskHarvesterWritePreview({
  clues = DEFAULT_CLUES,
  defaultOpen = false,
  onNotice,
}: {
  clues?: HarvesterPreviewClue[];
  defaultOpen?: boolean;
  onNotice?: (message: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [previewClueId, setPreviewClueId] = useState<string | null>(null);
  const [handledIds, setHandledIds] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<SplitReceiptState | null>(null);

  const pendingClues = clues.filter((c) => !handledIds.includes(c.id));

  function confirmRemoteAppend(clue: HarvesterPreviewClue) {
    setHandledIds((prev) => (prev.includes(clue.id) ? prev : [...prev, clue.id]));
    setPreviewClueId(null);
    const nextReceipt: SplitReceiptState = {
      clueTitle: clue.title,
      targetTaskTitle: clue.targetTaskTitle,
      localStatus: "ok",
      localText: clue.resolvesWait
        ? `已将等待项「${clue.resolvesWait}」标为已收到${clue.nextStep ? `，并加入本地下一步「${clue.nextStep}」` : ""}，来源备料已关联`
        : `已关联至「${clue.targetTaskTitle}」并保存来源备料`,
      remoteStatus: "ok",
      remoteText: `已模拟回读确认写入滴答「${clue.targetList} · ${clue.targetTaskTitle}」（保留原备注，仅在末尾追加）`,
    };
    setReceipt(nextReceipt);
    onNotice?.(`已确认追加到「${clue.targetTaskTitle}」（本地与远端回执已分开记录）`);
  }

  function keepLocalOnly(clue: HarvesterPreviewClue) {
    setHandledIds((prev) => (prev.includes(clue.id) ? prev : [...prev, clue.id]));
    setPreviewClueId(null);
    const nextReceipt: SplitReceiptState = {
      clueTitle: clue.title,
      targetTaskTitle: clue.targetTaskTitle,
      localStatus: "ok",
      localText: clue.resolvesWait
        ? `已更新本地等待项「${clue.resolvesWait}」与来源备料`
        : `已关联至「${clue.targetTaskTitle}」并保存来源备料`,
      remoteStatus: "cancelled",
      remoteText: "已取消滴答远端追加，原滴答任务备注未改动",
    };
    setReceipt(nextReceipt);
    onNotice?.(`已仅保留本地关联，未修改滴答远端任务「${clue.targetTaskTitle}」`);
  }

  function cancelPreview(clue: HarvesterPreviewClue) {
    setPreviewClueId(null);
    setReceipt({
      clueTitle: clue.title,
      targetTaskTitle: clue.targetTaskTitle,
      localStatus: "unchanged",
      localText: "已取消本次关联，本地备料与等待状态未改动",
      remoteStatus: "cancelled",
      remoteText: "已取消滴答远端追加预览，远端任务未改动",
    });
    onNotice?.("已取消远端追加预览，本地与滴答均未改动");
  }

  return (
    <section className="tw-harvester-preview-shell" aria-label="行动捕手远端追加预览">
      <button
        type="button"
        className="tw-harvester-preview-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tw-harvester-preview-title">
          <Sparkles size={14} aria-hidden="true" />
          <strong>行动捕手 · 远端追加确认</strong>
          <small>
            {pendingClues.length > 0 ? `${pendingClues.length} 条可关联线索` : "当前示例线索已处理"} · 追加前必预览
          </small>
        </span>
        <span className="tw-harvester-preview-chevron">
          {open ? (
            <>
              收起 <ChevronDown size={13} aria-hidden="true" />
            </>
          ) : (
            <>
              展开预览 <ChevronRight size={13} aria-hidden="true" />
            </>
          )}
        </span>
      </button>

      {receipt && (
        <div className="tw-harvester-split-receipt" role="status" aria-label="行动捕手分开回执">
          <div className="tw-harvester-split-head">
            <strong>
              处理回执（本地 / 滴答远端已分开） · {receipt.targetTaskTitle}
            </strong>
            <button type="button" aria-label="关闭分开回执" onClick={() => setReceipt(null)}>
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          <div className={`tw-harvester-receipt-row is-${receipt.localStatus}`}>
            <span>本地回执</span>
            <p>{receipt.localText}</p>
          </div>
          <div className={`tw-harvester-receipt-row is-${receipt.remoteStatus}`}>
            <span>滴答远端回执</span>
            <p>{receipt.remoteText}</p>
          </div>
        </div>
      )}

      {open && (
        <div className="tw-harvester-preview-body">
          {pendingClues.length === 0 ? (
            <div className="tw-harvester-preview-empty">
              <span>示例线索均已核对完成。</span>
              <button
                type="button"
                onClick={() => {
                  setHandledIds([]);
                  setPreviewClueId(null);
                  setReceipt(null);
                }}
              >
                重置示例线索
              </button>
            </div>
          ) : (
            pendingClues.map((clue) => {
              const previewing = previewClueId === clue.id;
              const afterText = `${clue.existingNote}\n\n---\n${clue.appendBlock}`;
              return (
                <article key={clue.id} className="tw-harvester-preview-card">
                  <div className="tw-harvester-preview-card-head">
                    <strong>{clue.title}</strong>
                    <span>{clue.sourceLabel}</span>
                  </div>
                  <blockquote className="tw-harvester-preview-quote">{clue.quote}</blockquote>
                  <div className="tw-harvester-preview-meta">
                    <span>
                      匹配任务：<b>{clue.targetTaskTitle}</b>（{clue.targetList}）
                    </span>
                    {clue.resolvesWait && (
                      <span className="tw-harvester-preview-tag">
                        <CheckCircle2 size={11} aria-hidden="true" /> 可解除等待：{clue.resolvesWait}
                      </span>
                    )}
                  </div>

                  {!previewing ? (
                    <div className="tw-harvester-preview-actions">
                      <button
                        type="button"
                        className="tw-primary-btn"
                        onClick={() => setPreviewClueId(clue.id)}
                      >
                        <Link2 size={13} aria-hidden="true" />
                        {clue.resolvesWait ? "预览解除等待并追加到滴答" : "预览并关联补充至已有任务"}
                      </button>
                    </div>
                  ) : (
                    <div className="tw-harvester-append-preview" role="region" aria-label="滴答远端追加预览">
                      <div className="tw-harvester-append-head">
                        <strong>向滴答远端追加前预览（确认前不会改动远端任务）</strong>
                        <small>
                          目标：滴答清单 · {clue.targetList} · {clue.targetTaskTitle}
                        </small>
                      </div>
                      <div className="tw-harvester-append-diff">
                        <div>
                          <span>追加前（原滴答备注）</span>
                          <pre>{clue.existingNote}</pre>
                        </div>
                        <div>
                          <span>追加后预览</span>
                          <pre>{afterText}</pre>
                        </div>
                      </div>
                      <div className="tw-harvester-append-actions">
                        <button
                          type="button"
                          className="tw-primary-btn"
                          onClick={() => confirmRemoteAppend(clue)}
                        >
                          <Check size={13} aria-hidden="true" /> 确认追加到滴答
                        </button>
                        <button type="button" onClick={() => keepLocalOnly(clue)}>
                          仅保留本地关联
                        </button>
                        <button type="button" onClick={() => cancelPreview(clue)}>
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
