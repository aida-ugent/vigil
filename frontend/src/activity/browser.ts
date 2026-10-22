import "./browser.css";
import type {
  DashboardFilter,
  DashboardSummary,
  RecordFilter,
  EventCursor,
} from "./analytics";
import { AnalyticsClient } from "./analyticsClient";
import { renderBars } from "./charts";
import type { ActivityEvent } from "./model";

const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id)! as T;
const input = (id: string) => el<HTMLInputElement>(id);
const value = (id: string) => input(id).value;
const worker = new Worker(new URL("./analytics.worker.ts", import.meta.url), {
  type: "module",
});
const client = new AnalyticsClient(worker);
function day(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
input("to").value = day(Date.now());
const initialStart = new Date();
initialStart.setDate(initialStart.getDate() - 29);
input("from").value = day(initialStart.getTime());
function readFilter(): DashboardFilter {
  const now = Date.now();
  let from = 0,
    to = now;
  if (value("period") === "custom") {
    from = new Date(`${value("from")}T00:00:00`).getTime();
    to = new Date(`${value("to")}T23:59:59.999`).getTime();
  } else if (value("period") !== "all") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - Number(value("period")) + 1);
    from = start.getTime();
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from > to)
    throw new Error("Choose a valid date range.");
  return {
    from,
    to,
    viewer: value("viewer"),
    surface: value("surface") as DashboardFilter["surface"],
  };
}
let filter: DashboardFilter;
let summary: DashboardSummary | undefined;
let summaryGeneration = 0,
  recordsGeneration = 0;
let next: EventCursor | undefined;
let selectedDay = "",
  selectedDomain = "";
