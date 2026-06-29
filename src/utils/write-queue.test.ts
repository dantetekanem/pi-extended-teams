import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "./paths";
import {
  cancelQueuedWriteSpawn,
  dequeueWriteSpawn,
  dequeueWriteSpawns,
  enqueueWriteSpawn,
  findQueuedWriteSpawn,
  listWriteQueue,
  removeQueuedWriteSpawnsByName,
  queuedWriteSpawnToMember,
} from "./write-queue";

type EnqueueWriteSpawnRequest = Parameters<typeof enqueueWriteSpawn>[1];

const testDir = path.join(os.tmpdir(), "pi-extended-teams-write-queue-" + Date.now());
const queuePath = path.join(testDir, "write-queue.json");
const HIGH_VOLUME_WRITER_COUNT = 350;
const HIGH_VOLUME_STAGE_BUDGET_MS = 5_000;
const HIGH_VOLUME_TEST_TIMEOUT_MS = 15_000;

function highVolumeWriterId(index: number): string {
  return `writer-${String(index).padStart(3, "0")}`;
}

function highVolumeWriteSpawn(index: number): EnqueueWriteSpawnRequest {
  const id = highVolumeWriterId(index);
  return {
    id,
    name: id,
    prompt: `Implement high-volume shard ${index}`,
    cwd: testDir,
    category: index % 2 === 0 ? "feature" : undefined,
    modelSlot: "writing-hard",
    planModeRequired: index % 2 === 0,
    color: index % 2 === 0 ? "green" : "blue",
    operationId: `scale-op-${String(index).padStart(3, "0")}`,
    workflowRunId: "scale-run",
    metadata: { slot: index, fanout: HIGH_VOLUME_WRITER_COUNT },
    requestedAt: index + 1,
  };
}

function writeFavoriteLevels() {
  const settingsPath = path.join(testDir, ".pi", "agent", "pi-extended-teams", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    favoriteModels: {
      "writing-basic": { model: "provider/model", thinking: "high" },
      "writing-hard": { model: "provider/model", thinking: "xhigh" },
    },
  }));
}

