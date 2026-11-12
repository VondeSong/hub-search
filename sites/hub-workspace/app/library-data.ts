import type { Section } from "./data";

export type LibraryId = "craft" | "obsidian" | "dida" | "feishu";
export type LibraryNode = {
  id: string; library: LibraryId; parent: string; title: string;
  kind: "folder" | "document" | "page" | "collection" | "attachment" | "taskList" | "taskGroup" | "task" | "note" | "shortcut";
  filename?: string; description?: string; tags?: string[]; sections?: Section[];
  status?: "todo" | "doing" | "done"; priority?: "高" | "中"; due?: string;
  documentType?: "docx" | "sheet" | "bitable"; targetId?: string; access?: "restricted";
  rows?: string[][]; imageSrc?: string;
};
export const libraries = {
  craft: { name: "Car", provider: "Craft", description: "工程资料空间", root: "craft-root", initialFolder: "c-harness", initialDocument: "c-guide", expanded: ["c-harness", "c-guide"], countLabel: "文档与子页面" },
  obsidian: { name: "OS", provider: "Obsidian", description: "本地知识库", root: "obsidian-root", initialFolder: "o-resources", initialDocument: "o-learning", expanded: ["o-resources", "o-knowledge"], countLabel: "Markdown 笔记" },
  dida: { name: "工作与生活", provider: "滴答清单", description: "清单、任务与项目笔记", root: "dida-root", initialFolder: "d-wire", initialDocument: "d-review", expanded: ["d-work", "d-wire", "d-prep", "d-review"], countLabel: "任务与笔记" },
  feishu: { name: "工程知识库", provider: "飞书", description: "知识空间与云文档", root: "feishu-root", initialFolder: "f-home", initialDocument: "f-guide", expanded: ["f-home", "f-guide"], countLabel: "页面节点" },
} satisfies Record<LibraryId, object>;
const p = (text: string): Section => ({ type: "p", text });
const h = (text: string): Section => ({ type: "h2", text });
const list = (...items: string[]): Section => ({ type: "list", items });

