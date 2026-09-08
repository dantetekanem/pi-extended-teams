import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "../utils/paths";
import * as reports from "../utils/report-events";
import type { Member, TeamReportEvent } from "../utils/models";
import * as source from "./source-identity";
import * as durable from "./durable-json";
import { createReportResult, type ReportedTaskDetails } from "./report-result";
import { checkpointId, checkpointPath, readCheckpoint, retireCheckpoint } from "./specialist-checkpoint";
import { checkpointReference, saveReportCheckpoint, resyncReportCheckpoint } from "./checkpoint-report";

let root: string;
let member: Member;
const identity = (fingerprint = "a".repeat(64)): source.SourceIdentity => ({ version: 1, cwd: root, repositoryRoot: root,
  head: null, inputs: ["src"], fileCount: 1, fingerprint });
async function report(current = member, extraFindings: NonNullable<ReportedTaskDetails["findings"]> = []): Promise<TeamReportEvent> {
  return reports.appendTeamReportEvent("team", { agentName: current.name, status: "completed", source: "read-agent", modelSlot: current.modelSlot,
    report: "Complete authentication findings.", checkpoint: checkpointReference("team", current),
    result: createReportResult("team", current.name, current.lifecycleRunId!, { outcome: "succeeded",
      findings: [{ id: "F1", text: "Missing tenant check", evidence: ["src/auth.ts:4"] }, ...extraFindings], inspectedEvidence: ["src/auth.ts:1-30"], questions: ["Which tenant owns this token?"] }) });
}

