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

export function findLeadTeamForSession(): string | null {
  try {
    const teamsDir = paths.TEAMS_DIR;
    if (!fs.existsSync(teamsDir)) return null;

    for (const teamDir of fs.readdirSync(teamsDir)) {
      const sessionFile = paths.leadSessionPath(teamDir);
      if (fs.existsSync(sessionFile)) {
        try {
          const session = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
          if (session.pid === process.pid) {
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

export function registerLeadSession(teamName: string) {
  const sessionFile = paths.leadSessionPath(teamName);
  const dir = path.dirname(sessionFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
  }));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cleanupStaleTeam(teamName: string, terminal: any): boolean {
  const sessionFile = paths.leadSessionPath(teamName);
  const configFile = paths.configPath(teamName);

  if (!fs.existsSync(sessionFile) || !fs.existsSync(configFile)) {
    return false;
  }

  try {
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));

    // Only cleanup if the lead PID is actually dead
    if (session.pid && !isPidAlive(session.pid)) {
      // Read config to get member info for cleanup
      try {
        const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));

        // Kill all teammate panes/windows
        for (const member of config.members || []) {
          if (member.name === "team-lead") continue;

          // Kill via PID file
          const pidFile = path.join(paths.teamDir(teamName), `${member.name}.pid`);
          if (fs.existsSync(pidFile)) {
            try {
              const pid = fs.readFileSync(pidFile, "utf-8").trim();
              process.kill(parseInt(pid), "SIGKILL");
              fs.unlinkSync(pidFile);
            } catch {}
          }

          // Kill via terminal adapter
          if (terminal && member.tmuxPaneId) {
            try { terminal.kill(member.tmuxPaneId); } catch {}
          }
        }
      } catch {}

      // Delete entire team directory
      const teamDirectory = paths.teamDir(teamName);
      if (fs.existsSync(teamDirectory)) {
        fs.rmSync(teamDirectory, { recursive: true });
      }

      // Delete tasks directory
      const tasksDirectory = paths.taskDir(teamName);
      if (fs.existsSync(tasksDirectory)) {
        fs.rmSync(tasksDirectory, { recursive: true });
      }

      return true;
    }
  } catch {}

  return false;
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
