import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "../utils/paths";
import * as messaging from "../utils/messaging";
import { appendTeamReportEvent } from "../utils/report-events";
import { createReportResult } from "./report-result";
import { CompletionGroup } from "./completion-group";
import { deliverCompletionGroupReport } from "./completion-group-delivery";
import { requestCompletionGroupWake, observeCompletionGroupWakes } from "./completion-group-wake";
import { recoverCompletionGroups } from "./completion-group-recovery";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-group-wake-"));
  vi.spyOn(paths, "teamDir").mockImplementation(team => path.join(root, team));
  vi.spyOn(paths, "reportFilesDir").mockReturnValue(path.join(root, "reports"));
  vi.spyOn(paths, "inboxPath").mockImplementation((team, name) => path.join(root, team, "inboxes", `${name}.json`));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

async function makeGroup(count = 1, seal = true) {
  const group = await CompletionGroup.create({ teamName: "team", sessionId: "session", submissionId: "batch",
    policy: { delivery: "all-settled" }, members: Array.from({ length: count }, (_, index) => ({ name: `reader-${index}` })) });
  if (!group) throw new Error("Expected group");
  if (seal) await group.seal();
  return group;
}
async function report(group: CompletionGroup, index: number, outcome: "succeeded" | "blocked" = "succeeded") {
  await group.apply({ type: "running", ...group.binding(index), runId: `run-${index}` });
  const event = await appendTeamReportEvent("team", { agentName: `reader-${index}`, source: "read-agent", status: "completed",
    completionGroup: group.binding(index), report: "Full independent report", summary: "Finding summary",
    result: createReportResult("team", `reader-${index}`, `run-${index}`, { outcome }) });
  await deliverCompletionGroupReport(event);
}
const inbox = () => messaging.peekInbox("team", "team-lead");
const entry = (send: ReturnType<typeof vi.fn>) => ({ type: "custom_message", id: "entry-1", customType: "pi-extended-teams-wake",
  content: send.mock.calls[0][0], details: send.mock.calls[0][1] });

