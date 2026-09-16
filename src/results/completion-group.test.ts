import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../utils/paths";
import { createReportResult, type TaskOutcome } from "./report-result";
import { CompletionGroup, type CompletionGroupOptions } from "./completion-group";

let root: string;
let options: CompletionGroupOptions;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-completion-group-"));
  vi.spyOn(paths, "teamDir").mockReturnValue(path.join(root, "private"));
  options = { teamName: "team", sessionId: "session", submissionId: "tool-call",
    policy: { delivery: "all-settled" }, members: [{ name: "one" }, { name: "two" }] };
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

async function group(overrides: Partial<CompletionGroupOptions> = {}) {
  const created = await CompletionGroup.create({ ...options, ...overrides });
  if (!created) throw new Error("Expected an opted-in group");
  return created;
}
function report(g: CompletionGroup, index: number, outcome: TaskOutcome = "succeeded") {
  const member = g.read().members[index];
  const result = createReportResult("team", member.name, `run-${index}`, { outcome });
  return { type: "reported" as const, slotId: member.slotId,
    report: { runId: result.runId, reportId: result.reportId, outcome, verification: "not-requested" as const } };
}
async function start(g: CompletionGroup, index: number) {
  await g.apply({ type: "running", ...g.binding(index), runId: `run-${index}` });
}

