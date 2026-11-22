// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentSkillPackages} from "./AgentSkillPackages";
const {invoke,choose}=vi.hoisted(()=>({invoke:vi.fn(),choose:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
vi.mock("@tauri-apps/plugin-dialog",()=>({open:choose}));
const src={packageId:"package-one",revision:1,name:"review-a",directory:"D:/fixture/method",mode:"source",methodVersion:"method-one",sourceFingerprint:"file-fingerprint"};
const file={path:"assets/report.md",bytes:15,sha256:"file-sha",kind:"asset",readable:true,encoding:"utf8"};
const inspected={source:null,directory:src.directory,methodVersion:"method-preview",sourceFingerprint:src.sourceFingerprint,skill:{name:src.name,title:"复核方法",available:true,unavailableReasons:[]},files:[file,{path:"scripts/check.py",kind:"script",bytes:3,sha256:"script-sha",readable:false,encoding:"utf8"}],warnings:["脚本仅保存，不执行"],verifiedByRealRun:false};
const saved={...inspected,source:src,methodVersion:src.methodVersion,history:[{revision:1,methodVersion:src.methodVersion}]};
let host:HTMLDivElement,root:Root;const changed=vi.fn();
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement("div");document.body.append(host);root=createRoot(host);changed.mockReset();choose.mockReset().mockResolvedValue(src.directory);invoke.mockReset().mockImplementation(async(_name,{args})=>{if(args.action==="skillPackages")return {sources:[src]};if(args.action==="skillPackagePreview")return inspected;if(args.action==="skillPackageDetails"||args.action==="skillPackageImport")return saved;if(args.action==="skillPackageFile")return {packageId:src.packageId,methodVersion:src.methodVersion,path:file.path,sha256:file.sha256,content:"<script>unsafe()</script>\n# template",previewOnly:true};throw Error("unexpected "+args.action);});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(b=>b.textContent===text)!;
const click=async(text:string)=>act(async()=>{button(text).click();await new Promise(r=>setTimeout(r,0));});
async function render(){await act(async()=>root.render(<AgentSkillPackages onChanged={changed}/>));}
async function inspect(){await click("管理方法包");await click("检查方法文件夹");}
it("uses the registered package identity and real pause operation from the management card",async()=>{
 const base=invoke.getMockImplementation()!;
 invoke.mockImplementation((name,payload)=>payload.args.action==="skillPackagePause"
  ?Promise.resolve({...saved,paused:true}):base(name,payload));
 const cardSkill={...saved.skill,description:"复核点检表",packageId:src.packageId,origin:"registered" as const,version:src.methodVersion,allowImplicitInvocation:true};
 await act(async()=>root.render(<AgentSkillPackages initiallyExpanded cardSkills={[cardSkill]} onChanged={changed}/>));
 const row=host.querySelector(".agent-skill-manager-card")!;
 expect(row.textContent).toContain("复核方法第 1 版Codex 通用");
 const toggle=row.querySelector<HTMLButtonElement>('[role="switch"]')!;
 expect(toggle.getAttribute("aria-checked")).toBe("true");
 await act(async()=>toggle.click());
 expect(invoke.mock.calls.find(([,request])=>request.args.action==="skillPackagePause")?.[1].args)
  .toEqual({action:"skillPackagePause",packageId:src.packageId,expectedRevision:src.revision,paused:true});
 expect(changed).toHaveBeenCalledTimes(1);
 expect(host.querySelector('[aria-label="已保存方法包"]')).toBeNull();
 await act(async()=>root.render(<AgentSkillPackages initiallyExpanded cardSkills={[{...cardSkill,available:false,unavailableReasons:["技能已停用"]}]} onChanged={changed}/>));
 expect(toggle.getAttribute("aria-checked")).toBe("false");
});
it("does not inspect folders or invoke tools until requested, then shows a complete compatibility inventory",async()=>{
 await render();expect(invoke).not.toHaveBeenCalled();expect(choose).not.toHaveBeenCalled();await inspect();
 expect(choose).toHaveBeenCalledWith({directory:true,multiple:false,title:"选择包含 SKILL.md 的普通方法文件夹"});expect(host.textContent).toContain("尚未导入");expect(host.textContent).toContain("scripts/check.py");expect(host.textContent).toContain("脚本仅保存，不执行");expect(invoke.mock.calls.some(([,x])=>x.args.action==="skillPackageImport")).toBe(false);
 await click("保存固定方法包");const submitted=invoke.mock.calls.find(([,x])=>x.args.action==="skillPackageImport")![1].args;expect(submitted.expectedFingerprint).toBe(src.sourceFingerprint);expect(submitted.mode).toBe("source");expect(submitted.clientRequestId).toBeTruthy();expect(changed).toHaveBeenCalledTimes(1);
});
it("keeps the exact unknown commit request and blocks a different submission until reconciled",async()=>{
 let failed=true;invoke.mockImplementation(async(_name,{args})=>{if(args.action==="skillPackages")return {sources:[]};if(args.action==="skillPackagePreview")return inspected;if(args.action==="skillPackageImport"){if(failed)throw Error("receipt and status unavailable");return saved;}if(args.action==="skillPackageRequest")return {found:false};throw Error(args.action);});
 await render();await inspect();await click("保存固定方法包");expect(host.textContent).toContain("结果待核对");expect(button("保存固定方法包").disabled).toBe(true);const first=invoke.mock.calls.find(([,x])=>x.args.action==="skillPackageImport")![1].args;
 await click("核对本次保存结果");expect(host.textContent).toContain("仍可能在途");expect(button("保存固定方法包").disabled).toBe(true);failed=false;await click("以同一请求重试");const attempts=invoke.mock.calls.filter(([,x])=>x.args.action==="skillPackageImport");expect(attempts).toHaveLength(2);expect(attempts[1][1].args).toEqual(first);expect(host.textContent).not.toContain("结果待核对");expect(changed).toHaveBeenCalledTimes(1);
});
it("a known committed result followed by list refresh failure is not falsely made uncertain",async()=>{
 let reads=0;invoke.mockImplementation(async(_name,{args})=>{if(args.action==="skillPackages"){reads++;if(reads>1)throw Error("list unavailable");return {sources:[]};}if(args.action==="skillPackagePreview")return inspected;if(args.action==="skillPackageImport")return saved;throw Error(args.action);});
 await render();await inspect();await click("保存固定方法包");expect(host.textContent).toContain("保存已核对，但来源清单刷新失败");expect(host.textContent).not.toContain("结果待核对");expect(button("检查方法文件夹").disabled).toBe(false);
});
it("name conflicts prevent overwrite and absent optional resource support is visible",async()=>{
 invoke.mockImplementation(async(_name,{args})=>args.action==="skillPackages"?{sources:[]}:{...inspected,nameConflict:"同名来源不能覆盖",skill:{...inspected.skill,available:false,unavailableReasons:["缺少必需依赖"]}});
 await render();await inspect();expect(button("保存固定方法包").disabled).toBe(true);expect(host.textContent).toContain("缺少必需依赖");expect(host.textContent).toContain("同名来源不能覆盖");
});
it("no-change inspection does not publish or start a model",async()=>{
 const base=invoke.getMockImplementation()!;invoke.mockImplementation((name,args)=>args.args.action==="skillPackageCheck"?Promise.resolve({...saved,changed:false}):base(name,args));
 await render();await click("管理方法包");await click("review-a · 登记第1版");await click("检查原目录变化（不运行）");expect(host.textContent).toContain("无须重新发布或运行模型");expect(button("发布检查过的新版本（旧版保留）").disabled).toBe(true);expect(invoke.mock.calls.some(([,x])=>/Update|Switch|run/i.test(x.args.action))).toBe(false);
});
it("file preview renders inert text, rejects mismatched identities, and Escape returns focus locally",async()=>{
 await render();await click("管理方法包");await click("review-a · 登记第1版");await click("预览 assets/report.md");expect(host.querySelector("pre")?.textContent).toContain("<script>unsafe()</script>");expect(host.querySelector("script")).toBeNull();expect(document.activeElement).toBe(button("关闭文件预览并返回"));
 await act(async()=>button("关闭文件预览并返回").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true})));expect(host.querySelector("pre")).toBeNull();expect(document.activeElement).toBe(button("预览 assets/report.md"));expect(host.querySelector('[aria-expanded="true"]')).not.toBeNull();
 invoke.mockResolvedValueOnce({packageId:"package-foreign",methodVersion:src.methodVersion,path:file.path,content:"wrong source",previewOnly:true});await click("预览 assets/report.md");expect(host.querySelector("pre")).toBeNull();expect(host.textContent).toContain("预览文件身份不一致");
});
it("late file preview after unmount has no state or follow-up mutation",async()=>{
 await render();await click("管理方法包");await click("review-a · 登记第1版");let done!:(v:unknown)=>void;invoke.mockImplementationOnce(()=>new Promise(r=>{done=r;}));await act(async()=>button("预览 assets/report.md").click());await act(async()=>root.unmount());root=createRoot(host);const before=invoke.mock.calls.length;await act(async()=>done({packageId:src.packageId,methodVersion:src.methodVersion,path:file.path,content:"late",previewOnly:true}));expect(invoke.mock.calls).toHaveLength(before);expect(host.textContent).not.toContain("late");
});

