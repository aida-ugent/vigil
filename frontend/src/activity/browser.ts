import "./browser.css";
import { browseActivity } from "./database";
const form = document.querySelector<HTMLFormElement>("#filters")!;
const body = document.querySelector<HTMLTableSectionElement>("#rows")!;
const more = document.querySelector<HTMLButtonElement>("#more")!;
const status = document.querySelector<HTMLElement>("#status")!;
let next: IDBValidKey | undefined;
let generation = 0;
let filters: { kind: "posts" | "visits"; author: string; query: string };
async function load(reset: boolean): Promise<void> {
  const requestGeneration = reset ? ++generation : generation;
  if (reset) {
    next = undefined;
    body.replaceChildren();
    filters = {
      kind: document.querySelector<HTMLSelectElement>("#kind")!.value as
        "posts" | "visits",
      author: document.querySelector<HTMLInputElement>("#author")!.value,
      query: document.querySelector<HTMLInputElement>("#query")!.value,
    };
  }
  more.disabled = true;
  status.textContent = "Loading…";
  try {
    const result = await browseActivity({ ...filters, after: next });
    if (generation !== requestGeneration) return;
    for (const row of result.rows) {
      const tr = document.createElement("tr");
      const cells =
        row.kind === "post"
          ? [
              new Date(row.data.at).toLocaleString(),
              `@${row.data.author}`,
              row.data.text,
              row.data.liked ? "Yes" : "No observed like",
            ]
          : [
              new Date(row.data.at).toLocaleString(),
              row.data.url,
              row.data.title ?? "",
              "—",
            ];
      for (const value of cells) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(td);
      }
      body.append(tr);
    }
    next = result.next;
    more.hidden = next === undefined;
    status.textContent = `${body.rows.length} records shown${next !== undefined ? " · More available" : ""}.`;
  } catch {
    if (generation !== requestGeneration) return;
    status.textContent = "Could not read activity data.";
  } finally {
    if (generation === requestGeneration) more.disabled = false;
  }
}
document.querySelector("#kind")!.addEventListener("change", () => {
  const visits =
    document.querySelector<HTMLSelectElement>("#kind")!.value === "visits";
  for (const id of ["author", "query"])
    document.querySelector<HTMLInputElement>(`#${id}`)!.disabled = visits;
  void load(true);
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void load(true);
});
more.addEventListener("click", () => {
  void load(false);
});
void load(true);
