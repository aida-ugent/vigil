import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
  define: { __VIGIL_BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  plugins: [
    webExtension({
      manifest: "manifest.json",
      skipManifestValidation: true,
      additionalInputs: [
        "src/offscreen/offscreen.html",
        "src/activity/index.html",
      ],
    }),
  ],
  build: {
    target: "ES2022",
    minify: "esbuild",
    sourcemap: false,
    cssMinify: true,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  esbuild: {
    target: "ES2022",
    legalComments: "none",
  },
  optimizeDeps: {
    exclude: ["@mlc-ai/web-llm"],
  },
});
