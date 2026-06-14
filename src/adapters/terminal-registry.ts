/**
 * Terminal Registry
 *
 * pi-extended-teams is tmux-only. This module resolves the single tmux
 * adapter and fails fast when not running inside a tmux session.
 */

import { TerminalAdapter } from "../utils/terminal-adapter";
import { TmuxAdapter } from "./tmux-adapter";

/**
 * Cached detected adapter
 */
let cachedAdapter: TerminalAdapter | null = null;

/**
 * Detect and return the tmux adapter, or null if not running inside tmux.
 *
 * @returns The tmux adapter, or null if TMUX is not set
 */
export function getTerminalAdapter(): TerminalAdapter | null {
  if (cachedAdapter) {
    return cachedAdapter;
  }

  const adapter = new TmuxAdapter();
  if (adapter.detect()) {
    cachedAdapter = adapter;
    return adapter;
  }

  return null;
}

/**
 * Require the tmux adapter, throwing a clear error when unavailable.
 */
export function requireTerminalAdapter(): TerminalAdapter {
  const adapter = getTerminalAdapter();
  if (!adapter) {
    throw new Error(
      "pi-extended-teams requires running inside tmux. Start a tmux session and launch pi from within it."
    );
  }
  return adapter;
}

/**
 * Clear the cached adapter (useful for testing or environment changes)
 */
export function clearAdapterCache(): void {
  cachedAdapter = null;
}

/**
 * Set a specific adapter (useful for testing or forced selection)
 */
export function setAdapter(adapter: TerminalAdapter): void {
  cachedAdapter = adapter;
}

/**
 * Check if a tmux adapter is available.
 *
 * @returns true if running inside tmux
 */
export function hasTerminalAdapter(): boolean {
  return getTerminalAdapter() !== null;
}

/**
 * Get the name of the currently detected terminal adapter.
 *
 * @returns The adapter name, or null if none detected
 */
export function getTerminalName(): string | null {
  return getTerminalAdapter()?.name ?? null;
}
