// Project: pi-extended-teams
import fs from "node:fs";
import path from "node:path";
import { TaskFile } from "./models";
import { taskDir, sanitizeName } from "./paths";

export interface FileClaimConflict {
  path: string;
  heldBy: string;
}

const FILE_CLAIM_BLOCK_PREFIX = "file-claim:";

function fileClaimBlockId(conflict: FileClaimConflict): string {
  return `${FILE_CLAIM_BLOCK_PREFIX}${encodeURIComponent(conflict.path)}:${encodeURIComponent(conflict.heldBy)}`;
}

function parseFileClaimBlockPath(blocker: string): string | null {
  if (!blocker.startsWith(FILE_CLAIM_BLOCK_PREFIX)) return null;
  const encodedPath = blocker.slice(FILE_CLAIM_BLOCK_PREFIX.length).split(":", 1)[0];
  try {
    return decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
}

function isOpenTask(task: TaskFile): boolean {
  return task.status !== "completed" && task.status !== "deleted";
}
import { teamExists } from "./teams";
import { withLock } from "./lock";
import { runHook } from "./hooks";

export interface GuardedTaskUpdateOptions {
  expectedStatus?: TaskFile["status"];
  expectedOwner?: string | null;
  expectedVersion?: number;
  expectedUpdatedAt?: string;
  operationId?: string;
}

export interface GuardedTaskUpdateResult {
  task: TaskFile;
  updated: boolean;
  idempotent: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nextTaskState(task: TaskFile, updates: Partial<TaskFile>, operationId?: string): TaskFile {
  const now = nowIso();
  const metadata = { ...(task.metadata || {}), ...(updates.metadata || {}) };
  if (operationId) {
    metadata.lastOperationId = operationId;
    metadata.appliedOperationIds = {
      ...(task.metadata?.appliedOperationIds || {}),
      ...(updates.metadata?.appliedOperationIds || {}),
      [operationId]: true,
    };
  }

  return {
    ...task,
    ...updates,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    version: (task.version || 0) + 1,
    updatedAt: now,
  };
}

function taskOperationMatches(task: TaskFile, operationId?: string): boolean {
  if (!operationId) return false;
  return task.metadata?.lastOperationId === operationId || task.metadata?.appliedOperationIds?.[operationId] === true;
}

function assertGuardMatches(task: TaskFile, guard: GuardedTaskUpdateOptions): void {
  if (guard.expectedStatus !== undefined && task.status !== guard.expectedStatus) {
    throw new Error(`Task ${task.id} status guard failed: expected ${guard.expectedStatus}, got ${task.status}`);
  }

  if (guard.expectedOwner !== undefined && (task.owner ?? null) !== guard.expectedOwner) {
    throw new Error(`Task ${task.id} owner guard failed: expected ${guard.expectedOwner ?? "<none>"}, got ${task.owner ?? "<none>"}`);
  }

  if (guard.expectedVersion !== undefined && (task.version || 0) !== guard.expectedVersion) {
    throw new Error(`Task ${task.id} version guard failed: expected ${guard.expectedVersion}, got ${task.version || 0}`);
  }

  if (guard.expectedUpdatedAt !== undefined && task.updatedAt !== guard.expectedUpdatedAt) {
    throw new Error(`Task ${task.id} updatedAt guard failed: expected ${guard.expectedUpdatedAt}, got ${task.updatedAt ?? "<none>"}`);
  }
}

export function getTaskId(teamName: string): string {
  const dir = taskDir(teamName);
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  const ids = files.map(f => parseInt(path.parse(f).name, 10)).filter(id => !isNaN(id));
  return ids.length > 0 ? (Math.max(...ids) + 1).toString() : "1";
}

function getTaskPath(teamName: string, taskId: string): string {
  const dir = taskDir(teamName);
  const safeTaskId = sanitizeName(taskId);
  return path.join(dir, `${safeTaskId}.json`);
}

export async function createTask(
  teamName: string,
  subject: string,
  description: string,
  activeForm = "",
  metadata?: Record<string, any>
): Promise<TaskFile> {
  if (!subject || !subject.trim()) throw new Error("Task subject must not be empty");
  if (!teamExists(teamName)) throw new Error(`Team ${teamName} does not exist`);

  const dir = taskDir(teamName);
  const lockPath = dir;

  return await withLock(lockPath, async () => {
    const id = getTaskId(teamName);
    const createdAt = nowIso();
    const task: TaskFile = {
      id,
      subject,
      description,
      activeForm,
      status: "pending",
      blocks: [],
      blockedBy: [],
      version: 1,
      createdAt,
      updatedAt: createdAt,
      metadata,
    };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(task, null, 2));
    return task;
  });
}

export async function updateTask(
  teamName: string,
  taskId: string,
  updates: Partial<TaskFile>,
  retries?: number
): Promise<TaskFile> {
  const p = getTaskPath(teamName, taskId);

  return await withLock(p, async () => {
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    const task: TaskFile = JSON.parse(fs.readFileSync(p, "utf-8"));
    const updated = nextTaskState(task, updates);

    if (updates.status === "deleted") {
      fs.unlinkSync(p);
      return updated;
    }

    fs.writeFileSync(p, JSON.stringify(updated, null, 2));

    if (updates.status === "completed") {
      await runHook(teamName, "task_completed", updated);
    }

    return updated;
  }, retries);
}

/**
 * Submits a plan for a task, updating its status to "planning".
 * @param teamName The name of the team
 * @param taskId The ID of the task
 * @param plan The content of the plan
 * @returns The updated task
 */
export async function updateTaskGuarded(
  teamName: string,
  taskId: string,
  updates: Partial<TaskFile>,
  guard: GuardedTaskUpdateOptions,
  retries?: number
): Promise<GuardedTaskUpdateResult> {
  const p = getTaskPath(teamName, taskId);

  return await withLock(p, async () => {
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    const task: TaskFile = JSON.parse(fs.readFileSync(p, "utf-8"));

    if (taskOperationMatches(task, guard.operationId)) {
      return { task, updated: false, idempotent: true };
    }

    assertGuardMatches(task, guard);
    const updated = nextTaskState(task, updates, guard.operationId);

    if (updates.status === "deleted") {
      fs.unlinkSync(p);
      return { task: updated, updated: true, idempotent: false };
    }

    fs.writeFileSync(p, JSON.stringify(updated, null, 2));

    if (updates.status === "completed") {
      await runHook(teamName, "task_completed", updated);
    }

    return { task: updated, updated: true, idempotent: false };
  }, retries);
}

export async function submitPlan(teamName: string, taskId: string, plan: string): Promise<TaskFile> {
  if (!plan || !plan.trim()) throw new Error("Plan must not be empty");
  return await updateTask(teamName, taskId, { status: "planning", plan });
}

/**
 * Evaluates a submitted plan for a task.
 * @param teamName The name of the team
 * @param taskId The ID of the task
 * @param action The evaluation action: "approve" or "reject"
 * @param feedback Optional feedback for the evaluation (required for rejection)
 * @param retries Number of times to retry acquiring the lock
 * @returns The updated task
 */
export async function evaluatePlan(
  teamName: string,
  taskId: string,
  action: "approve" | "reject",
  feedback?: string,
  retries?: number
): Promise<TaskFile> {
  const p = getTaskPath(teamName, taskId);

  return await withLock(p, async () => {
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    const task: TaskFile = JSON.parse(fs.readFileSync(p, "utf-8"));

    // 1. Validate state: Only "planning" tasks can be evaluated
    if (task.status !== "planning") {
      throw new Error(
        `Cannot evaluate plan for task ${taskId} because its status is '${task.status}'. ` +
        `Tasks must be in 'planning' status to be evaluated.`
      );
    }

    // 2. Validate plan presence
    if (!task.plan || !task.plan.trim()) {
      throw new Error(`Cannot evaluate plan for task ${taskId} because no plan has been submitted.`);
    }

    // 3. Require feedback for rejections
    if (action === "reject" && (!feedback || !feedback.trim())) {
      throw new Error("Feedback is required when rejecting a plan.");
    }

    // 4. Perform update
    const updates: Partial<TaskFile> = action === "approve" 
      ? { status: "in_progress", planFeedback: "" }
      : { status: "planning", planFeedback: feedback };

    const updated = nextTaskState(task, updates);
    fs.writeFileSync(p, JSON.stringify(updated, null, 2));
    return updated;
  }, retries);
}

export async function readTask(teamName: string, taskId: string, retries?: number): Promise<TaskFile> {
  const p = getTaskPath(teamName, taskId);
  if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
  return await withLock(p, async () => {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }, retries);
}

export async function listTasks(teamName: string): Promise<TaskFile[]> {
  const dir = taskDir(teamName);
  return await withLock(dir, async () => {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    const tasks: TaskFile[] = files
      .map(f => {
        const id = parseInt(path.parse(f).name, 10);
        if (isNaN(id)) return null;
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      })
      .filter(t => t !== null);
    return tasks.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
  });
}

export async function markOwnerTasksBlockedByFileClaims(
  teamName: string,
  agentName: string,
  conflicts: FileClaimConflict[],
  blockedAt: string = new Date().toISOString()
): Promise<TaskFile[]> {
  if (conflicts.length === 0) return [];

  const dir = taskDir(teamName);
  if (!fs.existsSync(dir)) return [];

  return await withLock(dir, async () => {
    const blockerIds = conflicts.map(fileClaimBlockId);
    const updatedTasks: TaskFile[] = [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));

    for (const f of files) {
      const p = path.join(dir, f);
      const task: TaskFile = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (task.owner !== agentName || !isOpenTask(task)) continue;

      task.blockedBy = Array.from(new Set([...(task.blockedBy || []), ...blockerIds]));
      task.metadata = {
        ...(task.metadata || {}),
        fileClaimBlock: { blockedAt, conflicts },
      };
      fs.writeFileSync(p, JSON.stringify(task, null, 2));
      updatedTasks.push(task);
    }

    return updatedTasks;
  });
}

