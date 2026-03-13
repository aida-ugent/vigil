import type { Finding } from "./findings";
import type { CacheEntry, CacheStats, ContentPlatform } from "./content";
import { cacheTextHash, normalizeWhitespace } from "./utils";

const CACHE_KEY = "vigil_analysis_cache_v1";
const MAX_ENTRIES = 500;
const TTL_MS = 24 * 60 * 60 * 1000;

/** In-memory cache to avoid full deserialization on every operation. */
let memCache: CacheEntry[] | null = null;
let memCacheDirty = false;

async function loadAll(): Promise<CacheEntry[]> {
  if (memCache !== null) return memCache;
  try {
    const data = await chrome.storage.local.get(CACHE_KEY);
    const raw = data[CACHE_KEY];
    if (Array.isArray(raw)) {
      memCache = raw as CacheEntry[];
      return memCache;
    }
  } catch (error) {
    console.warn("[Vigil cache] Failed to load cache", error);
  }
  memCache = [];
  return memCache;
}

async function persistIfDirty(): Promise<void> {
  if (!memCacheDirty || !memCache) return;
  const pruned = memCache
    .sort((a, b) => b.analyzedAt - a.analyzedAt)
    .slice(0, MAX_ENTRIES);
  memCache = pruned;
  memCacheDirty = false;
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: pruned });
  } catch (error) {
    console.warn("[Vigil cache] Failed to save cache", error);
  }
}

function markDirty(): void {
  memCacheDirty = true;
  // Flush on next microtask to batch multiple writes
  void Promise.resolve().then(persistIfDirty);
}

/**
 * Persistent analysis cache backed by chrome.storage.local with an
 * in-memory hot cache. Keyed by content ID; validated by text hash,
 * analyzer mode, sensitivity, and TTL so stale or mismatched entries
 * are treated as cache misses.
 */
export const cacheManager = {
  async get(
    id: string,
    text: string,
    analyzerMode: string,
    sensitivity: number,
    pluginIds?: string[],
  ): Promise<CacheEntry | null> {
    const entries = await loadAll();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return null;

    const currentHash = cacheTextHash(text);
    if (entry.textHash !== currentHash) return null;

    if (Date.now() - entry.analyzedAt > TTL_MS) return null;

    if (entry.analyzerMode !== analyzerMode) return null;
    if (entry.sensitivity !== sensitivity) return null;

    if (pluginIds) {
      const cached = [...(entry.pluginIds ?? [])].sort().join(",");
      const requested = [...pluginIds].sort().join(",");
      if (cached !== requested) return null;
    }

    return entry;
  },

  async set(
    id: string,
    text: string,
    pageUrl: string,
    platform: ContentPlatform,
    findings: Finding[],
    tips: string[],
    pluginIds: string[],
    analyzerMode: string,
    sensitivity: number,
  ): Promise<void> {
    const entries = await loadAll();
    const idx = entries.findIndex((e) => e.id === id);
    const normalized = normalizeWhitespace(text);
    const entry: CacheEntry = {
      id,
      text: normalized,
      textHash: cacheTextHash(text),
      pageUrl,
      platform,
      findings,
      tips,
      pluginIds,
      analyzerMode,
      sensitivity,
      analyzedAt: Date.now(),
    };

    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }

    markDirty();
  },

  async remove(id: string): Promise<void> {
    const entries = await loadAll();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      entries.splice(idx, 1);
      markDirty();
    }
  },

  async getAll(): Promise<CacheEntry[]> {
    return loadAll();
  },

  async getForPage(pageUrl: string): Promise<CacheEntry[]> {
    const entries = await loadAll();
    return entries.filter((e) => e.pageUrl === pageUrl);
  },

  async clear(): Promise<void> {
    memCache = [];
    memCacheDirty = false;
    try {
      await chrome.storage.local.set({ [CACHE_KEY]: [] });
    } catch (error) {
      console.warn("[Vigil cache] Failed to clear cache", error);
    }
  },

  async clearForPage(pageUrl: string): Promise<void> {
    const entries = await loadAll();
    const before = entries.length;
    memCache = entries.filter((e) => e.pageUrl !== pageUrl);
    if (memCache.length !== before) markDirty();
  },

  async getStats(pageUrl?: string): Promise<CacheStats> {
    const entries = await loadAll();
    const forPage = pageUrl
      ? entries.filter((e) => e.pageUrl === pageUrl)
      : [];
    const oldest = entries.length > 0
      ? Math.min(...entries.map((e) => e.analyzedAt))
      : null;
    return {
      totalEntries: entries.length,
      entriesForPage: forPage.length,
      oldestTimestamp: oldest,
    };
  },

  async updateFindings(
    id: string,
    findings: Finding[],
    tips: string[],
  ): Promise<void> {
    const entries = await loadAll();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return;
    entry.findings = findings;
    entry.tips = tips;
    entry.analyzedAt = Date.now();
    markDirty();
  },

  async removeFinding(id: string, findingIndex: number): Promise<Finding[] | null> {
    const entries = await loadAll();
    const entry = entries.find((e) => e.id === id);
    if (!entry) return null;
    if (findingIndex < 0 || findingIndex >= entry.findings.length) return null;
    entry.findings.splice(findingIndex, 1);
    entry.analyzedAt = Date.now();
    markDirty();
    return entry.findings;
  },

  /** Invalidate the in-memory cache (e.g. after external storage changes). */
  invalidate(): void {
    memCache = null;
    memCacheDirty = false;
  },
};
