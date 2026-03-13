import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
  plugins: [
    webExtension({
      manifest: "manifest.json",
      skipManifestValidation: true,
      additionalInputs: ["src/offscreen/offscreen.html"],
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
