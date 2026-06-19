import { describe, expect, it, vi, afterEach } from "vitest";
import { buildRoster } from "./roster.js";
import * as teams from "../../src/utils/teams.js";
import * as tasks from "../../src/utils/tasks.js";
import * as claims from "../../src/utils/claims.js";
import * as runtime from "../../src/utils/runtime.js";
import * as messaging from "../../src/utils/messaging.js";
import * as writeQueue from "../../src/utils/write-queue.js";
import type { Member, TeamConfig, TaskFile } from "../../src/utils/models.js";
import type { FileClaim } from "../../src/utils/claims.js";

function member(name: string, overrides: Partial<Member> = {}): Member {
  return {
    agentId: `${name}@scale`,
    name,
    agentType: name === "team-lead" ? "lead" : "teammate",
    role: name === "team-lead" ? undefined : "write",
    joinedAt: Date.now(),
    tmuxPaneId: name === "team-lead" ? "" : `%${name}`,
    cwd: process.cwd(),
    subscriptions: [],
    ...overrides,
  };
}

describe("team roster performance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("indexes tasks and claims once instead of filtering full lists per member", async () => {
    const members = [
      member("team-lead"),
      ...Array.from({ length: 300 }, (_unused, index) => member(`agent-${index}`)),
    ];
    const config: TeamConfig = {
      name: "scale",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "session",
      members,
    };
    const taskRows: TaskFile[] = [
      { id: "1", subject: "active", description: "", status: "in_progress", owner: "agent-42", blocks: [], blockedBy: [] },
      { id: "2", subject: "pending", description: "", status: "pending", owner: "agent-42", blocks: [], blockedBy: [] },
      { id: "3", subject: "completed", description: "", status: "completed", owner: "agent-42", blocks: [], blockedBy: [] },
      { id: "4", subject: "deleted", description: "", status: "deleted", owner: "agent-99", blocks: [], blockedBy: [] },
      { id: "5", subject: "unowned", description: "", status: "pending", blocks: [], blockedBy: [] },
    ];
    const claimRows: FileClaim[] = [
      { agent: "agent-42", path: "extensions/team/roster.ts", since: 1 },
      { agent: "agent-99", path: "extensions/team/lifecycle.ts", since: 2 },
    ];
    const taskFilterSpy = vi.spyOn(taskRows, "filter");
    const claimFilterSpy = vi.spyOn(claimRows, "filter");

    vi.spyOn(teams, "readConfig").mockResolvedValue(config);
    vi.spyOn(tasks, "listTasks").mockResolvedValue(taskRows);
    vi.spyOn(claims, "listClaims").mockResolvedValue(claimRows);
    vi.spyOn(writeQueue, "listWriteQueue").mockResolvedValue([]);
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({ ready: true } as any);
    vi.spyOn(messaging, "readInbox").mockResolvedValue([]);

    const roster = await buildRoster("scale", {
      terminal: { isAlive: vi.fn(() => true) },
      runningReadAgents: new Map(),
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
    });

    const agent42 = roster.members.find((item) => item.name === "agent-42");
    expect(agent42?.tasks).toEqual([
      { id: "1", subject: "active", status: "in_progress" },
      { id: "2", subject: "pending", status: "pending" },
    ]);
    expect(agent42?.claims).toEqual(["extensions/team/roster.ts"]);
    expect(roster.members.find((item) => item.name === "agent-99")?.tasks).toEqual([]);
    expect(roster.members.find((item) => item.name === "agent-99")?.claims).toEqual(["extensions/team/lifecycle.ts"]);
    expect(taskFilterSpy).not.toHaveBeenCalled();
    expect(claimFilterSpy).not.toHaveBeenCalled();
  });
});
