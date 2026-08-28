import { afterEach, describe, expect, it, vi } from "vitest";
import * as teams from "../../src/utils/teams.js";
import * as runtime from "../../src/utils/runtime.js";
import type { Member } from "../../src/utils/models.js";
import type { RunningReadAgent } from "./types.js";
import { createTeammateInterrupter } from "./teammate-interrupt.js";

const key = (teamName: string, agentName: string) => `${teamName}:${agentName}`;
const team = (members: Member[]) => ({
  name: "team", description: "", createdAt: Date.now(), leadAgentId: "lead", leadSessionId: "lead-session", members,
});

function member(overrides: Partial<Member> = {}): Member {
  return {
    agentId: "reader@team", name: "reader", agentType: "teammate", role: "read",
    lifecycleRunId: "run-1", joinedAt: Date.now(), tmuxPaneId: "", cwd: process.cwd(),
    subscriptions: [], isActive: true, ...overrides,
  };
}

function readState(session: any, overrides: Partial<RunningReadAgent> = {}): RunningReadAgent {
  return {
    runId: "run-1", name: "reader", teamName: "team", startedAt: Date.now(), tokensUsed: 12,
    status: "working", activeToolName: "bash", activeOperationGeneration: 1,
    activeOperationSettlementPromise: Promise.resolve(), recentEvents: [],
    lastActivityAt: Date.now(), teardownState: "active", acceptingMessages: true, session, ...overrides,
  };
}

function createInterrupt(state?: RunningReadAgent, terminal: any = null, settleTimeoutMs?: number) {
  return createTeammateInterrupter({
    terminal,
    runningReadAgents: new Map(state ? [[key("team", state.name), state]] : []),
    readAgentKey: key,
    getTeamName: () => "team",
    settleTimeoutMs,
  });
}

describe("teammate command interruption", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aborts a read command without changing the agent lifecycle", async () => {
    let streaming = true;
    const session = { get isStreaming() { return streaming; }, abort: vi.fn(async () => { streaming = false; }) };
    const state = readState(session);
    vi.spyOn(teams, "readConfig").mockResolvedValue(team([member()]));
    const terminal = { interrupt: vi.fn(), kill: vi.fn() };

    await expect(createInterrupt(state, terminal, 20)("reader")).resolves.toMatchObject({
      status: "interrupted", agentKind: "read", lifecycleRunId: "run-1", mechanism: "agent-session-abort",
    });
    expect(session.abort).toHaveBeenCalledOnce();
    expect(state).toMatchObject({ interruptRequestedGeneration: 1, session, teardownState: "active" });
    expect(state.stopRequested).not.toBe(true);
    expect(terminal.interrupt).not.toHaveBeenCalled();
    expect(terminal.kill).not.toHaveBeenCalled();
  });

  it("requires command proof and bounds cooperative read cancellation", async () => {
    const idleSession = { isStreaming: true, abort: vi.fn(async () => {}) };
    vi.spyOn(teams, "readConfig").mockResolvedValue(team([member()]));
    await expect(createInterrupt(readState(idleSession, { activeToolName: undefined, status: "thinking" }))("reader"))
      .resolves.toMatchObject({ status: "no_command" });
    expect(idleSession.abort).not.toHaveBeenCalled();

    vi.useFakeTimers();
    let settle!: () => void;
    const rawAbort = new Promise<void>((resolve) => { settle = resolve; });
    const state = readState({ isStreaming: true, abort: vi.fn(() => rawAbort) });
    const pending = createInterrupt(state, null, 25)("reader");
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toMatchObject({ status: "pending", lifecycleRunId: "run-1" });
    expect(state).toMatchObject({ teardownState: "active" });
    expect(state.stopRequested).not.toBe(true);
    settle();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("delivers Pi's Escape interrupt to a proven tmux command without killing the pane", async () => {
    const writer = member({ name: "writer", role: "write", lifecycleRunId: "writer-run", tmuxPaneId: "%42" });
    vi.spyOn(teams, "readConfig").mockResolvedValue(team([writer]));
    vi.spyOn(runtime, "readRuntimeStatus").mockResolvedValue({
      teamName: "team", agentName: "writer", lifecycleRunId: "writer-run", ready: true,
      lastHeartbeatAt: Date.now(), currentAction: "working", activeToolName: "bash",
    });
    const terminal = { interrupt: vi.fn(() => true), kill: vi.fn() };

    await expect(createInterrupt(undefined, terminal)("writer")).resolves.toMatchObject({
      status: "interrupt_sent", agentKind: "write", lifecycleRunId: "writer-run", mechanism: "tmux-escape",
    });
    expect(terminal.interrupt).toHaveBeenCalledWith("%42");
    expect(terminal.kill).not.toHaveBeenCalled();
  });

  it("distinguishes missing, unsupported, and rejected writer interruption", async () => {
    const writer = member({ name: "writer", role: "write", lifecycleRunId: "writer-run", tmuxPaneId: "%42" });
    const readConfig = vi.spyOn(teams, "readConfig");
    const readRuntime = vi.spyOn(runtime, "readRuntimeStatus");
    const terminal = { interrupt: vi.fn(() => false), kill: vi.fn() };
    const interrupt = createInterrupt(undefined, terminal);

    readConfig.mockResolvedValueOnce(team([]));
    await expect(interrupt("missing")).resolves.toMatchObject({ status: "not_found" });

    readConfig.mockResolvedValueOnce(team([writer])).mockResolvedValueOnce(team([writer]));
    readRuntime.mockResolvedValueOnce(null);
    await expect(interrupt("writer")).resolves.toMatchObject({ status: "unsupported", reason: "missing-runtime-proof" });

    readConfig.mockResolvedValue(team([writer]));
    readRuntime.mockResolvedValue({
      teamName: "team", agentName: "writer", lifecycleRunId: "writer-run", ready: true,
      lastHeartbeatAt: Date.now(), currentAction: "working", activeToolName: "bash",
    });
    await expect(interrupt("writer")).resolves.toMatchObject({ status: "failed" });
    expect(terminal.kill).not.toHaveBeenCalled();
  });
});
