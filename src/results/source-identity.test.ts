import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { captureSourceIdentity, sameTestedSource } from "./source-identity";

let root: string;
let repo: string;
function git(...args: string[]): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}
function put(relative: string, content: string | Buffer): void {
  const file = path.join(repo, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-source-identity-"));
  repo = fs.realpathSync(root);
  git("init", "--quiet");
  put("src/input.ts", "original\n");
  put(".gitignore", "ignored/\n");
  git("add", ".");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("tested source identity", () => {
  it("is repeatable without modifying repository files or the index", async () => {
    const index = fs.readFileSync(path.join(repo, ".git/index"));
    const before = await captureSourceIdentity(repo);
    expect(before).toMatchObject({ version: 1, cwd: repo, repositoryRoot: repo, head: null, fileCount: 2, inputs: ["."] });
    expect(before.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(await captureSourceIdentity(path.join(repo, "src", ".."))).toEqual(before);
    expect(fs.readFileSync(path.join(repo, ".git/index"))).toEqual(index);
    expect(fs.readFileSync(path.join(repo, "src/input.ts"), "utf8")).toBe("original\n");
  });

  it.each([" ", "\n"])("preserves trailing repository-path characters: %j", async suffix => {
    const renamed = `${repo}${suffix}`;
    fs.renameSync(repo, renamed);
    root = renamed;
    repo = fs.realpathSync(renamed);
    expect(await captureSourceIdentity(repo)).toMatchObject({ cwd: repo, repositoryRoot: repo });
  });

  it("detects dirty bytes, index changes and untracked binary content without a commit", async () => {
    const first = await captureSourceIdentity(repo);
    put("src/input.ts", "modified\n");
    const dirty = await captureSourceIdentity(repo);
    expect(sameTestedSource(first, dirty)).toBe(false);
    git("add", "src/input.ts");
    const staged = await captureSourceIdentity(repo);
    expect(sameTestedSource(dirty, staged)).toBe(false);
    put("new\nfile.bin", Buffer.from([0, 255, 1]));
    const untracked = await captureSourceIdentity(repo);
    expect(untracked.fileCount).toBe(3);
    expect(sameTestedSource(staged, untracked)).toBe(false);
    put("new\nfile.bin", Buffer.from([0, 255, 2]));
    expect(sameTestedSource(untracked, await captureSourceIdentity(repo))).toBe(false);
  });

  it("detects deletion and executable-mode changes", async () => {
    const first = await captureSourceIdentity(repo);
    fs.chmodSync(path.join(repo, "src/input.ts"), 0o755);
    const executable = await captureSourceIdentity(repo);
    expect(sameTestedSource(first, executable)).toBe(false);
    fs.unlinkSync(path.join(repo, "src/input.ts"));
    expect(sameTestedSource(executable, await captureSourceIdentity(repo))).toBe(false);
  });

  it("defaults to the entire repository and supports explicit literal input scopes", async () => {
    const cwd = path.join(repo, "src");
    const all = await captureSourceIdentity(cwd);
    const scoped = await captureSourceIdentity(cwd, ["."]);
    expect(scoped.inputs).toEqual(["src"]);
    put("sibling.ts", "outside explicit scope");
    expect(sameTestedSource(all, await captureSourceIdentity(cwd))).toBe(false);
    expect(await captureSourceIdentity(cwd, ["."])).toEqual(scoped);
    const includingSibling = await captureSourceIdentity(cwd);
    put("ignored/output", "not covered");
    expect(await captureSourceIdentity(cwd)).toEqual(includingSibling);
    expect(await captureSourceIdentity(cwd, ["."])).toEqual(scoped);
    await expect(captureSourceIdentity(repo, ["../escape"])).rejects.toThrow(/outside/i);
    await expect(captureSourceIdentity(repo, ["ignored"])).rejects.toThrow(/captured|scope/i);
  });

  it("captures symlink identity only when its regular-file target is also in scope", async () => {
    fs.symlinkSync("src/input.ts", path.join(repo, "link.ts"));
    const before = await captureSourceIdentity(repo);
    expect(before.fileCount).toBe(3);
    await expect(captureSourceIdentity(repo, ["link.ts"])).rejects.toThrow(/symlink|target/i);
    fs.unlinkSync(path.join(repo, "link.ts"));
    fs.symlinkSync(".git/config", path.join(repo, "link.ts"));
    await expect(captureSourceIdentity(repo)).rejects.toThrow(/symlink|target/i);
  });

  it("rejects unsupported repositories and pre-cancelled capture", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "teams-source-outside-"));
    try { await expect(captureSourceIdentity(outside)).rejects.toThrow(/git|repository/i); }
    finally { fs.rmSync(outside, { recursive: true, force: true }); }
    await expect(captureSourceIdentity(repo, undefined, AbortSignal.abort())).rejects.toThrow();
  });
});
