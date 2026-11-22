import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const source=readFileSync(new URL("../app/library-data.ts",import.meta.url),"utf8");
const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
const {columnParents,libraryNodes,nodeById,libraries,childrenOf,ancestorsOf,pathOf,searchLibrary,isContent,isContainer,contentOf,nodeKindLabel,isWithin}=await import("data:text/javascript;base64,"+Buffer.from(outputText).toString("base64"));
let checks=0;
const check=(label,fn)=>{fn();checks++;process.stdout.write("✓ "+label+"\n");};
check("节点身份唯一，父节点属于同一库，层级无循环",()=>{
 assert.equal(new Set(libraryNodes.map(n=>n.id)).size,libraryNodes.length);
 for(const n of libraryNodes){assert.ok(n.parent===libraries[n.library].root||nodeById[n.parent]?.library===n.library);const seen=new Set();let current=n;while(current){assert.ok(!seen.has(current.id));seen.add(current.id);current=nodeById[current.parent];}}
 assert.deepEqual(ancestorsOf("c-pin").map(n=>n.id),["c-harness","c-guide","c-circuit","c-pin"]);
});
check("目录列表只包含直接子项",()=>{assert.deepEqual(childrenOf("c-harness").map(n=>n.id),["c-guide","c-checks","c-projects"]);});
check("范围搜索包含深层页面，排除范围外内容",()=>{
 assert.ok(searchLibrary("craft","孔位","c-harness").some(n=>n.id==="c-pin"));
 assert.equal(searchLibrary("craft","孔位","c-reference").length,0);
 assert.ok(searchLibrary("craft","孔位").length>0);
});
check("搜索隔离资料库并支持正文多个关键词",()=>{
 assert.equal(searchLibrary("obsidian","孔位核对清单").length,0);
 assert.ok(searchLibrary("craft","图纸 版本").some(n=>n.id==="c-circuit"));
 assert.equal(searchLibrary("craft","完全不存在的关键词").length,0);
});
check("空目录有节点，附件不计入笔记数",()=>{
 assert.ok(nodeById["c-empty"]);assert.equal(childrenOf("c-empty").length,0);
 assert.ok(nodeById["o-archive"]);assert.equal(childrenOf("o-archive").length,0);
 assert.deepEqual(childrenOf("o-attachments").map(n=>n.id),["o-pdf","o-reading-image"]);assert.equal(childrenOf("o-attachments").filter(isContent).length,0);
});
check("同名笔记通过完整路径保持独立",()=>{
 const results=searchLibrary("obsidian","每周回顾");assert.equal(results.length,2);assert.equal(new Set(results.map(pathOf)).size,2);assert.equal(searchLibrary("obsidian","每周回顾","o-projects").length,1);
});
check("合集与初始浏览位置的归属正确",()=>{
 assert.equal(childrenOf("c-collection").length,3);assert.ok(isWithin(nodeById["c-ref-nav"],"c-reference"));assert.ok(!isWithin(nodeById["c-ref-nav"],"c-harness"));
 for(const [id,meta] of Object.entries(libraries)){assert.equal(nodeById[meta.initialFolder].library,id);assert.equal(nodeById[meta.initialDocument].library,id);for(const key of meta.expanded)assert.equal(nodeById[key].library,id);}
});
check("滴答的清单与分组是容器，子任务和检查项分别保留",()=>{
 assert.ok(isContainer(nodeById["d-wire"]));assert.ok(isContainer(nodeById["d-prep"]));assert.ok(!isContent(nodeById["d-prep"]));
 assert.equal(nodeKindLabel(nodeById["d-version"]),"子任务");assert.equal(nodeKindLabel(nodeById["d-review"]),"任务");
 assert.equal(childrenOf("d-review").length,2);assert.equal(nodeById["d-review"].sections.find(s=>s.type==="checklist").items.length,2);
 assert.equal(childrenOf("d-follow").length,0);assert.equal(childrenOf("d-empty").length,0);
 assert.equal(nodeById["d-note"].status,undefined);assert.ok(isContent(nodeById["d-note"]));
});
check("滴答范围搜索包含子任务，四库搜索分别隔离",()=>{
 assert.ok(searchLibrary("dida","图纸版本","d-wire").some(n=>n.id==="d-version"));
 assert.equal(searchLibrary("dida","图纸版本","d-inbox").length,0);
 for(const id of Object.keys(libraries))assert.ok(searchLibrary(id,"").every(n=>n.library===id));
});
check("飞书快捷方式共享正文但保留不同节点与路径",()=>{
 assert.equal(contentOf(nodeById["f-shortcut"]).id,"f-spec");assert.notEqual(pathOf(nodeById["f-shortcut"]),pathOf(nodeById["f-spec"]));
 const results=searchLibrary("feishu","适用项目和版本");assert.ok(results.some(n=>n.id==="f-shortcut"));assert.ok(results.some(n=>n.id==="f-spec"));
});
check("飞书页面可承载子节点，表格正文可搜索，权限节点不包含正文",()=>{
 assert.ok(!isContainer(nodeById["f-guide"]));assert.equal(childrenOf("f-guide").length,2);
 assert.equal(nodeKindLabel(nodeById["f-sheet"]),"电子表格");assert.equal(nodeKindLabel(nodeById["f-bitable"]),"多维表格");
 assert.ok(searchLibrary("feishu","仪表").some(n=>n.id==="f-sheet"));
 assert.equal(nodeById["f-restricted"].sections,undefined);assert.equal(nodeById["f-restricted"].access,"restricted");
});
check("分栏保留完整祖先，空目录有列，叶子与快捷方式不虚构下级",()=>{
 assert.deepEqual(columnParents("craft","c-pin"),["craft-root","c-harness","c-guide","c-circuit"]);
 assert.deepEqual(columnParents("dida","d-version"),["dida-root","d-work","d-wire","d-prep","d-review"]);
 assert.deepEqual(columnParents("obsidian","o-archive"),["obsidian-root","o-archive"]);
 assert.deepEqual(columnParents("feishu","f-shortcut"),["feishu-root","f-home"]);
 assert.deepEqual(columnParents("obsidian","c-pin"),["obsidian-root"]);
});
process.stdout.write(`${checks} 组库结构检查通过。\n`);
