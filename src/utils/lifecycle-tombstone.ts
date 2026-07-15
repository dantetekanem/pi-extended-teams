import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock";
import { lifecycleTombstonePath } from "./paths";

export const LIFECYCLE_TOMBSTONE_VERSION = 1 as const;

export type LifecycleTombstonePhase =
  | "closing"
  | "persistence_closed"
  | "timed_out"
  | "finalizing"
  | "cleanup_failed";

export interface LifecycleTombstone {
  version: typeof LIFECYCLE_TOMBSTONE_VERSION;
  team: string;
  agent: string;
  runId: string;
  role: "read" | "write";
  reason: string;
  phase: LifecycleTombstonePhase;
  ownerPid: number;
  extensionInstanceId: string;
  timestamps: {
    createdAt: number;
    updatedAt: number;
  };
  timeout?: {
    afterMs: number;
    at: number;
  };
  error?: string;
}

export type LifecycleTombstoneReadResult =
  | { status: "absent" }
  | { status: "occupied"; tombstone: LifecycleTombstone }
  | { status: "corrupt"; error: string };

export interface CreateLifecycleTombstoneInput {
  team: string;
  agent: string;
  runId: string;
  role: "read" | "write";
  reason: string;
  phase?: LifecycleTombstonePhase;
  ownerPid?: number;
  extensionInstanceId: string;
  now?: number;
}

export interface LifecycleTombstoneLock {
  path: string;
  read(): LifecycleTombstoneReadResult;
  occupy(input: CreateLifecycleTombstoneInput): LifecycleTombstone;
  updateMatching(runId: string, updates: Partial<Pick<LifecycleTombstone, "phase" | "timeout" | "error">>): LifecycleTombstone | null;
  clearMatching(runId: string): boolean;
}

const clearListeners = new Set<(teamName: string, agentName: string, runId: string) => void>();

export function generateLifecycleRunId(): string {
  return crypto.randomUUID();
}

export function generateExtensionInstanceId(): string {
  return crypto.randomUUID();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isLifecycleTombstone(value: unknown, teamName: string, agentName: string): value is LifecycleTombstone {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LifecycleTombstone>;
  return item.version === LIFECYCLE_TOMBSTONE_VERSION
    && item.team === teamName
    && item.agent === agentName
    && isNonEmptyString(item.runId)
    && (item.role === "read" || item.role === "write")
    && isNonEmptyString(item.reason)
    && ["closing", "persistence_closed", "timed_out", "finalizing", "cleanup_failed"].includes(String(item.phase))
    && typeof item.ownerPid === "number"
    && isNonEmptyString(item.extensionInstanceId)
    && !!item.timestamps
    && typeof item.timestamps.createdAt === "number"
    && typeof item.timestamps.updatedAt === "number"
    && (item.timeout === undefined || (
      typeof item.timeout.afterMs === "number" && typeof item.timeout.at === "number"
    ))
    && (item.error === undefined || typeof item.error === "string");
}

function readUnlocked(teamName: string, agentName: string, tombstonePath: string): LifecycleTombstoneReadResult {
  if (!fs.existsSync(tombstonePath)) return { status: "absent" };
  try {
    const parsed = JSON.parse(fs.readFileSync(tombstonePath, "utf-8"));
    if (!isLifecycleTombstone(parsed, teamName, agentName)) {
      return { status: "corrupt", error: "Lifecycle tombstone schema or identity is invalid." };
    }
    return { status: "occupied", tombstone: parsed };
  } catch (error) {
    return { status: "corrupt", error: `Lifecycle tombstone could not be read: ${errorText(error)}` };
  }
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, filePath);
    try {
      const dirDescriptor = fs.openSync(dir, "r");
      try { fs.fsyncSync(dirDescriptor); } finally { fs.closeSync(dirDescriptor); }
    } catch {
      // Directory fsync is not supported on every platform/filesystem.
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve original error */ }
    }
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* preserve original error */ }
    throw error;
  }
}

function occupiedError(teamName: string, agentName: string, result: Exclude<LifecycleTombstoneReadResult, { status: "absent" }>): Error {
  if (result.status === "corrupt") {
    return new Error(`Agent ${agentName} in ${teamName} is lifecycle-quarantined by a corrupt tombstone: ${result.error}`);
  }
  return new Error(
    `Agent ${agentName} in ${teamName} is lifecycle-quarantined for run ${result.tombstone.runId} (${result.tombstone.phase}).`
  );
}

export function assertLifecycleTombstoneAbsent(
  teamName: string,
  agentName: string,
  result: LifecycleTombstoneReadResult
): asserts result is { status: "absent" } {
  if (result.status !== "absent") throw occupiedError(teamName, agentName, result);
}

