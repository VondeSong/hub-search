export type DemoCard={id:string;deck:string;question:string;answer:string;source:string;isNew:boolean;cardType?:'multiple_choice'|'typed_answer';choices?:string[];correctChoice?:number;acceptedAnswer?:string};
export const demoCards:DemoCard[]=[
 {id:'knowledge',deck:'学习笔记',question:'阅读中的一个观点，怎样成为真正可用的知识？',answer:'把观点与当前问题连接，保留原始依据与适用条件，再用一个小样本验证。',source:'知识应用 · DXF 试验',isNew:false},
 {id:'hub',deck:'学习笔记',question:'在 Hub 中处理一条洞察，会自动完成原任务吗？',answer:'不会。发现的处理状态与来源任务状态分别维护。需要操作时，回到任务清单确认。',source:'Hub · 洞察边界',isNew:false},
 {id:'engineering',deck:'工程知识',question:'比对两份工程记录时，应该先核对哪些信息？',answer:'先确认对象、版本、记录时间和适用工况，再比较差异；不要只按相似标题合并。',source:'线束 · 资料核对',isNew:true},
 {id:'decision',deck:'学习笔记',question:'决定值得回顾的触发条件有哪些？',answer:'到了约定日期，或关键假设有了新证据。回顾时对照当时理由和后来观察。',source:'决策 · 条件与回顾',isNew:true},
 {id:'choice',deck:'学习笔记',question:'哪种做法更能避免把演示结果当作真实验收？',answer:'明确标注示例，并分别记录原型、真实数据和实际客户端的验证结果。',source:'示例 · 验收边界',isNew:false,cardType:'multiple_choice',choices:['页面完整，就标记全部通过','分别记录示例、真实数据与客户端证据','只保留成功截图'],correctChoice:1},
 {id:'typed',deck:'工程知识',question:'先核对对象、____、时间和工况，再比较两份记录。请补全空缺。',answer:'版本。资料的适用版本会影响差异解释。',source:'示例 · 资料核对',isNew:true,cardType:'typed_answer',acceptedAnswer:'版本'},
 {id:'evidence',deck:'学习笔记',question:'结论暂时缺少依据时，怎样记录？',answer:'保留为待验证的假设，并列出需要补充的证据。',source:'示例 · 证据与假设',isNew:false},
 {id:'context',deck:'学习笔记',question:'摘录之外，留下一句话有什么帮助？',answer:'说明摘录与当前问题的关系，方便下次找回使用场景。',source:'示例 · 阅读记录',isNew:true},
 {id:'source',deck:'学习笔记',question:'转述资料时，为什么要保留来源？',answer:'方便回到原文核对上下文、适用条件和后续更新。',source:'示例 · 来源核对',isNew:false},
 {id:'boundary',deck:'工程知识',question:'工程记录里的未知数据怎么处理？',answer:'保留未知并说明缺口，不能把未知填成零。',source:'示例 · 数据边界',isNew:false},
 {id:'sample',deck:'工程知识',question:'验证复杂流程，可以从哪里开始？',answer:'选一份可人工核对的小样本，写清预期、实际结果与差异。',source:'示例 · 验证方法',isNew:true},
 {id:'change',deck:'工程知识',question:'新记录出现后，原结论必须修改吗？',answer:'不一定。先比较证据是否相关，维持结论也应留下核对理由。',source:'示例 · 后续核对',isNew:true},
];
export const draftCards:DemoCard[]=[
 {id:'draft-reading',deck:'学习笔记',question:'读完一篇文章，先留下什么？',answer:'留下一条与当前问题有关的观点及其依据。',source:'收件箱 · 阅读摘录示例',isNew:true},
 {id:'draft-engineering',deck:'工程知识',question:'试装记录应保留哪些背景？',answer:'对象、版本、观察条件和实际结果。',source:'收件箱 · 试装记录示例',isNew:true},
];
export const sessionLimits=[10,20,50,100,0];
export const dailyLimits=[0,5,10,20,50];
export function reviewPlan(dueIds:string[],learnedIds:string[],dailyLimit:number,newToday:number,sessionLimit:number,deck='',cards:DemoCard[]=demoCards){
 let allowance=dailyLimit===0?Infinity:Math.max(0,dailyLimit-newToday);
 const eligible=cards.filter(c=>dueIds.includes(c.id)&&(!deck||c.deck===deck)).filter(c=>!c.isNew||learnedIds.includes(c.id)||allowance-->0);
 return {eligible,session:sessionLimit===0?eligible:eligible.slice(0,sessionLimit)};
}
