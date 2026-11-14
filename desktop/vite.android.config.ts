import { defineConfig, mergeConfig } from "vite";
import baseConfig from "./vite.config";

export default defineConfig(async env => mergeConfig(await baseConfig(env), {
  server: {
    host: "127.0.0.1",
    port: 1422,
    strictPort: true,
    hmr: { protocol: "ws", host: "127.0.0.1", port: 1422 },
  },
}));
