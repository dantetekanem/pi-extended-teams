import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as paths from "../utils/paths";
import { withLock } from "../utils/lock";
import { AssignedCheckSchema, CheckJournal, assignmentBinding, checkIdentity, type AssignedCheck, type CheckRecord } from "./check-journal";
import { normalizeCheckPolicy, readCheckEvidence, verifyAssignedChecks, type CheckDefinition, type CheckEvidence } from "./check-policy";
import { observeCheckSource, runAssignedCheck, type CheckRunnerOptions } from "./check-runner";
import { syncPathAndParents, writeJsonDurably } from "./durable-json";
import { normalizeReportedTaskDetails, type ReportResult } from "./report-result";
import { normalizeRepairPolicy, type RepairPolicy, type RepairResult, type RepairState } from "./repair-policy";

const text = Type.String({ minLength: 1 });
const stageStates = ["running", "not-needed", "requested", "repaired", "exhausted", "cancelled", "declined", "blocked"] as const;
const StageSchema = Type.Object({
  submissionId: text, signature: text, token: text,
  attempt: Type.Integer({ minimum: 1, maximum: 6 }),
  state: Type.Union(stageStates.map(state => Type.Literal(state))),
  checkIds: Type.Array(Type.String({ pattern: "^check:[a-f0-9]{64}$" })),
}, { additionalProperties: false });
const LedgerSchema = Type.Object({
  version: Type.Literal(1), assignments: Type.Array(AssignedCheckSchema, { minItems: 1 }),
  maxAttempts: Type.Integer({ minimum: 1, maximum: 5 }), cancelled: Type.Boolean(),
  stages: Type.Array(StageSchema, { maxItems: 6 }),
}, { additionalProperties: false });
type Stage = Static<typeof StageSchema>;
type Ledger = Static<typeof LedgerSchema>;

export interface VerificationControllerOptions {
  teamName: string;
  result: ReportResult;
  cwd: string;
  checks?: CheckDefinition[];
  repair?: RepairPolicy;
}
export interface RepairRequest { id: string; attempt: number; checks: CheckRecord[] }
export interface VerificationDecision { result: ReportResult; checks: CheckRecord[]; request?: RepairRequest }

