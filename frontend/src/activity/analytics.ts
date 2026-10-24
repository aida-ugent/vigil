import { restoreSnapshot } from "./snapshots";
import type { ActivityEvent } from "./model";
import { database } from "./database";

export interface DashboardFilter {
  from: number;
  to: number;
  viewer: string;
  surface: "all" | "home-feed";
}
export interface AccountMetric {
  author: string;
  exposures: number;
  uniqueSeen: number;
  likedPosts: number;
  likeActions: number;
  unlikeActions: number;
}
export interface DailyMetric {
  day: string;
  exposures: number;
  likeActions: number;
}
export interface DashboardSummary {
  exposures: number;
  uniqueSeen: number;
  likedPosts: number;
  likeActions: number;
  unlikeActions: number;
  accounts: AccountMetric[];
  days: DailyMetric[];
  domains: Array<{ domain: string; visits: number }>;
  visits: number;
  viewers: string[];
}
export interface RecordFilter extends DashboardFilter {
  kind: "all" | "exposure" | "like" | "unlike" | "visit";
  author: string;
  query: string;
  day: string;
  domain: string;
}
export interface EventCursor {
  at: number;
  id: string;
}
export interface EventPage {
  rows: ActivityEvent[];
  next?: EventCursor;
}
export function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function matchesX(
  event: ActivityEvent,
  filter: DashboardFilter,
): boolean {
  return (
    !!event.post &&
    (!filter.viewer || event.post.viewer === filter.viewer) &&
    (filter.surface === "all" || event.context === filter.surface)
  );
}

/** Stream events into aggregates. Text snapshots are not retained in summary memory. */
export function createSummary(filter: DashboardFilter) {
  const accounts = new Map<string, AccountMetric>();
  const seen = new Set<string>(),
    liked = new Set<string>(),
    viewers = new Set<string>();
  const days = new Map<string, DailyMetric>(),
    domains = new Map<string, number>();
  let visits = 0;
  function add(event: ActivityEvent): void {
    if (event.at < filter.from || event.at > filter.to) return;
    if (event.kind === "visit") {
      try {
        const domain = new URL(event.url).hostname;
        domains.set(domain, (domains.get(domain) ?? 0) + 1);
        visits++;
      } catch {
        /* Invalid legacy URL. */
      }
      return;
    }
    if (event.post) viewers.add(event.post.viewer);
    if (!matchesX(event, filter)) return;
    const post = event.post!;
    const account = accounts.get(post.author) ?? {
      author: post.author,
      exposures: 0,
      uniqueSeen: 0,
      likedPosts: 0,
      likeActions: 0,
      unlikeActions: 0,
    };
    const day = localDay(event.at);
    const daily = days.get(day) ?? { day, exposures: 0, likeActions: 0 };
    const key = `${post.viewer}:${post.author}:${post.id}`;
    if (event.kind === "exposure") {
      account.exposures++;
      daily.exposures++;
      if (!seen.has(key)) {
        seen.add(key);
        account.uniqueSeen++;
      }
    } else if (event.kind === "like") {
      account.likeActions++;
      daily.likeActions++;
      if (!liked.has(key)) {
        liked.add(key);
        account.likedPosts++;
      }
    } else if (event.kind === "unlike") account.unlikeActions++;
    accounts.set(post.author, account);
    days.set(day, daily);
  }
  function result(): DashboardSummary {
    const rows = [...accounts.values()];
    return {
      exposures: rows.reduce((n, a) => n + a.exposures, 0),
      uniqueSeen: seen.size,
      likedPosts: liked.size,
      likeActions: rows.reduce((n, a) => n + a.likeActions, 0),
      unlikeActions: rows.reduce((n, a) => n + a.unlikeActions, 0),
      accounts: rows.sort((a, b) => a.author.localeCompare(b.author)),
      days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
      domains: [...domains]
        .map(([domain, visits]) => ({ domain, visits }))
        .sort(
          (a, b) => b.visits - a.visits || a.domain.localeCompare(b.domain),
        ),
      visits,
      viewers: [...viewers].sort(),
    };
  }
  return { add, result };
}
function range(filter: DashboardFilter): IDBKeyRange {
  if (
    !Number.isFinite(filter.from) ||
    !Number.isFinite(filter.to) ||
    filter.from < 0 ||
    filter.from > filter.to
  )
    throw new Error("Choose a valid date range.");
  return IDBKeyRange.bound(filter.from, filter.to);
}
export async function dashboardSummary(
  filter: DashboardFilter,
  cancelled = () => false,
): Promise<DashboardSummary> {
  range(filter);
  const accumulator = createSummary(filter);
  // Separate short transactions let queued activity writes proceed between batches.
  // These live statistics may include activity committed while the scan is in progress.
  let after: EventCursor | undefined;
  do {
    if (cancelled()) throw new Error("Cancelled");
    const page = await readEventPage(
      {
        ...filter,
        viewer: "",
        surface: "all",
        kind: "all",
        author: "",
        query: "",
        day: "",
        domain: "",
      },
      after,
      cancelled,
      500,
      false,
    );
    page.rows.forEach(accumulator.add);
    after = page.next;
  } while (after);
  return accumulator.result();
}

