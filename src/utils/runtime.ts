import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock";
import { configPath, runtimeStatusPath, teamDir } from "./paths";
import type { TeamConfig } from "./models";
import { withLifecycleTombstoneLock } from "./lifecycle-tombstone";

/**
 * Runtime constants for health checking.
 * Exported for configurability and testing.
 */
export const HEARTBEAT_STALE_MS = 90000; // 90 seconds
export const STARTUP_STALL_MS = 60000;   // 60 seconds
export const RUNTIME_STALE_MS = 300000;  // 5 minutes - files older than this are considered stale

/**
 * Structured error information for better diagnostics.
 */
export interface RuntimeError {
  message: string;
  timestamp: number;
}

export interface AgentRuntimeStatus {
  teamName: string;
  agentName: string;
  lifecycleRunId?: string;
  pid?: number;
  startedAt?: number;
  lastHeartbeatAt?: number;
  lastInboxReadAt?: number;
  ready?: boolean;
  currentAction?: "starting" | "thinking" | "working" | "finishing" | "done";
  activeToolName?: string;
  tokensUsed?: number;
  latestProgress?: string;
  progressUpdatedAt?: number;
  lastError?: RuntimeError;
}

export class RuntimeStatusWriteRejectedError extends Error {
  readonly code = "RUNTIME_STATUS_WRITE_REJECTED";
}

export function isRuntimeStatusWriteRejectedError(error: unknown): error is RuntimeStatusWriteRejectedError {
  return error instanceof RuntimeStatusWriteRejectedError
    || (error instanceof Error && (error as Error & { code?: string }).code === "RUNTIME_STATUS_WRITE_REJECTED");
}

function rejectRuntimeWrite(teamName: string, agentName: string, reason: string): never {
  throw new RuntimeStatusWriteRejectedError(
    `Refusing runtime status write for ${agentName} in ${teamName}: ${reason}`
  );
}

/**
 * Write runtime status for one admitted lifecycle run. Merges with existing
 * status while holding lifecycle -> config -> runtime locks.
 */
export async function writeRuntimeStatus(
  teamName: string,
  agentName: string,
  expectedRunId: string,
  updates: Omit<Partial<AgentRuntimeStatus>, "teamName" | "agentName" | "lifecycleRunId">
): Promise<AgentRuntimeStatus> {
  if (!expectedRunId) rejectRuntimeWrite(teamName, agentName, "expected lifecycle run id is missing.");
  const p = runtimeStatusPath(teamName, agentName);
  const teamConfigPath = configPath(teamName);

  return withLifecycleTombstoneLock(teamName, agentName, async lifecycleLock => {
    const fence = lifecycleLock.read();
    if (fence.status === "corrupt") rejectRuntimeWrite(teamName, agentName, `lifecycle tombstone is corrupt: ${fence.error}`);
    if (fence.status === "occupied") rejectRuntimeWrite(teamName, agentName, `lifecycle run ${fence.tombstone.runId} is ${fence.tombstone.phase}.`);

    return withLock(teamConfigPath, async () => {
      if (!fs.existsSync(teamConfigPath)) rejectRuntimeWrite(teamName, agentName, "team config is absent.");
      let config: TeamConfig;
      try {
        config = JSON.parse(fs.readFileSync(teamConfigPath, "utf-8")) as TeamConfig;
      } catch {
        rejectRuntimeWrite(teamName, agentName, "team config is unreadable.");
      }
      const member = Array.isArray(config.members)
        ? config.members.find(item => item.name === agentName)
        : undefined;
      if (!member || member.isActive === false) rejectRuntimeWrite(teamName, agentName, "matching active roster member is absent.");
      if (member.lifecycleRunId !== expectedRunId) {
        rejectRuntimeWrite(teamName, agentName, `roster belongs to lifecycle run ${member.lifecycleRunId || "unknown"}, not ${expectedRunId}.`);
      }

      return withLock(p, async () => {
        let current: AgentRuntimeStatus = { teamName, agentName, lifecycleRunId: expectedRunId };
        if (fs.existsSync(p)) {
          try {
            current = JSON.parse(fs.readFileSync(p, "utf-8")) as AgentRuntimeStatus;
          } catch {
            current = { teamName, agentName, lifecycleRunId: expectedRunId };
          }
        }
        if (current.lifecycleRunId && current.lifecycleRunId !== expectedRunId) {
          rejectRuntimeWrite(teamName, agentName, `runtime file belongs to lifecycle run ${current.lifecycleRunId}.`);
        }

        const next: AgentRuntimeStatus = {
          ...current,
          ...updates,
          teamName,
          agentName,
          lifecycleRunId: expectedRunId,
        };
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(next, null, 2));
        return next;
      });
    });
  });
}

