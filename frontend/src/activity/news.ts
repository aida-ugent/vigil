import { getDomain } from "tldts";
import { database } from "./database";
import { NEWS_CATALOG_KEY } from "./model";

const LATEST =
  "https://api.github.com/repos/yang3kc/list_of_news_domains/commits?path=data/output/news_domains.csv&per_page=1";
const MAX_BYTES = 2_000_000;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const RETRY_AFTER = 6 * 60 * 60 * 1000;
export interface NewsCatalog {
  domains: string[];
  fetchedAt: number;
  version: string;
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
export function parseNewsDomains(csv: string): string[] {
  if (new TextEncoder().encode(csv).byteLength > MAX_BYTES)
    throw new Error("News list too large");
  const lines = csv
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);
  if (lines.shift()?.trim() !== "domain" || lines.length > 100_000)
    throw new Error("Invalid news list");
  const domains = new Set<string>();
  let invalid = 0;
  for (const line of lines) {
    const normalized = domain(line.trim().replace(/^"([^"]+)"$/, "$1"));
    if (normalized) domains.add(normalized);
    else invalid++;
  }
  if (domains.size < 100 || invalid > lines.length / 10)
    throw new Error("Incomplete news list");
  return [...domains].sort();
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
    },
  ) {}
  async matches(url: string): Promise<boolean> {
    const state = await (this.cached ??= this.io.read());
    return (this.matcher ??= newsMatcher(state.catalog))(url);
  }
  refresh(force = false): Promise<NewsCatalogState> {
    return (this.running ??= this.update(force).finally(() => {
      this.running = undefined;
    }));
  }
  private async update(force: boolean): Promise<NewsCatalogState> {
    let state = await this.io.read();
    const now = this.io.now();
    if (
      (!force && state.catalog && now - state.catalog.fetchedAt < MAX_AGE) ||
      (state.attemptedAt !== undefined &&
        now - state.attemptedAt < (force ? 60_000 : RETRY_AFTER))
    )
      return state;
    state = { ...state, attemptedAt: now };
    await this.io.write(state);
    try {
      const options: RequestInit = {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(15_000),
      };
      const metadata = JSON.parse(
        await boundedText(await this.io.fetch(LATEST, options), 100_000),
      );
      const version = Array.isArray(metadata) ? metadata[0]?.sha : undefined;
      if (typeof version !== "string" || !/^[a-f0-9]{40}$/.test(version))
        throw new Error("Invalid news metadata");
      const domains =
        state.catalog?.version === version
          ? state.catalog.domains
          : parseNewsDomains(
              await boundedText(
                await this.io.fetch(
                  `https://raw.githubusercontent.com/yang3kc/list_of_news_domains/${version}/data/output/news_domains.csv`,
                  options,
                ),
                MAX_BYTES,
              ),
            );
      if (state.catalog && domains.length < state.catalog.domains.length / 2)
        throw new Error("Unexpectedly incomplete news list");
      state = {
        attemptedAt: now,
        catalog: { domains, fetchedAt: now, version },
      };
    } catch {
      state = {
        ...state,
        error:
          "News list update failed. The last saved list is still used, if available.",
      };
    }
    await this.io.write(state);
    this.cached = Promise.resolve(state);
    this.matcher = newsMatcher(state.catalog);
    return state;
  }
}
export const newsCatalog = new NewsCatalogService();
