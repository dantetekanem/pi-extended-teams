import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as paths from "../utils/paths";
import { CheckJournal, checkIdentity } from "./check-journal";
import type { CheckOperations, CheckRunnerOptions } from "./check-runner";
import { createReportResult } from "./report-result";
import * as sourceIdentity from "./source-identity";
import { VerificationController, type VerificationControllerOptions } from "./verification-controller";

let root: string;
let repo: string;
let context: VerificationControllerOptions;
let operations: CheckRunnerOptions;
let exec: ReturnType<typeof vi.fn<CheckOperations["exec"]>>;
let failing: boolean;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-repair-controller-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "a.ts"), "original a");
  fs.writeFileSync(path.join(repo, "b.ts"), "original b");
  vi.spyOn(paths, "teamDir").mockReturnValue(path.join(root, "private"));
  context = {
    teamName: "team", cwd: repo,
    result: createReportResult("team", "reader", "run", { outcome: "succeeded" }),
    checks: [
      { name: "a", command: "check a", timeoutSeconds: 2, inputs: ["a.ts"] },
      { name: "b", command: "check b", timeoutSeconds: 2, inputs: ["b.ts"] },
    ],
    repair: { maxAttempts: 1 },
  };
  failing = true;
  exec = vi.fn<CheckOperations["exec"]>(async (command, _cwd, options) => {
    const exitCode = command === "check a" && failing ? 1 : 0;
    options.onData(Buffer.from(`${command}: exit ${exitCode}`));
    return { exitCode };
  });
  operations = { loadOperations: async () => ({ exec }) };
});

afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

function controller(overrides: Partial<VerificationControllerOptions> = {}) {
  return new VerificationController({ ...context, ...overrides });
}

