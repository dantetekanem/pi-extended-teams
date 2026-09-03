import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "./paths";
import { publishHerdrOwnerMatchingRun, readConfig, updateActiveMemberMatchingRun } from "./teams";
import { withLifecycleTombstoneLock } from "./lifecycle-tombstone";

let root: string;

function writeTeam(runId: string, isActive = true): void {
  const file = paths.configPath("team");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    name: "team",
    description: "",
    createdAt: Date.now(),
    leadAgentId: "lead",
    leadSessionId: "session",
    members: [{
      agentId: "reader@team",
      name: "reader",
      agentType: "teammate",
      role: "read",
      lifecycleRunId: runId,
      isActive,
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
    }],
  }, null, 2));
}

describe("exact-run member publication", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-member-cas-"));
    vi.spyOn(paths, "teamDir").mockImplementation(teamName => path.join(root, "teams", paths.sanitizeName(String(teamName))));
    vi.spyOn(paths, "configPath").mockImplementation(teamName => path.join(root, "teams", paths.sanitizeName(String(teamName)), "config.json"));
    vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName, agentName) => {
      return path.join(root, "teams", paths.sanitizeName(String(teamName)), "lifecycle", "quarantine", `${paths.sanitizeName(String(agentName))}.json`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("recognizes an exact same-run external finalizer without rewriting or rejecting it", async () => {
    writeTeam("run-1");
    await updateActiveMemberMatchingRun("team", "reader", "run-1", {
      backendType: "herdr-pending",
      tmuxPaneId: "w1:p9",
      processIdentity: "token-1",
      cleanupPrivateSessionOnFinalize: true,
    });
    await withLifecycleTombstoneLock("team", "reader", async lifecycleLock => {
      lifecycleLock.occupy({
        team: "team",
        agent: "reader",
        runId: "run-1",
        role: "read",
        reason: "quit",
        extensionInstanceId: "external-finalizer",
      });
    });
    const config = await readConfig("team");
    config.members[0].isActive = false;
    fs.writeFileSync(paths.configPath("team"), JSON.stringify(config, null, 2));

    await expect(publishHerdrOwnerMatchingRun("team", "reader", "run-1", {
      backendType: "herdr",
    })).resolves.toBe("finalizing");
    await expect(readConfig("team")).resolves.toMatchObject({
      members: [expect.objectContaining({
        lifecycleRunId: "run-1",
        backendType: "herdr-pending",
        tmuxPaneId: "w1:p9",
        processIdentity: "token-1",
        cleanupPrivateSessionOnFinalize: true,
        isActive: false,
      })],
    });
  });

  it("updates only the active member belonging to the expected lifecycle run", async () => {
    writeTeam("run-1");

    await expect(updateActiveMemberMatchingRun("team", "reader", "run-1", {
      backendType: "herdr",
      tmuxPaneId: "w1:p9",
      processIdentity: "handoff-token-1",
    })).resolves.toBe(true);
    await expect(readConfig("team")).resolves.toMatchObject({
      members: [expect.objectContaining({
        lifecycleRunId: "run-1",
        backendType: "herdr",
        tmuxPaneId: "w1:p9",
        processIdentity: "handoff-token-1",
      })],
    });

    writeTeam("run-2");
    await expect(updateActiveMemberMatchingRun("team", "reader", "run-1", {
      backendType: "herdr",
      tmuxPaneId: "stale-pane",
    })).resolves.toBe(false);
    await expect(readConfig("team")).resolves.toMatchObject({
      members: [expect.objectContaining({ lifecycleRunId: "run-2", tmuxPaneId: "" })],
    });

    writeTeam("run-1", false);
    await expect(updateActiveMemberMatchingRun("team", "reader", "run-1", {
      backendType: "herdr",
      tmuxPaneId: "closed-pane",
    })).resolves.toBe(false);

    fs.unlinkSync(paths.configPath("team"));
    await expect(updateActiveMemberMatchingRun("team", "reader", "run-1", {
      backendType: "herdr",
      tmuxPaneId: "missing-team-pane",
    })).resolves.toBe(false);
  });
});
