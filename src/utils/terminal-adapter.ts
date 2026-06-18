/**
 * Terminal Adapter Interface
 *
 * Abstracts tmux window/pane operations to provide a unified API for spawning,
 * managing, and terminating writer screens. pi-extended-teams is tmux-only.
 */

import { spawnSync } from "node:child_process";

/**
 * Options for spawning a new terminal pane
 */
export interface SpawnOptions {
  /** Name/identifier for the background tmux window/pane */
  name: string;
  /** Working directory for the new pane */
  cwd: string;
  /** Command to execute in the pane */
  command: string;
  /** Environment variables to set (key-value pairs) */
  env: Record<string, string>;
  /** Optional pane ID used to create the background window in the same tmux session */
  anchorPaneId?: string;
}

/**
 * Terminal Adapter Interface
 *
 * Implementations provide tmux-specific logic for writer screen management.
 */
export interface TerminalAdapter {
  /** Unique name identifier for this terminal type */
  readonly name: string;

  /**
   * Detect if this terminal is currently available/active.
   *
   * @returns true if this terminal should be used
   */
  detect(): boolean;

  /**
   * Spawn a new background terminal screen with the given options.
   *
   * @param options - Spawn configuration
   * @returns Pane ID that can be used for subsequent operations
   * @throws Error if spawn fails
   */
  spawn(options: SpawnOptions): string;

  /**
   * Return the current tmux pane ID when available.
   */
  getCurrentPaneId?(): string | null;

  /**
   * Return the tmux window ID for a pane when available.
   */
  getWindowIdForPane?(paneId: string | null | undefined): string | null;

  /**
   * Focus/select a tmux pane so the user can watch it live.
   *
   * @returns true when the pane was selected
   */
  focusPane?(paneId: string): boolean;

  /**
   * Kill/terminate a terminal pane.
   * Should be idempotent - no error if pane doesn't exist.
   *
   * @param paneId - The pane ID returned from spawn()
   */
  kill(paneId: string): void;

  /**
   * Check if a terminal pane is still alive/active.
   *
   * @param paneId - The pane ID returned from spawn()
   * @returns true if pane exists and is active
   */
  isAlive(paneId: string): boolean;

  /**
   * Set the title of the current terminal pane.
   * Used for identifying panes/windows in the terminal UI.
   *
   * @param title - The title to set
   */
  setTitle(title: string): void;
}

/**
 * Base helper for adapters to execute commands synchronously.
 */
export function execCommand(command: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(command, args, { encoding: "utf-8" });
  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    status: result.status,
  };
}
