import fs from "node:fs";
import path from "node:path";
import * as paths from "../../src/utils/paths";

export const PRIVATE_AGENT_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface CleanupStalePrivateAgentSessionsOptions {
  teamsRoot?: string;
  now?: number;
  maxAgeMs?: number;
}

export interface PrivateAgentSessionRetentionOptions {
  now?: number;
  maxAgeMs?: number;
}

export type PrivateAgentSessionRetentionResult = "recent" | "none" | "unknown";

type DirectoryInspection =
  | { kind: "directory"; stat: fs.Stats }
  | { kind: "missing" }
  | { kind: "unsafe" }
  | { kind: "error" };

type DirectoryEntriesInspection =
  | { kind: "entries"; entries: fs.Dirent[] }
  | { kind: "error" };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function inspectDirectory(directory: string): DirectoryInspection {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: "unsafe" };
    return { kind: "directory", stat };
  } catch (error) {
    return errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR"
      ? { kind: "missing" }
      : { kind: "error" };
  }
}

function inspectDirectoryEntries(directory: string): DirectoryEntriesInspection {
  try {
    return { kind: "entries", entries: fs.readdirSync(directory, { withFileTypes: true }) };
  } catch {
    return { kind: "error" };
  }
}

function safeComponent(value: string): string {
  return paths.sanitizeName(value);
}

function directoryStat(directory: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink() ? stat : null;
  } catch {
    return null;
  }
}

function ensurePrivateDirectory(directory: string): void {
  const existing = directoryStat(directory);
  if (!existing) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  const verified = directoryStat(directory);
  if (!verified) {
    throw new Error(`Refusing untrusted private agent session directory: ${directory}`);
  }
  if (process.platform !== "win32" && (verified.mode & 0o777) !== 0o700) {
    fs.chmodSync(directory, 0o700);
    const secured = directoryStat(directory);
    if (!secured || (secured.mode & 0o777) !== 0o700) {
      throw new Error(`Could not secure private agent session directory: ${directory}`);
    }
  }
}

function privateSessionRoot(teamName: string): string {
  return path.join(paths.teamDir(safeComponent(teamName)), "agent-sessions");
}

function privateAgentDirectory(teamName: string, agentName: string): string {
  return path.join(privateSessionRoot(teamName), safeComponent(agentName));
}

function privateRunDirectory(teamName: string, agentName: string, lifecycleRunId: string): string {
  return path.join(privateAgentDirectory(teamName, agentName), safeComponent(lifecycleRunId));
}

function pruneEmptyDirectory(directory: string): void {
  try {
    if (directoryStat(directory)) fs.rmdirSync(directory);
  } catch {
    // Siblings or unknown entries keep their parent directory in place.
  }
}

export function preparePrivateAgentSessionDirectory(
  teamName: string,
  agentName: string,
  lifecycleRunId: string,
): string {
  const teamDirectory = paths.teamDir(safeComponent(teamName));
  if (!directoryStat(teamDirectory)) {
    throw new Error(`Refusing private agent session storage without a trusted team directory: ${teamDirectory}`);
  }
  const root = privateSessionRoot(teamName);
  const agentDirectory = privateAgentDirectory(teamName, agentName);
  const runDirectory = privateRunDirectory(teamName, agentName, lifecycleRunId);
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(agentDirectory);
  ensurePrivateDirectory(runDirectory);
  return runDirectory;
}

export function cleanupPrivateAgentSessionDirectory(
  teamName: string,
  agentName: string,
  lifecycleRunId: string,
): boolean {
  const root = privateSessionRoot(teamName);
  const agentDirectory = privateAgentDirectory(teamName, agentName);
  const runDirectory = privateRunDirectory(teamName, agentName, lifecycleRunId);
  const runInspection = inspectDirectory(runDirectory);
  if (runInspection.kind === "missing") return false;
  const inspections = [
    { directory: root, inspection: inspectDirectory(root) },
    { directory: agentDirectory, inspection: inspectDirectory(agentDirectory) },
    { directory: runDirectory, inspection: runInspection },
  ];
  const failedInspection = inspections.find(({ inspection }) => inspection.kind !== "directory");
  if (failedInspection) {
    if (failedInspection.inspection.kind === "error") {
      throw new Error(`Could not inspect private agent session directory: ${failedInspection.directory}`);
    }
    throw new Error(`Refusing to remove an untrusted private agent session directory: ${failedInspection.directory}`);
  }
  fs.rmSync(runDirectory, { recursive: true, force: false });
  pruneEmptyDirectory(agentDirectory);
  pruneEmptyDirectory(root);
  return true;
}

function readActiveRuns(teamDirectory: string): Set<string> | null {
  try {
    const configPath = path.join(teamDirectory, "config.json");
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!Array.isArray(config?.members)) return null;
    const active = new Set<string>();
    for (const member of config.members) {
      // A report fence marks the member inactive before trailing session events
      // and final teardown settle. Roster presence, not isActive, owns retention.
      if (member?.agentType !== "teammate") continue;
      if (typeof member.name !== "string" || typeof member.lifecycleRunId !== "string") return null;
      active.add(`${safeComponent(member.name)}\0${safeComponent(member.lifecycleRunId)}`);
    }
    return active;
  } catch {
    return null;
  }
}

