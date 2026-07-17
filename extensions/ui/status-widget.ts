import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
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
const PROGRESS_ANIMATION_FRAME_MS = 60;
const SINGLE_COLUMN_ASCII = /^[\x20-\x7E]*$/;
const SINGLE_COLUMN_STATUS_TEXT = /^[\x20-\x7E\u00B7]*$/;

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
  key: string;
  authoritative: boolean;
  entryRole: TeamActivityStatusEntry["role"];
  entryName: string;
  source: string;
  branch: string;
  prefix: string;
  linePrefix: string;
  linePrefixVisibleWidth: number;
  previous: string;
  previousSingleColumn: boolean;
  previousVisibleWidth: number;
  target: string;
  targetSingleColumn: boolean;
  targetVisibleWidth: number;
  startedAt: number;
  maxRenderedWidth: number;
}

function progressTransitionMaxRenderedWidth(linePrefixVisibleWidth: number, previousVisibleWidth: number, targetVisibleWidth: number): number {
  return linePrefixVisibleWidth + Math.max(previousVisibleWidth, targetVisibleWidth + 3);
}

function currentTransitionRenderedWidth(
  transition: ProgressTransition,
  progressText: string,
  singleColumn: boolean,
  width: number
): number {
  return transition.maxRenderedWidth <= width
    ? transition.maxRenderedWidth
    : transition.linePrefixVisibleWidth + (singleColumn ? progressText.length : visibleWidth(progressText));
}

function splitProgressDisplay(displayText: string | undefined): { prefix: string; progress: string } | null {
  if (!displayText) return null;
  const delimiterIndex = displayText.lastIndexOf(" · ");
  if (delimiterIndex < 0) return null;
  const displayLength = displayText.length;
  if (displayLength >= 4
    && displayText.charCodeAt(displayLength - 1) === 107
    && displayText.charCodeAt(displayLength - 2) === 111
    && displayText.charCodeAt(displayLength - 3) === 116
    && displayText.charCodeAt(displayLength - 4) === 32) return null;
  let progressEnd = displayLength;
  while (progressEnd > delimiterIndex + 3 && displayText.charCodeAt(progressEnd - 1) === 46) progressEnd--;
  return {
    prefix: displayText.slice(0, delimiterIndex + 3),
    progress: displayText.slice(delimiterIndex + 3, progressEnd),
  };
}

