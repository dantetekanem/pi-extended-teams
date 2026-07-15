import fs from "node:fs";
import path from "node:path";
import { loadSettings, type PiExtendedTeamsSettings } from "../../src/utils/settings";

const SELF_COMMAND_NAME = "agents-extensions";
export const EXTENSIONS_COMMAND_DESCRIPTION = "Select which observable loaded Pi extensions spawned agents receive.";
const GENERIC_TOOL_SOURCES = new Set(["builtin", "sdk"]);

type ResourceScope = "user" | "project" | "temporary";

export interface ExtensionSourceInfo {
  path: string;
  source: string;
  scope: ResourceScope;
  origin: "package" | "top-level";
  baseDir?: string;
}

export interface LeadExtensionSnapshot {
  /** Stable, human-readable selector when unique in the current lead snapshot. */
  name: string;
  /** Canonical filesystem identity used for deterministic deduplication. */
  identity: string;
  /** Pi's registered extension entrypoint path, passed to the child unchanged. */
  path: string;
  sourceInfo: ExtensionSourceInfo;
  isSelf: boolean;
}

export type SpawnExtensionState = "selected" | "available" | "blocked" | "self";

export interface SpawnExtensionCandidate extends LeadExtensionSnapshot {
  selector: string;
  selected: boolean;
  state: SpawnExtensionState;
}

export type SpawnResourceDiagnosticCode =
  | "stale-selection"
  | "blocked-selection"
  | "self-excluded";

export interface SpawnResourceDiagnostic {
  code: SpawnResourceDiagnosticCode;
  message: string;
  configuredEntry?: string;
}

export interface SpawnResourcePlan {
  selectionMode: "default" | "explicit";
  extensionPaths: readonly string[];
  selfExtensionPath?: string;
  extensions: readonly SpawnExtensionCandidate[];
  diagnostics: readonly SpawnResourceDiagnostic[];
  skills: "all";
  trust: Readonly<{
    cwd: string;
    projectTrusted: boolean;
  }>;
}

interface LeadRegistrationApi {
  getCommands?(): Array<{
    name?: string;
    description?: string;
    source?: string;
    sourceInfo?: ExtensionSourceInfo;
  }>;
  getAllTools?(): Array<{
    name?: string;
    sourceInfo?: ExtensionSourceInfo;
  }>;
}

export interface CreateSpawnResourcePlanOptions {
  cwd: string;
  projectTrusted: boolean;
  settings?: PiExtendedTeamsSettings;
  pi?: LeadRegistrationApi;
  leadExtensions?: readonly LeadExtensionSnapshot[];
}

function canonicalPath(filePath: string): string {
  const absolute = path.resolve(filePath);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function extensionName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() || normalized;
  if (/^index\.(?:[cm]?[jt]s)$/.test(base)) {
    const segments = normalized.split("/");
    const parent = segments.at(-2) || base;
    return parent === "extensions" ? segments.at(-3) || parent : parent;
  }
  return base.replace(/\.(?:[cm]?[jt]s)$/, "") || base;
}

function usableSourceInfo(sourceInfo: ExtensionSourceInfo | undefined): sourceInfo is ExtensionSourceInfo {
  return !!sourceInfo
    && typeof sourceInfo.path === "string"
    && sourceInfo.path.length > 0
    && !sourceInfo.path.startsWith("<");
}

/**
 * Snapshot extensions observable through Pi's public registration APIs.
 *
 * Pi currently exposes sourceInfo for commands and tools, not for event-only,
 * renderer-only, shortcut-only, or provider-only extensions. Those extensions
 * cannot be observed or propagated without using private loader internals.
 */
export function snapshotLeadExtensions(pi: LeadRegistrationApi): readonly LeadExtensionSnapshot[] {
  const commands = typeof pi.getCommands === "function" ? pi.getCommands() : [];
  const tools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
  const selfPaths = new Set(commands
    .filter((command) => command.source === "extension"
      && (command.description === EXTENSIONS_COMMAND_DESCRIPTION
        || (command.description === undefined && command.name === SELF_COMMAND_NAME)))
    .map((command) => command.sourceInfo)
    .filter(usableSourceInfo)
    .map((sourceInfo) => canonicalPath(sourceInfo.path)));

  const registrations = [
    ...commands
      .filter((command) => command.source === "extension")
      .map((command) => command.sourceInfo),
    ...tools
      .filter((tool) => !GENERIC_TOOL_SOURCES.has(tool.sourceInfo?.source ?? ""))
      .map((tool) => tool.sourceInfo),
  ].filter(usableSourceInfo);

  const seen = new Set<string>();
  const snapshot: LeadExtensionSnapshot[] = [];
  for (const sourceInfo of registrations) {
    const identity = canonicalPath(sourceInfo.path);
    if (seen.has(identity)) continue;
    seen.add(identity);
    snapshot.push(Object.freeze({
      name: extensionName(sourceInfo.path),
      identity,
      path: sourceInfo.path,
      sourceInfo: Object.freeze({ ...sourceInfo }),
      isSelf: selfPaths.has(identity),
    }));
  }
  return Object.freeze(snapshot);
}

