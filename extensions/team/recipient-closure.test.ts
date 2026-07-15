import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../../src/utils/paths.js";
import * as teams from "../../src/utils/teams.js";
import { readLifecycleTombstone } from "../../src/utils/lifecycle-tombstone.js";
import { closePersistedRecipient } from "./recipient-closure.js";

let root = "";

function writeConfig(teamName: string, members: Array<{ name: string; lifecycleRunId?: string; isActive?: boolean }>): void {
  const configFile = paths.configPath(teamName);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ name: teamName, members }, null, 2));
}

describe("closePersistedRecipient", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "recipient-closure-"));
    vi.spyOn(paths, "teamDir").mockImplementation(teamName => path.join(root, String(teamName)));
    vi.spyOn(paths, "configPath").mockImplementation(teamName => path.join(root, String(teamName), "config.json"));
    vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName, agentName) => path.join(root, String(teamName), "lifecycle", "quarantine", `${String(agentName)}.json`));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("fences a missing team as closed without clearing the tombstone", async () => {
    await expect(closePersistedRecipient("missing-team", "reader", "run-1", { removeOnFailure: true })).resolves.toBeUndefined();
    await expect(readLifecycleTombstone("missing-team", "reader")).resolves.toMatchObject({
      status: "occupied",
      tombstone: { runId: "run-1", phase: "persistence_closed" },
    });
  });

  it("treats an already-absent member as closed while retaining the fence", async () => {
    writeConfig("team", [{ name: "team-lead", isActive: true }]);

    await expect(closePersistedRecipient("team", "reader", "run-1", { removeOnFailure: true })).resolves.toBeUndefined();
    expect((await teams.readConfig("team")).members.map(member => member.name)).toEqual(["team-lead"]);
    expect((await readLifecycleTombstone("team", "reader")).status).toBe("occupied");
  });

  it("persists inactive membership only for the expected run", async () => {
    writeConfig("team", [
      { name: "team-lead", isActive: true },
      { name: "reader", lifecycleRunId: "run-1", isActive: true },
    ]);

    await closePersistedRecipient("team", "reader", "run-1");
    expect((await teams.readConfig("team")).members.find(member => member.name === "reader")?.isActive).toBe(false);
  });

  it("removes a still-active matching member after update failure and leaves its tombstone", async () => {
    writeConfig("team", [
      { name: "team-lead", isActive: true },
      { name: "reader", lifecycleRunId: "run-1", isActive: true },
    ]);
    vi.spyOn(teams, "updateMember").mockResolvedValueOnce();

    await closePersistedRecipient("team", "reader", "run-1", { removeOnFailure: true });
    expect((await teams.readConfig("team")).members.map(member => member.name)).toEqual(["team-lead"]);
    await expect(readLifecycleTombstone("team", "reader")).resolves.toMatchObject({
      status: "occupied",
      tombstone: { runId: "run-1", phase: "persistence_closed" },
    });
  });

  it("does not modify a different-run member", async () => {
    writeConfig("team", [
      { name: "team-lead", isActive: true },
      { name: "reader", lifecycleRunId: "run-2", isActive: true },
    ]);

    await expect(closePersistedRecipient("team", "reader", "run-1", { removeOnFailure: true })).rejects.toThrow(
      "expected run run-1, found run-2"
    );
    expect((await teams.readConfig("team")).members.find(member => member.name === "reader")).toMatchObject({
      lifecycleRunId: "run-2",
      isActive: true,
    });
    await expect(readLifecycleTombstone("team", "reader")).resolves.toEqual({ status: "absent" });
  });

  it("leaves a fail-closed tombstone when malformed config prevents closure", async () => {
    const configFile = paths.configPath("team");
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, "{ malformed config");

    await expect(closePersistedRecipient("team", "reader", "run-1", { removeOnFailure: true })).rejects.toThrow();
    expect(fs.readFileSync(configFile, "utf-8")).toBe("{ malformed config");
    expect((await readLifecycleTombstone("team", "reader")).status).toBe("occupied");
  });
});
