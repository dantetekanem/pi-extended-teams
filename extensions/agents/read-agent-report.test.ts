import { describe, expect, it } from "vitest";
import { resolveReadAgentReport } from "./read-agent-report";

const submission = {
  content: "Waiting for product input", summary: "Decision needed", outcome: "blocked" as const,
  findings: [{ id: "F1", text: "Missing API choice", evidence: ["api.ts:1"] }],
};

function acceptedMessages(arguments_: Record<string, unknown>) {
  return [
    { role: "assistant", content: [{ type: "toolCall", name: "report_and_exit", id: "report-1", arguments: arguments_ }] },
    { role: "toolResult", toolName: "report_and_exit", toolCallId: "report-1", details: { accepted: true } },
  ];
}

describe("structured final report recovery", () => {
  it.each(["direct", "immediate", "persisted"])("retains accepted %s task details", source => {
    const messages = acceptedMessages(submission);
    const result = resolveReadAgentReport(
      source === "direct" ? submission : undefined,
      source === "immediate" ? messages : [],
      source === "persisted" ? messages : [],
    );
    expect(result).toMatchObject({
      report: submission.content, summary: submission.summary, outcome: "blocked", findings: submission.findings,
      source: source === "persisted" ? "persisted-report_and_exit" : "report_and_exit",
    });
  });

  it("retains legacy accepted text without treating unknown extra fields as task success", () => {
    const result = resolveReadAgentReport(undefined, [], acceptedMessages({ content: "Legacy report", outcome: "completed" }));
    expect(result).toEqual({ report: "Legacy report", summary: undefined, source: "persisted-report_and_exit" });
  });
});
