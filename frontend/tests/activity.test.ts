import { eng } from "stopword";
import type { LLMService } from "../src/llm/types";
import { ConfirmationAnalysisService } from "../src/sidepanel/confirmationAnalysisService";
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import "fake-indexeddb/auto";
import { IDBIndex } from "fake-indexeddb";
import { isRuntimeRequestMessage } from "../src/shared/messages";
import { JSDOM } from "jsdom";
import {
  saveEvents,
  clearActivity,
  related,
  activitySummary,
  exportActivity,
  revision,
  browseActivity,
} from "../src/activity/database";
import {
  cleanUrl,
  tokens,
  eventSchema,
  type ActivityEvent,
} from "../src/activity/model";
import { detectConfirmationBias } from "../src/plugins/confirmationBias";
import { startActivityCollection } from "../src/activity/collector";
Object.defineProperty(globalThis, "crypto", { value: webcrypto });
function event(
  kind: ActivityEvent["kind"],
  id = "123",
  at = Date.now(),
  author = "alice",
): ActivityEvent {
  return {
    id: crypto.randomUUID(),
    kind,
    at,
    url: "https://x.com/home",
    session: "session",
    post: {
      id,
      author,
      viewer: "reader",
      text: "Solar energy climate research supports renewable investment",
      url: `https://x.com/${author}/status/${id}`,
    },
  };
}
async function seed() {
  await clearActivity();
  await saveEvents(
    Array.from({ length: 6 }, (_, i) =>
      event(
        "like",
        `${100 + i}`,
        Date.UTC(2026, 9, 1 + (i % 2)),
        i % 2 ? "alice" : "bob",
      ),
    ),
  );
}
test("upgrades existing activity without losing likes and makes them available to author fallback", async () => {
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open("vigil-activity", 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      const events = db.createObjectStore("events", { keyPath: "id" }); events.createIndex("at", "at"); events.createIndex("kind", "kind");
      const posts = db.createObjectStore("posts", { keyPath: "key" });
      posts.createIndex("author", "author"); posts.createIndex("tokens", "tokens", { multiEntry: true }); posts.createIndex("likedTokens", "likedTokens", { multiEntry: true });
      db.createObjectStore("accounts", { keyPath: "key" }); db.createObjectStore("meta");
      posts.put({ ...event("like", "124", 1000, "bob").post!, key: "reader:124", at: 1000, liked: true, likedAt: 1000,
        text: "Solar energy", likedText: "Solar energy", tokens: [], likedTokens: [] });
      posts.put({ ...event("like").post!, key: "reader:123", at: 1000, liked: true, likedAt: 1000,
        likedText: "our and are you the for", text: "our and are you the for", tokens: ["our", "and", "are", "you", "the", "for"], likedTokens: ["our", "and", "are", "you", "the", "for"] });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { open.result.close(); resolve(); };
  });
  assert.equal((await related("our and are you the for")).posts.length, 0);
  const history = await related("unrelated topic", undefined, "@ALICE");
  assert.deepEqual((await related("solar energy")).posts.map(p => p.id), ["124"]);
  assert.equal(history.posts[0].id, "123"); assert.equal(history.retrievalMethod, "same-author");
});
test("deduplicates retried events and updates same-account counts atomically", async () => {
  await clearActivity();
  const first = event("exposure");
  await saveEvents([
    first,
    first,
    event("exposure", "124"),
    event("like"),
    event("like"),
  ]);
  const summary = await activitySummary();
  assert.equal(summary.events, 4);
  assert.equal(summary.posts, 2);
  assert.equal(summary.accounts[0].exposures, 2);
  assert.equal(summary.accounts[0].likes, 1);
});
test("unlikes remove preference evidence; late exposure does not suppress an earlier like", async () => {
  await clearActivity();
  await saveEvents([
    event("exposure", "123", 3000),
    event("like", "123", 2000),
  ]);
  assert.equal((await related("solar energy")).posts[0].liked, true);
  await saveEvents([event("unlike", "123", 4000), event("like", "123", 1000)]);
  assert.equal(
    (await related("solar energy")).posts.some((p) => p.liked),
    false,
  );
  assert.equal((await activitySummary()).accounts[0].likes, 0);
});
test("gates on topic, distinct posts and viewing identity", async () => {
  await seed();
  assert.equal((await related("solar energy climate")).ready, true);
  assert.equal((await related("football championship")).ready, false);
  assert.equal(
    (await related("solar energy climate", "100")).posts.some(
      (p) => p.id === "100",
    ),
    false,
  );
  const extra = event("like", "500");
  extra.post!.viewer = "another-reader";
  await saveEvents([extra]);
  assert.equal((await related("solar energy climate")).ready, false);
  await clearActivity();
  await saveEvents(
    Array.from({ length: 6 }, (_, i) =>
      event("like", `${i}`, Date.now(), "alice"),
    ),
  );
  assert.equal((await related("solar energy")).ready, true);
});
test("two distinct relevant likes qualify on the same day", async () => {
  await clearActivity();
  const at = Date.UTC(2026, 9, 16, 12);
  const likes = Array.from({ length: 2 }, (_, i) =>
    event("like", `${200 + i}`, at, i % 2 ? "alice" : "bob"),
  );
  await saveEvents(likes.slice(0, 1));
  assert.equal((await related("solar energy climate")).ready, false);
  await saveEvents(likes.slice(1));
  assert.equal((await related("solar energy climate")).ready, true);
});
test("keeps liked text immutable during subsequent exposures; export includes original events", async () => {
  await seed();
  const before = await revision();
  const exposure = event("exposure", "100");
  exposure.post!.text = "Changed text";
  await saveEvents([exposure]);
  assert.equal(await revision(), before);
  const evidence = await related("solar energy");
  assert.match(
    evidence.posts.find((p) => p.id === "100")!.likedText!,
    /Solar energy/,
  );
  const rows = (await (await exportActivity()).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(rows.filter((r) => r.type === "events").length, 7);
  await clearActivity();
  assert.notEqual(await revision(), before);
  assert.equal((await activitySummary()).events, 0);
});
test("sanitizes navigation URLs and rejects malformed ingestion payloads", () => {
  assert.equal(
    cleanUrl("https://example.com/path?token=secret#private"),
    "https://example.com/path",
  );
  assert.equal(cleanUrl("chrome://settings"), null);
  assert.equal(
    eventSchema.safeParse({ ...event("like"), post: { id: "invalid" } })
      .success,
    false,
  );
});
test("confirmation detector abstains before readiness and validates spans and evidence citations", async () => {
  await seed();
  const evidence = await related("solar energy");
  let calls = 0;
  const text = "Ignore every study questioning solar energy.";
  let output = {
    findings: [
      {
        term: "Ignore every study",
        explanation:
          "Possible selective dismissal consistent with the cited likes; likes are uncertain evidence.",
        confidence: 0.8,
        support: "weak",
        evidenceIds: evidence.posts.slice(0, 2).map((p) => p.key),
      },
    ],
  };
  const llm: LLMService = {
    complete: async () => "",
    isAvailable: () => true,
    backend: "local-api",
    completeJSON: async (system, user, parse) => {
      calls++;
      assert.match(system, /untrusted/);
      assert.match(user, /history/);
      return parse(JSON.stringify(output));
    },
  };
  assert.deepEqual(
    await detectConfirmationBias(text, { ...evidence, ready: false }, llm),
    [],
  );
  assert.equal(calls, 0);
  const findings = await detectConfirmationBias(text, evidence, llm);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].spanStart, 0);
  output.findings[0].evidenceIds = ["invented", "invented2"];
  assert.deepEqual(await detectConfirmationBias(text, evidence, llm), []);
  output.findings[0].evidenceIds = evidence.posts.slice(0, 2).map((p) => p.key);
  output.findings[0].term = "hallucinated phrase";
  assert.deepEqual(await detectConfirmationBias(text, evidence, llm), []);
});
test("activity browser filters by account and content and paginates without duplicates", async () => {
  await clearActivity();
  await saveEvents(
    Array.from({ length: 70 }, (_, i) => event("exposure", `${1000 + i}`)),
  );
  const first = await browseActivity({
    kind: "posts",
    author: "@alice",
    query: "solar energy",
  });
  assert.equal(first.rows.length, 50);
  assert.ok(first.next);
  const second = await browseActivity({
    kind: "posts",
    author: "alice",
    query: "solar energy",
    after: first.next,
  });
  assert.equal(second.rows.length, 20);
  assert.equal(
    new Set([...first.rows, ...second.rows].map((p) => p.data.id)).size,
    70,
  );
  assert.equal(
    (await browseActivity({ kind: "posts", query: "football" })).rows.length,
    0,
  );
  assert.equal(
    (await browseActivity({ kind: "posts", author: "bob" })).rows.length,
    0,
  );
});
test("collector is opt-in, requires dwell, captures media-only posts and stops when disabled", async () => {
  const dom = new JSDOM(
    `<body><a data-testid="AppTabBar_Profile_Link" href="/reader"></a><article data-testid="tweet"><a href="/alice/status/123"><time>Today</time></a><img alt="A solar panel" /></article></body>`,
    { url: "https://x.com/home", pretendToBeVisual: true },
  );
  for (const name of [
    "window",
    "document",
    "location",
    "Element",
    "MutationObserver",
  ])
    Object.defineProperty(globalThis, name, {
      value: dom.window[name],
      configurable: true,
    });
  Object.defineProperty(globalThis, "innerHeight", {
    value: 900,
    configurable: true,
  });
  dom.window.document.hasFocus = () => true;
  let onStorage: (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => void;
  let intersect: (
    entries: Array<{
      target: Element;
      intersectionRect: { height: number };
      boundingClientRect: { height: number };
    }>,
  ) => void;
  let observations = 0;
  const batches: ActivityEvent[][] = [];
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: { get: async () => ({}) },
        onChanged: {
          addListener: (fn) => {
            onStorage = fn;
          },
        },
      },
      runtime: {
        sendMessage: async (m) => {
          batches.push(m.payload.events);
          return { type: "ACTIVITY_ACK", payload: { ok: true } };
        },
      },
    },
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      constructor(fn) {
        intersect = fn;
      }
      observe() {
        observations++;
      }
      unobserve() {}
      disconnect() {}
    },
  });
  startActivityCollection();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(observations, 0);
  onStorage!(
    { vigilActivitySettingsV1: { newValue: { tracking: true } } },
    "local",
  );
  assert.equal(observations, 1);
  const article = document.querySelector("article")!;
  intersect!([
    {
      target: article,
      intersectionRect: { height: 100 },
      boundingClientRect: { height: 100 },
    },
  ]);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].post!.text, "A solar panel");
  assert.equal(batches[0][0].post!.viewer, "reader");
  onStorage!(
    { vigilActivitySettingsV1: { newValue: { tracking: false } } },
    "local",
  );
  dom.window.close();
});

