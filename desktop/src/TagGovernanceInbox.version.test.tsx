// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TagGovernanceInbox } from "./TagGovernanceInbox";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

let container: HTMLDivElement;
let root: Root;
let revision: string;
let proposalStatus: "pending" | "accepted";
const proposal = () => ({
  proposalId: "p1", indexRevision: "index", status: proposalStatus,
  summary: "测试建议", proposal: { recommendations: [] }, createdAt: 1, updatedAt: 1,
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  revision = "taxonomy-1";
  proposalStatus = "pending";
  invoke.mockImplementation(async (command, args) => {
    if (command === "list_tag_governance_proposals") return { proposals: args.status === proposalStatus ? [proposal()] : [] };
    if (command === "get_tag_taxonomy_health") return {
      status: "healthy", summary: { relationCount: 1, criticalCount: 0, warningCount: 0 }, issues: [],
    };
    if (command === "list_tag_taxonomy_repairs") return { repairs: [] };
    if (command === "get_tag_governance_proposal_evidence") return { evidence: [] };
    if (command === "preview_tag_governance_proposal") return {
      taxonomyRevision: revision, stale: false, reviewBlocked: false, reviewBlockers: [], tagImpacts: [],
      withdrawalImpact: { relationCount: 1, relations: [], affectedTags: ["a"], relatedAcceptedProposalCount: 0, relatedAcceptedProposalIds: [], sourceTagsModified: false },
    };
    if (command === "resolve_tag_governance_proposal" || command === "withdraw_tag_governance_proposal") throw new Error("Hub 内部标签体系已经变化，请重新预演");
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  invoke.mockReset();
});

const click = async (selector: string) => {
  const button = container.querySelector<HTMLButtonElement>(selector)!;
  expect(button).not.toBeNull();
  await act(async () => button.click());
};

describe("TagGovernanceInbox version locks", () => {
  it("blocks approval without a version but leaves rejection available", async () => {
    revision = "";
    await act(async () => root.render(<TagGovernanceInbox tagId="a" />));
    await click(".tag-governance-summary");
    expect(container.querySelector<HTMLButtonElement>("footer button.primary")?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>("footer button:not(.primary)")?.disabled).toBe(false);
  });

  it("discards an expired approval preview and reads a new version before retry", async () => {
    await act(async () => root.render(<TagGovernanceInbox tagId="a" />));
    await click(".tag-governance-summary");
    await click("footer button.primary");
    expect(invoke).toHaveBeenCalledWith("resolve_tag_governance_proposal", expect.objectContaining({ expectedTaxonomyRevision: "taxonomy-1" }));
    expect(container.querySelector(".tag-governance-detail")).toBeNull();
    revision = "taxonomy-2";
    await click(".tag-governance-summary");
    await click("footer button.primary");
    expect(invoke).toHaveBeenCalledWith("resolve_tag_governance_proposal", expect.objectContaining({ expectedTaxonomyRevision: "taxonomy-2" }));
    expect(invoke.mock.calls.filter(([name]) => name === "preview_tag_governance_proposal")).toHaveLength(2);
  });

  it("requires a new preview and two clicks after a rejected withdrawal", async () => {
    proposalStatus = "accepted";
    await act(async () => root.render(<TagGovernanceInbox />));
    await click(".tag-governance-status-filter button:nth-child(2)");
    await click(".tag-governance-summary");
    await click(".tag-governance-resolution button");
    expect(invoke.mock.calls.filter(([name]) => name === "withdraw_tag_governance_proposal")).toHaveLength(0);
    await click(".tag-governance-resolution button");
    expect(invoke).toHaveBeenCalledWith("withdraw_tag_governance_proposal", expect.objectContaining({ expectedTaxonomyRevision: "taxonomy-1" }));
    revision = "taxonomy-2";
    await click(".tag-governance-summary");
    await click(".tag-governance-resolution button");
    expect(invoke.mock.calls.filter(([name]) => name === "withdraw_tag_governance_proposal")).toHaveLength(1);
    await click(".tag-governance-resolution button");
    expect(invoke).toHaveBeenCalledWith("withdraw_tag_governance_proposal", expect.objectContaining({ expectedTaxonomyRevision: "taxonomy-2" }));
  });

  it("does not allow withdrawal when a preview has no relationship version", async () => {
    proposalStatus = "accepted";
    revision = "";
    await act(async () => root.render(<TagGovernanceInbox />));
    await click(".tag-governance-status-filter button:nth-child(2)");
    await click(".tag-governance-summary");
    expect(container.querySelector<HTMLButtonElement>(".tag-governance-resolution button")?.disabled).toBe(true);
  });
});
