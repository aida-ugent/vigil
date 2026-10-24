import { eng } from "stopword";
import { z } from "zod";

export const ACTIVITY_SETTINGS_KEY = "vigilActivitySettingsV1";
export interface ActivitySettings {
  tracking: boolean;
}
export async function getActivitySettings(): Promise<ActivitySettings> {
  const raw = (await chrome.storage.local.get(ACTIVITY_SETTINGS_KEY))[
    ACTIVITY_SETTINGS_KEY
  ];
  return {
    tracking: raw?.tracking === true,
  };
}
export async function setActivitySettings(
  patch: Partial<ActivitySettings>,
): Promise<void> {
  await chrome.storage.local.set({
    [ACTIVITY_SETTINGS_KEY]: { ...(await getActivitySettings()), ...patch },
  });
}

export const postSchema = z.object({
  id: z.string().regex(/^\d+$/),
  author: z.string().max(100),
  text: z.string().max(20000),
  url: z.string().url().max(2048),
  viewer: z.string().max(100),
});
export const eventSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["visit", "exposure", "like", "unlike"]),
  at: z.number().finite().nonnegative(),
  url: z.string().url().max(2048),
  title: z.string().max(500).optional(),
  session: z.string().max(100),
  post: postSchema.optional(),
  context: z.string().max(100).optional(),
});
export type ActivityEvent = z.infer<typeof eventSchema>;
export type PostSnapshot = z.infer<typeof postSchema>;
export interface StoredPost extends PostSnapshot {
  key: string;
  at: number;
  liked: boolean;
  likedAt?: number;
  interactionAt?: number;
  likedText?: string;
  tokens: string[];
  likedTokens: string[];
  /** Sparse index key: present only for liked/authored posts, so vector scans skip ordinary exposures. */
  preferenceAt?: number;
  /** L2-normalized sentence vector of preferenceText(); absent until the backlog drain reaches it. */
  embedding?: Float32Array;
  embeddingVersion?: string;
}
export interface AccountStats {
  key: string;
  author: string;
  viewer: string;
  exposures: number;
  feedExposures: number;
  likes: number;
}
export type RetrievalMethod = "lexical" | "semantic" | "hybrid";
export interface Evidence {
  revision: string;
  posts: StoredPost[];
  ready: boolean;
  retrievalMethod?: RetrievalMethod;
  matchMethods?: Record<string, RetrievalMethod>;
  /** Query tokens that were discriminative enough to count toward the lexical floor. */
  queryTerms?: string[];
  /** Cosine per retrieved key, surfaced in diagnostics so the floor can be calibrated. */
  similarity?: Record<string, number>;
}

// Standard English stopwords, normalized with the same tokenizer as incoming text.
// URL/platform fragments are retrieval noise rather than linguistic stopwords.
const STOP = new Set([
  ...eng.flatMap(
    (word) => word.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  ),
  "http",
  "https",
  "twitter",
  "com",
  // Supplements to the library’s short English list; never count these as topical evidence.
  "will",
  "just",
  "really",
  "enough",
  "full",
]);
export function tokens(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
        (t) => !STOP.has(t),
      ),
    ),
  ].slice(0, 300);
}
export function cleanUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol)
      ? `${u.origin}${u.pathname}`.slice(0, 2048)
      : null;
  } catch {
    return null;
  }
}
/** Authorship is inferred only from a rendered post's author matching the signed-in profile. */
export function isOwnPost(post: PostSnapshot): boolean {
  return (
    !!post.viewer &&
    post.viewer !== "unknown" &&
    post.author.toLowerCase() === post.viewer.toLowerCase()
  );
}
export function isPreferencePost(post: StoredPost): boolean {
  return post.liked || isOwnPost(post);
}
export function preferenceText(post: StoredPost): string {
  return isOwnPost(post) ? post.text : (post.likedText ?? post.text);
}
/** Liked posts rank by when the preference was expressed; authored posts have no like timestamp. */
export function preferenceAt(post: StoredPost): number | undefined {
  return isPreferencePost(post) ? (post.likedAt ?? post.at) : undefined;
}
export const EMBEDDING_DIMS = 384;
// Bump whenever weights, backend, pooling or input preprocessing change.
// Old unit-length vectors can be numerically valid but belong to an incompatible space.
export const EMBEDDING_VERSION = "minilm-751bff3:q8:wasm:mean:l2:1500:v1";
export function hasCurrentEmbedding(post: StoredPost): boolean {
  return (
    post.embeddingVersion === EMBEDDING_VERSION &&
    !!post.embedding &&
    validEmbedding(post.embedding)
  );
}
/** At least two shared meaningful tokens, unchanged from the original lexical retriever. */
export const LEXICAL_FLOOR = 2;
/** Provisional cosine floor checked on small smoke-test fixtures, not a calibrated relevance threshold. */
export const SIMILARITY_FLOOR = 0.4;
/** Below this many stored posts, document frequencies are too noisy to filter on. */
export const IDF_MIN_CORPUS = 20;
/** A term carried by more than this share of stored posts discriminates nothing, whether it is
 * English filler the 108-word stopword list misses ("will", "just", "think") or the reader's own
 * pet topic. Two such terms must not be enough to qualify a post as evidence. */
export const IDF_MAX_SHARE = 0.15;
/** Bounds the vector pass; the preference index is ordered by recency so this keeps the newest. */
export const VECTOR_SCAN_LIMIT = 2000;
/** Bounds foreground indexing work before retrieval; background batches are smaller. */
export const DRAIN_BATCH = 32;
/** Reject malformed model output before it can poison retrieval or permanently leave the backlog. */
export function validEmbedding(vector: Float32Array): boolean {
  if (vector.length !== EMBEDDING_DIMS || !vector.every(Number.isFinite))
    return false;
  const norm = vector.reduce((sum, value) => sum + value * value, 0);
  return Math.abs(norm - 1) < 0.02;
}
/** Stored vectors are L2-normalized, so the dot product is already the cosine. */
export function similarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += a[i] * b[i];
  return total;
}
export function evidenceReady(posts: StoredPost[]): boolean {
  const eligible = posts.filter(isPreferencePost);
  const viewers = new Set(eligible.map((p) => p.viewer));
  return (
    new Set(eligible.map((p) => p.id)).size >= 2 &&
    viewers.size === 1 &&
    !viewers.has("unknown")
  );
}
