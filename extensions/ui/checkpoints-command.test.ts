import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "../../src/utils/paths";
import * as checkpoints from "../../src/results/specialist-checkpoint";
import { expireCheckpoints } from "../../src/results/checkpoint-retention";
import { registerCheckpointsCommand } from "./checkpoints-command";

let root: string;
async function saved(name: string, expiresAt = Date.now() + 86_400_000) {
  const author = { teamName: "retention", agentName: name, runId: "run", modelSlot: "read-review" as const };
  const reportId = `report:retention:${name}:run`;
  const source = { version: 1 as const, cwd: root, repositoryRoot: root, head: null, inputs: ["src"], fingerprint: "a".repeat(64), fileCount: 0 };
  const record: checkpoints.SpecialistCheckpoint = { version: 1, state: "ready", id: checkpoints.checkpointId(author), author, createdAt: expiresAt - 86_400_000, expiresAt,
    assignment: { original: "Review", current: "Review" }, policy: { inputs: ["src"], retentionDays: 1, decisions: [] }, reportId,
    reports: [{ id: reportId, path: path.join(root, "report.md"), source: { before: source, after: source }, verification: "not-requested", acceptance: "pending" }], findings: [], inspectedEvidence: [], questions: [] };
  await checkpoints.saveCheckpoint(record); return record;
}
function command() {
  const registerCommand = vi.fn(); registerCheckpointsCommand({ registerCommand } as any);
  const ctx = { ui: { notify: vi.fn() } };
  return { ctx, run: (args: string) => registerCommand.mock.calls[0][1].handler(args, ctx) };
}
describe("checkpoint retention controls", () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-controls-")));
    vi.spyOn(paths, "checkpointFilesDir").mockReturnValue(path.join(root, "checkpoints"));
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  it("keeps absent-root inventory and expiry source-free, with actionable unavailable deletion", async () => {
    const { ctx, run } = command(); await run("");
    expect(await expireCheckpoints()).toEqual([]);
    await run(`delete checkpoint:${"a".repeat(64)}`);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/unavailable/i), "warning");
    expect(fs.existsSync(paths.checkpointFilesDir())).toBe(false);
  });

  it("lists records and diagnostics, then retires only the selected payload", async () => {
    const selected = await saved("selected"); const sibling = await saved("sibling"); const corrupt = await saved("corrupt");
    fs.writeFileSync(checkpoints.checkpointPath(corrupt.id), "{corrupt"); fs.writeFileSync(path.join(root, "report.md"), "independent report");
    const { ctx, run } = command(); await run("list");
    const listing = ctx.ui.notify.mock.calls.flat().join(" ");
    expect(listing).toContain(selected.id); expect(listing).toContain(corrupt.id);
    await run(`delete ${selected.id}`);
    expect(JSON.parse(fs.readFileSync(checkpoints.checkpointPath(selected.id), "utf8"))).toEqual({ version: 1, id: selected.id, state: "deleted", retiredAt: expect.any(Number) });
    expect(checkpoints.readCheckpoint(sibling.id)).toEqual(sibling);
    expect(fs.readFileSync(checkpoints.checkpointPath(corrupt.id), "utf8")).toBe("{corrupt");
    expect(fs.readFileSync(path.join(root, "report.md"), "utf8")).toBe("independent report");
  });

  it.each(["delete", "delete invalid", "delete invalid extra"])("rejects invalid command %s without creating storage", async args => {
    const { ctx, run } = command(); await run(args);
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
    expect(fs.existsSync(paths.checkpointFilesDir())).toBe(false);
  });

  it("expires only due ready records and preserves failed, corrupt, unsafe and unrelated siblings", async () => {
    const now = Date.now(); const future = await saved("future", now + 1);
    const due = [await saved("due-a", now), await saved("due-b", now - 1)].sort((a, b) => a.id.localeCompare(b.id));
    const retired = await saved("retired"); await checkpoints.retireCheckpoint(retired.id, "deleted");
    const corrupt = await saved("corrupt"); fs.writeFileSync(checkpoints.checkpointPath(corrupt.id), "{corrupt");
    const unsafe = await saved("unsafe"); const outside = path.join(root, "report.md"); fs.writeFileSync(outside, "independent report");
    fs.unlinkSync(checkpoints.checkpointPath(unsafe.id)); fs.symlinkSync(outside, checkpoints.checkpointPath(unsafe.id));
    const retire = checkpoints.retireCheckpoint;
    vi.spyOn(checkpoints, "retireCheckpoint").mockImplementation((id, state, time) => id === due[0].id ? Promise.reject(new Error("retirement failed")) : retire(id, state, time));
    const diagnostics = await expireCheckpoints(now);
    expect(diagnostics.join(" ")).toMatch(/retirement failed/); expect(diagnostics.join(" ")).toContain(corrupt.id); expect(diagnostics.join(" ")).toMatch(/unsafe/i);
    expect(checkpoints.retireCheckpoint).toHaveBeenCalledWith(due[0].id, "expired", now);
    expect(checkpoints.readCheckpoint(future.id, now)).toEqual(future);
    expect(JSON.parse(fs.readFileSync(checkpoints.checkpointPath(due[0].id), "utf8")).state).toBe("ready");
    expect(JSON.parse(fs.readFileSync(checkpoints.checkpointPath(due[1].id), "utf8")).state).toBe("expired");
    expect(JSON.parse(fs.readFileSync(checkpoints.checkpointPath(retired.id), "utf8")).state).toBe("deleted");
    expect(fs.readFileSync(checkpoints.checkpointPath(corrupt.id), "utf8")).toBe("{corrupt");
    expect(fs.lstatSync(checkpoints.checkpointPath(unsafe.id)).isSymbolicLink()).toBe(true); expect(fs.readFileSync(outside, "utf8")).toBe("independent report");
  });
});
