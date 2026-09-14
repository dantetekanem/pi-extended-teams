import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { RepairResult } from "./repair-policy";

const reference = Type.String({ minLength: 1 });

export const ReportedTaskDetailsSchema = Type.Object({
  outcome: Type.Optional(Type.Union([
    Type.Literal("succeeded"), Type.Literal("blocked"), Type.Literal("failed"), Type.Literal("cancelled"),
  ], { description: "Reported task outcome, separate from clean exit, verification, and lead acceptance. Omit when unspecified." })),
  changedPaths: Type.Optional(Type.Array(reference)),
  artifacts: Type.Optional(Type.Array(Type.Object({
    path: reference,
    label: Type.Optional(Type.String()),
  }, { additionalProperties: false }))),
  findings: Type.Optional(Type.Array(Type.Object({
    id: reference,
    text: reference,
    evidence: Type.Array(reference),
  }, { additionalProperties: false }))),
  questions: Type.Optional(Type.Array(reference)),
}, { additionalProperties: false });

export type ReportedTaskDetails = Static<typeof ReportedTaskDetailsSchema>;
export type TaskOutcome = NonNullable<ReportedTaskDetails["outcome"]>;
export type VerificationState = "not-requested" | "pending" | "passed" | "failed" | "stale";

export interface ReportResult extends ReportedTaskDetails {
  version: 1;
  taskId: string;
  runId: string;
  reportId: string;
  verification: { state: VerificationState; checkIds?: string[]; error?: string };
  acceptance: { state: "pending" | "accepted" | "rejected"; decidedAt?: number; reason?: string };
  repair?: RepairResult;
}

export function effectiveTaskOutcome(result: ReportResult): TaskOutcome | undefined {
  return result.repair?.outcome ?? result.outcome;
}

export function normalizeReportedTaskDetails(value: unknown): ReportedTaskDetails {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Reported task details must be an object.");
  }
  const input = value as Record<string, unknown>;
  const details = Object.fromEntries(Object.keys(ReportedTaskDetailsSchema.properties)
    .filter(key => input[key] !== undefined)
    .map(key => [key, input[key]]));
  if (!Value.Check(ReportedTaskDetailsSchema, details)) throw new Error("Invalid reported task details.");
  const findingIds = details.findings?.map(finding => finding.id) ?? [];
  if (new Set(findingIds).size !== findingIds.length) throw new Error("Reported finding IDs must be unique.");
  return structuredClone(details);
}

export function createReportResult(
  teamName: string,
  agentName: string,
  runId: string,
  reported: ReportedTaskDetails,
): ReportResult {
  if (![teamName, agentName, runId].every(value => typeof value === "string" && value.length > 0)) {
    throw new Error("Report identity requires the bound team, agent and lifecycle run.");
  }
  const identity = [teamName, agentName, runId].map(encodeURIComponent).join(":");
  return {
    ...normalizeReportedTaskDetails(reported),
    version: 1,
    taskId: `task:${identity}`,
    runId,
    reportId: `report:${identity}`,
    verification: { state: "not-requested" },
    acceptance: { state: "pending" },
  };
}