test("server discovery uses loaded and newly typed URLs instead of the initial default", async () => {
  const dom = new JSDOM(
    '<input id="server-url"><span id="server-status-dot"></span><div id="server-plugins-list"></div><select id="llm-backend"><option value="none">Disabled</option></select>',
  );
  for (const name of [
    "window",
    "document",
    "Element",
    "HTMLInputElement",
    "HTMLSelectElement",
    "HTMLButtonElement",
  ])
    Object.defineProperty(globalThis, name, {
      value: dom.window[name],
      configurable: true,
    });
  const { DEFAULT_SETTINGS, SETTINGS_KEY } =
    await import("../src/shared/settings");
  let current = { ...DEFAULT_SETTINGS };
  let stored = current;
  const urls: string[] = [];
  const statuses: string[] = [];
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (message) => {
          urls.push(message.payload.url);
          return {
            payload: {
              ok: true,
              status: 200,
              body: JSON.stringify({ analyzers: [] }),
            },
          };
        },
      },
      storage: {
        sync: {
          get: async () => ({ [SETTINGS_KEY]: stored }),
          set: async (value) => {
            stored = value[SETTINGS_KEY];
          },
        },
      },
    },
  });
  const { createSettingsController } =
    await import("../src/sidepanel/settingsController");
  const controller = createSettingsController({
    getCurrentSettings: () => current,
    setCurrentSettings: (s) => {
      current = s;
    },
    onSaveStatus() {},
    onPanelStatus: (message) => statuses.push(message),
    onDiagnosticsChanged() {},
  });
  current = { ...current, serverUrl: "http://127.0.0.1:18787" };
  controller.render(current);
  await controller.checkServerAndLoadPlugins();
  assert.deepEqual(urls, [
    "http://127.0.0.1:18787/health",
    "http://127.0.0.1:18787/plugins",
  ]);
  assert.equal(
    document.querySelector<HTMLSelectElement>("#llm-backend")!.value,
    "none",
  );
  document.querySelector<HTMLInputElement>("#server-url")!.value =
    "http://127.0.0.1:28787";
  await controller.checkServerAndLoadPlugins();
  assert.equal(urls.at(-1), "http://127.0.0.1:28787/plugins");
  assert.equal(stored.serverUrl, "http://127.0.0.1:28787");
  assert.match(statuses.at(-1)!, /Connected/);
  dom.window.close();
});

