import { visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentFollowComponent, formatAgentFollowTranscript } from "./agent-follow-view";
import { formatAnimatedProgress } from "./renderers";
import type { RunningReadAgent } from "../runtime/types";

const ANSI_SGR_SEQUENCE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR_SEQUENCE, "");
}

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

    expect(stripAnsi(lines[0] || "")).toContain("read-safe next");
    expect(stripAnsi(lines[4] || "")).toContain("bash-safe next");
    expect(lines.join("\n")).not.toContain("\u001b[2J");
    expect(lines.join("\n")).not.toContain("\u001b]52");
  });

  it("renders user, exposed thinking, assistant text, and paired tool activity blocks", () => {
    const lines = formatAgentFollowTranscript([
      { role: "user", content: [{ type: "text", text: "Inspect the project" }] },
      { role: "assistant", content: [
        { type: "thinking", thinking: "I should inspect the files." },
        { type: "text", text: "I will inspect it." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
      ] },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "Line one\nLine two" }] },
    ]).join("\n");
    const plain = stripAnsi(lines);

    expect(plain).toContain("Inspect the project");
    expect(plain).toContain("I should inspect the files.");
    expect(plain).toContain("I will inspect it.");
    expect(plain).toContain("╭─ read · README.md");
    expect(plain).toContain("│ Line one\n│ Line two");
    expect(plain).toContain("╰─ 2 lines");
  });

  it("collapses large tool results with head and tail context and can expand them", () => {
    const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "rg TODO src" } }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: output },
    ];

    const collapsed = stripAnsi(formatAgentFollowTranscript(messages).join("\n"));
    expect(collapsed).toContain("╭─ bash · $ rg TODO src");
    expect(collapsed).toContain("9 lines hidden · press l to expand logs");
    expect(collapsed).not.toContain("│ line 10");
    expect(collapsed).toContain("│ line 20");
    expect(collapsed).toContain("collapsed");

    const expanded = stripAnsi(formatAgentFollowTranscript(messages, { expandLargeToolResults: true }).join("\n"));
    expect(expanded).toContain("│ line 10");
    expect(expanded).not.toContain("lines hidden");
    expect(expanded).not.toContain("collapsed");
  });

  it("renders report_progress calls as one ordinary neutral field", () => {
    const lines = formatAgentFollowTranscript([
      { role: "assistant", content: [
        { type: "toolCall", id: "progress-1", name: "report_progress", arguments: { status: "Checking the follow renderer" } },
      ] },
      {
        role: "toolResult",
        toolCallId: "progress-1",
        toolName: "report_progress",
        content: [{ type: "text", text: "Progress updated: Checking the follow renderer" }],
        details: { session: "team", status: "Checking the follow renderer", updatedAt: 1 },
        isError: false,
      },
    ], { width: 80 });
    const plain = lines.map(stripAnsi);

    expect(plain[0]).toBe("Checking the follow renderer");
    expect(plain.join("\n")).not.toContain("report_progress");
    expect(lines[0]).not.toContain("\x1b[");
    expect(lines.join("\n")).not.toContain("\x1b[48;2;31;33;47m");
  });

  it("renders successful and failed edits without source or result noise", () => {
    const successful = formatAgentFollowTranscript([
      { role: "assistant", content: [
        {
          type: "toolCall",
          id: "edit-1",
          name: "edit",
          arguments: { path: "src/app.ts", edits: [{ oldText: "private old source", newText: "private new source" }] },
        },
      ] },
      {
        role: "toolResult",
        toolCallId: "edit-1",
        toolName: "edit",
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/app.ts." }],
        details: { diff: "  1 context\n- 2 old line\n+ 2 new line\n+12 another line", firstChangedLine: 2 },
        isError: false,
      },
    ], { width: 100 });

    expect(successful.map(stripAnsi)).toEqual(["edit · src/app.ts · +2 −1 · worked"]);
    expect(successful.join("\n")).not.toContain("private old source");
    expect(successful.join("\n")).not.toContain("Successfully replaced");

    const failed = formatAgentFollowTranscript([
      { role: "assistant", content: [
        { type: "toolCall", id: "edit-2", name: "edit", arguments: { path: "src/missing.ts", edits: [{ oldText: "secret", newText: "replacement" }] } },
      ] },
      {
        role: "toolResult",
        toolCallId: "edit-2",
        toolName: "edit",
        content: [{ type: "text", text: "Could not find the exact text" }],
        isError: true,
      },
    ], { width: 100 });

    expect(failed.map(stripAnsi)).toEqual(["edit · src/missing.ts · failed"]);
    expect(failed.join("\n")).not.toContain("Could not find");
    expect(failed.join("\n")).not.toContain("secret");
  });

  it("compacts write and final-report tools that otherwise repeat large arguments", () => {
    const lines = formatAgentFollowTranscript([
      { role: "assistant", content: [
        { type: "toolCall", id: "write-1", name: "write", arguments: { path: "src/generated.ts", content: "large generated file contents" } },
        { type: "toolCall", id: "report-1", name: "report_and_exit", arguments: { content: "complete final report body", summary: "Done" } },
      ] },
      { role: "toolResult", toolCallId: "write-1", toolName: "write", content: "Wrote src/generated.ts", isError: false },
      {
        role: "toolResult",
        toolCallId: "report-1",
        toolName: "report_and_exit",
        content: "A final report was already accepted for this run.",
        details: { session: "team", accepted: false },
        isError: false,
      },
    ], { width: 100 });

    expect(lines.map(stripAnsi)).toEqual([
      "write · src/generated.ts · worked",
      "final report · duplicate",
    ]);
    expect(lines.join("\n")).not.toContain("large generated file contents");
    expect(lines.join("\n")).not.toContain("complete final report body");
  });

  it("uses semantic chrome colors while leaving prose and raw output neutral", () => {
    const lines = formatAgentFollowTranscript([
      { role: "assistant", content: [
        { type: "thinking", thinking: "Neutral thinking prose" },
        { type: "text", text: "Neutral assistant prose" },
        { type: "toolCall", id: "read-pending", name: "read", arguments: { path: "src/pending.ts" } },
        { type: "toolCall", id: "edit-success", name: "edit", arguments: { path: "src/worked.ts", edits: [] } },
        { type: "toolCall", id: "edit-failure", name: "edit", arguments: { path: "src/failed.ts", edits: [] } },
        { type: "toolCall", id: "bash-raw", name: "bash", arguments: { command: "printf output" } },
      ] },
      {
        role: "toolResult",
        toolCallId: "edit-success",
        toolName: "edit",
        content: "Successfully replaced source",
        details: { diff: "- 2 old\n+ 2 new\n+12 added" },
        isError: false,
      },
      { role: "toolResult", toolCallId: "edit-failure", toolName: "edit", content: "Edit failed", isError: true },
      { role: "toolResult", toolCallId: "bash-raw", toolName: "bash", content: "neutral shell output", isError: false },
    ], { width: 80 });

    const pendingHeader = lines.find((line) => stripAnsi(line).startsWith("╭─ read")) || "";
    const pendingState = lines.find((line) => stripAnsi(line).includes("waiting for result")) || "";
    const successfulEdit = lines.find((line) => stripAnsi(line).includes("src/worked.ts")) || "";
    const failedEdit = lines.find((line) => stripAnsi(line).includes("src/failed.ts")) || "";
    const rawOutput = lines.find((line) => stripAnsi(line) === "│ neutral shell output") || "";

    expect(pendingHeader).toContain("\x1b[38;5;117mread\x1b[39m");
    expect(pendingHeader).toContain("\x1b[38;5;213msrc/pending.ts\x1b[39m");
    expect(pendingState).toContain("\x1b[38;5;222mwaiting for result…\x1b[39m");
    expect(successfulEdit).toContain("\x1b[38;5;114m+2\x1b[39m");
    expect(successfulEdit).toContain("\x1b[38;5;210m−1\x1b[39m");
    expect(successfulEdit).toContain("\x1b[38;5;114mworked\x1b[39m");
    expect(failedEdit).toContain("\x1b[38;5;210mfailed\x1b[39m");
    expect(rawOutput).toBe("\x1b[38;5;141m│\x1b[39m neutral shell output");
    expect(lines).toContain("Neutral thinking prose");
    expect(lines).toContain("Neutral assistant prose");
  });

  it("keeps claim and release tools compact and semantically colored", () => {
    const lines = formatAgentFollowTranscript([
      { role: "assistant", content: [
        { type: "toolCall", id: "claim-1", name: "claim_file", arguments: { paths: ["src/a.ts", "src/b.ts"] } },
        { type: "toolCall", id: "release-1", name: "release_file", arguments: { paths: ["src/a.ts"] } },
      ] },
      {
        role: "toolResult",
        toolCallId: "claim-1",
        toolName: "claim_file",
        content: "Claimed 2 file(s)",
        details: { granted: ["src/a.ts", "src/b.ts"], conflicts: [] },
        isError: false,
      },
      {
        role: "toolResult",
        toolCallId: "release-1",
        toolName: "release_file",
        content: "Released 1 file claim(s)",
        details: { released: ["src/a.ts"] },
        isError: false,
      },
    ], { width: 80 });

    expect(lines.map(stripAnsi)).toEqual([
      "claim · src/a.ts, src/b.ts · worked",
      "release · src/a.ts · worked",
    ]);
    expect(lines[0]).toContain("\x1b[38;5;117mclaim\x1b[39m");
    expect(lines[0]).toContain("\x1b[38;5;213msrc/a.ts, src/b.ts\x1b[39m");
    expect(lines[1]).toContain("\x1b[38;5;114mworked\x1b[39m");
  });

  it.each([
    ["1,000-character", "x".repeat(1_000)],
    ["roughly 50 KiB", "x".repeat(50 * 1_024)],
  ])("bounds a %s single result line in collapsed and expanded modes", (_label, output) => {
    const width = 42;
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "long-result", name: "bash", arguments: { command: "printf output" } }] },
      { role: "toolResult", toolCallId: "long-result", toolName: "bash", content: output, isError: false },
    ];

    for (const expandLargeToolResults of [false, true]) {
      const lines = formatAgentFollowTranscript(messages, { expandLargeToolResults, width });
      const body = lines.find((line) => stripAnsi(line).startsWith("│ ")) || "";
      const wrapped = lines.flatMap((line) => wrapTextWithAnsi(line, width));

      expect(lines).toHaveLength(4);
      expect(wrapped).toHaveLength(4);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(visibleWidth(body)).toBe(width);
      expect(stripAnsi(body)).toMatch(/^│ x+…$/);
    }
  });

  it("truncates ANSI-colored long result lines without width or control-sequence leakage", () => {
    const width = 31;
    const output = `\x1b[31m${"彩".repeat(1_000)}\x1b[0m`;
    const lines = formatAgentFollowTranscript([
      { role: "assistant", content: [{ type: "toolCall", id: "ansi-result", name: "bash", arguments: { command: "printf color" } }] },
      { role: "toolResult", toolCallId: "ansi-result", toolName: "bash", content: output, isError: false },
    ], { width });
    const body = lines.find((line) => stripAnsi(line).startsWith("│ ")) || "";

    expect(visibleWidth(body)).toBeLessThanOrEqual(width);
    expect(wrapTextWithAnsi(body, width)).toHaveLength(1);
    expect(body).toContain("\x1b[31m");
    expect(body).toMatch(/\x1b\[0m…\x1b\[0m$/);
    expect(stripAnsi(body)).toContain("…");
    expect(stripAnsi(body)).not.toContain("\x1b");
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
    expect(stripAnsi(first)).not.toContain("progress:");
    expect(first).toContain("\x1b[48;2;22;23;32m");
    expect(first).not.toContain("\x1b[48;5;235m");

    tokens = 2_300_000;
    agent.latestProgress = "Writing final report";
    const updated = component.render(140).join("\n");
    expect(updated).toMatch(/2\.3M tok · Writing final report\.{1,3}/);
    expect(stripAnsi(updated)).not.toContain("progress:");

    component.handleInput("\x1b[A");
    expect(done).toHaveBeenCalledOnce();
    component.dispose();
  });

  it("uses the ordinary agent status when no stored progress is present", () => {
    const tui = { terminal: { rows: 20 }, requestRender: vi.fn() };
    const agent = makeAgent({ latestProgress: undefined, status: "working" });
    const component = createAgentFollowComponent(tui, vi.fn(), { getAgents: () => [agent] });

    const rendered = stripAnsi(component.render(80).join("\n"));
    expect(rendered).toContain("42 tok · working");
    expect(rendered).not.toContain("progress:");
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

  it("shows a direct-message input and sends to the selected agent", async () => {
    const tui = { terminal: { rows: 30 }, requestRender: vi.fn() };
    const sendMessage = vi.fn(async () => {});
    const component = createAgentFollowComponent(tui, vi.fn(), {
      getAgents: () => [makeAgent()],
      sendMessage,
    });

    expect(component.render(120).join("\n")).toContain("message reader");
    expect(component.render(120).join("\n")).toContain("Press m to start typing");

    component.focused = true;
    component.handleInput("m");
    expect(component.render(120).join("\n")).toContain("enter send · esc cancel");
    component.handleInput("Please inspect the failing test");
    component.handleInput("\r");
    await vi.advanceTimersByTimeAsync(1);

    expect(sendMessage).toHaveBeenCalledWith("reader", "Please inspect the failing test");
    expect(component.render(120).join("\n")).toContain("Message sent to reader.");
    expect(component.render(120).join("\n")).toContain("Press m to start typing");
    component.dispose();
  });

  it("keeps the message draft open when delivery fails", async () => {
    const tui = { terminal: { rows: 30 }, requestRender: vi.fn() };
    const component = createAgentFollowComponent(tui, vi.fn(), {
      getAgents: () => [makeAgent()],
      sendMessage: async () => { throw new Error("Cannot send message to reader: agent is not running."); },
    });

    component.handleInput("m");
    component.handleInput("Are you still there?");
    component.handleInput("\r");
    await vi.advanceTimersByTimeAsync(1);

    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Cannot send message to reader: agent is not running.");
    expect(rendered).toContain("Are you still there?");
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
