import { isDeepStrictEqual } from "node:util";
import type { Member, TeamReportEvent } from "../utils/models";
import { normalizeFavoriteModelSlot } from "../utils/settings";
import { readStoredTeamReportEvent, recordReportCheckpoint, resyncStoredTeamReportEvent } from "../utils/report-events";
import { captureSourceIdentity, type SourceIdentity } from "./source-identity";
import { checkpointId, checkpointReportPayload, isSpecialistCheckpoint, MAX_CHECKPOINT_BYTES, MAX_CHECKPOINT_REPORT_PATH_LENGTH, saveCheckpoint, type SpecialistCheckpoint } from "./specialist-checkpoint";
import type { ReportResult } from "./report-result";

function author(teamName: string, member: Member) {
  return { teamName, agentName: member.name, runId: member.lifecycleRunId!, modelSlot: normalizeFavoriteModelSlot(member.modelSlot)! };
}

export function checkpointReference(teamName: string, member: Member): TeamReportEvent["checkpoint"] {
  return member.checkpointAssignment ? { id: checkpointId(author(teamName, member)) } : undefined;
}

function requireDraft(event: TeamReportEvent): SpecialistCheckpoint {
  const draft = event.checkpoint?.draft;
  if (!isSpecialistCheckpoint(draft) || draft.id !== event.checkpoint?.id || draft.reportId !== event.id
    || draft.author.teamName !== event.teamName || draft.author.agentName !== event.agentName || draft.author.runId !== event.result?.runId
    || draft.reports.find(report => report.id === event.id)?.path !== event.reportPath) throw new Error("Checkpoint report provenance is unavailable or changed.");
  return draft;
}

function checkpointBytes(record: SpecialistCheckpoint): number {
  return Buffer.byteLength(JSON.stringify(record, null, 2));
}

