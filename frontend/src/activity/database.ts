import { snapshotKey, storeSnapshot, restoreSnapshot } from "./snapshots";
import {
  tokens,
  evidenceReady,
  isOwnPost,
  isPreferencePost,
  preferenceText,
  preferenceAt,
  similarity,
  validEmbedding,
  hasCurrentEmbedding,
  EMBEDDING_VERSION,
  LEXICAL_FLOOR,
  SIMILARITY_FLOOR,
  IDF_MIN_CORPUS,
  IDF_MAX_SHARE,
  VECTOR_SCAN_LIMIT,
  type ActivityEvent,
  type StoredPost,
  type AccountStats,
  type Evidence,
  type RetrievalMethod,
} from "./model";

let opening: Promise<IDBDatabase> | undefined;
export function database(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("vigil-activity", 7);
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
      if (event.oldVersion < 6) {
        db.createObjectStore("texts", { keyPath: "key" });
        req
          .transaction!.objectStore("events")
          .createIndex("kindAt", ["kind", "at"]);
        req
          .transaction!.objectStore("posts")
          .createIndex("embeddingVersion", "embeddingVersion");
      }
      if (event.oldVersion < 7) {
        const events = req.transaction!.objectStore("events");
        events.createIndex("postKindAt", [
          "post.viewer",
          "post.id",
          "kind",
          "at",
        ]);
        events.createIndex("textKey", "textKey");
      }
      // Existing likedAt values are indexed automatically; preserve all activity.
      const posts = req.transaction!.objectStore("posts");
      if (event.oldVersion < 2)
        posts.createIndex("authorLikedAt", ["author", "likedAt"]);
      // Sparse: IndexedDB omits records whose key path is undefined, so only preference posts are listed.
      if (event.oldVersion < 4)
        posts.createIndex("preferenceAt", "preferenceAt");
      // One cursor for every derived field: concurrent cursors over the same store overwrite each
      // other's updates, which silently dropped the refreshed tokens when both passes ran.
      if (event.oldVersion < 5) {
        const cursor = posts.openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const post = entry.value as StoredPost;
          // Refresh derived search fields after switching stopword sources; raw activity is unchanged.
          const refreshed: StoredPost =
            event.oldVersion < 3
              ? {
                  ...post,
                  tokens: tokens(post.text),
                  likedTokens: post.liked
                    ? tokens(post.likedText ?? post.text)
                    : [],
                }
              : post;
          // Only the synchronous key is backfilled here. Vectors cannot be: awaiting inference inside
          // an upgrade transaction lets it auto-commit, so embeddings are filled by the drain instead.
          // v5 drops vectors computed by the earlier WebGPU int8 path; the drain recomputes them on WASM.
          entry.update({
            ...refreshed,
            preferenceAt: preferenceAt(refreshed),
            embedding: undefined,
          });
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
/** Remove saved preferences up to an interaction time, preserving newer re-likes. */
function removePreferenceEvents(
  tx: IDBTransaction,
  viewer: string,
  id: string,
  at: number,
  garbage: Set<string>,
  finished: () => void,
): void {
  const kinds = ["like", "unlike"];
  function scan(): void {
    const kind = kinds.shift();
    if (!kind) {
      finished();
      return;
    }
    const req = tx
      .objectStore("events")
      .index("postKindAt")
      .openCursor(
        IDBKeyRange.bound([viewer, id, kind, 0], [viewer, id, kind, at]),
      );
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        scan();
        return;
      }
      if (cursor.value.textKey) garbage.add(cursor.value.textKey);
      cursor.delete();
      cursor.continue();
    };
  }
  scan();
}