/**
 * Read runtime status for an agent. Returns null if not found.
 */
export async function readRuntimeStatus(
  teamName: string,
  agentName: string
): Promise<AgentRuntimeStatus | null> {
  const p = runtimeStatusPath(teamName, agentName);
  if (!fs.existsSync(p)) return null;

  return await withLock(p, async () => {
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as AgentRuntimeStatus;
    } catch {
      // Corrupted file
      return null;
    }
  });
}

/**
 * Delete runtime status for an agent. Called during shutdown.
 */
async function deleteRuntimeStatusFile(
  teamName: string,
  agentName: string,
  expectedRunId?: string
): Promise<boolean> {
  const p = runtimeStatusPath(teamName, agentName);
  if (!fs.existsSync(p)) return false;

  return withLock(p, async () => {
    if (!fs.existsSync(p)) return false;
    if (expectedRunId) {
      let current: AgentRuntimeStatus;
      try {
        current = JSON.parse(fs.readFileSync(p, "utf-8")) as AgentRuntimeStatus;
      } catch {
        return false;
      }
      if (current.lifecycleRunId !== expectedRunId) return false;
    }
    try {
      fs.unlinkSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

export async function deleteRuntimeStatus(
  teamName: string,
  agentName: string,
  expectedRunId?: string
): Promise<boolean> {
  return deleteRuntimeStatusFile(teamName, agentName, expectedRunId);
}

/** Runtime-file deletion for finalizers that already hold the lifecycle lock. */
export async function deleteRuntimeStatusUnderLifecycleLock(
  teamName: string,
  agentName: string,
  expectedRunId: string
): Promise<boolean> {
  return deleteRuntimeStatusFile(teamName, agentName, expectedRunId);
}

/**
 * Clean up stale runtime files for a team.
 * Removes files older than RUNTIME_STALE_MS that have no recent heartbeat.
 * Returns the number of files cleaned up.
 */
export interface CleanupStaleRuntimeHooks {
  afterLifecycleLock?(agentName: string): void | Promise<void>;
  beforeDelete?(agentName: string): void | Promise<void>;
}

export async function cleanupStaleRuntimeFiles(
  teamName: string,
  now: number = Date.now(),
  hooks: CleanupStaleRuntimeHooks = {}
): Promise<number> {
  const runtimeDir = path.join(teamDir(teamName), "runtime");
  if (!fs.existsSync(runtimeDir)) return 0;

  let cleaned = 0;
  const files = fs.readdirSync(runtimeDir).filter(f => f.endsWith(".json"));

  for (const file of files) {
    const p = path.join(runtimeDir, file);
    const agentName = file.slice(0, -".json".length);
    await withLifecycleTombstoneLock(teamName, agentName, async lifecycleLock => {
      await hooks.afterLifecycleLock?.(agentName);
      await withLock(p, async () => {
        const fence = lifecycleLock.read();
        if (fence.status !== "absent" || !fs.existsSync(p)) return;

        let shouldDelete = false;
        try {
          const status = JSON.parse(fs.readFileSync(p, "utf-8")) as AgentRuntimeStatus;
          const lastActivity = status.lastHeartbeatAt || status.startedAt || 0;
          shouldDelete = (now - lastActivity) > RUNTIME_STALE_MS;
        } catch {
          shouldDelete = true;
        }
        if (!shouldDelete) return;

        await hooks.beforeDelete?.(agentName);
        try {
          fs.unlinkSync(p);
          cleaned++;
        } catch {
          // Best-effort janitor; another cleanup may already have removed it.
        }
      });
    });
  }

  return cleaned;
}

/**
 * Create a structured error object from an error.
 */
export function createRuntimeError(error: unknown): RuntimeError {
  return {
    message: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}