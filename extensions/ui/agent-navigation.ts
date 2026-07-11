import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey } from "@mariozechner/pi-tui";
import type { RunningReadAgent } from "../runtime/types";
import { openAgentFollowView } from "./agent-follow-view";

export interface AgentNavigationOptions {
  getAgents(): RunningReadAgent[];
  stopAgent?(name: string): void | Promise<void>;
}

type NavigationEditorFactory = ((tui: any, theme: any, keybindings: any) => any) & {
  piExtendedTeamsBaseFactory?: ((tui: any, theme: any, keybindings: any) => any) | null;
};

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
        initialAgentName: agents.slice().sort((a, b) => a.name.localeCompare(b.name))[0]?.name,
        stopAgent: options.stopAgent,
      }).finally(() => { opening = false; });
      return true;
    });
  };
  navigationFactory.piExtendedTeamsBaseFactory = baseFactory ?? null;
  ctx.ui.setEditorComponent(navigationFactory);
}
