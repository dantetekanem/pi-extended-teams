import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { withLock } from "./lock";
import { readHelperQueuePath } from "./paths";
import type { FavoriteModelSlot } from "./settings";

export interface QueuedReadHelperRequest {
  id: string;
  teamName: string;
  requester: string;
  name: string;
  prompt: string;
  cwd: string;
  modelSlot: FavoriteModelSlot;
  requestedAt: number;
}

function ensureQueuePath(teamName: string): string {
  const queuePath = readHelperQueuePath(teamName);
  const dir = path.dirname(queuePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return queuePath;
}

function readQueueRaw(queuePath: string): QueuedReadHelperRequest[] {
  if (!fs.existsSync(queuePath)) return [];
  const raw = JSON.parse(fs.readFileSync(queuePath, "utf-8"));
  return Array.isArray(raw) ? raw : [];
}

function writeQueueRaw(queuePath: string, queue: QueuedReadHelperRequest[]): void {
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
}

export async function listReadHelperQueue(teamName: string): Promise<QueuedReadHelperRequest[]> {
  const queuePath = ensureQueuePath(teamName);
  return await withLock(queuePath, async () => readQueueRaw(queuePath));
}

export async function enqueueReadHelperRequest(
  teamName: string,
  request: Omit<QueuedReadHelperRequest, "id" | "teamName" | "requestedAt"> & Partial<Pick<QueuedReadHelperRequest, "id" | "requestedAt">>
): Promise<QueuedReadHelperRequest> {
  const queuePath = ensureQueuePath(teamName);
  return await withLock(queuePath, async () => {
    const queue = readQueueRaw(queuePath);
    if (queue.some(item => item.name === request.name)) {
      throw new Error(`Read helper request ${request.name} is already queued for team ${teamName}. Choose a different helper name.`);
    }
    const queued: QueuedReadHelperRequest = {
      id: request.id || crypto.randomUUID(),
      teamName,
      requester: request.requester,
      name: request.name,
      prompt: request.prompt,
      cwd: request.cwd,
      modelSlot: request.modelSlot,
      requestedAt: request.requestedAt || Date.now(),
    };
    queue.push(queued);
    writeQueueRaw(queuePath, queue);
    return queued;
  });
}

export async function dequeueReadHelperRequest(teamName: string): Promise<QueuedReadHelperRequest | null> {
  const queuePath = ensureQueuePath(teamName);
  return await withLock(queuePath, async () => {
    const queue = readQueueRaw(queuePath);
    const next = queue.shift() || null;
    writeQueueRaw(queuePath, queue);
    return next;
  });
}

export async function removeQueuedReadHelperRequest(teamName: string, id: string): Promise<QueuedReadHelperRequest | null> {
  const queuePath = ensureQueuePath(teamName);
  return await withLock(queuePath, async () => {
    const queue = readQueueRaw(queuePath);
    const index = queue.findIndex(item => item.id === id);
    if (index === -1) return null;
    const [removed] = queue.splice(index, 1);
    writeQueueRaw(queuePath, queue);
    return removed;
  });
}

export async function removeQueuedReadHelpersByName(teamName: string, name: string): Promise<QueuedReadHelperRequest[]> {
  const queuePath = ensureQueuePath(teamName);
  return await withLock(queuePath, async () => {
    const queue = readQueueRaw(queuePath);
    const removed = queue.filter(item => item.name === name);
    const kept = queue.filter(item => item.name !== name);
    if (removed.length > 0) writeQueueRaw(queuePath, kept);
    return removed;
  });
}
