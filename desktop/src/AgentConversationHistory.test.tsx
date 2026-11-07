// @vitest-environment jsdom
import {act,useState} from 'react';import {createRoot} from 'react-dom/client';import {expect,it,vi} from 'vitest';
import {AgentConversationHistory} from './AgentConversationHistory';
it('shows four recent conversations and navigates to a separate history page without fetching or losing focus',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement('div'),root=createRoot(host),load=vi.fn();document.body.append(host);
 const works=Array.from({length:6},(_,i)=>({id:String(i),goal:`对话 ${i}`,state:'completed',pinned:i===5}));
 function History(){const [expanded,setExpanded]=useState(false),[items,setItems]=useState(works);return <AgentConversationHistory works={items} expanded={expanded} onExpand={()=>setExpanded(true)} onBack={()=>setExpanded(false)} disabled={false} more loading={false} error="" states={{}} onOpen={()=>{}} onChange={async(work,change)=>setItems(items=>items.map(item=>item.id===work.id?{...item,...change}:item))} onMore={load} onClose={()=>{}}/>;}
 try{
  await act(async()=>root.render(<History/>));expect(host.querySelectorAll('.agent-history-row')).toHaveLength(4);expect(host.querySelector('.agent-history-title')?.textContent).toBe('对话 5');
  await act(async()=>host.querySelector<HTMLButtonElement>('.agent-history-more')!.click());expect(host.querySelectorAll('.agent-history-row')).toHaveLength(6);expect(load).not.toHaveBeenCalled();
  expect(document.activeElement?.getAttribute('aria-label')).toBe('返回对话菜单');expect(host.querySelector('.agent-history-heading')?.textContent).toBe('全部对话');
  await act(async()=>host.querySelector<HTMLButtonElement>('.agent-history-more')!.click());expect(load).toHaveBeenCalledOnce();
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="返回对话菜单"]')!.click());expect(host.querySelectorAll('.agent-history-row')).toHaveLength(4);expect(document.activeElement).toBe(host.querySelector('.agent-history-more'));
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="取消置顶 对话 5"]')!.click());await act(async()=>{await new Promise(r=>setTimeout(r,10));});
  expect([...host.querySelectorAll('.agent-history-title')].map(item=>item.textContent)).not.toContain('对话 5');expect(document.activeElement).toBe(host.querySelector('.agent-history-more'));
 }finally{await act(async()=>root.unmount());host.remove();}
});
it('pins explicitly and deletes immediately with undo instead of confirmation',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement('div'),root=createRoot(host),change=vi.fn(async()=>{}),open=vi.fn();document.body.append(host);
 const work={id:'a',goal:'一段很长的历史标题'.repeat(8),state:'completed',pinned:false};
 try{await act(async()=>root.render(<AgentConversationHistory expanded={false} onExpand={()=>{}} onBack={()=>{}} works={[work]} disabled={false} more={false} loading={false} error="" states={{}} onChange={change} onOpen={open} onMore={()=>{}} onClose={()=>{}}/>));
  const click=async(label:string)=>act(async()=>host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  await click(`置顶对话 ${work.goal}`);expect(change).toHaveBeenCalledWith(work,{pinned:true});expect(open).not.toHaveBeenCalled();
  await act(async()=>{await new Promise(r=>setTimeout(r,10));});expect(document.activeElement?.getAttribute('title')).toBe('置顶');
  await click(`删除对话 ${work.goal}`);expect(change).toHaveBeenCalledTimes(2);
  expect(change).toHaveBeenLastCalledWith(work,{deleted:true});expect(host.textContent).not.toContain('确认删除');
  await act(async()=>{await new Promise(r=>setTimeout(r,10));});expect(document.activeElement?.textContent).toBe('撤销');
  await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='撤销')!.click());expect(change).toHaveBeenLastCalledWith(work,{deleted:false});
  expect(host.querySelector('.agent-history-undo')).toBeNull();
  await act(async()=>{await new Promise(r=>setTimeout(r,10));});expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭对话详情');
  expect(host.querySelector('.agent-history-title strong')).toBeNull();
 }finally{await act(async()=>root.unmount());host.remove();}
});
it('distinguishes loading, empty history, and a retryable read failure',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement('div'),root=createRoot(host),retry=vi.fn();
 const props={expanded:false,onExpand:()=>{},onBack:()=>{},works:[],disabled:false,more:false,error:'',states:{},onChange:async()=>{},onOpen:()=>{},onMore:()=>{},onClose:()=>{},onRetry:retry};
 try{
  await act(async()=>root.render(<AgentConversationHistory {...props} loading/>));
  expect(host.textContent).toContain('正在读取历史对话');expect(host.textContent).not.toContain('还没有历史对话');
  await act(async()=>root.render(<AgentConversationHistory {...props} loading={false}/>));expect(host.textContent).toContain('还没有历史对话');
  await act(async()=>root.render(<AgentConversationHistory {...props} loading={false} error="读取失败"/>));expect(host.textContent).not.toContain('还没有历史对话');
  await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='重新读取历史')!.click());expect(retry).toHaveBeenCalledOnce();
 }finally{await act(async()=>root.unmount());}
});
it('does not offer undo when deletion fails and reports the failure without opening the chat',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement('div'),root=createRoot(host),open=vi.fn();
 const work={id:'a',goal:'保留这段对话',state:'completed'};
 try{await act(async()=>root.render(<AgentConversationHistory expanded={false} onExpand={()=>{}} onBack={()=>{}} works={[work]} disabled={false} more={false} loading={false} error="" states={{}} onChange={async()=>{throw Error('保存失败');}} onOpen={open} onMore={()=>{}} onClose={()=>{}}/>));
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="删除对话 保留这段对话"]')!.click());
  expect(host.textContent).toContain('保存失败');expect(host.querySelector('.agent-history-undo')).toBeNull();expect(open).not.toHaveBeenCalled();
 }finally{await act(async()=>root.unmount());}
});
it('supports successive deletions and undo in reverse order',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement('div'),root=createRoot(host),change=vi.fn(async()=>{});
 const works=[{id:'a',goal:'对话 A',state:'completed'},{id:'b',goal:'对话 B',state:'completed'}];
 try{await act(async()=>root.render(<AgentConversationHistory expanded={false} onExpand={()=>{}} onBack={()=>{}} works={works} disabled={false} more={false} loading={false} error="" states={{}} onChange={change} onOpen={()=>{}} onMore={()=>{}} onClose={()=>{}}/>));
  for(const work of works)await act(async()=>host.querySelector<HTMLButtonElement>(`[aria-label="删除对话 ${work.goal}"]`)!.click());
  expect(host.textContent).toContain('已删除 2 段对话');
  await act(async()=>host.querySelector<HTMLButtonElement>('.agent-history-undo button')!.click());expect(change).toHaveBeenLastCalledWith(works[1],{deleted:false});
  await act(async()=>host.querySelector<HTMLButtonElement>('.agent-history-undo button')!.click());expect(change).toHaveBeenLastCalledWith(works[0],{deleted:false});
  expect(host.querySelector('.agent-history-undo')).toBeNull();
 }finally{await act(async()=>root.unmount());}
});
