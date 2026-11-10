import { getDomain } from "tldts";
import { getSettings } from "../shared/settingsStorage";
import { database } from "./database";
import { NEWS_CATALOG_KEY } from "./model";

const MAX_BYTES = 8_000_000;
export interface NewsCatalog {
  domains: string[];
  fetchedAt: number;
  version: string;
  source?: "mediacloud";
  scope?: "geographic-publishers-v1";
  publishedAt?: string;
}
export interface NewsCatalogState {
  catalog?: NewsCatalog;
  attemptedAt?: number;
  error?: string;
}
export async function readNewsState(): Promise<NewsCatalogState> {
  const req = (await database())
    .transaction("meta")
    .objectStore("meta")
    .get(NEWS_CATALOG_KEY);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ?? {});
    req.onerror = () => reject(req.error);
  });
}
async function writeNewsState(state: NewsCatalogState): Promise<void> {
  const tx = (await database()).transaction("meta", "readwrite");
  tx.objectStore("meta").put(state, NEWS_CATALOG_KEY);
  tx.objectStore("meta").delete("newsCatalogV1");
  tx.objectStore("meta").delete("mediaCloudCatalogV1");
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
function domain(value: string): string | null {
  if (!value || value.length > 253 || /[\s/:@?#\\]/.test(value)) return null;
  try {
    const host = new URL(`https://${value}`).hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .replace(/\.$/, "");
    if (
      !/^[a-z0-9.-]+$/.test(host) ||
      host
        .split(".")
        .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
      return null;
    return getDomain(host, { allowPrivateDomains: true }) ? host : null;
  } catch {
    return null;
  }
}
export function parseNewsCatalog(text: string): NewsCatalog {
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES)
    throw new Error("News list too large");
  const data = JSON.parse(text);
  if (
    data?.source !== "mediacloud" ||
    data.scope !== "geographic-publishers-v1" ||
    typeof data.publishedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(data.publishedAt) ||
    typeof data.version !== "string" ||
    !/^mediacloud-curated:[a-f0-9]{64}$/.test(data.version) ||
    !Number.isFinite(data.fetchedAt) ||
    data.fetchedAt <= 0 ||
    !Array.isArray(data.domains) ||
    data.domains.length < 100 ||
    data.domains.length > 200_000
  )
    throw new Error("Invalid Media Cloud snapshot");
  const domains = new Set<string>();
  for (const value of data.domains) {
    if (typeof value !== "string") throw new Error("Invalid news domain");
    const normalized = domain(value);
    // Public suffixes and shared-hosting roots must never become allowlist entries.
    if (normalized) domains.add(normalized);
  }
  if (domains.size < 100 || domains.size < data.domains.length * 0.9)
    throw new Error("Incomplete news list");
  return {
    source: "mediacloud",
    scope: "geographic-publishers-v1",
    publishedAt: data.publishedAt,
    domains: [...domains].sort(),
    fetchedAt: data.fetchedAt,
    version: data.version,
  };
}
export function newsMatcher(catalog?: NewsCatalog): (url: string) => boolean {
  const domains = new Set(catalog?.domains ?? []);
  return (url: string) => {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return false;
      let host = parsed.hostname.toLowerCase().replace(/\.$/, "");
      const root = getDomain(host, { allowPrivateDomains: true });
      // X has its own interaction collector; do not also log generic page visits.
      if (!root || root === "x.com" || root === "twitter.com") return false;
      while (true) {
        if (domains.has(host)) return true;
        if (host === root) return false;
        host = host.slice(host.indexOf(".") + 1);
      }
    } catch {
      return false;
    }
  };
}
async function boundedText(response: Response, limit: number): Promise<string> {
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("Content-Length")) > limit
  )
    throw new Error("News download failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("News download too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Only the background owns refreshes; navigation uses an in-memory matcher, never a network lookup. */
export class NewsCatalogService {
  private cached: Promise<NewsCatalogState> | undefined;
  private matcher: ((url: string) => boolean) | undefined;
  private running: Promise<NewsCatalogState> | undefined;
  constructor(
    private readonly io = {
      read: readNewsState,
      write: writeNewsState,
      fetch: globalThis.fetch.bind(globalThis),
      now: Date.now,
      endpoint: async () => {
        const { serverUrl } = await getSettings();
        return `${serverUrl.replace(/\/+$/, "")}/news/sources`;
      },
    },
  ) {}
  async matches(url: string): Promise<boolean> {
    const state = await (this.cached ??= this.io.read());
    return (this.matcher ??= newsMatcher(state.catalog))(url);
  }
  refresh(): Promise<NewsCatalogState> {
    return (this.running ??= this.update().finally(() => {
      this.running = undefined;
    }));
  }
  private async update(): Promise<NewsCatalogState> {
    let state = await this.io.read();
    const now = this.io.now();
    state = { ...state, attemptedAt: now };
    await this.io.write(state);
    try {
      const options: RequestInit = {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(15_000),
      };
      const catalog = parseNewsCatalog(
        await boundedText(
          await this.io.fetch(await this.io.endpoint(), options),
          MAX_BYTES,
        ),
      );
      if (
        state.catalog &&
        catalog.domains.length < state.catalog.domains.length / 2
      )
        throw new Error("Unexpectedly incomplete news list");
      state = { attemptedAt: now, catalog };
    } catch {
      state = {
        ...state,
        error:
          "Media Cloud download failed. The last saved Media Cloud list is still used, if available.",
      };
    }
    await this.io.write(state);
    this.cached = Promise.resolve(state);
    this.matcher = newsMatcher(state.catalog);
    return state;
  }
}
export const newsCatalog = new NewsCatalogService();