let recordFilter: RecordFilter;
function selectRecords(
  kind: RecordFilter["kind"],
  author = "",
  selectedDate = "",
  domain = "",
) {
  input("kind").value = kind;
  input("author").value = author;
  input("query").value = "";
  selectedDay = selectedDate;
  selectedDomain = domain;
  void loadRecords(true);
  el("records").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderCharts() {
  if (!summary) return;
  const limit = Number(value("limit"));
  const measure = value("seen-measure") as "exposures" | "uniqueSeen";
  const ranked = (metric: "exposures" | "uniqueSeen" | "likedPosts") =>
    summary!.accounts
      .filter((a) => a[metric] > 0)
      .sort((a, b) => b[metric] - a[metric] || a.author.localeCompare(b.author))
      .slice(0, limit)
      .map((a) => ({ key: a.author, label: `@${a.author}`, value: a[metric] }));
  renderBars(el("seen-chart"), ranked(measure), summary[measure], (author) =>
    selectRecords("exposure", author),
  );
  renderBars(
    el("liked-chart"),
    ranked("likedPosts"),
    summary.likedPosts,
    (author) => selectRecords("like", author),
  );
  renderBars(
    el("domain-chart"),
    summary.domains
      .slice(0, limit)
      .map((d) => ({ key: d.domain, label: d.domain, value: d.visits })),
    summary.visits,
    (domain) => selectRecords("visit", "", "", domain),
  );
}
function renderTimeline() {
  const container = el("timeline");
  container.replaceChildren();
  const end = new Date(filter.to);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 89);
  const first = new Date(Math.max(filter.from, start.getTime()));
  first.setHours(0, 0, 0, 0);
  const metrics = new Map(summary!.days.map((d) => [d.day, d]));
  const dates: string[] = [];
  for (
    const date = new Date(first);
    date <= end;
    date.setDate(date.getDate() + 1)
  )
    dates.push(day(date.getTime()));
  const max = Math.max(
    1,
    ...dates.flatMap((d) => [
      metrics.get(d)?.exposures ?? 0,
      metrics.get(d)?.likeActions ?? 0,
    ]),
  );
  for (const date of dates) {
    const metric = metrics.get(date) ?? { exposures: 0, likeActions: 0 };
    const button = document.createElement("button");
    button.type = "button";
    button.className = "day-column";
    button.title = `${date}: ${metric.exposures} times seen, ${metric.likeActions} like actions`;
    button.setAttribute("aria-label", button.title + ". Show records.");
    const bars = document.createElement("span");
    bars.className = "day-bars";
    for (const [index, count] of [
      metric.exposures,
      metric.likeActions,
    ].entries()) {
      const bar = document.createElement("span");
      bar.className = index ? "daily-bar amber" : "daily-bar";
      bar.style.height = `${(count / max) * 100}%`;
      bars.append(bar);
    }
    const label = document.createElement("span");
    label.className = "day-label";
    label.textContent = date.slice(5);
    button.append(bars, label);
    button.addEventListener("click", () => selectRecords("all", "", date));
    container.append(button);
  }
  el("timeline-note").textContent =
    filter.from < start.getTime()
      ? "Showing the latest 90 days in this range. Totals and account charts include the entire selected period."
      : "Daily totals include days with no observed activity.";
}
function appendRow(event: ActivityEvent) {
  const tr = document.createElement("tr");
  const labels = {
    visit: "Website visit",
    exposure: "Post seen",
    like: "Liked",
    unlike: "Unliked",
  };
  let source = event.post ? `@${event.post.author}` : event.url;
  if (!event.post) {
    try {
      source = new URL(event.url).hostname;
    } catch {
      /* Legacy data. */
    }
  }
  const content = event.post?.text ?? event.title ?? event.url;
  for (const text of [
    new Date(event.at).toLocaleString(),
    labels[event.kind],
    source,
    content,
    event.post
      ? event.post.viewer === "unknown"
        ? "Unknown"
        : `@${event.post.viewer}`
      : "—",
  ]) {
    const td = document.createElement("td");
    td.textContent = text;
    tr.append(td);
  }
  const cell = tr.cells[3];
  if (content.length > 280) {
    const details = document.createElement("details"),
      heading = document.createElement("summary"),
      full = document.createElement("p");
    heading.textContent = content.slice(0, 240) + "…";
    full.textContent = content;
    details.append(heading, full);
    cell.replaceChildren(details);
  }
  try {
    const url = new URL(event.post?.url ?? event.url);
    if (url.protocol === "https:" || url.protocol === "http:") {
      const link = document.createElement("a");
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "record-link";
      link.textContent = "Open ↗";
      cell.append(link);
    }
  } catch {
    /* Keep invalid legacy URLs as plain text. */
  }
  el("rows").append(tr);
}
async function loadRecords(reset: boolean) {
  if (!filter) return;
  const generation = reset ? ++recordsGeneration : recordsGeneration;
  if (reset) {
    next = undefined;
    el("rows").replaceChildren();
    el("more").hidden = true;
    recordFilter = {
      ...filter,
      kind: value("kind") as RecordFilter["kind"],
      author: value("author").trim().replace(/^@/, "").toLowerCase(),
      query: value("query"),
      day: selectedDay,
      domain: selectedDomain,
    };
    const parts = [
      recordFilter.author && `@${recordFilter.author}`,
      selectedDay,
      selectedDomain,
    ].filter(Boolean);
    el("selection").textContent = parts.length
      ? `Records for ${parts.join(" · ")}. All dashboard filters also apply.`
      : "Showing records in the selected period. X filters apply to X activity only.";
    el("clear-selection").hidden = !parts.length;
  }
  el<HTMLButtonElement>("more").disabled = true;
  el("status").textContent = "Reading saved activity…";
  try {
    const result = await client.request({
      type: "records",
      filter: recordFilter,
      after: next,
    });
    if (generation !== recordsGeneration) return;
    result.rows.forEach(appendRow);
    next = result.next;
    el("more").hidden = !next;
    const count = el<HTMLTableSectionElement>("rows").rows.length;
    el("status").textContent =
      `${count.toLocaleString()} records shown.${next ? " Load more to continue searching older activity." : count ? "" : " No matching records."}`;
  } catch (error) {
    if (generation === recordsGeneration)
      el("status").textContent =
        error instanceof Error ? error.message : "Could not read activity.";
  } finally {
    if (generation === recordsGeneration)
      el<HTMLButtonElement>("more").disabled = false;
  }
}
async function refresh() {
  el("custom-dates").hidden = value("period") !== "custom";
  let newFilter: DashboardFilter;
  try {
    newFilter = readFilter();
  } catch (error) {
    el("dashboard-status").textContent = (error as Error).message;
    return;
  }
  filter = newFilter;
  selectedDay = "";
  selectedDomain = "";
  const generation = ++summaryGeneration;
  summary = undefined;
  for (const id of ["seen-chart", "liked-chart", "domain-chart", "timeline"])
    el(id).replaceChildren();
  for (const id of [
    "metric-seen",
    "metric-unique",
    "metric-liked",
    "metric-visits",
  ])
    el(id).textContent = "—";
  el("empty").hidden = true;
  el("dashboard-status").textContent = "Calculating your activity…";
  void loadRecords(true);
  try {
    const result = await client.request({ type: "summary", filter });
    if (generation !== summaryGeneration) return;
    summary = result;
    const viewer = el<HTMLSelectElement>("viewer");
    const viewers = [
      ...new Set([
        ...result.viewers,
        ...(filter.viewer ? [filter.viewer] : []),
      ]),
    ].sort();
    viewer.replaceChildren(
      new Option("All observed accounts", ""),
      ...viewers.map(
        (v) =>
          new Option(v === "unknown" ? "Unknown viewing account" : `@${v}`, v),
      ),
    );
    viewer.value = filter.viewer;
    for (const [id, count] of [
      ["seen", result.exposures],
      ["unique", result.uniqueSeen],
      ["liked", result.likedPosts],
      ["visits", result.visits],
    ] as const)
      el(`metric-${id}`).textContent = count.toLocaleString();
    el("liked-note").textContent =
      `${result.likeActions.toLocaleString()} like actions · ${result.unlikeActions.toLocaleString()} unlike actions`;
    el("empty").hidden = !!(
      result.exposures ||
      result.likeActions ||
      result.unlikeActions ||
      result.visits
    );
    renderCharts();
    renderTimeline();
    el("dashboard-status").textContent =
      `Updated ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    if (generation === summaryGeneration)
      el("dashboard-status").textContent =
        error instanceof Error ? error.message : "Could not read activity.";
  }
}
el("dashboard-filters").addEventListener("submit", (event) => {
  event.preventDefault();
  void refresh();
});
el("dashboard-filters").addEventListener("change", (event) => {
  if ((event.target as HTMLElement).id === "limit") renderCharts();
  else void refresh();
});
el("seen-measure").addEventListener("change", renderCharts);
el("refresh").addEventListener("click", () => void refresh());
el("record-filters").addEventListener("submit", (event) => {
  event.preventDefault();
  if (value("kind") !== "visit" || value("author").trim()) selectedDomain = "";
  void loadRecords(true);
});
el("clear-selection").addEventListener("click", () => selectRecords("all"));
el("more").addEventListener("click", () => void loadRecords(false));
window.addEventListener("pagehide", () => client.dispose());
void refresh();
