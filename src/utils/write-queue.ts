import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { Member } from "./models";
import { withLock } from "./lock";
import { writeQueuePath } from "./paths";

export interface QueuedWriteSpawn {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  category?: string;
  model: string;
  thinking?: Member["thinking"];
  planModeRequired?: boolean;
  color?: string;
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
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
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
    const queued: QueuedWriteSpawn = {
      id: request.id || crypto.randomUUID(),
      name: request.name,
      prompt: request.prompt,
      cwd: request.cwd,
      category: request.category,
      model: request.model,
      thinking: request.thinking,
      planModeRequired: request.planModeRequired,
      color: request.color,
      requestedAt: request.requestedAt || Date.now(),
    };
    queue.push(queued);
    writeQueueRaw(queuePath, queue);
    return queued;
  });
}

export async function dequeueWriteSpawn(teamName: string): Promise<QueuedWriteSpawn | null> {
  const queuePath = ensureQueueDir(teamName);
  return await withLock(queuePath, async () => {
    const queue = readQueueRaw(queuePath);
    const next = queue.shift() || null;
    writeQueueRaw(queuePath, queue);
    return next;
  });
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

export function queuedWriteSpawnToMember(teamName: string, queued: QueuedWriteSpawn): Member {
  return {
    agentId: `${queued.name}@${teamName}`,
    name: queued.name,
    agentType: "teammate",
    role: "write",
    category: queued.category,
    model: queued.model,
    joinedAt: Date.now(),
    tmuxPaneId: "",
    cwd: queued.cwd,
    subscriptions: [],
    prompt: queued.prompt,
    color: queued.color || "blue",
    thinking: queued.thinking,
    planModeRequired: queued.planModeRequired,
  };
}
