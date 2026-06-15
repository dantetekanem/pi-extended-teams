import fs from "node:fs";
import path from "node:path";
import { withLock } from "./lock";
import { sharedMemoryPath } from "./paths";

export interface SharedMemoryEntry {
  key: string;
  value: string;
  author: string;
  updatedAt: number;
}

function ensureMemoryPath(teamName: string): string {
  const p = sharedMemoryPath(teamName);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return p;
}

function readMemoryRaw(p: string): Record<string, SharedMemoryEntry> {
  if (!fs.existsSync(p)) return {};
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function writeMemoryRaw(p: string, memory: Record<string, SharedMemoryEntry>): void {
  fs.writeFileSync(p, JSON.stringify(memory, null, 2));
}

export async function writeSharedMemory(
  teamName: string,
  author: string,
  key: string,
  value: string
): Promise<SharedMemoryEntry> {
  const normalizedKey = key.trim();
  if (!normalizedKey) throw new Error("Shared memory key must not be empty.");

  const p = ensureMemoryPath(teamName);
  return await withLock(p, async () => {
    const memory = readMemoryRaw(p);
    const entry: SharedMemoryEntry = {
      key: normalizedKey,
      value,
      author,
      updatedAt: Date.now(),
    };
    memory[normalizedKey] = entry;
    writeMemoryRaw(p, memory);
    return entry;
  });
}

export async function readSharedMemory(teamName: string, key?: string): Promise<SharedMemoryEntry[]> {
  const p = ensureMemoryPath(teamName);
  return await withLock(p, async () => {
    const memory = readMemoryRaw(p);
    if (key) {
      const entry = memory[key.trim()];
      return entry ? [entry] : [];
    }
    return Object.values(memory).sort((a, b) => a.key.localeCompare(b.key));
  });
}

export async function deleteSharedMemory(teamName: string, key: string): Promise<SharedMemoryEntry | null> {
  const normalizedKey = key.trim();
  if (!normalizedKey) throw new Error("Shared memory key must not be empty.");

  const p = ensureMemoryPath(teamName);
  return await withLock(p, async () => {
    const memory = readMemoryRaw(p);
    const entry = memory[normalizedKey] || null;
    if (entry) {
      delete memory[normalizedKey];
      writeMemoryRaw(p, memory);
    }
    return entry;
  });
}