function identity(value: unknown): string {
  return `repair:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function repairJournalPath(teamName: string, reportId: string): string {
  return path.join(paths.teamDir(teamName), "repairs", `${identity(reportId).slice(7)}.json`);
}

function readLedger(file: string): Ledger | undefined {
  let contents: string;
  try { contents = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(contents); } catch { throw new Error("Corrupt repair ledger JSON."); }
  return parseLedger(value);
}

function parseLedger(value: unknown): Ledger {
  if (!Value.Check(LedgerSchema, value)) throw new Error("Corrupt or incompatible repair ledger.");
  const names = value.assignments.map(assignment => assignment.name);
  if (new Set(names).size !== names.length || value.assignments.some(assignment => assignment.attempt !== 1)
    || value.stages.length > value.maxAttempts + 1
    || new Set(value.stages.map(stage => stage.submissionId)).size !== value.stages.length) throw new Error("Corrupt repair assignment binding.");
  for (const [index, stage] of value.stages.entries()) {
    if (stage.attempt !== index + 1 || (index > 0 && value.stages[index - 1].state !== "requested")
      || stage.checkIds.length !== names.length || stage.checkIds.some((id, item) =>
        !Array.from({ length: stage.attempt }, (_, attempt) => checkIdentity({ ...value.assignments[item], attempt: attempt + 1 })).includes(id))) {
      throw new Error("Corrupt repair stage binding.");
    }
  }
  return structuredClone(value);
}

export class VerificationController {
  readonly journalPath: string;
  private readonly context: VerificationControllerOptions;
  private readonly checks: CheckDefinition[] | undefined;
  private readonly repair: RepairPolicy | undefined;
  private readonly assignments: AssignedCheck[];
  private observedLedger = false;

  constructor(options: VerificationControllerOptions) {
    this.context = structuredClone(options);
    this.checks = normalizeCheckPolicy(options.checks);
    this.repair = normalizeRepairPolicy(options.repair);
    if (this.repair && !this.checks?.length) throw new Error("Repair policy requires explicitly assigned checks.");
    this.assignments = (this.checks ?? []).map(check => ({
      ...check, inputs: check.inputs ? [...new Set(check.inputs)].sort() : undefined,
      taskId: options.result.taskId, runId: options.result.runId, reportId: options.result.reportId,
      cwd: options.cwd, attempt: 1,
    }));
    this.journalPath = repairJournalPath(options.teamName, options.result.reportId);
  }

  static async observe(teamName: string, result: ReportResult, signal?: AbortSignal): Promise<VerificationDecision> {
    const uncertain = async (error: unknown): Promise<VerificationDecision> => {
      const message = error instanceof Error ? error.message : String(error);
      const evidence = await readCheckEvidence(teamName, result, signal).catch(() => ({ verification: result.verification, checks: [] }));
      return { result: { ...structuredClone(result), verification: { ...evidence.verification, state: "pending", error: message },
        repair: { controllerId: identity(result.reportId), journalPath: repairJournalPath(teamName, result.reportId), state: "pending", outcome: "blocked", error: message } }, checks: evidence.checks };
    };
    let ledger: Ledger | undefined;
    try { ledger = readLedger(repairJournalPath(teamName, result.reportId)); }
    catch (error) { return uncertain(error); }
    if (!ledger && !result.repair) {
      const evidence = await readCheckEvidence(teamName, result, signal);
      return { result: { ...structuredClone(result), verification: evidence.verification }, checks: evidence.checks };
    }
    try {
      if (!ledger) throw new Error(`Referenced repair ledger is unavailable.${result.verification.error ? ` ${result.verification.error}` : ""}`);
      if (ledger.assignments.some(assignment => assignment.taskId !== result.taskId || assignment.runId !== result.runId || assignment.reportId !== result.reportId)) {
        throw new Error("Repair ledger belongs to another task/run binding.");
      }
      const controller = new VerificationController({ teamName, result, cwd: ledger.assignments[0].cwd,
        checks: ledger.assignments.map(({ name, command, timeoutSeconds, inputs }) => ({ name, command, timeoutSeconds, inputs })),
        repair: { maxAttempts: ledger.maxAttempts } });
      const current = controller.read();
      if (!current) throw new Error("Referenced repair ledger is unavailable.");
      if (result.verification.error && ["running", "requested"].includes(current.stages.at(-1)?.state ?? "")) {
        return uncertain(result.verification.error);
      }
      return await controller.decision(current, current.stages.at(-1), undefined, signal);
    } catch (error) { return uncertain(error); }
  }

  pendingRepair(error: unknown): RepairResult | undefined {
    if (!this.repair) return undefined;
    return {
      ...this.context.result.repair,
      controllerId: identity(this.context.result.reportId), journalPath: this.journalPath,
      state: "pending", outcome: "blocked", maxAttempts: this.repair.maxAttempts,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  private read(): Ledger | undefined {
    const ledger = readLedger(this.journalPath);
    if (!ledger) {
      const result = this.context.result;
      if (this.observedLedger || result.repair || (this.repair && (result.verification.checkIds?.length || result.verification.error))) {
        throw new Error(`Referenced repair ledger is unavailable; inspect ${this.journalPath}.${result.verification.error ? ` ${result.verification.error}` : ""}`);
      }
      return undefined;
    }
    this.observedLedger = true;
    if (ledger.maxAttempts !== this.repair?.maxAttempts
      || JSON.stringify(ledger.assignments.map(assignmentBinding)) !== JSON.stringify(this.assignments.map(assignmentBinding))) {
      throw new Error("Repair policy or assignment binding has changed.");
    }
    return ledger;
  }

  private async update<T>(change: (ledger: Ledger) => { value: T; changed: boolean }): Promise<T> {
    fs.mkdirSync(path.dirname(this.journalPath), { recursive: true, mode: 0o700 });
    return withLock(this.journalPath, async () => {
      let ledger = this.read();
      if (!ledger) {
        const journal = new CheckJournal(this.context.teamName);
        for (const assignment of this.assignments) {
          if (await journal.read(checkIdentity(assignment))) throw new Error(`Referenced repair ledger is unavailable; inspect ${this.journalPath}.`);
        }
        ledger = { version: 1, assignments: this.assignments, maxAttempts: this.repair!.maxAttempts, cancelled: false, stages: [] };
      }
      const changed = change(ledger);
      this.observedLedger = true;
      if (changed.changed) writeJsonDurably(this.journalPath, parseLedger(ledger));
      else syncPathAndParents(this.journalPath);
      return structuredClone(changed.value);
    });
  }

  async cancel(): Promise<void> {
    if (!this.repair) {
      this.read();
      return;
    }
    await this.update(ledger => {
      const last = ledger.stages.at(-1);
      const terminal = last && !["running", "requested"].includes(last.state);
      const changed = !ledger.cancelled && !terminal;
      if (changed) ledger.cancelled = true;
      return { value: undefined, changed };
    });
  }

  async cancelAndRequireSettled(): Promise<void> {
    const verificationError = this.context.result.verification.error;
    await this.cancel();
    const ledger = this.read();
    const stage = ledger?.stages.at(-1);
    if (stage?.state === "running" || (stage?.state === "requested" && verificationError)) {
      throw new Error(`Repair verification remains unresolved; inspect ${this.journalPath}.${verificationError ? ` ${verificationError}` : ""}`);
    }
    const journal = new CheckJournal(this.context.teamName);
    for (const [index, id] of (stage?.checkIds ?? []).entries()) {
      const record = await journal.read(id);
      if (record && assignmentBinding(record.assignment) !== assignmentBinding({ ...this.assignments[index], attempt: record.assignment.attempt })) {
        throw new Error(`Repair evidence binding is invalid; inspect ${this.journalPath}.`);
      }
      if (record?.state === "claimed") throw new Error(`Repair check ownership remains unresolved; inspect ${this.journalPath}.`);
    }
  }

  private async evidence(checkIds: string[], signal?: AbortSignal): Promise<CheckEvidence> {
    return readCheckEvidence(this.context.teamName, {
      ...this.context.result, verification: { state: "pending", checkIds },
    }, signal);
  }

  private async decision(ledger: Ledger, stage: Stage | undefined, evidence?: CheckEvidence, signal?: AbortSignal): Promise<VerificationDecision> {
    evidence ??= await this.evidence(stage?.checkIds ?? [], signal);
    const state: RepairState = stage?.state === "running" || evidence.verification.state === "pending"
      ? "pending" : ledger.cancelled ? "cancelled" : stage?.state ?? "pending";
    if (state === "pending") evidence.verification.state = "pending";
    const requested = ledger.stages.filter(item => item.state === "requested");
    const repair: RepairResult = {
      controllerId: identity(this.context.result.reportId), journalPath: this.journalPath, state, maxAttempts: ledger.maxAttempts,
      attemptsUsed: requested.length, requestIds: requested.map(item => identity([this.context.result.reportId, item.attempt])),
      ...(["pending", "exhausted", "cancelled", "declined", "blocked"].includes(state) ? { outcome: "blocked" as const } : {}),
    };
    return {
      result: { ...structuredClone(this.context.result), verification: evidence.verification, repair }, checks: evidence.checks,
      ...(state === "requested" && stage ? { request: {
        id: identity([this.context.result.reportId, stage.attempt]), attempt: stage.attempt,
        checks: evidence.checks.filter(check => check.state !== "passed"),
      } } : {}),
    };
  }

  private async runPlan(stage: Stage, previous: Stage | undefined, options: CheckRunnerOptions): Promise<CheckEvidence> {
    const journal = new CheckJournal(this.context.teamName);
    const prior = previous ? await Promise.all(previous.checkIds.map(id => journal.read(id))) : [];
    for (const [index, record] of prior.entries()) {
      if (!record || assignmentBinding(record.assignment) !== assignmentBinding({ ...this.assignments[index], attempt: record.assignment.attempt })) {
        throw new Error("Prior repair evidence has an incompatible assignment binding.");
      }
    }
    if (prior.some(record => record?.state === "claimed")) return this.evidence(previous!.checkIds, options.signal);
    const checkIds = [...stage.checkIds];
    for (const [index, assignment] of this.assignments.entries()) {
      if (options.signal?.aborted) break;
      const observed = prior[index] && await observeCheckSource(prior[index]!, options.signal);
      if (observed?.state === "passed") { checkIds[index] = observed.checkId; continue; }
      const record = await runAssignedCheck(journal, { ...assignment, attempt: stage.attempt }, options);
      checkIds[index] = record.checkId;
      if (record.state === "claimed" || options.signal?.aborted) break;
    }
    return this.evidence(checkIds, options.signal);
  }

  async verify(submissionId: string, options: CheckRunnerOptions): Promise<VerificationDecision> {
    if (!this.repair) {
      this.read();
      const evidence = await verifyAssignedChecks(this.context.teamName, this.context.result, this.context.cwd, this.checks, options);
      const result = { ...structuredClone(this.context.result), verification: evidence.verification };
      delete result.repair;
      return { result, checks: evidence.checks };
    }
    if (typeof submissionId !== "string" || !submissionId.trim()) throw new Error("Repair verification requires a runtime submission identity.");
    if (options.signal?.aborted) await this.cancel();
    const signature = identity(normalizeReportedTaskDetails(this.context.result));
    const reservation = await this.update(ledger => {
      const existing = ledger.stages.find(stage => stage.submissionId === submissionId);
      if (existing && existing.signature !== signature) throw new Error("Repair submission identity binding has changed.");
      const previous = ledger.stages.at(-1);
      if (ledger.cancelled || existing || (previous && previous.state !== "requested")) {
        return { value: { ledger, stage: previous ?? existing, previous: undefined as Stage | undefined, granted: false }, changed: false };
      }
      const attempt = (previous?.attempt ?? 0) + 1;
      const declined = previous && ["blocked", "failed", "cancelled"].includes(this.context.result.outcome ?? "");
      const stage: Stage = {
        submissionId, signature, token: crypto.randomUUID(), attempt,
        state: declined ? "declined" : "running",
        checkIds: declined ? [...previous.checkIds] : this.assignments.map(assignment => checkIdentity({ ...assignment, attempt })),
      };
      ledger.stages.push(stage);
      return { value: { ledger, stage, previous, granted: !declined }, changed: true };
    });
    if (!reservation.granted || !reservation.stage) {
      const observed = await this.decision(reservation.ledger, reservation.stage, undefined, options.signal);
      if (!options.signal?.aborted) return observed;
      await this.cancel();
      const cancelled = this.read();
      if (!cancelled) throw new Error("Repair ledger disappeared during cancellation.");
      return this.decision(cancelled, cancelled.stages.at(-1), undefined, options.signal);
    }
    const evidence = await this.runPlan(reservation.stage, reservation.previous, options);
    const finished = await this.update(ledger => {
      const stage = ledger.stages.find(item => item.token === reservation.stage!.token);
      if (!stage || stage.state !== "running") throw new Error("Repair reservation changed before completion.");
      stage.checkIds = evidence.verification.checkIds ?? [];
      if (options.signal?.aborted || evidence.checks.some(check => check.state === "cancelled")) ledger.cancelled = true;
      const repairable = evidence.checks.length === this.assignments.length
        && evidence.checks.every(check => ["passed", "failed", "stale", "timed-out"].includes(check.state));
      if (evidence.verification.state === "pending") stage.state = "running";
      else if (ledger.cancelled) stage.state = "cancelled";
      else if (evidence.verification.state === "passed") stage.state = stage.attempt === 1 ? "not-needed" : "repaired";
      else if (["blocked", "failed", "cancelled"].includes(this.context.result.outcome ?? "")) stage.state = "declined";
      else if (!repairable) stage.state = "blocked";
      else stage.state = stage.attempt <= ledger.maxAttempts ? "requested" : "exhausted";
      return { value: { ledger, stage }, changed: true };
    });
    return this.decision(finished.ledger, finished.stage, evidence);
  }
}
