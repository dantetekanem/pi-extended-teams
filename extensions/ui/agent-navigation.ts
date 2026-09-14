import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { RunningReadAgent } from "../runtime/types";
import { openAgentFollowView } from "./agent-follow-view";

export interface AgentNavigationOptions {
  getAgents(): RunningReadAgent[];
  interruptAgent?(name: string): void | Promise<void>;
  stopAgent?(name: string): void | Promise<void>;
  sendMessage?(name: string, content: string): void | Promise<void>;
}

type NavigationEditorFactory = ((tui: any, theme: any, keybindings: any) => any) & {
  piExtendedTeamsBaseFactory?: ((tui: any, theme: any, keybindings: any) => any) | null;
};

function uniqueAgentsByName(agents: RunningReadAgent[]): RunningReadAgent[] {
  return agents.filter((agent, index) => agents.findIndex(candidate => candidate.name === agent.name) === index);
}

export function hasActiveReadAgentLifecycle(agent: RunningReadAgent): boolean {
  return agent.teardownState !== "stopping"
    && agent.teardownState !== "quarantined"
    && agent.teardownState !== "persistence_failed"
    && agent.teardownState !== "finalized";
}

/** Mirrors the activity footer's order for the running and runtime-only populations. */
export function orderAgentNavigationEntries(
  runningAgents: RunningReadAgent[],
  runtimeAgents: RunningReadAgent[],
): RunningReadAgent[] {
  const uniqueRunningAgents = uniqueAgentsByName(runningAgents);
  const activeRunningAgents = uniqueRunningAgents.filter(hasActiveReadAgentLifecycle);
  const retainedAgents = uniqueRunningAgents.filter(agent => !hasActiveReadAgentLifecycle(agent));
  const runningNames = new Set(uniqueRunningAgents.map(agent => agent.name));
  const uniqueRuntimeAgents = uniqueAgentsByName(runtimeAgents)
    .filter(agent => !runningNames.has(agent.name));
  const byName = (a: RunningReadAgent, b: RunningReadAgent) => a.name.localeCompare(b.name);
  const isWriteAgent = (agent: RunningReadAgent) => agent.role === "write";

  return [
    ...activeRunningAgents.filter(isWriteAgent).sort(byName),
    ...uniqueRuntimeAgents.filter(isWriteAgent).sort(byName),
    ...uniqueRuntimeAgents.filter(agent => !isWriteAgent(agent)).sort(byName),
    ...activeRunningAgents.filter(agent => !isWriteAgent(agent)).sort(byName),
    ...retainedAgents.sort(byName),
  ];
}

export function wrapEditorForAgentNavigation(editor: any, openAgentView: () => boolean): any {
  const originalHandleInput = editor.handleInput.bind(editor);
  editor.handleInput = (data: string) => {
    if (matchesKey(data, Key.down) && editor.getText?.().length === 0 && openAgentView()) return;
    originalHandleInput(data);
  };
  return editor;
}

export function installAgentNavigation(ctx: any, options: AgentNavigationOptions): void {
  if (ctx.mode && ctx.mode !== "tui") return;
  if (!ctx.ui?.setEditorComponent) return;

  const currentFactory = ctx.ui.getEditorComponent?.() as NavigationEditorFactory | undefined;
  const baseFactory = currentFactory && Object.hasOwn(currentFactory, "piExtendedTeamsBaseFactory")
    ? currentFactory.piExtendedTeamsBaseFactory ?? undefined
    : currentFactory;
  let opening = false;

  const navigationFactory: NavigationEditorFactory = (tui: any, theme: any, keybindings: any) => {
    const editor = baseFactory
      ? baseFactory(tui, theme, keybindings)
      : new CustomEditor(tui, theme, keybindings);

    return wrapEditorForAgentNavigation(editor, () => {
      const agents = options.getAgents();
      if (opening || agents.length === 0) return false;
      opening = true;
      void openAgentFollowView(ctx, {
        getAgents: options.getAgents,
        initialAgentName: agents[0]?.name,
        interruptAgent: options.interruptAgent,
        stopAgent: options.stopAgent,
        sendMessage: options.sendMessage,
      }).catch(() => {}).finally(() => { opening = false; });
      return true;
    });
  };
  navigationFactory.piExtendedTeamsBaseFactory = baseFactory ?? null;
  ctx.ui.setEditorComponent(navigationFactory);
}
