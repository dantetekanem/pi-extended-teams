import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { checkpointFilesDir } from "../utils/paths";
import { FAVORITE_MODEL_SLOTS } from "../utils/settings";
import { withLock } from "../utils/lock";
import { normalizeCheckpointPolicy, StoredCheckpointPolicySchema } from "./checkpoint-policy";
import { SourceIdentitySchema } from "./source-identity";
import { createReportResult, type ReportResult } from "./report-result";
import { syncPathAndParents, writeJsonDurably } from "./durable-json";

export const MAX_CHECKPOINT_BYTES = 65_536;
const day = 86_400_000;
const text = (maxLength = 4096) => Type.String({ minLength: 1, maxLength });
const identity = Type.String({ pattern: "^checkpoint:[a-f0-9]{64}$", maxLength: 75 });
const reportIdentity = Type.String({ pattern: "^report:[^:]+:[^:]+:[^:]+$", maxLength: 2048 });
const time = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const authorSchema = Type.Object({
  teamName: text(256), agentName: text(256), runId: text(256),
  modelSlot: Type.Union(FAVORITE_MODEL_SLOTS.map(slot => Type.Literal(slot))),
}, { additionalProperties: false });
export type CheckpointAuthor = Static<typeof authorSchema>;
const recordSchema = Type.Object({
  version: Type.Literal(1), state: Type.Literal("ready"), id: identity,
  author: authorSchema, createdAt: time, expiresAt: time, parentId: Type.Optional(identity),
  assignment: Type.Object({ original: text(16_384), current: text(16_384) }, { additionalProperties: false }),
  policy: StoredCheckpointPolicySchema, reportId: reportIdentity,
  reports: Type.Array(Type.Object({
    id: reportIdentity, path: text(2048),
    source: Type.Object({ before: SourceIdentitySchema, after: SourceIdentitySchema }, { additionalProperties: false }),
    verification: Type.Union((["not-requested", "pending", "passed", "failed", "stale"] as const).map(state => Type.Literal(state))),
    acceptance: Type.Union((["pending", "accepted", "rejected"] as const).map(state => Type.Literal(state))),
    leadDecisions: Type.Optional(Type.Array(text(), { maxItems: 32 })),
  }, { additionalProperties: false }), { minItems: 1, maxItems: 16 }),
  findings: Type.Array(Type.Object({
    id: text(256), text: text(), evidence: Type.Array(text(2048), { maxItems: 32 }), reportId: reportIdentity,
  }, { additionalProperties: false }), { maxItems: 100 }),
  inspectedEvidence: Type.Array(Type.Object({ reference: text(2048), reportId: reportIdentity }, { additionalProperties: false }), { maxItems: 128 }),
  questions: Type.Array(text(), { maxItems: 32 }),
}, { additionalProperties: false });
const retirementSchema = Type.Object({
  version: Type.Literal(1), id: identity, retiredAt: time,
  state: Type.Union([Type.Literal("deleted"), Type.Literal("expired")]),
}, { additionalProperties: false });
export type SpecialistCheckpoint = Static<typeof recordSchema>;
export type RetiredCheckpoint = Static<typeof retirementSchema>;
export type CheckpointRecord = SpecialistCheckpoint | RetiredCheckpoint;

const currentReportSchema = Type.Pick(recordSchema, ["findings", "inspectedEvidence", "questions"]);

export function checkpointReportPayload(result: ReportResult): Static<typeof currentReportSchema> {
  const payload = {
    findings: (result.findings ?? []).map(finding => ({ ...finding, reportId: result.reportId })),
    inspectedEvidence: [...new Set(result.inspectedEvidence ?? [])].map(reference => ({ reference, reportId: result.reportId })),
    questions: [...new Set(result.questions ?? [])],
  };
  const error = Value.Errors(currentReportSchema, payload).First();
  if (error) throw new Error(`Checkpoint report ${error.path}: ${error.message}. Correct the report fields and resubmit report_and_exit.`);
  return payload;
}

