import { truncateToWidth } from "@mariozechner/pi-tui";
import { dimAnsi, pink, purple } from "./ansi";
import { formatAnimatedProgress } from "./renderers";

export interface TeamActivityStatusEntry {
  name: string;
  role: "read" | "write";
  status?: string;
  detail?: string;
  displayText?: string;
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
  return `${pink("summary")} ${purple(summary)} ${dimAnsi("↓ navigate")}`;
}

function formatExpandedEntry(entry: TeamActivityStatusEntry): string {
  if (entry.displayText) return entry.displayText;
  const status = entry.status ? ` ${purple(entry.status)}` : "";
  const detail = entry.detail ? ` ${dimAnsi(entry.detail)}` : "";
  return `${pink(entry.name)} ${purple(entry.role)}${status}${detail}`;
}

function formatHeader(snapshot: TeamActivityStatusSnapshot): string {
  const summary = `${formatCountSummary(snapshot)} · ↓ navigate`;
  return `${pink("agent activity")}  ${dimAnsi(summary)}`;
}

interface ProgressTransition {
  previous: string;
  target: string;
  startedAt: number;
}

function splitProgressDisplay(displayText: string | undefined): { prefix: string; progress: string } | null {
  if (!displayText) return null;
  const delimiterIndex = displayText.lastIndexOf(" · ");
  if (delimiterIndex < 0) return null;
  const suffix = displayText.slice(delimiterIndex + 3);
  if (/ tok$/.test(suffix)) return null;
  return {
    prefix: displayText.slice(0, delimiterIndex + 3),
    progress: suffix.replace(/\.+$/, ""),
  };
}

export function teamActivityStatusWidget(
  getSnapshot: () => TeamActivityStatusSnapshot | null | undefined,
  _getExpanded: () => boolean,
  requestRender?: () => void
) {
  const transitions = new Map<string, ProgressTransition>();
  let animationTimer: NodeJS.Timeout | null = null;

  const animateEntry = (entry: TeamActivityStatusEntry, now: number): { text: string; active: boolean } => {
    const parsed = splitProgressDisplay(entry.displayText);
    if (!parsed) return { text: formatExpandedEntry(entry), active: false };

    const key = `${entry.role}:${entry.name}`;
    let transition = transitions.get(key);
    if (!transition) {
      transition = { previous: parsed.progress, target: parsed.progress, startedAt: now - 1000 };
      transitions.set(key, transition);
    } else if (transition.target !== parsed.progress) {
      transition = { previous: transition.target, target: parsed.progress, startedAt: now };
      transitions.set(key, transition);
    }

    const elapsed = Math.max(0, now - transition.startedAt);
    if (elapsed < 200) {
      const remaining = Math.max(0, Math.ceil(transition.previous.length * (1 - elapsed / 200)));
      return { text: `${parsed.prefix}${dimAnsi(transition.previous.slice(0, remaining))}`, active: true };
    }
    if (elapsed < 1000) {
      const revealed = Math.min(transition.target.length, Math.floor(transition.target.length * ((elapsed - 200) / 800)));
      return { text: `${parsed.prefix}${transition.target.slice(0, revealed)}`, active: true };
    }
    return { text: `${parsed.prefix}${formatAnimatedProgress(transition.target, now)}`, active: false };
  };

  const stopAnimationTimer = () => {
    if (animationTimer) clearInterval(animationTimer);
    animationTimer = null;
  };

  return {
    render(width: number): string[] {
      const snapshot = getSnapshot();
      if (!snapshot || width <= 0) {
        stopAnimationTimer();
        return [];
      }

      const now = Date.now();
      let animationActive = false;
      const lines = [formatHeader(snapshot)];
      if (shouldUseAggregatePreview(snapshot)) lines.push(formatAggregatePreview(snapshot));

      const entries = snapshot.entries.slice(0, MAX_EXPANDED_ENTRIES);
      const activeKeys = new Set<string>();
      for (const [index, entry] of entries.entries()) {
        activeKeys.add(`${entry.role}:${entry.name}`);
        const branch = index === entries.length - 1 && snapshot.entries.length <= MAX_EXPANDED_ENTRIES ? "└─" : "├─";
        const animated = animateEntry(entry, now);
        animationActive ||= animated.active;
        lines.push(`${purple(branch)} ${animated.text}`);
      }
      for (const key of transitions.keys()) {
        if (!activeKeys.has(key)) transitions.delete(key);
      }

      const remaining = snapshot.entries.length - entries.length;
      if (remaining > 0) lines.push(dimAnsi(`└─ … ${remaining} more active agent${remaining === 1 ? "" : "s"}`));

      if (animationActive && requestRender && !animationTimer) {
        animationTimer = setInterval(requestRender, 50);
      } else if (!animationActive) {
        stopAnimationTimer();
      }

      const border = purple("─".repeat(Math.max(0, width)));
      return [...lines.map((body) => truncateToWidth(body, width, "…", true)), border];
    },
    invalidate() {},
    dispose() {
      stopAnimationTimer();
    },
  };
}
