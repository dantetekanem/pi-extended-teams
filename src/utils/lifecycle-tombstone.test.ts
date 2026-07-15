import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "./paths";
import {
  readLifecycleTombstone,
  withLifecycleTombstoneLock,
} from "./lifecycle-tombstone";

let root = "";

function tombstonePath(teamName: string, agentName: string): string {
  return path.join(root, teamName, "lifecycle", "quarantine", `${agentName}.json`);
}

describe("lifecycle tombstone store", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-tombstone-"));
    vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation(tombstonePath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("atomically writes and reads a schema-v1 tombstone", async () => {
    await withLifecycleTombstoneLock("team", "reader", async lock => {
      const written = lock.occupy({
        team: "team",
        agent: "reader",
        runId: "run-1",
        role: "read",
        reason: "quit",
        extensionInstanceId: "extension-a",
        now: 100,
      });
      expect(written).toMatchObject({
        version: 1,
        team: "team",
        agent: "reader",
        runId: "run-1",
        phase: "closing",
        timestamps: { createdAt: 100, updatedAt: 100 },
      });
    });

    await expect(readLifecycleTombstone("team", "reader")).resolves.toMatchObject({
      status: "occupied",
      tombstone: { version: 1, runId: "run-1", extensionInstanceId: "extension-a" },
    });
    expect(fs.readdirSync(path.dirname(tombstonePath("team", "reader"))).filter(file => file.endsWith(".tmp"))).toEqual([]);
  });

  it("clears only a matching run and leaves a wrong-run request occupied", async () => {
    await withLifecycleTombstoneLock("team", "reader", async lock => {
      lock.occupy({
        team: "team", agent: "reader", runId: "run-1", role: "read", reason: "quit", extensionInstanceId: "extension-a",
      });
      expect(lock.clearMatching("run-2")).toBe(false);
    });
    expect((await readLifecycleTombstone("team", "reader")).status).toBe("occupied");

    await withLifecycleTombstoneLock("team", "reader", async lock => {
      expect(lock.clearMatching("run-1")).toBe(true);
    });
    expect(await readLifecycleTombstone("team", "reader")).toEqual({ status: "absent" });
  });

  it("treats corrupt content as occupied and never overwrites or clears it", async () => {
    const file = tombstonePath("team", "reader");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ malformed");

    await expect(readLifecycleTombstone("team", "reader")).resolves.toMatchObject({ status: "corrupt" });
    await expect(withLifecycleTombstoneLock("team", "reader", async lock => {
      lock.occupy({
        team: "team", agent: "reader", runId: "run-1", role: "read", reason: "quit", extensionInstanceId: "extension-a",
      });
    })).rejects.toThrow("corrupt tombstone");
    await withLifecycleTombstoneLock("team", "reader", async lock => {
      expect(lock.clearMatching("run-1")).toBe(false);
    });
    expect(fs.readFileSync(file, "utf-8")).toBe("{ malformed");
  });
});
