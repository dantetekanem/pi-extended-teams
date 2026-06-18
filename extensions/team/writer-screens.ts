import { Key } from "@mariozechner/pi-tui";
import * as teams from "../../src/utils/teams";

export interface WriterScreenTarget {
  name: string;
  role: "lead" | "write";
  paneId: string;
  windowId?: string;
}

export interface WriterScreenCycleResult {
  ok: boolean;
  reason?: string;
  target?: WriterScreenTarget;
}

function isPaneAlive(terminal: any, paneId: string | undefined): paneId is string {
  if (!paneId) return false;
  return terminal?.isAlive ? !!terminal.isAlive(paneId) : true;
}

export async function buildWriterScreenTargets(teamName: string, terminal: any): Promise<WriterScreenTarget[]> {
  const config = await teams.readConfig(teamName);
  const targets: WriterScreenTarget[] = [];
  const lead = config.members.find(member => member.name === "team-lead");
  const leadPaneId = lead?.tmuxPaneId;

  if (isPaneAlive(terminal, leadPaneId)) {
    targets.push({
      name: "main",
      role: "lead",
      paneId: leadPaneId,
      windowId: lead?.windowId,
    });
  }

  for (const member of config.members) {
    if (member.name === "team-lead" || (member.role ?? "write") === "read") continue;
    if (!isPaneAlive(terminal, member.tmuxPaneId)) continue;
    targets.push({
      name: member.name,
      role: "write",
      paneId: member.tmuxPaneId,
      windowId: member.windowId,
    });
  }

  return targets;
}

export async function cycleWriterScreen(teamName: string | null | undefined, terminal: any): Promise<WriterScreenCycleResult> {
  if (!teamName) return { ok: false, reason: "No current team to cycle." };
  if (!terminal?.focusPane) return { ok: false, reason: "The active terminal adapter cannot focus tmux screens." };

  const targets = await buildWriterScreenTargets(teamName, terminal);
  const writerTargets = targets.filter(target => target.role === "write");
  if (writerTargets.length === 0) return { ok: false, reason: `No active writer screens for ${teamName}.` };

  const currentPaneId = terminal.getCurrentPaneId?.();
  const currentIndex = currentPaneId ? targets.findIndex(target => target.paneId === currentPaneId) : -1;
  const firstWriterIndex = targets.findIndex(target => target.role === "write");
  const nextIndex = currentIndex >= 0
    ? (currentIndex + 1) % targets.length
    : firstWriterIndex;
  const target = targets[nextIndex] ?? writerTargets[0];

  if (!target) return { ok: false, reason: `No focusable writer screens for ${teamName}.` };
  const focused = terminal.focusPane(target.paneId);
  if (!focused) return { ok: false, reason: `Could not focus ${target.name} (${target.paneId}).`, target };
  return { ok: true, target };
}

export function registerWriterScreenShortcut(pi: any, options: {
  getTeamName(): string | null | undefined;
  terminal: any;
}): void {
  pi.registerShortcut?.(Key.alt("tab"), {
    description: "Cycle main and background writer-agent tmux screens",
    handler: async (ctx: any) => {
      const result = await cycleWriterScreen(options.getTeamName(), options.terminal);
      if (!result.ok) {
        ctx.ui.notify(result.reason || "Could not cycle writer screens.", "warning");
        return;
      }

      const target = result.target!;
      const label = target.role === "lead" ? "main" : `writer ${target.name}`;
      ctx.ui.notify(`Switched to ${label} (${target.paneId}).`, "info");
    },
  });
}
