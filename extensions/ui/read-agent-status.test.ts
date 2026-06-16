import { describe, expect, it } from "vitest";
import { buildReadAgentIdleNudgeMessage, describeReadAgentStatus, shouldNudgeReadAgentIdle } from "./read-agent-status.js";
import type { RunningReadAgent } from "../runtime/types.js";

function makeAgent(overrides: Partial<RunningReadAgent> = {}): RunningReadAgent {
  const startedAt = Date.UTC(2026, 0, 1, 0, 0, 0);
  return {
    runId: "run-1",
    name: "reader",
    teamName: "team",
    startedAt,
    tokensUsed: 0,
    status: "thinking",
    recentEvents: [],
    lastActivityAt: startedAt,
    ...overrides,
  };
}

describe("read-agent status descriptions", () => {
  it("describes normal thinking as waiting for model response", () => {
    const agent = makeAgent({ status: "thinking" });

    expect(describeReadAgentStatus(agent, agent.startedAt + 10_000)).toMatchObject({
      label: "thinking",
      detail: "waiting for model response",
      idleLevel: "none",
    });
  });

  it("describes normal working with the active tool name", () => {
    const agent = makeAgent({ status: "working", activeToolName: "bash" });

    expect(describeReadAgentStatus(agent, agent.startedAt + 10_000)).toMatchObject({
      label: "working",
      detail: "using bash",
      idleLevel: "none",
    });
  });

  it("nudges softly after 60 seconds without response or token movement", () => {
    const agent = makeAgent({ status: "thinking" });

    expect(describeReadAgentStatus(agent, agent.startedAt + 61_000)).toMatchObject({
      label: "idle",
      detail: "no response/token change for 1m01s · consider ping/check",
      idleLevel: "soft",
      idleMs: 61_000,
    });
  });

  it("nudges hard after 3 minutes without response or token movement", () => {
    const agent = makeAgent({ status: "working", activeToolName: "read" });

    expect(describeReadAgentStatus(agent, agent.startedAt + 181_000)).toMatchObject({
      label: "hanging",
      detail: "no response/token change for 3m01s · ping/check now",
      idleLevel: "hard",
      idleMs: 181_000,
    });
  });

  it("sends each idle nudge once, while still escalating from soft to hard", () => {
    expect(shouldNudgeReadAgentIdle(undefined, "none")).toBe(false);
    expect(shouldNudgeReadAgentIdle(undefined, "soft")).toBe(true);
    expect(shouldNudgeReadAgentIdle("soft", "soft")).toBe(false);
    expect(shouldNudgeReadAgentIdle("soft", "hard")).toBe(true);
    expect(shouldNudgeReadAgentIdle("hard", "hard")).toBe(false);
  });

  it("builds the soft and hard lead nudge messages", () => {
    const agent = makeAgent({ name: "reviewer", teamName: "status-team" });

    expect(buildReadAgentIdleNudgeMessage(agent, {
      label: "idle",
      detail: "",
      idleLevel: "soft",
      idleMs: 61_000,
    })).toBe("Read agent reviewer on team status-team has gone quiet: no response or token change for 1m01s. Ping it or check /team before assuming it is healthy.");

    expect(buildReadAgentIdleNudgeMessage(agent, {
      label: "hanging",
      detail: "",
      idleLevel: "hard",
      idleMs: 181_000,
    })).toBe("Read agent reviewer on team status-team appears hung: no response or token change for 3m01s. Ping/check it now, and consider stopping or promoting it if needed.");
  });
});
