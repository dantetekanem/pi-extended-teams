import { truncateToWidth } from "@mariozechner/pi-tui";
import { dimAnsi, pink, purple } from "./ansi";

export interface TeamActivityStatusEntry {
  name: string;
  role: "read" | "write";
  status?: string;
  detail?: string;
}

export type TeamActivityStatusCounts = Record<string, number>;

export interface TeamActivityStatusSnapshot {
  activeCount: number;
  readCount: number;
  writeCount: number;
  unreadCount: number;
  entries: TeamActivityStatusEntry[];
  statusCounts?: TeamActivityStatusCounts;
  updatedAt: number;
}

const MAX_EXPANDED_ENTRIES = 10;
const AGGREGATE_PREVIEW_THRESHOLD = MAX_EXPANDED_ENTRIES;
const MAX_AGGREGATE_STATUS_PARTS = 4;

function formatCountSummary(snapshot: TeamActivityStatusSnapshot): string {
  const parts = [`${snapshot.activeCount} active`];
  if (snapshot.readCount > 0) parts.push(`${snapshot.readCount} read`);
  if (snapshot.writeCount > 0) parts.push(`${snapshot.writeCount} write`);
  if (snapshot.unreadCount > 0) parts.push(`${snapshot.unreadCount} inbox`);
  return parts.join(" · ");
}

function shouldUseAggregatePreview(snapshot: TeamActivityStatusSnapshot): boolean {
  return snapshot.entries.length > AGGREGATE_PREVIEW_THRESHOLD;
}

function formatRoleSummary(snapshot: TeamActivityStatusSnapshot): string {
  const parts: string[] = [];
  if (snapshot.readCount > 0) parts.push(`${snapshot.readCount} read`);
  if (snapshot.writeCount > 0) parts.push(`${snapshot.writeCount} write`);
  return parts.length > 0 ? parts.join(" · ") : `${snapshot.activeCount} active`;
}

function formatStatusSummary(statusCounts: TeamActivityStatusCounts | undefined): string | undefined {
  if (!statusCounts) return undefined;
  const sorted = Object.entries(statusCounts)
    .filter(([, count]) => count > 0)
    .sort(([aLabel, aCount], [bLabel, bCount]) => bCount - aCount || aLabel.localeCompare(bLabel));
  if (sorted.length === 0) return undefined;

  const shown = sorted.slice(0, MAX_AGGREGATE_STATUS_PARTS).map(([label, count]) => `${count} ${label}`);
  const remaining = sorted.length - shown.length;
  if (remaining > 0) shown.push(`+${remaining} states`);
  return shown.join(" · ");
}

function formatAggregatePreview(snapshot: TeamActivityStatusSnapshot): string {
  const summary = formatStatusSummary(snapshot.statusCounts) || formatRoleSummary(snapshot);
  return `${pink("summary")} ${purple(summary)} ${dimAnsi("/agents shows agent details")}`;
}

function formatExpandedEntry(entry: TeamActivityStatusEntry): string {
  const status = entry.status ? ` ${purple(entry.status)}` : "";
  const detail = entry.detail ? ` ${dimAnsi(entry.detail)}` : "";
  return `${pink(entry.name)} ${purple(entry.role)}${status}${detail}`;
}

function formatHeader(snapshot: TeamActivityStatusSnapshot): string {
  const summary = `${formatCountSummary(snapshot)} · /agents`;
  return `${pink("agent activity")}  ${dimAnsi(summary)}`;
}

function expandedRows(snapshot: TeamActivityStatusSnapshot): string[] {
  const lines = [formatHeader(snapshot)];

  if (shouldUseAggregatePreview(snapshot)) lines.push(formatAggregatePreview(snapshot));

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
  _getExpanded: () => boolean
) {
  return {
    render(width: number): string[] {
      const snapshot = getSnapshot();
      if (!snapshot || width <= 0) return [];

      const border = purple("─".repeat(Math.max(0, width)));
      const bodyRows = expandedRows(snapshot);
      return [border, ...bodyRows.map((body) => truncateToWidth(body, width, "…", true))];
    },
    invalidate() {},
  };
}
