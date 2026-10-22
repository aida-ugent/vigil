import {
  pipeline,
  env,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import {
  DRAIN_BATCH,
  EMBEDDING_DIMS,
  preferenceText,
  validEmbedding,
} from "./model";
import { pendingEmbeddings, saveEmbeddings } from "./database";

/** Weights and the ONNX runtime are served from the extension package: retrieval makes no network
 * calls, and MV3 forbids executing remotely fetched code regardless. */
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL("models/");
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("ort/");
  // Extension pages are not cross-origin isolated, so SharedArrayBuffer threading is unavailable.
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}

const EMBEDDING_MODEL = "all-MiniLM-L6-v2";

let extractor: Promise<FeatureExtractionPipeline> | null = null;
function load(): Promise<FeatureExtractionPipeline> {
  return (extractor ??= (async () => {
    // WASM only: q8 is the library's default there, whereas the WebGPU backend lacks proper int8
    // kernels. A single short query is fast enough on CPU.
    return await pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: "q8",
      device: "wasm",
    });
  })().catch((error) => {
    extractor = null;
    throw new Error(
      `Embedding model unavailable. Run "npm run assets:model" to vendor the weights. (${error instanceof Error ? error.message : "unknown error"})`,
    );
  }));
}

/** Mean-pooled and L2-normalized, so stored vectors compare by dot product. */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const output = await (
    await load()
  )(texts, { pooling: "mean", normalize: true });
  const flat = Float32Array.from(output.data as ArrayLike<number>);
  if (flat.length !== texts.length * EMBEDDING_DIMS)
    throw new Error("Unexpected embedding output shape.");
  const vectors = texts.map((_, i) =>
    flat.slice(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS),
  );
  if (!vectors.every(validEmbedding))
    throw new Error("Embedding model returned invalid vectors.");
  return vectors;
}

/** Embeds one batch of the backlog. Returns how many posts are still missing a vector. */
export async function drain(limit = DRAIN_BATCH): Promise<number> {
  const posts = await pendingEmbeddings(limit);
  if (!posts.length) return 0;
  const texts = posts.map((post) => preferenceText(post).slice(0, 1500));
  const vectors = await embed(texts);
  await saveEmbeddings(
    posts.map((post, i) => ({
      key: post.key,
      embedding: vectors[i],
      text: preferenceText(post),
    })),
  );
  return (await pendingEmbeddings(limit)).length;
}
