import { sendRuntimeMessage } from "../shared/messages";
import {
  ACTIVITY_SETTINGS_KEY,
  getActivitySettings,
  cleanUrl,
  type ActivityEvent,
  type PostSnapshot,
} from "./model";

const SELECTOR = 'article[data-testid="tweet"]';
/** No API interception: these are observations of rendered X UI, not server-confirmed actions. */
export function startActivityCollection(): void {
  if (!/^(www\.)?(x\.com|twitter\.com)$/.test(location.hostname)) return;
  let enabled = false;
  let observer: IntersectionObserver | undefined;
  let mutations: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing = false;
  let reportedFailure = false;
  let reportedOverflow = false;
  let route = location.pathname;
  let session: string = crypto.randomUUID();
  const pending: ActivityEvent[] = [];
  const tracked = new Map<
    Element,
    {
      visible: boolean;
      timer?: ReturnType<typeof setTimeout>;
      timerKey?: string;
      snapshot?: PostSnapshot;
      seen?: string;
    }
  >();
  const likes = new Map<
    Element,
    {
      post: PostSnapshot;
      before: boolean;
      session: string;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  function snapshot(article: Element): PostSnapshot | undefined {
    const previous = tracked.get(article)?.snapshot;
    const link = article.querySelector<HTMLAnchorElement>(
      'a[href*="/status/"]:has(time)',
    );
    const match = link?.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!match) return;
    if (article.querySelector(".vigil-reform-badge"))
      return previous?.id === match[2] ? previous : undefined;
    const textNode = article.querySelector('[data-testid="tweetText"]');
    const media = Array.from(article.querySelectorAll("img[alt]"))
      .map((n) => n.getAttribute("alt"))
      .filter((t) => t && t !== "Image")
      .join(" ");
    const profile = document.querySelector<HTMLAnchorElement>(
      'a[data-testid="AppTabBar_Profile_Link"]',
    );
    const viewer = profile?.pathname.split("/")[1]?.toLowerCase() || "unknown";
    return {
      id: match[2],
      author: match[1].toLowerCase(),
      text: (textNode?.textContent ?? media ?? "").trim().slice(0, 20000),
      url: `https://x.com/${match[1]}/status/${match[2]}`,
      viewer,
    };
  }
  function emit(
    kind: ActivityEvent["kind"],
    post: PostSnapshot,
    eventSession: string = session,
  ): void {
    if (!enabled) return;
    if (pending.length >= 500) {
      if (!reportedOverflow)
        console.warn(
          "[Vigil activity] Collection queue is full; new events are being dropped.",
        );
      reportedOverflow = true;
      return;
    }
    pending.push({
      id: crypto.randomUUID(),
      kind,
      post,
      at: Date.now(),
      url: cleanUrl(location.href)!,
      session: eventSession,
      context:
        location.pathname === "/home"
          ? "home-feed"
          : location.pathname.includes("/status/")
            ? "thread"
            : "other",
    });
    if (kind === "like" || kind === "unlike" || pending.length >= 25)
      void flush();
    else if (!timer)
      timer = setTimeout(() => {
        timer = undefined;
        void flush();
      }, 500);
  }
  async function flush(): Promise<void> {
    if (flushing || !enabled || !pending.length) return;
    flushing = true;
    const batch = pending.slice(0, 50);
    try {
      const response = await sendRuntimeMessage({
        type: "ACTIVITY_BATCH",
        payload: { events: batch },
      });
      if (!response.payload.ok)
        throw new Error(
          response.payload.error ?? "Activity persistence failed",
        );
      reportedFailure = false;
      reportedOverflow = false;
      const ids = new Set(batch.map((event) => event.id));
      for (let i = pending.length - 1; i >= 0; i--) {
        if (ids.has(pending[i].id)) pending.splice(i, 1);
      }
    } catch (error) {
      // Report once per outage; retain event IDs so retries cannot double-count.
      if (!reportedFailure)
        console.warn(
          "[Vigil activity] Could not save activity; retrying.",
          error,
        );
      reportedFailure = true;
    } finally {
      flushing = false;
      if (enabled && pending.length && !timer)
        timer = setTimeout(() => {
          timer = undefined;
          void flush();
        }, 1000);
    }
  }
  function consider(article: Element): void {
    const state = tracked.get(article);
    if (!state) return;
    if (
      !state.visible ||
      document.visibilityState !== "visible" ||
      !document.hasFocus()
    ) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      return;
    }
    const post = snapshot(article);
    if (!post) return;
    state.snapshot = post;
    const key = `${session}:${post.viewer}:${post.id}`;
    if (state.seen === key || (state.timer && state.timerKey === key)) return;
    if (state.timer) clearTimeout(state.timer);
    state.timerKey = key;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (
        !enabled ||
        !article.isConnected ||
        !state.visible ||
        document.hidden ||
        !document.hasFocus()
      )
        return;
      const current = snapshot(article);
      if (!current || current.id !== post.id) {
        consider(article);
        return;
      }
      state.seen = key;
      emit("exposure", post);
    }, 500);
  }
  function attach(root: Element): void {
    const articles = root.matches(SELECTOR)
      ? [root]
      : Array.from(root.querySelectorAll(SELECTOR));
    for (const article of articles)
      if (!tracked.has(article)) {
        tracked.set(article, { visible: false });
        observer?.observe(article);
      }
  }
  function checkLike(article: Element): void {
    const intent = likes.get(article);
    if (!intent) return;
    const current = snapshot(article);
    if (!current || current.id !== intent.post.id) return;
    const liked = !!article.querySelector('[data-testid="unlike"]');
    if (liked !== intent.before) {
      clearTimeout(intent.timeout);
      likes.delete(article);
      emit(liked ? "like" : "unlike", intent.post, intent.session);
    }
  }
  function click(event: MouseEvent): void {
    if (!enabled || !event.isTrusted) return;
    const target =
      event.target instanceof Element
        ? event.target.closest('[data-testid="like"], [data-testid="unlike"]')
        : null;
    const article = target?.closest(SELECTOR);
    if (!target || !article) return;
    const post = snapshot(article);
    if (!post) return;
    const old = likes.get(article);
    if (old) clearTimeout(old.timeout);
    likes.set(article, {
      post,
      before: target.getAttribute("data-testid") === "unlike",
      session,
      timeout: setTimeout(() => likes.delete(article), 5000),
    });
  }
  function focus(): void {
    for (const article of tracked.keys()) consider(article);
  }
  function configure(tracking: boolean): void {
    if (enabled === tracking) return;
    enabled = tracking;
    if (!enabled) {
      observer?.disconnect();
      mutations?.disconnect();
      if (timer) clearTimeout(timer);
      timer = undefined;
      for (const state of tracked.values())
        if (state.timer) clearTimeout(state.timer);
      for (const intent of likes.values()) clearTimeout(intent.timeout);
      tracked.clear();
      likes.clear();
      pending.length = 0;
      document.removeEventListener("click", click, true);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", focus);
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const state = tracked.get(entry.target);
          if (!state) continue;
          state.visible =
            entry.intersectionRect.height >=
            Math.min(entry.boundingClientRect.height, innerHeight) * 0.5;
          if (!state.visible) state.seen = undefined;
          consider(entry.target);
        }
      },
      { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );
    mutations = new MutationObserver((records) => {
      if (route !== location.pathname) {
        route = location.pathname;
        session = crypto.randomUUID();
        for (const state of tracked.values()) state.seen = undefined;
        focus();
      }
      const affected = new Set<Element>();
      for (const record of records) {
        for (const node of Array.from(record.addedNodes))
          if (node instanceof Element) attach(node);
        const target =
          record.target instanceof Element
            ? record.target
            : record.target.parentElement;
        const article = target?.closest(SELECTOR);
        if (article) affected.add(article);
      }
      for (const article of affected) {
        checkLike(article);
        consider(article);
      }
      for (const [article, state] of tracked)
        if (!article.isConnected) {
          if (state.timer) clearTimeout(state.timer);
          observer?.unobserve(article);
          tracked.delete(article);
        }
    });
    attach(document.body);
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-testid", "href"],
    });
    document.addEventListener("click", click, true);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", focus);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[ACTIVITY_SETTINGS_KEY])
      configure(changes[ACTIVITY_SETTINGS_KEY].newValue?.tracking === true);
  });
  void getActivitySettings()
    .then((s) => configure(s.tracking))
    .catch(() => {});
}
