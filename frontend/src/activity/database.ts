import {
  tokens,
  evidenceReady,
  isOwnPost,
  isPreferencePost,
  preferenceText,
  type ActivityEvent,
  type StoredPost,
  type AccountStats,
  type Evidence,
} from "./model";

let opening: Promise<IDBDatabase> | undefined;
export function database(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("vigil-activity", 3);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (event.oldVersion < 1) {
      const events = db.createObjectStore("events", { keyPath: "id" });
      events.createIndex("at", "at");
      events.createIndex("kind", "kind");
      const posts = db.createObjectStore("posts", { keyPath: "key" });
      posts.createIndex("author", "author");
      posts.createIndex("tokens", "tokens", { multiEntry: true });
      posts.createIndex("likedTokens", "likedTokens", { multiEntry: true });
      db.createObjectStore("accounts", { keyPath: "key" });
      db.createObjectStore("meta");
      }
      // Existing likedAt values are indexed automatically; preserve all activity.
      const posts = req.transaction!.objectStore("posts");
      if (event.oldVersion < 2) posts.createIndex("authorLikedAt", ["author", "likedAt"]);
      // Refresh derived search fields after switching stopword sources; raw activity is unchanged.
      if (event.oldVersion < 3) {
        const cursor = posts.openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const post = entry.value as StoredPost;
          entry.update({ ...post, tokens: tokens(post.text), likedTokens: post.liked ? tokens(post.likedText ?? post.text) : [] });
          entry.continue();
        };
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        opening = undefined;
      };
      resolve(req.result);
    };
    req.onerror = () => {
      opening = undefined;
      reject(req.error);
    };
  }));
}
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("Activity transaction aborted"));
    tx.onerror = () => reject(tx.error);
  });
}
export async function saveEvents(events: ActivityEvent[]): Promise<void> {
  const tx = (await database()).transaction(
    ["events", "posts", "accounts", "meta"],
    "readwrite",
  );
  const completed = done(tx);
  // All dependent operations stay in IDB callbacks so the transaction remains active.
  let position = 0;
  function next(): void {
    const event = events[position++];
    if (!event) return;
    const exists = tx.objectStore("events").get(event.id);
    exists.onsuccess = () => {
      if (exists.result) {
        next();
        return;
      }
      tx.objectStore("events").put(event);
      if (event.kind === "like" || event.kind === "unlike")
        tx.objectStore("meta").put(crypto.randomUUID(), "revision");
      if (!event.post) {
        next();
        return;
      }
      const post = event.post;
      const key = `${post.viewer}:${post.id}`;
      const get = tx.objectStore("posts").get(key);
      get.onsuccess = () => {
        const old = get.result as StoredPost | undefined;
        const newer = !old || event.at >= (old.interactionAt ?? 0);
        const liked =
          newer && event.kind === "like"
            ? true
            : newer && event.kind === "unlike"
              ? false
              : (old?.liked ?? false);
        const likedText =
          newer && event.kind === "like" ? post.text : old?.likedText;
        const latest = old && old.at > event.at ? old : post;
        const row: StoredPost = {
          ...latest,
          key,
          at: Math.max(event.at, old?.at ?? 0),
          liked,
          interactionAt:
            newer && (event.kind === "like" || event.kind === "unlike")
              ? event.at
              : old?.interactionAt,
          likedAt: newer && event.kind === "like" ? event.at : old?.likedAt,
          likedText,
          tokens: tokens(latest.text),
          likedTokens: liked ? tokens(likedText ?? post.text) : [],
        };
        if (isOwnPost(row) && (!old || old.text !== row.text))
          tx.objectStore("meta").put(crypto.randomUUID(), "revision");
        tx.objectStore("posts").put(row);
        const accountKey = `${post.viewer}:${post.author}`;
        const accountReq = tx.objectStore("accounts").get(accountKey);
        accountReq.onsuccess = () => {
          const account: AccountStats = accountReq.result ?? {
            key: accountKey,
            author: post.author,
            viewer: post.viewer,
            exposures: 0,
            feedExposures: 0,
            likes: 0,
          };
          if (event.kind === "exposure") {
            account.exposures++;
            if (event.context === "home-feed")
              account.feedExposures = (account.feedExposures ?? 0) + 1;
          }
          account.likes += Number(liked) - Number(old?.liked ?? false);
          tx.objectStore("accounts").put(account);
          next();
        };
      };
    };
  }
  next();
  await completed;
}
export async function revision(): Promise<string> {
  return (
    (await request(
      (await database())
        .transaction("meta")
        .objectStore("meta")
        .get("revision"),
    )) ?? "empty"
  );
}
export async function related(
  text: string,
  excludeId?: string,
  author?: string,
): Promise<Evidence> {
  const db = await database();
  const tx = db.transaction(["posts", "meta"]);
  const query = tokens(text).slice(0, 24);
  const store = tx.objectStore("posts");
  const revisionRequest = request(tx.objectStore("meta").get("revision"));
  const normalizedAuthor = author?.trim().replace(/^@/, "").toLowerCase();
  // Schedule alongside keyword reads to keep one consistent transaction snapshot.
  const authorPosts: Promise<StoredPost[]> = normalizedAuthor
    ? new Promise((resolve, reject) => {
        const matches: StoredPost[] = [];
        let scanned = 0;
        const range = IDBKeyRange.bound([normalizedAuthor, 0], [normalizedAuthor, Number.MAX_VALUE]);
        const cursor = store.index("authorLikedAt").openCursor(range, "prev");
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) { resolve(matches); return; }
          const post = entry.value as StoredPost;
          if (post.liked && post.id !== excludeId) matches.push(post);
          if (matches.length >= 100 || ++scanned >= 500) { resolve(matches); return; }
          entry.continue();
        };
      })
    : Promise.resolve([]);
  const [groups, sameAuthor] = await Promise.all([Promise.all(
    query.flatMap((term) => [
      request(store.index("likedTokens").getAll(term, 100)),
      request(store.index("tokens").getAll(term, 50)),
    ]),
  ), authorPosts]);
  const candidates = new Map<string, StoredPost>();
  for (const group of groups)
    for (const p of group as StoredPost[])
      if (p.id !== excludeId && isPreferencePost(p)) candidates.set(p.key, p);
  const ranked = [...candidates.values()]
    .map((p) => {
      const terms = new Set(tokens(preferenceText(p)));
      return { p, score: query.filter(t => terms.has(t)).length };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score || b.p.at - a.p.at);
  // Fallback only when no candidate meets the meaningful-keyword threshold.
  const retrievalMethod = ranked.length ? "keywords" as const : "same-author" as const;
  const selected = ranked.length ? ranked : sameAuthor.map(p => ({ p, score: 0 }));
  // Never mix viewing accounts into a single inferred preference profile.
  const viewers = new Set(
    selected.map((x) => x.p.viewer),
  );
  const viewer = [...viewers][0];
  const scoped = selected.filter((x) => x.p.viewer === viewer);
  const posts = scoped.slice(0, 12).map(x => x.p);
  return {
    revision: (await revisionRequest) ?? "empty",
    posts,
    retrievalMethod,
    ready:
      viewers.size === 1 && !viewers.has("unknown") && evidenceReady(posts),
  };
}
export async function activitySummary(): Promise<{
  events: number;
  posts: number;
  accounts: AccountStats[];
}> {
  const tx = (await database()).transaction(["events", "posts", "accounts"]);
  const [events, posts, accounts] = await Promise.all([
    request(tx.objectStore("events").count()),
    request(tx.objectStore("posts").count()),
    request(tx.objectStore("accounts").getAll()),
  ]);
  return { events, posts, accounts };
}
export async function clearActivity(): Promise<void> {
  const tx = (await database()).transaction(
    ["events", "posts", "accounts", "meta"],
    "readwrite",
  );
  const completed = done(tx);
  for (const name of ["events", "posts", "accounts", "meta"])
    tx.objectStore(name).clear();
  tx.objectStore("meta").put(crypto.randomUUID(), "revision");
  await completed;
}
export async function exportActivity(): Promise<Blob> {
  const chunks: string[] = [
    JSON.stringify({
      type: "manifest",
      version: 1,
      exportedAt: new Date().toISOString(),
    }) + "\n",
  ];
  const tx = (await database()).transaction(["events", "posts", "accounts"]);
  const completed = done(tx);
  for (const name of ["events", "posts", "accounts"]) {
    const cursor = tx.objectStore(name).openCursor();
    cursor.onsuccess = () => {
      if (cursor.result) {
        chunks.push(
          JSON.stringify({ type: name, data: cursor.result.value }) + "\n",
        );
        cursor.result.continue();
      }
    };
  }
  await completed;
  return new Blob(chunks, { type: "application/x-ndjson" });
}

