import { defineConfig } from "vite";

const backend = process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:7878";

export default defineConfig({
  build: {
    target: "esnext",
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": backend,
      "/map-work": backend,
      "/obj-worker.js": backend,
    },
  },
});
