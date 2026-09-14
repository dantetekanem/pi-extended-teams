import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { VerificationController } from "../results/verification-controller";
import { appendTeamReportEvent, listTeamReportEvents, readStoredTeamReportEvent, recordReportAcceptance } from "./report-events";
import { createReportResult } from "../results/report-result";
import * as paths from "./paths";
import type { TeamReportEvent } from "./models";

let root: string;

function reportsPath(teamName = "team"): string {
  return path.join(root, "teams", paths.sanitizeName(teamName), "reports.json");
}

function event(overrides: Partial<TeamReportEvent>): TeamReportEvent {
  return {
    id: overrides.id || `event-${overrides.createdAt}`,
    teamName: overrides.teamName || "team",
    agentName: overrides.agentName || "reader",
    status: overrides.status || "completed",
    report: overrides.report || "done",
    createdAt: overrides.createdAt || Date.now(),
    source: overrides.source || "read-agent",
    ...overrides,
  };
}

describe("report events", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-reports-"));
    vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName))));
    vi.spyOn(paths, "reportFilesDir").mockReturnValue(path.join(root, "agent", "reports"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps unrelated reports available when referenced check evidence is corrupt", async () => {
    const bad = createReportResult("team", "bad", "run", {});
    bad.verification = { state: "pending", checkIds: ["invalid-check-id"] };
    const good = createReportResult("team", "good", "run", { outcome: "blocked" });
    await appendTeamReportEvent("team", { agentName: "bad", status: "completed", report: "Bad evidence", result: bad, source: "read-agent" });
    await appendTeamReportEvent("team", { agentName: "good", status: "completed", report: "Good report", result: good, source: "read-agent" });
    const before = fs.readFileSync(reportsPath(), "utf8");
    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(2);
    expect(reports[0].result?.verification).toMatchObject({ state: "failed", error: expect.stringContaining("Invalid check identity") });
    expect(reports[1].result).toEqual(good);
    expect(fs.readFileSync(reportsPath(), "utf8")).toBe(before);
  });

  it.each(["running", "corrupt"])("observes %s repair ownership without rewriting reports or hiding unrelated results", async state => {
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "input.ts"), "tested");
    const result = createReportResult("team", "repairer", "run", { outcome: "succeeded" });
    const controller = new VerificationController({ teamName: "team", result, cwd,
      checks: [{ name: "tests", command: "authorized", timeoutSeconds: 2 }], repair: { maxAttempts: 1 } });
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    const verified = await controller.verify("initial", { loadOperations: async () => ({ exec }) });
    const ledger = JSON.parse(fs.readFileSync(controller.journalPath, "utf8"));
    ledger.stages[0].state = "running";
    fs.writeFileSync(controller.journalPath, state === "corrupt" ? "{" : JSON.stringify(ledger));
    await appendTeamReportEvent("team", { agentName: "repairer", status: "failed", report: "Recovery report", source: "read-agent",
      result: state === "running" ? result : verified.result });
    const good = createReportResult("team", "other", "run", { outcome: "blocked" });
    await appendTeamReportEvent("team", { agentName: "other", status: "completed", report: "Other report", source: "read-agent", result: good });
    const before = fs.readFileSync(reportsPath(), "utf8");
    const [observed, unrelated] = await listTeamReportEvents("team");
    expect(observed).toMatchObject({ result: { outcome: "succeeded", verification: { state: "pending" },
      repair: { state: "pending", outcome: "blocked" }, acceptance: { state: "pending" } }, checks: [{ state: "passed", exitCode: 0 }] });
    expect(unrelated.result).toEqual(good);
    expect(fs.readFileSync(reportsPath(), "utf8")).toBe(before);
    expect(exec).toHaveBeenCalledOnce();
  });

  it("reads exact stored recovery metadata without source observation or shared mutable results", async () => {
    const result = createReportResult("team", "reader", "run", { outcome: "succeeded" });
    result.verification = { state: "pending", error: "Uncertain persistence" };
    const event = await appendTeamReportEvent("team", { agentName: "reader", status: "failed", report: "Recovery", source: "read-agent", result });
    const observe = vi.spyOn(VerificationController, "observe");
    const stored = await readStoredTeamReportEvent("team", result.reportId);
    expect(stored).toEqual(event);
    stored!.result!.verification.error = "Caller mutation";
    expect((await readStoredTeamReportEvent("team", result.reportId))?.result).toEqual(result);
    expect(await readStoredTeamReportEvent("team", "another-report")).toBeUndefined();
    expect(observe).not.toHaveBeenCalled();
  });

  it("filters before applying latest-limit pagination", async () => {
    await appendTeamReportEvent("team", event({ id: "a-100", agentName: "agent-a", createdAt: 100, summary: "a100" }));
    await appendTeamReportEvent("team", event({ id: "b-200", agentName: "agent-b", createdAt: 200, summary: "b200" }));
    await appendTeamReportEvent("team", event({ id: "a-300", agentName: "agent-a", createdAt: 300, summary: "a300" }));
    await appendTeamReportEvent("team", event({ id: "b-400", agentName: "agent-b", createdAt: 400, summary: "b400" }));
    await appendTeamReportEvent("team", event({ id: "a-500", agentName: "agent-a", createdAt: 500, summary: "a500" }));

    const agentReports = await listTeamReportEvents("team", { agentName: "agent-a", limit: 2 });
    expect(agentReports.map(report => report.summary)).toEqual(["a300", "a500"]);

    const sinceReports = await listTeamReportEvents("team", { since: 250, limit: 2 });
    expect(sinceReports.map(report => report.summary)).toEqual(["b400", "a500"]);

    await expect(listTeamReportEvents("team", { limit: 0 })).resolves.toEqual([]);
  });

  it("sorts externally-written files before slicing latest events", async () => {
    const p = reportsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify([
      event({ id: "300", createdAt: 300, summary: "third" }),
      event({ id: "100", createdAt: 100, summary: "first" }),
      event({ id: "200", createdAt: 200, summary: "second" }),
    ]));

    const reports = await listTeamReportEvents("team", { limit: 2 });

    expect(reports.map(report => report.summary)).toEqual(["second", "third"]);
  });

  it("reuses the in-process index until the report file changes", async () => {
    await appendTeamReportEvent("team", event({ id: "one", createdAt: 100, summary: "one" }));

    const readSpy = vi.spyOn(fs, "readFileSync");
    const first = await listTeamReportEvents("team");
    const second = await listTeamReportEvents("team");

    expect(first.map(report => report.id)).toEqual(["one"]);
    expect(second.map(report => report.id)).toEqual(["one"]);
    expect(readSpy.mock.calls.filter(call => String(call[0]).endsWith("reports.json"))).toHaveLength(0);

    const p = reportsPath();
    fs.writeFileSync(p, JSON.stringify([
      ...first,
      event({ id: "two", createdAt: 200, summary: "two" }),
    ]));

    const afterExternalWrite = await listTeamReportEvents("team");
    expect(afterExternalWrite.map(report => report.id)).toEqual(["one", "two"]);
    expect(readSpy.mock.calls.filter(call => String(call[0]).endsWith("reports.json"))).toHaveLength(1);
  });

  it("isolates cached report objects from caller mutation", async () => {
    const appended = await appendTeamReportEvent("team", event({
      id: "immutable",
      createdAt: 100,
      summary: "original",
      metadata: { nested: { value: "original" } },
    }));

    appended.summary = "mutated append result";
    appended.metadata!.nested.value = "mutated append result";

    const firstList = await listTeamReportEvents("team");
    expect(firstList[0].summary).toBe("original");
    expect(firstList[0].metadata).toEqual({ nested: { value: "original" } });

    firstList[0].summary = "mutated list result";
    firstList[0].metadata!.nested.value = "mutated list result";

    const secondList = await listTeamReportEvents("team");
    expect(secondList[0].summary).toBe("original");
    expect(secondList[0].metadata).toEqual({ nested: { value: "original" } });
  });

  it("does not resort when inserting into an already sorted cache", async () => {
    await appendTeamReportEvent("team", event({ id: "one", createdAt: 100, summary: "one" }));

    const sortSpy = vi.spyOn(Array.prototype, "sort");
    await appendTeamReportEvent("team", event({ id: "two", createdAt: 200, summary: "two" }));

    expect(sortSpy).not.toHaveBeenCalled();
    sortSpy.mockRestore();
    await expect(listTeamReportEvents("team")).resolves.toMatchObject([{ id: "one" }, { id: "two" }]);
  });

  it("writes plain-text reports under the session and versions repeated agent names", async () => {
    const reportFilesDir = path.join(root, "agent", "reports");
    const getReportFilesDir = (paths as any).reportFilesDir;
    if (typeof getReportFilesDir !== "function") throw new Error("reportFilesDir is not implemented");
    vi.spyOn(paths as any, "reportFilesDir").mockReturnValue(reportFilesDir);

    const first = await appendTeamReportEvent("team", event({ id: "one", createdAt: 100, report: "first report", summary: "First" }));
    const second = await appendTeamReportEvent("team", event({ id: "two", createdAt: 200, report: "second report", summary: "Second" }));
    const sessionDir = path.join(reportFilesDir, "team");

    expect(path.dirname((first as any).reportPath)).toBe(sessionDir);
    expect(path.basename((first as any).reportPath)).toBe("reader.md");
    expect(path.basename((second as any).reportPath)).toBe("reader-v2.md");
    expect(fs.readFileSync((first as any).reportPath, "utf-8")).toBe("first report");
    expect(fs.readFileSync((second as any).reportPath, "utf-8")).toBe("second report");
    await expect(listTeamReportEvents("team")).resolves.toMatchObject([
      { id: "one", report: "first report", summary: "First", reportPath: (first as any).reportPath },
      { id: "two", report: "second report", summary: "Second", reportPath: (second as any).reportPath },
    ]);
  });

  it("persists and replays a blocked task result without sharing mutable evidence", async () => {
    const result = createReportResult("team", "reader", "run-1", {
      outcome: "blocked", findings: [{ id: "F1", text: "Missing input", evidence: ["file.ts:1"] }],
    });
    const input = { agentName: "reader", status: "completed" as const, report: "Waiting for input", source: "read-agent" as const, result };
    const first = await appendTeamReportEvent("team", input);
    expect(first.id).toBe(result.reportId);
    first.result!.findings![0].text = "mutated return";
    result.findings![0].evidence.push("mutated input");
    const replay = await appendTeamReportEvent("team", { ...input, report: "Duplicate delivery" });
    expect(replay).toMatchObject({
      id: result.reportId, status: "completed", report: "Waiting for input",
      result: { outcome: "blocked", findings: [{ id: "F1", text: "Missing input", evidence: ["file.ts:1"] }],
        verification: { state: "not-requested" }, acceptance: { state: "pending" } },
    });
    expect(fs.readFileSync(replay.reportPath!, "utf8")).toBe("Waiting for input");
    expect(await listTeamReportEvents("team")).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(reportsPath(), "utf8"))[0].result).toMatchObject({ outcome: "blocked", runId: "run-1" });
  });

  it("records explicit lead acceptance without changing the task outcome or verification", async () => {
    const result = createReportResult("team", "reader", "run-1", { outcome: "blocked" });
    const original = await appendTeamReportEvent("team", {
      agentName: "reader", status: "completed", report: "Needs product input", source: "read-agent", result,
    });
    const accepted = await recordReportAcceptance("team", original.id, "accepted", "Blocker acknowledged");
    expect(accepted.result).toMatchObject({
      outcome: "blocked", verification: { state: "not-requested" },
      acceptance: { state: "accepted", reason: "Blocker acknowledged", decidedAt: expect.any(Number) },
    });
    expect(accepted.reportPath).toBe(original.reportPath);
    expect((await listTeamReportEvents("team"))[0].result).toEqual(accepted.result);
    await expect(recordReportAcceptance("team", "missing", "accepted")).rejects.toThrow(/report/i);
  });

  it("preserves the durable result if acceptance persistence fails", async () => {
    const result = createReportResult("team", "reader", "run-1", { outcome: "succeeded" });
    const original = await appendTeamReportEvent("team", {
      agentName: "reader", status: "completed", report: "Implemented", source: "read-agent", result,
    });
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("storage unavailable"); });
    await expect(recordReportAcceptance("team", original.id, "accepted")).rejects.toThrow("storage unavailable");
    rename.mockRestore();
    expect((await listTeamReportEvents("team"))[0]).toEqual(original);
    expect(JSON.parse(fs.readFileSync(reportsPath(), "utf8"))[0].result.acceptance).toEqual({ state: "pending" });
  });

  it("returns the original event for duplicate ids", async () => {
    const first = await appendTeamReportEvent("team", event({ id: "same", createdAt: 100, summary: "first" }));
    const second = await appendTeamReportEvent("team", event({ id: "same", createdAt: 200, summary: "second" }));

    expect(second).toEqual(first);
    await expect(listTeamReportEvents("team")).resolves.toMatchObject([{ id: "same", summary: "first" }]);
  });
});