/** Only propagate trust to the same cwd whose trust the parent context resolved. */
export function parentProjectTrustForSpawn(ctx: any, spawnCwd: string): boolean {
  if (!ctx || typeof ctx.isProjectTrusted !== "function" || typeof ctx.cwd !== "string") return false;
  if (path.resolve(ctx.cwd) !== path.resolve(spawnCwd)) return false;
  return ctx.isProjectTrusted() === true;
}

function normalized(value: string): string {
  return value.replace(/\\/g, "/");
}

function entryMatchesExtension(entry: string, extension: LeadExtensionSnapshot, cwd: string): boolean {
  if (entry === extension.name || normalized(entry) === normalized(extension.path)) return true;
  if (!path.isAbsolute(entry) && !entry.startsWith(".")) return false;
  return canonicalPath(path.resolve(cwd, entry)) === extension.identity;
}

function deepFreezePlan(plan: SpawnResourcePlan): SpawnResourcePlan {
  for (const extension of plan.extensions) Object.freeze(extension);
  for (const diagnostic of plan.diagnostics) Object.freeze(diagnostic);
  Object.freeze(plan.extensionPaths);
  Object.freeze(plan.extensions);
  Object.freeze(plan.diagnostics);
  Object.freeze(plan.trust);
  return Object.freeze(plan);
}

/** Apply spawned-agent allow/block policy to an immutable lead-session snapshot. */
export function createSpawnResourcePlan(options: CreateSpawnResourcePlanOptions): SpawnResourcePlan {
  const cwd = path.resolve(options.cwd);
  const settings = options.settings ?? loadSettings({
    projectDir: options.projectTrusted ? cwd : undefined,
  });
  const snapshot = options.leadExtensions ?? snapshotLeadExtensions(options.pi ?? {});
  const allow = settings.extensions.allow;
  const blocked = settings.extensions.block;
  const nameCounts = new Map<string, number>();
  for (const extension of snapshot) nameCounts.set(extension.name, (nameCounts.get(extension.name) ?? 0) + 1);

  const records = snapshot.map((extension) => {
    const isBlocked = blocked.some((entry) => entryMatchesExtension(entry, extension, cwd));
    const explicitlyAllowed = allow?.some((entry) => entryMatchesExtension(entry, extension, cwd)) ?? false;
    const selected = !extension.isSelf && !isBlocked && (allow === null || explicitlyAllowed);
    const state: SpawnExtensionState = extension.isSelf
      ? "self"
      : isBlocked
        ? "blocked"
        : selected
          ? "selected"
          : "available";
    return Object.freeze({
      ...extension,
      selector: nameCounts.get(extension.name) === 1 ? extension.name : extension.path,
      selected,
      state,
    });
  });

  const diagnostics: SpawnResourceDiagnostic[] = [];
  if (allow !== null) {
    for (const configuredEntry of allow) {
      const matches = records.filter((record) => entryMatchesExtension(configuredEntry, record, cwd));
      if (matches.length === 0) {
        diagnostics.push({
          code: "stale-selection",
          configuredEntry,
          message: `Configured extension is not observable in the lead Pi session: ${configuredEntry}`,
        });
      } else if (matches.every((record) => record.isSelf)) {
        diagnostics.push({
          code: "self-excluded",
          configuredEntry,
          message: `pi-extended-teams is injected by identity and is not an external selection: ${configuredEntry}`,
        });
      } else if (matches.every((record) => record.state === "blocked")) {
        diagnostics.push({
          code: "blocked-selection",
          configuredEntry,
          message: `Configured extension is blocked for spawned agents: ${configuredEntry}`,
        });
      }
    }
  }

  return deepFreezePlan({
    selectionMode: allow === null ? "default" : "explicit",
    extensionPaths: records.filter((extension) => extension.selected).map((extension) => extension.path),
    selfExtensionPath: records.find((extension) => extension.isSelf)?.path,
    extensions: records,
    diagnostics,
    skills: "all",
    trust: { cwd, projectTrusted: options.projectTrusted },
  });
}
