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
import { THINKING_LEVEL_NAMES, type ThinkingLevelName } from "./thinking-levels";

export { THINKING_LEVEL_NAMES, type ThinkingLevelName } from "./thinking-levels";

export type AgentRole = "read" | "write";

export const AGENT_ROLES: AgentRole[] = ["read", "write"];

const THINKING_LEVELS = new Set<string>(THINKING_LEVEL_NAMES);

export const FAVORITE_MODEL_SLOTS = [
  "read-collect",
  "read-review",
  "read-analyze",
  "read-critical",
  "write-patch",
  "write-feature",
  "write-system",
  "write-critical",
] as const;
export type CanonicalFavoriteModelSlot = (typeof FAVORITE_MODEL_SLOTS)[number];

export const LEGACY_FAVORITE_MODEL_SLOT_ALIASES = {
  "reading-fast": "read-collect",
  "reading-default": "read-review",
  "reading-hard": "read-critical",
  "writing-basic": "write-patch",
  "writing-hard": "write-system",
} as const satisfies Record<string, CanonicalFavoriteModelSlot>;
export type LegacyFavoriteModelSlot = keyof typeof LEGACY_FAVORITE_MODEL_SLOT_ALIASES;
/** Canonical tier or a minor-release compatibility alias accepted at public boundaries. */
export type FavoriteModelSlot = CanonicalFavoriteModelSlot | LegacyFavoriteModelSlot;
export const LEGACY_FAVORITE_MODEL_SLOTS = Object.keys(LEGACY_FAVORITE_MODEL_SLOT_ALIASES) as LegacyFavoriteModelSlot[];
export const ACCEPTED_FAVORITE_MODEL_SLOTS = [
  ...FAVORITE_MODEL_SLOTS,
  ...LEGACY_FAVORITE_MODEL_SLOTS,
] as readonly FavoriteModelSlot[];
const CANONICAL_FAVORITE_MODEL_SLOT_SET = new Set<string>(FAVORITE_MODEL_SLOTS);
const FAVORITE_MODEL_SLOT_SET = new Set<string>(ACCEPTED_FAVORITE_MODEL_SLOTS);

/** Per-role default model/thinking. `null`/omitted means "inherit". */
export interface RoleModelConfig {
  model: string | null;
  thinking: string | null;
}

/** A favorite model slot selected by spawn-time workload intent. */
export interface FavoriteModelConfig {
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
  /** Maximum concurrent write agents. */
  maxConcurrent: number;
  /** When at capacity, queue the spawn instead of rejecting it. */
  queueOverflow: boolean;
}

export interface ReadAgentsConfig {
  /** Maximum concurrent in-process read agents for a team. */
  maxConcurrent: number;
  /** When at capacity, queue the spawn instead of rejecting it. */
  queueOverflow: boolean;
}

export interface ReadHelpersConfig {
  /** Maximum concurrent lead-run read helpers for a team. */
  maxConcurrent: number;
  /** When at capacity, keep helper requests queued instead of rejecting them. */
  queueOverflow: boolean;
}

export interface ExtensionsConfig {
  /** `null` inherits every effective Pi extension; an array is an explicit selection. */
  allow: string[] | null;
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
  readAgents: ReadAgentsConfig;
  readHelpers: ReadHelpersConfig;
  roles: Record<AgentRole, RoleModelConfig>;
  favoriteModels: Partial<Record<FavoriteModelSlot, FavoriteModelConfig>>;
  categories: Record<string, CategoryConfig>;
  extensions: ExtensionsConfig;
  debug: DebugConfig;
}

export const DEFAULT_WRITE_AGENT_MAX_CONCURRENT = 100;
export const DEFAULT_READ_AGENT_MAX_CONCURRENT = 25;
export const DEFAULT_READ_HELPER_MAX_CONCURRENT = 10;

export const DEFAULT_SETTINGS: PiExtendedTeamsSettings = {
  watchdog: { bufferSeconds: 30 },
  writeAgents: { maxConcurrent: DEFAULT_WRITE_AGENT_MAX_CONCURRENT, queueOverflow: true },
  readAgents: { maxConcurrent: DEFAULT_READ_AGENT_MAX_CONCURRENT, queueOverflow: true },
  readHelpers: { maxConcurrent: DEFAULT_READ_HELPER_MAX_CONCURRENT, queueOverflow: true },
  roles: {
    read: { model: null, thinking: null },
    write: { model: null, thinking: null },
  },
  favoriteModels: {},
  categories: {},
  extensions: { allow: null, block: [] },
  debug: { enabled: false },
};

export function globalSettingsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".pi", "agent", "pi-extended-teams", "settings.json");
}