describe("report checkpoint publication", () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-report-")));
    vi.spyOn(paths, "teamDir").mockReturnValue(path.join(root, "team"));
    vi.spyOn(paths, "reportFilesDir").mockReturnValue(path.join(root, "reports"));
    vi.spyOn(paths, "checkpointFilesDir").mockReturnValue(path.join(root, "checkpoints"));
    vi.spyOn(source, "captureSourceIdentity").mockResolvedValue(identity("b".repeat(64)));
    member = { name: "reviewer", agentId: "reviewer@team", agentType: "teammate", role: "read", modelSlot: "read-review",
      lifecycleRunId: "run-1", joinedAt: 1, tmuxPaneId: "", cwd: root, subscriptions: [], prompt: "Review authentication",
      checkpointAssignment: { originalPrompt: "Review authentication", policy: { inputs: ["src"], retentionDays: 30, decisions: ["Deny anonymous requests"] }, sourceBefore: identity() } };
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it("publishes a bound checkpoint only after synchronizing the complete report", async () => {
    const event = await report();
    const sync = reports.resyncStoredTeamReportEvent;
    const order: string[] = [];
    vi.spyOn(reports, "resyncStoredTeamReportEvent").mockImplementation(async (...args) => { const stored = await sync(...args); order.push("report"); return stored; });
    const write = durable.writeJsonDurably;
    vi.spyOn(durable, "writeJsonDurably").mockImplementation((file, value) => { if (file === checkpointPath(event.checkpoint!.id)) order.push("checkpoint"); write(file, value); });
    const saved = await saveReportCheckpoint("team", member, event);
    expect(order).toEqual(["report", "checkpoint"]);
    expect(saved).toMatchObject({ author: { teamName: "team", agentName: "reviewer", runId: "run-1", modelSlot: "read-review" },
      assignment: { original: member.prompt, current: member.prompt }, findings: [{ id: "F1", reportId: event.id }],
      inspectedEvidence: [{ reference: "src/auth.ts:1-30", reportId: event.id }], questions: ["Which tenant owns this token?"],
      reports: [{ id: event.id, path: event.reportPath, source: { before: identity(), after: identity("b".repeat(64)) },
        verification: "not-requested", acceptance: "pending", leadDecisions: ["Deny anonymous requests"] }] });
    expect(event.result?.checkpointId).toBe(saved?.id);
    expect(fs.readFileSync(event.reportPath!, "utf8")).toBe(event.report);
  });

  it("does no checkpoint work for ordinary reports or metadata claims", async () => {
    member.checkpointAssignment = undefined;
    member.metadata = { checkpointAssignment: { policy: { inputs: ["src"] } } };
    const event = await report();
    expect(await saveReportCheckpoint("team", member, event)).toBeUndefined();
    expect(await resyncReportCheckpoint(event)).toBeUndefined();
    expect(source.captureSourceIdentity).not.toHaveBeenCalled();
    expect(fs.existsSync(paths.checkpointFilesDir())).toBe(false);
  });

  it.each(["run", "missing-reference", "result"])("rejects %s provenance without capturing source", async fault => {
    const event = await report();
    if (fault === "run") member.lifecycleRunId = "other-run";
    else if (fault === "result") delete event.result;
    else delete event.checkpoint;
    await expect(saveReportCheckpoint("team", member, event)).rejects.toThrow(/checkpoint.*binding|checkpoint.*provenance/i);
    expect(source.captureSourceIdentity).not.toHaveBeenCalled();
  });

  it.each(["failed", "cancelled", "late-abort"])("retains the complete report when source capture is %s", async mode => {
    const event = await report();
    const cancellation = new AbortController();
    const error = new Error("source unavailable");
    if (mode === "cancelled") cancellation.abort(error);
    vi.mocked(source.captureSourceIdentity).mockImplementation(async () => {
      if (mode === "late-abort") { cancellation.abort(error); return identity(); }
      throw error;
    });
    await expect(saveReportCheckpoint("team", member, event, cancellation.signal)).rejects.toThrow("source unavailable");
    if (mode === "cancelled") expect(source.captureSourceIdentity).not.toHaveBeenCalled();
    expect(fs.readFileSync(event.reportPath!, "utf8")).toBe(event.report);
    await expect(resyncReportCheckpoint((await reports.readStoredTeamReportEvent("team", event.id))!)).rejects.toThrow(/checkpoint/i);
  });

  it("keeps the prepared snapshot immutable after uncertain checkpoint sync and later lead acceptance", async () => {
    const event = await report();
    const sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { if (fs.existsSync(checkpointPath(event.checkpoint!.id)) && fs.fstatSync(fd).isDirectory()) throw new Error("checkpoint receipt uncertain"); sync(fd); });
    await expect(saveReportCheckpoint("team", member, event)).rejects.toThrow("checkpoint receipt uncertain");
    expect(fs.existsSync(checkpointPath(event.checkpoint!.id))).toBe(true);
    vi.mocked(fs.fsyncSync).mockImplementation(sync);
    await reports.recordReportAcceptance("team", event.id, "accepted");
    vi.mocked(source.captureSourceIdentity).mockRejectedValue(new Error("must not recapture"));
    const saved = await saveReportCheckpoint("team", member, event);
    expect(saved?.state).toBe("ready");
    expect(readCheckpoint(saved!.id).reports[0].acceptance).toBe("pending");
    expect(source.captureSourceIdentity).toHaveBeenCalledOnce();
  });

  it("replays a prepared report snapshot after checkpoint creation failed before writing", async () => {
    const event = await report();
    const write = durable.writeJsonDurably;
    vi.spyOn(durable, "writeJsonDurably").mockImplementation((file, value) => { if (file === checkpointPath(event.checkpoint!.id)) throw new Error("checkpoint storage unavailable"); write(file, value); });
    await expect(saveReportCheckpoint("team", member, event)).rejects.toThrow("checkpoint storage unavailable");
    const stored = (await reports.readStoredTeamReportEvent("team", event.id))!;
    expect(stored.checkpoint?.draft).toBeDefined();
    vi.mocked(durable.writeJsonDurably).mockImplementation(write);
    vi.mocked(source.captureSourceIdentity).mockRejectedValue(new Error("must not recapture"));
    expect((await resyncReportCheckpoint(stored))?.state).toBe("ready");
    expect(source.captureSourceIdentity).toHaveBeenCalledOnce();
  });

  it("does not acknowledge an unavailable full report or regenerate a deleted checkpoint", async () => {
    const event = await report();
    await saveReportCheckpoint("team", member, event);
    await retireCheckpoint(event.checkpoint!.id, "deleted");
    vi.mocked(source.captureSourceIdentity).mockRejectedValue(new Error("must not recapture"));
    expect((await saveReportCheckpoint("team", member, event))?.state).toBe("deleted");
    fs.unlinkSync(event.reportPath!);
    await expect(saveReportCheckpoint("team", member, event)).rejects.toThrow();
    expect(source.captureSourceIdentity).toHaveBeenCalledOnce();
  });

  it("retains the original dependency provenance when bounded history rolls forward", async () => {
    const original = await report();
    await saveReportCheckpoint("team", member, original);
    const parent = readCheckpoint(original.checkpoint!.id);
    parent.reports.push(...Array.from({ length: 15 }, (_, index) => ({ ...structuredClone(parent.reports[0]), id: `report:team:reviewer:history-${index}` })));
    parent.author.runId = "history-14"; parent.id = checkpointId(parent.author); parent.reportId = parent.reports.at(-1)!.id;
    member.lifecycleRunId = "continued-run";
    member.checkpointAssignment = { ...member.checkpointAssignment!, parent };
    const current = await report();
    await saveReportCheckpoint("team", member, current);
    const saved = readCheckpoint(current.checkpoint!.id);
    expect(saved.reports).toHaveLength(16);
    expect(saved.reports[0]).toEqual(parent.reports[0]);
    expect(saved.reports.at(-1)?.id).toBe(current.id);
  });

  it("retains historical evidence and lead decisions while binding new claims to their new report", async () => {
    const previous = await report(member, [{ id: "F2", text: "Earlier invariant", evidence: ["src/auth.ts:20"] }]);
    await saveReportCheckpoint("team", member, previous);
    const parent = readCheckpoint(previous.checkpoint!.id);
    member.lifecycleRunId = "run-2";
    member.prompt = "Recheck the fixes";
    member.checkpointAssignment = { originalPrompt: parent.assignment.original, policy: { ...parent.policy, decisions: ["Preserve tenant isolation"] }, sourceBefore: identity("b".repeat(64)), parent };
    const current = await report();
    await saveReportCheckpoint("team", member, current);
    const saved = readCheckpoint(current.checkpoint!.id);
    expect(saved.parentId).toBe(parent.id);
    expect(saved.findings).toEqual([expect.objectContaining({ id: "F1", reportId: current.id }), expect.objectContaining({ id: "F2", reportId: previous.id })]);
    expect(saved.reports[0].source).toEqual(parent.reports[0].source);
    expect(saved.reports.map(item => item.leadDecisions)).toEqual([["Deny anonymous requests"], ["Preserve tenant isolation"]]);
    const transcript = path.join(root, "private-session.jsonl");
    fs.writeFileSync(transcript, "disposable session"); fs.unlinkSync(transcript);
    expect(readCheckpoint(saved.id)).toEqual(saved);
  });
});
