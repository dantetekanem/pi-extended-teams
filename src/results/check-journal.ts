import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as paths from "../utils/paths";
import { withLock } from "../utils/lock";
import { sameTestedSource, SourceIdentitySchema } from "./source-identity";

const text = Type.String({ minLength: 1, pattern: "\\S" });
export const AssignedCheckSchema = Type.Object({
  taskId: text, runId: text, reportId: text, name: text, command: text, cwd: text,
  timeoutSeconds: Type.Number({ exclusiveMinimum: 0, maximum: 2_147_483.647 }),
  attempt: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  inputs: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
}, { additionalProperties: false });
export type AssignedCheck = Static<typeof AssignedCheckSchema>;

const CheckRecordSchema = Type.Object({
  version: Type.Literal(1),
  checkId: Type.String({ pattern: "^check:[a-f0-9]{64}$" }),
  claimToken: text,
  assignment: AssignedCheckSchema,
  state: Type.Union([
    Type.Literal("claimed"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("cancelled"),
    Type.Literal("timed-out"), Type.Literal("stale"), Type.Literal("unsupported"), Type.Literal("error"),
  ]),
  startedAt: Type.Number({ minimum: 0 }),
  completedAt: Type.Optional(Type.Number({ minimum: 0 })),
  sourceBefore: Type.Optional(SourceIdentitySchema),
  sourceAfter: Type.Optional(SourceIdentitySchema),
  exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  logPath: text,
  logBytes: Type.Integer({ minimum: 0 }),
  error: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type CheckRecord = Static<typeof CheckRecordSchema>;
export type CheckCompletion = Pick<CheckRecord, "sourceBefore" | "sourceAfter" | "exitCode" | "logBytes" | "error"> & {
  state: Exclude<CheckRecord["state"], "claimed">;
  completedAt: number;
};

export function checkIdentity(assignment: Pick<AssignedCheck, "reportId" | "name" | "attempt">): string {
  return `check:${crypto.createHash("sha256").update(JSON.stringify([
    assignment.reportId, assignment.name, assignment.attempt,
  ])).digest("hex")}`;
}

function assignmentBinding(assignment: AssignedCheck): string {
  return JSON.stringify([
    assignment.taskId, assignment.runId, assignment.reportId, assignment.name, assignment.command,
    assignment.cwd, assignment.timeoutSeconds, assignment.attempt, assignment.inputs ?? null,
  ]);
}

function normalizeAssignment(value: unknown): AssignedCheck {
  if (!Value.Check(AssignedCheckSchema, value)) throw new Error("Invalid assigned check.");
  const result = structuredClone(value);
  if (result.inputs) result.inputs = [...new Set(result.inputs)].sort();
  return result;
}

function parseRecord(value: unknown): CheckRecord {
  if (!Value.Check(CheckRecordSchema, value)) throw new Error("Corrupt or incompatible check record.");
  if (value.checkId !== checkIdentity(value.assignment)) throw new Error("Corrupt check identity binding.");
  if ((value.state === "claimed") !== (value.completedAt === undefined)) throw new Error("Corrupt check completion state.");
  if (value.state === "passed" && (value.exitCode !== 0 || value.error !== undefined
    || !value.sourceBefore || !value.sourceAfter || !sameTestedSource(value.sourceBefore, value.sourceAfter))) {
    throw new Error("A passed check requires successful execution and matching source evidence.");
  }
  return structuredClone(value);
}

function syncPath(file: string): void {
  const descriptor = fs.openSync(file, "r");
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function syncPathAndParents(file: string): void {
  for (let current = file; ; current = path.dirname(current)) {
    syncPath(current);
    if (path.dirname(current) === current) return;
  }
}

function writeRecordDurably(file: string, record: CheckRecord): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
    syncPath(temporary);
    fs.renameSync(temporary, file);
    syncPathAndParents(path.dirname(file));
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export class CheckJournal {
  private readonly directory: string;

  constructor(teamName: string) {
    this.directory = path.join(paths.teamDir(teamName), "checks");
  }

  private recordPath(checkId: string): string {
    if (!/^check:[a-f0-9]{64}$/.test(checkId)) throw new Error("Invalid check identity.");
    return path.join(this.directory, `${checkId.slice(6)}.json`);
  }

  private readRecord(file: string): CheckRecord | undefined {
    let contents: string;
    try { contents = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") return undefined;
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(contents); }
    catch { throw new Error(`Corrupt check record: ${file}`); }
    const record = parseRecord(value);
    if (this.recordPath(record.checkId) !== file || record.logPath !== file.replace(/\.json$/, ".log")) {
      throw new Error("Corrupt check storage binding.");
    }
    return record;
  }

  async claim(value: AssignedCheck): Promise<{ claimed: boolean; record: CheckRecord }> {
    const assignment = normalizeAssignment(value);
    const checkId = checkIdentity(assignment);
    const file = this.recordPath(checkId);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    return withLock(file, async () => {
      const existing = this.readRecord(file);
      if (existing) {
        if (assignmentBinding(existing.assignment) !== assignmentBinding(assignment)) {
          throw new Error("Check identity is already bound to another assignment.");
        }
        syncPathAndParents(file);
        return { claimed: false, record: existing };
      }
      const record = parseRecord({
        version: 1, checkId, claimToken: crypto.randomUUID(), assignment, state: "claimed",
        startedAt: Date.now(), logPath: file.replace(/\.json$/, ".log"), logBytes: 0,
      });
      writeRecordDurably(file, record);
      return { claimed: true, record: structuredClone(record) };
    });
  }

  async read(checkId: string): Promise<CheckRecord | undefined> {
    return this.readRecord(this.recordPath(checkId));
  }

  async finish(checkId: string, claimToken: string, completion: CheckCompletion): Promise<CheckRecord> {
    const file = this.recordPath(checkId);
    return withLock(file, async () => {
      const existing = this.readRecord(file);
      if (!existing || existing.claimToken !== claimToken) throw new Error("Check claim is missing or belongs to another owner.");
      if (existing.state !== "claimed") {
        syncPathAndParents(file);
        return existing;
      }
      const record = parseRecord({
        ...existing, ...completion, version: existing.version, checkId,
        claimToken: existing.claimToken, assignment: existing.assignment,
        startedAt: existing.startedAt, logPath: existing.logPath,
      });
      writeRecordDurably(file, record);
      return structuredClone(record);
    });
  }
}
