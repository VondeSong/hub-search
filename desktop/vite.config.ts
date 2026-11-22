import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom", "lucide-react"] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // Archived acceptance fixtures are not application entry points.
  optimizeDeps: { entries: ["index.html"] },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // The shell and lazy screens share one runtime owner. Keeping React,
          // its DOM renderer and their common dependencies together avoids
          // splitting CommonJS initialization across application chunks.
          "react-runtime": ["react", "react-dom", "react-dom/client"],
          // Markdown shares React with the shell. Let the route graph split its
          // parser dependencies so they stay behind the lazy preview boundary.
          "yaml-vendor": ["yaml"],
        },
      },
    },
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    // The desktop development-only launcher consumes the workbench's shared demo source.
    fs: { allow: [
      ".",
      "../sites/hub-workspace/app/agents",
      "../sites/hub-workspace/app/AssistantAnswerActions.tsx",
      "../sites/hub-workspace/app/AssistantAnswerContent.tsx",
      "../sites/hub-workspace/app/AssistantProcess.tsx",
      "../sites/hub-workspace/app/insight-migration.ts",
      "../sites/hub-workspace/public/agent-icons",
      "../sites/hub-workspace/public/hub-workspace-preview.jpg",
    ] },
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/artifacts/**", "**/.local/**"],
    },
  },
}));