export function checkpointId(author: CheckpointAuthor): string {
  if (!Value.Check(authorSchema, author)) throw new Error("Invalid checkpoint author.");
  return `checkpoint:${crypto.createHash("sha256").update(JSON.stringify([author.teamName, author.agentName, author.runId])).digest("hex")}`;
}

export function checkpointPath(id: string): string {
  if (!Value.Check(identity, id)) throw new Error("Invalid checkpoint ID.");
  return path.join(checkpointFilesDir(), `${id.slice("checkpoint:".length)}.json`);
}

export function isSpecialistCheckpoint(value: unknown): value is SpecialistCheckpoint {
  if (!Value.Check(recordSchema, value)) return false;
  const { author, reports, policy } = value;
  const reportIds = new Set(reports.map(report => report.id));
  const current = reports.find(report => report.id === value.reportId);
  const source = current?.source.before;
  const inputs = source ? [...new Set(policy.inputs.map(input =>
    path.relative(source.repositoryRoot, path.resolve(source.cwd, input)).split(path.sep).join("/") || "."))].sort() : [];
  return value.id === checkpointId(author) && value.parentId !== value.id
    && value.reportId === createReportResult(author.teamName, author.agentName, author.runId, {}).reportId
    && value.expiresAt === value.createdAt + policy.retentionDays * day
    && isDeepStrictEqual(policy, normalizeCheckpointPolicy(policy))
    && reportIds.size === reports.length && !!source && isDeepStrictEqual(inputs, source.inputs)
    && new Set(value.findings.map(finding => finding.id)).size === value.findings.length
    && [...value.findings, ...value.inspectedEvidence].every(item => reportIds.has(item.reportId))
    && reports.every(report => {
      const { before, after } = report.source;
      const relative = path.relative(before.repositoryRoot, before.cwd);
      return path.isAbsolute(report.path) && path.isAbsolute(before.cwd) && path.isAbsolute(before.repositoryRoot)
        && !path.isAbsolute(relative) && !relative.split(path.sep).includes("..")
        && before.cwd === after.cwd && before.repositoryRoot === after.repositoryRoot
        && isDeepStrictEqual(before.inputs, after.inputs);
    })
    && Buffer.byteLength(JSON.stringify(value, null, 2)) <= MAX_CHECKPOINT_BYTES;
}

