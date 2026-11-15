export type Provider = "craft" | "obsidian" | "dida365" | "feishu" | "files";
export type SearchProvider = Provider | "hub";

export function providerName(provider: SearchProvider): string {
  if (provider === "hub") return "Hub";
  if (provider === "obsidian") return "Obsidian";
  if (provider === "dida365") return "滴答清单";
  if (provider === "feishu") return "飞书";
  if (provider === "files") return "本地文件";
  return "Craft";
}

export function providerUnavailableLabel(provider: Provider): string {
  return provider === "obsidian" || provider === "files" ? "路径不可用" : "连接未恢复";
}

export function providerUnavailableHint(provider: Provider): string {
  return provider === "obsidian" || provider === "files"
    ? "路径不可用；请在设置 → 资料库中检查文件夹位置"
    : "连接未恢复；本地内容仍可查看。请检查网络，并在设置 → 资料库中检查连接，必要时重新授权";
}
