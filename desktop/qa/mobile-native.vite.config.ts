import { defineConfig } from "vite";
import appConfig from "../vite.config";
export default defineConfig(async env=>{
 const config=await appConfig(env);
 return {...config,server:{...config.server,host:"localhost",port:1426,watch:{ignored:["**/src-tauri/**","**/node_modules/**"]}}};
});
