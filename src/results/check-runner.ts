import fs from "node:fs";
import { CheckJournal, type AssignedCheck, type CheckCompletion, type CheckRecord } from "./check-journal";
import { captureSourceIdentity, sameTestedSource, type SourceIdentity } from "./source-identity";

export interface CheckOperations {
  exec(command: string, cwd: string, options: {
    onData(data: Buffer): void;
    signal?: AbortSignal;
    timeout?: number;
  }): Promise<{ exitCode: number | null }>;
}
export interface CheckRunnerOptions {
  loadOperations(): Promise<CheckOperations | undefined>;
  signal?: AbortSignal;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function observeCheckSource(record: CheckRecord, signal?: AbortSignal): Promise<CheckRecord> {
  if (record.state !== "passed") return record;
  try {
    const current = await captureSourceIdentity(record.assignment.cwd, record.assignment.inputs, signal);
    if (record.sourceAfter && sameTestedSource(record.sourceAfter, current)) return record;
    return { ...record, state: "stale", error: "Current source no longer matches the tested source." };
  } catch (error) {
    return { ...record, state: "stale", error: `Current source could not be established: ${errorText(error)}` };
  }
}

export async function readCurrentCheck(journal: CheckJournal, checkId: string, signal?: AbortSignal): Promise<CheckRecord | undefined> {
  const record = await journal.read(checkId);
  return record ? observeCheckSource(record, signal) : undefined;
}

export async function runAssignedCheck(
  journal: CheckJournal,
  assignment: AssignedCheck,
  options: CheckRunnerOptions,
): Promise<CheckRecord> {
  const { claimed, record } = await journal.claim(assignment);
  if (!claimed) return observeCheckSource(record, options.signal);
  const assigned = record.assignment;
  const logCancellation = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, logCancellation.signal]) : logCancellation.signal;
  let descriptor: number | undefined;
  let acceptingOutput = true;
  let logBytes = 0;
  let logError: string | undefined;
  let sourceBefore: SourceIdentity | undefined;
  let sourceAfter: SourceIdentity | undefined;
  let exitCode: number | null | undefined;
  let state: CheckCompletion["state"] = "error";
  let error: string | undefined;
  const onData = (data: Buffer): void => {
    if (!acceptingOutput || descriptor === undefined || logError !== undefined) return;
    try {
      fs.appendFileSync(descriptor, data);
      logBytes += data.byteLength;
    } catch (failure) {
      logError = errorText(failure);
      logCancellation.abort();
    }
  };
  try {
    descriptor = fs.openSync(record.logPath, "wx", 0o600);
    signal.throwIfAborted();
    const operations = await options.loadOperations();
    signal.throwIfAborted();
    if (!operations) {
      state = "unsupported";
      error = "This Pi runtime does not expose native local bash operations required for assigned checks.";
    } else {
      sourceBefore = await captureSourceIdentity(assigned.cwd, assigned.inputs, signal);
      signal.throwIfAborted();
      const observed = await operations.exec(assigned.command, sourceBefore.cwd, {
        onData, signal, timeout: assigned.timeoutSeconds,
      });
      if (logError !== undefined) throw new Error(logError);
      signal.throwIfAborted();
      if (observed.exitCode !== null && !Number.isInteger(observed.exitCode)) throw new Error("Native check returned invalid exit evidence.");
      exitCode = observed.exitCode;
      if (exitCode === null) throw new Error("Native check exited without a known exit code.");
      sourceAfter = await captureSourceIdentity(assigned.cwd, assigned.inputs, signal);
      state = exitCode !== 0 ? "failed" : sameTestedSource(sourceBefore, sourceAfter) ? "passed" : "stale";
    }
  } catch (failure) {
    error = logError ?? errorText(failure);
    state = logError !== undefined ? "error"
      : signal.aborted || error === "aborted" ? "cancelled"
      : error === `timeout:${assigned.timeoutSeconds}` ? "timed-out" : "error";
  } finally {
    acceptingOutput = false;
    if (descriptor !== undefined) {
      try {
        try {
          logBytes = fs.fstatSync(descriptor).size;
          fs.fsyncSync(descriptor);
        } finally { fs.closeSync(descriptor); }
      } catch (failure) {
        state = "error";
        error = `Check log could not be durably closed: ${errorText(failure)}`;
      }
    }
  }
  return journal.finish(record.checkId, record.claimToken, {
    state, completedAt: Date.now(), sourceBefore, sourceAfter, exitCode, logBytes, error,
  });
}
