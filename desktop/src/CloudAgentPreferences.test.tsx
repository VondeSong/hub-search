// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudModelPanel, CloudSkillSheet, quotaLabel, type CloudModel } from "./CloudAgentPreferences";
import { runtimeCapabilities } from "./RuntimePlatform";
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: { mobile: false } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); runtimeCapabilities.mobile = false; });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const model: CloudModel = { model: "gpt-test", displayName: "Test", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] };
async function click(label: string) { const button = [...host.querySelectorAll<HTMLElement>("button,summary")].find(item => item.getAttribute("aria-label") === label || item.textContent?.trim() === label); expect(button, label).toBeTruthy(); await act(async () => button!.click()); }

it("uses only the runtime catalog and the supported efforts", async () => {
  const choose = vi.fn();
  await act(async () => root.render(<CloudModelPanel page="model" catalog={{ state: "ready", models: [model] }} selection={{model:model.model,effort:"low"}} disabled={false} onSelect={choose} onPage={vi.fn()} onRefresh={vi.fn()}/>));
  await click("GPT-test执行端默认模型");
  expect(choose).toHaveBeenCalledWith({model:model.model,effort:"low"});
  await act(async () => root.render(<CloudModelPanel page="effort" catalog={{ state: "ready", models: [model] }} selection={{model:model.model,effort:"low"}} disabled={false} onSelect={choose} onPage={vi.fn()} onRefresh={vi.fn()}/>));
  expect(host.querySelectorAll("button")).toHaveLength(2);
  expect(host.textContent).not.toContain("Ultra");
  await click("高为复杂问题投入更多推理");
  expect(choose).toHaveBeenLastCalledWith({model:model.model,effort:"high"});
});

it("explains weekly and short quota windows without showing them as time spent", async () => {
  expect(quotaLabel(10080)).toBe("本周已用"); expect(quotaLabel(300)).toBe("5 小时额度已用");
  await act(async () => root.render(<CloudModelPanel page="usage" account={{ state: "ready", plan: "prolite", limits: [{usedPercent:18,windowDurationMins:10080},{usedPercent:3,windowDurationMins:300}] }} disabled={false} onSelect={vi.fn()} onPage={vi.fn()} onRefresh={vi.fn()}/>));
  expect(host.textContent).toContain("ChatGPT Pro Lite"); expect(host.textContent).toContain("本周已用18%");
  expect(host.textContent).not.toContain("10080"); expect(host.querySelectorAll("progress")).toHaveLength(2);
  await act(async () => root.render(<CloudModelPanel page="usage" account={{state:"unknown"}} disabled={false} onSelect={vi.fn()} onPage={vi.fn()} onRefresh={vi.fn()}/>));
  expect(host.textContent).toContain("暂未提供额度读数"); expect(host.querySelector("progress")).toBeNull();
});

it("browses skill details and optional files before explicitly adding to the message", async () => {
  const choose = vi.fn();
  const skill = { name:"record-to-log", title:"整理日志", description:"把零散叙述整理为一条日志", methodVersion:"version-one", paths:["references/formats.md","references/very-long-resource-name.md"] };
  await act(async () => root.render(<CloudSkillSheet skills={[skill]} paths={[]} onChoose={choose} onClose={vi.fn()} onRetry={vi.fn()}/>));
  await click("查看技能 整理日志 的详情");
  expect(choose).not.toHaveBeenCalled(); expect(host.textContent).toContain("添加到消息");
  await click("配套文件 · 2");
  await act(async () => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click());
  expect(choose).not.toHaveBeenCalled();
  await click("添加到消息");
  expect(choose).toHaveBeenCalledWith(skill,["references/formats.md"]);
});

it("Android back returns from skill details to the list before dismissing the sheet", async () => {
  runtimeCapabilities.mobile = true;
  window.history.replaceState({hubMobileRoute:"agents",hubCloudAgentChat:true},"");
  function Harness() { const [open, setOpen] = useState(true); return open ? <CloudSkillSheet skills={[{name:"record-to-log",title:"日志",methodVersion:"version",paths:[]}]} paths={[]} onChoose={vi.fn()} onClose={()=>setOpen(false)} onRetry={vi.fn()}/> : <p>closed</p>; }
  await act(async () => root.render(<Harness/>));
  await click("查看技能 日志 的详情");
  await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve,30)); });
  expect(host.querySelector('[aria-label="搜索技能"]')).not.toBeNull(); expect(window.history.state.hubCloudDialog).toBeTruthy();
  await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve,30)); });
  expect(host.textContent).toBe("closed");
});

it("keeps a bound skill immutable while its metadata is loading", async () => {
  const choose=vi.fn(); const fixed={name:"original",version:"old-version",paths:["SKILL.md","references/fixed.md"]};
  await act(async () => root.render(<CloudSkillSheet bound={fixed} skills={[]} paths={[]} onChoose={choose} onClose={vi.fn()} onRetry={vi.fn()}/>));
  expect(host.textContent).toContain("此版本已固定到本对话");
  expect(host.textContent).toContain("references/fixed.md");
  expect(host.querySelector('input[type="checkbox"]')).toBeNull(); expect(choose).not.toHaveBeenCalled();
  await act(async () => root.render(<CloudSkillSheet bound={fixed} skills={[{name:"original",title:"Original",description:"Saved method",methodVersion:"old-version",paths:["references/fixed.md","references/unused.md"]}]} paths={[]} onChoose={choose} onClose={vi.fn()} onRetry={vi.fn()}/>));
  expect(host.querySelector(".cloud-skill-fixed-file")?.textContent).toContain("fixed.md");
  expect(host.textContent).not.toContain("unused.md");
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect(host.textContent).toContain("新建对话可更换技能");
});

it("includes a new skill's companion text and keeps a failed preflight inside its detail sheet", async () => {
  const skill={name:"log",title:"日志",description:"整理记录",methodVersion:"version",paths:["references/required.md"]};
  const choose=vi.fn(async()=>{throw new Error("技能正文与参考文字超过上限");});
  await act(async()=>root.render(<CloudSkillSheet skills={[skill]} paths={[]} onChoose={choose} onClose={vi.fn()} onRetry={vi.fn()}/>));
  await click("添加技能 日志");
  expect(choose).toHaveBeenCalledWith(skill,["references/required.md"]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("超过上限");
  expect(host.querySelector('[aria-label="/log"]')).not.toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
});
