// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AgentConversation, AgentDelivery, type Conversation } from "./AgentDelivery";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it.runIf(Boolean(import.meta.env.VITE_HUB_CHART_DEPENDENCY_VIEW_JSON))("renders the actual persisted chart/report revision sequence and collapses superseded prose", async () => {
  const sequence = JSON.parse(import.meta.env.VITE_HUB_CHART_DEPENDENCY_VIEW_JSON);
  const render = async (conversation: Conversation) => act(async () => root.render(
    <AgentConversation conversation={conversation} revoked={false} onOpenCitation={() => {}} />,
  ));
  await render(sequence.before.conversation);
  expect(host.textContent).toContain("旧口径：共 3 次提及");
  expect(host.querySelector('p[aria-label="回答使用的图表版本"]')?.textContent).toContain("第 1 版");
  expect(host.querySelector(".agent-history")).toBeNull();

  await render(sequence.changed.conversation);
  const old = host.querySelector<HTMLDetailsElement>(".agent-history")!;
  expect(old.open).toBe(false);
  expect(old.querySelector("summary")?.textContent).toBe("查看旧版回答（要求或图表已更新）");
  expect(old.textContent).toContain("第 1 版（当前第 2 版）");
  expect(old.closest(".agent-message")?.textContent).toContain("旧回答仅供历史查阅");
  expect(old.textContent).toContain("旧口径：共 3 次提及");
  await act(async () => old.querySelector("summary")!.click());
  expect(old.open).toBe(true);

  await render(sequence.repaired.conversation);
  const messages = host.querySelectorAll(".agent-message-assistant");
  const newest = messages[messages.length - 1];
  expect(newest.querySelector(".agent-history")).toBeNull();
  expect(newest.textContent).toContain("新口径：共 2 天提及");
  expect(newest.textContent).toContain("第 2 版");

  await act(async () => root.render(<AgentDelivery report={null} evidence={[]} history={sequence.changed.history} running={false} revoked={false} />));
  expect(host.textContent).toContain("旧回答仅供历史查阅");
  expect(host.querySelector("details details")?.hasAttribute("open")).toBe(false);

  await render(sequence.removed.conversation);
  expect(host.textContent).not.toContain("旧口径：共 3 次提及");
  expect(host.textContent).not.toContain("新口径：共 2 天提及");
  expect(host.querySelector('[aria-label="回答使用的图表版本"]')).toBeNull();
});

it.runIf(Boolean(import.meta.env.VITE_HUB_GOAL_BINDING_VIEW_JSON))("collapses the persisted answer after a new goal command even without charts", async () => {
  const sequence = JSON.parse(import.meta.env.VITE_HUB_GOAL_BINDING_VIEW_JSON);
  const render = async (conversation: Conversation) => act(async () => root.render(
    <AgentConversation conversation={conversation} revoked={false} onOpenCitation={() => {}} />,
  ));
  await render(sequence.before.conversation);
  expect(host.querySelector(".agent-history")).toBeNull();
  await render(sequence.changed.conversation);
  const history = host.querySelector<HTMLDetailsElement>(".agent-history")!;
  expect(history.open).toBe(false);
  expect(history.querySelector("summary")?.textContent).toBe("查看旧版回答（要求或图表已更新）");
  expect(host.textContent).toContain("用户要求已更新");
  expect(history.textContent).toContain("历史回答保持原字节");
  expect(host.querySelector('[aria-label="回答使用的图表版本"]')).toBeNull();
  await act(async () => history.querySelector("summary")!.click());
  expect(history.open).toBe(true);
});
