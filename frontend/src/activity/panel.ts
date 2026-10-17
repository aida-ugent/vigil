import { sendRuntimeMessage } from "../shared/messages";
import {
  ACTIVITY_SETTINGS_KEY,
  getActivitySettings,
  setActivitySettings,
} from "./model";
import { activitySummary, exportActivity } from "./database";

export function initializeActivityPanel(onInvalidated: () => void): void {
  const tracking = document.querySelector<HTMLInputElement>(
    "#track-interactions",
  )!;
  const confirmation = document.querySelector<HTMLInputElement>(
    "#confirmation-bias-enabled",
  )!;
  const status = document.querySelector<HTMLElement>("#activity-status")!;
  const accounts = document.querySelector<HTMLElement>("#activity-accounts")!;
  async function render(): Promise<void> {
    const settings = await getActivitySettings();
    tracking.checked = settings.tracking;
    confirmation.checked = settings.confirmation;
    const data = await activitySummary();
    status.textContent = `${settings.tracking ? "Tracking on" : "Tracking paused"} · ${data.events} activity records · ${data.posts} posts. ${settings.confirmation ? "Confirmation-bias analysis needs at least 2 distinct relevant liked or self-authored posts. Unknown or mixed viewing identities are not analyzed." : "Confirmation-bias analysis off."}`;
    accounts.replaceChildren();
    for (const [label, metric] of [
      ["Most seen on your home feed", "feedExposures"],
      ["Most seen across X", "exposures"],
      ["Most liked", "likes"],
    ] as const) {
      const heading = document.createElement("p");
      heading.textContent = label;
      accounts.append(heading);
      const list = document.createElement("ol");
      for (const row of data.accounts
        .filter((a) => a[metric] > 0)
        .sort((a, b) => b[metric] - a[metric])
        .slice(0, 10)) {
        const item = document.createElement("li");
        item.textContent = `@${row.author}: ${row[metric]} (viewing as @${row.viewer})`;
        list.append(item);
      }
      accounts.append(list);
    }
  }
  function fail(error: unknown): void {
    status.textContent =
      error instanceof Error ? error.message : "Activity operation failed.";
  }
  for (const [input, key] of [
    [tracking, "tracking"],
    [confirmation, "confirmation"],
  ] as const) {
    input.addEventListener("change", () => {
      input.disabled = true;
      void setActivitySettings({ [key]: input.checked })
        .then(render)
        .catch(fail)
        .finally(() => {
          input.disabled = false;
        });
    });
  }
  document.querySelector("#activity-browse")!.addEventListener("click", () => {
    void chrome.tabs
      .create({ url: chrome.runtime.getURL("src/activity/index.html") })
      .catch(fail);
  });
  document.querySelector("#activity-refresh")!.addEventListener("click", () => {
    void render().catch(fail);
  });
  document.querySelector("#activity-export")!.addEventListener("click", () => {
    void exportActivity()
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `vigil-activity-${new Date().toISOString().slice(0, 10)}.jsonl`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })
      .catch(fail);
  });
  document.querySelector("#activity-delete")!.addEventListener("click", () => {
    if (
      !window.confirm(
        "Delete all stored activity and pause tracking? This cannot be undone.",
      )
    )
      return;
    void (async () => {
      await setActivitySettings({ tracking: false });
      const response = await sendRuntimeMessage({ type: "ACTIVITY_CLEAR" });
      if (!response.payload.ok)
        throw new Error("Activity could not be deleted.");
      onInvalidated();
      await render();
    })().catch(fail);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[ACTIVITY_SETTINGS_KEY]) {
      onInvalidated();
      void render().catch(fail);
    }
  });
  void render().catch(fail);
}
