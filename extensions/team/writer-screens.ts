import { Key } from "@mariozechner/pi-tui";
import * as teams from "../../src/utils/teams";

export interface ActiveWriterTab {
  teamName: string;
  name: string;
  paneId: string;
  windowId?: string;
  joinedAt?: number;
}

export interface WriterScreenTarget extends ActiveWriterTab {
  role: "write";
}

export interface WriterScreenCycleResult {
  ok: boolean;
  reason?: string;
  target?: WriterScreenTarget;
}

export interface WriterScreenState {
  activeWritersTabs: ActiveWriterTab[];
  cursor: number;
}

export function createWriterScreenState(activeWritersTabs: ActiveWriterTab[] = []): WriterScreenState {
  return { activeWritersTabs, cursor: -1 };
}

const defaultWriterScreenState = createWriterScreenState();

function normalizeWriterTab(tab: ActiveWriterTab): ActiveWriterTab | null {
  const teamName = tab.teamName?.trim();
  const name = tab.name?.trim();
  const paneId = tab.paneId?.trim();
  if (!teamName || !name || !paneId) return null;
  return {
    ...tab,
    teamName,
    name,
    paneId,
    windowId: tab.windowId?.trim() || undefined,
  };
}

function replaceActiveWriterTabs(state: WriterScreenState, nextTabs: ActiveWriterTab[]): void {
  state.activeWritersTabs.splice(0, state.activeWritersTabs.length, ...nextTabs);
  if (state.activeWritersTabs.length === 0) state.cursor = -1;
  else if (state.cursor >= state.activeWritersTabs.length) state.cursor = state.activeWritersTabs.length - 1;
}

function isPaneAlive(terminal: any, paneId: string | undefined): paneId is string {
  if (!paneId) return false;
  if (!terminal?.isAlive) return true;
  try {
    return !!terminal.isAlive(paneId);
  } catch {
    return false;
  }
}

async function readLiveWriterMemberNames(teamName: string): Promise<Set<string> | undefined> {
  try {
    const config = await teams.readConfig(teamName);
    return new Set(
      config.members
        .filter(member => member.name !== "team-lead" && (member.role ?? "write") !== "read")
        .map(member => member.name)
    );
  } catch {
    return undefined;
  }
}

export function upsertWriterScreenTab(state: WriterScreenState, tab: ActiveWriterTab): void {
  const normalized = normalizeWriterTab(tab);
  if (!normalized) return;

  const existingIndex = state.activeWritersTabs.findIndex((item) => (
    item.teamName === normalized.teamName && (item.name === normalized.name || item.paneId === normalized.paneId)
  ));

  if (existingIndex >= 0) {
    state.activeWritersTabs.splice(existingIndex, 1, normalized);
    return;
  }

  state.activeWritersTabs.push(normalized);
}

export function removeWriterScreenTab(state: WriterScreenState, match: { teamName?: string; name?: string; paneId?: string }): void {
  const nextTabs = state.activeWritersTabs.filter((tab) => {
    if (match.teamName && tab.teamName !== match.teamName) return true;
    if (match.name && tab.name !== match.name) return true;
    if (match.paneId && tab.paneId !== match.paneId) return true;
    return false;
  });
  replaceActiveWriterTabs(state, nextTabs);
}

export async function pruneWriterScreenTabs(teamName: string, terminal: any, state = defaultWriterScreenState): Promise<ActiveWriterTab[]> {
  const liveWriterNames = await readLiveWriterMemberNames(teamName);
  const nextTabs = state.activeWritersTabs.filter((tab) => {
    if (tab.teamName !== teamName) return true;
    if (liveWriterNames && !liveWriterNames.has(tab.name)) return false;
    return isPaneAlive(terminal, tab.paneId);
  });
  replaceActiveWriterTabs(state, nextTabs);
  return state.activeWritersTabs.filter(tab => tab.teamName === teamName);
}

export async function buildWriterScreenTargets(teamName: string, terminal: any, state = defaultWriterScreenState): Promise<WriterScreenTarget[]> {
  const tabs = await pruneWriterScreenTabs(teamName, terminal, state);
  return tabs.map(tab => ({ ...tab, role: "write" as const }));
}

export async function cycleWriterScreen(teamName: string | null | undefined, terminal: any, state = defaultWriterScreenState): Promise<WriterScreenCycleResult> {
  if (!teamName) return { ok: false, reason: "No current team to cycle." };
  if (!terminal?.focusPane) return { ok: false, reason: "The active terminal adapter cannot focus tmux screens." };

  const targets = await buildWriterScreenTargets(teamName, terminal, state);
  if (targets.length === 0) return { ok: false, reason: `No active writer screens for ${teamName}.` };

  state.cursor = (state.cursor + 1) % targets.length;
  const target = targets[state.cursor] ?? targets[0];
  if (!target) return { ok: false, reason: `No focusable writer screens for ${teamName}.` };

  const focused = terminal.focusPane(target.paneId);
  if (!focused) {
    removeWriterScreenTab(state, { teamName: target.teamName, name: target.name, paneId: target.paneId });
    return { ok: false, reason: `Could not focus ${target.name} (${target.paneId}).`, target };
  }

  return { ok: true, target };
}

export function registerWriterScreenShortcut(pi: any, options: {
  getTeamName(): string | null | undefined;
  terminal: any;
  state?: WriterScreenState;
}): void {
  pi.registerShortcut?.(Key.alt("tab"), {
    description: "Cycle active writer-agent tmux screens",
    handler: async (ctx: any) => {
      const result = await cycleWriterScreen(options.getTeamName(), options.terminal, options.state ?? defaultWriterScreenState);
      if (!result.ok) {
        ctx.ui.notify(result.reason || "Could not cycle writer screens.", "warning");
        return;
      }

      const target = result.target!;
      ctx.ui.notify(`Switched to writer ${target.name} (${target.paneId}).`, "info");
    },
  });
}
