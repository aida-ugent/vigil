import { database } from "../activity/database";
import { EMBEDDING_DIMS, EMBEDDING_VERSION } from "../activity/model";

function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Counts use indexes; no post text, vectors or browsing URLs are loaded for diagnostics. */
export async function storageDiagnostics() {
  const tx = (await database()).transaction([
    "events",
    "posts",
    "accounts",
    "texts",
  ]);
  const events = tx.objectStore("events");
  const [visits, exposures, likes, posts, accounts, snapshots, vectors] =
    await Promise.all([
      ...["visit", "exposure", "like"].map((kind) =>
        read(events.index("kind").count(kind)),
      ),
      read(tx.objectStore("posts").count()),
      read(tx.objectStore("accounts").count()),
      read(tx.objectStore("texts").count()),
      read(
        tx
          .objectStore("posts")
          .index("embeddingVersion")
          .count(EMBEDDING_VERSION),
      ),
    ]);
  const [localBytes, analysisBytes, estimate] = await Promise.all([
    chrome.storage.local.getBytesInUse(null),
    chrome.storage.local.getBytesInUse("vigil_analysis_cache_v1"),
    navigator.storage?.estimate?.().catch(() => undefined),
  ]);
  return {
    visits,
    exposures,
    likes,
    posts,
    accounts,
    snapshots,
    vectors,
    vectorBytes: vectors * EMBEDDING_DIMS * Float32Array.BYTES_PER_ELEMENT,
    localBytes,
    analysisBytes,
    webBytes: estimate?.usage,
    quotaBytes: estimate?.quota,
  };
}

export function createStorageDiagnostics(): HTMLElement {
  const details = document.createElement("details");
  details.className = "disclosure";
  const summary = document.createElement("summary");
  summary.className = "disclosure-trigger";
  summary.textContent = "Storage usage and record counts";
  const content = document.createElement("pre");
  content.setAttribute("aria-live", "polite");
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "btn btn-ghost btn-xs";
  refresh.textContent = "Refresh storage usage";
  let busy = false;
  const mib = (bytes: number | undefined) =>
    bytes === undefined
      ? "Unavailable"
      : `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  async function render(): Promise<void> {
    if (busy) return;
    busy = refresh.disabled = true;
    content.textContent = "Reading storage usage…";
    try {
      const data = await storageDiagnostics();
      content.textContent = [
        `Extension web storage (estimate): ${mib(data.webBytes)}`,
        `Web storage quota (estimate): ${mib(data.quotaBytes)}`,
        `Chrome local storage: ${mib(data.localBytes)}`,
        `  Analysis cache: ${mib(data.analysisBytes)} (included above)`,
        "Web storage includes IndexedDB and model caches; installed extension files and RAM are excluded. These figures are not a single combined total.",
        "",
        `Website visits: ${data.visits.toLocaleString()}`,
        `X exposure events: ${data.exposures.toLocaleString()}`,
        `Saved likes: ${data.likes.toLocaleString()}`,
        `Stored X posts: ${data.posts.toLocaleString()}`,
        `Account records: ${data.accounts.toLocaleString()}`,
        `Shared text snapshots: ${data.snapshots.toLocaleString()}`,
        `Current embeddings: ${data.vectors.toLocaleString()} (${mib(data.vectorBytes)} raw vectors; metadata excluded)`,
        "",
        "Website visits older than one calendar month are removed at startup/update and during hourly maintenance. X activity is retained. Existing snapshots are compacted in resumable batches.",
      ].join("\n");
    } catch {
      content.textContent = "Storage usage could not be read. Try refreshing.";
    } finally {
      busy = refresh.disabled = false;
    }
  }
  details.addEventListener("toggle", () => {
    if (details.open) void render();
  });
  refresh.addEventListener("click", () => {
    void render();
  });
  details.append(summary, refresh, content);
  return details;
}
