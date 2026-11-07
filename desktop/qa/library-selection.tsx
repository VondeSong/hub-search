import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceRail } from "../src/WorkspaceRail";
import { WorkspaceChrome } from "../src/WorkspaceChrome";
import { useSidebarLayout } from "../src/useSidebarLayout";
import { PanelRight } from "lucide-react";
import { SettingsDialog } from "../src/SettingsDialog";
import type { LibrarySummary } from "../src/SearchTypes";
import "../src/App.css";
import "../src/WorkspaceRefresh.css";
import "../src/SearchToolbar.css";
const spaces: LibrarySummary[] = [
  {id:"car",name:"Car",provider:"craft",connected:true,documentCount:75,excludedPaths:[]},
  {id:"main",name:"Main",provider:"obsidian",connected:true,documentCount:1343,excludedPaths:[]},
  {id:"tasks",name:"滴答清单",provider:"dida365",connected:true,documentCount:396,excludedPaths:[]},
];
const noop=()=>{};
function QA(){
  const layout=useSidebarLayout("home");
  const [preview,setPreview]=useState(false);
  const [settings,setSettings]=useState(false);
  const [selected,setSelected]=useState<string[]|null>(null);
  const toggle=(id:string)=>setSelected(current=>{
    const ids=current??spaces.map(s=>s.id);
    const next=ids.includes(id)?ids.filter(item=>item!==id):[...ids,id];
    return next.length===spaces.length?null:next;
  });
  return <div style={{display:"grid",gridTemplateColumns:"56px minmax(0,1fr)",height:"100vh"}}>
    <WorkspaceRail onTogglePanel={layout.togglePanel} panelExpanded={layout.panelExpanded} activeView="home" spaces={spaces} selectedLibraryIds={selected} renderLibraryIcon={space=><span style={{fontSize:20}}>{space.id==="car"?"🚕":space.id==="main"?"📓":"✅"}</span>}
      favoriteCount={3} taskOpenCount={12} journalCount={326} historyCount={100} tagCount={353} flashcardDueCount={745}
      onSelectView={noop} onSelectAllLibraries={()=>setSelected(null)} onSelectLibrary={id=>setSelected([id])} onToggleLibrary={toggle} onManageLibraries={()=>setSettings(true)}/>
    <main><WorkspaceChrome mode={layout.mode} onModeChange={layout.changeMode} actions={<button aria-label="显示预览窗格" aria-pressed={preview} onClick={()=>setPreview(!preview)}><PanelRight size={17}/></button>} view="home" spaces={spaces} selectedLibraryIds={selected} onToggleLibrary={toggle} onSelectAll={()=>setSelected(null)} onManage={noop}/>
      <div style={{padding:24}}><h2>搜索资料库</h2><p role="status">当前范围：{selected===null?"全部资料库":spaces.filter(s=>selected.includes(s.id)).map(s=>s.name).join("、")||"未选择资料库"}</p></div>
    </main>
    {settings && <SettingsDialog canClose category="libraries" onCategoryChange={noop} onClose={()=>setSettings(false)}><p>资料库设置验证</p>{Array.from({length:40},(_,i)=><p key={i}>示例资料库 {i+1}</p>)}</SettingsDialog>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<QA/>);