// JSDOM cannot create trusted user events. Capture the DOM listener and provide
// the browser trust bit at that boundary; button changes still use real mutations.
test("collector records like/unlike transitions and ignores unchanged or synthetic clicks", async () => {
  const dom = new JSDOM(
    `<body><a data-testid="AppTabBar_Profile_Link" href="/reader"></a><article data-testid="tweet"><a href="/alice/status/123"><time>Today</time></a><div data-testid="tweetText">Solar energy research</div><button data-testid="like"></button></article></body>`,
    { url: "https://x.com/home", pretendToBeVisual: true },
  );
  for (const name of [
    "window",
    "document",
    "location",
    "Element",
    "MutationObserver",
  ]) {
    Object.defineProperty(globalThis, name, {
      value: dom.window[name],
      configurable: true,
    });
  }
  dom.window.document.hasFocus = () => true;
  const batches: ActivityEvent[][] = [];
  let changeSettings: (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => void;
  let clickListener: EventListener;
  const addListener = document.addEventListener.bind(document);
  document.addEventListener = ((
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === "click") clickListener = listener;
    addListener(type, listener, options);
  }) as typeof document.addEventListener;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async () => ({ vigilActivitySettingsV1: { tracking: true } }),
        },
        onChanged: {
          addListener: (listener) => {
            changeSettings = listener;
          },
        },
      },
      runtime: {
        sendMessage: async (message) => {
          batches.push(message.payload.events);
          return { type: "ACTIVITY_ACK", payload: { ok: true } };
        },
      },
    },
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  startActivityCollection();
  await tick();
  const button = document.querySelector("button")!;
  const click = () =>
    clickListener!({ target: button, isTrusted: true } as unknown as Event);
  try {
    click();
    await tick();
    assert.equal(batches.length, 0, "click alone does not prove a like");
    button.setAttribute("data-testid", "unlike");
    await tick();
    assert.equal(batches[0][0].kind, "like");
    assert.equal(batches[0][0].post!.text, "Solar energy research");
    assert.equal(batches[0][0].post!.viewer, "reader");

    click();
    button.setAttribute("data-testid", "like");
    await tick();
    assert.equal(batches[1][0].kind, "unlike");

    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    button.setAttribute("data-testid", "unlike");
    await tick();
    assert.equal(
      batches.length,
      2,
      "synthetic clicks do not become interactions",
    );

    changeSettings!(
      { vigilActivitySettingsV1: { newValue: { tracking: false } } },
      "local",
    );
    click();
    button.setAttribute("data-testid", "like");
    await tick();
    assert.equal(
      batches.length,
      2,
      "pausing collection stops interaction events",
    );
  } finally {
    changeSettings!(
      { vigilActivitySettingsV1: { newValue: { tracking: false } } },
      "local",
    );
    dom.window.close();
  }
});