export function projectSettingsPath(projectDir: string): string {
  return path.join(projectDir, ".pi", "pi-extended-teams.json");
}

export interface ProjectExtensionAllowOverride {
  filePath: string;
  allow: string[] | null;
}

/**
 * Read only the project-local `extensions.allow` layer, without merging it with
 * global/default settings. Callers must establish project trust before using it.
 */
export function readProjectExtensionAllowOverride(projectDir: string): ProjectExtensionAllowOverride | null {
  const filePath = projectSettingsPath(projectDir);
  const raw = readJson(filePath);
  const extensions = raw?.extensions;
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) return null;
  if (extensions.allow === null) return { filePath, allow: null };
  const allow = toStringList(extensions.allow);
  return allow === undefined ? null : { filePath, allow };
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

export function isCanonicalFavoriteModelSlot(value: unknown): value is CanonicalFavoriteModelSlot {
  return typeof value === "string" && CANONICAL_FAVORITE_MODEL_SLOT_SET.has(value);
}

export function isFavoriteModelSlot(value: unknown): value is FavoriteModelSlot {
  return typeof value === "string" && FAVORITE_MODEL_SLOT_SET.has(value);
}

export function normalizeFavoriteModelSlot(value: unknown): CanonicalFavoriteModelSlot | null {
  if (isCanonicalFavoriteModelSlot(value)) return value;
  if (typeof value !== "string") return null;
  return LEGACY_FAVORITE_MODEL_SLOT_ALIASES[value as LegacyFavoriteModelSlot] ?? null;
}

/**
 * Project a value read from persisted state to its canonical slot without
 * mutating storage or changing the contract for absent/unknown values.
 */
export function canonicalPersistedModelSlot<T>(value: T): T | CanonicalFavoriteModelSlot {
  return normalizeFavoriteModelSlot(value) ?? value;
}

export function roleForFavoriteModelSlot(slot: FavoriteModelSlot): AgentRole {
  const canonical = normalizeFavoriteModelSlot(slot);
  if (!canonical) throw new Error(`Unknown favorite model slot "${String(slot)}".`);
  return canonical.startsWith("write-") ? "write" : "read";
}

export interface ResolvedFavoriteModelLevel {
  slot: CanonicalFavoriteModelSlot;
  role: AgentRole;
  model: string;
  thinking: ThinkingLevelName;
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

function favoriteModelConfigFromRaw(
  raw: any,
  base?: FavoriteModelConfig
): FavoriteModelConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    model: "model" in raw ? toStringOrNull(raw.model) : (base?.model ?? null),
    thinking: "thinking" in raw ? normalizeThinking(raw.thinking) : (base?.thinking ?? null),
  };
}

/**
 * Apply one raw settings object on top of an accumulator, in place.
 */
function applyLayer(acc: PiExtendedTeamsSettings, raw: any, options: { favoriteModels?: boolean } = {}): void {
  if (!raw || typeof raw !== "object") return;
  const includeFavoriteModels = options.favoriteModels !== false;

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

  if (raw.readAgents && typeof raw.readAgents === "object") {
    const m = Number(raw.readAgents.maxConcurrent);
    if (Number.isFinite(m) && m >= 1) acc.readAgents.maxConcurrent = Math.floor(m);
    if (typeof raw.readAgents.queueOverflow === "boolean") {
      acc.readAgents.queueOverflow = raw.readAgents.queueOverflow;
    }
  }

  if (raw.readHelpers && typeof raw.readHelpers === "object") {
    const m = Number(raw.readHelpers.maxConcurrent);
    if (Number.isFinite(m) && m >= 1) acc.readHelpers.maxConcurrent = Math.floor(m);
    if (typeof raw.readHelpers.queueOverflow === "boolean") {
      acc.readHelpers.queueOverflow = raw.readHelpers.queueOverflow;
    }
  }

  if (raw.roles && typeof raw.roles === "object") {
    acc.roles.read = mergeRoleConfig(acc.roles.read, raw.roles.read);
    acc.roles.write = mergeRoleConfig(acc.roles.write, raw.roles.write);
  }

  if (includeFavoriteModels && raw.favoriteModels && typeof raw.favoriteModels === "object") {
    // Read aliases first, then canonical tiers, so canonical keys win regardless
    // of JSON property order when both forms are present.
    for (const legacySlot of LEGACY_FAVORITE_MODEL_SLOTS) {
      const config = favoriteModelConfigFromRaw(raw.favoriteModels[legacySlot]);
      if (config) acc.favoriteModels[LEGACY_FAVORITE_MODEL_SLOT_ALIASES[legacySlot]] = config;
    }
    for (const canonicalSlot of FAVORITE_MODEL_SLOTS) {
      const config = favoriteModelConfigFromRaw(
        raw.favoriteModels[canonicalSlot],
        acc.favoriteModels[canonicalSlot]
      );
      if (config) acc.favoriteModels[canonicalSlot] = config;
    }
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
    if (raw.extensions.allow === null) {
      acc.extensions.allow = null;
    } else {
      const allow = toStringList(raw.extensions.allow);
      if (allow) acc.extensions.allow = allow;
    }
    const block = toStringList(raw.extensions.block);
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
    // Favorite model slots are intentionally global-only: /agents-favorite-models
    // writes ~/.pi/agent/pi-extended-teams/settings.json, so spawn resolution must
    // not be shadowed by project-local slot values the picker cannot update.
    applyLayer(acc, readJson(projectSettingsPath(options.projectDir)), { favoriteModels: false });
  }

  return acc;
}