it("publishes only the inspected update with exact source revision and fingerprint",async()=>{
 const base=invoke.getMockImplementation()!;invoke.mockImplementation((name,args)=>{if(args.args.action==="skillPackageCheck")return Promise.resolve({...saved,changed:true,sourceFingerprint:"next-fingerprint"});if(args.args.action==="skillPackageUpdate")return Promise.resolve({...saved,source:{...src,revision:2,methodVersion:"method-two"},methodVersion:"method-two"});return base(name,args);});
 await render();await click("管理方法包");await click("review-a · 登记第1版");await click("检查原目录变化（不运行）");await click("发布检查过的新版本（旧版保留）");const sent=invoke.mock.calls.find(([,x])=>x.args.action==="skillPackageUpdate")![1].args;expect(sent.packageId).toBe(src.packageId);expect(sent.expectedRevision).toBe(1);expect(sent.expectedFingerprint).toBe("next-fingerprint");expect(changed).toHaveBeenCalledTimes(1);
});
it("history switch retains the current registration revision rather than borrowing the old version revision",async()=>{
 const active={...saved,source:{...src,revision:2,methodVersion:"method-two"},methodVersion:"method-two",history:[{revision:2,methodVersion:"method-two"},{revision:1,methodVersion:src.methodVersion}]};const base=invoke.getMockImplementation()!;invoke.mockImplementation((name,args)=>args.args.action==="skillPackageDetails"||args.args.action==="skillPackageSwitch"?Promise.resolve(active):base(name,args));
 await render();await click("管理方法包");await click("review-a · 登记第1版");const select=host.querySelector<HTMLSelectElement>("select")!;await act(async()=>{select.value=src.methodVersion;select.dispatchEvent(new Event("change",{bubbles:true}));});await click("切换未来使用版本（历史与动作保留）");const sent=invoke.mock.calls.find(([,x])=>x.args.action==="skillPackageSwitch")![1].args;expect(sent.expectedRevision).toBe(2);expect(sent.methodVersion).toBe(src.methodVersion);expect(sent.packageId).toBe(src.packageId);
});


