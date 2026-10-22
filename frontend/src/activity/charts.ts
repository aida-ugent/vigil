export interface BarDatum { key: string; label: string; value: number }
export function renderBars(container: HTMLElement, data: BarDatum[], total: number, select: (key: string) => void): void {
  container.replaceChildren();
  if (!data.length) {
    const empty = document.createElement("p"); empty.className = "chart-empty"; empty.textContent = "No activity recorded for this selection."; container.append(empty); return;
  }
  const max = Math.max(...data.map(row => row.value), 1);
  for (const row of data) {
    const button = document.createElement("button"); button.type = "button"; button.className = "bar-row";
    const share = total ? Math.round(row.value / total * 100) : 0;
    button.setAttribute("aria-label", `${row.label}: ${row.value.toLocaleString()}, ${share}% of total. Show records.`);
    const label = document.createElement("span"); label.className = "bar-label"; label.textContent = row.label;
    const track = document.createElement("span"); track.className = "bar-track";
    const fill = document.createElement("span"); fill.className = "bar-fill"; fill.style.width = `${row.value / max * 100}%`; track.append(fill);
    const count = document.createElement("span"); count.className = "bar-count"; count.textContent = row.value.toLocaleString();
    const percentage = document.createElement("small"); percentage.textContent = `${share}%`; count.append(percentage);
    button.append(label, track, count); button.addEventListener("click", () => select(row.key)); container.append(button);
  }
}
