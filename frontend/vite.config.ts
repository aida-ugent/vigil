import { readFile } from "node:fs/promises";
import { defineConfig } from "vite";

export default defineConfig({
  define: { __VIGIL_BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  plugins: [
    {
      name: "vigil-chunk-budgets",
      generateBundle(_options, bundle) {
        // WebLLM ships a large runtime as one module. It is loaded on demand;
        // retain the normal 500 kB budget for every other JavaScript chunk.
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk") continue;
          const isWebLLM = chunk.isDynamicEntry &&
            chunk.facadeModuleId?.includes("/node_modules/@mlc-ai/web-llm/");
          const budget = isWebLLM ? 7000 : 500;
          const size = Buffer.byteLength(chunk.code) / 1000;
          if (size > budget) {
            this.warn(`${chunk.fileName} is ${Math.round(size)} kB; budget is ${budget} kB.`);
          }
        }
      },
    },
    {
      name: "vigil-manifest",
      buildStart() {
        this.addWatchFile("manifest.json");
      },
      async generateBundle() {
        const manifest = JSON.parse(
          await readFile(new URL("./manifest.json", import.meta.url), "utf8"),
        );
        manifest.background.service_worker = "src/background/index.js";
        for (const script of manifest.content_scripts) {
          script.js = script.js.map((entry: string) =>
            entry.replace(/\.ts$/, ".js"),
          );
        }
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source: JSON.stringify(manifest, null, 2),
        });
      },
    },
  ],
  build: {
    target: "es2022",
    sourcemap: false,
    // The plugin above enforces the smaller budget on application chunks.
    chunkSizeWarningLimit: 7000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "onnx-runtime", test: /node_modules[\\/]onnxruntime-web[\\/]/ },
          ],
        },
      },
      input: [
        "src/sidepanel/index.html",
        "src/offscreen/offscreen.html",
        "src/activity/index.html",
      ],
    },
  },
});