export function preflightReportCheckpoint(teamName: string, member: Member, result: ReportResult): void {
  const assignment = member.checkpointAssignment;
  if (!assignment) return;
  if (!assignment.sourceBefore) throw new Error("Checkpoint assignment provenance is unavailable.");
  // JSON may escape each path character as six bytes; the final versioned path is allocated later.
  const reservedBytes = 6 * MAX_CHECKPOINT_REPORT_PATH_LENGTH;
  const event: TeamReportEvent = {
    id: result.reportId, teamName, agentName: member.name, status: "completed", source: "read-agent", report: "",
    createdAt: Number.MAX_SAFE_INTEGER - assignment.policy.retentionDays * 86_400_000,
    reportPath: "/", checkpoint: checkpointReference(teamName, member),
    result: { ...result, verification: { ...result.verification, state: "not-requested" }, acceptance: { state: "accepted" } },
  };
  // Native capture uses SHA-1/SHA-256 and an array length; stable path/scope fields must match sourceBefore.
  const after = { ...assignment.sourceBefore, head: "f".repeat(64), fileCount: Number.MAX_SAFE_INTEGER };
  const record = snapshot(teamName, member, event, after, reservedBytes);
  if (checkpointBytes(record) + reservedBytes > MAX_CHECKPOINT_BYTES) {
    throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes including assignment and retained provenance. Correct the report fields and resubmit report_and_exit.`);
  }
}

function snapshot(teamName: string, member: Member, event: TeamReportEvent, after: SourceIdentity, reservedBytes = 0): SpecialistCheckpoint {
  const { originalPrompt, policy, sourceBefore, parent } = member.checkpointAssignment!;
  const result = event.result!;
  if (!sourceBefore || (parent && !isSpecialistCheckpoint(parent))) throw new Error("Checkpoint assignment provenance is unavailable.");
  const previous = (parent ? [parent.reports[0], ...parent.reports.slice(1).slice(-14)] : []).map(report => ({ ...report,
    ...(report.id === parent?.reportId && !report.leadDecisions ? { leadDecisions: parent.policy.decisions } : {}) }));
  const retained = new Set(previous.map(report => report.id));
  const { findings, inspectedEvidence: inspected, questions } = checkpointReportPayload(result);
  const updated = new Set(findings.map(finding => finding.id));
  const record: SpecialistCheckpoint = {
    version: 1, state: "ready", id: event.checkpoint!.id, author: author(teamName, member),
    createdAt: event.createdAt, expiresAt: event.createdAt + policy.retentionDays * 86_400_000,
    ...(parent ? { parentId: parent.id } : {}), assignment: { original: originalPrompt, current: member.prompt! }, policy,
    reportId: event.id, reports: [...previous, { id: event.id, path: event.reportPath!, source: { before: sourceBefore, after },
      verification: result.verification.state, acceptance: result.acceptance.state, leadDecisions: policy.decisions }],
    findings: [...findings, ...(parent?.findings.filter(finding => retained.has(finding.reportId) && !updated.has(finding.id)) ?? []).slice(0, Math.max(0, 100 - findings.length))],
    inspectedEvidence: [...inspected, ...(parent?.inspectedEvidence.filter(item => retained.has(item.reportId)) ?? []).slice(0, Math.max(0, 128 - inspected.length))],
    questions: [...questions, ...(parent?.questions.filter(question => !questions.includes(question)) ?? []).slice(0, Math.max(0, 32 - questions.length))],
  };
  const oversized = () => checkpointBytes(record) + reservedBytes > MAX_CHECKPOINT_BYTES;
  while (oversized() && record.reports.length > 2) {
    const removed = record.reports.splice(1, 1)[0].id;
    record.findings = record.findings.filter(finding => finding.reportId !== removed);
    record.inspectedEvidence = record.inspectedEvidence.filter(item => item.reportId !== removed);
  }
  while (oversized() && record.questions.length > questions.length) record.questions.pop();
  return structuredClone(record);
}

export async function saveReportCheckpoint(teamName: string, member: Member, event: TeamReportEvent, signal?: AbortSignal) {
  const reference = checkpointReference(teamName, member);
  if (!reference && !event.checkpoint) return undefined;
  if (!reference || event.checkpoint?.id !== reference.id || event.teamName !== teamName || event.agentName !== member.name
    || !event.result || event.result.runId !== member.lifecycleRunId || event.id !== event.result.reportId) throw new Error("Checkpoint report binding changed.");
  let stored = await readStoredTeamReportEvent(teamName, event.id);
  if (stored?.checkpoint?.id !== reference.id) throw new Error("Checkpoint report provenance is unavailable.");
  if (!stored.checkpoint.draft) {
    const assignment = structuredClone(member.checkpointAssignment!);
    if (!assignment.sourceBefore) throw new Error("Checkpoint assignment provenance is unavailable.");
    const captureSignal = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    captureSignal.throwIfAborted();
    const after = await captureSourceIdentity(member.cwd, assignment.policy.inputs, captureSignal);
    captureSignal.throwIfAborted();
    await resyncStoredTeamReportEvent(teamName, event.id);
    stored = await recordReportCheckpoint(teamName, event.id, snapshot(teamName, { ...member, checkpointAssignment: assignment }, stored, after));
  } else stored = await resyncStoredTeamReportEvent(teamName, event.id);
  const draft = requireDraft(stored);
  if (!isDeepStrictEqual(draft.author, author(teamName, member)) || !isDeepStrictEqual(draft.policy, member.checkpointAssignment!.policy)
    || draft.assignment.original !== member.checkpointAssignment!.originalPrompt || draft.assignment.current !== member.prompt
    || !isDeepStrictEqual(draft.reports.find(report => report.id === event.id)?.source.before, member.checkpointAssignment!.sourceBefore)) {
    throw new Error("Checkpoint assignment binding changed.");
  }
  return saveCheckpoint(draft);
}

export async function resyncReportCheckpoint(event: TeamReportEvent) {
  if (!event.checkpoint) return undefined;
  const stored = await resyncStoredTeamReportEvent(event.teamName, event.id);
  if (stored.checkpoint?.id !== event.checkpoint.id) throw new Error("Checkpoint report binding changed.");
  return saveCheckpoint(requireDraft(stored));
}
