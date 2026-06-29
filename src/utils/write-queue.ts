import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { Member } from "./models";
import { withLock } from "./lock";
import { writeQueuePath } from "./paths";
import { loadSettings, requireFavoriteModelLevel, type FavoriteModelSlot } from "./settings";

export interface QueuedWriteSpawn {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  category?: string;
  modelSlot: FavoriteModelSlot;
  planModeRequired?: boolean;
  color?: string;
  operationId?: string;
  workflowRunId?: string;
  metadata?: Record<string, any>;
  requestedAt: number;
}

function ensureQueueDir(teamName: string): string {
  const queuePath = writeQueuePath(teamName);
  const dir = path.dirname(queuePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return queuePath;
}

function readQueueRaw(queuePath: string): QueuedWriteSpawn[] {
  if (!fs.existsSync(queuePath)) return [];
  const raw = JSON.parse(fs.readFileSync(queuePath, "utf-8"));
  return Array.isArray(raw) ? raw : [];
}

function writeQueueRaw(queuePath: string, queue: QueuedWriteSpawn[]): void {
  const dir = path.dirname(queuePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(queuePath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(queue, null, 2));
    fs.renameSync(tmpPath, queuePath);
  } catch (e) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors; preserve the original write/rename failure.
    }
    throw e;
  }
}

function operationIdFor(item: Pick<QueuedWriteSpawn, "operationId" | "metadata">): string | undefined {
  return item.operationId || item.metadata?.operationId;
}

function workflowRunIdFor(item: Pick<QueuedWriteSpawn, "workflowRunId" | "metadata">): string | undefined {
  return item.workflowRunId || item.metadata?.workflowRunId;
}

function matchesQueuedIdentity(
  item: QueuedWriteSpawn,
  request: Partial<QueuedWriteSpawn> & Pick<QueuedWriteSpawn, "name">
): boolean {
  if (request.id && item.id === request.id) return true;
  if (item.name === request.name) return true;

  const operationId = operationIdFor(request);
  if (!operationId || operationIdFor(item) !== operationId) return false;

  const workflowRunId = workflowRunIdFor(request);
  return workflowRunId === undefined || workflowRunIdFor(item) === workflowRunId;
}

export async function withWriteQueueCapacityLock<T>(teamName: string, fn: () => Promise<T>): Promise<T> {
  const queuePath = ensureQueueDir(teamName);
  return await withLock(`${queuePath}.capacity`, fn);
}

export async function listWriteQueue(teamName: string): Promise<QueuedWriteSpawn[]> {
  const queuePath = ensureQueueDir(teamName);
  return await withLock(queuePath, async () => readQueueRaw(queuePath));
}

export async function enqueueWriteSpawn(
  teamName: string,
  request: Omit<QueuedWriteSpawn, "id" | "requestedAt"> & Partial<Pick<QueuedWriteSpawn, "id" | "requestedAt">>
): Promise<QueuedWriteSpawn> {
  const queuePath = ensureQueueDir(teamName);
  return await withLock(queuePath, async () => {
    const queue = readQueueRaw(queuePath);
    const existing = queue.find(item => matchesQueuedIdentity(item, request));
    if (existing) return existing;

    const queued: QueuedWriteSpawn = {
      id: request.id || crypto.randomUUID(),
      name: request.name,
      prompt: request.prompt,
      cwd: request.cwd,
      category: request.category,
      modelSlot: request.modelSlot,
      planModeRequired: request.planModeRequired,
      color: request.color,
      operationId: request.operationId,
      workflowRunId: request.workflowRunId,
      metadata: request.metadata,
      requestedAt: request.requestedAt || Date.now(),
    };
    queue.push(queued);
    queue.sort((a, b) => a.requestedAt - b.requestedAt);
    writeQueueRaw(queuePath, queue);
    return queued;
  });
}

export async function dequeueWriteSpawns(teamName: string, count: number): Promise<QueuedWriteSpawn[]> {
  const take = Math.max(0, Math.floor(count));
  if (take < 1) return [];

  const queuePath = ensureQueueDir(teamName);
  return await withLock(queuePath, async () => {
    const queue = readQueueRaw(queuePath);
    const next = queue.splice(0, take);
    if (next.length > 0) writeQueueRaw(queuePath, queue);
    return next;
  });
}

export async function dequeueWriteSpawn(teamName: string): Promise<QueuedWriteSpawn | null> {
  const [queued] = await dequeueWriteSpawns(teamName, 1);
  return queued || null;
}

export async function removeQueuedWriteSpawnsByName(teamName: string, name: string): Promise<QueuedWriteSpawn[]> {
  const queuePath = ensureQueueDir(teamName);
  return await withLock(queuePath, async () => {
    const queue = readQueueRaw(queuePath);
    const removed = queue.filter(item => item.name === name);
    const kept = queue.filter(item => item.name !== name);
    if (removed.length > 0) writeQueueRaw(queuePath, kept);
    return removed;
  });
}

export async function cancelQueuedWriteSpawn(teamName: string, id: string): Promise<QueuedWriteSpawn | null> {
  const queuePath = ensureQueueDir(teamName);
  return await withLock(queuePath, async () => {
    const queue = readQueueRaw(queuePath);
    const index = queue.findIndex(item => item.id === id);
    if (index === -1) return null;
    const [removed] = queue.splice(index, 1);
    writeQueueRaw(queuePath, queue);
    return removed;
  });
}

export async function findQueuedWriteSpawn(
  teamName: string,
  criteria: { name?: string; operationId?: string; workflowRunId?: string }
): Promise<QueuedWriteSpawn | null> {
  const queuePath = ensureQueueDir(teamName);
  return await withLock(queuePath, async () => {
    const queue = readQueueRaw(queuePath);
    return queue.find(item => {
      const nameMatches = criteria.name !== undefined && item.name === criteria.name;
      const operationMatches = criteria.operationId !== undefined
        && (item.operationId || item.metadata?.operationId) === criteria.operationId
        && (criteria.workflowRunId === undefined || (item.workflowRunId || item.metadata?.workflowRunId) === criteria.workflowRunId);
      return nameMatches || operationMatches;
    }) || null;
  });
}

export function queuedWriteSpawnToMember(teamName: string, queued: QueuedWriteSpawn): Member {
  const level = requireFavoriteModelLevel(loadSettings({ projectDir: queued.cwd }), queued.modelSlot);
  if (level.role !== "write") {
    throw new Error(`Queued writer ${queued.name} requires a writing-* level, got ${level.slot}.`);
  }
  return {
    agentId: `${queued.name}@${teamName}`,
    name: queued.name,
    agentType: "teammate",
    role: "write",
    category: queued.category,
    model: level.model,
    joinedAt: Date.now(),
    tmuxPaneId: "",
    cwd: queued.cwd,
    subscriptions: [],
    prompt: queued.prompt,
    color: queued.color || "blue",
    thinking: level.thinking,
    modelSlot: level.slot,
    planModeRequired: queued.planModeRequired,
    metadata: {
      ...(queued.metadata || {}),
      ...(queued.operationId ? { operationId: queued.operationId } : {}),
      ...(queued.workflowRunId ? { workflowRunId: queued.workflowRunId } : {}),
    },
  };
}