function rootAvailable(create = false): boolean {
  const root = checkpointFilesDir();
  for (let current = root; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Unsafe checkpoint directory: ${current}`);
    if (path.dirname(current) === current) break;
  }
  if (!fs.existsSync(root)) {
    if (!create) return false;
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || (process.getuid && stat.uid !== process.getuid())) throw new Error(`Unsafe checkpoint directory: ${root}`);
  return true;
}

function requireRegularFile(file: string): fs.Stats {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) throw new Error(`Checkpoint unavailable: ${file}. Request a new checkpoint.`);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (process.getuid && stat.uid !== process.getuid())) throw new Error(`Unsafe checkpoint file: ${file}`);
  return stat;
}

function readRecord(id: string): CheckpointRecord {
  const file = checkpointPath(id);
  requireRegularFile(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let raw: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error(`Unsafe checkpoint file: ${file}`);
    if (stat.size > MAX_CHECKPOINT_BYTES) throw new Error(`Checkpoint is too large: ${file}. Delete it or create a smaller checkpoint.`);
    const buffer = Buffer.alloc(MAX_CHECKPOINT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!bytes) break;
      length += bytes;
    }
    if (length > MAX_CHECKPOINT_BYTES) throw new Error(`Checkpoint is too large: ${file}. Delete it or create a smaller checkpoint.`);
    raw = buffer.subarray(0, length).toString("utf8");
  } finally { fs.closeSync(fd); }
  try {
    const value: unknown = JSON.parse(raw);
    if ((Value.Check(retirementSchema, value) || isSpecialistCheckpoint(value)) && value.id === id) return value;
  } catch {}
  throw new Error(`Checkpoint ${id} is corrupt or incompatible; inspect ${file} or delete it.`);
}

export function readCheckpoint(id: string, now = Date.now()): SpecialistCheckpoint {
  if (!Value.Check(time, now)) throw new Error("Invalid checkpoint observation time.");
  const file = checkpointPath(id);
  if (!rootAvailable()) throw new Error(`Checkpoint unavailable: ${file}. Request a new checkpoint.`);
  const record = readRecord(id);
  if (record.state !== "ready") throw new Error(`Checkpoint ${id} was ${record.state}. Request a new checkpoint.`);
  if (record.expiresAt <= now) throw new Error(`Checkpoint ${id} has expired. Request a new checkpoint.`);
  return structuredClone(record);
}

export async function saveCheckpoint(value: unknown): Promise<CheckpointRecord | undefined> {
  if (value === undefined) return undefined;
  if (!isSpecialistCheckpoint(value)) throw new Error("Invalid specialist checkpoint.");
  const record = structuredClone(value);
  if (record.parentId === undefined) delete record.parentId;
  for (const report of record.reports) if (report.leadDecisions === undefined) delete report.leadDecisions;
  const file = checkpointPath(record.id);
  rootAvailable(true);
  return withLock(file, async () => {
    rootAvailable();
    if (fs.lstatSync(file, { throwIfNoEntry: false })) {
      const existing = readRecord(record.id);
      if (existing.state === "ready" && !isDeepStrictEqual(existing, record)) throw new Error(`Checkpoint ${record.id} is immutable.`);
      syncPathAndParents(file);
      return structuredClone(existing);
    }
    writeJsonDurably(file, record);
    return structuredClone(record);
  });
}

export async function resyncCheckpoint(id: string): Promise<CheckpointRecord> {
  const file = checkpointPath(id);
  if (!rootAvailable()) throw new Error(`Checkpoint unavailable: ${file}. Request a new checkpoint.`);
  return withLock(file, async () => {
    rootAvailable();
    const record = readRecord(id);
    syncPathAndParents(file);
    return structuredClone(record);
  });
}

export async function retireCheckpoint(id: string, state: RetiredCheckpoint["state"], now = Date.now()): Promise<RetiredCheckpoint> {
  const record: RetiredCheckpoint = { version: 1, id, state, retiredAt: now };
  if (!Value.Check(retirementSchema, record)) throw new Error("Invalid checkpoint retirement.");
  const file = checkpointPath(id);
  if (!rootAvailable()) throw new Error(`Checkpoint unavailable: ${file}. Request a new checkpoint.`);
  return withLock(file, async () => {
    rootAvailable();
    requireRegularFile(file);
    let existing: CheckpointRecord | undefined;
    try { existing = readRecord(id); }
    catch (error) { if (state !== "deleted") throw error; }
    if (existing && existing.state !== "ready") {
      syncPathAndParents(file);
      return existing;
    }
    if (state === "expired" && (!existing || existing.expiresAt > now)) throw new Error(`Checkpoint ${id} is not expired.`);
    writeJsonDurably(file, record);
    return structuredClone(record);
  });
}

export function listCheckpointRecords(): { records: CheckpointRecord[]; errors: { id: string; message: string }[] } {
  const records: CheckpointRecord[] = [];
  const errors: { id: string; message: string }[] = [];
  if (!rootAvailable()) return { records, errors };
  for (const name of fs.readdirSync(checkpointFilesDir()).sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const id = `checkpoint:${name.slice(0, -5)}`;
    try { records.push(readRecord(id)); }
    catch (error) { errors.push({ id, message: error instanceof Error ? error.message : String(error) }); }
  }
  return { records, errors };
}
