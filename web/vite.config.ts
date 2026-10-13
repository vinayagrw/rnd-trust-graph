import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // tailwindcss() is ADDITIVE: it only compiles classes used by the new admin
  // surface. Preflight (the global CSS reset) is deliberately NOT imported in
  // admin.css, so the existing hand-styled beats are untouched. See admin.css.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      // BFF endpoints proxied so the browser only ever talks to one origin.
      // Target defaults to the standard BFF; override with BFF_PROXY to point a
      // dev instance at an alternate BFF (e.g. a second server on another port).
      "/api": {
        target: process.env.BFF_PROXY ?? "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Generative Studio (Task 9) lazy-imports vega-embed only once a
        // VegaTile actually renders; splitting the vega/vega-lite/vega-embed
        // trio into their own chunk keeps that weight out of the main bundle
        // for every beat that never touches the generative lane.
        manualChunks: {
          vega: ["vega", "vega-lite", "vega-embed"],
        },
      },
    },
  },
});
