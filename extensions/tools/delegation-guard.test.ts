import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestLeadForTeammateSpawn, resolveLeadRequestTeamName } from "./delegation-guard.js";
import * as paths from "../../src/utils/paths.js";
import { readInbox } from "../../src/utils/messaging.js";

let root: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "inboxPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "inboxes", `${paths.sanitizeName(String(agentName))}.json`);
  });
}

describe("teammate delegation guard", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-delegation-"));
    installPathSpies();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves the active team before a requested team name", () => {
    const teamName = resolveLeadRequestTeamName({
      isTeammate: true,
      agentName: "reader",
      getTeamName: () => "active-team",
    }, "requested-team");

    expect(teamName).toBe("active-team");
  });

  it("falls back to the requested team name when no active team is available", () => {
    const teamName = resolveLeadRequestTeamName({
      isTeammate: true,
      agentName: "reader",
      getTeamName: () => undefined,
    }, "requested-team");

    expect(teamName).toBe("requested-team");
  });

  it("requires either an active team or a requested team name", () => {
    expect(() => resolveLeadRequestTeamName({
      isTeammate: true,
      agentName: "reader",
      getTeamName: () => undefined,
    })).toThrow("Cannot resolve team context without a current team or team_name.");
  });

  it("sends lead-owned agent requests to team-lead instead of spawning directly", async () => {
    const result = await requestLeadForTeammateSpawn({
      isTeammate: true,
      agentName: "reader",
      getTeamName: () => "active-team",
    }, {
      action: "spawn_teammate",
      params: {
        team_name: "requested-team",
        name: "helper",
        prompt: "Investigate the failure",
        role: "read",
      },
      reason: "Need independent coverage",
    });

    expect(result.content[0].text).toContain("Sent a request to team-lead for active-team");
    expect(result.details).toMatchObject({
      requested: true,
      requestedAction: "spawn_teammate",
      teamName: "active-team",
      recipient: "team-lead",
      from: "reader",
    });

    const inbox = await readInbox("active-team", "team-lead", false, false);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      from: "reader",
      summary: "Agent spawn request from reader for helper",
      color: "yellow",
      read: false,
    });
    expect(inbox[0].text).toContain("Teammates are not allowed to spawn or promote other agents directly.");
    expect(inbox[0].text).toContain("Requested action: spawn_teammate");
    expect(inbox[0].text).toContain("Reason: Need independent coverage");
    expect(inbox[0].text).toContain('"prompt": "Investigate the failure"');
  });
});
