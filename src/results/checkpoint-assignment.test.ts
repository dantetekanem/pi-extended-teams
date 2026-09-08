import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "../utils/paths";
import * as source from "./source-identity";
import { checkpointId, saveCheckpoint, retireCheckpoint, type SpecialistCheckpoint } from "./specialist-checkpoint";
import { createCheckpointAssignment, captureCheckpointAssignment, continuationPrompt } from "./checkpoint-assignment";

let root: string;
let parent: SpecialistCheckpoint;
const nativeCapture = source.captureSourceIdentity;
const identity = (inputs = ["src"], fingerprint = "a".repeat(64)): source.SourceIdentity => ({ version: 1, cwd: root, repositoryRoot: root, head: null, inputs, fingerprint, fileCount: 1 });
describe("continuation assignments", () => {
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "continuation-assignment-")));
    vi.spyOn(paths, "checkpointFilesDir").mockReturnValue(path.join(root, "checkpoints"));
    const author = { teamName: "old-team", agentName: "reviewer", runId: "old-run", modelSlot: "read-review" as const };
    const now = Date.now(); const reportId = "report:old-team:reviewer:old-run";
    parent = { version: 1, state: "ready", id: checkpointId(author), author, createdAt: now, expiresAt: now + 30 * 86_400_000,
      assignment: { original: "Review authentication", current: "Previous review" }, policy: { inputs: ["src"], retentionDays: 30, decisions: ["Historical choice"] },
      reportId, reports: [{ id: reportId, path: path.join(root, "original.md"), source: { before: identity(), after: identity() }, verification: "passed", acceptance: "accepted" }],
      findings: [{ id: "F1", text: "Check tenant ownership", evidence: ["src/auth.ts:4"], reportId }], inspectedEvidence: [], questions: ["Which tenant?"] };
    await saveCheckpoint(parent);
    vi.spyOn(source, "captureSourceIdentity").mockImplementation(async (_cwd, inputs) => identity(inputs!.map(input => path.relative(root, path.resolve(root, input)))));
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it("inherits data scope and retention, not old decisions or execution authority", () => {
    const assignment = createCheckpointAssignment(undefined, "Recheck my fixes", parent.id)!;
    expect(assignment).toMatchObject({ originalPrompt: "Review authentication", policy: { inputs: ["src"], retentionDays: 30, decisions: [] }, parent });
    const policy = { inputs: ["config"], retentionDays: 2, decisions: ["Current choice"] };
    const overridden = createCheckpointAssignment(policy, "Recheck my fixes", parent.id)!;
    policy.inputs.push("mutated");
    expect(overridden.policy).toEqual({ inputs: ["config"], retentionDays: 2, decisions: ["Current choice"] });
    expect(overridden).not.toHaveProperty("assignedChecks");
    expect(() => createCheckpointAssignment(undefined, " ", parent.id)).toThrow(/assignment/i);
  });

  it.each(["unchanged", "dependency-change", "investigation-change", "unknown", "override"])("revalidates original dependency scope at actual capture: %s", async mode => {
    if (mode === "investigation-change") {
      parent.reports[0].source.before.fingerprint = "b".repeat(64);
      fs.writeFileSync(path.join(paths.checkpointFilesDir(), `${parent.id.slice(11)}.json`), JSON.stringify(parent));
    }
    const assignment = createCheckpointAssignment(mode === "override" ? { inputs: ["config"] } : undefined, "Recheck my fixes", parent.id)!;
    if (mode === "dependency-change") vi.mocked(source.captureSourceIdentity).mockResolvedValue(identity(["src"], "b".repeat(64)));
    if (mode === "unknown") {
      assignment.policy.inputs = ["config"];
      vi.mocked(source.captureSourceIdentity).mockImplementation(async (_cwd, inputs) => {
        if (inputs?.[0] === "config") return identity(["config"]);
        throw new Error("Dependency scope unavailable");
      });
    }
    const captured = await captureCheckpointAssignment(assignment, root, new AbortController().signal);
    expect(captured.revalidation).toEqual([expect.objectContaining({ reportId: parent.reportId, required: !["unchanged", "override"].includes(mode) })]);
    expect(source.captureSourceIdentity).toHaveBeenCalledTimes(mode === "override" || mode === "unknown" ? 2 : 1);
    if (mode === "override") expect(source.captureSourceIdentity).toHaveBeenLastCalledWith(root, [path.join(root, "src")], expect.any(AbortSignal));
    const prompt = continuationPrompt(captured, "Recheck my fixes");
    expect(prompt).toContain(JSON.stringify(parent.findings[0]));
    expect(prompt).toContain(JSON.stringify(captured.revalidation));
    expect(prompt.endsWith("Recheck my fixes")).toBe(true);
  });

  it("observes an actual dependency edit outside the reported finding after assignment creation", async () => {
    const cwd = path.join(root, "repo");
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true }); fs.mkdirSync(path.join(cwd, "config"));
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "src/auth.ts"), "tenant guard"); fs.writeFileSync(path.join(cwd, "config/policy.ts"), "deny anonymous");
    parent.policy.inputs = ["config", "src"];
    const before = await nativeCapture(cwd, parent.policy.inputs);
    parent.reports[0].source = { before, after: before };
    fs.writeFileSync(path.join(paths.checkpointFilesDir(), `${parent.id.slice(11)}.json`), JSON.stringify(parent));
    const assignment = createCheckpointAssignment(undefined, "Recheck the fixes", parent.id)!;
    fs.writeFileSync(path.join(cwd, "config/policy.ts"), "allow anonymous");
    vi.mocked(source.captureSourceIdentity).mockImplementation(nativeCapture);
    const captured = await captureCheckpointAssignment(assignment, cwd, new AbortController().signal);
    expect(captured.sourceBefore?.fingerprint).not.toBe(before.fingerprint);
    expect(captured.revalidation).toEqual([expect.objectContaining({ reportId: parent.reportId, required: true })]);
    expect(fs.readFileSync(path.join(cwd, "src/auth.ts"), "utf8")).toBe("tenant guard");
  });

  it("rejects deleted queued context before source work and keeps ordinary prompts unchanged", async () => {
    const assignment = createCheckpointAssignment(undefined, "Recheck", parent.id)!;
    await retireCheckpoint(parent.id, "deleted");
    await expect(captureCheckpointAssignment(assignment, root, new AbortController().signal)).rejects.toThrow(/deleted/i);
    expect(source.captureSourceIdentity).not.toHaveBeenCalled();
    expect(continuationPrompt(undefined, "Ordinary task")).toBe("Ordinary task");
    expect(createCheckpointAssignment(undefined, "Ordinary task")).toBeUndefined();
  });
});