export async function withLifecycleTombstoneLock<T>(
  teamName: string,
  agentName: string,
  fn: (lock: LifecycleTombstoneLock) => Promise<T>
): Promise<T> {
  const tombstonePath = lifecycleTombstonePath(teamName, agentName);
  let clearedRunId: string | undefined;
  const result = await withLock(tombstonePath, async () => {
    const lock: LifecycleTombstoneLock = {
      path: tombstonePath,
      read: () => readUnlocked(teamName, agentName, tombstonePath),
      occupy: (input) => {
        const current = readUnlocked(teamName, agentName, tombstonePath);
        if (current.status === "corrupt") throw occupiedError(teamName, agentName, current);
        if (current.status === "occupied") {
          if (current.tombstone.runId !== input.runId) throw occupiedError(teamName, agentName, current);
          return current.tombstone;
        }
        const now = input.now ?? Date.now();
        const tombstone: LifecycleTombstone = {
          version: LIFECYCLE_TOMBSTONE_VERSION,
          team: input.team,
          agent: input.agent,
          runId: input.runId,
          role: input.role,
          reason: input.reason,
          phase: input.phase ?? "closing",
          ownerPid: input.ownerPid ?? process.pid,
          extensionInstanceId: input.extensionInstanceId,
          timestamps: { createdAt: now, updatedAt: now },
        };
        if (!isLifecycleTombstone(tombstone, teamName, agentName)) {
          throw new Error(`Refusing to write invalid lifecycle tombstone for ${agentName} in ${teamName}.`);
        }
        atomicWriteJson(tombstonePath, tombstone);
        return tombstone;
      },
      updateMatching: (runId, updates) => {
        const current = readUnlocked(teamName, agentName, tombstonePath);
        if (current.status !== "occupied" || current.tombstone.runId !== runId) return null;
        const next: LifecycleTombstone = {
          ...current.tombstone,
          ...updates,
          timestamps: { ...current.tombstone.timestamps, updatedAt: Date.now() },
        };
        atomicWriteJson(tombstonePath, next);
        return next;
      },
      clearMatching: (runId) => {
        const current = readUnlocked(teamName, agentName, tombstonePath);
        if (current.status !== "occupied" || current.tombstone.runId !== runId) return false;
        fs.unlinkSync(tombstonePath);
        clearedRunId = runId;
        return true;
      },
    };
    return fn(lock);
  });
  if (clearedRunId) {
    for (const listener of clearListeners) {
      try { listener(teamName, agentName, clearedRunId); } catch { /* observers are best-effort */ }
    }
  }
  return result;
}

export function readLifecycleTombstoneSnapshot(teamName: string, agentName: string): LifecycleTombstoneReadResult {
  const tombstonePath = lifecycleTombstonePath(teamName, agentName);
  return readUnlocked(teamName, agentName, tombstonePath);
}

export async function readLifecycleTombstone(teamName: string, agentName: string): Promise<LifecycleTombstoneReadResult> {
  const tombstonePath = lifecycleTombstonePath(teamName, agentName);
  // Existing/corrupt content is already a fail-closed answer and must be
  // observable even while its owner holds the exact lock for slow cleanup.
  if (fs.existsSync(tombstonePath)) return readUnlocked(teamName, agentName, tombstonePath);
  // Absence needs the lock and a second read so admission cannot race creation.
  return withLifecycleTombstoneLock(teamName, agentName, async lock => lock.read());
}

export async function listLifecycleTombstones(
  teamName: string
): Promise<Array<{ agentName: string; result: Exclude<LifecycleTombstoneReadResult, { status: "absent" }> }>> {
  const quarantineDir = path.dirname(lifecycleTombstonePath(teamName, "placeholder"));
  if (!fs.existsSync(quarantineDir)) return [];
  const entries: Array<{ agentName: string; result: Exclude<LifecycleTombstoneReadResult, { status: "absent" }> }> = [];
  for (const file of fs.readdirSync(quarantineDir).filter(item => item.endsWith(".json")).sort()) {
    const agentName = file.slice(0, -".json".length);
    const result = await readLifecycleTombstone(teamName, agentName);
    if (result.status !== "absent") entries.push({ agentName, result });
  }
  return entries;
}

export async function updateMatchingLifecycleTombstone(
  teamName: string,
  agentName: string,
  runId: string,
  updates: Partial<Pick<LifecycleTombstone, "phase" | "timeout" | "error">>
): Promise<LifecycleTombstone | null> {
  return withLifecycleTombstoneLock(teamName, agentName, async lock => lock.updateMatching(runId, updates));
}

export function onLifecycleTombstoneCleared(
  listener: (teamName: string, agentName: string, runId: string) => void
): () => void {
  clearListeners.add(listener);
  return () => clearListeners.delete(listener);
}
