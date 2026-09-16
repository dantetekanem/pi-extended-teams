import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const RepairPolicySchema = Type.Object({
  maxAttempts: Type.Integer({ minimum: 0, maximum: 5, description: "Maximum additional repair attempts after initial verification. Zero disables automatic repair. Only the lead or a trusted integration may authorize this policy." }),
}, { additionalProperties: false });
export type RepairPolicy = Static<typeof RepairPolicySchema>;
export type RepairState = "pending" | "not-needed" | "requested" | "repaired" | "exhausted" | "cancelled" | "declined" | "blocked";
export interface RepairResult {
  controllerId: string;
  journalPath?: string;
  state: RepairState;
  attemptsUsed?: number;
  maxAttempts?: number;
  requestIds?: string[];
  outcome?: "blocked";
  error?: string;
}

export function normalizeRepairPolicy(value: unknown): RepairPolicy | undefined {
  if (value === undefined) return undefined;
  if (!Value.Check(RepairPolicySchema, value)) throw new Error("Invalid repair policy.");
  return value.maxAttempts ? structuredClone(value) : undefined;
}
