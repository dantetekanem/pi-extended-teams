import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "../utils/paths";
import * as messaging from "../utils/messaging";
import { appendTeamReportEvent, readStoredTeamReportEvent } from "../utils/report-events";
import { createReportResult, type ReportedTaskDetails } from "./report-result";
import { CompletionGroup } from "./completion-group";
import { deliverCompletionGroupReport, enqueueCompletionGroupDeliveries } from "./completion-group-delivery";

let root: string;
let group: CompletionGroup;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-group-delivery-"));
  vi.spyOn(paths, "teamDir").mockImplementation(team => path.join(root, team));
  vi.spyOn(paths, "reportFilesDir").mockReturnValue(path.join(root, "reports"));
  vi.spyOn(paths, "inboxPath").mockImplementation((team, name) => path.join(root, team, "inboxes", `${name}.json`));
  const created = await CompletionGroup.create({ teamName: "team", sessionId: "session", submissionId: "batch",
    policy: { delivery: "all-settled" }, members: [{ name: "one" }, { name: "two" }] });
  if (!created) throw new Error("Expected a group");
  group = created;
  await group.seal();
  for (let index = 0; index < 2; index++) await group.apply({ type: "running", ...group.binding(index), runId: `run-${index}` });
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

async function report(index: number, details: ReportedTaskDetails = { outcome: "succeeded" }, status: "completed" | "failed" = "completed") {
  const name = group.read().members[index].name;
  return appendTeamReportEvent("team", { agentName: name, source: "read-agent", status,
    completionGroup: group.binding(index), summary: `${name} findings`, report: `Complete independent report for ${name}.\n${"Evidence\n".repeat(200)}`,
    result: createReportResult("team", name, `run-${index}`, details) });
}
async function indexes() {
  return (await messaging.readInbox("team", "team-lead", false, false)).map(message => ({ message, index: JSON.parse(message.text) }));
}

describe("completion-group delivery", () => {
  it("queues one index with findings and full report references after all members report", async () => {
    const first = await report(0, { outcome: "succeeded", findings: [{ id: "F1", text: "Important finding", evidence: ["input.ts:4"] }] });
    await deliverCompletionGroupReport(first);
    expect(await indexes()).toEqual([]);
    const second = await report(1);
    await deliverCompletionGroupReport(second);
    const [delivery] = await indexes();
    expect(delivery.index).toMatchObject({ groupId: group.groupId, kind: "settled", members: [
      { name: "one", taskId: first.result!.taskId, runId: "run-0", outcome: "succeeded", verification: { state: "not-requested" }, acceptance: { state: "pending" },
        findings: [{ id: "F1", text: "Important finding", evidence: ["input.ts:4"] }], report: { id: first.id, path: first.reportPath } },
      { name: "two", report: { id: second.id, path: second.reportPath } },
    ] });
    expect(delivery.message.operationId).toBe(group.read().deliveries[0].id);
    expect(group.read().deliveries[0].status).toBe("enqueued");
    expect(fs.readFileSync(first.reportPath!, "utf8")).toBe(first.report);
    expect((await readStoredTeamReportEvent("team", second.id))?.report).toBe(second.report);
  });

  it("retries failed index enqueue without duplicating the independently stored reports or notification", async () => {
    const first = await report(0, { outcome: "blocked" });
    vi.spyOn(messaging, "sendPlainMessageOnce").mockRejectedValueOnce(new Error("inbox unavailable"));
    await expect(deliverCompletionGroupReport(first)).rejects.toThrow("inbox unavailable");
    expect(group.read().members[0].status).toBe("reported");
    expect((await readStoredTeamReportEvent("team", first.id))?.report).toBe(first.report);
    await Promise.all([deliverCompletionGroupReport(first), deliverCompletionGroupReport(first)]);
    expect(await indexes()).toHaveLength(1);
    expect(await group.prepareDeliveries()).toEqual([]);
  });

  it("recovers a persisted inbox message after its group receipt fails", async () => {
    const first = await report(0, { outcome: "blocked" });
    vi.spyOn(CompletionGroup.prototype, "markEnqueued").mockRejectedValueOnce(new Error("receipt unavailable"));
    await expect(deliverCompletionGroupReport(first)).rejects.toThrow("receipt unavailable");
    expect(await indexes()).toHaveLength(1);
    await deliverCompletionGroupReport(first);
    expect(await indexes()).toHaveLength(1);
    expect(await group.prepareDeliveries()).toEqual([]);
  });

  it("queues an urgent index for native failure without rewriting a reported success", async () => {
    const failed = await report(0, { outcome: "succeeded" }, "failed");
    await deliverCompletionGroupReport(failed);
    const [delivery] = await indexes();
    expect(delivery.index).toMatchObject({ kind: "urgent", members: [{ outcome: "succeeded", runtimeStatus: "failed" }] });
    expect((await readStoredTeamReportEvent("team", failed.id))?.result?.outcome).toBe("succeeded");
  });

  it("does not grant group authority to opaque report metadata", async () => {
    const ordinary = await appendTeamReportEvent("team", { agentName: "ordinary", source: "read-agent", status: "completed",
      report: "Ordinary report", metadata: { completionGroup: group.binding(0) } });
    expect(await deliverCompletionGroupReport(ordinary)).toBe(false);
    expect(group.read().members[0].status).toBe("running");
    expect(await indexes()).toEqual([]);
    expect((await readStoredTeamReportEvent("team", ordinary.id))?.metadata).toEqual(ordinary.metadata);
  });

  it("rejects unstored or missing full reports before enqueuing an index", async () => {
    const stored = await report(0, { outcome: "blocked" });
    await expect(deliverCompletionGroupReport({ ...stored, id: "not-stored" })).rejects.toThrow(/report|binding/i);
    fs.unlinkSync(stored.reportPath!);
    await expect(deliverCompletionGroupReport(stored)).rejects.toThrow();
    expect(await indexes()).toEqual([]);
  });

  it("delivers rejected queue outcomes without fabricating an agent report", async () => {
    const created = await CompletionGroup.create({ teamName: "team", sessionId: "session", submissionId: "rejected",
      policy: { delivery: "all-settled" }, members: [{ name: "never-started" }] });
    if (!created) throw new Error("Expected a group");
    await created.apply({ type: "rejected", ...created.binding(0), reason: "No capacity" });
    await created.seal();
    await enqueueCompletionGroupDeliveries(created);
    const [delivery] = await indexes();
    expect(delivery.index.members).toEqual([{ name: "never-started", slotId: created.binding(0).slotId, status: "rejected", reason: "No capacity" }]);
  });
});
