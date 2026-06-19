import { keyText } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { dimAnsi, pink, purple } from "./ansi";

export interface TeamActivityStatusEntry {
  name: string;
  role: "read" | "write";
  status?: string;
  detail?: string;
}

export interface TeamActivityStatusSnapshot {
  activeCount: number;
  readCount: number;
  writeCount: number;
  unreadCount: number;
  entries: TeamActivityStatusEntry[];
  updatedAt: number;
}

const MAX_COLLAPSED_ENTRIES = 2;
const MAX_EXPANDED_ENTRIES = 10;
const BADGE_WIDTH = 8;

function toolExpandKey(): string {
  try {
    return keyText("app.tools.expand") || "ctrl+o";
  } catch {
    return "ctrl+o";
  }
}

function formatCountSummary(snapshot: TeamActivityStatusSnapshot): string {
  const parts = [`${snapshot.activeCount} active`];
  if (snapshot.readCount > 0) parts.push(`${snapshot.readCount} read`);
  if (snapshot.writeCount > 0) parts.push(`${snapshot.writeCount} write`);
  if (snapshot.unreadCount > 0) parts.push(`${snapshot.unreadCount} inbox`);
  return parts.join(" · ");
}

function formatEntryPreview(entry: TeamActivityStatusEntry): string {
  const state = entry.status ? ` ${entry.status}` : "";
  return `${pink(entry.name)} ${purple(entry.role)}${state ? purple(state) : ""}`;
}

function formatCollapsedPreview(snapshot: TeamActivityStatusSnapshot): string {
  const shownEntries = snapshot.entries.slice(0, MAX_COLLAPSED_ENTRIES).map(formatEntryPreview).join(dimAnsi(" · "));
  const more = snapshot.entries.length > MAX_COLLAPSED_ENTRIES
    ? dimAnsi(` +${snapshot.entries.length - MAX_COLLAPSED_ENTRIES} more`)
    : "";
  return shownEntries ? `${shownEntries}${more}` : dimAnsi("no active agents");
}

function formatExpandedEntry(entry: TeamActivityStatusEntry): string {
  const status = entry.status ? ` ${purple(entry.status)}` : "";
  const detail = entry.detail ? ` ${dimAnsi(entry.detail)}` : "";
  return `${pink(entry.name)} ${purple(entry.role)}${status}${detail}`;
}

function padVisible(value: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(value));
  return `${value}${" ".repeat(pad)}`;
}

function row(left: string, body: string, width: number): string {
  if (width < 56) return truncateToWidth(`${left ? `${left} ` : ""}${body}`, width, "…", true);
  const leftCell = padVisible(left, BADGE_WIDTH);
  const prefix = `${leftCell} ${purple("│")} `;
  const bodyWidth = Math.max(1, width - visibleWidth(prefix));
  return `${prefix}${truncateToWidth(body, bodyWidth, "…", true)}`;
}

function badgeLines(snapshot: TeamActivityStatusSnapshot): string[] {
  const count = Math.min(99, Math.max(0, snapshot.activeCount)).toString().padStart(2, "0");
  return [
    purple("╭────╮"),
    purple("│") + pink("TEAM") + purple("│"),
    purple("│ ") + pink(count) + purple(" │"),
    purple("╰────╯"),
  ];
}

function collapsedRows(snapshot: TeamActivityStatusSnapshot): string[] {
  const key = toolExpandKey();
  return [
    `${pink("team activity")}  ${dimAnsi(formatCountSummary(snapshot))}`,
    formatCollapsedPreview(snapshot),
    dimAnsi(`reports land collapsed in chat · full panel: /team`),
    dimAnsi(`${key} details`),
  ];
}

function expandedRows(snapshot: TeamActivityStatusSnapshot): string[] {
  const key = toolExpandKey();
  const lines = [
    `${pink("team activity")}  ${dimAnsi(formatCountSummary(snapshot))}`,
    dimAnsi(`${key} collapse · full panel: /team`),
  ];

  const entries = snapshot.entries.slice(0, MAX_EXPANDED_ENTRIES);
  for (const [index, entry] of entries.entries()) {
    const branch = index === entries.length - 1 && snapshot.entries.length <= MAX_EXPANDED_ENTRIES ? "└─" : "├─";
    lines.push(`${purple(branch)} ${formatExpandedEntry(entry)}`);
  }

  const remaining = snapshot.entries.length - entries.length;
  if (remaining > 0) lines.push(dimAnsi(`└─ … ${remaining} more active agent${remaining === 1 ? "" : "s"}`));
  return lines;
}

export function teamActivityStatusWidget(
  getSnapshot: () => TeamActivityStatusSnapshot | null | undefined,
  getExpanded: () => boolean
) {
  return {
    render(width: number): string[] {
      const snapshot = getSnapshot();
      if (!snapshot || width <= 0) return [];

      const border = purple("─".repeat(Math.max(0, width)));
      const bodyRows = getExpanded() ? expandedRows(snapshot) : collapsedRows(snapshot);
      const badge = badgeLines(snapshot);
      const rendered = [border];

      for (const [index, body] of bodyRows.entries()) {
        rendered.push(row(badge[index] ?? "", body, width));
      }

      return rendered;
    },
    invalidate() {},
  };
}
