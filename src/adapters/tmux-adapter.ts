/**
 * Tmux Terminal Adapter
 * 
 * Implements the TerminalAdapter interface for tmux terminal multiplexer.
 */

import { TerminalAdapter, SpawnOptions, execCommand } from "../utils/terminal-adapter";

export class TmuxAdapter implements TerminalAdapter {
  readonly name = "tmux";

  detect(): boolean {
    // tmux is available if TMUX environment variable is set
    return !!process.env.TMUX;
  }

  getCurrentPaneId(): string | null {
    const paneId = process.env.TMUX_PANE?.trim();
    return paneId ? paneId : null;
  }

  getWindowIdForPane(paneId: string | null | undefined): string | null {
    if (!paneId) return null;

    try {
      const result = execCommand("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"]);
      if (result.status !== 0) return null;

      const windowId = result.stdout.trim();
      return windowId || null;
    } catch {
      return null;
    }
  }

  private isPaneUsable(paneId: string | null | undefined): paneId is string {
    if (!paneId) return false;

    try {
      const result = execCommand("tmux", ["display-message", "-p", "-t", paneId, "#{pane_id}"]);
      return result.status === 0 && result.stdout.trim() === paneId;
    } catch {
      return false;
    }
  }

  private getOriginPaneId(preferredPaneId?: string | null): string | null {
    if (this.isPaneUsable(preferredPaneId)) {
      return preferredPaneId;
    }

    const currentPaneId = this.getCurrentPaneId();
    if (this.isPaneUsable(currentPaneId)) {
      return currentPaneId;
    }

    return null;
  }

  spawn(options: SpawnOptions): string {
    const envArgs = Object.entries(options.env)
      .filter(([k]) => k.startsWith("PI_"))
      .map(([k, v]) => `${k}=${v}`);

    const originPaneId = this.getOriginPaneId(options.anchorPaneId);
    const originWindowId = this.getWindowIdForPane(originPaneId);
    const tmuxArgs = [
      "new-window",
      "-dP",
      "-F", "#{pane_id}",
      "-n", options.name,
    ];

    if (originWindowId) {
      // A bare `new-window -t @window` reuses the target window index; insert after it instead.
      tmuxArgs.push("-a", "-t", originWindowId);
    }

    tmuxArgs.push(
      "-c", options.cwd,
      "env", ...envArgs,
      "sh", "-c", options.command
    );

    const result = execCommand("tmux", tmuxArgs);
    
    if (result.status !== 0) {
      throw new Error(`tmux spawn failed with status ${result.status}: ${result.stderr}`);
    }

    const newPaneId = result.stdout.trim();
    if (newPaneId) {
      execCommand("tmux", ["select-pane", "-t", newPaneId, "-T", options.name]);
    }

    return newPaneId;
  }

  kill(paneId: string): void {
    if (!paneId) return;

    try {
      execCommand("tmux", ["kill-pane", "-t", paneId.trim()]);
    } catch {
      // Ignore errors - pane may already be dead
    }
  }

  isAlive(paneId: string): boolean {
    if (!paneId) return false;
    // A pane is alive if tmux still reports it as a valid pane id.
    return this.isPaneUsable(paneId.trim());
  }

  focusPane(paneId: string): boolean {
    const targetPaneId = paneId?.trim();
    if (!this.isPaneUsable(targetPaneId)) return false;

    const windowId = this.getWindowIdForPane(targetPaneId);
    if (windowId) {
      const windowResult = execCommand("tmux", ["select-window", "-t", windowId]);
      if (windowResult.status !== 0) return false;
    }

    const paneResult = execCommand("tmux", ["select-pane", "-t", targetPaneId]);
    return paneResult.status === 0;
  }

  setTitle(title: string): void {
    try {
      const paneId = this.getCurrentPaneId();
      const args = paneId
        ? ["select-pane", "-t", paneId, "-T", title]
        : ["select-pane", "-T", title];
      execCommand("tmux", args);
    } catch {
      // Ignore errors
    }
  }
}
