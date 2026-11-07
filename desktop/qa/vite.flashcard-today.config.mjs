import react from "@vitejs/plugin-react";
export default {
  plugins: [react()],
  server: { host: "127.0.0.1", port: 1428, strictPort: true,
    watch: { ignored: ["**/artifacts/**", "**/task-state/**", "**/src-tauri/**", "**/dist/**"] } },
};
