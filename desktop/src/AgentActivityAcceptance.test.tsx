// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentActivity,ActivityDisclosureProvider,type ActivityEvent,type ActivityRun} from "./AgentActivity";
import {ActivityIdentity} from "./AgentActivityIdentity";

vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn().mockRejectedValue(new Error("offline"))}));
let host:HTMLDivElement,root:Root;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const event=(extra:Partial<ActivityEvent>={}):ActivityEvent=>({id:"tool",kind:"tool",operation:"read",state:"completed",label:"核对来源",createdAt:1000,finishedAt:2000,...extra});
const run=(events:ActivityEvent[],extra:Partial<ActivityRun>={}):ActivityRun=>({runId:"acceptance",revision:1,state:"completed",running:false,startedAt:1000,finishedAt:5000,steps:events.length,events,...extra});
async function render(events:ActivityEvent[],expanded=true,extra:Partial<ActivityRun>={}){
 await act(async()=>root.render(<AgentActivity value={run(events,extra)}/>));
 if(expanded&&host.querySelector(".agent-activity-toggle")?.getAttribute("aria-expanded")==="false")await act(async()=>host.querySelector<HTMLButtonElement>(".agent-activity-toggle")!.click());
}

it("only the paused run receives the recovery controls and its own unverified draft", async()=>{
 const current=run([event({id:"partial",kind:"unpublishedAnswer",state:"unverified",label:"本轮草稿"})],{runId:"paused-run",state:"interrupted"});
 const previous=run([event({id:"older",kind:"unpublishedAnswer",state:"unverified",label:"旧轮草稿"})],{runId:"previous-run",state:"interrupted"});
 const onScope=vi.fn(), onResume=vi.fn();
 await act(async()=>root.render(<ActivityDisclosureProvider recovery={{runId:current.runId,reason:"正在等待手动恢复",canResume:true,onScope,onResume}}>
   <AgentActivity value={previous}/><AgentActivity value={current}/>
 </ActivityDisclosureProvider>));
 const cards=host.querySelectorAll(".agent-recovery-card");
 expect(cards).toHaveLength(1);
 expect(cards[0].textContent).not.toContain("本轮草稿");
 const [resume, scope, preview]=cards[0].querySelectorAll("button");
 await act(async()=>preview.click());
 expect(cards[0].textContent).toContain("本轮草稿");
 expect(cards[0].textContent).not.toContain("旧轮草稿");
 await act(async()=>scope.click());
 expect(onScope).toHaveBeenCalledWith(scope);
 await act(async()=>resume.click());
 expect(onResume).toHaveBeenCalledOnce();
});

