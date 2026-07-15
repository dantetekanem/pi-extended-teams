import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  writeRuntimeStatus,
  readRuntimeStatus,
  deleteRuntimeStatus,
  cleanupStaleRuntimeFiles,
  createRuntimeError,
  HEARTBEAT_STALE_MS,
  STARTUP_STALL_MS,
  RUNTIME_STALE_MS,
} from "./runtime";
import * as paths from "./paths";

describe("runtime status", () => {
  const teamName = `runtime-test-${Date.now()}`;
  const agentName = "worker-1";
  const runId = "worker-run";
  let root: string;

  function writeRoster(members: Array<{ name: string; lifecycleRunId: string; isActive?: boolean }>): void {
    fs.writeFileSync(paths.configPath(teamName), JSON.stringify({ name: teamName, members }, null, 2));
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-runtime-"));
    const teamPath = (teamName: string) => path.join(root, "teams", paths.sanitizeName(teamName));
    vi.spyOn(paths, "teamDir").mockImplementation(teamPath);
    vi.spyOn(paths, "configPath").mockImplementation(teamName => path.join(teamPath(teamName), "config.json"));
    vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName, agentName) => {
      return path.join(teamPath(teamName), "runtime", `${paths.sanitizeName(agentName)}.json`);
    });
    vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName, agentName) => {
      return path.join(teamPath(teamName), "lifecycle", "quarantine", `${paths.sanitizeName(agentName)}.json`);
    });
    fs.mkdirSync(paths.teamDir(teamName), { recursive: true });
    writeRoster([{ name: agentName, lifecycleRunId: runId, isActive: true }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes and reads status", async () => {
    await writeRuntimeStatus(teamName, agentName, runId, {
      pid: 123,
      startedAt: 1000,
      ready: false,
    });

    const runtime = await readRuntimeStatus(teamName, agentName);
    expect(runtime).not.toBeNull();
    expect(runtime?.teamName).toBe(teamName);
    expect(runtime?.agentName).toBe(agentName);
    expect(runtime?.pid).toBe(123);
    expect(runtime?.ready).toBe(false);
  });

  it("merges updates instead of overwriting status", async () => {
    await writeRuntimeStatus(teamName, agentName, runId, {
      pid: 123,
      startedAt: 1000,
      ready: false,
      latestProgress: "Inspecting runtime state",
      progressUpdatedAt: 1500,
    });

    await writeRuntimeStatus(teamName, agentName, runId, {
      lastHeartbeatAt: 2000,
      ready: true,
      currentAction: "working",
      activeToolName: "read",
    });

    const runtime = await readRuntimeStatus(teamName, agentName);
    expect(runtime?.pid).toBe(123);
    expect(runtime?.startedAt).toBe(1000);
    expect(runtime?.lastHeartbeatAt).toBe(2000);
    expect(runtime?.ready).toBe(true);
    expect(runtime?.currentAction).toBe("working");
    expect(runtime?.activeToolName).toBe("read");
    expect(runtime?.latestProgress).toBe("Inspecting runtime state");
    expect(runtime?.progressUpdatedAt).toBe(1500);
  });

  it("returns null when status does not exist", async () => {
    const missing = await readRuntimeStatus(teamName, "missing-agent");
    expect(missing).toBeNull();
  });

  it("stores status in team runtime directory", async () => {
    await writeRuntimeStatus(teamName, agentName, runId, { ready: true });
    const p = paths.runtimeStatusPath(teamName, agentName);
    expect(path.basename(path.dirname(p))).toBe("runtime");
    expect(fs.existsSync(p)).toBe(true);
  });

  describe("deleteRuntimeStatus", () => {
    it("deletes existing runtime status", async () => {
      await writeRuntimeStatus(teamName, agentName, runId, { ready: true });
      const deleted = await deleteRuntimeStatus(teamName, agentName);
      expect(deleted).toBe(true);

      const runtime = await readRuntimeStatus(teamName, agentName);
      expect(runtime).toBeNull();
    });

    it("returns false when status does not exist", async () => {
      const deleted = await deleteRuntimeStatus(teamName, "nonexistent");
      expect(deleted).toBe(false);
    });

    it("refuses wrong-run overwrite and deletion", async () => {
      await writeRuntimeStatus(teamName, agentName, runId, { ready: true });

      await expect(writeRuntimeStatus(teamName, agentName, "replacement-run", {
        ready: false,
      })).rejects.toThrow("not replacement-run");
      await expect(deleteRuntimeStatus(teamName, agentName, "replacement-run")).resolves.toBe(false);
      await expect(readRuntimeStatus(teamName, agentName)).resolves.toMatchObject({
        lifecycleRunId: runId,
        ready: true,
      });
      await expect(deleteRuntimeStatus(teamName, agentName, runId)).resolves.toBe(true);
    });
  });

  describe("cleanupStaleRuntimeFiles", () => {
    it("removes stale runtime files with old heartbeats", async () => {
      const staleTime = Date.now() - RUNTIME_STALE_MS - 1000;
      writeRoster([
        { name: agentName, lifecycleRunId: runId, isActive: true },
        { name: "stale-agent", lifecycleRunId: "stale-run", isActive: true },
      ]);
      await writeRuntimeStatus(teamName, "stale-agent", "stale-run", {
        startedAt: staleTime,
        lastHeartbeatAt: staleTime,
        ready: true,
      });

      const cleaned = await cleanupStaleRuntimeFiles(teamName);
      expect(cleaned).toBe(1);

      const runtime = await readRuntimeStatus(teamName, "stale-agent");
      expect(runtime).toBeNull();
    });

    it("preserves runtime files with recent heartbeats", async () => {
      await writeRuntimeStatus(teamName, agentName, runId, {
        startedAt: Date.now() - RUNTIME_STALE_MS - 1000,
        lastHeartbeatAt: Date.now(),
        ready: true,
      });

      const cleaned = await cleanupStaleRuntimeFiles(teamName);
      expect(cleaned).toBe(0);

      const runtime = await readRuntimeStatus(teamName, agentName);
      expect(runtime).not.toBeNull();
    });

    it("removes corrupted files while holding the lifecycle and runtime locks", async () => {
      const runtimeDir = path.join(paths.teamDir(teamName), "runtime");
      if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(path.join(runtimeDir, "corrupted.json"), "not valid json");

      const cleaned = await cleanupStaleRuntimeFiles(teamName);
      expect(cleaned).toBe(1);
    });

    it("re-reads after taking the lifecycle lock and preserves a concurrent fresh replacement", async () => {
      const staleTime = Date.now() - RUNTIME_STALE_MS - 1000;
      await writeRuntimeStatus(teamName, agentName, runId, {
        startedAt: staleTime,
        lastHeartbeatAt: staleTime,
        ready: true,
      });
      let releaseLifecycleBarrier!: () => void;
      const lifecycleBarrier = new Promise<void>(resolve => { releaseLifecycleBarrier = resolve; });
      let notifyLifecycleLocked!: () => void;
      const lifecycleLocked = new Promise<void>(resolve => { notifyLifecycleLocked = resolve; });

      const cleanup = cleanupStaleRuntimeFiles(teamName, Date.now(), {
        afterLifecycleLock: async name => {
          if (name !== agentName) return;
          notifyLifecycleLocked();
          await lifecycleBarrier;
        },
      });
      await lifecycleLocked;
      fs.writeFileSync(paths.runtimeStatusPath(teamName, agentName), JSON.stringify({
        teamName,
        agentName,
        lifecycleRunId: runId,
        startedAt: staleTime,
        lastHeartbeatAt: Date.now(),
        ready: true,
      }, null, 2));
      releaseLifecycleBarrier();

      await expect(cleanup).resolves.toBe(0);
      await expect(readRuntimeStatus(teamName, agentName)).resolves.toMatchObject({
        lifecycleRunId: runId,
        ready: true,
      });
    });

    it("serializes a fresh heartbeat behind stale deletion without losing the new runtime", async () => {
      const staleTime = Date.now() - RUNTIME_STALE_MS - 1000;
      await writeRuntimeStatus(teamName, agentName, runId, {
        startedAt: staleTime,
        lastHeartbeatAt: staleTime,
        ready: true,
      });
      let releaseDeleteBarrier!: () => void;
      const deleteBarrier = new Promise<void>(resolve => { releaseDeleteBarrier = resolve; });
      let notifyBeforeDelete!: () => void;
      const beforeDelete = new Promise<void>(resolve => { notifyBeforeDelete = resolve; });

      const cleanup = cleanupStaleRuntimeFiles(teamName, Date.now(), {
        beforeDelete: async name => {
          if (name !== agentName) return;
          notifyBeforeDelete();
          await deleteBarrier;
        },
      });
      await beforeDelete;
      let heartbeatSettled = false;
      const heartbeat = writeRuntimeStatus(teamName, agentName, runId, {
        lastHeartbeatAt: Date.now(),
        ready: true,
      }).then(result => {
        heartbeatSettled = true;
        return result;
      });
      await Promise.resolve();
      expect(heartbeatSettled).toBe(false);
      releaseDeleteBarrier();

      await expect(cleanup).resolves.toBe(1);
      await expect(heartbeat).resolves.toMatchObject({ lifecycleRunId: runId, ready: true });
      await expect(readRuntimeStatus(teamName, agentName)).resolves.toMatchObject({
        lifecycleRunId: runId,
        ready: true,
      });
    });

    it("rejects writes while an occupied or corrupt tombstone fences the active roster member", async () => {
      const tombstonePath = paths.lifecycleTombstonePath(teamName, agentName);
      fs.mkdirSync(path.dirname(tombstonePath), { recursive: true });
      fs.writeFileSync(tombstonePath, JSON.stringify({
        version: 1,
        team: teamName,
        agent: agentName,
        runId,
        role: "write",
        reason: "quit",
        phase: "closing",
        ownerPid: process.pid,
        extensionInstanceId: "test-instance",
        timestamps: { createdAt: Date.now(), updatedAt: Date.now() },
      }));
      await expect(writeRuntimeStatus(teamName, agentName, runId, { ready: false }))
        .rejects.toThrow("lifecycle run worker-run is closing");

      fs.writeFileSync(tombstonePath, "not json");
      await expect(writeRuntimeStatus(teamName, agentName, runId, { ready: false }))
        .rejects.toThrow("lifecycle tombstone is corrupt");
    });

    it("returns 0 when no runtime directory exists", async () => {
      const cleaned = await cleanupStaleRuntimeFiles("nonexistent-team");
      expect(cleaned).toBe(0);
    });
  });

  describe("createRuntimeError", () => {
    it("creates structured error from Error object", () => {
      const error = new Error("Test error");
      const runtimeError = createRuntimeError(error);
      expect(runtimeError.message).toBe("Test error");
      expect(runtimeError.timestamp).toBeGreaterThan(0);
    });

    it("creates structured error from string", () => {
      const runtimeError = createRuntimeError("String error");
      expect(runtimeError.message).toBe("String error");
      expect(runtimeError.timestamp).toBeGreaterThan(0);
    });

    it("creates structured error from unknown type", () => {
      const runtimeError = createRuntimeError({ weird: "object" });
      expect(runtimeError.message).toBe("[object Object]");
      expect(runtimeError.timestamp).toBeGreaterThan(0);
    });
  });

  describe("constants", () => {
    it("exports HEARTBEAT_STALE_MS with correct value", () => {
      expect(HEARTBEAT_STALE_MS).toBe(90000);
    });

    it("exports STARTUP_STALL_MS with correct value", () => {
      expect(STARTUP_STALL_MS).toBe(60000);
    });

    it("exports RUNTIME_STALE_MS with correct value", () => {
      expect(RUNTIME_STALE_MS).toBe(300000);
    });
  });
});