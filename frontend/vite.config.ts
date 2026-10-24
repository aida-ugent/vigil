import { readFile } from "node:fs/promises";
import { defineConfig } from "vite";

export default defineConfig({
  define: { __VIGIL_BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  plugins: [
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
    rolldownOptions: {
      input: [
        "src/sidepanel/index.html",
        "src/offscreen/offscreen.html",
        "src/activity/index.html",
      ],
    },
  },
});