test("confirmation service discards results when history changes during inference", async () => {
  await seed();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: { local: { get: async () => ({}) } },
    },
  });
  let finishInference: () => void;
  let notifyStarted: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    finishInference = resolve;
  });
  const llm: LLMService = {
    backend: "local-api",
    isAvailable: () => true,
    complete: async () => "",
    completeJSON: async (_system, _user, parse) => {
      notifyStarted!();
      await waiting;
      return parse('{"findings":[]}');
    },
  };
  let applied = false;
  const service = new ConfirmationAnalysisService({
    isCurrent: () => true,
    onStatus() {},
    onResult: async () => {
      applied = true;
    },
  });
  const item = {
    id: "999",
    platform: "twitter" as const,
    text: "solar energy research",
    pageUrl: "https://x.com/home",
  };
  const running = service.analyze({
    item,
    generation: 1,
    tabId: 1,
    llm,
    base: {
      id: item.id,
      text: item.text,
      findings: [],
      tips: [],
      elapsedMs: 0,
      cached: false,
    },
  });
  await started;
  await saveEvents([event("unlike", "100")]);
  finishInference!();
  await running;
  assert.equal(applied, false);
});

test("confirmation service runs only the latest pending item and keeps existing findings", async () => {
  await seed();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: { local: { get: async () => ({}) } },
    },
  });
  let finishFirst: () => void;
  let notifyStarted: () => void;
  let notifyApplied: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const applied = new Promise<void>((resolve) => {
    notifyApplied = resolve;
  });
  let calls = 0;
  const llm: LLMService = {
    backend: "local-api",
    isAvailable: () => true,
    complete: async () => "",
    completeJSON: async (_system, _user, parse) => {
      if (++calls === 1) {
        notifyStarted!();
        await waiting;
      }
      return parse('{"findings":[]}');
    },
  };
  const ids: string[] = [];
  const service = new ConfirmationAnalysisService({
    isCurrent: () => true,
    onStatus() {},
    onResult: async (request, result) => {
      ids.push(result.id);
      assert.deepEqual(result.findings, request.base.findings);
      if (result.id === "third") notifyApplied!();
    },
  });
  const request = (id: string) => ({
    item: {
      id,
      platform: "generic" as const,
      text: "solar energy research",
      pageUrl: "https://example.com",
    },
    generation: 1,
    tabId: 1,
    llm,
    base: {
      id,
      text: "solar energy research",
      findings: [
        {
          term: "solar",
          label: "Existing finding",
          explanation: "Existing detector",
          severity: "low" as const,
          pluginId: "existing",
        },
      ],
      tips: [],
      elapsedMs: 0,
      cached: false,
    },
  });
  const running = service.analyze(request("first"));
  await started;
  await service.analyze(request("second"));
  await service.analyze(request("third"));
  finishFirst!();
  await running;
  await applied;
  assert.deepEqual(ids, ["first", "third"]);
  assert.equal(calls, 2);
});

