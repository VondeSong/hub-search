import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {FolderOpen} from 'lucide-react';
import {LibraryAddActions} from './LibraryAddActions';
import type {LibraryAddOptions} from './LibraryManagement';

type Inventory={path:string;supported:number;ignored:number;recursive:boolean;libraryId:string};
export function LocalFilesConnectionSection({blocked=false}:{blocked?:boolean}){
  const [enabled,setEnabled]=useState(false),[name,setName]=useState(''),[path,setPath]=useState(''),[recursive,setRecursive]=useState(true);
  const [inventory,setInventory]=useState<Inventory|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const revision=useRef(0);
  useEffect(()=>{let active=true;void invoke<{enabled:boolean}>('local_file_sources',{args:{action:'capabilities'}}).then(v=>{if(active)setEnabled(v.enabled);}).catch(()=>{});return()=>{active=false;revision.current++;};},[]);
  function changed(){revision.current++;setInventory(null);setError('');setMessage('');}
  async function run(action:'inspect'|'add',options?:LibraryAddOptions){
    const version=++revision.current;setBusy(true);setError('');setMessage('');
    try{const value=await invoke<Inventory>('local_file_sources',{args:{action,path,name,recursive,startNow:options?.startNow??false}});if(version!==revision.current)return;
      if(action==='inspect')setInventory(value);else{setInventory(null);setMessage(options?.startNow?'文件夹已接入，后台开始提取正文。可在资料库查看处理结果。':'文件夹已接入并暂停。可在资料库继续处理。');}
    }catch(reason){if(version===revision.current)setError(String(reason));}finally{if(version===revision.current)setBusy(false);}
  }
  if(!enabled)return null;
  return <details className="provider-connection-card" name="settings-library-connections" data-provider="files"><summary><span className="library-icon files"><FolderOpen size={19}/></span><span className="provider-connection-heading"><strong>本地文件夹</strong><small>实验功能 · TXT、DOCX 只读检索</small></span><span className="provider-connection-action">添加资料库</span></summary><div className="provider-connection-body">
    <label className="url-field"><span>资料库名称</span><input value={name} maxLength={80} disabled={busy} onChange={e=>{changed();setName(e.target.value);}}/></label>
    <label className="url-field"><span>文件夹完整路径</span><input value={path} disabled={busy} spellCheck={false} onChange={e=>{changed();setPath(e.target.value);}}/></label>
    <label className="local-files-recursive"><input type="checkbox" checked={recursive} disabled={busy} onChange={e=>{changed();setRecursive(e.target.checked);}}/>包含子文件夹</label>
    {!inventory?<button className="connect-button" disabled={busy||blocked||!path.trim()||!name.trim()} onClick={()=>void run('inspect')}>{busy?'正在读取目录…':'检查接入范围'}</button>:<><div className="security-note" role="status">{inventory.path}<br/>{inventory.recursive?'包含子文件夹':'仅此文件夹'} · {inventory.supported} 个TXT／DOCX文件，{inventory.ignored} 项其他格式或链接未收录。尚未提取正文。</div><LibraryAddActions busy={busy||blocked||inventory.supported===0} onAdd={options=>run('add',options)}/><button disabled={busy} onClick={()=>{changed();}}>返回修改</button></>}
    {error&&<div className="connection-error" role="alert">{error}</div>}{message&&<div className="security-note" role="status">{message}</div>}
    <div className="security-note">只读保存原件缓存并提取正文，不修改或移动文件。暂不接入PDF、PPTX、XLSX或HTML；DOCX复杂布局请打开原文件。与已有Obsidian或本地资料库重叠的目录会被阻止。首次扫描最多1万项；文件变化后使用资料库的更新操作重新检查。</div>
  </div></details>;
}
