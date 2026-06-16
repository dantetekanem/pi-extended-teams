import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as paths from "../../src/utils/paths";
import type { PiExtendedTeamsSettings } from "../../src/utils/settings";

const DISABLED_VALUES = new Set(["", "0", "false", "no", "off"]);

export function isTeamsDebugEnabled(settings?: Pick<PiExtendedTeamsSettings, "debug">): boolean {
  const envValue = process.env.PI_EXTENDED_TEAMS_DEBUG ?? process.env.PI_TEAMS_DEBUG;
  if (envValue !== undefined) {
    return !DISABLED_VALUES.has(envValue.trim().toLowerCase());
  }

  return settings?.debug.enabled ?? false;
}

export function teamDebugLogPath(teamName: string): string {
  return path.join(paths.teamDir(teamName), "debug.log");
}

export async function writeTeamsDebugEvent(
  teamName: string,
  event: string,
  details: Record<string, unknown>,
  settings?: Pick<PiExtendedTeamsSettings, "debug">
): Promise<string | null> {
  if (!isTeamsDebugEnabled(settings)) return null;

  const logPath = teamDebugLogPath(teamName);
  const entry = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    event,
    ...details,
  };

  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
    return logPath;
  } catch {
    return null;
  }
}
