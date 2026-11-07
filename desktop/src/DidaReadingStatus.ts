export type DidaRetentionKind = "quota-exhausted" | "source-changed" | "cleanup-disabled" | "attachment-list-unavailable" | "attachment-incomplete" | "authentication" | "cloud-verification" | "other";
export type DidaRetentionReason = { message: string; count: number; kind?: DidaRetentionKind };

// Older saved records have only a message. Keep their diagnostic text, but give
// the reading screen the same explanation as newly classified records.
export function didaRetentionKind(reason: DidaRetentionReason): DidaRetentionKind {
  if (/额度不足/.test(reason.message)) return "quota-exhausted";
  if (/版本不一致|来源版本不同/.test(reason.message)) return "source-changed";
  if (reason.kind && reason.kind !== "other") return reason.kind;
  if (/来源清理未开启|清理.*关闭|删除.*未开启/.test(reason.message)) return "cleanup-disabled";
  if (/附件清单未知|附件库存未知|没有返回.*附件列表|附件列表.*(异常|未知|未返回|尚未.*读取)|附件清单.*(未知|未返回)/.test(reason.message)) return "attachment-list-unavailable";
  if (/网页登录|\b40[13]\b/.test(reason.message)) return "authentication";
  if (/云端|云同步|恢复检查|恢复核验/.test(reason.message)) return "cloud-verification";
  if (/附件|原件/.test(reason.message) && /下载|未保存|未完整|不一致|缺失|未上传|失败/.test(reason.message)) return "attachment-incomplete";
  return "other";
}

export function didaRetentionExplanation(reason: DidaRetentionReason, currentMode?: "local" | "cloud-preserve" | "cloud-verified"): string {
  switch (didaRetentionKind(reason)) {
    case "quota-exhausted": return "云端传输额度不足，检查尚未完成。请在设置 → 云同步 → 阅读附件查看用量。";
    case "source-changed": return "滴答返回的两个版本内容不一致。请在“处理保留的原内容”中重新检查，或保留两边并结束此项处理。";
    case "cleanup-disabled": return currentMode === "cloud-verified"
      ? "上次同步时未开启删除；当前已开启，下次同步会继续检查。"
      : currentMode === "local"
      ? "上次同步因设置保留原内容；下次同步按当前设置重新检查。"
      : "删除开关未开启，滴答里的原内容会继续保留。";
    case "attachment-list-unavailable": return /格式异常/.test(reason.message)
      ? "滴答返回的附件列表无法识别，暂时保留原内容。这不代表附件已丢失。"
      : "滴答没有返回附件列表，暂时无法确认有无附件，所以保留原内容。这不代表附件已丢失。";
    case "attachment-incomplete": return "附件还没全部保存并检查通过，暂时保留滴答里的原内容。";
    case "authentication": return "需要检查滴答网页登录，确认账号后再同步。原内容仍在滴答里。";
    case "cloud-verification": return "云端副本还没完整确认，暂时保留滴答里的原内容。";
    default: return "保存结果还需要确认，暂时保留滴答里的原内容。可展开技术记录查看原因。";
  }
}
