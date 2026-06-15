import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "./paths";
import {
  cancelQueuedWriteSpawn,
  dequeueWriteSpawn,
  enqueueWriteSpawn,
  listWriteQueue,
  removeQueuedWriteSpawnsByName,
  queuedWriteSpawnToMember,
} from "./write-queue";

const testDir = path.join(os.tmpdir(), "pi-extended-teams-write-queue-" + Date.now());
const queuePath = path.join(testDir, "write-queue.json");

describe("write queue utilities", () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    vi.spyOn(paths, "writeQueuePath").mockReturnValue(queuePath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
  });

  it("queues and dequeues write spawns in FIFO order", async () => {
    const first = await enqueueWriteSpawn("team", {
      id: "first",
      name: "writer-a",
      prompt: "A",
      cwd: "/repo",
      model: "provider/model",
      requestedAt: 1,
    });
    const second = await enqueueWriteSpawn("team", {
      id: "second",
      name: "writer-b",
      prompt: "B",
      cwd: "/repo",
      model: "provider/model",
      requestedAt: 2,
    });

    expect((await listWriteQueue("team")).map(item => item.id)).toEqual([first.id, second.id]);
    expect((await dequeueWriteSpawn("team"))?.id).toBe("first");
    expect((await dequeueWriteSpawn("team"))?.id).toBe("second");
    expect(await dequeueWriteSpawn("team")).toBeNull();
  });

  it("cancels a queued writer by id", async () => {
    await enqueueWriteSpawn("team", {
      id: "keep",
      name: "writer-a",
      prompt: "A",
      cwd: "/repo",
      model: "provider/model",
    });
    const canceled = await enqueueWriteSpawn("team", {
      id: "cancel-me",
      name: "writer-b",
      prompt: "B",
      cwd: "/repo",
      model: "provider/model",
    });

    expect(await cancelQueuedWriteSpawn("team", canceled.id)).toEqual(canceled);
    expect((await listWriteQueue("team")).map(item => item.id)).toEqual(["keep"]);
    expect(await cancelQueuedWriteSpawn("team", "missing")).toBeNull();
  });

  it("removes queued writers by teammate name", async () => {
    await enqueueWriteSpawn("team", {
      id: "one",
      name: "writer-a",
      prompt: "A",
      cwd: "/repo",
      model: "provider/model",
    });
    await enqueueWriteSpawn("team", {
      id: "two",
      name: "writer-a",
      prompt: "B",
      cwd: "/repo",
      model: "provider/model",
    });
    await enqueueWriteSpawn("team", {
      id: "three",
      name: "writer-b",
      prompt: "C",
      cwd: "/repo",
      model: "provider/model",
    });

    expect((await removeQueuedWriteSpawnsByName("team", "writer-a")).map(item => item.id)).toEqual(["one", "two"]);
    expect((await listWriteQueue("team")).map(item => item.id)).toEqual(["three"]);
  });

  it("converts a queued spawn into a write member", () => {
    const member = queuedWriteSpawnToMember("team", {
      id: "queued",
      name: "writer-a",
      prompt: "Implement it",
      cwd: "/repo",
      category: "feature",
      model: "provider/model",
      thinking: "xhigh",
      planModeRequired: true,
      requestedAt: 1,
    });

    expect(member).toMatchObject({
      agentId: "writer-a@team",
      name: "writer-a",
      agentType: "teammate",
      role: "write",
      category: "feature",
      model: "provider/model",
      cwd: "/repo",
      prompt: "Implement it",
      color: "blue",
      thinking: "xhigh",
      planModeRequired: true,
      tmuxPaneId: "",
    });
    expect(member.joinedAt).toEqual(expect.any(Number));
  });
});
