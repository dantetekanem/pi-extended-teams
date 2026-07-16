import type { Member } from "../../src/utils/models";

export const NESTED_READ_MODEL_SLOTS = [
  "read-collect",
  "read-review",
  "read-analyze",
  "read-critical",
] as const;

export type NestedReadModelSlot = (typeof NESTED_READ_MODEL_SLOTS)[number];

export const NESTED_DELEGATION_TOOL_NAMES = ["spawn_agent", "spawn_swarm_agents"] as const;

const ELIGIBLE_PARENT_MODEL_SLOTS = new Set(["write-feature", "write-critical"]);

export function isEligibleNestedReadParent(member: Member): boolean {
  return member.role === "write"
    && member.delegationDepth === 0
    && member.allowNestedReadAgents === true
    && typeof member.modelSlot === "string"
    && ELIGIBLE_PARENT_MODEL_SLOTS.has(member.modelSlot);
}
