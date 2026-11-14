// @vitest-environment jsdom
import {act,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {CloudAnswerNote,CloudMaterialPicker} from './CloudAgentMaterials';
import {runtimeCapabilities} from './RuntimePlatform';
vi.mock('./RuntimePlatform',()=>({runtimeCapabilities:{mobile:false}}));
const invoke=vi.fn();vi.mock('@tauri-apps/api/core',()=>({invoke:(...args:unknown[])=>invoke(...args)}));
let host:HTMLDivElement,root:Root;
beforeEach(()=>{host=document.createElement('div');document.body.append(host);root=createRoot(host);invoke.mockReset();runtimeCapabilities.mobile=false;window.history.replaceState({hubMobileRoute:'agents',hubCloudAgentChat:true},'');});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function click(text:string){const button=[...host.querySelectorAll('button')].find(b=>b.textContent===text);expect(button,text).toBeTruthy();await act(async()=>button!.click());}
it('previews only the explicitly selected snapshot and requires confirmation before attaching it',async()=>{
 const confirm=vi.fn();const value={id:'source',title:'A saved note',source:'Library',text:'Exact source text',sha256:'snapshot-hash'};
 invoke.mockImplementation(async(_command,payload)=>payload.action.op==='materials'?{items:[{key:{kind:'document',id:'source',libraryId:'notes'},title:value.title,source:value.source,chars:17,preview:'Exact source'}],more:false}:value);
 await act(async()=>root.render(<CloudMaterialPicker onClose={()=>{}} onConfirm={confirm}/>));
 await act(async()=>{await new Promise(r=>setTimeout(r,250));});
 await act(async()=>host.querySelector<HTMLButtonElement>('.cloud-material-results button')!.click());
 expect(host.textContent).toContain('Exact source text');expect(confirm).not.toHaveBeenCalled();
 await click('使用本次正文');expect(confirm).toHaveBeenCalledWith(value);
 expect(invoke.mock.calls.every(c=>c[0]==='cloud_agents')).toBe(true);
});
it('requires save confirmation and distinguishes local, uploaded and OS receipts',async()=>{
 let saved=false,stage=0;const record={version:1,id:'f'.repeat(32),date:'2026-11-15',text:'Actual completed answer',attachments:[]};
 invoke.mockImplementation(async(command,payload)=>{
  if(command==='cloud_agents')return {record};
  if(command==='capture_quick_journal'){expect(payload.record).toEqual(record);saved=true;return {warning:null};}
  if(command==='sync_quick_journal'){stage++;return {};}
  if(command==='list_quick_journal')return {items:saved?[{record,uploaded:stage>=1,applied:stage>=2}]:[]};
  throw Error(command);
 });
 await act(async()=>root.render(<CloudAnswerNote thread="thread" turn="turn"/>));
 await click('保存为速记');await click('预览保存');expect(saved).toBe(false);expect(host.textContent).toContain(record.text);
 await click('确认保存速记');expect(host.textContent).toContain('已存本机');expect(host.textContent).not.toContain('OS 已确认写入');
 await click('同步并核对回执');expect(host.textContent).toContain('等待 OS 回执');
 await click('同步并核对回执');expect(host.textContent).toContain('OS 已确认写入');
 expect(invoke.mock.calls.filter(c=>c[0]==='capture_quick_journal')).toHaveLength(1);
});
it('Android Back dismisses the material dialog before the underlying conversation',async()=>{
 runtimeCapabilities.mobile=true;invoke.mockResolvedValue({items:[],more:false});
 function Screen(){const[open,setOpen]=useState(true);return open?<CloudMaterialPicker onClose={()=>setOpen(false)} onConfirm={()=>{}}/>:<p>Conversation remains</p>;}
 const parent=vi.fn();window.addEventListener('popstate',parent);
 try{
  await act(async()=>root.render(<Screen/>));
  expect(window.history.state.hubCloudDialog).toBeTruthy();
  await act(async()=>{window.history.back();await new Promise(r=>setTimeout(r,30));});
  expect(host.textContent).toBe('Conversation remains');expect(parent).not.toHaveBeenCalled();
  expect(window.history.state).toEqual({hubMobileRoute:'agents',hubCloudAgentChat:true});
 }finally{window.removeEventListener('popstate',parent);}
});
it('Android Back cannot dismiss an in-flight save preview or leave its conversation',async()=>{
 runtimeCapabilities.mobile=true;let release!:(value:unknown)=>void;
 invoke.mockImplementation(()=>new Promise(r=>{release=r;}));
 await act(async()=>root.render(<CloudAnswerNote thread="thread" turn="turn"/>));
 await click('保存为速记');await click('预览保存');
 await act(async()=>{window.history.back();await new Promise(r=>setTimeout(r,30));});
 expect(host.querySelector('[role="dialog"]')).not.toBeNull();expect(window.history.state.hubCloudDialog).toBeTruthy();
 await act(async()=>{release({record:{version:1,id:'record',date:'2026-11-15',text:'answer',attachments:[]}});});
});