describe("bounded source-bound repair decisions", () => {
  it("preserves no-check and verification-only defaults", async () => {
    const loadOperations = vi.fn();
    const result = await controller({ checks: undefined, repair: undefined }).verify("initial", { loadOperations });
    expect(result.result.verification.state).toBe("not-requested");
    expect(loadOperations).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "private"))).toBe(false);
    const checked = await controller({ repair: undefined }).verify("initial", operations);
    expect(checked.result.verification.state).toBe("failed");
    expect(checked.request).toBeUndefined();
    const disabled = await controller({ repair: { maxAttempts: 0 } }).verify("disabled", operations);
    expect(disabled.result.verification.state).toBe("failed");
    expect(disabled.request).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(root, "private", "repairs"))).toBe(false);
  });

  it.each([-1, 0.5, Infinity, 6])("rejects an invalid repair bound: %s", maxAttempts => {
    expect(() => controller({ repair: { maxAttempts } })).toThrow(/repair policy/i);
  });

  it("reserves one repair with actual failed evidence and replays it without another command", async () => {
    const first = await controller().verify("initial", operations);
    expect(first.result).toMatchObject({ outcome: "succeeded", verification: { state: "failed" }, acceptance: { state: "pending" },
      repair: { state: "requested", attemptsUsed: 1, maxAttempts: 1 } });
    expect(first.request).toMatchObject({ attempt: 1, checks: [{ state: "failed", exitCode: 1, assignment: { name: "a" } }] });
    expect(fs.readFileSync(first.request!.checks[0].logPath, "utf8")).toBe("check a: exit 1");
    const replay = await controller().verify("initial", operations);
    expect(replay.request).toEqual(first.request);
    expect(replay.result.repair?.attemptsUsed).toBe(1);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("passes cancellation to source observation when replaying a reserved decision", async () => {
    await controller().verify("initial", operations);
    const capture = vi.spyOn(sourceIdentity, "captureSourceIdentity");
    const signal = new AbortController().signal;
    await controller().verify("initial", { ...operations, signal });
    expect(capture).toHaveBeenCalled();
    expect(capture.mock.calls.every(call => call[2] === signal)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("durably cancels future attempts when replay observation is interrupted", async () => {
    await controller().verify("initial", operations);
    const abort = new AbortController();
    vi.spyOn(sourceIdentity, "captureSourceIdentity").mockImplementationOnce(async () => {
      abort.abort();
      throw new Error("observation aborted");
    });
    await controller().verify("initial", { ...operations, signal: abort.signal });
    const later = await controller().verify("later", operations);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(later.result.repair?.state).toBe("cancelled");
    expect(later.request).toBeUndefined();
  });

  it("reruns failed checks but reuses a matching-source passed check", async () => {
    const initial = await controller().verify("initial", operations);
    fs.writeFileSync(path.join(repo, "a.ts"), "fixed a");
    failing = false;
    const repaired = await controller().verify("after-repair", operations);
    expect(exec.mock.calls.map(call => call[0])).toEqual(["check a", "check b", "check a"]);
    expect(repaired.result).toMatchObject({ outcome: "succeeded", verification: { state: "passed" }, acceptance: { state: "pending" },
      repair: { state: "repaired", attemptsUsed: 1 } });
    expect(repaired.result.verification.checkIds?.[1]).toBe(initial.result.verification.checkIds?.[1]);
    expect(repaired.result.verification.checkIds?.[0]).not.toBe(initial.result.verification.checkIds?.[0]);
  });

  it("reruns a formerly passed check when its inputs changed during repair", async () => {
    const initial = await controller().verify("initial", operations);
    fs.writeFileSync(path.join(repo, "a.ts"), "fixed a");
    fs.writeFileSync(path.join(repo, "b.ts"), "changed b");
    failing = false;
    const repaired = await controller().verify("after-repair", operations);
    expect(exec.mock.calls.map(call => call[0])).toEqual(["check a", "check b", "check a", "check b"]);
    expect(repaired.result.verification.state).toBe("passed");
    const oldPassed = await new CheckJournal("team").read(initial.result.verification.checkIds![1]);
    expect(oldPassed?.state).toBe("passed");
    expect(repaired.result.verification.checkIds?.[1]).not.toBe(oldPassed?.checkId);
  });

  it("exhausts the finite repair budget without rewriting the reported outcome or rerunning delivery", async () => {
    await controller().verify("initial", operations);
    const exhausted = await controller().verify("after-repair", operations);
    expect(exhausted.result).toMatchObject({ outcome: "succeeded", verification: { state: "failed" }, acceptance: { state: "pending" },
      repair: { state: "exhausted", attemptsUsed: 1, outcome: "blocked" } });
    expect(exhausted.request).toBeUndefined();
    await controller().verify("after-repair", operations);
    await controller().verify("late-duplicate", operations);
    const oldDelivery = await controller().verify("initial", operations);
    expect(oldDelivery.request).toBeUndefined();
    expect(oldDelivery.result.repair?.state).toBe("exhausted");
    expect(exec.mock.calls.map(call => call[0])).toEqual(["check a", "check b", "check a"]);
  });

  it("durably cancels future repairs while retaining the observed failure", async () => {
    const initial = await controller().verify("initial", operations);
    await controller().cancel();
    failing = false;
    const cancelled = await controller().verify("after-cancellation", operations);
    expect(cancelled.result.verification).toEqual(initial.result.verification);
    expect(cancelled.result.repair).toMatchObject({ state: "cancelled", outcome: "blocked" });
    expect(cancelled.request).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("stops starting checks after cancellation and does not retry them on a later report", async () => {
    let started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    exec.mockImplementation(async (_command, _cwd, options) => {
      started();
      await new Promise<void>(resolve => { options.signal!.addEventListener("abort", () => resolve(), { once: true }); });
      return { exitCode: 0 };
    });
    const abort = new AbortController();
    const running = controller().verify("initial", { ...operations, signal: abort.signal });
    await began;
    abort.abort();
    const cancelled = await running;
    expect(cancelled.result).toMatchObject({ verification: { state: "failed" }, repair: { state: "cancelled" } });
    await controller().verify("after-cancellation", operations);
    expect(exec).toHaveBeenCalledOnce();
  });

  it.each(["missing", "settled", "cancelled"])("recovers running controller ownership with %s check evidence", async condition => {
    failing = false;
    const completed = await controller().verify("initial", operations);
    const ledgerPath = controller().journalPath;
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    ledger.stages[0].state = "running";
    ledger.cancelled = condition === "cancelled";
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    if (condition === "missing") for (const check of completed.checks) fs.unlinkSync(check.logPath.replace(/\.log$/, ".json"));
    const before = fs.readFileSync(ledgerPath, "utf8");
    const observed = await VerificationController.observe("team", completed.result);
    expect(observed.result).toMatchObject({ outcome: "succeeded", verification: { state: "pending" },
      repair: { state: "pending", outcome: "blocked" }, acceptance: { state: "pending" } });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(ledgerPath, "utf8")).toBe(before);
  });

  it("keeps an unresolved native claim pending even when the controller appears settled", async () => {
    const initial = await controller().verify("initial", operations);
    const check = initial.checks[0];
    fs.writeFileSync(check.logPath.replace(/\.log$/, ".json"), JSON.stringify({ ...check, state: "claimed", completedAt: undefined }));
    const ledger = JSON.parse(fs.readFileSync(controller().journalPath, "utf8"));
    ledger.stages[0].state = "not-needed";
    fs.writeFileSync(controller().journalPath, JSON.stringify(ledger));
    const observed = await VerificationController.observe("team", context.result);
    expect(observed.result).toMatchObject({ verification: { state: "pending" }, repair: { state: "pending", outcome: "blocked" } });
    expect(observed.request).toBeUndefined();
    const capture = vi.spyOn(sourceIdentity, "captureSourceIdentity");
    await expect(controller().cancelAndRequireSettled()).rejects.toThrow("ownership remains unresolved");
    expect(capture).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("recovers the latest repair state and current source without trusting cached provenance", async () => {
    const initial = await controller().verify("initial", operations);
    failing = false;
    await controller().verify("repaired", operations);
    const before = fs.readFileSync(controller().journalPath, "utf8");
    initial.result.repair = { controllerId: "forged", state: "exhausted", maxAttempts: 99, attemptsUsed: 99, requestIds: [] };
    const recovered = await VerificationController.observe("team", initial.result);
    expect(recovered.result).toMatchObject({ outcome: "succeeded", verification: { state: "passed" },
      repair: { state: "repaired", attemptsUsed: 1, maxAttempts: 1 } });
    fs.writeFileSync(path.join(repo, "b.ts"), "changed after repair");
    expect((await VerificationController.observe("team", initial.result)).result.verification.state).toBe("stale");
    expect(exec).toHaveBeenCalledTimes(3);
    expect(fs.readFileSync(controller().journalPath, "utf8")).toBe(before);
  });

  it.each(["corrupt", "missing", "wrong-run"])("keeps %s repair ownership uncertain without trusting cached completion", async condition => {
    const initial = await controller().verify("initial", operations);
    if (condition === "corrupt") fs.writeFileSync(controller().journalPath, "{");
    if (condition === "missing") fs.unlinkSync(controller().journalPath);
    if (condition === "wrong-run") initial.result.runId = "another-run";
    const observed = await VerificationController.observe("team", initial.result);
    expect(observed.result).toMatchObject({ outcome: "succeeded", verification: { state: "pending", error: expect.any(String) },
      repair: { state: "pending", outcome: "blocked", error: expect.any(String) } });
    expect(observed.result.repair?.maxAttempts).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
    if (condition !== "wrong-run") expect(observed.checks.map(check => check.exitCode)).toEqual([1, 0]);
  });

  it.each(["verify", "cancel", "cleanup"])("blocks %s when previously referenced repair history disappears", async operation => {
    const initial = await controller().verify("initial", operations);
    if (operation === "cleanup") initial.result.verification.error = "reservation publication uncertain";
    fs.unlinkSync(controller().journalPath);
    const recovered = controller({ result: operation === "verify" ? context.result : initial.result });
    await expect(operation === "verify" ? recovered.verify("later", operations)
      : operation === "cancel" ? recovered.cancel() : recovered.cancelAndRequireSettled()).rejects.toThrow(/ledger.*unavailable/i);
    expect(fs.existsSync(recovered.journalPath)).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
    const observed = await VerificationController.observe("team", initial.result);
    expect(observed.result).toMatchObject({ verification: { state: "pending" }, repair: { state: "pending", outcome: "blocked" } });
    expect(observed.result.repair?.attemptsUsed).toBeUndefined();
    if (operation === "cleanup") expect(observed.result.verification.error).toContain("reservation publication uncertain");
    expect(observed.checks.map(check => fs.readFileSync(check.logPath, "utf8"))).toEqual(["check a: exit 1", "check b: exit 0"]);
  });

  it.each(["check-refs", "persistence-error"])("retains missing ownership established by %s without surviving native rows", async proof => {
    const result = structuredClone(context.result);
    result.verification = proof === "check-refs"
      ? { state: "pending", checkIds: [checkIdentity({ reportId: result.reportId, name: "a", attempt: 1 })] }
      : { state: "pending", error: "reservation publication uncertain" };
    const recovered = controller({ result });
    await expect(recovered.cancelAndRequireSettled()).rejects.toThrow(/ledger.*unavailable/i);
    await expect(recovered.verify("later", operations)).rejects.toThrow(/ledger.*unavailable/i);
    expect(fs.existsSync(recovered.journalPath)).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("remembers observed ownership after its ledger and native rows disappear", async () => {
    const owner = controller();
    const initial = await owner.verify("initial", operations);
    fs.unlinkSync(owner.journalPath);
    for (const check of initial.checks) fs.unlinkSync(check.logPath.replace(/\.log$/, ".json"));
    await expect(owner.cancelAndRequireSettled()).rejects.toThrow(/ledger.*unavailable/i);
    expect(fs.existsSync(owner.journalPath)).toBe(false);
  });

  it("cancels genuinely never-started repair without executing checks", async () => {
    await controller().cancelAndRequireSettled();
    const later = await controller().verify("initial", operations);
    expect(later.result.repair).toMatchObject({ state: "cancelled", attemptsUsed: 0 });
    expect(exec).not.toHaveBeenCalled();
  });

  it("supports multiple explicitly bounded repair reservations", async () => {
    const configured = { repair: { maxAttempts: 2 } };
    const initial = await controller(configured).verify("initial", operations);
    const second = await controller(configured).verify("repair-one", operations);
    const exhausted = await controller(configured).verify("repair-two", operations);
    expect(initial.request?.attempt).toBe(1);
    expect(second.request?.attempt).toBe(2);
    expect(second.request?.id).not.toBe(initial.request?.id);
    expect(exhausted.result.repair).toMatchObject({ state: "exhausted", attemptsUsed: 2 });
    expect(exec.mock.calls.map(call => call[0])).toEqual(["check a", "check b", "check a", "check a"]);
  });

  it("allows a responsible agent to decline repair without another command", async () => {
    await controller().verify("initial", operations);
    const result = { ...context.result, outcome: "blocked" as const };
    const declined = await controller({ result }).verify("cannot-repair", operations);
    expect(declined.result).toMatchObject({ outcome: "blocked", verification: { state: "failed" }, repair: { state: "declined" } });
    expect(declined.request).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("does not authorize checking if the durable reservation cannot be synced", async () => {
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw new Error("reservation sync failed"); });
    const loadOperations = vi.fn();
    await expect(controller().verify("initial", { loadOperations })).rejects.toThrow("reservation sync failed");
    expect(loadOperations).not.toHaveBeenCalled();
  });

  it("does not deliver repair feedback before its reservation is durable", async () => {
    const repair = controller();
    const rename = fs.renameSync;
    let publications = 0;
    let publishingFeedback = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (to === repair.journalPath) publishingFeedback = ++publications === 2;
    });
    const sync = fs.fsyncSync;
    const fault = vi.spyOn(fs, "fsyncSync").mockImplementation(descriptor => {
      if (publishingFeedback && fs.fstatSync(descriptor).isDirectory()) throw new Error("feedback sync failed");
      sync(descriptor);
    });
    await expect(repair.verify("initial", operations)).rejects.toThrow("feedback sync failed");
    fault.mockRestore();
    const recovered = await controller().verify("initial", operations);
    expect(recovered.request?.attempt).toBe(1);
    expect(recovered.result.repair?.attemptsUsed).toBe(1);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("rejects repair initialization around an orphaned native claim", async () => {
    const assignment = { ...context.checks![0], taskId: context.result.taskId, runId: context.result.runId,
      reportId: context.result.reportId, cwd: repo, attempt: 1 };
    const journal = new CheckJournal("team");
    await journal.claim(assignment);
    await expect(controller().verify("initial", operations)).rejects.toThrow(/ledger.*unavailable/i);
    await expect(controller().cancelAndRequireSettled()).rejects.toThrow(/ledger.*unavailable/i);
    expect(await journal.read(checkIdentity(assignment))).toMatchObject({ state: "claimed" });
    expect(fs.existsSync(controller().journalPath)).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("keeps a concurrently reserved submission pending without running a second copy", async () => {
    let started!: () => void;
    let release!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    exec.mockImplementation(async command => {
      if (command === "check a") { started(); await gate; }
      return { exitCode: command === "check a" ? 1 : 0 };
    });
    const running = controller().verify("initial", operations);
    await began;
    const overlapping = await controller().verify("initial", operations).catch(error => error);
    release();
    const finished = await running;
    expect(overlapping.result.verification.state).toBe("pending");
    expect(overlapping.request).toBeUndefined();
    expect(finished.result.repair?.attemptsUsed).toBe(1);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("does not let cancellation hide an unacknowledged execution reservation", async () => {
    const sync = fs.fsyncSync;
    const fault = vi.spyOn(fs, "fsyncSync").mockImplementation(descriptor => {
      if (fs.fstatSync(descriptor).isDirectory()) throw new Error("directory sync failed");
      sync(descriptor);
    });
    const loadOperations = vi.fn();
    await expect(controller().verify("initial", { loadOperations })).rejects.toThrow("directory sync failed");
    fault.mockRestore();
    await controller().cancel();
    const pending = await controller().verify("after-reload", { loadOperations });
    expect(pending.result.verification.state).toBe("pending");
    expect(pending.request).toBeUndefined();
    expect(loadOperations).not.toHaveBeenCalled();
  });

  it("does not offer model repair for unsupported check execution", async () => {
    const result = await controller().verify("initial", { loadOperations: async () => undefined });
    expect(result.result.verification.state).toBe("failed");
    expect(result.result.repair).toMatchObject({ state: "blocked", attemptsUsed: 0 });
    expect(result.request).toBeUndefined();
  });

  it("isolates a corrupt repair ledger from unrelated report identities", async () => {
    const first = controller();
    await first.verify("initial", operations);
    fs.writeFileSync(first.journalPath, JSON.stringify({ version: 99 }));
    await expect(first.verify("next", operations)).rejects.toThrow(/corrupt|incompatible/i);
    const result = createReportResult("team", "other", "other-run", { outcome: "succeeded" });
    expect((await controller({ result }).verify("initial", operations)).result.repair?.state).toBe("requested");
  });

  it("rejects policy or run rebinding after a durable reservation", async () => {
    await controller().verify("initial", operations);
    await expect(controller({ repair: { maxAttempts: 2 } }).verify("next", operations)).rejects.toThrow(/binding/i);
    await expect(controller({ repair: undefined }).verify("next", operations)).rejects.toThrow(/binding/i);
    await expect(controller({ repair: undefined }).cancel()).rejects.toThrow(/binding/i);
    await expect(controller({ result: { ...context.result, runId: "other-run" } }).verify("next", operations)).rejects.toThrow(/binding/i);
    await expect(controller({ result: { ...context.result, outcome: "blocked" } }).verify("initial", operations)).rejects.toThrow(/binding/i);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
