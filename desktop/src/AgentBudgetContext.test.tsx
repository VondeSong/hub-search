// @vitest-environment jsdom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {AgentProviderBudget,type ProviderBudget} from './AgentProviderBudget';
import {AgentNativeContext,type NativeContext} from './AgentNativeContext';
let host:HTMLDivElement,root:Root;
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
const tokens=(n:number)=>({inputTokens:n,uncachedInputTokens:n,outputTokens:n/10});
const button=()=>host.querySelector<HTMLButtonElement>('button')!;
const confirm=async()=>{await act(async()=>host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());};
const input=async(value:string)=>{await act(async()=>{const e=host.querySelector<HTMLInputElement>('input[type="number"]')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(e,value);e.dispatchEvent(new Event('input',{bubbles:true}));});};
it('CN06 freeze explicitly reserves unknown old runs and does not save on mount',async()=>{
 const save=vi.fn(async()=>{});const value:ProviderBudget={state:'unconfigured',legacy:{measured:tokens(40),unknownRuns:[{runId:'old',minimum:tokens(200000)}]}};
 await act(async()=>root.render(<AgentProviderBudget value={value} disabled={false} onSave={save}/>));
 expect(save).not.toHaveBeenCalled();expect(button().disabled).toBe(true);expect(host.textContent).toContain('不是按零计算');await confirm();await act(async()=>button().click());
 expect(save).toHaveBeenCalledWith({action:'freezeProviderBudget',limits:{inputTokens:600000,uncachedInputTokens:600000,outputTokens:48000},perRun:{inputTokens:150000,uncachedInputTokens:150000,outputTokens:12000},unknownReservations:{old:tokens(200000)}});
});
it('CN06 extension retains consumption, per-run values and identity across a failed retry',async()=>{
 const save=vi.fn().mockRejectedValueOnce(Error('授权已变化')).mockResolvedValue(undefined);const value:ProviderBudget={state:'exhausted',limits:tokens(1000),perRun:tokens(100),chargedOrReserved:tokens(900),unmeasuredRunIds:['old']};
 await act(async()=>root.render(<AgentProviderBudget value={value} disabled={false} onSave={save}/>));await input('2000');await confirm();await act(async()=>button().click());expect(host.textContent).toContain('授权已变化');expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe('2000');await act(async()=>button().click());
 expect(save.mock.calls[0][0]).toEqual(save.mock.calls[1][0]);expect(save.mock.calls[0][0]).toMatchObject({action:'extendProviderBudget',expectedLimits:tokens(1000),limits:{...tokens(1000),inputTokens:2000},operationId:expect.any(String)});expect(save.mock.calls[0][0]).not.toHaveProperty('perRun');expect(value.chargedOrReserved).toEqual(tokens(900));
});
it('CN06 active and invalid budgets cannot submit',async()=>{
 const save=vi.fn(async()=>{});const value:ProviderBudget={state:'unconfigured'};await act(async()=>root.render(<AgentProviderBudget value={value} disabled={true} onSave={save}/>));expect(host.querySelector('fieldset')!.disabled).toBe(true);await act(async()=>button().click());expect(save).not.toHaveBeenCalled();
 await act(async()=>root.render(<AgentProviderBudget value={value} disabled={false} onSave={save}/>));await input('-1');await confirm();expect(button().disabled).toBe(true);await act(async()=>button().click());expect(save).not.toHaveBeenCalled();
});
it('CN06 context distinguishes unknown, last usage, cumulative usage and post-compaction waiting',async()=>{
 const value:NativeContext={state:'reported',lastTokens:800,windowTokens:1000,threadTotalTokens:900000,usedPercent:80,nearLimit:true};await act(async()=>root.render(<AgentNativeContext value={value}/>));expect(host.querySelector('summary')!.textContent).toContain('80%');expect(host.textContent).toContain('900,000');expect(host.textContent).toContain('八成以上');
 await act(async()=>root.render(<AgentNativeContext value={{...value,state:'awaitingUsage',lastTokens:null,windowTokens:null,threadTotalTokens:null,usedPercent:null,nearLimit:null}}/>));expect(host.textContent).toContain('等待整理后的用量');expect(host.textContent).not.toContain('80%');expect(host.textContent).toContain('尚未报告');
 await act(async()=>root.render(<AgentNativeContext value={{...value,previousRevision:true}}/>));expect(host.querySelector('summary')!.textContent).toContain('上一版本记录');expect(host.textContent).not.toContain('八成以上');
});