test("indexed pagination seeks to later pages without replaying earlier records", async () => {
  await clearActivity();
  await saveEvents(
    Array.from({ length: 300 }, (_, i) => event("exposure", `${1000 + i}`)),
  );
  const original = IDBIndex.prototype.openCursor;
  let visited = 0;
  IDBIndex.prototype.openCursor = function (...args) {
    const request = original.apply(this, args);
    request.addEventListener("success", () => {
      visited++;
    });
    return request;
  };
  try {
    const page = await browseActivity({
      kind: "posts",
      author: "alice",
      after: "reader:1249",
    });
    assert.equal(page.rows.length, 50);
    assert.equal(page.rows[0].data.id, "1250");
    assert.ok(
      visited <= 53,
      `Visited ${visited} cursor positions for 50 results`,
    );
  } finally {
    IDBIndex.prototype.openCursor = original;
  }
});

test("activity runtime messages reject malformed records and oversized batches", () => {
  assert.equal(
    isRuntimeRequestMessage({
      type: "ACTIVITY_BATCH",
      payload: { events: [event("like")] },
    }),
    true,
  );
  assert.equal(isRuntimeRequestMessage({ type: "ACTIVITY_CLEAR" }), true);
  assert.equal(
    isRuntimeRequestMessage({
      type: "ACTIVITY_BATCH",
      payload: { events: [{ id: "bad" }] },
    }),
    false,
  );
  assert.equal(
    isRuntimeRequestMessage({
      type: "ACTIVITY_BATCH",
      payload: { events: Array.from({ length: 51 }, () => event("like")) },
    }),
    false,
  );
});

test("retrieval uses liked and authored posts, excludes exposures and the current post", async () => {
  await clearActivity();
  await saveEvents([event("exposure", "700", Date.now(), "reader"), event("exposure", "701"), event("like", "702")]);
  let evidence = await related("solar energy climate");
  assert.equal(evidence.ready, true);
  assert.deepEqual(new Set(evidence.posts.map(p => p.id)), new Set(["700", "702"]));
  assert.equal((await related("solar energy climate", "700")).ready, false);
  await saveEvents([event("unlike", "702")]);
  assert.equal((await related("solar energy climate")).ready, false);
  await saveEvents([event("exposure", "703", Date.now(), "reader")]);
  evidence = await related("solar energy climate");
  assert.equal(evidence.ready, true); // Own-post-only history can qualify.
  assert.ok(evidence.posts.every(p => p.author === "reader" && !p.liked));
  const before = await revision();
  await saveEvents([event("exposure", "703", Date.now(), "reader")]);
  assert.equal(await revision(), before); // Repeat exposure should not cancel inference.
  const changed = event("exposure", "703", Date.now() + 1, "reader");
  changed.post!.text += " Additional context.";
  await saveEvents([changed]); assert.notEqual(await revision(), before);
});