export function matchesRecord(
  event: ActivityEvent,
  filter: RecordFilter,
): boolean {
  if (event.at < filter.from || event.at > filter.to) return false;
  if (filter.kind !== "all" && event.kind !== filter.kind) return false;
  if (filter.day && localDay(event.at) !== filter.day) return false;
  if (event.kind === "visit") {
    if (filter.author) return false;
    if (filter.domain) {
      try {
        if (new URL(event.url).hostname !== filter.domain) return false;
      } catch {
        return false;
      }
    }
  } else {
    if (filter.domain || !matchesX(event, filter)) return false;
    if (
      filter.author &&
      event.post!.author !== filter.author.replace(/^@/, "").toLowerCase()
    )
      return false;
  }
  const query = filter.query.trim().toLowerCase();
  return (
    !query ||
    `${event.post?.text ?? ""} ${event.title ?? ""} ${event.url} ${event.post?.author ?? ""}`
      .toLowerCase()
      .includes(query)
  );
}
/** Descending index cursor, with a bounded scan per page and stable tie handling. */
export async function dashboardRecords(
  filter: RecordFilter,
  after?: EventCursor,
  cancelled = () => false,
): Promise<EventPage> {
  return readEventPage(filter, after, cancelled, 50);
}
async function readEventPage(
  filter: RecordFilter,
  after: EventCursor | undefined,
  cancelled: () => boolean,
  pageSize: number,
  includeText = true,
): Promise<EventPage> {
  const keyRange = range({
    ...filter,
    to: Math.min(filter.to, after?.at ?? filter.to),
  });
  const tx = (await database()).transaction(["events", "texts"]);
  return new Promise((resolve, reject) => {
    const rows: ActivityEvent[] = [];
    let scanned = 0;
    const req = tx
      .objectStore("events")
      .index("at")
      .openCursor(keyRange, "prev");
    tx.onabort = () => reject(new Error("Cancelled"));
    tx.onerror = () => reject(tx.error);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      if (cancelled()) {
        tx.abort();
        return;
      }
      const cursor = req.result;
      if (!cursor) {
        resolve({ rows });
        return;
      }
      const event = cursor.value as ActivityEvent;
      if (after && event.at === after.at) {
        const comparison = indexedDB.cmp(cursor.primaryKey, after.id);
        if (comparison > 0) {
          cursor.continuePrimaryKey(cursor.key, after.id);
          return;
        }
        if (comparison === 0) {
          cursor.continue();
          return;
        }
      }
      const accept = (restored: ActivityEvent) => {
        if (matchesRecord(restored, filter)) rows.push(restored);
        if (rows.length >= pageSize || ++scanned >= 2000) {
          resolve({ rows, next: { at: event.at, id: event.id } });
          return;
        }
        cursor.continue();
      };
      if (includeText) restoreSnapshot(tx, event, accept);
      else accept(event);
    };
  });
}
