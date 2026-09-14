import { Type } from "@sinclair/typebox";
import { StringEnum } from "../internal/schema";
import { ACCEPTED_FAVORITE_MODEL_SLOTS } from "../../src/utils/settings";
import { CheckPolicySchema } from "../../src/results/check-policy";
import { RepairPolicySchema } from "../../src/results/repair-policy";
import { CheckpointPolicySchema } from "../../src/results/checkpoint-policy";
import { CompletionGroupPolicySchema } from "../../src/results/completion-group";

const levelDescription = "Required intent tier. Configured favorites take priority; an unconfigured tier inherits the current lead model and thinking. Read tiers: read-collect gathers bounded facts without owning the conclusion; read-review is the normal default for focused review, verification, and bounded synthesis; read-analyze explains behavior or root cause across connected evidence; read-critical is only for irreducible high-stakes security, architecture, concurrency, migration, or data-correctness reasoning. Write tiers: write-patch makes a narrow localized change; write-feature implements a bounded feature with a known design; write-system owns a cross-cutting integration or refactor within explicitly claimed files; write-critical is only for high-risk security, concurrency, recovery, migration, or data-integrity changes. Prefer canonical tiers; legacy reading-*/writing-* aliases remain accepted for this minor release. Do not pass role, model, or thinking directly; see README.md.";
const base = {
  name: Type.Optional(Type.String({ description: "Stable display name. Defaults to a generated agent name." })),
  prompt: Type.String({ description: "The agent's assignment, relevant prior context, evidence already gathered, constraints, and report shape." }),
  cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the lead session cwd." })),
  checks: Type.Optional(CheckPolicySchema),
  repair: Type.Optional(RepairPolicySchema),
  checkpoint: Type.Optional(CheckpointPolicySchema),
  continue_from: Type.Optional(Type.String({ description: "Continue this checkpoint as a fresh recipient/run with the current assignment and tier. name is a prefix, not a recipient to reuse." })),
  session_context: Type.Optional(StringEnum(["none", "lazy"] as const, { description: "Optional filtered snapshot of the lead's active session branch. Use lazy only when omitted session history may materially affect the lane; the child reads it on demand rather than receiving transcript content in its prompt.", default: "none" })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
  allow_nested_read_agents: Type.Optional(Type.Boolean({ description: "Opt in eligible depth-0 write-feature/write-critical agents to restricted read-only child spawning.", default: false })),
};

// Metadata is available before session_start without creating a second queue,
// lifecycle controller, or execution owner during host reload.
export const publicTeamToolMetadata = {
  get_agent_status: {
    name: "get_agent_status", label: "Get Agent Status",
    description: "Get one read-only snapshot of one or all agents owned by this parent. Omit agent_name to inspect all. This call is allowed when current status is needed; it never waits, polls, stops, or changes agents. Do not call it repeatedly. Final reports arrive automatically and resume this agent.",
    parameters: Type.Object({ agent_name: Type.Optional(Type.String({ description: "One owned agent to inspect. Omit to inspect all owned agents." })) }),
  },
  spawn_agent: {
    name: "spawn_agent", label: "Spawn Agent",
    description: "Spawn one agent by intent tier only. Configured favorites take priority; an unconfigured tier inherits the current lead model and thinking. Give it the relevant goal, decisions, prior attempts, inspected evidence, constraints, and expected delta rather than a context-free task. Use session_context=lazy only as an on-demand fallback when omitted session history may materially matter; it never replaces a good mission prompt. read-review is the normal read default; use read-collect for bounded fact gathering, read-analyze for connected explanation/root cause, and read-critical only for irreducible high-stakes reasoning. For edits, choose write-patch, write-feature, write-system, or the rare high-risk write-critical by scope and risk. After spawning, do not duplicate or take over its lane; work only on unrelated work, then end the turn so the automatic report can resume you. One get_agent_status snapshot is allowed when current status is needed; never sleep, busy-wait, repeatedly read inbox/status, or treat healthy silence as failure. Wait for the actual report before synthesizing; intervene only on a reported blocker/error, actual health failure, or explicit user cancellation. model_slot selects behavior, model, and thinking; do not pass role, model, or thinking directly.",
    parameters: Type.Object({ ...base, model_slot: StringEnum(ACCEPTED_FAVORITE_MODEL_SLOTS, { description: levelDescription, default: "read-review" }) }),
  },
  spawn_swarm_agents: {
    name: "spawn_swarm_agents", label: "Spawn Swarm Agents",
    description: "Spawn a batch by intent tier only. Configured favorites take priority; unconfigured tiers inherit the current lead model and thinking. Give each lane the relevant goal, decisions, prior attempts, inspected evidence, constraints, and expected delta. Use session_context=lazy selectively as an on-demand fallback, never instead of a good mission prompt. Use read-review as the normal default, read-collect for bounded collection lanes, read-analyze for connected explanation, and read-critical only for irreducible high-stakes reasoning; choose write-patch/feature/system/critical by edit scope and risk. Each spawned lane is delegation-locked: do not duplicate or take it over. After unrelated work is done, end the turn so automatic reports can resume you. One get_agent_status snapshot is allowed when current status is needed; never sleep, busy-wait, repeatedly read inbox/status, or intervene early. Synthesize only after actual reports; intervene only on blocker/error, actual failure, or explicit cancellation. Each agent gets model_slot directly or from defaults; do not pass role, model, or thinking directly.",
    parameters: Type.Object({
      defaults: Type.Optional(Type.Object({
        cwd: Type.Optional(Type.String()), checks: Type.Optional(CheckPolicySchema), repair: Type.Optional(RepairPolicySchema),
        checkpoint: Type.Optional(CheckpointPolicySchema), model_slot: Type.Optional(StringEnum(ACCEPTED_FAVORITE_MODEL_SLOTS, { description: levelDescription })),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
        session_context: Type.Optional(StringEnum(["none", "lazy"] as const, { description: "Shared lazy session-reference policy.", default: "none" })),
        allow_nested_read_agents: Type.Optional(Type.Boolean({ description: "Shared opt-in for eligible depth-0 write-feature/write-critical agents.", default: false })),
      })),
      completion_group: Type.Optional(CompletionGroupPolicySchema),
      agents: Type.Array(Type.Object({ ...base, model_slot: Type.Optional(StringEnum(ACCEPTED_FAVORITE_MODEL_SLOTS, { description: levelDescription })) }), { description: "Agents to spawn as one batch. Each one must have model_slot directly or inherit it from defaults." }),
    }),
  },
};
