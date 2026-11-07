export type ExternalOpenGate = {
  pending: boolean;
  cooldownUntil: number;
};

export type ExternalLinkTarget = {
  application: "浏览器" | "Obsidian" | "Craft";
  label: string;
};

const SUPPORTED_PROTOCOLS = new Set(["http:", "https:", "obsidian:", "craftdocs:"]);

export function isCraftHttpsUrl(href: string): boolean {
  try {
    const url = new URL(href.trim());
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && (hostname === "craft.do" || hostname.endsWith(".craft.do"));
  } catch {
    return false;
  }
}

export function externalLinkTarget(href: string): ExternalLinkTarget | null {
  try {
    const url = new URL(href.trim());
    if (!SUPPORTED_PROTOCOLS.has(url.protocol)) return null;
    if (url.protocol === "obsidian:") return { application: "Obsidian", label: "Obsidian 链接" };
    if (url.protocol === "craftdocs:") return { application: "Craft", label: "Craft 链接" };
    if (isCraftHttpsUrl(url.toString())) return { application: "Craft", label: "Craft 网页链接" };
    return { application: "浏览器", label: url.hostname || "网页链接" };
  } catch {
    return null;
  }
}

export function beginExternalOpen(gate: ExternalOpenGate, now: number, cooldownMs = 1_200): boolean {
  if (gate.pending || now < gate.cooldownUntil) return false;
  gate.pending = true;
  gate.cooldownUntil = now + cooldownMs;
  return true;
}

export function finishExternalOpen(gate: ExternalOpenGate, now: number, trailingCooldownMs = 500): void {
  gate.pending = false;
  gate.cooldownUntil = Math.max(gate.cooldownUntil, now + trailingCooldownMs);
}

export function externalOpenSuccessMessage(target: ExternalLinkTarget, elapsedMs: number): string {
  const base = `已交给${target.application}打开 · ${target.label}`;
  if (elapsedMs < 800) return base;
  const duration = elapsedMs < 1_000
    ? `${Math.round(elapsedMs)} 毫秒`
    : `${(elapsedMs / 1_000).toFixed(1)} 秒`;
  return `${base} · Hub 响应 ${duration}`;
}
