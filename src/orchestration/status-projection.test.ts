import { describe, expect, it } from "vitest";
import { AGENT_HANGING_MS, projectAgentStatus } from "./status-projection";
import type { Member } from "../utils/models";

const member = { lifecycleRunId: "run", joinedAt: 1, role: "write", isActive: true } as Member;
const activity = { runId: "run", startedAt: 1, lastActivityAt: 1, status: "thinking" as const };
const input = { member, runtime: null, fence: { status: "absent" as const }, terminalAlive: null, now: AGENT_HANGING_MS + 2 };

describe("status telemetry evidence", () => {
  it.each(["read", "write"] as const)("reports unknown for a %s agent without runtime evidence", (role) => {
    expect(projectAgentStatus({ ...input, member: { ...member, role } })).toMatchObject({
      phase: "unknown", health: "unknown", alive: null,
    });
  });

  it("keeps external activity unknown while retaining its lifecycle phase", () => {
    expect(projectAgentStatus({ ...input, activity: { ...activity, externalControl: {} }, unreadCount: 1 })).toMatchObject({
      phase: "thinking", health: "unknown", alive: true, startupStalled: false,
    });
  });

  it("preserves native quiet-time stalls", () => {
    expect(projectAgentStatus({ ...input, activity })).toMatchObject({ phase: "stalled", health: "stalled" });
  });

  it("preserves explicit death evidence", () => {
    expect(projectAgentStatus({ ...input, terminalAlive: false })).toMatchObject({ health: "dead", alive: false });
  });

  it("preserves lifecycle fences and errors without telemetry", () => {
    expect(projectAgentStatus({ ...input, fence: { status: "corrupt", error: "invalid fence" } })).toMatchObject({
      phase: "quarantined", health: "quarantined", error: "invalid fence",
    });
  });
});