test("model context contains only liked/authored evidence and rejects unsupported or duplicate citations", async () => {
  await seed();
  const evidence = await related("solar energy climate");
  const own = { ...evidence.posts[0], key: "reader:800", id: "800", author: "reader", liked: false };
  const exposure = { ...evidence.posts[1], key: "reader:801", id: "801", liked: false };
  evidence.posts = [own, ...evidence.posts, exposure];
  const text = "Solar energy saves every home money without exception.";
  let refs = [own.key, evidence.posts[1].key];
  const llm: LLMService = {
    backend: "local-api", isAvailable: () => true, complete: async () => "",
    completeJSON: async (system, user, parse) => {
      assert.match(system, /support PRESENTED IN THE CURRENT POST/);
      assert.match(system, /subjective preference alone/);
      const context = JSON.parse(user);
      assert.ok(context.history.every(p => p.key !== exposure.key));
      assert.equal(context.history[0].basis, "authored");
      return parse(JSON.stringify({ findings: [{ term: text, explanation: "This may reinforce your support for solar energy; no evidence for the universal savings claim is shown.", confidence: 0.8, support: "absent", evidenceIds: refs }] }));
    },
  };
  assert.equal((await detectConfirmationBias(text, evidence, llm)).length, 1);
  refs = [own.key, own.key]; assert.deepEqual(await detectConfirmationBias(text, evidence, llm), []);
  refs = [own.key, exposure.key]; assert.deepEqual(await detectConfirmationBias(text, evidence, llm), []);
});

test("CB badge is separate from phrase highlights, supports hover/focus/click, and clears recycled posts", async () => {
  const { highlightTweetFindings, clearAllHighlights } = await import("../src/content/highlighter");
  const dom = new JSDOM('<body><article data-testid="tweet"><a href="/alice/status/900"><time>Now</time></a><div data-testid="tweetText">Solar energy always saves money.</div></article></body>', { url: "https://x.com/home", pretendToBeVisual: true });
  for (const name of ["window", "document", "Element", "HTMLElement", "HTMLAnchorElement", "Node", "NodeFilter", "MutationObserver"])
    Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) });
  Object.defineProperty(globalThis, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(globalThis, "innerHeight", { configurable: true, value: 768 });
  dom.window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any;
  const article = document.querySelector('article')!;
  let navigated = false; article.addEventListener("click", () => { navigated = true; });
  const result = { tweetId: "900", text: "Solar energy always saves money.", tips: [], elapsedMs: 0, findings: [
    { term: "always", label: "Ordinary detector", explanation: "Existing highlight", severity: "low" as const, pluginId: "ordinary", spanStart: 13, spanEnd: 19 },
    { term: "Solar energy always saves money.", label: "Possible confirmation bias", explanation: "<img src=x onerror=alert(1)> No universal savings evidence shown.", severity: "medium" as const, pluginId: "confirmation-bias-llm", spanStart: 0, spanEnd: 31 },
  ] };
  try {
    assert.equal(highlightTweetFindings([result]).totalHighlights, 2);
    assert.equal(document.querySelectorAll('mark').length, 1);
    const host = document.querySelector<HTMLElement>('[data-vigil-confirmation-badge]')!;
    const root = host.shadowRoot!; const button = root.querySelector('button')!; const tooltip = root.querySelector<HTMLElement>('[role="tooltip"]')!;
    assert.equal(button.textContent, "CB?"); assert.equal(tooltip.hidden, true);
    host.dispatchEvent(new dom.window.Event("pointerenter")); assert.equal(tooltip.hidden, false);
    assert.match(tooltip.textContent!, /not a fact-check/); assert.equal(root.querySelector('img'), null);
    host.dispatchEvent(new dom.window.Event("pointerleave")); assert.equal(tooltip.hidden, true);
    button.focus(); assert.equal(tooltip.hidden, false);
    button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); assert.equal(tooltip.hidden, true);
    button.click(); assert.equal(tooltip.hidden, false); assert.equal(navigated, false);
    button.click(); assert.equal(tooltip.hidden, true);
    highlightTweetFindings([result]); assert.equal(document.querySelectorAll('[data-vigil-confirmation-badge]').length, 1);
    article.querySelector('a')!.href = '/bob/status/901';
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelector('[data-vigil-confirmation-badge]'), null);
    article.querySelector('a')!.href = '/alice/status/900';
    highlightTweetFindings([result]); clearAllHighlights();
    assert.equal(document.querySelector('[data-vigil-confirmation-badge]'), null); assert.equal(document.querySelector('mark'), null);
  } finally { clearAllHighlights(); dom.window.close(); }
});

