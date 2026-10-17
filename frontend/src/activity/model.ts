import { eng } from "stopword";
import { z } from "zod";

export const ACTIVITY_SETTINGS_KEY = "vigilActivitySettingsV1";
export interface ActivitySettings {
  tracking: boolean;
  confirmation: boolean;
}
export async function getActivitySettings(): Promise<ActivitySettings> {
  const raw = (await chrome.storage.local.get(ACTIVITY_SETTINGS_KEY))[
    ACTIVITY_SETTINGS_KEY
  ];
  return {
    tracking: raw?.tracking === true,
    confirmation: raw?.confirmation !== false,
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
}
export interface AccountStats {
  key: string;
  author: string;
  viewer: string;
  exposures: number;
  feedExposures: number;
  likes: number;
}
export interface Evidence {
  revision: string;
  posts: StoredPost[];
  ready: boolean;
  retrievalMethod?: "keywords" | "same-author";
}

// Standard English stopwords, normalized with the same tokenizer as incoming text.
// URL/platform fragments are retrieval noise rather than linguistic stopwords.
const STOP = new Set([
  ...eng.flatMap(word => word.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
  "http", "https", "twitter", "com",
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
  return !!post.viewer && post.viewer !== "unknown" && post.author.toLowerCase() === post.viewer.toLowerCase();
}
export function isPreferencePost(post: StoredPost): boolean {
  return post.liked || isOwnPost(post);
}
export function preferenceText(post: StoredPost): string {
  return isOwnPost(post) ? post.text : post.likedText ?? post.text;
}
export function evidenceReady(posts: StoredPost[]): boolean {
  const eligible = posts.filter(isPreferencePost);
  const viewers = new Set(eligible.map(p => p.viewer));
  return new Set(eligible.map(p => p.id)).size >= 2 && viewers.size === 1 && !viewers.has("unknown");
}