describe("completion group wake requests", () => {
  it("requests one compact wake for ten reports and observes only its exact history entry", async () => {
    const group = await makeGroup(10);
    const send = vi.fn();
    for (let index = 0; index < 10; index++) {
      await report(group, index);
      for (const message of await inbox()) await requestCompletionGroupWake("team", "session", message, send);
      expect(send).toHaveBeenCalledTimes(index === 9 ? 1 : 0);
    }
    expect(send.mock.calls[0][0]).toContain("Finding summary");
    expect(group.read().deliveries[0].wake?.state).toBe("pending");
    await messaging.sendPlainMessage("team", "writer", "team-lead", "Later information", "Later");
    const observed = await observeCompletionGroupWakes("team", "session", [entry(send)]);
    expect(observed).toEqual({ observed: ["entry-1"], errors: [] });
    expect(group.read().deliveries[0].wake).toMatchObject({ state: "observed", entryId: "entry-1" });
    expect((await messaging.peekInbox("team", "team-lead", true)).map(message => message.text)).toEqual(["Later information"]);
    await requestCompletionGroupWake("team", "session", (await inbox())[0], send);
    expect(send).toHaveBeenCalledOnce();
  }, 15_000);

  it("never reissues an ambiguous failed wake and can observe a surviving queued message after reload", async () => {
    const group = await makeGroup();
    await report(group, 0);
    const [message] = await inbox();
    const send = vi.fn(() => { throw new Error("API request unconfirmed"); });
    await expect(requestCompletionGroupWake("team", "session", message, send)).rejects.toThrow("API request unconfirmed");
    expect(group.read().deliveries[0].wake).toMatchObject({ state: "pending", error: "API request unconfirmed" });
    const afterReload = vi.fn();
    await requestCompletionGroupWake("team", "session", message, afterReload);
    expect(afterReload).not.toHaveBeenCalled();
    expect(await observeCompletionGroupWakes("team", "session", [])).toEqual({ observed: [], errors: [] });
    expect((await observeCompletionGroupWakes("team", "session", [entry(send)])).observed).toEqual(["entry-1"]);
    expect(group.read().deliveries[0].wake?.state).toBe("observed");
  });

  it("reserves only once across concurrent wake requests and rejects incorrect session or message bindings", async () => {
    await report(await makeGroup(), 0);
    const [message] = await inbox();
    const send = vi.fn();
    await expect(requestCompletionGroupWake("team", "different-session", message, send)).rejects.toThrow(/binding/i);
    await expect(requestCompletionGroupWake("team", "session", { ...message, text: "Changed index" }, send)).rejects.toThrow(/binding/i);
    await Promise.all([requestCompletionGroupWake("team", "session", message, send), requestCompletionGroupWake("team", "session", message, send)]);
    expect(send).toHaveBeenCalledOnce();
    expect(await observeCompletionGroupWakes("other-team", "session", [entry(send)])).toEqual({ observed: [], errors: [] });
    expect((await observeCompletionGroupWakes("team", "session", [{ ...entry(send), content: "Changed index" }])).errors).toHaveLength(1);
    expect((await messaging.peekInbox("team", "team-lead", true))).toHaveLength(1);
  });

  it("recovers exact reports and interrupted queues without inventing settlement for unknown running work", async () => {
    const group = await makeGroup(3, false);
    await group.apply({ type: "running", ...group.binding(0), runId: "run-0" });
    await appendTeamReportEvent("team", { agentName: "reader-0", source: "read-agent", status: "completed", report: "Saved blocker",
      completionGroup: group.binding(0), result: createReportResult("team", "reader-0", "run-0", { outcome: "blocked" }) });
    await group.apply({ type: "queued", ...group.binding(1), queueId: "lost-queue" });
    await group.apply({ type: "running", ...group.binding(2), runId: "unknown-run" });
    const errors = await recoverCompletionGroups("team", "session", [], [], new Set());
    expect(group.read().members.map(member => member.status)).toEqual(["reported", "interrupted", "running"]);
    expect(errors.some(error => error.includes("unknown-run"))).toBe(true);
    expect(await inbox()).toHaveLength(1);
    expect(group.read().deliveries[0].wake).toBeUndefined();
  });

  it("leaves current-runtime admission alone and restores only actual roster run identities", async () => {
    const group = await makeGroup(1, false);
    const before = fs.readFileSync(group.journalPath, "utf8");
    expect(await recoverCompletionGroups("team", "session", [], [], new Set([group.groupId]))).toEqual([]);
    expect(fs.readFileSync(group.journalPath, "utf8")).toBe(before);
    await group.apply({ type: "queued", ...group.binding(0), queueId: "queue" });
    const owner = { name: "reader-0", lifecycleRunId: "actual-run", completionGroup: group.binding(0) };
    await recoverCompletionGroups("team", "session", [owner], [], new Set());
    expect(group.read().members[0]).toMatchObject({ status: "running", runId: "actual-run", queueId: "queue" });
  });

  it("reports missing archived group history without blocking an unrelated suppressed group", async () => {
    const missing = await makeGroup();
    await report(missing, 0);
    fs.unlinkSync(missing.journalPath);
    const other = await CompletionGroup.create({ teamName: "team", sessionId: "session", submissionId: "other",
      policy: { delivery: "all-settled" }, members: [{ name: "other", suppressed: true }] });
    if (!other) throw new Error("Expected group");
    const errors = await recoverCompletionGroups("team", "session", [], [], new Set());
    expect(errors.some(error => error.includes("unavailable"))).toBe(true);
    expect(fs.existsSync(missing.journalPath)).toBe(false);
    expect(other.read().members[0].status).toBe("interrupted");
    expect(other.read().deliveries).toEqual([]);
  });

  it("can request an early blocker without waiting for other members", async () => {
    const group = await makeGroup(2);
    await report(group, 0, "blocked");
    const send = vi.fn();
    await requestCompletionGroupWake("team", "session", (await inbox())[0], send);
    expect(send).toHaveBeenCalledOnce();
    expect(group.read().members[1].status).toBe("pending");
    expect(send.mock.calls[0][0]).toContain('"kind":"urgent"');
  });
});
