// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentSkills } from "./AgentSkills";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
const select = vi.fn();
const catalog = { directory: "D:/Hub Data/agent-skills", diagnostics: [], skills: [
  { name: "hub-flashcards", title: "有来源的闪卡", description: "按当前笔记制作或检查闪卡", origin: "builtin", available: true, allowImplicitInvocation: true, unavailableReasons: [], version: "v1" },
  { name: "custom-audit", title: "学习审核", description: "按个人方法检查", origin: "user", available: true, allowImplicitInvocation: false, unavailableReasons: [], version: "v2" },
  { name: "missing", title: "终端分析", description: "需要外部能力", origin: "user", available: false, allowImplicitInvocation: true, unavailableReasons: ["当前 Hub 未接入依赖：terminal"], version: "v3" }
] };
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset().mockResolvedValue(catalog); select.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(disabled = false) { await act(async () => root.render(<AgentSkills disabled={disabled} onSelect={select} />)); }
async function open() { await act(async () => { host.querySelector("summary")!.click(); await new Promise(resolve => setTimeout(resolve, 0)); }); }
it("loads the actual catalog only on demand and inserts an explicit skill selection", async () => {
  await render(); expect(invoke).not.toHaveBeenCalled(); await open();
  expect(invoke).toHaveBeenCalledWith("agent_investigation", { args: { action: "skills" } });

  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes("有来源的闪卡"))!.click());
  expect(select).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="技能详情"]')).not.toBeNull();
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "添加到本次对话")!.click());
  expect(select).toHaveBeenCalledExactlyOnceWith("hub-flashcards"); expect(host.querySelector("details")!.open).toBe(false);
});
it("explains unavailable dependencies and prevents selecting a blocked skill", async () => {
  await render(); await open();
  const button = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("终端分析"))!;
  await act(async () => button.click());
  expect(host.textContent).toContain("未接入依赖：terminal");
  expect([...host.querySelectorAll("button")].find(b=>b.textContent === "添加到本次对话")?.disabled).toBe(true);
  expect(select).not.toHaveBeenCalled();
});
it("offers retry after discovery failure and opens the owned directory only on a user click", async () => {
  invoke.mockRejectedValueOnce(new Error("技能目录暂不可读")); await render(); await open();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("暂不可读");
  invoke.mockResolvedValue(catalog);
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "刷新技能")!.click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(invoke.mock.calls.some(([, args]) => args.args.action === "openSkillDirectory")).toBe(false);
  invoke.mockImplementation(async(_,{args})=>args.action==="skillPackages"?{sources:[]}:catalog);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="管理技能"]')!.click());
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "打开用户技能文件夹")!.click());
  expect(invoke).toHaveBeenLastCalledWith("agent_investigation", { args: { action: "openSkillDirectory" } });
  expect(host.textContent).toContain(catalog.directory);
  expect(host.textContent).toContain("与 Codex 的用户技能独立");
  expect(host.textContent).toContain("Hub MCP");
});

it("explains the purpose before origin and does not require a skill for ordinary questions",async()=>{
  await render(); await open();
  expect(host.textContent).toContain("按需自动选用");
  const choice=host.querySelector('.agent-skill-choice > button')!;
  expect(choice.querySelector('.agent-skill-icon svg')).not.toBeNull();
  expect(choice.querySelector('.agent-skill-copy strong')?.textContent).toBe("有来源的闪卡");
  expect(choice.textContent).not.toContain("助手可按需使用");
  expect(choice.parentElement?.querySelector("details")).toBeNull();
  expect(select).not.toHaveBeenCalled();
});

it("keeps empty discovery distinct from loading failure without choosing a fallback skill",async()=>{
  invoke.mockResolvedValue({...catalog,skills:[]});
  await render(); await open();
  expect(host.textContent).toContain("还没有可用技能");
  expect(host.textContent).toContain("可直接提问");
  expect(host.querySelector('.agent-skill-choice')).toBeNull();
  expect(select).not.toHaveBeenCalled();
});

it("keeps the internal guide searchable alongside other skills while allowing automatic selection",async()=>{
  invoke.mockResolvedValue({...catalog,skills:[...catalog.skills,{...catalog.skills[0],name:"hub-tool-guide",title:"Hub 工具使用方法"}]});
  const reset=vi.fn();
  await act(async()=>root.render(<AgentSkills disabled={false} onSelect={select} selected={["hub-flashcards"]} onReset={reset}/>));
  await open();
  expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toContain('有来源的闪卡');
  expect(host.querySelector(".agent-skill-description")).toBeNull();
  const guide=host.querySelector('[aria-label="查看技能 Hub 工具使用方法"]')!;
  expect(guide).not.toBeNull();
  expect(guide.closest('section')?.getAttribute('aria-label')).toBe('全部技能');
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='恢复自动选择')!.click());
  expect(reset).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
});

it("searches title, identifier and purpose, and keeps focus when pinning moves a skill",async()=>{
  function PinnedSkills(){const [pinned,setPinned]=useState<string[]>([]);return <AgentSkills embedded disabled={false} onSelect={select} pinned={pinned} onPin={name=>setPinned(current=>current.includes(name)?current.filter(item=>item!==name):[...current,name])}/>;}
  await act(async()=>root.render(<PinnedSkills/>));
  const pin=host.querySelector<HTMLButtonElement>('[aria-label="置顶技能 学习审核"]')!;
  await act(async()=>{pin.focus();pin.click();});
  expect(host.querySelector('.agent-skill-group')?.getAttribute('aria-label')).toBe('置顶');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('取消置顶技能 学习审核');
  const search=host.querySelector<HTMLInputElement>('[aria-label="搜索技能"]')!;
  async function query(value:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,value);search.dispatchEvent(new Event('input',{bubbles:true}));});}
  for(const keyword of ['学习审核','custom-audit','个人方法']){await query(keyword);expect(host.querySelectorAll('.agent-skill-choice')).toHaveLength(1);expect(host.querySelector('.agent-skill-choice')?.textContent).toContain('学习审核');}
  await query('不存在的技能');expect(host.textContent).toContain('没有找到匹配的技能');
  await query('');
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="查看技能 学习审核"]')!.click());
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="取消置顶技能 学习审核"]')!.click());
  expect(document.activeElement?.getAttribute('aria-label')).toBe('置顶技能 学习审核');
  expect(select).not.toHaveBeenCalled();
});
