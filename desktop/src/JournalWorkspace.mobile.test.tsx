// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect,it,vi} from "vitest";
import {JournalWorkspace} from "./JournalWorkspace";
import {JournalViewsContext,useJournalViewStore} from "./JournalViews";
vi.mock("./RuntimePlatform",()=>({runtimeCapabilities:{mobile:true,platform:"android"}}));
vi.mock("./useJournalPage",()=>({useJournalPage:()=>({items:[],total:0,days:0,libraries:0,loading:false,error:""})}));
vi.mock("@tauri-apps/api/core",()=>({invoke:async(cmd:string)=>{
 if(cmd==="get_quick_journal_settings")return{settings:{libraryId:"",folder:"Journals",sync:false},mobile:true};
 if(cmd==="list_quick_journal")return{items:[{record:{version:1,id:"a".repeat(32),date:"2026-11-12",text:"手机上的独立记录",attachments:[]},body:"手机上的独立记录",uploaded:false,applied:false,libraryId:"",path:""}],error:""};
 throw new Error(cmd);
}}));
it("opens one mobile record feed without desktop month controls or a second journal heading",async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
 function Fixture(){const store=useJournalViewStore();return <JournalViewsContext.Provider value={store}><JournalWorkspace libraries={[]} scope={null} dataVersion="1" selectedDate="" onPreview={vi.fn()} onOpen={vi.fn()} renderIcon={()=>null}/></JournalViewsContext.Provider>;}
 try{await act(async()=>root.render(<Fixture/>));expect(host.querySelectorAll("h1")).toHaveLength(1);expect(host.querySelector("h1")?.textContent).toBe("日志");expect(host.querySelector('[aria-label="日志上个月"]')).toBeNull();expect(host.querySelector(".journal-db-toolbar")).toBeNull();expect(host.querySelectorAll("article")).toHaveLength(1);expect(host.textContent).toContain("手机上的独立记录");}
 finally{await act(async()=>root.unmount());host.remove();delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;}
});