test("diagnostics capture the exact sent context and model output without provider credentials", async () => {
  const { ConfirmationDiagnostics } = await import("../src/diagnostics/confirmation");
  await seed();
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: { get: async () => ({}) } } } });
  const diagnostics = new ConfirmationDiagnostics();
  let sentSystem = "", sentUser = "";
  const llm: LLMService = {
    backend: "local-api", isAvailable: () => true, complete: async () => "",
    completeJSON: async (system, user, parse) => {
      sentSystem = system; sentUser = user;
      assert.equal(diagnostics.get()!.stage, "calling");
      return parse('{"findings":[]}');
    },
  };
  const item = { id: "999", text: "solar energy climate", pageUrl: "https://x.com/home", platform: "twitter" as const };
  const base = { id: item.id, text: item.text, findings: [], tips: [], elapsedMs: 0, cached: false };
  const service = new ConfirmationAnalysisService({ isCurrent: () => true, onStatus() {}, onResult: async () => {} }, diagnostics);
  await service.analyze({ item, base, generation: 1, tabId: 1, llm, model: "test-model" });
  const trace = diagnostics.get()!;
  assert.equal(trace.stage, "completed"); assert.match(trace.reason, /abstained/);
  assert.equal(trace.request!.system, sentSystem); assert.equal(trace.request!.user, sentUser);
  assert.equal(trace.responses[0].text, '{"findings":[]}');
  assert.equal(trace.model, "test-model"); assert.ok(trace.retrieved.every(p => p.matchedTerms.includes("solar")));
  assert.ok(JSON.parse(sentUser).history.every(p => p.basis === "liked"));
  assert.equal("llm" in trace, false); assert.equal("headers" in trace.request!, false);
});

test("diagnostics distinguish skipped checks, invalid responses, and private provider errors", async () => {
  const { ConfirmationDiagnostics } = await import("../src/diagnostics/confirmation");
  await clearActivity();
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: { storage: { local: { get: async () => ({}) } } } });
  const diagnostics = new ConfirmationDiagnostics();
  let mode = "invalid";
  const llm: LLMService = {
    backend: "local-api", isAvailable: () => true, complete: async () => "",
    completeJSON: async (_system, _user, parse) => {
      if (mode === "error") throw new Error("private-api-key-do-not-record");
      return parse("not JSON");
    },
  };
  const item = { id: "999", text: "solar energy climate", pageUrl: "https://x.com/home", platform: "twitter" as const };
  const base = { id: item.id, text: item.text, findings: [], tips: [], elapsedMs: 0, cached: false };
  const service = new ConfirmationAnalysisService({ isCurrent: () => true, onStatus() {}, onResult: async () => {} }, diagnostics);
  const request = { item, base, generation: 1, tabId: 1, llm };
  await service.analyze(request);
  assert.equal(diagnostics.get()!.stage, "skipped"); assert.equal(diagnostics.get()!.request, undefined);
  await seed();
  const warn = console.warn; console.warn = () => {};
  try {
    await service.analyze(request);
    assert.equal(diagnostics.get()!.stage, "failed");
    assert.equal(diagnostics.get()!.responses[0].text, "not JSON");
    assert.match(diagnostics.get()!.validation[0], /not valid JSON/);
    mode = "error"; await service.analyze(request);
    assert.equal(diagnostics.get()!.stage, "failed");
    assert.ok(!JSON.stringify(diagnostics.get()).includes("private-api-key"));
  } finally { console.warn = warn; }
});

test("cleared or replaced diagnostics cannot be repopulated by a late response", async () => {
  const { ConfirmationDiagnostics } = await import("../src/diagnostics/confirmation");
  const diagnostics = new ConfirmationDiagnostics();
  const current = { id: "1", text: "private text", pageUrl: "https://x.com/home" };
  const first = diagnostics.begin(current, "local-api");
  diagnostics.clear(); diagnostics.update(first, { reason: "late private response" });
  assert.equal(diagnostics.get(), null);
  const second = diagnostics.begin({ ...current, id: "2" }, "local-api");
  diagnostics.update(first, { stage: "completed" }); assert.equal(diagnostics.get()!.id, second);
  assert.equal(diagnostics.get()!.stage, "retrieving");
});

