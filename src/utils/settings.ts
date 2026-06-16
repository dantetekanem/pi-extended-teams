/**
 * pi-extended-teams settings
 *
 * Loads configuration that drives agent roles, per-role and per-category model
 * selection, the watchdog buffer, the write-agent cap, and which pi extensions
 * spawned agents may load.
 *
 * Locations (project overrides global, both over built-in defaults):
 * - Global:  ~/.pi/agent/pi-extended-teams/settings.json
 * - Project: <project>/.pi/pi-extended-teams.json
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AgentRole = "read" | "write";

export const AGENT_ROLES: AgentRole[] = ["read", "write"];

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** Per-role default model/thinking. `null`/omitted means "inherit". */
export interface RoleModelConfig {
  model: string | null;
  thinking: string | null;
}

/** A named preset bundling a role with optional model/thinking overrides. */
export interface CategoryConfig {
  role?: AgentRole;
  model: string | null;
  thinking: string | null;
}

export interface WatchdogConfig {
  /** Grace buffer (seconds) added on top of the heartbeat interval. */
  bufferSeconds: number;
}

export interface WriteAgentsConfig {
  /** Maximum concurrent write agents. Read agents are unlimited. */
  maxConcurrent: number;
  /** When at capacity, queue the spawn instead of rejecting it. */
  queueOverflow: boolean;
}

export interface ExtensionsConfig {
  /** Extensions loaded into spawned agents (e.g. "pi-emote"). */
  allow: string[];
  /** Extensions explicitly kept out of spawned agents. */
  block: string[];
}

export interface DebugConfig {
  /** Write spawn decisions and terminal launch results to the team debug log. */
  enabled: boolean;
}

export interface PiExtendedTeamsSettings {
  watchdog: WatchdogConfig;
  writeAgents: WriteAgentsConfig;
  roles: Record<AgentRole, RoleModelConfig>;
  categories: Record<string, CategoryConfig>;
  extensions: ExtensionsConfig;
  debug: DebugConfig;
}

export const DEFAULT_SETTINGS: PiExtendedTeamsSettings = {
  watchdog: { bufferSeconds: 30 },
  writeAgents: { maxConcurrent: 3, queueOverflow: true },
  roles: {
    read: { model: null, thinking: null },
    write: { model: null, thinking: null },
  },
  categories: {},
  extensions: { allow: [], block: [] },
  debug: { enabled: false },
};

export function globalSettingsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".pi", "agent", "pi-extended-teams", "settings.json");
}

export function projectSettingsPath(projectDir: string): string {
  return path.join(projectDir, ".pi", "pi-extended-teams.json");
}

function readJson(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return Array.from(
    new Set(value.map((v) => String(v).trim()).filter(Boolean))
  );
}

function normalizeRole(value: unknown): AgentRole | undefined {
  return value === "read" || value === "write" ? value : undefined;
}

function normalizeThinking(value: unknown): string | null {
  const s = toStringOrNull(value);
  return s && THINKING_LEVELS.has(s) ? s : null;
}

function mergeRoleConfig(base: RoleModelConfig, raw: any): RoleModelConfig {
  if (!raw || typeof raw !== "object") return base;
  return {
    model: "model" in raw ? toStringOrNull(raw.model) : base.model,
    thinking: "thinking" in raw ? normalizeThinking(raw.thinking) : base.thinking,
  };
}

/**
 * Apply one raw settings object on top of an accumulator, in place.
 */
function applyLayer(acc: PiExtendedTeamsSettings, raw: any): void {
  if (!raw || typeof raw !== "object") return;

  if (raw.watchdog && typeof raw.watchdog === "object") {
    const b = Number(raw.watchdog.bufferSeconds);
    if (Number.isFinite(b) && b >= 0) acc.watchdog.bufferSeconds = b;
  }

  if (raw.writeAgents && typeof raw.writeAgents === "object") {
    const m = Number(raw.writeAgents.maxConcurrent);
    if (Number.isFinite(m) && m >= 1) acc.writeAgents.maxConcurrent = Math.floor(m);
    if (typeof raw.writeAgents.queueOverflow === "boolean") {
      acc.writeAgents.queueOverflow = raw.writeAgents.queueOverflow;
    }
  }

  if (raw.roles && typeof raw.roles === "object") {
    acc.roles.read = mergeRoleConfig(acc.roles.read, raw.roles.read);
    acc.roles.write = mergeRoleConfig(acc.roles.write, raw.roles.write);
  }

  if (raw.categories && typeof raw.categories === "object") {
    for (const [name, value] of Object.entries<any>(raw.categories)) {
      if (!value || typeof value !== "object") continue;
      acc.categories[name] = {
        role: normalizeRole(value.role),
        model: toStringOrNull(value.model),
        thinking: normalizeThinking(value.thinking),
      };
    }
  }

  if (raw.extensions && typeof raw.extensions === "object") {
    const allow = toStringList(raw.extensions.allow);
    const block = toStringList(raw.extensions.block);
    if (allow) acc.extensions.allow = allow;
    if (block) acc.extensions.block = block;
  }

  if (typeof raw.debug === "boolean") {
    acc.debug.enabled = raw.debug;
  } else if (raw.debug && typeof raw.debug === "object" && typeof raw.debug.enabled === "boolean") {
    acc.debug.enabled = raw.debug.enabled;
  }
}