export async function saveEvents(events: ActivityEvent[]): Promise<void> {
  // Unlike is a deletion command, not an event to persist or embed.
  const keys = await Promise.all(
    events.map((event) =>
      event.post && event.kind !== "unlike"
        ? snapshotKey(event.post.text)
        : undefined,
    ),
  );
  const tx = (await database()).transaction(
    ["events", "posts", "accounts", "meta", "texts"],
    "readwrite",
  );
  const completed = done(tx);
  const garbage = new Set<string>();
  let position = 0;
  function next(): void {
    const event = events[position++];
    if (!event) {
      // Check references only after all commands, including re-likes, have been applied.
      for (const key of garbage) {
        const req = tx.objectStore("events").index("textKey").count(key);
        req.onsuccess = () => {
          if (!req.result) tx.objectStore("texts").delete(key);
        };
      }
      return;
    }
    const textKey = keys[position - 1];
    const exists = tx.objectStore("events").get(event.id);
    exists.onsuccess = () => {
      if (exists.result && event.kind !== "unlike") {
        next();
        return;
      }
      const post = event.post;
      if (!post) {
        if (event.kind !== "unlike") tx.objectStore("events").put(event);
        else tx.objectStore("events").delete(event.id);
        next();
        return;
      }
      const key = `${post.viewer}:${post.id}`;
      const get = tx.objectStore("posts").get(key);
      get.onsuccess = () => {
        const old = get.result as StoredPost | undefined;
        // Only an ordering timestamp is kept after deletion, so delayed retries cannot
        // resurrect a removed like. No unlike event, text, or snapshot is retained.
        const ordering = tx.objectStore("meta").get(`lastUnlike:${key}`);
        ordering.onsuccess = () => {
          const newer =
            event.at >=
              Math.max(old?.interactionAt ?? 0, ordering.result ?? 0) &&
            (event.kind !== "like" ||
              ordering.result === undefined ||
              event.at > ordering.result);
          const apply = () => {
            if (!newer && event.kind !== "exposure") {
              next();
              return;
            }
            if (event.kind !== "unlike")
              tx.objectStore("events").put(storeSnapshot(tx, event, textKey));
            if (event.kind === "like" || event.kind === "unlike")
              tx.objectStore("meta").put(crypto.randomUUID(), "revision");
            if (event.kind === "unlike")
              tx.objectStore("meta").put(event.at, `lastUnlike:${key}`);
            const liked =
              event.kind === "like"
                ? true
                : event.kind === "unlike"
                  ? false
                  : (old?.liked ?? false);
            const latest =
              event.kind === "unlike" && old
                ? old
                : old && old.at > event.at
                  ? old
                  : post;
            const likedText =
              event.kind === "unlike"
                ? undefined
                : event.kind === "like"
                  ? post.text
                  : old?.likedText;
            const row: StoredPost = {
              ...latest,
              key,
              at: Math.max(event.at, old?.at ?? 0),
              liked,
              interactionAt:
                event.kind === "like" || event.kind === "unlike"
                  ? event.at
                  : old?.interactionAt,
              likedAt:
                event.kind === "unlike"
                  ? undefined
                  : event.kind === "like"
                    ? event.at
                    : old?.likedAt,
              likedText,
              tokens: tokens(latest.text),
              likedTokens: liked ? tokens(likedText ?? post.text) : [],
            };
            row.preferenceAt = preferenceAt(row);
            row.embedding =
              isPreferencePost(row) &&
              old &&
              hasCurrentEmbedding(old) &&
              preferenceText(row) === preferenceText(old)
                ? old.embedding
                : undefined;
            row.embeddingVersion = row.embedding
              ? EMBEDDING_VERSION
              : undefined;
            if (isOwnPost(row) && (!old || old.text !== row.text))
              tx.objectStore("meta").put(crypto.randomUUID(), "revision");
            const save = (keep: boolean) => {
              if (keep) tx.objectStore("posts").put(row);
              else tx.objectStore("posts").delete(key);
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
                if (account.exposures || account.likes)
                  tx.objectStore("accounts").put(account);
                else tx.objectStore("accounts").delete(accountKey);
                next();
              };
            };
            if (event.kind === "unlike" && !isOwnPost(row)) {
              const exposures = tx
                .objectStore("events")
                .index("postKindAt")
                .count(
                  IDBKeyRange.bound(
                    [post.viewer, post.id, "exposure", 0],
                    [post.viewer, post.id, "exposure", Number.MAX_VALUE],
                  ),
                );
              exposures.onsuccess = () => save(exposures.result > 0);
            } else save(true);
          };
          if (event.kind === "unlike" || (event.kind === "like" && newer))
            removePreferenceEvents(
              tx,
              post.viewer,
              post.id,
              event.at,
              garbage,
              apply,
            );
          else apply();
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
  queryVector?: Float32Array,
  excludeId?: string,
): Promise<Evidence> {
  const db = await database();
  const tx = db.transaction(["posts", "meta"]);
  const query = tokens(text).slice(0, 24);
  const store = tx.objectStore("posts");
  const revisionRequest = request(tx.objectStore("meta").get("revision"));
  // Issued synchronously with every other read so the transaction cannot auto-commit beneath us.
  // Counts span all stored posts, not just preference posts: a cheap proxy for term commonness.
  const totalRequest = request(store.count());
  const documentFrequency = query.map((term) =>
    request(store.index("tokens").count(term)),
  );
  // Newest preference posts first, bounded; scheduled alongside the keyword reads for one snapshot.
  const vectorMatches: Promise<Array<{ post: StoredPost; score: number }>> =
    queryVector
      ? new Promise((resolve, reject) => {
          const matches: Array<{ post: StoredPost; score: number }> = [];
          let scanned = 0;
          const cursor = store.index("preferenceAt").openCursor(null, "prev");
          cursor.onerror = () => reject(cursor.error);
          cursor.onsuccess = () => {
            const entry = cursor.result;
            if (!entry) {
              resolve(matches);
              return;
            }
            const post = entry.value as StoredPost;
            if (hasCurrentEmbedding(post) && post.id !== excludeId) {
              const score = similarity(queryVector, post.embedding!);
              if (score >= SIMILARITY_FLOOR) matches.push({ post, score });
            }
            if (++scanned >= VECTOR_SCAN_LIMIT) {
              resolve(matches);
              return;
            }
            entry.continue();
          };
        })
      : Promise.resolve([]);
  const [groups, semantic] = await Promise.all([
    Promise.all(
      query.flatMap((term) => [
        request(store.index("likedTokens").getAll(term, 100)),
        request(store.index("tokens").getAll(term, 50)),
      ]),
    ),
    vectorMatches,
  ]);
  const candidates = new Map<string, StoredPost>();
  for (const group of groups)
    for (const p of group as StoredPost[])
      if (p.id !== excludeId && isPreferencePost(p)) candidates.set(p.key, p);
  const [total, frequencies] = await Promise.all([
    totalRequest,
    Promise.all(documentFrequency),
  ]);
  // Small corpora give unusable frequencies, so fall back to plain token overlap until there is
  // enough history for commonness to mean anything.
  const discriminative = query.filter(
    (_, i) => total < IDF_MIN_CORPUS || frequencies[i] <= total * IDF_MAX_SHARE,
  );
  const lexical = [...candidates.values()]
    .map((post) => {
      const terms = new Set(tokens(preferenceText(post)));
      return { post, score: discriminative.filter((t) => terms.has(t)).length };
    })
    .filter((x) => x.score >= LEXICAL_FLOOR)
    .sort((a, b) => b.score - a.score || b.post.at - a.post.at);
  const dense = [...semantic].sort(
    (a, b) => b.score - a.score || b.post.at - a.post.at,
  );
  // Only posts that cleared a retriever's own floor enter the pool, so "nothing relevant" stays
  // expressible: neither pass backfills the other with its nearest remaining neighbours.
  // Cosine is the primary ranking signal. Rank fusion used to let a weak semantic
  // match outrank a much stronger one merely because it also matched keywords.
  // Keyword-only candidates remain a fallback after the semantic candidates.
  const selected = [
    ...dense.map((x) => x.post),
    ...lexical
      .filter((x) => !dense.some((d) => d.post.key === x.post.key))
      .map((x) => x.post),
  ];
  const lexicalKeys = new Set(lexical.map((x) => x.post.key));
  const semanticKeys = new Set(dense.map((x) => x.post.key));
  const retrievalMethod: RetrievalMethod =
    lexical.length && dense.length
      ? "hybrid"
      : dense.length
        ? "semantic"
        : "lexical";
  // Never mix viewing accounts into a single inferred preference profile.
  const viewers = new Set(selected.map((p) => p.viewer));
  const viewer = [...viewers][0];
  const posts = selected.filter((p) => p.viewer === viewer).slice(0, 12);
  return {
    revision: (await revisionRequest) ?? "empty",
    posts,
    retrievalMethod,
    matchMethods: Object.fromEntries(
      posts.map((post) => [
        post.key,
        semanticKeys.has(post.key)
          ? lexicalKeys.has(post.key)
            ? "hybrid"
            : "semantic"
          : "lexical",
      ]),
    ),
    queryTerms: discriminative,
    // Report scores even for keyword-selected posts below the semantic floor.
    // Previously a hidden below-floor score looked identical to a missing vector.
    similarity: Object.fromEntries(
      posts
        .filter((post) => queryVector && hasCurrentEmbedding(post))
        .map((post) => [
          post.key,
          Number(similarity(queryVector!, post.embedding!).toFixed(4)),
        ]),
    ),
    ready:
      viewers.size === 1 && !viewers.has("unknown") && evidenceReady(posts),
  };
}
/** Preference posts still missing a vector, newest first: the drain works backwards from recent. */
export async function pendingEmbeddings(limit: number): Promise<StoredPost[]> {
  const store = (await database()).transaction("posts").objectStore("posts");
  return new Promise((resolve, reject) => {
    const rows: StoredPost[] = [];
    let scanned = 0;
    const cursor = store.index("preferenceAt").openCursor(null, "prev");
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) {
        resolve(rows);
        return;
      }
      const post = entry.value as StoredPost;
      if (!hasCurrentEmbedding(post)) rows.push(post);
      if (rows.length >= limit || ++scanned >= VECTOR_SCAN_LIMIT) {
        resolve(rows);
        return;
      }
      entry.continue();
    };
  });
}
/** Writes vectors without touching any other field: a concurrent like must win over a stale read. */
export async function saveEmbeddings(
  entries: Array<{ key: string; embedding: Float32Array; text: string }>,
): Promise<void> {
  if (entries.some((entry) => !validEmbedding(entry.embedding)))
    throw new Error("Invalid embedding vector.");
  const tx = (await database()).transaction("posts", "readwrite");
  const completed = done(tx);
  for (const entry of entries) {
    const get = tx.objectStore("posts").get(entry.key);
    get.onsuccess = () => {
      const post = get.result as StoredPost | undefined;
      if (
        !post ||
        !isPreferencePost(post) ||
        preferenceText(post) !== entry.text
      )
        return;
      tx.objectStore("posts").put({
        ...post,
        embedding: entry.embedding,
        embeddingVersion: EMBEDDING_VERSION,
      });
    };
  }
  await completed;
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
    ["events", "posts", "accounts", "meta", "texts"],
    "readwrite",
  );
  const completed = done(tx);
  for (const name of ["events", "posts", "accounts", "meta", "texts"])
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
  const tx = (await database()).transaction([
    "events",
    "posts",
    "accounts",
    "texts",
  ]);
  const completed = done(tx);
  for (const name of ["events", "posts", "accounts"]) {
    const cursor = tx.objectStore(name).openCursor();
    cursor.onsuccess = () => {
      if (cursor.result) {
        const entry = cursor.result;
        const append = (data: unknown) => {
          chunks.push(JSON.stringify({ type: name, data }) + "\n");
          entry.continue();
        };
        if (name === "events") restoreSnapshot(tx, entry.value, append);
        else append(entry.value);
      }
    };
  }
  await completed;
  return new Blob(chunks, { type: "application/x-ndjson" });
}

export type ActivityRow =
  | { kind: "post"; data: StoredPost }
  | { kind: "visit"; data: ActivityEvent };

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
