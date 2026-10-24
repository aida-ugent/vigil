export interface BarDatum {
  key: string;
  label: string;
  value: number;
}
export function renderBars(
  container: HTMLElement,
  data: BarDatum[],
  total: number,
  select: (key: string) => void,
): void {
  container.replaceChildren();
  if (!data.length) {
    const empty = document.createElement("p");
    empty.className = "chart-empty";
    empty.textContent = "No activity recorded for this selection.";
    container.append(empty);
    return;
  }
  const max = Math.max(...data.map((row) => row.value), 1);
  for (const row of data) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bar-row";
    const share = total ? Math.round((row.value / total) * 100) : 0;
    button.setAttribute(
      "aria-label",
      `${row.label}: ${row.value.toLocaleString()}, ${share}% of total. Show records.`,
    );
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = row.label;
    const track = document.createElement("span");
    track.className = "bar-track";
    const fill = document.createElement("span");
    fill.className = "bar-fill";
    fill.style.width = `${(row.value / max) * 100}%`;
    track.append(fill);
    const count = document.createElement("span");
    count.className = "bar-count";
    count.textContent = row.value.toLocaleString();
    const percentage = document.createElement("small");
    percentage.textContent = `${share}%`;
    count.append(percentage);
    button.append(label, track, count);
    button.addEventListener("click", () => select(row.key));
    container.append(button);
  }
}

// Keep share charts compact; ranked bars below retain the full selected top N.
export function renderShare(
  container: HTMLElement,
  data: BarDatum[],
  total: number,
  unit: string,
  select: (key: string) => void,
): void {
  container.replaceChildren();
  if (total <= 0 || !data.length) return;
  const colors = [
    "#0e7490",
    "#7c3aed",
    "#b45309",
    "#047857",
    "#be185d",
    "#94a3b8",
  ];
  const rows: Array<BarDatum & { other?: boolean }> = data.slice(0, 5);
  const remaining = total - rows.reduce((sum, row) => sum + row.value, 0);
  if (remaining > 0)
    rows.push({ key: "", label: "Other", value: remaining, other: true });
  const ring = document.createElement("div");
  ring.className = "share-ring";
  ring.setAttribute("aria-hidden", "true");
  let offset = 0;
  const stops = rows.map((row, index) => {
    const start = offset;
    offset += (row.value / total) * 100;
    return `${colors[index]} ${start}% ${offset}%`;
  });
  ring.style.background = `conic-gradient(${stops.join(", ")})`;
  const center = document.createElement("div");
  center.className = "share-center";
  const count = document.createElement("strong");
  count.textContent = total.toLocaleString();
  const caption = document.createElement("span");
  caption.textContent = unit;
  center.append(count, caption);
  ring.append(center);
  const legend = document.createElement("div");
  legend.className = "share-legend";
  const title = document.createElement("p");
  title.className = "hint";
  title.textContent = `Share of ${total.toLocaleString()} ${unit} · top 5 + other`;
  legend.append(title);
  rows.forEach((row, index) => {
    const item = document.createElement(row.other ? "div" : "button");
    item.className = "share-item";
    const percentage = ((row.value / total) * 100).toLocaleString(undefined, {
      maximumFractionDigits: 1,
    });
    const label = `${row.label}: ${row.value.toLocaleString()} (${percentage}%)`;
    item.title = label;
    if (!row.other) {
      item.setAttribute("type", "button");
      item.setAttribute("aria-label", `${label}. Show records.`);
      item.addEventListener("click", () => select(row.key));
    }
    const swatch = document.createElement("span");
    swatch.className = "share-swatch";
    swatch.style.backgroundColor = colors[index];
    const name = document.createElement("span");
    name.className = "share-name";
    name.textContent = row.label;
    const share = document.createElement("span");
    share.textContent = `${percentage}%`;
    item.append(swatch, name, share);
    legend.append(item);
  });
  container.append(ring, legend);
}
