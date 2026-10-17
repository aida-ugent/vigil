import {
  isRuntimeRequestMessage,
  type RuntimeResponseMap,
} from "../shared/messages";
import {
  getActivitySettings,
  cleanUrl,
  ACTIVITY_SETTINGS_KEY,
  type ActivityEvent,
} from "./model";
import { saveEvents, clearActivity } from "./database";

let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse) => {
    if (!isRuntimeRequestMessage(message)) return;
    const respond = (
      payload: RuntimeResponseMap["ACTIVITY_BATCH"]["payload"],
    ): void => {
      sendResponse({
        type: "ACTIVITY_ACK",
        payload,
      } satisfies RuntimeResponseMap["ACTIVITY_BATCH"]);
    };
    if (
      message?.type !== "ACTIVITY_BATCH" &&
      message?.type !== "ACTIVITY_CLEAR"
    )
      return;
    if (sender.id !== chrome.runtime.id || sender.tab?.incognito) {
      respond({ ok: false });
      return;
    }
    void enqueue(async () => {
      if (message.type === "ACTIVITY_CLEAR") {
        if (sender.tab || !sender.url?.startsWith(chrome.runtime.getURL("")))
          throw new Error("Extension page required");
        await clearActivity();
        return { ok: true };
      }
      if (sender.frameId !== 0 || !sender.tab || !sender.url)
        throw new Error("Top-level content script required");
      if (!(await getActivitySettings()).tracking) return { ok: true };
      const parsed = message.payload.events;
      const host = new URL(sender.url).hostname;
      if (!/^(www\.)?(x\.com|twitter\.com)$/.test(host))
        throw new Error("X activity required");
      const events = parsed
        .filter(
          (e) =>
            e.kind !== "visit" &&
            e.post &&
            /^https:\/\/(x\.com|twitter\.com)\//.test(e.post.url),
        )
        .map((e) => ({ ...e, url: cleanUrl(e.url) ?? "https://x.com/" }));
      await saveEvents(events);
      return { ok: true };
    }).then(respond, (error) => {
      console.warn("[Vigil activity] Ingestion failed", error);
      respond({ ok: false, error: "Activity could not be saved." });
    });
    return true;
  },
);

async function visit(tabId: number, url: string, id: string): Promise<void> {
  const normalized = cleanUrl(url);
  if (!normalized) return;
  await enqueue(async () => {
    if (!(await getActivitySettings()).tracking) return;
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito) return;
    const event: ActivityEvent = {
      id: crypto.randomUUID(),
      kind: "visit",
      at: Date.now(),
      url: normalized,
      title: (tab.title ?? "").slice(0, 500),
      session: id.slice(0, 100),
    };
    await saveEvents([event]);
  });
}
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0)
    void visit(
      details.tabId,
      details.url,
      details.documentId ?? crypto.randomUUID(),
    ).catch((error) =>
      console.warn("[Vigil activity] Failed to record navigation", error),
    );
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0)
    void visit(
      details.tabId,
      details.url,
      details.documentId ?? crypto.randomUUID(),
    ).catch((error) =>
      console.warn("[Vigil activity] Failed to record navigation", error),
    );
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area !== "local" ||
    changes[ACTIVITY_SETTINGS_KEY]?.newValue?.tracking !== true ||
    changes[ACTIVITY_SETTINGS_KEY]?.oldValue?.tracking === true
  )
    return;
  void chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .then((tabs) => {
      const tab = tabs[0];
      if (tab?.id && tab.url)
        return visit(tab.id, tab.url, crypto.randomUUID());
    })
    .catch((error) =>
      console.warn("[Vigil activity] Failed to record navigation", error),
    );
});
