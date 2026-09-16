import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as paths from "../utils/paths";
import { createReportResult } from "./report-result";
import { CheckJournal } from "./check-journal";
import { normalizeCheckPolicy, readCheckEvidence, verifyAssignedChecks } from "./check-policy";

let root: string;
let cwd: string;
const definition = { name: "tests", command: "assigned command", timeoutSeconds: 2 };
const result = createReportResult("team", "reader", "run", { outcome: "succeeded" });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-check-policy-"));
  cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  execFileSync("git", ["init", "--quiet"], { cwd });
  fs.writeFileSync(path.join(cwd, "input.ts"), "original");
  vi.spyOn(paths, "teamDir").mockReturnValue(path.join(root, "private"));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("explicit assigned-check policy", () => {
  it("validates definitions without admitting runtime identity or duplicate names", () => {
    const policy = [{ ...definition, inputs: ["input.ts"] }];
    const copy = normalizeCheckPolicy(policy);
    policy[0].inputs.push("later");
    expect(copy).toEqual([{ ...definition, inputs: ["input.ts"] }]);
    expect(() => normalizeCheckPolicy([{ ...definition, runId: "forged" }])).toThrow();
    expect(() => normalizeCheckPolicy([definition, definition])).toThrow(/unique|duplicate/i);
    expect(normalizeCheckPolicy([])).toBeUndefined();
  });

  it("does not invoke the check runtime or create storage without an explicit policy", async () => {
    const loadOperations = vi.fn();
    expect(await verifyAssignedChecks("team", result, cwd, undefined, { loadOperations })).toEqual({
      verification: { state: "not-requested" }, checks: [],
    });
    expect(loadOperations).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "private"))).toBe(false);
  });

  it("uses observed failures rather than the reported task outcome and deduplicates repeat reporting", async () => {
    const exec = vi.fn(async () => ({ exitCode: 1 }));
    const options = { loadOperations: async () => ({ exec }) };
    const first = await verifyAssignedChecks("team", result, cwd, [definition], options);
    expect(first.verification).toMatchObject({ state: "failed", checkIds: [expect.any(String)] });
    expect(first.checks[0]).toMatchObject({ state: "failed", assignment: { reportId: result.reportId, runId: "run", command: definition.command } });
    expect(await verifyAssignedChecks("team", result, cwd, [definition], options)).toEqual(first);
    expect(exec).toHaveBeenCalledOnce();
    expect(result.acceptance.state).toBe("pending");
    expect(result.outcome).toBe("succeeded");
  });

  it("makes changed-source evidence stale and rejects another run's referenced checks", async () => {
    const checked = await verifyAssignedChecks("team", result, cwd, [definition], { loadOperations: async () => ({ exec: async () => ({ exitCode: 0 }) }) });
    const storedResult = { ...result, verification: checked.verification };
    expect(checked.verification.state).toBe("passed");
    fs.writeFileSync(path.join(cwd, "input.ts"), "changed");
    expect((await readCheckEvidence("team", storedResult)).verification.state).toBe("stale");
    const another = { ...createReportResult("team", "other", "other-run", {}), verification: checked.verification };
    expect((await readCheckEvidence("team", another)).verification).toMatchObject({ state: "failed", error: expect.stringMatching(/binding|run/i) });
  });

  it("stops at an unresolved claim instead of masking it with a later failure", async () => {
    await new CheckJournal("team").claim({ ...definition, taskId: result.taskId, runId: result.runId,
      reportId: result.reportId, cwd, attempt: 1 });
    const loadOperations = vi.fn(async () => ({ exec: async () => ({ exitCode: 1 }) }));
    const checked = await verifyAssignedChecks("team", result, cwd, [definition, { ...definition, name: "later" }], { loadOperations });
    expect(checked.verification.state).toBe("pending");
    expect(checked.verification.checkIds).toHaveLength(2);
    expect(loadOperations).not.toHaveBeenCalled();
  });

  it("does not pass a partially cancelled policy or start another command", async () => {
    const controller = new AbortController();
    const exec = vi.fn(async () => { controller.abort(); return { exitCode: 0 }; });
    const checked = await verifyAssignedChecks("team", result, cwd, [definition, { ...definition, name: "second" }], {
      loadOperations: async () => ({ exec }), signal: controller.signal,
    });
    expect(checked.verification.state).toBe("failed");
    expect(exec).toHaveBeenCalledOnce();
    expect(checked.checks).toHaveLength(1);
  });
});
