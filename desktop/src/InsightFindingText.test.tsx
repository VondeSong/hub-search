// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {findingSections,InsightFindingText} from "./InsightFindingText";
import {InsightInlineHistory} from "./InsightInlineHistory";
import type {Insight} from "./InsightTypes";
const {invoke}=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke}));
it('separates only explicitly supplied conditions and keeps legacy prose and code intact',()=>{
 const raw='旧内容\n```md\n## 适用条件\n代码里的标题\n```';expect(findingSections(raw).body).toBe(raw);expect(findingSections(raw).conditions).toBe('');
 const parts=findingSections('## 发现\n先验证。\n## 为什么现在有关\n输入相同。\n## 适用条件\n只适用样图。\n## 限制与未知\n批量未验证。\n## 核对说明\n仍需验证。');
 expect(parts).toEqual({body:'先验证。',why:'输入相同。',conditions:'只适用样图。',limits:'批量未验证。',comparison:'仍需验证。'});
});
it('renders the original and new result together and never invents missing conditions',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 try{await act(async()=>root.render(<InsightFindingText text="新增观察。" previous="原判断。"/>));expect(host.querySelectorAll('.idd-compare-grid>section')).toHaveLength(2);expect(host.textContent).toContain('原判断。');expect(host.textContent).toContain('新增观察。');expect(host.querySelectorAll('dt')).toHaveLength(3);expect(host.textContent).toContain('未单列');}
 finally{await act(async()=>root.unmount());host.remove();}
});
it('reads inline history on demand, switches versions, and hides inaccessible history',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const item={id:'one',headRevision:2} as Insight;
 invoke.mockImplementation(async(_command,{args})=>({...item,contentRevision:args.revision??2,snapshot:args.revision===1?undefined:{text:'补充版。',sourceCitations:[],reviewOutcome:{kind:'revise',comparison:'新观察只改变了适用条件。',previousRevision:1}}}));
 try{
  await act(async()=>root.render(<InsightInlineHistory item={item} generation={1} onReadSource={vi.fn()}/>));expect(invoke).not.toHaveBeenCalled();
  await act(async()=>{const details=host.querySelector('details')!;details.open=true;details.dispatchEvent(new Event('toggle'));});
  expect(host.textContent).toContain('补充版。');expect(host.textContent).toContain('新观察只改变了适用条件。');expect(host.querySelectorAll('option')).toHaveLength(2);
  await act(async()=>{const select=host.querySelector('select')!;select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(host.textContent).toContain('当前不可访问');expect(host.textContent).not.toContain('补充版。');expect(invoke.mock.calls.every(([,v])=>v.args.action==='insightDetail')).toBe(true);
 }finally{await act(async()=>root.unmount());host.remove();invoke.mockClear();}
});

it('discards an old history response after the current scope is rechecked',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const item={id:'one',headRevision:2} as Insight;
 const pending:((v:unknown)=>void)[]=[];invoke.mockImplementation(()=>new Promise(resolve=>pending.push(resolve)));
 try{
  await act(async()=>root.render(<InsightInlineHistory item={item} generation={1} onReadSource={vi.fn()}/>));
  await act(async()=>{const details=host.querySelector('details')!;details.open=true;details.dispatchEvent(new Event('toggle'));});
  const older=[...pending];pending.length=0;
  await act(async()=>root.render(<InsightInlineHistory item={item} generation={2} onReadSource={vi.fn()}/>));
  await act(async()=>{for(const resolve of older)resolve({...item,snapshot:{text:'过期历史',sourceCitations:[]}});});
  expect(host.textContent).not.toContain('过期历史');
  await act(async()=>{for(const resolve of pending)resolve({...item});});
  expect(host.textContent).toContain('当前不可访问');
 }finally{await act(async()=>root.unmount());host.remove();invoke.mockClear();}
});