it("deletion needs an exact preview and explicit confirmation, then retains historical limits",async()=>{
 const base=invoke.getMockImplementation()!;let removed=false;
 invoke.mockImplementation((name,x)=>{const a=x.args;if(a.action==="skillPackages")return Promise.resolve({sources:removed?[]:[src]});if(a.action==="skillPackageDeletePreview")return Promise.resolve({packageId:src.packageId,revision:1,fingerprint:"delete-plan",methodVersions:2,readReceipts:3,scope:"删除Hub副本；原目录、报告、失败和累计用量保留，外部历史不召回"});if(a.action==="skillPackageDelete"){removed=true;return Promise.resolve({clientRequestId:a.clientRequestId,packageId:src.packageId,operation:"delete",state:"completed",detail:{}});}return base(name,x);});
 await render();await click("管理方法包");await click("review-a · 登记第1版");await click("核对删除Hub保存副本的范围");expect(button("确认删除Hub保存副本").disabled).toBe(true);expect(invoke.mock.calls.some(([,x])=>x.args.action==="skillPackageDelete")).toBe(false);
 const checkbox=host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;await act(async()=>checkbox.click());await click("确认删除Hub保存副本");const sent=invoke.mock.calls.find(([,x])=>x.args.action==="skillPackageDelete")![1].args;expect(sent.expectedFingerprint).toBe("delete-plan");expect(sent.confirmed).toBe(true);expect(host.textContent).toContain("外部已发送或导出的副本未召回");expect(host.querySelector('[aria-label="已保存方法包"]')).toBeNull();expect(document.activeElement).toBe(button("管理方法包"));
});
it("export chooses a parent and sends the viewed immutable version without executing anything",async()=>{
 const base=invoke.getMockImplementation()!;choose.mockResolvedValue("D:/exports");invoke.mockImplementation((name,x)=>x.args.action==="skillPackageExport"?Promise.resolve({clientRequestId:x.args.clientRequestId,packageId:src.packageId,operation:"export",state:"completed",detail:{methodVersion:src.methodVersion,target:"D:/exports/review-a"}}):base(name,x));
 await render();await click("管理方法包");await click("review-a · 登记第1版");await click("导出正在查看的固定版本");expect(choose).toHaveBeenCalledWith({directory:true,multiple:false,title:"选择导出父文件夹（新建方法子目录，不覆盖）"});const sent=invoke.mock.calls.find(([,x])=>x.args.action==="skillPackageExport")![1].args;expect(sent.methodVersion).toBe(src.methodVersion);expect(sent.expectedRevision).toBe(1);expect(sent.directory).toBe("D:/exports");expect(host.textContent).toContain("已核对固定版本导出");expect(invoke.mock.calls.some(([,x])=>/run|execute|publishReport/i.test(x.args.action))).toBe(false);
});
it("partial export stays uncertain and a saved matching receipt resolves the same operation",async()=>{
 const base=invoke.getMockImplementation()!;let original:Record<string,unknown>|undefined;
 invoke.mockImplementation((name,x)=>{const a=x.args;if(a.action==="skillPackageExport"){original=a;return Promise.resolve({clientRequestId:a.clientRequestId,packageId:src.packageId,operation:"export",state:"unverified",detail:{methodVersion:src.methodVersion,target:"D:/exports/review-a"},verificationReason:"目录所有权待核对"});}if(a.action==="skillPackageRequest")return Promise.resolve({found:true,operation:{clientRequestId:original!.clientRequestId,packageId:src.packageId,operation:"export",state:"completed",detail:{methodVersion:src.methodVersion,target:"D:/exports/review-a"}}});return base(name,x);});
 await render();await click("管理方法包");await click("review-a · 登记第1版");await click("导出正在查看的固定版本");expect(host.textContent).toContain("结果待核对");expect(button("导出正在查看的固定版本").disabled).toBe(true);expect(host.textContent).not.toContain("已核对固定版本导出");await click("核对本次保存结果");expect(host.textContent).toContain("已核对固定版本导出");expect(invoke.mock.calls.filter(([,x])=>x.args.action==="skillPackageExport")).toHaveLength(1);
});
it("a mismatched requested history version cannot replace the displayed manifest",async()=>{
 const active={...saved,history:[{revision:2,methodVersion:"method-two"},{revision:1,methodVersion:src.methodVersion}]};const base=invoke.getMockImplementation()!;invoke.mockImplementation((name,x)=>x.args.action==="skillPackageDetails"?Promise.resolve(active):base(name,x));
 await render();await click("管理方法包");await click("review-a · 登记第1版");const select=host.querySelector<HTMLSelectElement>("select")!;await act(async()=>{select.value="method-two";select.dispatchEvent(new Event("change",{bubbles:true}));});await click("查看所选版本的清单");expect(host.textContent).toContain("返回身份或文件清单不一致");
});

