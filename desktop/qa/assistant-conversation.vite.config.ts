import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
const root=fileURLToPath(new URL(".",import.meta.url));
export default defineConfig({root,plugins:[react()],optimizeDeps:{entries:["assistant-conversation.html"]},server:{host:"127.0.0.1",port:1426,strictPort:true,fs:{allow:[fileURLToPath(new URL("..",import.meta.url))]},watch:{ignored:["**/memory-selection/**","**/src-tauri/**","**/artifacts/**","**/task-state/**","**/.local/**"]}}});
