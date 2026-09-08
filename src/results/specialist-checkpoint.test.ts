import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReportResult } from "./report-result";
import {
  checkpointId, checkpointPath, listCheckpointRecords, MAX_CHECKPOINT_BYTES,
  readCheckpoint, resyncCheckpoint, retireCheckpoint, saveCheckpoint, type SpecialistCheckpoint,
} from "./specialist-checkpoint";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../utils/paths", async original => ({
  ...await original<typeof import("../utils/paths")>(),
  checkpointFilesDir: () => path.join(fixture.root, "checkpoints"),
}));
const now = 1_800_000_000_000;
const day = 86_400_000;

function record(runId = "run-1"): SpecialistCheckpoint {
  const author = { teamName: "review", agentName: "authentication", runId, modelSlot: "read-review" as const };
  const reportId = createReportResult(author.teamName, author.agentName, runId, {}).reportId;
  const source = { version: 1 as const, cwd: "/repo", repositoryRoot: "/repo", head: null,
    fingerprint: "a".repeat(64), inputs: ["src/auth", "src/policy.ts"], fileCount: 3 };
  return {
    version: 1, state: "ready", id: checkpointId(author), author, createdAt: now, expiresAt: now + 30 * day,
    assignment: { original: "Review authentication.", current: "Review authentication." },
    policy: { inputs: ["src/auth", "src/policy.ts"], retentionDays: 30, decisions: ["Anonymous requests stay denied."] },
    reportId,
    reports: [{ id: reportId, path: "/reports/authentication.md", source: { before: source, after: structuredClone(source) }, verification: "not-requested", acceptance: "pending" }],
    findings: [{ id: "F1", text: "Check the anonymous request path.", evidence: ["src/auth:12"], reportId }],
    inspectedEvidence: [{ reference: "src/policy.ts:1-20", reportId }],
    questions: ["Does the policy apply to background jobs?"],
  };
}

