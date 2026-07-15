import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import * as paths from "../../src/utils/paths";

export function resolveSkillFile(skillName: string, cwd: string): string {
  const safeName = paths.sanitizeName(skillName);
  const candidates = [
    path.join(cwd, "skills", `${safeName}.md`),
    path.join(cwd, "skills", safeName, "SKILL.md"),
    path.join(getAgentDir(), "skills", safeName, "SKILL.md"),
    path.join(getAgentDir(), "skills", `${safeName}.md`),
  ];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Skill ${skillName} not found. Checked project and agent skill directories.`);
  }
  return found;
}

export function getPiSessionId(ctx?: any): string | undefined {
  const id = ctx?.sessionManager?.getSessionId?.();
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function findLeadTeamForSession(sessionId?: string): string | null {
  if (!sessionId) return null;
  try {
    const teamsDir = path.dirname(paths.teamDir("__probe__"));
    if (!fs.existsSync(teamsDir)) return null;

    for (const teamDir of fs.readdirSync(teamsDir)) {
      const sessionFile = paths.leadSessionPath(teamDir);
      if (fs.existsSync(sessionFile)) {
        try {
          const session = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
          if (session.sessionId === sessionId && session.pid === process.pid) {
            return teamDir;
          }
        } catch {
          // ignore invalid session files
        }
      }
    }
  } catch {
    // ignore errors
  }
  return null;
}

export function registerLeadSession(teamName: string, sessionId?: string) {
  const sessionFile = paths.leadSessionPath(teamName);
  const dir = path.dirname(sessionFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify({
    pid: process.pid,
    sessionId,
    startedAt: Date.now(),
  }));
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJsonFile(filePath: string): any | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export interface CleanupPidFileResult {
  pid?: number;
  killed: boolean;
  unlinked: boolean;
  killError?: unknown;
}

export function unlinkPidFile(pidFile: string): boolean {
  if (!fs.existsSync(pidFile)) return false;
  try {
    fs.unlinkSync(pidFile);
    return true;
  } catch {
    return false;
  }
}

export function cleanupPidFileProcess(
  pidFile: string,
  options: { signal?: NodeJS.Signals | number; skipPid?: number } = {}
): CleanupPidFileResult {
  const result: CleanupPidFileResult = { killed: false, unlinked: false };
  if (!fs.existsSync(pidFile)) return result;

  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      result.pid = pid;
      if (pid !== options.skipPid) {
        try {
          process.kill(pid, options.signal ?? "SIGKILL");
          result.killed = true;
        } catch (error) {
          result.killError = error;
        }
      }
    }
  } catch {
    // Keep cleanup best-effort: unreadable/corrupt pid files should still be unlinked.
  } finally {
    result.unlinked = unlinkPidFile(pidFile);
  }

  return result;
}

function killTeamMemberProcesses(teamName: string, config: any, terminal: any): void {
  for (const member of config?.members || []) {
    if (member.name === "team-lead") continue;

    const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
    cleanupPidFileProcess(pidFile, { skipPid: process.pid });

    if (terminal && member.tmuxPaneId) {
      try { terminal.kill(member.tmuxPaneId); } catch {}
    }
  }
}

export function forceCleanupTeam(teamName: string, terminal: any): boolean {
  const config = readJsonFile(paths.configPath(teamName));
  killTeamMemberProcesses(teamName, config, terminal);

  const teamDirectory = paths.teamDir(teamName);
  const tasksDirectory = paths.taskDir(teamName);
  let removed = false;
  if (fs.existsSync(teamDirectory)) {
    fs.rmSync(teamDirectory, { recursive: true, force: true });
    removed = true;
  }
  if (fs.existsSync(tasksDirectory)) {
    fs.rmSync(tasksDirectory, { recursive: true, force: true });
    removed = true;
  }
  return removed;
}

function teamLastTouchedAt(teamName: string, teamDirectory: string): number {
  const session = readJsonFile(paths.leadSessionPath(teamName));
  if (typeof session?.startedAt === "number") return session.startedAt;

  const config = readJsonFile(paths.configPath(teamName));
  if (typeof config?.createdAt === "number") return config.createdAt;

  try { return fs.statSync(teamDirectory).mtimeMs; } catch { return 0; }
}

export function cleanupStaleTeam(teamName: string, terminal: any): boolean {
  const session = readJsonFile(paths.leadSessionPath(teamName));
  if (!session?.pid) return false;
  return isPidAlive(Number(session.pid)) ? false : forceCleanupTeam(teamName, terminal);
}

export interface CleanupOrphanedTeamsOptions {
  /** How old a team folder without a live lead must be before removal. */
  maxAgeMs?: number;
  /** Test seam; defaults to ~/.pi/teams. */
  teamsRoot?: string;
  now?: number;
}

export function cleanupOrphanedTeams(
  terminal: any,
  options: CleanupOrphanedTeamsOptions = {}
): number {
  const teamsRoot = options.teamsRoot || paths.TEAMS_DIR;
  if (!fs.existsSync(teamsRoot)) return 0;

  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const dir of fs.readdirSync(teamsRoot)) {
    const teamDirectory = path.join(teamsRoot, dir);
    try {
      if (!fs.statSync(teamDirectory).isDirectory()) continue;
      paths.sanitizeName(dir);

      const session = readJsonFile(paths.leadSessionPath(dir));
      if (session?.pid && isPidAlive(Number(session.pid))) continue;

      const missingLiveLead = !session?.pid || !isPidAlive(Number(session.pid));
      const lastTouchedAt = teamLastTouchedAt(dir, teamDirectory);
      const oldEnough = maxAgeMs <= 0 || (lastTouchedAt > 0 && (now - lastTouchedAt) > maxAgeMs);
      const deadLeadPid = !!session?.pid && !isPidAlive(Number(session.pid));
      const quarantineDir = path.join(teamDirectory, "lifecycle", "quarantine");
      const hasLifecycleFence = fs.existsSync(quarantineDir)
        && fs.readdirSync(quarantineDir).some(file => file.endsWith(".json"));

      // Lifecycle tombstones have no TTL. Even corrupt files are occupied and
      // must keep the team directory out of orphan cleanup.
      if (hasLifecycleFence) continue;

      if (deadLeadPid || (missingLiveLead && oldEnough)) {
        if (forceCleanupTeam(dir, terminal)) cleaned++;
      }
    } catch {
      // Ignore malformed team directories; cleanup should never disrupt startup.
    }
  }

  return cleaned;
}

export function cleanupAgentSessionFolders(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const agentTeamsDir = path.join(os.homedir(), ".pi", "agent", "teams");
  if (!fs.existsSync(agentTeamsDir)) return 0;

  let cleaned = 0;
  const now = Date.now();

  for (const dir of fs.readdirSync(agentTeamsDir)) {
    const sessionDir = path.join(agentTeamsDir, dir);
    const configFile = path.join(sessionDir, "config.json");

    try {
      // Check if this is a directory with a config.json
      if (!fs.statSync(sessionDir).isDirectory()) continue;
      if (!fs.existsSync(configFile)) continue;

      // Read the config to check the creation time
      const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      const createdAt = config.createdAt ? new Date(config.createdAt).getTime() : 0;

      // If the folder is older than maxAgeMs, delete it
      if (createdAt > 0 && (now - createdAt) > maxAgeMs) {
        fs.rmSync(sessionDir, { recursive: true });
        cleaned++;
      }
    } catch {
      // Ignore errors for individual folders
    }
  }

  return cleaned;
}
