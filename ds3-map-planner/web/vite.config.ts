import { defineConfig } from "vite";
import { resolve } from "node:path";

const backend = process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:7878";

export default defineConfig({
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        filters: resolve(__dirname, "filters.html"),
        regions: resolve(__dirname, "regions.html"),
      },
    },
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
