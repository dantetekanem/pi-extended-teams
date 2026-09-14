import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AssignedCheckSchema, CheckJournal, checkIdentity, type CheckRecord } from "./check-journal";
import { observeCheckSource, runAssignedCheck, type CheckRunnerOptions } from "./check-runner";
import type { ReportResult, VerificationState } from "./report-result";

export const CheckDefinitionSchema = Type.Pick(AssignedCheckSchema, ["name", "command", "timeoutSeconds", "inputs"]);
export const CheckPolicySchema = Type.Array(CheckDefinitionSchema, {
  description: "Optional lead-authorized checks, run in the agent's cwd before final-report acceptance. Each requires a unique name, command, and finite positive timeoutSeconds. Inputs optionally limit the source fingerprint; omit them to cover the repository. Verification never implies lead acceptance.",
});
export type CheckDefinition = Static<typeof CheckDefinitionSchema>;
export interface CheckEvidence {
  verification: ReportResult["verification"];
  checks: CheckRecord[];
}

export function normalizeCheckPolicy(value: unknown): CheckDefinition[] | undefined {
  if (value === undefined) return undefined;
  if (!Value.Check(CheckPolicySchema, value)) throw new Error("Invalid assigned check policy.");
  if (new Set(value.map(check => check.name)).size !== value.length) throw new Error("Assigned check names must be unique.");
  return value.length ? structuredClone(value) : undefined;
}

export function assignedCheckIds(result: ReportResult, checks: CheckDefinition[]): string[] {
  return checks.map(check => checkIdentity({ reportId: result.reportId, name: check.name, attempt: 1 }));
}

function verificationState(records: Array<CheckRecord | undefined>): VerificationState {
  if (records.some(record => record?.state === "claimed")) return "pending";
  if (!records.length || records.some(record => !record || !["passed", "stale"].includes(record.state))) return "failed";
  if (records.some(record => record?.state === "stale")) return "stale";
  return "passed";
}

export async function readCheckEvidence(teamName: string, result: ReportResult, signal?: AbortSignal): Promise<CheckEvidence> {
  if (result.version !== 1 || !result.verification) throw new Error("Corrupt or incompatible report verification.");
  if (result.verification.state === "not-requested") return { verification: { state: "not-requested" }, checks: [] };
  const journal = new CheckJournal(teamName);
  const checkIds = result.verification.checkIds ?? [];
  const errors: string[] = [];
  const records = await Promise.all(checkIds.map(async checkId => {
    try {
      const record = await journal.read(checkId);
      if (!record) throw new Error("Referenced check record is unavailable.");
      if (record.assignment.reportId !== result.reportId || record.assignment.taskId !== result.taskId
        || record.assignment.runId !== result.runId) throw new Error("Check record belongs to another task/run binding.");
      return await observeCheckSource(record, signal);
    } catch (error) {
      errors.push(`${checkId}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }));
  if (!checkIds.length) errors.push("Assigned verification has no recorded check evidence.");
  return {
    verification: { state: verificationState(records), checkIds, ...(errors.length ? { error: errors.join("\n") } : {}) },
    checks: records.filter((record): record is CheckRecord => record !== undefined),
  };
}

export async function verifyAssignedChecks(
  teamName: string,
  result: ReportResult,
  cwd: string,
  policy: CheckDefinition[] | undefined,
  options: CheckRunnerOptions,
): Promise<CheckEvidence> {
  const checks = normalizeCheckPolicy(policy);
  if (!checks) return { verification: { state: "not-requested" }, checks: [] };
  const journal = new CheckJournal(teamName);
  const records: CheckRecord[] = [];
  for (const check of checks) {
    const record = await runAssignedCheck(journal, {
      ...check, taskId: result.taskId, runId: result.runId, reportId: result.reportId, cwd, attempt: 1,
    }, options);
    records.push(record);
    if (record.state === "claimed" || options.signal?.aborted) break;
  }
  const evidence = await readCheckEvidence(teamName, {
    ...result, verification: { state: "pending", checkIds: assignedCheckIds(result, checks) },
  }, options.signal);
  if (evidence.verification.state !== "pending" && (options.signal?.aborted || records.length !== checks.length)) {
    evidence.verification.state = "failed";
    evidence.verification.error = "Assigned verification was cancelled before all checks settled.";
  }
  return evidence;
}
