import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  copyFile,
  readFile,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const revision = "751bff37182d3f1213fa05d7196b954e230abad9";
const model = "all-MiniLM-L6-v2";
// SHA-256 for the fixed upstream revision, checked both after download and before reuse.
const files = {
  "config.json":
    "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
  "tokenizer.json":
    "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  "tokenizer_config.json":
    "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  "onnx/model_quantized.onnx":
    "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
  "README.md":
    "63ea99bf681a2e9eda4f6a537d5ed8fda95d1677111656da37e9cfd080c3af02",
};
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function matches(path, expected) {
  try {
    return (await digest(path)) === expected;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function download(file, path, expected) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + ".tmp";
  try {
    console.log("Downloading embedding asset:", file);
    const response = await fetch(
      `https://huggingface.co/Xenova/${model}/resolve/${revision}/${file}`,
      { signal: AbortSignal.timeout(180_000) },
    );
    if (!response.ok || !response.body)
      throw new Error(`HTTP ${response.status} fetching ${file}`);
    await pipeline(response.body, createWriteStream(temporary));
    if (!(await matches(temporary, expected)))
      throw new Error("Checksum mismatch: " + file);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
const mode = process.argv[2] ?? "all";
if (!["all", "model", "ort", "check"].includes(mode))
  throw new Error("Unknown asset mode: " + mode);
if (mode !== "model") {
  await mkdir(join(root, "public/ort"), { recursive: true });
  for (const suffix of [".mjs", ".wasm", ".jsep.mjs", ".jsep.wasm"]) {
    const name = "ort-wasm-simd-threaded" + suffix;
    const source = join(root, "node_modules/onnxruntime-web/dist", name);
    const target = join(root, "public/ort", name);
    if (mode === "check") {
      if (!(await matches(target, await digest(source))))
        throw new Error(
          "Runtime asset missing or stale; run npm run assets: " + name,
        );
    } else await copyFile(source, target);
  }
}
if (mode !== "ort") {
  const directory = join(root, "public/models", model);
  for (const [file, expected] of Object.entries(files)) {
    const path = join(directory, file);
    if (await matches(path, expected)) continue;
    if (mode === "check")
      throw new Error(
        "Embedding asset missing or corrupt; run npm run assets: " + file,
      );
    await download(file, path, expected);
  }
  if (mode !== "check")
    await writeFile(join(directory, "revision.txt"), revision);
}