export type ActivityRow =
  { kind: "post"; data: StoredPost } | { kind: "visit"; data: ActivityEvent };

export interface ActivityPage {
  rows: ActivityRow[];
  next?: IDBValidKey;
}

/** Returns up to 50 matches, examining at most 1,000 new records per page.
 * Indexed cursors seek to the previous primary key rather than replaying earlier pages.
 */
export async function browseActivity(options: {
  kind: "posts" | "visits";
  author?: string;
  query?: string;
  after?: IDBValidKey;
}): Promise<ActivityPage> {
  const tx = (await database()).transaction(
    options.kind === "posts" ? "posts" : "events",
  );
  const store = tx.objectStore(options.kind === "posts" ? "posts" : "events");
  const terms = tokens(options.query ?? "");
  const author = options.author?.replace(/^@/, "").toLowerCase().trim();
  const source: IDBObjectStore | IDBIndex =
    options.kind === "visits"
      ? store.index("kind")
      : author
        ? store.index("author")
        : terms.length
          ? store.index("tokens")
          : store;
  const indexKey = options.kind === "visits" ? "visit" : author || terms[0];
  const range = indexKey
    ? IDBKeyRange.only(indexKey)
    : options.after
      ? IDBKeyRange.lowerBound(options.after, true)
      : undefined;
  const rows: ActivityRow[] = [];
  return new Promise((resolve, reject) => {
    const req = source.openCursor(range);
    let scanned = 0;
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve({ rows });
        return;
      }
      if (indexKey && options.after) {
        const comparison = indexedDB.cmp(cursor.primaryKey, options.after);
        if (comparison < 0) {
          cursor.continuePrimaryKey(cursor.key, options.after);
          return;
        }
        if (comparison === 0) {
          cursor.continue();
          return;
        }
      }
      const row: StoredPost | ActivityEvent = cursor.value;
      if ("tokens" in row) {
        if (terms.every((term) => row.tokens.includes(term)))
          rows.push({ kind: "post", data: row });
      } else {
        rows.push({ kind: "visit", data: row });
      }
      if (rows.length >= 50 || ++scanned >= 1000) {
        resolve({ rows, next: cursor.primaryKey });
        return;
      }
      cursor.continue();
    };
  });
}
