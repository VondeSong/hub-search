import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mcpCapabilityDescription, mcpToolGroups, McpSettingsSection, TAG_GOVERNANCE_PROMPT, type HubMcpCapabilitySummary } from "./McpSettingsSection";

const CAPABILITIES: HubMcpCapabilitySummary = {
  schemaVersion: "hub.mcp-capabilities.v1",
  toolCount: 21,
  readOnlyToolCount: 14,
  writeToolCount: 7,
  destructiveToolCount: 2,
  groups: { content: 3, tagEvidence: 6, tagWorkflow: 9, flashcardMedia: 3, other: 0 },
};

describe("McpSettingsSection", () => {
  it("describes the complete review-first Codex workflow", () => {
    const html = renderToStaticMarkup(<McpSettingsSection />);

    expect(mcpCapabilityDescription(CAPABILITIES)).toContain("21 个 Hub 工具：14 个只读，7 个可能写入 Hub");
    expect(mcpCapabilityDescription(CAPABILITIES)).toContain("2 个只影响 Hub 内部关系");
    expect(mcpToolGroups(CAPABILITIES).map(({ title, count }) => `${title} · ${count}`)).toEqual([
      "内容检索 · 3",
      "标签证据与体系 · 6",
      "建议与修复 · 9",
      "闪卡与媒体 · 3",
    ]);
    expect(html).toContain("正在读取 Hub MCP 能力清单");
    expect(html).toContain("标签证据与体系");
    expect(html).toContain("建议与修复");
    expect(html).toContain("用户审核");
    expect(html).toContain("复制任务模板");
    expect(html).not.toContain("调用四个工具");
  });

  it("keeps the copied task evidence-first and non-executing", () => {
    expect(TAG_GOVERNANCE_PROMPT).toContain("hub_tag_compare");
    expect(TAG_GOVERNANCE_PROMPT).toContain("hub_tag_evidence");
    expect(TAG_GOVERNANCE_PROMPT).toContain("hub_tag_taxonomy");
    expect(TAG_GOVERNANCE_PROMPT).toContain("hub_submit_tag_governance_proposal");
    expect(TAG_GOVERNANCE_PROMPT).toContain("hub_preview_tag_governance_proposal");
    expect(TAG_GOVERNANCE_PROMPT).toContain("reviewBlocked");
    expect(TAG_GOVERNANCE_PROMPT).toContain('agent="codex"');
    expect(TAG_GOVERNANCE_PROMPT).toContain("不要调用 hub_resolve_tag_governance_proposal");
    expect(TAG_GOVERNANCE_PROMPT).toContain("不要修改或声称已经修改 Craft");
  });
});
