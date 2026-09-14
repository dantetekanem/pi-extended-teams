import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as paths from "../utils/paths";

export function freshContinuationName(prefix: string, nonce?: string): string {
  paths.sanitizeName(prefix);
  if (!prefix || prefix.length > 128) throw new Error("Continuation name prefix must contain 1–128 characters.");
  const suffix = nonce === undefined ? crypto.randomUUID() : crypto.createHash("sha256").update(nonce).digest("hex").slice(0, 32);
  return `${prefix}-${suffix}`;
}

export function assertUnusedContinuationRecipient(teamName: string, candidate: string): void {
  paths.sanitizeName(candidate);
  const directory = paths.teamDir(teamName);
  const collision = () => { throw new Error(`Continuation recipient ${candidate} is not unused; choose a new prefix and retry.`); };
  const exists = (file: string) => !!fs.lstatSync(file, { throwIfNoEntry: false });
  for (const file of [paths.inboxPath(teamName, candidate), paths.runtimeStatusPath(teamName, candidate), paths.lifecycleTombstonePath(teamName, candidate),
    path.join(directory, `${candidate}.pid`), path.join(directory, "agent-sessions", candidate)]) if (exists(file)) collision();
  for (const [folder, matches] of [
    [path.join(directory, "session-context"), (name: string) => name.startsWith(`${candidate.toLowerCase()}--`)],
    [path.join(paths.reportFilesDir(), paths.sanitizeName(teamName)), (name: string) => name === `${candidate.toLowerCase()}.md` || name.startsWith(`${candidate.toLowerCase()}-v`)],
  ] as const) if (exists(folder) && fs.readdirSync(folder).some(name => matches(name.toLowerCase()))) collision();
  for (const [file, key, array] of [[paths.claimsPath(teamName), "agent", false], [paths.writeQueuePath(teamName), "name", true],
    [paths.readHelperQueuePath(teamName), "name", true], [path.join(directory, "reports.json"), "agentName", true]] as const) {
    if (!exists(file)) continue;
    let rows: unknown[];
    try {
      if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error("Not a regular namespace record");
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) !== array) throw new Error("Invalid namespace record");
      rows = array ? value : Object.values(value);
      if (rows.some(row => !row || typeof row !== "object" || typeof Reflect.get(row, key) !== "string")) throw new Error("Invalid namespace owner");
    } catch { throw new Error(`Cannot establish an unused continuation namespace; inspect ${file}.`); }
    if (rows.some(row => String(Reflect.get(row as object, key)).toLowerCase() === candidate.toLowerCase())) collision();
  }
}
