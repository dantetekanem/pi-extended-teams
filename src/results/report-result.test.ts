import { describe, expect, it } from "vitest";
import { createReportResult, effectiveTaskOutcome, normalizeReportedTaskDetails } from "./report-result";

describe("structured task results", () => {
  it("keeps a reported blocker separate from verification and lead acceptance", () => {
    const details = normalizeReportedTaskDetails({
      outcome: "blocked",
      changedPaths: ["src/config.ts"],
      artifacts: [{ path: "notes/findings.md", label: "Investigation" }],
      findings: [{ id: "F1", text: "The required credential is unavailable", evidence: ["src/config.ts:12"] }],
      questions: ["Which credential should this use?"],
    });
    expect(createReportResult("team", "reader", "run-1", details)).toEqual({
      version: 1,
      taskId: "task:team:reader:run-1",
      runId: "run-1",
      reportId: "report:team:reader:run-1",
      ...details,
      verification: { state: "not-requested" },
      acceptance: { state: "pending" },
    });
  });

  it("does not infer a task outcome from a plain report or accept claimed verification", () => {
    const details = normalizeReportedTaskDetails({
      content: "All checks passed.", verification: { state: "passed" }, acceptance: { state: "accepted" },
      repair: { state: "repaired", maxAttempts: 5, attemptsUsed: 0 },
      taskId: "another-task", runId: "another-run", reportId: "another-report",
    });
    const result = createReportResult("team", "reader", "actual-run", details);
    expect(result.outcome).toBeUndefined();
    expect(result.repair).toBeUndefined();
    expect(result).toMatchObject({
      taskId: "task:team:reader:actual-run", runId: "actual-run", reportId: "report:team:reader:actual-run",
      verification: { state: "not-requested" }, acceptance: { state: "pending" },
    });
  });

  it.each(["pending", "exhausted", "declined", "cancelled", "blocked"] as const)("projects %s repair as an effective blocker without replacing the claim", state => {
    const result = createReportResult("team", "reader", "run", { outcome: "succeeded" });
    result.repair = { controllerId: "controller", state, attemptsUsed: 1, maxAttempts: 1, requestIds: ["request"], outcome: "blocked" };
    expect(effectiveTaskOutcome(result)).toBe("blocked");
    expect(result.outcome).toBe("succeeded");
    expect(result.acceptance.state).toBe("pending");
  });

  it.each([undefined, "blocked", "failed", "cancelled", "succeeded"] as const)("never infers success from passed repair for claim %s", outcome => {
    const result = createReportResult("team", "reader", "run", { outcome });
    expect(effectiveTaskOutcome(result)).toBe(outcome);
    result.verification.state = "passed";
    result.repair = { controllerId: "controller", state: "repaired", attemptsUsed: 1, maxAttempts: 1, requestIds: ["request"] };
    expect(effectiveTaskOutcome(result)).toBe(outcome);
    expect(result.acceptance.state).toBe("pending");
  });

  it("keeps identities stable for replay and distinct for replacement runs", () => {
    const first = createReportResult("team", "reader", "run-1", {});
    expect(createReportResult("team", "reader", "run-1", {})).toEqual(first);
    expect(createReportResult("team", "reader", "run-2", {}).reportId).not.toBe(first.reportId);
    expect(createReportResult("a:b", "c", "run", {}).reportId)
      .not.toBe(createReportResult("a", "b:c", "run", {}).reportId);
  });

  it.each([
    { outcome: "completed" },
    { changedPaths: [42] },
    { findings: [{ id: "F1", text: "Missing evidence" }] },
    { findings: [{ id: "F1", text: "first", evidence: [] }, { id: "F1", text: "second", evidence: [] }] },
  ])("rejects malformed or ambiguous reported details: %j", details => {
    expect(() => normalizeReportedTaskDetails(details)).toThrow(/report|finding/i);
  });

  it("isolates accepted evidence from later caller mutation", () => {
    const input = { findings: [{ id: "F1", text: "Original", evidence: ["file.ts:1"] }] };
    const details = normalizeReportedTaskDetails(input);
    const result = createReportResult("team", "reader", "run-1", details);
    input.findings[0].evidence.push("injected");
    details.findings![0].text = "changed after acceptance";
    expect(result.findings).toEqual([{ id: "F1", text: "Original", evidence: ["file.ts:1"] }]);
  });
});
