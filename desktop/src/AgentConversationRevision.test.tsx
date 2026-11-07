// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {AgentConversation,type Conversation} from "./AgentDelivery";
import fixture from "./AgentConversationRevision.fixture";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
let host:HTMLDivElement,root:Root;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();Reflect.deleteProperty(navigator,'clipboard');});
async function render(conversation:Conversation){await act(async()=>root.render(<AgentConversation conversation={conversation} revoked={false} onOpenCitation={()=>{}}/>));}
it('keeps all three synthetic plain-text answers readable after follow-up changes',async()=>{
 await render(fixture as Conversation);
 expect(host.querySelectorAll('.agent-answer')).toHaveLength(3);
 expect(host.querySelector('details.agent-history')).toBeNull();
 expect(Array.from(host.querySelectorAll('.agent-note')).filter(n=>n.textContent==='此前回答')).toHaveLength(2);
 expect(host.textContent).not.toContain('后续条件已更新');
 expect(host.querySelectorAll('.agent-note[title]')).toHaveLength(0);
 expect(host.textContent).not.toContain('新增或纠正的要求需要重新核对');
 expect(host.textContent).toContain('目前没有合适方案');
 expect(host.textContent).toContain('本轮新增');
});
it('does not expose unavailable source answers or unwrap chart-dependent history',async()=>{
 const conversation=structuredClone(fixture) as Conversation;
 const answers=conversation.messages.filter(m=>m.role==='assistant');
 answers[0].artifactState='unavailable';answers[0].validity='来源授权已撤回，历史正文已隐藏';
 answers[1].artifactRefs=[{artifactId:'chart',revision:1,currentRevision:2,contentHash:'old',datasetRevision:'1'}];
 await render(conversation);
 const sections=host.querySelectorAll('.agent-message-assistant');
 expect(sections[0].querySelector('.agent-answer')).toBeNull();
 expect(sections[0].textContent).toContain('来源授权已撤回');
 expect(sections[1].querySelector('details.agent-history')?.hasAttribute('open')).toBe(false);
 expect(sections[1].textContent).toContain('新增或纠正的要求需要重新核对');
});
it('retains the conservative display for other stale reasons',async()=>{
 const conversation=structuredClone(fixture) as Conversation;
 conversation.messages.filter(m=>m.role==='assistant')[0].validity='原文已更新，旧结论需要重新核对';
 await render(conversation);
 const first=host.querySelector('.agent-message-assistant')!;
 expect(first.querySelector('details.agent-history')?.hasAttribute('open')).toBe(false);
 expect(first.textContent).toContain('原文已更新');
});
it('copies the actual answer and citation text, and reports clipboard failures',async()=>{
 const writeText=vi.fn().mockResolvedValue(undefined);
 Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
 const conversation=structuredClone(fixture) as Conversation;
 const last=conversation.messages[conversation.messages.length-1];
 last.report!.prose!.citations=[{evidenceId:'e1',quote:'质保3年'}];
 last.evidence=[{title:'合成报价',sourcePath:'报价.md',content:'质保3年',startChar:0,endChar:4,totalChars:4,truncated:false}];
 await render(conversation);
 const buttons=host.querySelectorAll<HTMLButtonElement>('[aria-label="复制回答"]');
 expect(buttons).toHaveLength(3);
 await act(async()=>buttons[2].click());
 expect(writeText).toHaveBeenCalledWith(expect.stringContaining('来源：\n[1] 合成报价（报价.md）：质保3年'));
 expect(writeText).toHaveBeenCalledWith(expect.stringContaining(last.report!.prose!.markdown));
 expect(buttons[2].getAttribute('aria-label')).toBe('已复制回答');
 writeText.mockRejectedValueOnce(new Error('blocked'));
 await act(async()=>buttons[0].click());
 expect(host.textContent).toContain('复制失败，请重试或选择正文复制。');
});
it('shows the saved user-message time and copies only the original message text',async()=>{
 const writeText=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
 const text='原始问题\n  保留换行与空格。';const sent=new Date('2026-11-05T23:33:00+08:00');
 await render({hasEarlier:false,messages:[{id:'user-1',role:'user',text,createdAt:sent.getTime()}]});
 const message=host.querySelector('.agent-message-user')!;const time=message.querySelector('time')!;
 expect(time.dateTime).toBe(sent.toISOString());expect(time.textContent).toBe(sent.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}));
 expect(time.title).toContain('2026');expect(message.querySelector('.agent-user-message-content p')?.textContent).toBe(text);
 const copy=message.querySelector<HTMLButtonElement>('[aria-label="复制消息"]')!;await act(async()=>copy.click());
 expect(writeText).toHaveBeenCalledExactlyOnceWith(text);expect(copy.getAttribute('aria-label')).toBe('已复制消息');expect(message.querySelector('[role="status"]')?.textContent).toBe('已复制');
});
it.each([0,-1,NaN,Infinity,9e20])('does not invent an unknown or invalid user-message time (%s)',async createdAt=>{
 await render({hasEarlier:false,messages:[{id:'legacy-user',role:'user',text:'旧消息',createdAt}]});
 expect(host.querySelector('.agent-message-user time')).toBeNull();expect(host.querySelector('[aria-label="复制消息"]')).not.toBeNull();
});
it('reports user-message clipboard failure and allows retry without copying metadata',async()=>{
 const writeText=vi.fn().mockRejectedValueOnce(Error('blocked')).mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
 await render({hasEarlier:false,messages:[{id:'decision',role:'user',kind:'decision',text:'确认使用此方案',createdAt:Date.now()}]});
 const copy=host.querySelector<HTMLButtonElement>('[aria-label="复制消息"]')!;await act(async()=>copy.click());
 expect(host.textContent).toContain('复制失败，请重试或选择正文复制。');await act(async()=>copy.click());
 expect(writeText).toHaveBeenLastCalledWith('确认使用此方案');expect(host.textContent).not.toContain('复制失败');
});
