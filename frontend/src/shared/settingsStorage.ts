import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  type VigilSettings,
  normalizeSettings,
} from "./settings";

type SettingsListener = (settings: VigilSettings) => void;

const listeners = new Set<SettingsListener>();
let storageListenerInstalled = false;

function notify(settings: VigilSettings): void {
  for (const listener of listeners) {
    listener(settings);
  }
}

function ensureStorageListener(): void {
  if (storageListenerInstalled) {
    return;
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync" || !changes[SETTINGS_KEY]) {
      return;
    }

    const nextSettings = normalizeSettings(changes[SETTINGS_KEY].newValue);
    notify(nextSettings);
  });

  storageListenerInstalled = true;
}

/**
 * Loads settings from sync storage and guarantees a normalized result.
 * If storage is empty, defaults are persisted immediately.
 */
export async function getSettings(): Promise<VigilSettings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  const settings = normalizeSettings(result[SETTINGS_KEY]);

  if (!result[SETTINGS_KEY]) {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  }

  return settings;
}

/**
 * Merges a partial patch into current settings and persists the result.
 * Uses normalizeSettings() to keep schema-safe values in storage.
 */
export async function updateSettings(
  patch: Partial<VigilSettings>,
): Promise<VigilSettings> {
  const current = await getSettings();
  const next = normalizeSettings({
    ...current,
    ...patch,
  });

  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  // Immediate local notification keeps UI responsive even before other
  // contexts process chrome.storage.onChanged.
  notify(next);
  return next;
}

/**
 * Subscribes to settings updates from both local writes and storage events.
 * Returns an unsubscribe callback for cleanup.
 */
export function subscribeSettings(listener: SettingsListener): () => void {
  ensureStorageListener();
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/** Resets settings to defaults and persists them to sync storage. */
export async function resetSettings(): Promise<VigilSettings> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  notify(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}
