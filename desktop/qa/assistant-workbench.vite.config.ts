import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
export default defineConfig({root:fileURLToPath(new URL("..",import.meta.url)),plugins:[react()],optimizeDeps:{entries:["qa/assistant-workbench.html"]},server:{host:"127.0.0.1",port:1427,strictPort:true,watch:{ignored:["**/src-tauri/**","**/artifacts/**","**/task-state/**","**/.local/**"]}}});
