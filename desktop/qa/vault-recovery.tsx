import { createRoot } from "react-dom/client";
import "../src/App.css";
import "../src/WorkspaceRefresh.css";
import "../src/InterfaceSelection.css";
import "../src/LiquidWorkspace.css";
import "../src/DisplayPreferences.css";
import { CollectionsWorkspace } from "../src/CollectionsWorkspace";
import { CollectionViewsProvider } from "../src/CollectionViews";

// Isolated UI fixture: every IPC is handled here, with no personal data access.
const storage={config:{mode:"obsidian",vaultPath:"D:/Obsidian/ZhiHu",downloadMedia:true,autoSyncMinutes:30},running:false,status:"",vaultRelocation:{rootExists:false,candidates:[{path:"D:/Obsidian/Sources",name:"Sources"}]}};
const fixture={calls:[] as {command:string;args:unknown}[],unknown:[] as string[],async invoke(command:string,args:Record<string,unknown>={}){
  fixture.calls.push({command,args});
  if(command==="get_window_visibility")return {revision:"1",visible:true,minimized:false,foreground:true};
  if(command.startsWith("plugin:event|"))return 0;
  if(command==="list_collection_items")return {items:[],total:0,unread:0,matched:0,connected:false,running:false,canResume:false,status:"",sources:[]};
  if(command==="get_collection_storage")return structuredClone(storage);
  if(command==="list_libraries"||command==="collection_library_operations")return [];
  if(command==="plugin:dialog|open")return "D:/Obsidian/Sources";
  if(command==="relocate_collection_vault"){
    if(args.expectedVaultPath!==storage.config.vaultPath)throw new Error("原库位置已改变");
    storage.config.vaultPath=String(args.path);storage.vaultRelocation={rootExists:true,candidates:[]};
    return {location:storage.config.vaultPath,warning:null};
  }
  if(command==="save_collection_storage")return "设置已保存";
  fixture.unknown.push(command);throw new Error(`未定义的隔离请求：${command}`);
}};
Object.assign(window,{__VAULT_RECOVERY_FIXTURE__:fixture,__TAURI_INTERNALS__:{invoke:fixture.invoke,convertFileSrc:(path:string)=>path,transformCallback:()=>0,unregisterCallback:()=>{}}});
document.body.style.margin="0";document.getElementById("root")!.style.height="100dvh";
createRoot(document.getElementById("root")!).render(<CollectionViewsProvider><CollectionsWorkspace/></CollectionViewsProvider>);