/**
 * Load merged settings: defaults < global < project.
 */
export function loadSettings(options?: {
  projectDir?: string;
  homeDir?: string;
}): PiExtendedTeamsSettings {
  const homeDir = options?.homeDir ?? os.homedir();
  const acc: PiExtendedTeamsSettings = structuredClone(DEFAULT_SETTINGS);

  applyLayer(acc, readJson(globalSettingsPath(homeDir)));
  if (options?.projectDir) {
    applyLayer(acc, readJson(projectSettingsPath(options.projectDir)));
  }

  return acc;
}

export interface ResolveModelInput {
  role: AgentRole;
  /** Optional category name referencing settings.categories. */
  category?: string;
  /** Explicit fully-qualified model passed at spawn time. */
  explicitModel?: string | null;
  /** Explicit thinking level passed at spawn time. */
  explicitThinking?: string | null;
  /** Team default model. */
  teamDefaultModel?: string | null;
  /** Current session model, used as the final fallback. */
  currentModel?: string | null;
}

export interface ResolvedModel {
  model: string | null;
  thinking: string | null;
  /** Where the model came from, for diagnostics. */
  modelSource: "explicit" | "category" | "role" | "team" | "current" | "none";
}

/**
 * Resolve a member's effective model/thinking.
 *
 * Model precedence:   explicit -> category -> role default -> team default -> current
 * Thinking precedence: explicit -> category -> role default (else none)
 *
 * Today read and write typically resolve to the same model (role defaults are
 * null = inherit). The precedence chain lets that diverge purely via settings,
 * without code changes.
 */
export function resolveModel(
  settings: PiExtendedTeamsSettings,
  input: ResolveModelInput
): ResolvedModel {
  const category = input.category ? settings.categories[input.category] : undefined;
  if (input.category && !category) {
    throw new Error(
      `Unknown category "${input.category}". Define it under categories in settings.json or omit it.`
    );
  }

  const roleDefaults = settings.roles[input.role];

  const explicitModel = toStringOrNull(input.explicitModel ?? null);
  const teamDefault = toStringOrNull(input.teamDefaultModel ?? null);
  const current = toStringOrNull(input.currentModel ?? null);

  let model: string | null;
  let modelSource: ResolvedModel["modelSource"];
  if (explicitModel) {
    model = explicitModel;
    modelSource = "explicit";
  } else if (category?.model) {
    model = category.model;
    modelSource = "category";
  } else if (roleDefaults.model) {
    model = roleDefaults.model;
    modelSource = "role";
  } else if (teamDefault) {
    model = teamDefault;
    modelSource = "team";
  } else if (current) {
    model = current;
    modelSource = "current";
  } else {
    model = null;
    modelSource = "none";
  }

  const explicitThinking = normalizeThinking(input.explicitThinking);
  const thinking =
    explicitThinking ??
    category?.thinking ??
    roleDefaults.thinking ??
    null;

  return { model, thinking, modelSource };
}

/**
 * Resolve which extension sources spawned agents should load.
 *
 * Spawned agents launch with `--no-extensions` (nothing auto-discovered) plus
 * the pi-extended-teams extension itself. This returns the additional extension
 * sources to load (e.g. "npm:pi-emote"), honoring the allow list minus
 * anything in the block list.
 */
export function resolveAllowedExtensions(settings: PiExtendedTeamsSettings): string[] {
  const blocked = new Set(settings.extensions.block);
  return settings.extensions.allow.filter((source) => !blocked.has(source));
}

/**
 * Effective role for a category: category.role wins, else the requested role.
 */
export function resolveRole(
  settings: PiExtendedTeamsSettings,
  requestedRole: AgentRole,
  category?: string
): AgentRole {
  if (category) {
    const cat = settings.categories[category];
    if (cat?.role) return cat.role;
  }
  return requestedRole;
}
