import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../utils/paths";
import { CheckJournal, type AssignedCheck } from "./check-journal";

let root: string;
let journal: CheckJournal;
const assignment: AssignedCheck = {
  taskId: "task:team:reader:run", runId: "run", reportId: "report:team:reader:run", name: "tests",
  command: "run trusted checks", cwd: "/workspace", timeoutSeconds: 30, attempt: 1,
};
const source = {
  version: 1 as const, cwd: "/workspace", repositoryRoot: "/workspace", head: null,
  fingerprint: "a".repeat(64), inputs: ["."], fileCount: 1,
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-check-journal-"));
  vi.spyOn(paths, "teamDir").mockReturnValue(root);
  journal = new CheckJournal("team");
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

describe("durable assigned-check journal", () => {
  it("grants one concurrent claim and does not regrant it after reload", async () => {
    const claims = await Promise.all([journal.claim(assignment), journal.claim({ ...assignment })]);
    expect(claims.map(claim => claim.claimed).sort()).toEqual([false, true]);
    expect(claims[0].record.checkId).toBe(claims[1].record.checkId);
    const recovered = await new CheckJournal("team").claim(assignment);
    expect(recovered).toMatchObject({ claimed: false, record: { state: "claimed", assignment } });
    const stored = fs.readdirSync(path.join(root, "checks")).filter(file => file.endsWith(".json"));
    expect(stored).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(root, "checks", stored[0]), "utf8")).state).toBe("claimed");
    expect(fs.statSync(path.join(root, "checks")).mode & 0o777).toBe(0o700);
  });

  it("rejects rebinding an identity and gives explicit attempts distinct identities", async () => {
    const first = await journal.claim(assignment);
    await expect(journal.claim({ ...assignment, command: "different command" })).rejects.toThrow(/assignment|binding/i);
    const retry = await journal.claim({ ...assignment, attempt: 2 });
    expect(retry.claimed).toBe(true);
    expect(retry.record.checkId).not.toBe(first.record.checkId);
    const named = await journal.claim({ ...assignment, name: "../../escape" });
    expect(path.dirname(named.record.logPath)).toBe(path.join(root, "checks"));
    await expect(journal.read("../../escape")).rejects.toThrow(/identity/i);
  });

  it("requires the claim token and preserves the first completed observation without aliasing", async () => {
    const { record } = await journal.claim(assignment);
    const completion = { state: "passed" as const, completedAt: Date.now(), exitCode: 0, logBytes: 123, sourceBefore: structuredClone(source), sourceAfter: structuredClone(source) };
    await expect(journal.finish(record.checkId, "stale-owner", completion)).rejects.toThrow(/claim/i);
    const done = await journal.finish(record.checkId, record.claimToken, completion);
    completion.sourceAfter.inputs.push("mutated input");
    done.assignment.command = "mutated result";
    const replay = await journal.finish(record.checkId, record.claimToken, { state: "failed", completedAt: Date.now(), exitCode: 1, logBytes: 0 });
    expect(replay).toMatchObject({ state: "passed", assignment, sourceAfter: { inputs: ["."] }, logBytes: 123 });
  });

  it("rejects passed claims without successful execution and matching source evidence", async () => {
    const { record } = await journal.claim(assignment);
    await expect(journal.finish(record.checkId, record.claimToken, {
      state: "passed", completedAt: Date.now(), exitCode: null, logBytes: 0,
    })).rejects.toThrow(/passed|evidence/i);
    await expect(journal.finish(record.checkId, record.claimToken, {
      state: "passed", completedAt: Date.now(), exitCode: 0, logBytes: 0,
      sourceBefore: source, sourceAfter: { ...source, fingerprint: "b".repeat(64) },
    })).rejects.toThrow(/passed|evidence/i);
    expect((await journal.read(record.checkId))?.state).toBe("claimed");
  });

  it.each(["file", "directory"])("does not acknowledge completion when %s sync fails", async kind => {
    const { record } = await journal.claim(assignment);
    const sync = fs.fsyncSync;
    const failingSync = vi.spyOn(fs, "fsyncSync").mockImplementation(descriptor => {
      if (fs.fstatSync(descriptor).isDirectory() === (kind === "directory")) throw new Error("sync unavailable");
      sync(descriptor);
    });
    const completion = { state: "failed" as const, completedAt: Date.now(), exitCode: 1, logBytes: 0 };
    await expect(journal.finish(record.checkId, record.claimToken, completion)).rejects.toThrow("sync unavailable");
    await expect(journal.finish(record.checkId, record.claimToken, completion)).rejects.toThrow("sync unavailable");
    failingSync.mockRestore();
    expect(await journal.finish(record.checkId, record.claimToken, completion)).toMatchObject({ state: "failed" });
    expect(fs.readdirSync(path.join(root, "checks")).filter(file => file.endsWith(".tmp"))).toEqual([]);
  });

  it("isolates incompatible records and preserves claimed state after a failed durable finish", async () => {
    const { record } = await journal.claim(assignment);
    const other = await journal.claim({ ...assignment, name: "other" });
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    await expect(journal.finish(record.checkId, record.claimToken, { state: "failed", completedAt: Date.now(), logBytes: 0 })).rejects.toThrow("disk unavailable");
    rename.mockRestore();
    expect((await journal.read(record.checkId))?.state).toBe("claimed");
    fs.writeFileSync(record.logPath.replace(/\.log$/, ".json"), JSON.stringify({ version: 99 }));
    await expect(journal.read(record.checkId)).rejects.toThrow(/incompatible|corrupt/i);
    expect(await journal.read(other.record.checkId)).toEqual(other.record);
  });
});
