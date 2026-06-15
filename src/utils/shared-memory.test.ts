import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "./paths";
import { deleteSharedMemory, readSharedMemory, writeSharedMemory } from "./shared-memory";

const testDir = path.join(os.tmpdir(), "pi-extended-teams-shared-memory-" + Date.now());
const memoryPath = path.join(testDir, "shared-memory.json");

describe("shared memory utilities", () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    vi.spyOn(paths, "sharedMemoryPath").mockReturnValue(memoryPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("writes and reads shared memory entries", async () => {
    const entry = await writeSharedMemory("team", "alice", "api-contract", "GET /users returns users");

    expect(entry).toMatchObject({
      key: "api-contract",
      value: "GET /users returns users",
      author: "alice",
    });
    expect(entry.updatedAt).toEqual(expect.any(Number));

    expect(await readSharedMemory("team", "api-contract")).toEqual([entry]);
  });

  it("lists entries sorted by key", async () => {
    await writeSharedMemory("team", "alice", "z", "last");
    await writeSharedMemory("team", "bob", "a", "first");

    expect((await readSharedMemory("team")).map(entry => entry.key)).toEqual(["a", "z"]);
  });

  it("replaces existing keys", async () => {
    await writeSharedMemory("team", "alice", "decision", "old");
    await writeSharedMemory("team", "bob", "decision", "new");

    expect(await readSharedMemory("team", "decision")).toMatchObject([
      { key: "decision", value: "new", author: "bob" },
    ]);
  });

  it("deletes entries", async () => {
    const entry = await writeSharedMemory("team", "alice", "decision", "keep");

    expect(await deleteSharedMemory("team", "decision")).toEqual(entry);
    expect(await readSharedMemory("team", "decision")).toEqual([]);
    expect(await deleteSharedMemory("team", "decision")).toBeNull();
  });

  it("rejects blank keys", async () => {
    await expect(writeSharedMemory("team", "alice", " ", "value")).rejects.toThrow("must not be empty");
    await expect(deleteSharedMemory("team", " ")).rejects.toThrow("must not be empty");
  });
});
