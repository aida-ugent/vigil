import { DRAIN_BATCH, VECTOR_SCAN_LIMIT } from "./model";
import { pendingEmbeddings } from "./database";

/** A first query must see newly indexed history, rather than racing a fire-and-forget drain. */
export async function prepareEmbedding(
  payload: { query?: string; drain?: number },
  encoder: {
    drain(limit: number): Promise<number>;
    embed(texts: string[]): Promise<Float32Array[]>;
  },
): Promise<{ vector: number[] | null; pending: number }> {
  if (payload.drain) await encoder.drain(Math.min(DRAIN_BATCH, payload.drain));
  const vector = payload.query
    ? [...(await encoder.embed([payload.query]))[0]]
    : null;
  // Exact within the same bounded recent-history window used by retrieval.
  const pending = (await pendingEmbeddings(VECTOR_SCAN_LIMIT)).length;
  return { vector, pending };
}
