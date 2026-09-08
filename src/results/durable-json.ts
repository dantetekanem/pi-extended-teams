import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function syncPath(file: string): void {
  const descriptor = fs.openSync(file, "r");
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

export function syncPathAndParents(file: string): void {
  for (let current = file; ; current = path.dirname(current)) {
    syncPath(current);
    if (path.dirname(current) === current) return;
  }
}

export function writeJsonDurably(file: string, value: unknown): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    syncPath(temporary);
    fs.renameSync(temporary, file);
    syncPathAndParents(path.dirname(file));
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}
