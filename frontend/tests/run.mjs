import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
mkdirSync("node_modules/.cache", { recursive: true });
await build({
  entryPoints: ["tests/activity.test.ts"],
  outfile: "node_modules/.cache/vigil-activity-tests.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const result = spawnSync(
  process.execPath,
  ["--test", "node_modules/.cache/vigil-activity-tests.cjs"],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