// Fictional fixtures for exploring navigation. They do not come from connected libraries.
export const libraryNodes: LibraryNode[] = [
  { id: "c-harness", library: "craft", parent: "craft-root", title: "线束工程", kind: "folder", description: "设计方法、图纸与验证记录" },
  { id: "c-guide", library: "craft", parent: "c-harness", title: "线束设计指南", kind: "document", description: "把设计依据、图纸检查与验证记录组织在一起。", tags: ["线束", "设计方法"], sections: [p("一份从问题出发的设计资料入口。这里把设计过程拆成几个可以独立阅读的子页面，让每一次核对都能回到相应的依据。"),h("从资料到验证"),list("先确认项目、图纸版本和适用条件。","按回路、连接器和布置分别整理资料。","记录问题、依据与验证结果，保留尚未确定的部分。"),{type:"callout",text:"这是用于体验库结构的示例文档。点击下方子页面，或展开左侧文档，继续逐层浏览。"},h("继续阅读")] },
  { id: "c-circuit", library: "craft", parent: "c-guide", title: "回路与连接器", kind: "page", description: "检查端点、连接器和孔位之间的对应关系。", tags:["回路"], sections:[p("核对回路时，先把端点、连接器、孔位和线号放到同一份记录中。保留原图位置，方便回看。"),h("核对顺序"),list("确认图纸版本与图例。","对照两端孔位和线号，记录无法确定的字段。","检查跨页连接，并将问题反馈回原始记录。"),h("页面内还有一层")] },
  { id: "c-pin", library: "craft", parent: "c-circuit", title: "孔位核对清单", kind: "page", description:"一条回路从起点走到终点。", tags:["连接器"], sections:[p("这是第三层子页面。页面层级代表它在原文中的位置，和文件夹层级分别保留。"),{type:"checklist",items:["核对连接器标识。","核对起点和终点孔位。","保留图纸页码及版本。"]}] },
  { id: "c-layout", library: "craft", parent: "c-guide", title: "布置与固定", kind: "page", description:"围绕固定点、相邻件和运动空间记录问题。", tags:["布置"], sections:[p("用照片或图纸位置描述待核对区域，再把观察条件、疑问与验证记录放在一起。"),h("记录的最小单位"),list("具体位置与适用工况。","关联图纸和版本。","下一步验证以及负责事项。") ] },
  { id: "c-checks", library: "craft", parent: "c-harness", title: "图纸检查记录", kind: "document", description:"用一个小样本核对 DXF 到线表的对应关系。", tags:["DXF","验证"], sections:[p("先选一张有完整说明的样图，逐行核对导出结果。"),h("本轮关注"),list("字段定义是否清楚。","端点和线号能否准确对应。","无法确认的项是否被保留下来。") ] },
  { id: "c-projects", library: "craft", parent: "c-harness", title: "项目资料", kind: "folder", description:"按项目保存资料，不按标题合并文档。" },
  { id: "c-project-a", library: "craft", parent: "c-projects", title: "项目 A · 设计评审", kind: "document", description:"评审材料、问题与后续动作。", tags:["评审"], sections:[p("把同一次评审的材料、问题和处理记录放在一起。"),h("讨论前准备"),list("记录本轮范围。","补齐来源链接。","标明等待确认的问题。") ] },
  { id: "c-reference", library: "craft", parent: "craft-root", title: "设计参考", kind: "folder" },
  { id: "c-collection", library: "craft", parent: "c-reference", title: "界面参考集", kind: "collection", description:"用一张表整理可借鉴的交互方式。", tags:["设计","参考"], sections:[p("合集仍是原库中的一个内容对象。它的条目既能按字段比较，也能打开各自的子页面。下方的表格与画廊使用同一组示例条目。") ] },
  { id: "c-ref-nav", library: "craft", parent: "c-collection", title: "目录与阅读的衔接", kind: "page", description:"结构清楚，阅读时也能知道自己在哪里。",tags:["导航"],sections:[p("观察目录、内容列表和预览如何协作。展开的位置与当前阅读内容应当互相对应。"),h("可借鉴的机制"),list("面包屑可以返回上级。","搜索结果可以定位回目录。","切换资料库后保留各自的浏览位置。") ] },
  { id: "c-ref-read", library: "craft", parent: "c-collection", title: "长文阅读与大纲", kind: "page",description:"普通标题留在页内，子页面保留在结构中。",tags:["阅读"],sections:[p("页内大纲帮助阅读一篇长文，目录树帮助找到文档在库中的位置。两者分别表达不同层级。") ] },
  { id: "c-ref-search", library: "craft", parent: "c-collection", title: "范围搜索与反馈", kind: "page",description:"明确搜索的是当前目录还是整个空间。",tags:["搜索"],sections:[p("搜索范围始终可见。没有命中时给出清楚的反馈，并允许扩大到整个库。") ] },
  { id: "c-daily", library: "craft", parent: "craft-root", title: "日记", kind: "folder", description:"按日期进入每日记录。" },
  { id: "c-day", library: "craft", parent: "c-daily", title: "2026.11.08 · 每日记录", kind: "document",description:"整理资料，记录今天确认的事情。", tags:["日记"], sections:[p("今天尝试从目录进入资料，再从搜索结果回到原来的位置。"),h("留下一个观察"),p("在展开深层页面后切换到另一个库，再切回来看看位置是否还在。") ] },
  { id: "c-inbox", library: "craft", parent: "craft-root", title: "未分类", kind: "folder",description:"还未放入文件夹的文档。" },
  { id: "c-inbox-note", library: "craft", parent: "c-inbox", title: "待整理的想法", kind: "document",description:"先保存，稍后再整理。",sections:[p("灵感可以先留下来，等问题和用途明确后再放进合适的位置。") ] },
  { id: "c-empty", library: "craft", parent: "craft-root", title: "待补充资料", kind: "folder",description:"这个文件夹已读取，当前没有内容。" },
  { id: "o-projects", library: "obsidian", parent: "obsidian-root", title: "01 Projects", kind: "folder" },
  { id: "o-hub", library: "obsidian", parent: "o-projects", title: "Hub", kind: "folder" },
  { id: "o-hub-notes", library: "obsidian", parent: "o-hub", title: "项目入口", filename:"项目入口.md", kind: "document",description:"目标、进展与尚未解决的问题。",tags:["Hub","项目"],sections:[p("这个文件与其他笔记一起保存在实际目录中。文件名和目录路径可以直接帮助理解它的归属。"),h("本轮目标"),p("体验在一个工作空间中浏览不同来源的资料。"),{type:"quote",text:"结构提供位置，链接提供另一条到达内容的路。"}] },
  { id: "o-hub-review", library: "obsidian", parent: "o-hub", title: "每周回顾", filename:"每周回顾.md", kind: "document",description:"Hub 项目本周进展的示例记录。",tags:["回顾"],sections:[p("本篇属于 Hub 项目。库里另一篇同名的每周回顾属于生活区域，两份笔记保持独立。") ] },
  { id: "o-areas", library: "obsidian", parent: "obsidian-root", title: "02 Areas", kind: "folder" },
  { id: "o-life-review", library: "obsidian", parent: "o-areas", title: "每周回顾", filename:"每周回顾.md", kind: "document",description:"生活与学习节奏的示例回顾。",tags:["生活","回顾"],sections:[p("这是一篇生活回顾，与项目目录中的同名笔记是两个独立文件。定位时以完整路径区分。") ] },
  { id: "o-resources", library: "obsidian", parent: "obsidian-root", title: "03 Resources", kind: "folder", description:"学习材料、方法与知识入口。" },
  { id: "o-learning", library: "obsidian", parent: "o-resources", title: "从阅读到知识应用", filename:"从阅读到知识应用.md", kind: "document", description:"把一个观点与当前的问题连接，再做一次小验证。",tags:["知识管理","学习"],sections:[p("保存一份资料，只是开始。尝试用自己的问题重新阅读，再把能够使用的部分整理成可返回的知识。"),h("让知识有一个落点"),list("带着问题阅读，并记录适用条件。","用自己的语言留下理解，链接到依据。","选择一个小场景应用，再记录结果。"),h("关联笔记"),p("下面的双链可以打开本库中的相关笔记；笔记在目录中的实际位置保持清楚。") ] },
  { id: "o-knowledge", library: "obsidian", parent: "o-resources", title: "知识管理", kind: "folder" },
  { id: "o-links", library: "obsidian", parent: "o-knowledge", title: "双链与主题入口", filename:"双链与主题入口.md", kind: "document",description:"目录表达归属，双链帮助跨目录找到相关内容。",tags:["双链","知识管理"],sections:[p("从一篇笔记可以沿着内部链接去往另一篇，随后也可以在目录里定位它。"),h("三种入口"),list("目录：按位置寻找。","标签：按主题筛选。","双链：跟着明确的引用继续阅读。") ] },
  { id: "o-reading", library: "obsidian", parent: "o-knowledge", title: "阅读笔记的方法", filename:"阅读笔记的方法.md", kind: "document",description:"问题、摘录、理解与下一次使用。",tags:["阅读","学习"],sections:[p("留下一次阅读真正回答了什么，附上原文依据，再说明哪些问题还没有答案。") ] },
  { id: "o-ai", library: "obsidian", parent: "o-resources", title: "AI 与工具", kind: "folder" },
  { id: "o-ai-note", library: "obsidian", parent: "o-ai", title: "与助手一起整理资料", filename:"与助手一起整理资料.md", kind: "document",description:"先明确范围，再核对来源与结果。",tags:["AI"],sections:[p("选定需要整理的资料，说明本次问题，并在保存前核对引用、事实和仍待确认的内容。") ] },
  { id: "o-attachments", library: "obsidian", parent: "o-resources", title: "Attachments", kind: "folder",description:"原附件单独展示，不计入 Markdown 笔记数量。" },
  { id: "o-pdf", library: "obsidian", parent: "o-attachments", title: "阅读摘录样例.pdf",kind:"attachment",description:"PDF 附件 · 原型中提供文件信息展示。" },
  { id:"o-reading-image",library:"obsidian",parent:"o-attachments",title:"阅读界面示例.jpg",kind:"attachment",description:"浏览器原型的阅读界面图片。",imageSrc:"/hub-insights-reading-design.jpg" },
  { id: "o-archive", library: "obsidian", parent: "obsidian-root", title: "04 Archive", kind: "folder",description:"已读取 · 当前没有归档内容。" },
  { id: "o-daily", library: "obsidian", parent: "obsidian-root", title: "Daily Notes", kind: "folder" },
  { id: "o-day", library: "obsidian", parent: "o-daily", title: "2026-11-08", filename:"2026-11-08.md",kind:"document",description:"今天的一次资料整理。",tags:["日记"],sections:[p("今天整理了学习资料。把引用补齐，比多收集几篇更有帮助。") ] },
  { id:"d-work",library:"dida",parent:"dida-root",title:"工作",kind:"folder" },
  { id:"d-wire",library:"dida",parent:"d-work",title:"线束项目",kind:"taskList",description:"按自定义分组整理任务，保留各自的完成状态。" },
  { id:"d-prep",library:"dida",parent:"d-wire",title:"资料准备",kind:"taskGroup" },
  { id:"d-review",library:"dida",parent:"d-prep",title:"准备线束设计评审",kind:"task",description:"收齐图纸、问题记录与本轮评审范围。",status:"doing",priority:"高",due:"11 月 12 日",tags:["线束","评审"],sections:[p("这是一项可以拆成独立子任务的示例任务。子任务有自己的完成状态；下方检查项只用于本任务内部核对。"),h("本次评审范围"),p("先对照图纸版本，再整理仍待确认的接口与回路。"),{type:"checklist",items:["邀请评审参与人。","在会议说明中附上材料入口。"]}] },
  { id:"d-version",library:"dida",parent:"d-review",title:"确认图纸版本",kind:"task",description:"记录本轮使用的图纸版本与日期。",status:"done",tags:["图纸"],sections:[p("图纸版本已在这份示例中确认。它是父任务下面的一条独立子任务，不是正文检查项。") ] },
  { id:"d-questions",library:"dida",parent:"d-review",title:"整理评审问题清单",kind:"task",description:"将无法确认的点汇总后，带到评审中。",status:"todo",due:"11 月 11 日",sections:[p("每一项问题保留位置、依据与待确认的内容。") ] },
  { id:"d-sample",library:"dida",parent:"d-prep",title:"选取一张 DXF 样图",kind:"task",description:"选一张能够人工核对端点的样图。",status:"todo",priority:"中",sections:[p("用一个范围明确的小样本验证字段与端点的对应关系。") ] },
  { id:"d-design",library:"dida",parent:"d-wire",title:"设计核对",kind:"taskGroup" },
  { id:"d-interface",library:"dida",parent:"d-design",title:"核对跨线束接口",kind:"task",description:"将两侧连接器和孔位信息放在一起核对。",status:"todo",due:"11 月 13 日",tags:["接口"],sections:[p("记录接口两侧的标识、孔位和版本，有疑问的地方单独保留。") ] },
  { id:"d-routing",library:"dida",parent:"d-design",title:"补充布置检查记录",kind:"task",description:"将现场观察补回项目资料。",status:"done",sections:[p("这条示例任务已完成，可以取消勾选体验恢复为待办。") ] },
  { id:"d-follow",library:"dida",parent:"d-wire",title:"评审跟进",kind:"taskGroup",description:"这个自定义分组暂时没有任务。" },
  { id:"d-notes",library:"dida",parent:"d-work",title:"项目笔记",kind:"taskList",description:"笔记清单 · 记录背景和想法。" },
  { id:"d-note",library:"dida",parent:"d-notes",title:"本轮设计评审的背景",kind:"note",description:"参考资料使用笔记，不需要勾选完成。",tags:["评审"],sections:[p("本轮希望把图纸检查与问题讨论放在一起，先确认最小验证范围，再安排后续工作。"),h("需要保留的背景"),list("本轮材料与适用版本。","仍待讨论的问题。","评审后的结论与下一步。") ] },
  { id:"d-personal",library:"dida",parent:"dida-root",title:"个人",kind:"folder" },
  { id:"d-learn-list",library:"dida",parent:"d-personal",title:"学习安排",kind:"taskList" },
  { id:"d-learn",library:"dida",parent:"d-learn-list",title:"整理一篇阅读笔记",kind:"task",status:"todo",description:"留下观点、依据与适用条件。",sections:[p("选一篇与当前问题有关的资料，用自己的语言留下理解。") ] },
  { id:"d-inbox",library:"dida",parent:"dida-root",title:"收件箱",kind:"taskList" },
  { id:"d-inbox-task",library:"dida",parent:"d-inbox",title:"整理今天的收件箱",kind:"task",status:"todo",description:"把新想法放入合适的清单。",sections:[p("先确认是否有明确行动，再决定保存为任务还是笔记。") ] },
  { id:"d-empty",library:"dida",parent:"dida-root",title:"稍后处理",kind:"taskList",description:"清单已读取，暂时没有任务。" },
  { id:"f-home",library:"feishu",parent:"feishu-root",title:"项目首页",kind:"document",documentType:"docx",description:"项目资料的总入口，页面本身也可以继续阅读。",sections:[p("知识库的一个节点既可以承载文档，也可以拥有下级页面。左侧使用页面图标，保留它在知识空间中的位置。"),h("常用入口"),p("从设计指南进入详细记录，或查看接口台账与项目追踪。") ] },
  { id:"f-guide",library:"feishu",parent:"f-home",title:"线束设计指南",kind:"document",documentType:"docx",description:"从知识库节点进入文档，再继续展开下级页面。",tags:["线束","设计"],sections:[p("飞书知识库以页面节点组织资料。当前页面有自己的正文，下级页面作为独立节点保留。"),h("本页关注"),list("设计依据与项目范围。","接口定义与验证记录。","评审结论及后续事项。"),h("下级页面")] },
  { id:"f-review",library:"feishu",parent:"f-guide",title:"设计评审记录",kind:"document",documentType:"docx",description:"本轮讨论、依据与后续记录。",sections:[p("本次评审先核对材料版本，再逐项讨论无法确认的内容。"),h("记录内容"),list("本轮的范围和参加角色。","确认的事项及其依据。","待补充资料和下次核对点。") ] },
  { id:"f-interface",library:"feishu",parent:"f-guide",title:"接口定义",kind:"document",documentType:"docx",description:"接口两端的信息与适用条件。",sections:[p("将连接器标识、端点和适用图纸放在一起，遇到版本变化时可以回到原始依据。") ] },
  { id:"f-shortcut",library:"feishu",parent:"f-home",title:"设计规范（快捷方式）",kind:"shortcut",documentType:"docx",targetId:"f-spec",description:"指向同一篇规范文档，保留当前目录位置。" },
  { id:"f-spec",library:"feishu",parent:"feishu-root",title:"设计规范",kind:"document",documentType:"docx",description:"项目适用规范的示例说明。",tags:["规范"],sections:[p("这是设计规范文档的原始节点。从项目首页的快捷方式也能阅读同一份内容，两处导航节点的路径分别保留。"),h("使用前确认"),list("适用项目和版本。","规范正文与附件是否完整。","已有变更记录和待确认事项。") ] },
  { id:"f-sheet",library:"feishu",parent:"feishu-root",title:"接口台账",kind:"document",documentType:"sheet",description:"电子表格 · 按行查看接口核对进度。",rows:[["接口","核对状态","下一步"],["车身 / 左前门","待核对","补齐连接器孔位"],["仪表 / 车身","已记录","复核图纸版本"],["底盘 / 车身","待核对","确认接口定义"]] },
  { id:"f-bitable",library:"feishu",parent:"feishu-root",title:"项目追踪",kind:"document",documentType:"bitable",description:"多维表格 · 以字段整理项目记录。",rows:[["事项","阶段","资料类型"],["设计评审","准备中","云文档"],["接口核对","待补充","电子表格"],["问题整理","进行中","记录"]] },
  { id:"f-restricted",library:"feishu",parent:"feishu-root",title:"供应商共享资料",kind:"document",documentType:"docx",access:"restricted",description:"目录可见 · 正文需要额外权限。" },
];
export const nodeById = Object.fromEntries(libraryNodes.map(node => [node.id, node]));
export const childrenOf = (id: string) => libraryNodes.filter(node => node.parent === id);
export const ancestorsOf = (id: string): LibraryNode[] => {
  const result: LibraryNode[] = []; let node = nodeById[id];
  while (node) { result.unshift(node); node = nodeById[node.parent]; }
  return result;
};
export const pathOf = (node: LibraryNode) => [libraries[node.library].name, ...ancestorsOf(node.id).map(n=>n.filename||n.title)].join(" / ");
export const isWithin = (node: LibraryNode, container: string) => node.parent===container || ancestorsOf(node.id).some(n=>n.id===container);
export const isContainer = (node: LibraryNode) => ["folder","taskList","taskGroup"].includes(node.kind);
export const isContent = (node: LibraryNode) => !isContainer(node) && node.kind!=="attachment";
export const contentOf = (node: LibraryNode): LibraryNode => node.targetId ? nodeById[node.targetId] || node : node;
export const nodeKindLabel = (node: LibraryNode) => node.kind==="task" ? (nodeById[node.parent]?.kind==="task"?"子任务":"任务") : node.kind==="taskList"?"清单":node.kind==="taskGroup"?"分组":node.kind==="note"?"笔记":node.kind==="shortcut"?"快捷方式":node.documentType==="sheet"?"电子表格":node.documentType==="bitable"?"多维表格":node.library==="feishu"?"云文档":({folder:"文件夹",document:"文档",page:"子页面",collection:"合集",attachment:"附件"} as Record<string,string>)[node.kind];
export function searchLibrary(library: LibraryId, query: string, container?: string) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return libraryNodes.filter(node=>node.library===library && !isContainer(node) && (!container||isWithin(node,container)) && terms.every(term=>[node.title,node.filename,node.description,...node.tags||[],...(node.access==="restricted"?[]:contentOf(node).sections?.map(s=>s.text||s.items?.join(" "))||[]),...(node.access==="restricted"?[]:contentOf(node).rows?.flat()||[])].join(" ").toLocaleLowerCase().includes(term)));
}

// Each column is one real parent; a leaf never creates an empty child column.
export function columnParents(library: LibraryId, cursor: string): string[] {
  const node=nodeById[cursor];
  if(!node||node.library!==library)return [libraries[library].root];
  return [libraries[library].root,...ancestorsOf(cursor).filter(n=>isContainer(n)||childrenOf(n.id).length>0).map(n=>n.id)];
}
