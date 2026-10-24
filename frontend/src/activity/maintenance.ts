import { database } from "./database";
import { snapshotKey, storeSnapshot, type StoredEvent } from "./snapshots";

const BATCH = 200;
const COMPACTION_CURSOR = "snapshotCompactionCursor";
const COMPACTION_DONE = "snapshotCompactionDone";

function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error("Maintenance transaction failed"));
  });
}

/** Same UTC time one calendar month ago, clamped to the last day of that month. */
export function visitCutoff(now: number): number {
  const date = new Date(now);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

/** Short transactions delete only expired visits; no X records or evidence are touched. */
export async function pruneVisits(now = Date.now()): Promise<number> {
  const db = await database();
  const cutoff = visitCutoff(now);
  let total = 0;
  let count: number;
  do {
    count = 0;
    const tx = db.transaction("events", "readwrite");
    const finished = complete(tx);
    const req = tx
      .objectStore("events")
      .index("kindAt")
      .openCursor(
        IDBKeyRange.bound(["visit", 0], ["visit", cutoff], false, true),
      );
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      cursor.delete();
      count++;
      if (count < BATCH) cursor.continue();
    };
    await finished;
    total += count;
    if (count === BATCH) await new Promise((resolve) => setTimeout(resolve, 0));
  } while (count === BATCH);
  return total;
}

/** Resume legacy snapshot compaction across worker shutdowns. Never re-ingest events or alter counts. */
export async function compactSnapshots(maxBatches = 100): Promise<void> {
  const db = await database();
  for (let batch = 0; batch < maxBatches; batch++) {
    const meta = db.transaction("meta").objectStore("meta");
    const [finished, after] = await Promise.all([
      read(meta.get(COMPACTION_DONE)),
      read(meta.get(COMPACTION_CURSOR)),
    ]);
    if (finished) return;
    const events: StoredEvent[] = await read(
      db
        .transaction("events")
        .objectStore("events")
        .getAll(after ? IDBKeyRange.lowerBound(after, true) : undefined, BATCH),
    );
    const keys = await Promise.all(
      events.map((event) =>
        event.post && !event.textKey ? snapshotKey(event.post.text) : undefined,
      ),
    );
    const tx = db.transaction(["events", "texts", "meta"], "readwrite");
    const done = complete(tx);
    events.forEach((event, i) => {
      if (!keys[i]) return;
      // Deletion may have happened while hashing. Never resurrect a removed event.
      const req = tx.objectStore("events").get(event.id);
      req.onsuccess = () => {
        if (req.result && !req.result.textKey)
          tx.objectStore("events").put(storeSnapshot(tx, req.result, keys[i]));
      };
    });
    if (events.length)
      tx.objectStore("meta").put(events.at(-1)!.id, COMPACTION_CURSOR);
    if (events.length < BATCH)
      tx.objectStore("meta").put(true, COMPACTION_DONE);
    await done;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

let running: Promise<void> | undefined;
export function maintainActivity(): Promise<void> {
  return (running ??= (async () => {
    await pruneVisits();
    await compactSnapshots();
  })().finally(() => {
    running = undefined;
  }));
}