describe("write queue utilities", () => {
  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
    vi.spyOn(paths, "writeQueuePath").mockReturnValue(queuePath);
    vi.spyOn(os, "homedir").mockReturnValue(testDir);
    writeFavoriteLevels();
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
      cwd: testDir,
      modelSlot: "writing-basic",
      requestedAt: 1,
    });
    const second = await enqueueWriteSpawn("team", {
      id: "second",
      name: "writer-b",
      prompt: "B",
      cwd: testDir,
      modelSlot: "writing-hard",
      requestedAt: 2,
    });

    expect((await listWriteQueue("team")).map(item => item.id)).toEqual([first.id, second.id]);
    expect((await dequeueWriteSpawn("team"))?.id).toBe("first");
    expect((await dequeueWriteSpawn("team"))?.id).toBe("second");
    expect(await dequeueWriteSpawn("team")).toBeNull();
  });

  it("handles a high configured writer capacity without dropping order or metadata", async () => {
    const enqueueStartedAt = Date.now();
    await Promise.all(Array.from({ length: HIGH_VOLUME_WRITER_COUNT }, (_value, index) => (
      enqueueWriteSpawn("team", highVolumeWriteSpawn(index))
    )));
    const enqueueMs = Date.now() - enqueueStartedAt;

    const queue = await listWriteQueue("team");
    expect(queue).toHaveLength(HIGH_VOLUME_WRITER_COUNT);
    expect(queue.slice(0, 3).map(item => item.id)).toEqual([
      highVolumeWriterId(0),
      highVolumeWriterId(1),
      highVolumeWriterId(2),
    ]);
    expect(queue.at(-1)).toMatchObject({
      id: highVolumeWriterId(HIGH_VOLUME_WRITER_COUNT - 1),
      name: highVolumeWriterId(HIGH_VOLUME_WRITER_COUNT - 1),
      requestedAt: HIGH_VOLUME_WRITER_COUNT,
      metadata: { fanout: HIGH_VOLUME_WRITER_COUNT },
    });

    const middleIndex = Math.floor(HIGH_VOLUME_WRITER_COUNT / 2);
    const middle = await findQueuedWriteSpawn("team", {
      operationId: `scale-op-${String(middleIndex).padStart(3, "0")}`,
      workflowRunId: "scale-run",
    });
    expect(middle).toMatchObject({
      id: highVolumeWriterId(middleIndex),
      metadata: { slot: middleIndex, fanout: HIGH_VOLUME_WRITER_COUNT },
    });
    expect(enqueueMs).toBeLessThan(HIGH_VOLUME_STAGE_BUDGET_MS);

    const dequeueStartedAt = Date.now();
    const drainedIds: string[] = [];
    for (let index = 0; index < HIGH_VOLUME_WRITER_COUNT; index++) {
      const queued = await dequeueWriteSpawn("team");
      expect(queued).not.toBeNull();
      drainedIds.push(queued!.id);
    }
    const dequeueMs = Date.now() - dequeueStartedAt;

    expect(drainedIds[0]).toBe(highVolumeWriterId(0));
    expect(drainedIds.at(-1)).toBe(highVolumeWriterId(HIGH_VOLUME_WRITER_COUNT - 1));
    expect(await dequeueWriteSpawn("team")).toBeNull();
    expect(dequeueMs).toBeLessThan(HIGH_VOLUME_STAGE_BUDGET_MS);
  }, HIGH_VOLUME_TEST_TIMEOUT_MS);

  it("deduplicates concurrent queued writers by name under the queue lock", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, (_value, index) => (
      enqueueWriteSpawn("team", {
        id: `duplicate-${index}`,
        name: "writer-a",
        prompt: `work ${index}`,
        cwd: testDir,
        modelSlot: "writing-basic",
      })
    )));

    const queue = await listWriteQueue("team");
    expect(queue).toHaveLength(1);
    expect(new Set(results.map(item => item.id))).toEqual(new Set([queue[0].id]));
  });

  it("dequeues batches atomically without duplicating or dropping concurrent drains", async () => {
    for (let index = 0; index < 10; index++) {
      await enqueueWriteSpawn("team", highVolumeWriteSpawn(index));
    }

    const [first, second] = await Promise.all([
      dequeueWriteSpawns("team", 7),
      dequeueWriteSpawns("team", 7),
    ]);
    const drainedIds = [...first, ...second].map(item => item.id);

    expect(drainedIds).toHaveLength(10);
    expect(new Set(drainedIds).size).toBe(10);
    expect(drainedIds.sort()).toEqual(Array.from({ length: 10 }, (_value, index) => highVolumeWriterId(index)).sort());
    expect(await listWriteQueue("team")).toEqual([]);
  });

  it("cancels a queued writer by id", async () => {
    await enqueueWriteSpawn("team", {
      id: "keep",
      name: "writer-a",
      prompt: "A",
      cwd: testDir,
      modelSlot: "writing-basic",
    });
    const canceled = await enqueueWriteSpawn("team", {
      id: "cancel-me",
      name: "writer-b",
      prompt: "B",
      cwd: testDir,
      modelSlot: "writing-hard",
    });

    expect(await cancelQueuedWriteSpawn("team", canceled.id)).toEqual(canceled);
    expect((await listWriteQueue("team")).map(item => item.id)).toEqual(["keep"]);
    expect(await cancelQueuedWriteSpawn("team", "missing")).toBeNull();
  });

  it("removes all queued writers by teammate name, including legacy duplicates", async () => {
    fs.writeFileSync(queuePath, JSON.stringify([
      { id: "one", name: "writer-a", prompt: "A", cwd: testDir, modelSlot: "writing-basic", requestedAt: 1 },
      { id: "two", name: "writer-a", prompt: "B", cwd: testDir, modelSlot: "writing-hard", requestedAt: 2 },
      { id: "three", name: "writer-b", prompt: "C", cwd: testDir, modelSlot: "writing-basic", requestedAt: 3 },
    ]));

    expect((await removeQueuedWriteSpawnsByName("team", "writer-a")).map(item => item.id)).toEqual(["one", "two"]);
    expect((await listWriteQueue("team")).map(item => item.id)).toEqual(["three"]);
  });

  it("converts a queued spawn into a write member", () => {
    const member = queuedWriteSpawnToMember("team", {
      id: "queued",
      name: "writer-a",
      prompt: "Implement it",
      cwd: testDir,
      category: "feature",
      modelSlot: "writing-hard",
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
      modelSlot: "writing-hard",
      cwd: testDir,
      prompt: "Implement it",
      color: "blue",
      thinking: "xhigh",
      planModeRequired: true,
      tmuxPaneId: "",
    });
    expect(member.joinedAt).toEqual(expect.any(Number));
  });
});
