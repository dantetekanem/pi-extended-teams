import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as paths from "../utils/paths";
import { CheckJournal, type AssignedCheck } from "./check-journal";
import { readCurrentCheck, runAssignedCheck, type CheckOperations } from "./check-runner";

let root: string;
let repo: string;
let journal: CheckJournal;
let assignment: AssignedCheck;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-check-runner-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "input.ts"), "source");
  vi.spyOn(paths, "teamDir").mockReturnValue(path.join(root, "private"));
  journal = new CheckJournal("team");
  assignment = { taskId: "task:team:reader:run", runId: "run", reportId: "report:team:reader:run",
    name: "tests", command: "trusted command", cwd: repo, timeoutSeconds: 2, attempt: 1 };
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

function loader(exec: CheckOperations["exec"]) { return async () => ({ exec }); }

describe("source-bound observed checks", () => {
  it("syncs claim contents and publication directories before native execution", async () => {
    const order: string[] = [];
    const sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(descriptor => {
      order.push(fs.fstatSync(descriptor).isDirectory() ? "directory-sync" : "file-sync");
      sync(descriptor);
    });
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      order.push("rename"); rename(from, to);
    });
    await runAssignedCheck(journal, assignment, { loadOperations: loader(async () => {
      order.push("execute"); return { exitCode: 0 };
    }) });
    expect(order.indexOf("file-sync")).toBeLessThan(order.indexOf("rename"));
    expect(order.indexOf("rename")).toBeLessThan(order.indexOf("directory-sync"));
    expect(order.indexOf("directory-sync")).toBeLessThan(order.indexOf("execute"));
  });

  it.each(["file", "directory"])("does not execute if claim %s sync fails", async kind => {
    const sync = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(descriptor => {
      if (fs.fstatSync(descriptor).isDirectory() === (kind === "directory")) throw new Error("sync unavailable");
      sync(descriptor);
    });
    const loadOperations = vi.fn();
    await expect(runAssignedCheck(journal, assignment, { loadOperations })).rejects.toThrow("sync unavailable");
    expect(loadOperations).not.toHaveBeenCalled();
  });

  it("claims before executing the assigned command and retains full private output", async () => {
    const output = Buffer.alloc(100_000, "x");
    const exec = vi.fn<CheckOperations["exec"]>(async (command, cwd, options) => {
      const claim = await journal.claim(assignment);
      expect(claim).toMatchObject({ claimed: false, record: { state: "claimed" } });
      expect(command).toBe("trusted command");
      expect(cwd).toBe(fs.realpathSync(repo));
      expect(options.timeout).toBe(2);
      options.onData(output);
      options.onData(Buffer.from("\nend"));
      return { exitCode: 0 };
    });
    const record = await runAssignedCheck(journal, assignment, { loadOperations: loader(exec) });
    expect(record).toMatchObject({ state: "passed", exitCode: 0, logBytes: 100_004 });
    expect(fs.readFileSync(record.logPath)).toEqual(Buffer.concat([output, Buffer.from("\nend")]));
    expect(fs.statSync(record.logPath).mode & 0o777).toBe(0o600);
    expect(await journal.read(record.checkId)).toEqual(record);
    expect(await runAssignedCheck(new CheckJournal("team"), assignment, { loadOperations: loader(exec) })).toEqual(record);
    expect(exec).toHaveBeenCalledOnce();
  });

  it.each([
    { exitCode: 1, state: "failed" }, { exitCode: null, state: "error" },
  ])("does not pass an unsuccessful or unknown exit: $exitCode", async ({ exitCode, state }) => {
    const record = await runAssignedCheck(journal, assignment, { loadOperations: loader(async () => ({ exitCode })) });
    expect(record).toMatchObject({ state, exitCode });
  });

  it("marks inputs changed by the command stale and checks later source drift without rerunning", async () => {
    const first = await runAssignedCheck(journal, assignment, { loadOperations: loader(async () => ({ exitCode: 0 })) });
    fs.writeFileSync(path.join(repo, "input.ts"), "changed after testing");
    expect(await readCurrentCheck(journal, first.checkId)).toMatchObject({ state: "stale" });
    expect((await journal.read(first.checkId))?.state).toBe("passed");
    const second = await runAssignedCheck(journal, { ...assignment, attempt: 2 }, { loadOperations: loader(async () => {
      fs.writeFileSync(path.join(repo, "untracked.ts"), "created by command");
      return { exitCode: 0 };
    }) });
    expect(second).toMatchObject({ state: "stale", exitCode: 0 });
    expect(second.sourceBefore?.fingerprint).not.toBe(second.sourceAfter?.fingerprint);
  });

  it("never replays a claimed attempt after reload", async () => {
    const { record } = await journal.claim(assignment);
    const loadOperations = vi.fn();
    expect(await runAssignedCheck(new CheckJournal("team"), assignment, { loadOperations })).toEqual(record);
    expect(loadOperations).not.toHaveBeenCalled();
  });

  it("records unsupported runtimes and pre-cancelled checks without executing", async () => {
    const unsupported = await runAssignedCheck(journal, assignment, { loadOperations: async () => undefined });
    expect(unsupported).toMatchObject({ state: "unsupported", error: expect.stringMatching(/native|Pi/i) });
    const loadOperations = vi.fn();
    const cancelled = await runAssignedCheck(journal, { ...assignment, attempt: 2 }, { loadOperations, signal: AbortSignal.abort() });
    expect(cancelled.state).toBe("cancelled");
    expect(loadOperations).not.toHaveBeenCalled();
  });

  it("preserves timeout output and cannot pass after cancellation even if the port returns zero", async () => {
    const timeout = await runAssignedCheck(journal, assignment, { loadOperations: loader(async (_command, _cwd, options) => {
      options.onData(Buffer.from("before timeout"));
      throw new Error("timeout:2");
    }) });
    expect(timeout.state).toBe("timed-out");
    expect(fs.readFileSync(timeout.logPath, "utf8")).toBe("before timeout");
    const controller = new AbortController();
    const cancelled = await runAssignedCheck(journal, { ...assignment, attempt: 2 }, {
      signal: controller.signal, loadOperations: loader(async () => { controller.abort(); return { exitCode: 0 }; }),
    });
    expect(cancelled.state).toBe("cancelled");
  });

  it("aborts on log failure without throwing out of the streaming callback or claiming success", async () => {
    const appendOriginal = fs.appendFileSync;
    const append = vi.spyOn(fs, "appendFileSync").mockImplementationOnce(descriptor => {
      appendOriginal(descriptor, "lo");
      throw new Error("log disk full");
    });
    const result = await runAssignedCheck(journal, assignment, { loadOperations: loader(async (_command, _cwd, options) => {
      expect(() => options.onData(Buffer.from("lost"))).not.toThrow();
      expect(options.signal?.aborted).toBe(true);
      return { exitCode: 0 };
    }) });
    append.mockRestore();
    expect(result).toMatchObject({ state: "error", logBytes: 2, error: expect.stringContaining("log disk full") });
    expect(fs.readFileSync(result.logPath, "utf8")).toBe("lo");
  });
});