function safeDirectoryEntries(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function latestPrivateRunActivityMs(runDirectory: string, runStat: fs.Stats): number | null {
  const entries = inspectDirectoryEntries(runDirectory);
  if (entries.kind === "error") return null;

  let latest = runStat.mtimeMs;
  for (const entry of entries.entries) {
    const entryPath = path.join(runDirectory, entry.name);
    try {
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) continue;
      latest = Math.max(latest, stat.mtimeMs);
    } catch {
      return null;
    }
  }
  return latest;
}

export function hasRecentPrivateAgentSessions(
  teamDirectory: string,
  options: PrivateAgentSessionRetentionOptions = {},
): PrivateAgentSessionRetentionResult {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? PRIVATE_AGENT_SESSION_RETENTION_MS;
  if (maxAgeMs <= 0) return "none";

  const teamInspection = inspectDirectory(teamDirectory);
  if (teamInspection.kind === "missing" || teamInspection.kind === "unsafe") return "none";
  if (teamInspection.kind === "error") return "unknown";

  const sessionRoot = path.join(teamDirectory, "agent-sessions");
  const rootInspection = inspectDirectory(sessionRoot);
  if (rootInspection.kind === "missing" || rootInspection.kind === "unsafe") return "none";
  if (rootInspection.kind === "error") return "unknown";

  const agentEntries = inspectDirectoryEntries(sessionRoot);
  if (agentEntries.kind === "error") return "unknown";
  for (const agentEntry of agentEntries.entries) {
    if (!agentEntry.isDirectory()) continue;
    try {
      safeComponent(agentEntry.name);
    } catch {
      continue;
    }
    const agentDirectory = path.join(sessionRoot, agentEntry.name);
    const agentInspection = inspectDirectory(agentDirectory);
    if (agentInspection.kind === "error" || agentInspection.kind === "missing") return "unknown";
    if (agentInspection.kind === "unsafe") continue;

    const runEntries = inspectDirectoryEntries(agentDirectory);
    if (runEntries.kind === "error") return "unknown";
    for (const runEntry of runEntries.entries) {
      if (!runEntry.isDirectory()) continue;
      try {
        safeComponent(runEntry.name);
      } catch {
        continue;
      }
      const runDirectory = path.join(agentDirectory, runEntry.name);
      const runInspection = inspectDirectory(runDirectory);
      if (runInspection.kind === "error" || runInspection.kind === "missing") return "unknown";
      if (runInspection.kind === "unsafe") continue;

      const latestActivity = latestPrivateRunActivityMs(runDirectory, runInspection.stat);
      if (latestActivity === null) return "unknown";
      if (now - latestActivity <= maxAgeMs) return "recent";
    }
  }

  return "none";
}

export function cleanupStalePrivateAgentSessions(
  options: CleanupStalePrivateAgentSessionsOptions = {},
): number {
  const teamsRoot = options.teamsRoot ?? path.dirname(paths.teamDir("__probe__"));
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? PRIVATE_AGENT_SESSION_RETENTION_MS;
  if (!directoryStat(teamsRoot)) return 0;
  let cleaned = 0;

  for (const teamEntry of safeDirectoryEntries(teamsRoot)) {
    if (!teamEntry.isDirectory()) continue;
    let teamName: string;
    try {
      teamName = safeComponent(teamEntry.name);
    } catch {
      continue;
    }
    const teamDirectory = path.join(teamsRoot, teamName);
    if (!directoryStat(teamDirectory)) continue;
    const activeRuns = readActiveRuns(teamDirectory);
    if (!activeRuns) continue;
    const sessionRoot = path.join(teamDirectory, "agent-sessions");
    if (!directoryStat(sessionRoot)) continue;

    for (const agentEntry of safeDirectoryEntries(sessionRoot)) {
      if (!agentEntry.isDirectory()) continue;
      let agentName: string;
      try {
        agentName = safeComponent(agentEntry.name);
      } catch {
        continue;
      }
      const agentDirectory = path.join(sessionRoot, agentName);
      if (!directoryStat(agentDirectory)) continue;

      for (const runEntry of safeDirectoryEntries(agentDirectory)) {
        if (!runEntry.isDirectory()) continue;
        let runId: string;
        try {
          runId = safeComponent(runEntry.name);
        } catch {
          continue;
        }
        if (activeRuns.has(`${agentName}\0${runId}`)) continue;
        const runDirectory = path.join(agentDirectory, runId);
        const stat = directoryStat(runDirectory);
        if (!stat) continue;
        const latestActivity = latestPrivateRunActivityMs(runDirectory, stat);
        if (latestActivity === null || now - latestActivity <= maxAgeMs) continue;
        try {
          fs.rmSync(runDirectory, { recursive: true, force: false });
          cleaned += 1;
        } catch {
          // One failed removal must not prevent later eligible runs from being cleaned.
        }
      }
      pruneEmptyDirectory(agentDirectory);
    }
    pruneEmptyDirectory(sessionRoot);
  }

  return cleaned;
}
