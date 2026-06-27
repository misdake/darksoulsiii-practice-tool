import { defineConfig } from "vite";

const backendOrigin =
  process.env.VITE_BACKEND_ORIGIN || "http://127.0.0.1:7878";

export default defineConfig({
  appType: "mpa",
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
