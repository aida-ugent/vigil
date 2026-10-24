import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const watch = process.argv.includes("--watch");
const mode = watch ? "development" : "production";
const watchers = [];
// Clear once; independent watch builds must never erase one another's outputs.
await rm(new URL("../dist/", import.meta.url), {
  recursive: true,
  force: true,
});
try {
  const pages = await build({
    root,
    mode,
    build: { emptyOutDir: false, watch: watch ? {} : null },
  });
  if (watch) watchers.push(pages);
  for (const [entry, format] of [
    ["src/background/index", "es"],
    ["src/content/index", "iife"],
  ]) {
    const result = await build({
      configFile: false,
      root,
      mode,
      publicDir: false,
      define: { "process.env.NODE_ENV": JSON.stringify(mode) },
      build: {
        target: "es2022",
        minify: true,
        emptyOutDir: false,
        watch: watch ? {} : null,
        lib: {
          name: "VigilContent",
          entry: `${root}${entry}.ts`,
          formats: [format],
          fileName: () => `${entry}.js`,
        },
      },
    });
    if (watch) watchers.push(result);
  }
} catch (error) {
  await Promise.all(watchers.map((watcher) => watcher.close()));
  throw error;
}
if (watch) {
  const close = async () => {
    await Promise.all(watchers.map((watcher) => watcher.close()));
    process.exit();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
