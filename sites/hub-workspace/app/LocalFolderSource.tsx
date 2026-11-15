"use client";
import {useEffect,useRef,useState} from 'react';
import {FolderOpen} from 'lucide-react';

type FolderDraft={name:string;path:string;recursive:boolean};
const key='hub-local-folder-draft-v1';
const empty:FolderDraft={name:'',path:'',recursive:true};
export default function LocalFolderSource(){
  const [draft,setDraft]=useState<FolderDraft>(empty),[saved,setSaved]=useState<FolderDraft|null>(null);
  const [review,setReview]=useState(false),[editing,setEditing]=useState(false),[ready,setReady]=useState(false),[message,setMessage]=useState('');
  const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{try{const value=JSON.parse(localStorage.getItem(key)||'null');if(value&&typeof value.name==='string'&&typeof value.path==='string'&&typeof value.recursive==='boolean'){setDraft(value);setSaved(value);}}catch{setMessage('接入草稿暂时无法读取，可以重新填写。');}setReady(true);},[]);
  const absolute=/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/[^/])/i.test(draft.path.trim());
  function save(){try{const value={...draft,name:draft.name.trim(),path:draft.path.trim()};localStorage.setItem(key,JSON.stringify(value));setDraft(value);setSaved(value);setEditing(false);setReview(false);setMessage('接入草稿已保存在本浏览器，尚未读取文件。');}catch{setMessage('浏览器无法保存草稿。请允许本站保存数据后重试。');}}
  function remove(){try{localStorage.removeItem(key);setSaved(null);setDraft(empty);setReview(false);setEditing(false);setMessage('已移除接入草稿，电脑上的文件未改动。');}catch{setMessage('草稿未能移除，请允许本站保存数据后重试。');}}
  return <section className="lf-source" aria-label="本地文件夹接入">
    <div className="lf-heading"><FolderOpen size={18}/><div><h3 ref={heading} tabIndex={-1}>本地文件夹</h3><p>只读收录文件，不移动或修改原件。</p></div><span className="cs-tag">尚未接入</span></div>
    <p className="lf-note">此网页用于确认接入流程，无法读取电脑目录。真实接入将在桌面端完成；这里不显示虚构的文件数或导入结果。</p>
    {saved&&!editing?<><dl className="lf-summary"><div><dt>接入草稿</dt><dd>{saved.name}</dd></div><div><dt>文件夹</dt><dd>{saved.path}</dd></div><div><dt>扫描范围</dt><dd>{saved.recursive?'包含子文件夹':'仅此文件夹'}</dd></div></dl><div className="lf-actions"><button className="cs-secondary" onClick={()=>{setDraft(saved);setEditing(true);setMessage('');}}>编辑草稿</button><button className="cs-link" onClick={remove}>移除草稿</button></div></>:<form className="cs-connect-form" onSubmit={e=>{e.preventDefault();if(review)save();else{setReview(true);setMessage('');requestAnimationFrame(()=>heading.current?.focus());}}}>
      {!review?<><label>资料库名称<input required maxLength={80} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})} autoComplete="off"/></label><label>文件夹完整路径<input required value={draft.path} onChange={e=>setDraft({...draft,path:e.target.value})} aria-describedby="lf-path-help" autoComplete="off" spellCheck={false}/></label><p id="lf-path-help">在电脑上复制完整路径。避免选择已接入的 Obsidian 资料库或其子目录。</p><label className="cs-check"><input type="checkbox" checked={draft.recursive} onChange={e=>setDraft({...draft,recursive:e.target.checked})}/>包含子文件夹</label></>:<><h4>确认读取范围</h4><dl className="lf-summary"><div><dt>资料库</dt><dd>{draft.name.trim()}</dd></div><div><dt>文件夹</dt><dd>{draft.path.trim()}</dd></div><div><dt>范围</dt><dd>{draft.recursive?'包含子文件夹':'仅此文件夹'}</dd></div></dl><p>首批正文格式：TXT、DOCX。PDF 沿用现有预览能力；PPTX、XLSX、HTML 的正文提取尚待接入。</p><p>桌面端需先检查目录访问权限、重复来源与可读取文件。单个文件解析失败应单独显示原因，保留原件和其他文件的结果。</p></>}
      <div className="cs-form-actions">{(review||editing)&&<button type="button" className="cs-secondary" onClick={()=>{if(review)setReview(false);else{setEditing(false);if(saved)setDraft(saved);}setMessage('');}}>{review?'返回修改':'取消'}</button>}<button className="cs-primary" disabled={!ready||!draft.name.trim()||!absolute} type="submit">{review?'保存接入草稿':'确认接入范围'}</button></div>
    </form>}
    {message&&<p className="lf-note" role="status">{message}</p>}
  </section>;
}