export async function clearOwnerFileClaimBlocks(
  teamName: string,
  agentName: string,
  paths?: string[]
): Promise<TaskFile[]> {
  const dir = taskDir(teamName);
  if (!fs.existsSync(dir)) return [];
  const pathSet = paths ? new Set(paths) : undefined;

  return await withLock(dir, async () => {
    const updatedTasks: TaskFile[] = [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));

    for (const f of files) {
      const p = path.join(dir, f);
      const task: TaskFile = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (task.owner !== agentName) continue;

      const originalBlockedBy = task.blockedBy || [];
      const nextBlockedBy = originalBlockedBy.filter(blocker => {
        const blockedPath = parseFileClaimBlockPath(blocker);
        if (!blockedPath) return true;
        return pathSet ? !pathSet.has(blockedPath) : false;
      });

      const fileClaimBlock = task.metadata?.fileClaimBlock as { conflicts?: FileClaimConflict[] } | undefined;
      const remainingConflicts = fileClaimBlock?.conflicts
        ? fileClaimBlock.conflicts.filter(conflict => pathSet ? !pathSet.has(conflict.path) : false)
        : [];

      const metadata = { ...(task.metadata || {}) };
      if (remainingConflicts.length > 0) {
        metadata.fileClaimBlock = { ...fileClaimBlock, conflicts: remainingConflicts };
      } else {
        delete metadata.fileClaimBlock;
      }

      const metadataChanged = JSON.stringify(metadata) !== JSON.stringify(task.metadata || {});
      const blockedByChanged = nextBlockedBy.length !== originalBlockedBy.length;
      if (!metadataChanged && !blockedByChanged) continue;

      task.blockedBy = nextBlockedBy;
      task.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
      fs.writeFileSync(p, JSON.stringify(task, null, 2));
      updatedTasks.push(task);
    }

    return updatedTasks;
  });
}

export async function resetOwnerTasks(teamName: string, agentName: string) {
  const dir = taskDir(teamName);
  const lockPath = dir;

  await withLock(lockPath, async () => {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
    for (const f of files) {
      const p = path.join(dir, f);
      const task: TaskFile = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (task.owner === agentName) {
        task.owner = undefined;
        if (task.status !== "completed") {
          task.status = "pending";
        }
        fs.writeFileSync(p, JSON.stringify(task, null, 2));
      }
    }
  });
}
