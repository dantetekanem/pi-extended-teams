import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentFollowComponent, formatAgentFollowTranscript } from "./agent-follow-view";
import { formatAnimatedProgress } from "./renderers";
import type { RunningReadAgent } from "../runtime/types";

function makeAgent(overrides: Partial<RunningReadAgent> = {}): RunningReadAgent {
  return {
    runId: "run-1",
    name: "reader",
    teamName: "team",
    startedAt: Date.now() - 60_000,
    tokensUsed: 42,
    status: "thinking",
    recentEvents: [],
    lastActivityAt: Date.now(),
    role: "read",
    model: "provider/gpt-model",
    thinking: "high",
    modelSlot: "reading-default",
    latestProgress: "Verifying assumptions",
    ...overrides,
  };
}

describe("animated agent progress", () => {
  it("cycles one, two, and three dots without accumulating punctuation", () => {
    expect(formatAnimatedProgress("Checking files...", 0)).toBe("Checking files.");
    expect(formatAnimatedProgress("Checking files...", 1_000)).toBe("Checking files..");
    expect(formatAnimatedProgress("Checking files...", 2_000)).toBe("Checking files...");
    expect(formatAnimatedProgress("Checking files...", 3_000)).toBe("Checking files.");
  });
});

describe("agent follow transcript", () => {
  it("sanitizes hostile control sequences and newlines from tool names", () => {
    const lines = formatAgentFollowTranscript([
      { role: "assistant", content: [
        { type: "toolCall", name: "read\u001b[2J-safe\nnext", arguments: {} },
      ] },
      { role: "toolResult", toolName: "bash\u001b]52;c;payload\u0007-safe\r\nnext", content: "ok" },
    ]);

    expect(lines[0]).toContain("tool read-safe next");
    expect(lines[3]).toContain("result bash-safe next");
    expect(lines.join("\n")).not.toContain("\u001b[2J");
    expect(lines.join("\n")).not.toContain("\u001b]52");
  });

  it("renders user, exposed thinking, assistant text, tool calls, and full tool results", () => {
    const lines = formatAgentFollowTranscript([
      { role: "user", content: [{ type: "text", text: "Inspect the project" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "I should inspect the files." },
        { type: "text", text: "I will inspect it." },
        { type: "toolCall", name: "read", arguments: { path: "README.md" } },
      ] },
      { role: "toolResult", toolName: "read", content: [{ type: "text", text: "Line one\nLine two" }] },
    ]).join("\n");

    expect(lines).toContain("Inspect the project");
    expect(lines).toContain("I should inspect the files.");
    expect(lines).toContain("I will inspect it.");
    expect(lines).toContain("tool read");
    expect(lines).toContain('"path": "README.md"');
    expect(lines).toContain("Line one\nLine two");
  });
});

describe("agent follow component", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("renders live agent state and returns to main with up", () => {
    let tokens = 42;
    const done = vi.fn();
    const tui = { terminal: { rows: 30 }, requestRender: vi.fn() };
    const agent = makeAgent({
      session: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "Working now" }] }],
        getSessionStats: () => ({ tokens: { total: tokens } }),
      } as any,
    });
    const component = createAgentFollowComponent(tui, done, { getAgents: () => [agent] });

    const first = component.render(140).join("\n");
    expect(first).toMatch(/\(reader\) gpt-model\/high · reading-default · 1m00s · 42 tok · Verifying assumptions\.{1,3}/);
    expect(first).toContain("Working now");
    expect(first).toContain("\x1b[48;2;22;23;32m");
    expect(first).not.toContain("\x1b[48;5;235m");

    tokens = 2_300_000;
    agent.latestProgress = "Writing final report";
    const updated = component.render(140).join("\n");
    expect(updated).toMatch(/2\.3M tok · Writing final report\.{1,3}/);

    component.handleInput("\x1b[A");
    expect(done).toHaveBeenCalledOnce();
    component.dispose();
  });

  it("stops the selected agent with x and keeps the live view open", () => {
    const tui = { terminal: { rows: 24 }, requestRender: vi.fn() };
    const agents = [makeAgent({ name: "alpha" }), makeAgent({ name: "beta" })];
    const stopAgent = vi.fn((name: string) => {
      const index = agents.findIndex(agent => agent.name === name);
      if (index >= 0) agents.splice(index, 1);
    });
    const component = createAgentFollowComponent(tui, vi.fn(), {
      getAgents: () => agents,
      initialAgentName: "beta",
      stopAgent,
    });

    expect(component.render(120).join("\n")).toContain("(beta)");
    component.handleInput("x");

    expect(stopAgent).toHaveBeenCalledWith("beta");
    expect(component.render(120).join("\n")).toContain("(alpha)");
    component.dispose();
  });

  it("navigates up to the previous agent before returning to main", () => {
    const done = vi.fn();
    const tui = { terminal: { rows: 24 }, requestRender: vi.fn() };
    const first = makeAgent({ name: "alpha" });
    const second = makeAgent({ name: "beta", modelSlot: "reading-hard" });
    const component = createAgentFollowComponent(tui, done, { getAgents: () => [first, second], initialAgentName: "alpha" });

    const initial = component.render(120).join("\n");
    expect(initial).toContain("↑  main agent");
    expect(initial).toContain("->");
    expect(initial).toContain("alpha");
    expect(initial).not.toContain("you are here");

    component.handleInput("\x1b[B");
    const next = component.render(120).join("\n");
    expect(next).toContain("->");
    expect(next).toContain("beta");
    expect(next).toContain("(beta)");

    component.handleInput("\x1b[A");
    expect(component.render(120).join("\n")).toContain("(alpha)");
    expect(done).not.toHaveBeenCalled();

    component.handleInput("\x1b[A");
    expect(done).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(250);
    expect(tui.requestRender).toHaveBeenCalled();
    component.dispose();
  });
});
