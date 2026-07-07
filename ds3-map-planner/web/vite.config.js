import { defineConfig } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const backendOrigin =
  process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:7878";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  appType: "mpa",
  build: {
    rollupOptions: {
      input: {
        index: resolve(root, "index.html"),
        filters: resolve(root, "filters.html"),
        regions: resolve(root, "regions.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": backendOrigin,
      "/map-work": backendOrigin,
      "/obj-worker.js": backendOrigin,
    },
  },
});