it("a committed then explicitly deleted import is reconciled without resurrecting or retrying it",async()=>{
 const base=invoke.getMockImplementation()!;invoke.mockImplementation((name,x)=>x.args.action==="skillPackageImport"?Promise.reject(Error("lost reply")):x.args.action==="skillPackageRequest"?Promise.resolve({found:true,removedPackageId:src.packageId}):base(name,x));
 await render();await inspect();await click("保存固定方法包");expect(host.textContent).toContain("结果待核对");await click("核对本次保存结果");expect(host.textContent).toContain("原保存曾提交，随后方法被明确删除");expect(host.textContent).not.toContain("结果待核对");expect(invoke.mock.calls.filter(([,x])=>x.args.action==="skillPackageImport")).toHaveLength(1);
});

it("returns keyboard focus to the scope trigger when deletion is cancelled without mutating data",async()=>{
 const base=invoke.getMockImplementation()!;
 invoke.mockImplementation((name,x)=>x.args.action==="skillPackageDeletePreview"?Promise.resolve({packageId:src.packageId,revision:1,fingerprint:"delete-scope",methodVersions:1,readReceipts:0,scope:"仅保存副本"}):base(name,x));
 await render();await click("管理方法包");await click("review-a · 登记第1版");await click("核对删除Hub保存副本的范围");
 button("取消删除").focus();await click("取消删除");
 expect(document.activeElement).toBe(button("核对删除Hub保存副本的范围"));
 expect(host.querySelector('[aria-label="删除方法副本确认"]')).toBeNull();
 expect(invoke.mock.calls.some(([,x])=>x.args.action==="skillPackageDelete")).toBe(false);
});
