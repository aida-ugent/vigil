import { newsCatalog } from "./news";
import { pruneNonNewsVisits } from "./maintenance";
import { maintainActivity } from "./maintenance";
import {
  isRuntimeRequestMessage,
  type RuntimeResponseMap,
} from "../shared/messages";
import {
  getActivitySettings,
  isTrackingEnabled,
  cleanUrl,
  ACTIVITY_SETTINGS_KEY,
  type ActivityEvent,
} from "./model";
import { saveEvents, clearActivity } from "./database";

const VISIT_TAB_PREFIX = "vigilNewsVisitTab:";
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
        const session = await chrome.storage.session.get(null);
        await chrome.storage.session.remove(
          Object.keys(session).filter((key) => key.startsWith(VISIT_TAB_PREFIX)),
        );
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

export async function recordNewsVisit(
  tabId: number,
  url: string,
  id: string,
): Promise<void> {
  const normalized = cleanUrl(url);
  await enqueue(async () => {
    const tab = await chrome.tabs.get(tabId);
    if (tab.incognito || tab.url !== url) return;
    const key = `${VISIT_TAB_PREFIX}${tabId}`;
    if (
      !normalized ||
      !(await getActivitySettings()).tracking ||
      !(await newsCatalog.matches(normalized))
    ) {
      // Leaving a news page permits a later return to count again. Do not
      // retain URLs for non-news pages or activity while tracking is paused.
      await chrome.storage.session.remove(key);
      return;
    }
    // Session storage survives worker suspension and reloads, but not browser
    // restarts. cleanUrl strips queries/fragments that sites churn via history.
    const previous = await chrome.storage.session.get(key);
    if (previous[key] === normalized) return;
    const event: ActivityEvent = {
      id: crypto.randomUUID(),
      kind: "visit",
      at: Date.now(),
      url: normalized,
      title: (tab.title ?? "").slice(0, 500),
      session: id.slice(0, 100),
    };
    await saveEvents([event]);
    await chrome.storage.session.set({ [key]: normalized });
  });
}
chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueue(() => chrome.storage.session.remove(`${VISIT_TAB_PREFIX}${tabId}`))
    .catch((error) => console.warn("[Vigil activity] Failed to clear tab state", error));
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0)
    void recordNewsVisit(
      details.tabId,
      details.url,
      details.documentId ?? crypto.randomUUID(),
    ).catch((error) =>
      console.warn("[Vigil activity] Failed to record navigation", error),
    );
});
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0)
    void recordNewsVisit(
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
    !isTrackingEnabled(changes[ACTIVITY_SETTINGS_KEY]?.newValue) ||
    isTrackingEnabled(changes[ACTIVITY_SETTINGS_KEY]?.oldValue)
  )
    return;
  void chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .then((tabs) => {
      const tab = tabs[0];
      if (tab?.id && tab.url)
        return recordNewsVisit(tab.id, tab.url, crypto.randomUUID());
    })
    .catch((error) =>
      console.warn("[Vigil activity] Failed to record navigation", error),
    );
});

// Alarms survive worker suspension; recreate if Chrome has cleared them on restart.
const MAINTENANCE_ALARM = "vigil-activity-maintenance";
function maintenance(): void {
  void maintainActivity().catch((error) =>
    console.warn("[Vigil activity] Maintenance failed", error),
  );
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === MAINTENANCE_ALARM) maintenance();
});
async function initializeMaintenance(): Promise<void> {
  await chrome.alarms.create(MAINTENANCE_ALARM, { periodInMinutes: 60 });
  maintenance();
}
function scheduleMaintenance(): void {
  void initializeMaintenance().catch((error) =>
    console.warn("[Vigil activity] Maintenance could not be scheduled", error),
  );
}
chrome.runtime.onInstalled.addListener(scheduleMaintenance);
chrome.runtime.onStartup.addListener(scheduleMaintenance);
void chrome.alarms
  .get(MAINTENANCE_ALARM)
  .then((alarm) => {
    if (!alarm) return initializeMaintenance();
  })
  .catch((error) =>
    console.warn("[Vigil activity] Maintenance could not be scheduled", error),
  );

async function refreshNews(): Promise<void> {
  const state = await newsCatalog.refresh();
  if (state.catalog) await pruneNonNewsVisits(state.catalog);
}
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install" && details.reason !== "update") return;
  void refreshNews().catch((error) =>
    console.warn("[Vigil news] Could not refresh news list", error),
  );
});