describe("durable completion groups", () => {
  it("leaves ordinary report delivery without group storage", async () => {
    expect(await CompletionGroup.create({ ...options, policy: undefined })).toBeUndefined();
    expect(fs.existsSync(path.join(root, "private"))).toBe(false);
  });

  it.each([null, {}, { delivery: "later" }, { delivery: "immediate", extra: true }])("rejects invalid policy %j before storage", async policy => {
    await expect(CompletionGroup.create({ ...options, policy } as CompletionGroupOptions)).rejects.toThrow(/policy/i);
    expect(fs.existsSync(path.join(root, "private"))).toBe(false);
  });

  it("waits for all ten accepted members and creates one ordinary decision", async () => {
    const g = await group({ members: Array.from({ length: 10 }, (_, index) => ({ name: `reader-${index}` })) });
    await g.seal();
    for (let index = 0; index < 10; index++) {
      await start(g, index);
      await g.apply(report(g, index));
      expect((await g.prepareDeliveries()).length).toBe(index === 9 ? 1 : 0);
    }
    expect(g.read().deliveries).toMatchObject([{ kind: "settled", status: "pending", slotIds: g.read().members.map(m => m.slotId) }]);
  });

  it("retains rejected, cancelled and interrupted slots while queued work remains outstanding", async () => {
    const g = await group({ members: Array.from({ length: 10 }, (_, index) => ({ name: `reader-${index}` })) });
    await g.apply({ type: "rejected", ...g.binding(0), reason: "capacity disabled" });
    await g.apply({ type: "queued", ...g.binding(1), queueId: "queue-1" });
    await g.apply({ type: "cancelled", ...g.binding(1), reason: "user cancelled" });
    await start(g, 2);
    await g.apply({ type: "interrupted", ...g.binding(2), runId: "run-2", reason: "session ended" });
    await start(g, 3);
    await g.apply(report(g, 3));
    await g.apply({ type: "queued", ...g.binding(4), queueId: "queue-4" });
    for (let index = 5; index < 10; index++) {
      await start(g, index);
      await g.apply(report(g, index, index === 5 ? "failed" : "succeeded"));
    }
    await g.seal();
    const early = await g.prepareDeliveries();
    expect(early).toMatchObject([{ kind: "urgent", slotIds: [g.binding(0).slotId] }, { kind: "urgent", slotIds: [g.binding(5).slotId] }]);
    for (const delivery of early) await g.markEnqueued(delivery.id);
    await start(g, 4);
    await g.apply(report(g, 4));
    expect(g.read().members.map(m => m.status)).toEqual(["rejected", "cancelled", "interrupted", ...Array(7).fill("reported")]);
    expect((await g.prepareDeliveries())[0]).toMatchObject({ kind: "settled" });
    expect((await g.prepareDeliveries())[0].slotIds).toHaveLength(10);
  });

  it("requests an early blocker once and folds a last failure into the final index", async () => {
    const g = await group();
    await g.seal();
    await start(g, 0);
    const blocked = report(g, 0, "blocked");
    await Promise.all([g.apply(blocked), g.apply(blocked)]);
    const [urgent] = await g.prepareDeliveries();
    expect(urgent).toMatchObject({ kind: "urgent", slotIds: [g.binding(0).slotId] });
    await g.markEnqueued(urgent.id);
    await start(g, 1);
    await g.apply(report(g, 1, "failed"));
    expect(g.read().deliveries.map(d => d.kind)).toEqual(["urgent", "settled"]);
    expect(g.read().members.map(m => m.report?.outcome)).toEqual(["blocked", "failed"]);
  });

  it("does not send an extra final decision when every visible result was already urgent", async () => {
    const g = await group({ members: [{ name: "one" }] });
    await start(g, 0);
    await g.apply(report(g, 0, "blocked"));
    await g.seal();
    expect(g.read().deliveries.map(d => d.kind)).toEqual(["urgent"]);
  });

  it.each(["failed", "stale"] as const)("keeps reported success separate from effective blockers and %s verification", async verification => {
    const g = await group();
    await start(g, 0);
    const success = report(g, 0);
    await g.apply({ ...success, report: { ...success.report, effectiveOutcome: "blocked" } });
    await start(g, 1);
    const failedCheck = report(g, 1);
    await g.apply({ ...failedCheck, report: { ...failedCheck.report, verification } });
    expect(g.read().deliveries.map(d => d.kind)).toEqual(["urgent", "urgent"]);
    expect(g.read().members.map(m => m.report?.outcome)).toEqual(["succeeded", "succeeded"]);
  });

  it("supports explicit immediate compact decisions without a duplicate final index", async () => {
    const g = await group({ policy: { delivery: "immediate" } });
    await start(g, 0);
    await g.apply(report(g, 0));
    await start(g, 1);
    await g.apply(report(g, 1));
    await g.seal();
    expect(g.read().deliveries.map(d => d.kind)).toEqual(["member", "member"]);
  });

  it("records suppressed results but never includes them in lead delivery decisions", async () => {
    const g = await group({ members: [{ name: "one", suppressed: true }, { name: "two" }] });
    await g.seal();
    await start(g, 0);
    await g.apply(report(g, 0, "blocked"));
    expect(await g.prepareDeliveries()).toEqual([]);
    await start(g, 1);
    await g.apply(report(g, 1));
    expect((await g.prepareDeliveries())[0].slotIds).toEqual([g.binding(1).slotId]);
  });

  it("settles an entirely suppressed batch without requesting lead delivery", async () => {
    const g = await group({ members: [{ name: "one", suppressed: true }] });
    await start(g, 0);
    await g.apply(report(g, 0, "failed"));
    await g.seal();
    expect(g.read()).toMatchObject({ sealed: true, members: [{ status: "reported" }] });
    expect(await g.prepareDeliveries()).toEqual([]);
  });

  it("reserves one wake only after durable enqueue and retains ambiguous failures", async () => {
    const g = await group();
    await start(g, 0);
    await g.apply(report(g, 0, "blocked"));
    const [delivery] = await g.prepareDeliveries();
    await expect(g.reserveWake(delivery.id)).rejects.toThrow(/enqueue/i);
    await g.markEnqueued(delivery.id);
    expect((await Promise.all([g.reserveWake(delivery.id), g.reserveWake(delivery.id)])).sort()).toEqual([false, true]);
    await g.recordWakeEvidence(delivery.id, { error: "Wake unconfirmed" });
    const restored = await group();
    expect(await restored.reserveWake(delivery.id)).toBe(false);
    expect(restored.read().deliveries[0].wake).toMatchObject({ state: "pending", error: "Wake unconfirmed" });
    await restored.recordWakeEvidence(delivery.id, { entryId: "session-entry" });
    expect(restored.read().deliveries[0].wake).toMatchObject({ state: "observed", entryId: "session-entry" });
    await expect(restored.recordWakeEvidence(delivery.id, { entryId: "different-entry" })).rejects.toThrow(/binding/i);
  });

  it("does not authorize a wake after uncertain reservation publication", async () => {
    const g = await group();
    await start(g, 0);
    await g.apply(report(g, 0, "blocked"));
    const [delivery] = await g.prepareDeliveries();
    await g.markEnqueued(delivery.id);
    const realSync = fs.fsyncSync;
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("wake reservation uncertain");
      realSync(fd);
    });
    await expect(g.reserveWake(delivery.id)).rejects.toThrow("wake reservation uncertain");
    sync.mockRestore();
    expect(await g.reserveWake(delivery.id)).toBe(false);
    expect(g.read().deliveries[0].wake?.state).toBe("pending");
  });

  it("serializes concurrent completions into one final decision", async () => {
    const g = await group();
    await g.seal();
    await Promise.all([start(g, 0), start(g, 1)]);
    await Promise.all([g.apply(report(g, 0)), g.apply(report(g, 1)), g.apply(report(g, 0))]);
    const [delivery] = await g.prepareDeliveries();
    expect(g.read().deliveries).toHaveLength(1);
    await Promise.all([g.markEnqueued(delivery.id), g.markEnqueued(delivery.id)]);
    expect(await g.prepareDeliveries()).toEqual([]);
    await expect(g.markEnqueued("unknown")).rejects.toThrow(/identity/i);
  });

  it("reopens immutable membership and decisions without replaying enqueued delivery", async () => {
    const g = await group();
    await start(g, 0);
    await g.apply(report(g, 0, "blocked"));
    const [delivery] = await g.prepareDeliveries();
    await g.markEnqueued(delivery.id);
    const bytes = fs.readFileSync(g.journalPath, "utf8");
    const reloaded = await group();
    expect(await reloaded.prepareDeliveries()).toEqual([]);
    await reloaded.apply({ type: "running", ...g.binding(0), runId: "run-0" });
    await reloaded.apply(report(g, 0, "blocked"));
    expect(fs.readFileSync(g.journalPath, "utf8")).toBe(bytes);
    await expect(group({ policy: { delivery: "immediate" } })).rejects.toThrow(/binding/i);
    await expect(group({ members: [{ name: "replacement" }] })).rejects.toThrow(/binding/i);
  });

  it("rejects conflicting reports and stale run transitions without replacing earlier evidence", async () => {
    const g = await group();
    await start(g, 0);
    await g.apply(report(g, 0, "blocked"));
    const bytes = fs.readFileSync(g.journalPath, "utf8");
    await expect(g.apply(report(g, 0, "succeeded"))).rejects.toThrow(/binding|conflict/i);
    await expect(g.apply({ type: "running", ...g.binding(0), runId: "replacement" })).rejects.toThrow(/binding/i);
    await expect(g.apply({ ...report(g, 0), report: { ...report(g, 0).report, reportId: "other-report" } })).rejects.toThrow(/binding/i);
    expect(fs.readFileSync(g.journalPath, "utf8")).toBe(bytes);
  });

  it("cannot revive a cancelled queued slot or cancel a different active run", async () => {
    const g = await group();
    await g.apply({ type: "queued", ...g.binding(0), queueId: "queue-0" });
    await g.apply({ type: "cancelled", ...g.binding(0), reason: "stopped" });
    await g.apply({ type: "queued", ...g.binding(0), queueId: "queue-0" });
    await expect(start(g, 0)).rejects.toThrow(/settled/i);
    await start(g, 1);
    await expect(g.apply({ type: "cancelled", ...g.binding(1), runId: "other", reason: "stopped" })).rejects.toThrow(/binding/i);
    expect(g.read().members.map(m => m.status)).toEqual(["cancelled", "running"]);
  });

  it.each(["cancelled", "rejected"] as const)("settles only the exact queued admission as %s before or after run binding", async type => {
    const g = await group();
    await g.apply({ type: "queued", ...g.binding(0), queueId: "queue-0" });
    await g.apply({ type: "queued", ...g.binding(1), queueId: "queue-1" });
    await start(g, 1);
    await g.seal();
    const bytes = fs.readFileSync(g.journalPath, "utf8");
    await expect(g.apply({ type, ...g.binding(1), queueId: "queue-0", reason: "stopped" })).rejects.toThrow(/binding/i);
    await expect(g.apply({ type, ...g.binding(1), runId: "replacement", reason: "stopped" })).rejects.toThrow(/binding/i);
    await expect(g.apply({ type, ...g.binding(1), queueId: "queue-1", runId: "replacement", reason: "stopped" })).rejects.toThrow(/binding/i);
    await expect(g.apply({ type, ...g.binding(1), reason: "stopped" })).rejects.toThrow(/binding/i);
    await expect(g.apply({ type: "running", ...g.binding(1), runId: "replacement" })).rejects.toThrow(/binding/i);
    expect(fs.readFileSync(g.journalPath, "utf8")).toBe(bytes);
    await g.apply({ type, ...g.binding(0), queueId: "queue-0", reason: "stopped" });
    await g.apply({ type, ...g.binding(1), queueId: "queue-1", reason: "stopped" });
    const settled = new CompletionGroup(g.teamName, g.groupId).read();
    expect(settled.members[0]).toMatchObject({ status: type, queueId: "queue-0" });
    expect(settled.members[0].runId).toBeUndefined();
    expect(settled.members[1]).toMatchObject({ status: type, queueId: "queue-1", runId: "run-1" });
    expect(settled.deliveries.at(-1)).toMatchObject({ kind: "settled" });
    await expect(start(g, 0)).rejects.toThrow(/settled/i);
    await expect(g.apply({ type: "running", ...g.binding(1), runId: "replacement" })).rejects.toThrow(/binding/i);
    await g.apply({ type, ...g.binding(1), queueId: "queue-1", reason: "stopped" });
    expect(g.read()).toEqual(settled);
  });

  it("refuses queue settlement for an unqueued run or a mismatched group", async () => {
    const g = await group();
    await start(g, 0);
    await g.apply({ type: "queued", ...g.binding(1), queueId: "queue-1" });
    const bytes = fs.readFileSync(g.journalPath, "utf8");
    await expect(g.apply({ type: "cancelled", ...g.binding(0), queueId: "queue-1", reason: "stopped" })).rejects.toThrow(/binding/i);
    await expect(g.apply({ type: "cancelled", ...g.binding(1), groupId: "other", queueId: "queue-1", reason: "stopped" })).rejects.toThrow(/binding/i);
    expect(fs.readFileSync(g.journalPath, "utf8")).toBe(bytes);
  });

  it("records unspecified legacy outcomes without inferring success or conflicting on replay", async () => {
    const g = await group();
    await start(g, 0);
    const result = createReportResult("team", "one", "run-0", {});
    await g.recordReport(g.binding(0).slotId, result);
    await g.recordReport(g.binding(0).slotId, result);
    expect(g.read().members[0]).toMatchObject({ status: "reported", report: { reportId: result.reportId, verification: "not-requested" } });
    expect(g.read().members[0].report?.outcome).toBeUndefined();
  });

  it("grants a new-batch creation receipt to only one concurrent caller", async () => {
    const created = await Promise.all([group(), group()]);
    expect(created.map(g => g.created).sort()).toEqual([false, true]);
    expect(created[0].groupId).toBe(created[1].groupId);
  });

  it("rejects reuse of a batch identity for a different assignment", async () => {
    await group({ members: [{ name: "one", assignmentKey: "original-assignment" }] });
    await expect(group({ members: [{ name: "one", assignmentKey: "different-assignment" }] })).rejects.toThrow(/binding/i);
  });

  it("isolates options and returned snapshots from later mutation", async () => {
    const g = await group();
    options.members[0].name = "changed";
    const snapshot = g.read();
    snapshot.members[0].name = "forged";
    expect(g.read().members[0].name).toBe("one");
    expect(fs.statSync(g.journalPath).mode & 0o777).toBe(0o600);
  });

  it("fails closed on missing or corrupt referenced state while other groups remain usable", async () => {
    const g = await group();
    await start(g, 0);
    fs.unlinkSync(g.journalPath);
    await expect(g.seal()).rejects.toThrow(/unavailable/i);
    expect(fs.existsSync(g.journalPath)).toBe(false);
    fs.writeFileSync(g.journalPath, "{bad");
    await expect(g.prepareDeliveries()).rejects.toThrow(/corrupt/i);
    const other = await group({ submissionId: "other-call" });
    expect(other.read().members).toHaveLength(2);
  });

  it("rejects persisted cross-run report references", async () => {
    const g = await group();
    await start(g, 0);
    await g.apply(report(g, 0));
    const state = g.read();
    const entry = state.members[0].report;
    if (!entry) throw new Error("Expected the persisted report");
    entry.reportId = createReportResult("team", "one", "other-run", {}).reportId;
    fs.writeFileSync(g.journalPath, JSON.stringify(state));
    expect(() => g.read()).toThrow(/binding/i);
  });

  it("requires durable re-sync after rename published a readable but uncertain decision", async () => {
    const g = await group();
    await start(g, 0);
    const realSync = fs.fsyncSync;
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(descriptor => {
      if (fs.fstatSync(descriptor).isDirectory()) throw new Error("directory sync failed");
      realSync(descriptor);
    });
    await expect(g.apply(report(g, 0, "blocked"))).rejects.toThrow("directory sync failed");
    expect(g.read().members[0].status).toBe("reported");
    await expect(g.prepareDeliveries()).rejects.toThrow("directory sync failed");
    sync.mockRestore();
    expect(await g.prepareDeliveries()).toHaveLength(1);
    await g.apply(report(g, 0, "blocked"));
    expect(g.read().deliveries).toHaveLength(1);
  });

  it("withholds delivery permission while publication cannot be re-synced", async () => {
    const g = await group();
    await start(g, 0);
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("fsync failed"); });
    await expect(g.apply(report(g, 0, "blocked"))).rejects.toThrow("fsync failed");
    expect(g.read().members[0].status).toBe("running");
    sync.mockRestore();
    await g.apply(report(g, 0, "blocked"));
    const replaySync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("replay fsync failed"); });
    await expect(g.prepareDeliveries()).rejects.toThrow("replay fsync failed");
    replaySync.mockRestore();
    expect(await g.prepareDeliveries()).toHaveLength(1);
  });
});