export function teamActivityStatusWidget(
  getSnapshot: () => TeamActivityStatusSnapshot | null | undefined,
  _getExpanded: () => boolean,
  requestRender?: () => void
) {
  const transitions = new Map<string, ProgressTransition>();
  let animationTimer: NodeJS.Timeout | null = null;
  let summarySnapshot: TeamActivityStatusSnapshot | null | undefined;
  let summaryUpdatedAt = -1;
  let summaryWidth = -1;
  let summaryLines: string[] = [];
  let headerActiveCount = -1;
  let headerReadCount = -1;
  let headerWriteCount = -1;
  let headerUnreadCount = -1;
  let headerWidth = -1;
  let headerLine = "";
  let aggregateStatusCounts: TeamActivityStatusCounts = {};
  let aggregateStatusCountSize = -1;
  let aggregateActiveCount = -1;
  let aggregateReadCount = -1;
  let aggregateWriteCount = -1;
  let aggregateWidth = -1;
  let aggregateLine = "";
  let remainingCount = -1;
  let remainingWidth = -1;
  let remainingLine = "";
  let transitionHintSnapshot: TeamActivityStatusSnapshot | null | undefined;
  let transitionHintUpdatedAt = -1;
  const transitionHintEntries: TeamActivityStatusEntry[] = [];
  const transitionHints: Array<ProgressTransition | undefined> = [];
  const transitionRosterRoles: Array<TeamActivityStatusEntry["role"]> = [];
  const transitionRosterNames: string[] = [];
  const transitionRosterKeys: string[] = [];
  let transitionRosterCount = -1;
  let stableSnapshot: TeamActivityStatusSnapshot | null | undefined;
  let stableUpdatedAt = -1;
  let stableWidth = -1;
  let stableLines: string[] | null = null;
  // render consumes each result synchronously before animating the next entry.
  const animatedResult: { text: string; active: boolean } = { text: "", active: false };
  const animationResult = (text: string, active: boolean, width: number, renderedWidth?: number) => {
    animatedResult.text = renderedWidth !== undefined && renderedWidth <= width
      ? text
      : truncateToWidth(text, width, "…", true);
    animatedResult.active = active;
    return animatedResult;
  };

  const animateEntry = (entry: TeamActivityStatusEntry, branch: string, now: number, width: number, transitionHint: ProgressTransition | undefined, hintIndex: number, hasCachedTransitionEntry: boolean): { text: string; active: boolean } => {
    let key: string | undefined;
    let transition = transitionHint;
    if (!transition) {
      key = `${entry.role}:${entry.name}`;
      transition = transitions.get(key);
      if (!hasCachedTransitionEntry || transition) transitionHints[hintIndex] = transition;
    }
    if (!entry.displayText) {
      return animationResult(`${purple(branch)} ${formatExpandedEntry(entry)}`, false, width);
    }

    if (!transition || transition.source !== entry.displayText) {
      const parsed = splitProgressDisplay(entry.displayText);
      if (!parsed) {
        return animationResult(`${purple(branch)} ${formatExpandedEntry(entry)}`, false, width);
      }
      const branchPrefix = `${purple(branch)} `;
      const prefixVisibleWidth = SINGLE_COLUMN_STATUS_TEXT.test(parsed.prefix)
        ? parsed.prefix.length
        : visibleWidth(parsed.prefix);
      const linePrefixVisibleWidth = prefixVisibleWidth + 3;
      const progressSingleColumn = SINGLE_COLUMN_ASCII.test(parsed.progress);
      const progressVisibleWidth = progressSingleColumn ? parsed.progress.length : visibleWidth(parsed.progress);
      const transitionKey = transition
        && transition.entryRole === entry.role
        && transition.entryName === entry.name
        ? transition.key
        : key ?? `${entry.role}:${entry.name}`;
      const sourceTransition = transition;

      if (!transition) {
        transition = {
          key: transitionKey,
          authoritative: true,
          entryRole: entry.role,
          entryName: entry.name,
          source: entry.displayText,
          branch,
          prefix: parsed.prefix,
          linePrefix: `${branchPrefix}${parsed.prefix}`,
          linePrefixVisibleWidth,
          previous: parsed.progress,
          previousSingleColumn: progressSingleColumn,
          previousVisibleWidth: progressVisibleWidth,
          target: parsed.progress,
          targetSingleColumn: progressSingleColumn,
          targetVisibleWidth: progressVisibleWidth,
          startedAt: now - 1000,
          maxRenderedWidth: progressTransitionMaxRenderedWidth(linePrefixVisibleWidth, progressVisibleWidth, progressVisibleWidth),
        };
      } else if (transition.target !== parsed.progress) {
        transition = {
          key: transitionKey,
          authoritative: true,
          entryRole: entry.role,
          entryName: entry.name,
          source: entry.displayText,
          branch,
          prefix: parsed.prefix,
          linePrefix: `${branchPrefix}${parsed.prefix}`,
          linePrefixVisibleWidth,
          previous: transition.target,
          previousSingleColumn: transition.targetSingleColumn,
          previousVisibleWidth: transition.targetVisibleWidth,
          target: parsed.progress,
          targetSingleColumn: progressSingleColumn,
          targetVisibleWidth: progressVisibleWidth,
          startedAt: now,
          maxRenderedWidth: progressTransitionMaxRenderedWidth(linePrefixVisibleWidth, transition.targetVisibleWidth, progressVisibleWidth),
        };
      } else {
        transition = {
          ...transition,
          key: transitionKey,
          authoritative: true,
          entryRole: entry.role,
          entryName: entry.name,
          source: entry.displayText,
          branch,
          prefix: parsed.prefix,
          linePrefix: `${branchPrefix}${parsed.prefix}`,
          linePrefixVisibleWidth,
          maxRenderedWidth: progressTransitionMaxRenderedWidth(linePrefixVisibleWidth, transition.previousVisibleWidth, transition.targetVisibleWidth),
        };
      }
      const replacedTransition = sourceTransition
        ? sourceTransition.authoritative && sourceTransition.key === transition.key
          ? sourceTransition
          : transitions.get(transition.key)
        : undefined;
      if (replacedTransition && replacedTransition !== transition) replacedTransition.authoritative = false;
      transitions.set(transition.key, transition);
      transitionHints[hintIndex] = transition;
    } else if (transition.branch !== branch) {
      transition.branch = branch;
      transition.linePrefix = `${purple(branch)} ${transition.prefix}`;
    }

    const elapsed = Math.max(0, now - transition.startedAt);
    if (elapsed < 200) {
      const remaining = Math.max(0, Math.ceil(transition.previous.length * (1 - elapsed / 200)));
      const progressText = transition.previous.slice(0, remaining);
      return animationResult(`${transition.linePrefix}${dimAnsi(progressText)}`, true, width, currentTransitionRenderedWidth(transition, progressText, transition.previousSingleColumn, width));
    }
    if (elapsed < 1000) {
      const revealed = Math.floor(transition.target.length * ((elapsed - 200) / 800));
      const progressText = transition.target.slice(0, revealed);
      return animationResult(`${transition.linePrefix}${progressText}`, true, width, currentTransitionRenderedWidth(transition, progressText, transition.targetSingleColumn, width));
    }
    const progressText = formatAnimatedProgress(transition.target, now);
    return animationResult(`${transition.linePrefix}${progressText}`, false, width, currentTransitionRenderedWidth(transition, progressText, transition.targetSingleColumn, width));
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
        stableLines = null;
        return [];
      }
      if (stableLines && stableSnapshot === snapshot && stableUpdatedAt === snapshot.updatedAt && stableWidth === width) {
        return stableLines.slice();
      }

      const now = Date.now();
      let animationActive = false;
      if (summarySnapshot !== snapshot || summaryUpdatedAt !== snapshot.updatedAt || summaryWidth !== width) {
        summarySnapshot = snapshot;
        summaryUpdatedAt = snapshot.updatedAt;
        summaryWidth = width;
        if (headerActiveCount !== snapshot.activeCount
          || headerReadCount !== snapshot.readCount
          || headerWriteCount !== snapshot.writeCount
          || headerUnreadCount !== snapshot.unreadCount
          || headerWidth !== width) {
          headerActiveCount = snapshot.activeCount;
          headerReadCount = snapshot.readCount;
          headerWriteCount = snapshot.writeCount;
          headerUnreadCount = snapshot.unreadCount;
          headerWidth = width;
          headerLine = truncateToWidth(formatHeader(snapshot), width, "…", true);
        }
        summaryLines = [headerLine];
        if (shouldUseAggregatePreview(snapshot)) {
          const statusCounts = snapshot.statusCounts;
          let statusCountSize = 0;
          let sameStatusCounts = true;
          if (statusCounts) {
            for (const label in statusCounts) {
              if (!Object.hasOwn(statusCounts, label)) continue;
              statusCountSize++;
              if (aggregateStatusCounts[label] !== statusCounts[label]) sameStatusCounts = false;
            }
          }
          sameStatusCounts &&= statusCountSize === aggregateStatusCountSize;
          if (!sameStatusCounts
            || aggregateActiveCount !== snapshot.activeCount
            || aggregateReadCount !== snapshot.readCount
            || aggregateWriteCount !== snapshot.writeCount
            || aggregateWidth !== width) {
            aggregateStatusCounts = statusCounts ? { ...statusCounts } : {};
            aggregateStatusCountSize = statusCountSize;
            aggregateActiveCount = snapshot.activeCount;
            aggregateReadCount = snapshot.readCount;
            aggregateWriteCount = snapshot.writeCount;
            aggregateWidth = width;
            aggregateLine = truncateToWidth(formatAggregatePreview(snapshot), width, "…", true);
          }
          summaryLines.push(aggregateLine);
        }
      }
      const lines = summaryLines.slice();

      const entries = snapshot.entries;
      const entryLength = entries.length;
      const allEntriesVisible = entryLength <= MAX_EXPANDED_ENTRIES;
      const entryCount = allEntriesVisible ? entryLength : MAX_EXPANDED_ENTRIES;
      const lastVisibleEntryIndex = allEntriesVisible ? entryCount - 1 : -1;
      const canReuseTransitionHints = transitionHintSnapshot === snapshot && transitionHintUpdatedAt === snapshot.updatedAt;
      if (!canReuseTransitionHints) {
        transitionHintSnapshot = snapshot;
        transitionHintUpdatedAt = snapshot.updatedAt;
      }
      let rosterChanged = entryCount !== transitionRosterCount;
      for (let index = 0; index < entryCount; index++) {
        const entry = entries[index];
        if (transitionRosterRoles[index] !== entry.role || transitionRosterNames[index] !== entry.name) {
          transitionRosterRoles[index] = entry.role;
          transitionRosterNames[index] = entry.name;
          transitionRosterKeys[index] = `${entry.role}:${entry.name}`;
          rosterChanged = true;
        }
        const branch = index === lastVisibleEntryIndex ? "└─" : "├─";
        const hasCachedTransitionEntry = canReuseTransitionHints && transitionHintEntries[index] === entry;
        let transitionHint = hasCachedTransitionEntry ? transitionHints[index] : undefined;
        if (!hasCachedTransitionEntry) {
          transitionHintEntries[index] = entry;
          const candidate = transitionHints[index];
          if (candidate
            && candidate.entryRole === entry.role
            && candidate.entryName === entry.name
            && candidate.authoritative) {
            transitionHint = candidate;
          }
        }
        const animated = animateEntry(entry, branch, now, width, transitionHint, index, hasCachedTransitionEntry);
        animationActive ||= animated.active;
        lines.push(animated.text);
      }
      if (rosterChanged) {
        const activeKeys = new Set<string>();
        for (let index = 0; index < entryCount; index++) activeKeys.add(transitionRosterKeys[index]);
        for (const key of transitions.keys()) {
          if (activeKeys.has(key)) continue;
          transitions.get(key)!.authoritative = false;
          transitions.delete(key);
        }
      }
      transitionRosterCount = entryCount;

      const remaining = entryLength - entryCount;
      if (remaining > 0) {
        if (remainingCount !== remaining || remainingWidth !== width) {
          remainingCount = remaining;
          remainingWidth = width;
          remainingLine = truncateToWidth(dimAnsi(`└─ … ${remaining} more active agent${remaining === 1 ? "" : "s"}`), width, "…", true);
        }
        lines.push(remainingLine);
      }

      if (animationActive && requestRender && !animationTimer) {
        animationTimer = setInterval(requestRender, PROGRESS_ANIMATION_FRAME_MS);
      } else if (!animationActive) {
        stopAnimationTimer();
      }

      const border = purple("─".repeat(Math.max(0, width)));
      const rendered = [...lines, border];
      if (animationActive) {
        stableLines = null;
      } else {
        stableSnapshot = snapshot;
        stableUpdatedAt = snapshot.updatedAt;
        stableWidth = width;
        stableLines = rendered;
      }
      return rendered;
    },
    invalidate() {},
    dispose() {
      stopAnimationTimer();
    },
  };
}
