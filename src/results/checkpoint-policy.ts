import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const CheckpointPolicySchema = Type.Object({
  inputs: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { minItems: 1, maxItems: 64 }),
  retentionDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  decisions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32 })),
}, { additionalProperties: false });
export type CheckpointPolicyInput = Static<typeof CheckpointPolicySchema>;
export const StoredCheckpointPolicySchema = Type.Required(CheckpointPolicySchema);
export type CheckpointPolicy = Static<typeof StoredCheckpointPolicySchema>;

export function normalizeCheckpointPolicy(value: unknown): CheckpointPolicy | undefined {
  if (value === undefined) return undefined;
  if (!Value.Check(CheckpointPolicySchema, value) || value.inputs.some(input =>
    !input.trim() || input.includes("\0") || path.isAbsolute(input) || /^[A-Za-z]:/.test(input)
    || input.split(/[\\/]/).includes(".."))) throw new Error("Invalid checkpoint policy.");
  return structuredClone({ inputs: [...new Set(value.inputs)].sort(), retentionDays: value.retentionDays ?? 30, decisions: value.decisions ?? [] });
}
