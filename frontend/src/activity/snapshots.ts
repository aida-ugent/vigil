import type { ActivityEvent } from "./model";

/** Internal disk representation. Public readers restore the original text. */
export interface StoredEvent extends ActivityEvent {
  textKey?: string;
}
export async function snapshotKey(text: string): Promise<string | undefined> {
  const bytes = new TextEncoder().encode(text);
  // A reference and its object overhead can exceed a short post's entire text.
  if (bytes.byteLength < 128) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
const pendingTexts = new WeakMap<IDBTransaction, Set<string>>();

export function storeSnapshot(
  tx: IDBTransaction,
  event: ActivityEvent,
  key?: string,
): StoredEvent {
  if (!event.post || !key) return event;
  let pending = pendingTexts.get(tx);
  if (!pending) {
    pending = new Set();
    pendingTexts.set(tx, pending);
  }
  if (!pending.has(key)) {
    pending.add(key);
    const store = tx.objectStore("texts");
    const req = store.getKey(key);
    req.onsuccess = () => {
      if (req.result === undefined) store.put({ key, text: event.post!.text });
    };
  }
  return { ...event, post: { ...event.post, text: "" }, textKey: key };
}
/** Keep the read transaction active by continuing from the IDB callback. */
export function restoreSnapshot(
  tx: IDBTransaction,
  event: StoredEvent,
  accept: (event: ActivityEvent) => void,
): void {
  const { textKey, ...original } = event;
  if (!textKey || !event.post) {
    accept(original);
    return;
  }
  const req = tx.objectStore("texts").get(textKey);
  req.onsuccess = () => {
    if (!req.result) {
      tx.abort();
      return;
    }
    accept({ ...original, post: { ...event.post!, text: req.result.text } });
  };
}
