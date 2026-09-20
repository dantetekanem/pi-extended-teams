import { describe, expect, it } from "vitest";
import { recordAgentActivity, type AgentActivity } from "./agent-activity";

describe("agent activity evidence", () => {
  it.each(["text_delta", "thinking_delta", "toolcall_delta"])("counts streamed %s without relying on final token totals", type => {
    const state: AgentActivity = {};
    recordAgentActivity(state, { type: "message_update", assistantMessageEvent: { type, delta: "x" } }, 123);
    expect(state.lastActivityAt).toBe(123);
  });

  it("keeps parallel tools busy until the last exact call ends", () => {
    const state: AgentActivity = {};
    recordAgentActivity(state, { type: "tool_execution_start", toolCallId: "a" }, 1);
    recordAgentActivity(state, { type: "tool_execution_start", toolCallId: "b" }, 2);
    recordAgentActivity(state, { type: "tool_execution_end", toolCallId: "a" }, 3);
    expect(state.activeWork?.size).toBe(1);
    recordAgentActivity(state, { type: "tool_execution_update", toolCallId: "b" }, 4);
    expect(state.lastActivityAt).toBe(4);
    recordAgentActivity(state, { type: "tool_execution_end", toolCallId: "b" }, 5);
    expect(state.activeWork?.size).toBe(0);
    expect(state.lastActivityAt).toBe(5);
  });

  it.each([
    ["compaction_start", "compaction_end"],
    ["auto_retry_start", "auto_retry_end"],
    ["session_before_compact", "session_compact_failed"],
    ["ui_prompt_start", "ui_prompt_end"],
  ])("protects %s until %s", (start, end) => {
    const state: AgentActivity = {};
    recordAgentActivity(state, { type: start }, 1);
    expect(state.activeWork?.size).toBe(1);
    recordAgentActivity(state, { type: end }, 20);
    expect(state.activeWork?.size).toBe(0);
    expect(state.lastActivityAt).toBe(20);
  });
});