it.each([
 ["search","搜索资料","search"],["read","读取资料","read"],
 ["command","运行命令","command"],["compute","运行计算脚本","compute"],
 ["edit","编辑文件","edit"],["loadSkill","使用技能","skill"],
 ["readSkillReference","使用技能","skill"],["delegate","协调子代理","delegate"],
 ["mcp","使用外部工具","mcp"],["future-operation","调用工具","tool"],
])("AC01 %s keeps the same semantic icon in its group and row",async(operation,title,icon)=>{
 await render([event({operation,label:"Search 修改 运行 — a misleading bilingual title",detail:"真实回执"})],true,{native:true});
 const summary=host.querySelector(".agent-operation-group > summary")!;
 expect(summary.textContent).toBe("已"+title);
 expect(summary.querySelector("[data-activity-icon]")?.getAttribute("data-activity-icon")).toBe(icon);
 expect(host.querySelector(".agent-activity-step [data-activity-icon]")?.getAttribute("data-activity-icon")).toBe(icon);
});
it("AC02 browser metadata selects the browser icon and preserves the actual source",async()=>{
 await render([event({operation:"mcp",serviceId:"browser:https://developers.openai.com",sourceRefs:[{url:"https://developers.openai.com/plugins/concepts/skills",title:"Skills"}]})]);
 expect(host.querySelector(".agent-activity-step [data-activity-icon]")?.getAttribute("data-activity-icon")).toBe("browser");
 expect(host.querySelector('[aria-label="developers.openai.com"]')).not.toBeNull();
});
it("AC03 a mixed phase retains both kinds without borrowing the first operation icon",async()=>{
 await render([event({id:"read"}),event({id:"search",operation:"search",createdAt:2500})],true,{native:true});
 const summary=host.querySelector(".agent-operation-group > summary")!;
 expect(summary.textContent).toContain("已读取资料、搜索资料");
 expect(summary.querySelector("[data-activity-icon]")?.getAttribute("data-activity-icon")).toBe("tool");
});
it("summarizes mixed connected work without reordering the individual receipts",async()=>{
 await render([
  event({id:"command",operation:"command",label:"检查工作区",detail:"退出码 0"}),
  event({id:"edit",operation:"edit",label:"编辑说明",createdAt:2000}),
  event({id:"chat",operation:"readChat",label:"读取聊天",createdAt:3000}),
  event({id:"rename",operation:"renameChat",label:"重命名聊天",createdAt:4000,state:"failed"}),
  event({id:"git",operation:"mcp",serviceId:"github",toolName:"github.fetch_issue",createdAt:5000}),
  event({id:"git2",operation:"mcp",serviceId:"github",toolName:"github.fetch_issue_comments",createdAt:6000}),
 ],true,{native:true});
 const group=host.querySelector<HTMLDetailsElement>(".agent-operation-group")!;
 const summary=group.querySelector("summary")!;
 expect(summary.querySelector(".agent-phase-label")?.textContent).toBe("使用了 GitHub、运行了命令、编辑了文件、读取了聊天、重命名聊天");
 expect(summary.querySelector('[data-activity-brand="GitHub"]')).not.toBeNull();
 expect(summary.querySelectorAll("img")).toHaveLength(1);
 expect(summary.querySelector(".agent-phase-warning")?.textContent).toBe("部分未完成");
 await act(async()=>summary.click());
 const rows=[...group.querySelectorAll(".agent-activity-step")];
 expect(rows.map(row=>row.textContent)).toEqual([
  expect.stringContaining("检查工作区"),expect.stringContaining("编辑说明"),expect.stringContaining("读取聊天"),
  expect.stringContaining("重命名聊天"),expect.stringContaining("github.fetch_issue"),expect.stringContaining("github.fetch_issue_comments"),
 ]);
 expect(rows[0].querySelector(".lucide-square-terminal")).not.toBeNull();
 expect(rows[1].querySelector(".lucide-file-pen-line")).not.toBeNull();
 expect(rows[2].querySelector(".lucide-messages-square")).not.toBeNull();
 expect(rows[4].querySelectorAll("img")).toHaveLength(1);
});
it.each(["failed","interrupted"])("AC04 a %s external tool stays visible with the entire successful process collapsed",async state=>{
 await render([event({state,operation:"mcp",label:"读取 GitHub 议题",detail:"实际工具未返回结果"}),event({id:"recovered",label:"读取另一份来源",createdAt:3000})],false);
 const warning=host.querySelector('[aria-label="工具操作未完成"]');
 expect(warning?.textContent).toContain("读取 GitHub 议题");
 expect(warning?.textContent).toContain(state==="failed"?"未完成":"已中断");
 expect(warning?.textContent).not.toContain("已完成");
 expect(host.querySelector(".agent-activity-events")).toBeNull();
});
it.each([["failed","未完成"],["running","进行中"],["queued","等待执行"]])("AC05 a short %s tool has a textual state even with no detail or receipt",async(state,label)=>{
 await render([event({state,finishedAt:undefined})],true,{state:state==="running"?"investigating":"completed",running:state==="running"});
 expect(host.querySelector(".agent-activity-step")?.textContent).toContain(label);
});
it("AC06 a successful retry does not erase the previous failed call or report every call as successful",async()=>{
 const events=[event({id:"first",state:"failed",detail:"连接暂时不可用"}),event({id:"retry",label:"重试读取",createdAt:3000})];
 await render(events,true,{native:true});
 const summary=host.querySelector(".agent-operation-group > summary")!;
 expect(summary.querySelector(".agent-phase-warning")?.textContent).toBe("部分未完成");
 expect(summary.textContent).not.toContain("已读取资料");
});
it("AC07 source and agent decorations cannot be invented by a model label",async()=>{
 await act(async()=>root.render(<ActivityIdentity events={[event({label:"GitHub、Notion 和两个代理已完成",serviceId:"unknown-service"})]}/>));
 expect(host.querySelector("img")).toBeNull();expect(host.querySelector(".agent-avatar")).toBeNull();
});
it("AC08 extra public sites remain counted, unsafe references add no icon, and image failure keeps its footprint",async()=>{
 await act(async()=>root.render(<ActivityIdentity workId="acceptance-sites" events={[event({sourceRefs:[{url:"https://github.com/a"},{url:"https://github.com/b"},{url:"https://developers.openai.com/a"},{url:"https://notion.so/a"},{url:"https://modelcontextprotocol.io/a"},{url:"http://localhost/private"},{url:"https://user:password@example.com"}]})]}/>));
 expect(host.querySelectorAll(".agent-site-icon")).toHaveLength(3);
 expect(host.querySelector("small")?.textContent).toBe("另 1 个站点");
 expect(host.querySelector("small")?.title).toContain("modelcontextprotocol.io");
 expect(host.querySelector(".agent-site-icon img")).toBeNull();
});
it("AC09 a real agent keeps the same avatar after updates, with no avatar for empty identities",async()=>{
 const renderIdentity=(ids:string[])=>root.render(<ActivityIdentity events={[event({agentIds:ids})]}/>);
 await act(async()=>renderIdentity(["actual-agent-123456"]));
 const avatar=host.querySelector(".agent-avatar")!;const drawing=avatar.innerHTML;
 await act(async()=>renderIdentity(["actual-agent-123456","actual-agent-123456"]));
 expect(host.querySelectorAll(".agent-avatar")).toHaveLength(1);expect(host.querySelector(".agent-avatar")?.innerHTML).toBe(drawing);
 await act(async()=>renderIdentity([]));expect(host.querySelector(".agent-avatar")).toBeNull();
});
it("AC10 an interrupted public summary and context lifecycle remain public history rather than a completed action",async()=>{
 await render([event({id:"summary",kind:"reasoning",operation:undefined,state:"interrupted",label:"核对上下文范围"}),event({id:"compact",kind:"context",origin:"publicLifecycle",operation:undefined,label:"上下文已自动压缩",createdAt:2500})]);
 expect(host.querySelector('[aria-label="思考摘要"]')?.textContent).toContain("已中断");
 expect(host.querySelector('.agent-context-event [data-activity-icon]')?.getAttribute("data-activity-icon")).toBe("context");
 expect(host.querySelector('.lucide-check')).toBeNull();
});
