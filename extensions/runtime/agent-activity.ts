/** Actual work evidence, separate from a runtime's periodic liveness heartbeat. */
export interface AgentActivity {
  lastActivityAt?: number;
  activeWork?: Set<string>;
}

const workStarts: Record<string, string> = {
  compaction_start: "compaction", auto_compaction_start: "compaction", session_before_compact: "compaction",
  auto_retry_start: "retry", ui_prompt_start: "user-prompt",
};
const workEnds: Record<string, string> = {
  compaction_end: "compaction", auto_compaction_end: "compaction", session_compact: "compaction",
  session_compact_failed: "compaction", auto_retry_end: "retry", ui_prompt_end: "user-prompt",
};

export function recordAgentActivity(
  state: AgentActivity,
  event: { type: string; toolCallId?: string; toolName?: string; assistantMessageEvent?: unknown },
  now = Date.now(),
): void {
  state.lastActivityAt = now;
  const work = state.activeWork ??= new Set();
  if (event.type === "tool_execution_start") work.add(`tool:${event.toolCallId ?? event.toolName}`);
  if (event.type === "tool_execution_end") work.delete(`tool:${event.toolCallId ?? event.toolName}`);
  if (workStarts[event.type]) work.add(workStarts[event.type]);
  if (workEnds[event.type]) work.delete(workEnds[event.type]);
}