function readRawSettingsObject(filePath: string): Record<string, any> {
  const raw = readJson(filePath);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function writeRawSettingsObject(filePath: string, raw: Record<string, any>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`);
}

function mergeRawFavoriteModelValues(base: any, override: any): any {
  const baseIsObject = base && typeof base === "object" && !Array.isArray(base);
  const overrideIsObject = override && typeof override === "object" && !Array.isArray(override);
  return baseIsObject && overrideIsObject ? { ...base, ...override } : override;
}

function canonicalizeFavoriteModelKeys(
  favoriteModels: Record<string, any>,
  options: { preserveUnknown: boolean }
): Record<string, any> {
  const next: Record<string, any> = {};
  if (options.preserveUnknown) {
    for (const [slot, config] of Object.entries(favoriteModels)) {
      if (!isFavoriteModelSlot(slot)) next[slot] = config;
    }
  }
  for (const legacySlot of LEGACY_FAVORITE_MODEL_SLOTS) {
    if (Object.prototype.hasOwnProperty.call(favoriteModels, legacySlot)) {
      next[LEGACY_FAVORITE_MODEL_SLOT_ALIASES[legacySlot]] = favoriteModels[legacySlot];
    }
  }
  for (const canonicalSlot of FAVORITE_MODEL_SLOTS) {
    if (Object.prototype.hasOwnProperty.call(favoriteModels, canonicalSlot)) {
      next[canonicalSlot] = mergeRawFavoriteModelValues(next[canonicalSlot], favoriteModels[canonicalSlot]);
    }
  }
  return next;
}

export function setGlobalFavoriteModel(
  slot: FavoriteModelSlot,
  config: FavoriteModelConfig,
  options?: { homeDir?: string }
): void {
  const canonicalSlot = normalizeFavoriteModelSlot(slot);
  if (!canonicalSlot) throw new Error(`Unknown favorite model slot "${slot}".`);
  const model = toStringOrNull(config.model);
  const thinking = normalizeThinking(config.thinking);
  if (!model) throw new Error(`Favorite model slot "${canonicalSlot}" requires a fully qualified provider/model.`);
  if (!thinking) throw new Error(`Favorite model slot "${canonicalSlot}" requires a valid thinking level.`);

  const filePath = globalSettingsPath(options?.homeDir ?? os.homedir());
  const raw = readRawSettingsObject(filePath);
  const existing = raw.favoriteModels && typeof raw.favoriteModels === "object" && !Array.isArray(raw.favoriteModels)
    ? raw.favoriteModels
    : {};
  const favoriteModels = canonicalizeFavoriteModelKeys(existing, { preserveUnknown: true });
  favoriteModels[canonicalSlot] = { model, thinking };
  raw.favoriteModels = favoriteModels;
  writeRawSettingsObject(filePath, raw);
}

export function clearGlobalFavoriteModels(options?: {
  homeDir?: string;
  slot?: FavoriteModelSlot;
}): void {
  const canonicalSlot = options?.slot ? normalizeFavoriteModelSlot(options.slot) : null;
  if (options?.slot && !canonicalSlot) {
    throw new Error(`Unknown favorite model slot "${options.slot}".`);
  }

  const filePath = globalSettingsPath(options?.homeDir ?? os.homedir());
  const raw = readRawSettingsObject(filePath);
  const existing = raw.favoriteModels && typeof raw.favoriteModels === "object" && !Array.isArray(raw.favoriteModels)
    ? raw.favoriteModels
    : {};
  const favoriteModels = canonicalizeFavoriteModelKeys(existing, { preserveUnknown: true });

  if (canonicalSlot) delete favoriteModels[canonicalSlot];
  else for (const slot of FAVORITE_MODEL_SLOTS) delete favoriteModels[slot];

  raw.favoriteModels = favoriteModels;
  writeRawSettingsObject(filePath, raw);
}

export function replaceGlobalFavoriteModels(
  favoriteModels: Partial<Record<FavoriteModelSlot, FavoriteModelConfig>>,
  options?: { homeDir?: string }
): void {
  const canonicalInput = canonicalizeFavoriteModelKeys(favoriteModels, { preserveUnknown: false });
  const next: Partial<Record<CanonicalFavoriteModelSlot, FavoriteModelConfig>> = {};
  for (const slot of FAVORITE_MODEL_SLOTS) {
    const config = canonicalInput[slot];
    if (!config) continue;
    const model = toStringOrNull(config.model);
    const thinking = normalizeThinking(config.thinking);
    if (!model || !thinking) continue;
    next[slot] = { model, thinking };
  }

  const filePath = globalSettingsPath(options?.homeDir ?? os.homedir());
  const raw = readRawSettingsObject(filePath);
  raw.favoriteModels = next;
  writeRawSettingsObject(filePath, raw);
}

/** Persist the spawned-agent extension policy without replacing unrelated settings. */
export function replaceGlobalExtensionAllow(
  allow: string[] | null,
  options?: { homeDir?: string }
): void {
  const filePath = globalSettingsPath(options?.homeDir ?? os.homedir());
  const raw = readRawSettingsObject(filePath);
  const extensions = raw.extensions && typeof raw.extensions === "object" && !Array.isArray(raw.extensions)
    ? { ...raw.extensions }
    : {};
  extensions.allow = allow === null ? null : (toStringList(allow) ?? []);
  raw.extensions = extensions;
  writeRawSettingsObject(filePath, raw);
}

export function requireConfiguredFavoriteModel(
  settings: PiExtendedTeamsSettings,
  slot: unknown
): { slot: CanonicalFavoriteModelSlot; config: FavoriteModelConfig } | null {
  if (slot === undefined || slot === null || slot === "") return null;
  const canonicalSlot = normalizeFavoriteModelSlot(slot);
  if (!canonicalSlot) {
    throw new Error(
      `Unknown favorite model slot "${String(slot)}". Use one of: ${FAVORITE_MODEL_SLOTS.join(", ")}.`
    );
  }

  const config = settings.favoriteModels[canonicalSlot]
    ?? (typeof slot === "string" && isFavoriteModelSlot(slot) ? settings.favoriteModels[slot] : undefined);
  if (!config?.model || !config.thinking) {
    throw new Error(
      `Favorite model slot "${canonicalSlot}" is not configured. Run /agents-favorite-models set ${canonicalSlot} <provider/model> <thinking>.`
    );
  }
  return { slot: canonicalSlot, config };
}

export function requireFavoriteModelLevel(
  settings: PiExtendedTeamsSettings,
  slot: unknown
): ResolvedFavoriteModelLevel {
  const favorite = requireConfiguredFavoriteModel(settings, slot);
  if (!favorite?.config.model || !favorite.config.thinking) {
    throw new Error(
      `Favorite model slot "${String(slot ?? "")}" is not configured. Run /agents-favorite-models to define levels before spawning agents.`
    );
  }
  return {
    slot: favorite.slot,
    role: roleForFavoriteModelSlot(favorite.slot),
    model: favorite.config.model,
    thinking: favorite.config.thinking as ThinkingLevelName,
  };
}

export interface ResolveModelInput {
  role: AgentRole;
  /** Optional category name referencing settings.categories. */
  category?: string;
  /** Favorite model slot selected at spawn time. */
  modelSlot?: string | null;
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
  modelSource: "explicit" | "favorite-slot" | "category" | "role" | "team" | "current" | "none";
}

/**
 * Resolve a member's effective model/thinking.
 *
 * Model precedence:   explicit -> favorite slot -> category -> role default -> team default -> current
 * Thinking precedence: explicit -> favorite slot -> category -> role default (else none)
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
  const explicitThinkingInput = toStringOrNull(input.explicitThinking ?? null);
  const favorite = requireConfiguredFavoriteModel(settings, input.modelSlot);
  if (favorite && (explicitModel || explicitThinkingInput)) {
    throw new Error(
      `model_slot cannot be combined with explicit model or thinking. Slot "${favorite.slot}" already defines both.`
    );
  }

  const teamDefault = toStringOrNull(input.teamDefaultModel ?? null);
  const current = toStringOrNull(input.currentModel ?? null);

  let model: string | null;
  let modelSource: ResolvedModel["modelSource"];
  if (explicitModel) {
    model = explicitModel;
    modelSource = "explicit";
  } else if (favorite?.config.model) {
    model = favorite.config.model;
    modelSource = "favorite-slot";
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
    favorite?.config.thinking ??
    category?.thinking ??
    roleDefaults.thinking ??
    null;

  return { model, thinking, modelSource };
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
