import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Write JSON state by staging a temp file and renaming it into place.
 *
 * `fs.writeFileSync` opens with `O_TRUNC`, so a crash between truncate and write
 * leaves a zero-byte file. For the shared JSON state files that is not a lost
 * write but a wedged team: readers either silently see empty state (claims) or
 * throw on every subsequent operation (shared memory, inboxes). `rename` is
 * atomic, so a reader sees either the old file or the new one.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors; preserve the original write/rename failure.
    }
    throw e;
  }
}
