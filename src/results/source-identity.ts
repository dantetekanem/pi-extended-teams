import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static } from "@sinclair/typebox";

export const SourceIdentitySchema = Type.Object({
  version: Type.Literal(1),
  cwd: Type.String({ minLength: 1 }),
  repositoryRoot: Type.String({ minLength: 1 }),
  head: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  inputs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  fileCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type SourceIdentity = Static<typeof SourceIdentitySchema>;
const execute = promisify(execFile);

function relativeInput(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Source input is outside the repository: ${absolute}`);
  }
  return relative.split(path.sep).join("/") || ".";
}

function fileStamp(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

export async function captureSourceIdentity(
  cwd: string,
  inputs?: string[],
  signal?: AbortSignal,
): Promise<SourceIdentity> {
  signal?.throwIfAborted();
  if (inputs !== undefined && (!Array.isArray(inputs) || !inputs.length
    || inputs.some(input => typeof input !== "string" || !input.length || input.includes("\0")))) {
    throw new Error("Source input scope must contain nonempty literal paths.");
  }
  const canonicalCwd = await fs.promises.realpath(cwd);
  const git = async (args: string[], directory = canonicalCwd): Promise<string> => {
    const { stdout } = await execute("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd: directory, encoding: "buffer", signal, timeout: 10_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    const text = stdout.toString("utf8");
    if (!Buffer.from(text).equals(stdout)) throw new Error("Source identity requires UTF-8 repository paths.");
    return text;
  };
  const repositoryRoot = await fs.promises.realpath((await git(["rev-parse", "--show-toplevel"])).replace(/\n$/, ""));
  const scopes = [...new Set(inputs?.map(input => relativeInput(repositoryRoot, path.resolve(canonicalCwd, input))) ?? ["."])].sort();
  const selected = (file: string) => scopes.some(scope => scope === "." || file === scope || file.startsWith(`${scope}/`));
  const index = await git(["ls-files", "--stage", "-z"], repositoryRoot);
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], repositoryRoot);
  const entries = index.split("\0").filter(Boolean).map(entry => {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error("Invalid Git index listing.");
    return { file: entry.slice(separator + 1), index: entry.slice(0, separator) };
  });
  const files = [...new Set([...entries.map(entry => entry.file), ...untracked.split("\0").filter(Boolean)])].filter(selected).sort();
  for (const scope of scopes) {
    if (inputs && !files.some(file => scope === "." || file === scope || file.startsWith(`${scope}/`))) {
      throw new Error(`No tracked or nonignored source inputs captured for scope: ${scope}`);
    }
  }
  let head: string | null;
  try { head = (await git(["rev-parse", "--verify", "--quiet", "HEAD"], repositoryRoot)).trim(); }
  catch (error) {
    if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== 1) throw error;
    head = null;
  }
  const digest = crypto.createHash("sha256");
  digest.update(JSON.stringify({ version: 1, head, inputs: scopes, index: entries.filter(entry => selected(entry.file)) }));
  const captured = new Set(files);
  for (const file of files) {
    signal?.throwIfAborted();
    const absolute = path.resolve(repositoryRoot, file);
    relativeInput(repositoryRoot, absolute);
    let before: fs.BigIntStats;
    try { before = await fs.promises.lstat(absolute, { bigint: true }); }
    catch (error) {
      if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "ENOENT") throw error;
      digest.update(JSON.stringify([file, "missing"]));
      continue;
    }
    const realPath = await fs.promises.realpath(absolute);
    const target = relativeInput(repositoryRoot, realPath);
    if (before.isSymbolicLink()) {
      if (!captured.has(target) || !(await fs.promises.stat(realPath)).isFile()) {
        throw new Error(`Symlink target is not a captured regular source file: ${file}`);
      }
      digest.update(JSON.stringify([file, "symlink", await fs.promises.readlink(absolute)]));
    } else {
      if (!before.isFile() || realPath !== absolute) throw new Error(`Unsupported source input type or symlink ancestor: ${file}`);
      const content = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(absolute, { signal })) content.update(chunk);
      digest.update(JSON.stringify([file, Number(before.mode & 0o777n), content.digest("hex")]));
    }
    if (fileStamp(before) !== fileStamp(await fs.promises.lstat(absolute, { bigint: true }))) {
      throw new Error(`Source input changed during capture: ${file}`);
    }
  }
  if (index !== await git(["ls-files", "--stage", "-z"], repositoryRoot)
    || untracked !== await git(["ls-files", "--others", "--exclude-standard", "-z"], repositoryRoot)) {
    throw new Error("Source input inventory changed during capture.");
  }
  return { version: 1, cwd: canonicalCwd, repositoryRoot, head, fingerprint: digest.digest("hex"), inputs: scopes, fileCount: files.length };
}

export function sameTestedSource(before: SourceIdentity, after: SourceIdentity): boolean {
  return before.version === after.version && before.cwd === after.cwd
    && before.repositoryRoot === after.repositoryRoot && before.fingerprint === after.fingerprint;
}