beforeEach(() => { fixture.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-specialist-checkpoint-"))); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

describe("specialist checkpoint storage", () => {
  it("does not create storage when checkpointing is omitted", async () => {
    expect(await saveCheckpoint(undefined)).toBeUndefined();
    expect(listCheckpointRecords()).toEqual({ records: [], errors: [] });
    expect(fs.readdirSync(fixture.root)).toEqual([]);
  });

  it("retains assignment, source and reported evidence independently in private storage", async () => {
    const expected = record();
    expect(await saveCheckpoint(expected)).toEqual(expected);
    expect(readCheckpoint(expected.id, now)).toEqual(expected);
    expect(fs.statSync(checkpointPath(expected.id)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(checkpointPath(expected.id))).mode & 0o777).toBe(0o700);
    expect(listCheckpointRecords()).toEqual({ records: [expected], errors: [] });
  });

  it("isolates caller mutations and concurrent duplicate receipts", async () => {
    const input = record();
    const expected = structuredClone(input);
    const first = saveCheckpoint(input);
    input.findings[0].text = "Caller mutation";
    const saved = await first;
    if (saved?.state !== "ready") throw new Error("Missing ready receipt");
    saved.policy.decisions.length = 0;
    await Promise.all([saveCheckpoint(expected), saveCheckpoint(expected)]);
    const read = readCheckpoint(expected.id, now);
    read.findings.length = 0;
    expect(readCheckpoint(expected.id, now)).toEqual(expected);
    expect(fs.readdirSync(path.dirname(checkpointPath(expected.id)))).toEqual([path.basename(checkpointPath(expected.id))]);
  });

  it.each(["parent", "report decisions"])("accepts equivalent replay after JSON omits undefined %s", async field => {
    const expected = record(); const input = structuredClone(expected);
    if (field === "parent") input.parentId = undefined; else input.reports[0].leadDecisions = undefined;
    await saveCheckpoint(input);
    expect(await saveCheckpoint(input)).toStrictEqual(expected);
    expect(await saveCheckpoint(expected)).toStrictEqual(expected);
  });

  it("rejects changes to the first saved report without replacing it", async () => {
    const original = record();
    await saveCheckpoint(original);
    const changed = structuredClone(original);
    changed.findings[0].text = "Different claim";
    await expect(saveCheckpoint(changed)).rejects.toThrow(/immutable/);
    expect(readCheckpoint(original.id, now)).toEqual(original);
  });

  const invalidRecords: Array<[string, (value: SpecialistCheckpoint) => unknown]> = [
    ["version", value => ({ ...value, version: 2 })],
    ["extra authority", value => ({ ...value, execute: "test" })],
    ["author run", value => ({ ...value, author: { ...value.author, runId: "other-run" } })],
    ["legacy tier", value => ({ ...value, author: { ...value.author, modelSlot: "reading-default" } })],
    ["report binding", value => ({ ...value, reportId: "report:another:agent:run" })],
    ["finding provenance", value => ({ ...value, findings: [{ ...value.findings[0], reportId: "unknown" }] })],
    ["inspected provenance", value => ({ ...value, inspectedEvidence: [{ reference: "src/a", reportId: "unknown" }] })],
    ["duplicate finding", value => ({ ...value, findings: [...value.findings, ...value.findings] })],
    ["duplicate report", value => ({ ...value, reports: [...value.reports, ...value.reports] })],
    ["source binding", value => ({ ...value, reports: [{ ...value.reports[0], source: { before: value.reports[0].source.before, after: { ...value.reports[0].source.after, cwd: "/other" } } }] })],
    ["current input scope", value => ({ ...value, policy: { ...value.policy, inputs: ["src/other"] } })],
    ["relative report reference", value => ({ ...value, reports: [{ ...value.reports[0], path: "../report.md" }] })],
    ["relative source roots", value => ({ ...value, reports: [{ ...value.reports[0], source: { before: { ...value.reports[0].source.before, cwd: "repo", repositoryRoot: "repo" }, after: { ...value.reports[0].source.after, cwd: "repo", repositoryRoot: "repo" } } }] })],
    ["retention binding", value => ({ ...value, expiresAt: value.expiresAt + day })],
    ["self parent", value => ({ ...value, parentId: value.id })],
    ["oversized assignment", value => ({ ...value, assignment: { original: "x".repeat(16_385), current: "Current" } })],
    ["oversized record", value => ({ ...value, findings: Array.from({ length: 30 }, (_, i) => ({ ...value.findings[0], id: `F${i}`, text: "x".repeat(4_000) })) })],
  ];
  it.each(invalidRecords)("rejects invalid %s before creating storage", async (_label, change) => {
    await expect(saveCheckpoint(change(record()))).rejects.toThrow(/Invalid.*checkpoint/);
    expect(fs.readdirSync(fixture.root)).toEqual([]);
  });

  it("keeps a missing lookup read-only and rejects path-like IDs", () => {
    expect(() => readCheckpoint(record().id, now)).toThrow(/unavailable/);
    expect(() => checkpointPath("../../outside")).toThrow(/Invalid checkpoint ID/);
    expect(() => checkpointPath(`${record().id}\n`)).toThrow(/Invalid checkpoint ID/);
    expect(fs.readdirSync(fixture.root)).toEqual([]);
  });

  it("isolates corrupt and incompatible records from valid siblings", async () => {
    const valid = record();
    const corrupt = record("corrupt");
    const incompatible = record("incompatible");
    await saveCheckpoint(valid);
    fs.writeFileSync(checkpointPath(corrupt.id), "{broken");
    fs.writeFileSync(checkpointPath(incompatible.id), JSON.stringify({ ...incompatible, version: 2 }));
    expect(() => readCheckpoint(corrupt.id, now)).toThrow(/corrupt or incompatible/);
    const inventory = listCheckpointRecords();
    expect(inventory.records).toEqual([valid]);
    expect(inventory.errors.map(error => error.id).sort()).toEqual([corrupt.id, incompatible.id].sort());
    expect(readCheckpoint(valid.id, now)).toEqual(valid);
    expect(fs.readFileSync(checkpointPath(corrupt.id), "utf8")).toBe("{broken");
  });

  it("requires re-sync after a post-rename save failure, including omitted report decisions and a fresh module", async () => {
    const expected = record(); const input = structuredClone(expected);
    input.reports[0].leadDecisions = undefined;
    const realSync = fs.fsyncSync;
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("checkpoint receipt uncertain");
      realSync(fd);
    });
    await expect(saveCheckpoint(input)).rejects.toThrow("checkpoint receipt uncertain");
    expect(readCheckpoint(expected.id, now)).toStrictEqual(expected);
    vi.resetModules();
    const fresh = await import("./specialist-checkpoint.js");
    await expect(fresh.saveCheckpoint(input)).rejects.toThrow("checkpoint receipt uncertain");
    sync.mockRestore();
    expect(await fresh.saveCheckpoint(input)).toStrictEqual(expected);
  });

  it("deletes only the selected payload and prevents replay from restoring it", async () => {
    const selected = record();
    const sibling = record("run-2");
    await saveCheckpoint(selected);
    await saveCheckpoint(sibling);
    const retired = await retireCheckpoint(selected.id, "deleted", now + 1);
    expect(retired).toEqual({ version: 1, id: selected.id, state: "deleted", retiredAt: now + 1 });
    expect(await saveCheckpoint(selected)).toEqual(retired);
    expect(() => readCheckpoint(selected.id, now + 2)).toThrow(/deleted/);
    expect(readCheckpoint(sibling.id, now + 2)).toEqual(sibling);
    expect(JSON.parse(fs.readFileSync(checkpointPath(selected.id), "utf8"))).toEqual(retired);
  });

  it("re-syncs exact ready and retired receipts without rebuilding report evidence", async () => {
    const expected = record();
    await saveCheckpoint(expected);
    expect(await resyncCheckpoint(expected.id)).toEqual(expected);
    const retired = await retireCheckpoint(expected.id, "deleted", now);
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("receipt uncertain"); });
    await expect(resyncCheckpoint(expected.id)).rejects.toThrow("receipt uncertain");
    sync.mockRestore();
    expect(await resyncCheckpoint(expected.id)).toEqual(retired);
    await expect(resyncCheckpoint(record("missing").id)).rejects.toThrow(/unavailable/);
  });

  it("expires only at the retention boundary and keeps retirement immutable", async () => {
    const expected = record();
    await saveCheckpoint(expected);
    expect(readCheckpoint(expected.id, expected.expiresAt - 1)).toEqual(expected);
    expect(() => readCheckpoint(expected.id, expected.expiresAt)).toThrow(/expired/);
    await expect(retireCheckpoint(expected.id, "expired", expected.expiresAt - 1)).rejects.toThrow(/not expired/);
    const retired = await retireCheckpoint(expected.id, "expired", expected.expiresAt);
    expect(await retireCheckpoint(expected.id, "deleted", expected.expiresAt + 1)).toEqual(retired);
    expect(await saveCheckpoint(expected)).toEqual(retired);
  });

  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])("rejects invalid observation time %s", async clock => {
    const expected = record();
    await saveCheckpoint(expected);
    expect(() => readCheckpoint(expected.id, clock)).toThrow(/Invalid checkpoint observation time/);
  });

  it("accepts repository-relative observations for a scoped subdirectory", async () => {
    const expected = record();
    expected.policy.inputs = ["auth", "policy.ts"];
    expected.reports[0].source.before.cwd = "/repo/src";
    expected.reports[0].source.after.cwd = "/repo/src";
    expect(await saveCheckpoint(expected)).toEqual(expected);
    expect(readCheckpoint(expected.id, now)).toEqual(expected);
  });

  it("does not acknowledge uncertain deletion on a no-op retry", async () => {
    const expected = record();
    await saveCheckpoint(expected);
    const realSync = fs.fsyncSync;
    const sync = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error("deletion receipt uncertain");
      realSync(fd);
    });
    await expect(retireCheckpoint(expected.id, "deleted", now)).rejects.toThrow("deletion receipt uncertain");
    await expect(retireCheckpoint(expected.id, "deleted", now + 1)).rejects.toThrow("deletion receipt uncertain");
    sync.mockRestore();
    expect((await retireCheckpoint(expected.id, "deleted", now + 2)).state).toBe("deleted");
  });

  it("allows exact deletion of corrupt data but never automatic expiry of it", async () => {
    const expected = record();
    await saveCheckpoint(expected);
    fs.writeFileSync(checkpointPath(expected.id), "{broken");
    await expect(retireCheckpoint(expected.id, "expired", expected.expiresAt)).rejects.toThrow(/corrupt or incompatible/);
    expect((await retireCheckpoint(expected.id, "deleted", now)).state).toBe("deleted");
    expect(await saveCheckpoint(expected)).toMatchObject({ state: "deleted" });
  });

  it("refuses symlink records and preserves the outside target", async () => {
    const expected = record();
    fs.mkdirSync(path.dirname(checkpointPath(expected.id)), { mode: 0o700 });
    const outside = path.join(fixture.root, "outside.json");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, checkpointPath(expected.id));
    expect(() => readCheckpoint(expected.id, now)).toThrow(/Unsafe/);
    await expect(saveCheckpoint(expected)).rejects.toThrow(/Unsafe/);
    await expect(retireCheckpoint(expected.id, "deleted", now)).rejects.toThrow(/Unsafe/);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it("rejects symlink roots before writing into them", async () => {
    const expected = record();
    const outside = path.join(fixture.root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.dirname(checkpointPath(expected.id)));
    await expect(saveCheckpoint(expected)).rejects.toThrow(/Unsafe/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("keeps reads bounded when a record grows after the size check", async () => {
    const expected = record();
    await saveCheckpoint(expected);
    const stat = fs.fstatSync;
    let grew = false;
    vi.spyOn(fs, "fstatSync").mockImplementation(fd => {
      const snapshot = stat(fd);
      if (snapshot.isFile() && !grew) {
        grew = true;
        fs.appendFileSync(checkpointPath(expected.id), " ".repeat(MAX_CHECKPOINT_BYTES));
      }
      return snapshot;
    });
    expect(() => readCheckpoint(expected.id, now)).toThrow(/too large/);
    expect(grew).toBe(true);
  });

  it("bounds disk reads before parsing oversized records", async () => {
    const expected = record();
    await saveCheckpoint(expected);
    fs.writeFileSync(checkpointPath(expected.id), " ".repeat(MAX_CHECKPOINT_BYTES + 1));
    const read = vi.spyOn(fs, "readFileSync");
    expect(() => readCheckpoint(expected.id, now)).toThrow(/too large/);
    expect(read).not.toHaveBeenCalled();
  });
});