test("diagnostics view renders model text safely and separates candidates from sent context", async () => {
  const { renderConfirmationTrace } = await import("../src/diagnostics/view");
  const { ConfirmationDiagnostics } = await import("../src/diagnostics/confirmation");
  const dom = new JSDOM('<body><div id="trace"></div></body>');
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  const target = document.getElementById("trace")!;
  const diagnostics = new ConfirmationDiagnostics();
  const id = diagnostics.begin({ id: "1", text: "test", pageUrl: "https://x.com/home" }, "local-api");
  diagnostics.update(id, { retrieved: [{ key: "p", author: "alice", text: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)", basis: "liked", matchedTerms: ["solar"] }] });
  renderConfirmationTrace(target, diagnostics.get());
  assert.match(target.textContent!, /not sent/); assert.equal(target.querySelector("img"), null); assert.equal(target.querySelector("a"), null);
  diagnostics.update(id, { request: { system: "test", user: JSON.stringify({ currentContent: "test", history: [{ key: "sent", author: "bob", text: "Actual sent excerpt", url: "https://x.com/bob/status/2", basis: "authored" }] }), options: {} } });
  renderConfirmationTrace(target, diagnostics.get());
  assert.match(target.textContent!, /Tweets sent to the LLM/); assert.match(target.textContent!, /Actual sent excerpt/);
  assert.doesNotMatch(target.textContent!, /@alice/); assert.equal(target.querySelector("a")!.rel, "noopener noreferrer");
  dom.window.close();
});


test("common words never contribute context matches", async () => {
  assert.deepEqual(tokens("OUR and ARE you THE for our"), []);
  assert.deepEqual(tokens("Our solar and energy are for you"), ["solar", "energy"]);
  await clearActivity();
  const rows = [event("like", "910"), event("like", "911")];
  rows.forEach(row => { row.post!.text = "Our cats and dogs are for you"; });
  await saveEvents(rows);
  assert.equal((await related("Our solar and energy are for you")).posts.length, 0);
});

test("same-author fallback uses recent likes only and preserves keyword priority", async () => {
  await clearActivity();
  const rows = [event("like", "920", 1000), event("like", "921", 2000), event("exposure", "922", 3000), event("like", "923", 4000, "bob")];
  rows.forEach(row => { row.post!.text = "Mountain cycling routes"; });
  await saveEvents(rows);
  const fallback = await related("Solar energy policy", "921", "@ALICE");
  assert.deepEqual(fallback.posts.map(p => p.id), ["920"]);
  assert.equal(fallback.retrievalMethod, "same-author");
  const both = await related("Solar energy policy", undefined, "alice");
  assert.deepEqual(both.posts.map(p => p.id), ["921", "920"]); assert.equal(both.ready, true);
  await saveEvents([event("like", "924", 5000, "bob")]);
  const keywords = await related("Solar energy policy", undefined, "alice");
  assert.equal(keywords.retrievalMethod, "keywords"); assert.deepEqual(keywords.posts.map(p => p.id), ["924"]);
  assert.equal((await related("unrelated language")).posts.length, 0); // No author supplied.
  await saveEvents([event("unlike", "921", 6000)]);
  assert.deepEqual((await related("unrelated language", undefined, "alice")).posts.map(p => p.id), ["920"]);
});

test("author fallback never treats unknown or mixed viewer identities as ready", async () => {
  await clearActivity();
  const rows = [event("like", "930"), event("like", "931")];
  rows[1].post!.viewer = "another-reader";
  await saveEvents(rows);
  assert.equal((await related("unrelated topic", undefined, "alice")).ready, false);
  await clearActivity(); rows.forEach(row => { row.post!.viewer = "unknown"; });
  await saveEvents(rows);
  assert.equal((await related("unrelated topic", undefined, "alice")).ready, false);
});


test("retrieval excludes the library's English stopwords without altering post text", () => {
  assert.deepEqual(tokens(eng.join(" ")), []);
  assert.deepEqual(tokens("The solar energy policy is for our community"), ["solar", "energy", "policy", "community"]);
  assert.deepEqual(tokens("https twitter com solar energy"), ["solar", "energy"]);
});
