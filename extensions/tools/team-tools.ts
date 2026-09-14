import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "../internal/schema";
import { isTeamsDebugEnabled, teamDebugLogPath, writeTeamsDebugEvent } from "../internal/debug";
import { getCurrentQualifiedModel, getModelSelectionState, requireQualifiedKnownModel } from "../internal/model-selection";
import { getPiSessionId } from "../internal/session-files";
import { createSessionContextReference, removeSessionContextReference } from "../internal/session-context-reference";
import * as paths from "../../src/utils/paths";
import * as teams from "../../src/utils/teams";
import * as runtime from "../../src/utils/runtime";
import * as messaging from "../../src/utils/messaging";
import * as writeQueue from "../../src/utils/write-queue";
import { ACCEPTED_FAVORITE_MODEL_SLOTS, FAVORITE_MODEL_SLOTS, canonicalPersistedModelSlot, isFavoriteModelSlot, loadSettings, normalizeFavoriteModelSlot, requireFavoriteModelLevel, resolveModel, roleForFavoriteModelSlot, type AgentRole, type CanonicalFavoriteModelSlot } from "../../src/utils/settings";
import type { Member } from "../../src/utils/models";
import { CheckPolicySchema, normalizeCheckPolicy } from "../../src/results/check-policy";
import { RepairPolicySchema, normalizeRepairPolicy } from "../../src/results/repair-policy";
import { CompletionGroup, CompletionGroupPolicySchema, completionGroupIdentity, normalizeCompletionGroupPolicy, type CompletionGroupBinding } from "../../src/results/completion-group";
import { listStoredTeamReportEvents } from "../../src/utils/report-events";
import { enqueueCompletionGroupDeliveries } from "../../src/results/completion-group-delivery";
import { shouldSuppressLeadReportInjection } from "../../src/utils/workflow-metadata";

import type { RunningReadAgent } from "../runtime/types";
import type { ReadAgentTeardownResult } from "../agents/read-agent-session-lifecycle";
import type { ShutdownTeammateOptions } from "../team/lifecycle";
import {
  onLifecycleTombstoneCleared,
  listLifecycleTombstones,
  readLifecycleTombstone,
  withLifecycleTombstoneLock,
  type LifecycleTombstoneLock,
} from "../../src/utils/lifecycle-tombstone";
import { isEligibleNestedReadParent, NESTED_READ_MODEL_SLOTS, type NestedReadModelSlot } from "../runtime/nested-read-agents";
import {
  createPendingChildController,
  type ParentRunIdentity,
  type PendingChildAcceptance,
  type PendingChildController,
  type PendingChildRun,
} from "../runtime/pending-child-controller";
import {
  AGENT_WAIT_CONTRACT,
  createAgentStatusTool,
  type AgentStatusScope,
  type QueuedAgentStatus,
} from "./agent-status-tool";

export const CHILD_AGENT_LIFECYCLE_PROBE = "pi-extended-teams:child-agent-lifecycle-probe";

interface ChildAgentLifecycleProbe {
  sessionId: string;
  respond(snapshot: { sessionId: string; running: number; queued: number }): void;
}

export interface TeamToolsOptions {
  terminal: any;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
  isCurrentReadAgentRun(key: string, state: RunningReadAgent): boolean;
  renderReadAgentStatus(): void;
  readAgentOptions(): any;
  runReadAgentInProcess(teamName: string, member: Member, prompt: string, ctx: any, options: any): Promise<void> | void;
  startWriteAgent(teamName: string, member: Member, prompt: string): Promise<string>;
  shutdownTeammate(teamName: string, member: Member, options?: ShutdownTeammateOptions): Promise<ReadAgentTeardownResult>;
  adoptTeamAsLead(teamName: string, ctx?: any): void;
  onCompletionGroupUse?(groupId: string): void;
  buildRoster(teamName: string): Promise<any>;
  isTeammate: boolean;
  agentName: string;
  getTeamName(): string | null | undefined;
  getSessionCtx?(): any;
  setSessionCtx?(ctx: any): void;
  pendingChildController?: PendingChildController;
}

export interface NestedReadAgentToolBinding {
  teamName: string;
  parent: Member;
  parentRunId: string;
  outerCtx: any;
}

export interface NestedChildSnapshot {
  running: number;
  queued: number;
}

export interface TeamToolsRuntime {
  createNestedReadAgentTools(binding: NestedReadAgentToolBinding): any[];
  nestedChildSnapshot(binding: NestedReadAgentToolBinding): NestedChildSnapshot;
  cancelQueuedAgent(teamName: string, agentName: string): boolean | Promise<boolean>;
}

interface SpawnTeammateOptions {
  once?: boolean;
  completionGroup?: CompletionGroupBinding;
  nestedParent?: {
    teamName: string;
    name: string;
    lifecycleRunId: string;
    cwd: string;
  };
  allowNestedReadAgents?: boolean;
}

interface QueuedReadSpawn {
  id: string;
  teamName: string;
  member: Member;
  prompt: string;
  params: any;
  resolved: ReturnType<typeof resolveModel>;
  ctx: any;
  requestedAt: number;
  nameReservationId?: string;
  pendingChildAcceptance?: PendingChildAcceptance;
  admissionError?: string;
  quarantineError?: string;
  launchCommitted?: boolean;
  groupSettlement?: Promise<void>;
}

export function registerTeamTools(pi: any, options: TeamToolsOptions): TeamToolsRuntime {
  if (options.isTeammate) {
    return {
      createNestedReadAgentTools: () => [],
      nestedChildSnapshot: () => ({ running: 0, queued: 0 }),
      cancelQueuedAgent: () => false,
    };
  }

  function emitOrchestrationResponse(requestId: string | undefined, type: string, payload: Record<string, any>): void {
    if (!requestId) return;
    pi.events?.emit?.("pi-extended-teams:orchestration-response", { requestId, type, ...payload });
  }

  function operationMetadataFromParams(params: any): Record<string, any> | undefined {
    const metadata = { ...(params.metadata || {}) };
    if (params.operation_id) metadata.operationId = params.operation_id;
    if (params.workflow_run_id) metadata.workflowRunId = params.workflow_run_id;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  function hasOwnParam(params: any, key: string): boolean {
    return !!params && Object.prototype.hasOwnProperty.call(params, key);
  }

  function rejectDirectModelSelection(params: any, context: string): void {
    const forbidden = ["model", "thinking", "role"].filter((key) => hasOwnParam(params, key));
    if (forbidden.length === 0) return;
    throw new Error(
      `${context} must use model_slot only. Do not pass ${forbidden.join(", ")}; choose an intent tier. Configured favorites are optional; see README.md for tier examples.`
    );
  }

  function requireSpawnLevel(params: any, context: string): CanonicalFavoriteModelSlot {
    rejectDirectModelSelection(params, context);
    if (params?.session_context !== undefined && params.session_context !== "none" && params.session_context !== "lazy") {
      throw new Error(`${context} session_context must be none or lazy.`);
    }
    const slot = normalizeFavoriteModelSlot(params?.model_slot);
    if (!slot) {
      throw new Error(
        `${context} requires a model_slot intent tier: ${FAVORITE_MODEL_SLOTS.join(", ")}. Unconfigured tiers inherit the current lead model and thinking; see README.md for examples.`
      );
    }
    return slot;
  }

  function configuredFavoriteModelForSpawn(params: any, ctx: any, context = "spawn_agent"): string {
    const slot = requireSpawnLevel(params, context);
    const settings = loadSettings({ projectDir: params.cwd || ctx.cwd });
    const configured = settings.favoriteModels[slot];
    if (configured?.model && configured.thinking) return configured.model;

    const currentModel = getCurrentQualifiedModel(ctx);
    if (!currentModel) {
      throw new Error(
        `${context} could not resolve model_slot "${slot}": it is not configured and the current lead session has no model.`
      );
    }
    return currentModel;
  }

  function requireNestedReadSpawnLevel(params: any, context: string): NestedReadModelSlot {
    rejectDirectModelSelection(params, context);
    if (!NESTED_READ_MODEL_SLOTS.includes(params?.model_slot)) {
      throw new Error(`${context} requires a canonical read-* model_slot: ${NESTED_READ_MODEL_SLOTS.join(", ")}.`);
    }
    return params.model_slot;
  }

  function rejectUnexpectedNestedParams(params: any, allowed: readonly string[], context: string): void {
    const unexpected = Object.keys(params || {}).filter((key) => !allowed.includes(key));
    if (unexpected.length > 0) {
      throw new Error(`${context} accepts only ${allowed.join(", ")}; do not pass ${unexpected.join(", ")}.`);
    }
  }

  function mergeSwarmAgentParams(defaults: any = {}, agent: any = {}): any {
    return { ...defaults, ...agent };
  }

  function memberMatchesOperation(member: Member, params: any): boolean {
    if (!params.operation_id) return false;
    const operationId = member.metadata?.operationId || member.metadata?.orchestration?.operationId;
    const workflowRunId = member.metadata?.workflowRunId || member.metadata?.orchestration?.workflowRunId;
    return operationId === params.operation_id && (params.workflow_run_id === undefined || workflowRunId === params.workflow_run_id);
  }

  function memberResolutionDetails(member: Member, params: any, extras: Record<string, any> = {}): Record<string, any> {
    const role = member.role ?? "write";
    const requestedRole = isFavoriteModelSlot(params.model_slot) ? roleForFavoriteModelSlot(params.model_slot) : role;
    const category = member.category ?? null;
    return {
      agentId: member.agentId,
      role,
      requestedRole,
      resolvedRole: role,
      requestedCategory: params.category ?? null,
      category,
      resolvedCategory: category,
      requestedModelSlot: canonicalPersistedModelSlot(params.model_slot) ?? null,
      modelSlot: canonicalPersistedModelSlot(member.modelSlot) ?? null,
      sessionContext: member.sessionContext ?? "none",
      sessionContextAvailable: null,
      model: member.model ?? null,
      thinking: member.thinking ?? null,
      ...extras,
    };
  }

  function queuedResolutionDetails(safeTeamName: string, queued: writeQueue.QueuedWriteSpawn, params: any, extras: Record<string, any> = {}): Record<string, any> {
    const category = queued.category ?? null;
    const level = requireFavoriteModelLevel(loadSettings({ projectDir: queued.cwd }), queued.modelSlot);
    return {
      agentId: `${queued.name}@${safeTeamName}`,
      role: "write",
      requestedRole: isFavoriteModelSlot(params.model_slot) ? roleForFavoriteModelSlot(params.model_slot) : level.role,
      resolvedRole: "write",
      requestedCategory: params.category ?? null,
      category,
      resolvedCategory: category,
      requestedModelSlot: canonicalPersistedModelSlot(params.model_slot) ?? null,
      modelSlot: level.slot,
      model: level.model,
      thinking: level.thinking,
      modelSource: "queued",
      ...extras,
    };
  }

  function spawnResolutionDetails(member: Member, params: any, resolved: ReturnType<typeof resolveModel>, extras: Record<string, any> = {}): Record<string, any> {
    return {
      ...memberResolutionDetails(member, params, extras),
      modelSource: resolved.modelSource,
    };
  }

  const pendingChildController = options.pendingChildController ?? createPendingChildController();
  const queuedReadSpawnsByTeam = new Map<string, QueuedReadSpawn[]>();
  const failedAdmissionsByTeam = new Map<string, QueuedReadSpawn[]>();
  const readQueueDrainingTeams = new Set<string>();
  const pendingQueueDrains = new Set<string>();
  const readAdmissionReservationsByTeam = new Map<string, Map<string, { count: number; role: string }>>();
  const nestedReadNameReservationsByTeam = new Map<string, Map<string, string>>();

  function activeAgentCount(teamName: string, role?: string, includeReservations = false): number {
    const activeKeys = new Set<string>();
    if (includeReservations) {
      for (const [key, reservation] of readAdmissionReservationsByTeam.get(teamName) ?? []) {
        if (!role || reservation.role === role) activeKeys.add(key);
      }
    }
    for (const [key, agent] of options.runningReadAgents) {
      if (agent.teamName === teamName && (!role || (agent.role || "read") === role)) activeKeys.add(key);
    }
    return activeKeys.size;
  }

  function reserveReadAdmission(teamName: string, key: string, role: string): void {
    const reservations = readAdmissionReservationsByTeam.get(teamName) ?? new Map<string, { count: number; role: string }>();
    const pending = reservations.get(key);
    if (pending && pending.role !== role) throw new Error(`Agent ${key} already has a ${pending.role} admission in progress.`);
    reservations.set(key, { count: (pending?.count ?? 0) + 1, role });
    readAdmissionReservationsByTeam.set(teamName, reservations);
  }

  function releaseReadAdmission(teamName: string, key: string): void {
    const reservations = readAdmissionReservationsByTeam.get(teamName);
    if (!reservations) return;
    const reservation = reservations.get(key);
    if (reservation && reservation.count > 1) reservation.count -= 1;
    else reservations.delete(key);
    if (reservations.size === 0) readAdmissionReservationsByTeam.delete(teamName);
  }

  function reserveNestedReadName(teamName: string, name: string): string {
    const reservations = nestedReadNameReservationsByTeam.get(teamName) ?? new Map<string, string>();
    if (reservations.has(name)) {
      throw new Error(`Nested read agent ${name} is already active or queued; nested delegation cannot replace an existing run.`);
    }
    const reservationId = crypto.randomUUID();
    reservations.set(name, reservationId);
    nestedReadNameReservationsByTeam.set(teamName, reservations);
    return reservationId;
  }

  function releaseNestedReadName(teamName: string, name: string, reservationId?: string): void {
    if (!reservationId) return;
    const reservations = nestedReadNameReservationsByTeam.get(teamName);
    if (reservations?.get(name) !== reservationId) return;
    reservations.delete(name);
    if (reservations.size === 0) nestedReadNameReservationsByTeam.delete(teamName);
  }

  function readQueue(teamName: string): QueuedReadSpawn[] {
    return queuedReadSpawnsByTeam.get(teamName) ?? [];
  }

  function nestedChildSnapshot(binding: NestedReadAgentToolBinding): NestedChildSnapshot {
    const parent = {
      teamName: binding.teamName,
      parentName: binding.parent.name,
      parentRunId: binding.parentRunId,
    };
    const queued = readQueue(binding.teamName).filter((child) => {
      const childParent = pendingParentForMember(binding.teamName, child.member);
      return childParent?.parentName === parent.parentName && childParent.parentRunId === parent.parentRunId;
    }).length;
    const pending = pendingChildController.pendingCount(parent);
    return { running: Math.max(0, pending - queued), queued };
  }

  async function listQueuedAgentStatuses(teamName: string): Promise<QueuedAgentStatus[]> {
    const readers = [...readQueue(teamName), ...(failedAdmissionsByTeam.get(teamName) ?? [])].map((queued, index) => ({
      name: queued.member.name,
      role: queued.member.role || "read",
      queuedAt: queued.requestedAt,
      queuePosition: index + 1,
      parentAgentName: queued.member.parentAgentName,
      parentLifecycleRunId: queued.member.parentLifecycleRunId,
      error: queued.admissionError || queued.quarantineError,
      failed: !!queued.admissionError,
    }));
    const writers = (await writeQueue.listWriteQueue(teamName)).map((queued, index) => ({
      name: queued.name,
      role: "write",
      queuedAt: queued.requestedAt,
      queuePosition: index + 1,
    }));
    return [...readers, ...writers];
  }

  function statusTool(scope?: AgentStatusScope, fixedTeamName?: string): any {
    return createAgentStatusTool({
      getTeamName: () => fixedTeamName ?? options.getTeamName(),
      runningReadAgents: options.runningReadAgents,
      readAgentKey: options.readAgentKey,
      terminal: options.terminal,
      listQueuedAgents: listQueuedAgentStatuses,
      scope,
    });
  }

  const lifecycleFenceUnsubscribe = onLifecycleTombstoneCleared((clearedTeamName) => {
    if (readQueue(clearedTeamName).length > 0) void drainQueuedReadSpawns(clearedTeamName);
  });
  const lifecycleProbeUnsubscribe = pi.events?.on?.(CHILD_AGENT_LIFECYCLE_PROBE, (payload: ChildAgentLifecycleProbe) => {
    const sessionId = getPiSessionId(options.getSessionCtx?.());
    if (!sessionId || payload?.sessionId !== sessionId || typeof payload.respond !== "function") return;
    const activeTeamName = options.getTeamName();
    if (!activeTeamName) return;
    payload.respond({
      sessionId,
      running: activeAgentCount(activeTeamName),
      queued: readQueue(activeTeamName).length,
    });
  });
  let lifecycleProbeCleanedUp = false;
  let pendingChildCancelUnsubscribe = (): void => {};
  pi.on?.("session_shutdown", async () => {
    if (lifecycleProbeCleanedUp) return;
    lifecycleProbeCleanedUp = true;
    const settlements: Promise<void>[] = [];
    for (const [teamName, queue] of queuedReadSpawnsByTeam) {
      for (const queued of queue) {
        const removed = removeQueuedReadSpawnById(teamName, queued.id);
        if (removed?.groupSettlement) settlements.push(removed.groupSettlement);
      }
    }
    try { await Promise.all(settlements); }
    finally {
      if (typeof lifecycleProbeUnsubscribe === "function") lifecycleProbeUnsubscribe();
      pendingChildCancelUnsubscribe();
      lifecycleFenceUnsubscribe();
    }
  });

  function setReadQueue(teamName: string, queue: QueuedReadSpawn[]): void {
    if (queue.length > 0) queuedReadSpawnsByTeam.set(teamName, queue);
    else queuedReadSpawnsByTeam.delete(teamName);
  }

  function findQueuedReadSpawn(teamName: string, params: any): QueuedReadSpawn | undefined {
    return readQueue(teamName).find((queued) => queued.member.name === params.name || memberMatchesOperation(queued.member, params));
  }

  function pendingParentForMember(teamName: string, member: Member): ParentRunIdentity | undefined {
    if (member.delegationDepth !== 1 || !member.parentAgentName || !member.parentLifecycleRunId) return undefined;
    return {
      teamName,
      parentName: member.parentAgentName,
      parentRunId: member.parentLifecycleRunId,
    };
  }

  function settleQueuedGroup(queued: QueuedReadSpawn): Promise<void> | undefined {
    const binding = queued.member.completionGroup;
    if (!binding) return;
    return Promise.resolve().then(async () => {
      const group = new CompletionGroup(queued.teamName, binding.groupId);
      await group.apply({ type: queued.admissionError ? "rejected" : "cancelled", ...binding,
        queueId: queued.id, reason: queued.admissionError || "Queued assignment cancelled." });
      await enqueueCompletionGroupDeliveries(group);
    });
  }

  function removeQueuedReadSpawnById(
    teamName: string,
    id: string,
    settlePendingAcceptance = true
  ): QueuedReadSpawn | undefined {
    const queue = readQueue(teamName);
    const removed = queue.find((queued) => queued.id === id);
    if (!removed) return undefined;
    setReadQueue(teamName, queue.filter((queued) => queued.id !== id));
    releaseNestedReadName(teamName, removed.member.name, removed.nameReservationId);
    if (settlePendingAcceptance && removed.pendingChildAcceptance) {
      pendingChildController.settleAcceptance(removed.pendingChildAcceptance);
    }
    if (settlePendingAcceptance) removed.groupSettlement = settleQueuedGroup(removed);
    return removed;
  }

  function removeQueuedReadSpawnsByName(teamName: string, name: string): QueuedReadSpawn[] {
    const queue = readQueue(teamName);
    const removed = queue.filter((queued) => queued.member.name === name);
    if (removed.length === 0) return [];
    setReadQueue(teamName, queue.filter((queued) => queued.member.name !== name));
    for (const queued of removed) {
      releaseNestedReadName(teamName, queued.member.name, queued.nameReservationId);
      if (queued.pendingChildAcceptance) pendingChildController.settleAcceptance(queued.pendingChildAcceptance);
      queued.groupSettlement = settleQueuedGroup(queued);
    }
    return removed;
  }

  pendingChildCancelUnsubscribe = pendingChildController.onParentCancelled((parent) => {
    const queue = readQueue(parent.teamName);
    for (const queued of queue) {
      const queuedParent = pendingParentForMember(parent.teamName, queued.member);
      if (!queuedParent
        || queuedParent.parentName !== parent.parentName
        || queuedParent.parentRunId !== parent.parentRunId) continue;
      removeQueuedReadSpawnById(parent.teamName, queued.id);
    }
  });

  function queuedReadResolutionDetails(queued: QueuedReadSpawn, params: any, extras: Record<string, any> = {}): Record<string, any> {
    return spawnResolutionDetails(queued.member, params, queued.resolved, {
      mode: "in-process",
      terminalId: null,
      queued: true,
      queueId: queued.id,
      ...extras,
    });
  }

  function assertNestedParentRuntimeActive(
    teamName: string,
    parentName: string,
    parentLifecycleRunId: string
  ): RunningReadAgent {
    const parentStateKey = options.readAgentKey(teamName, parentName);
    const parentState = options.runningReadAgents.get(parentStateKey);
    const closingTeardownStates = new Set(["stopping", "quarantined", "persistence_failed", "finalized"]);
    if (!parentState
      || !options.isCurrentReadAgentRun(parentStateKey, parentState)
      || parentState.runId !== parentLifecycleRunId
      || parentState.messageDeliveryClosed === true
      || parentState.persistedRecipientClosed === true
      || parentState.status === "finishing"
      || parentState.stopRequested
      || (parentState.teardownState !== undefined && closingTeardownStates.has(parentState.teardownState))) {
      throw new Error(`Nested read spawning is no longer authorized for ${parentName}: the bound parent lifecycle is not active.`);
    }
    return parentState;
  }

  async function assertNestedParentAuthorized(
    teamName: string,
    parentName: string,
    parentLifecycleRunId: string,
    parentCwd: string,
    lifecycleLock?: LifecycleTombstoneLock
  ): Promise<Member> {
    const initialFence = lifecycleLock?.read() ?? await readLifecycleTombstone(teamName, parentName);
    if (initialFence.status !== "absent") {
      throw new Error(`Nested read spawning is no longer authorized for ${parentName}: the bound parent lifecycle is not active.`);
    }
    const initialParentState = assertNestedParentRuntimeActive(teamName, parentName, parentLifecycleRunId);

    const config = await teams.readConfig(teamName);
    const persistedParent = config.members.find((candidate) => candidate.name === parentName);
    const finalFence = lifecycleLock?.read() ?? await readLifecycleTombstone(teamName, parentName);
    const finalParentState = assertNestedParentRuntimeActive(teamName, parentName, parentLifecycleRunId);
    if (finalFence.status !== "absent" || finalParentState !== initialParentState) {
      throw new Error(`Nested read spawning is no longer authorized for ${parentName}: the bound parent lifecycle is not active.`);
    }
    if (!persistedParent
      || persistedParent.lifecycleRunId !== parentLifecycleRunId
      || persistedParent.cwd !== parentCwd
      || persistedParent.isActive === false
      || !isEligibleNestedReadParent(persistedParent)) {
      throw new Error(`Nested read spawning is not authorized for ${parentName}: the persisted parent policy or provenance does not match.`);
    }
    return persistedParent;
  }

  async function assertNestedChildAdmission(
    teamName: string,
    child: Member,
    lifecycleLock?: LifecycleTombstoneLock
  ): Promise<void> {
    if (child.role !== "read"
      || child.delegationDepth !== 1
      || child.helperKind !== "read_helper"
      || child.allowNestedReadAgents !== false
      || !child.parentAgentName
      || !child.parentLifecycleRunId
      || child.requestedBy !== child.parentAgentName
      || !NESTED_READ_MODEL_SLOTS.includes(child.modelSlot as NestedReadModelSlot)) {
      throw new Error(`Nested read agent ${child.name} is missing runtime-owned read-only policy or parent provenance.`);
    }
    await assertNestedParentAuthorized(
      teamName,
      child.parentAgentName,
      child.parentLifecycleRunId,
      child.cwd,
      lifecycleLock
    );
  }

  function settlePendingChild(identity: PendingChildAcceptance | PendingChildRun | undefined): void {
    if (!identity) return;
    if ("childRunId" in identity) pendingChildController.settleChildRun(identity);
    else pendingChildController.settleAcceptance(identity);
  }

  async function rollbackAgentAdmission(
    teamName: string,
    member: Member,
    cause: unknown,
    pendingChild: PendingChildAcceptance | PendingChildRun | undefined
  ): Promise<never> {
    const runId = member.lifecycleRunId;
    if (!runId) {
      settlePendingChild(pendingChild);
      throw cause;
    }
    try {
      const removed = await teams.removeMemberMatchingRun(teamName, member.name, runId);
      if (!removed) throw new Error(`matching agent run ${runId} was not present`);
    } catch (rollbackError) {
      const causeMessage = cause instanceof Error ? cause.message : String(cause);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(`${causeMessage} Exact-run rollback for agent ${member.name} failed: ${rollbackMessage}`);
    } finally {
      settlePendingChild(pendingChild);
    }
    throw cause;
  }

  interface AdmittedReadAgentLaunch {
    launch: Promise<void> | void;
    pendingChildRun?: PendingChildRun;
    sessionContextAvailable: boolean;
  }

  async function admitAndLaunchReadAgentMember(
    teamName: string,
    member: Member,
    prompt: string,
    ctx: any,
    queuedAcceptance?: PendingChildAcceptance,
    assertPending?: () => void,
    commitLaunch?: () => void,
  ): Promise<AdmittedReadAgentLaunch> {
    const addValidateAndLaunch = async (parentLifecycleLock?: LifecycleTombstoneLock): Promise<AdmittedReadAgentLaunch> => {
      let pendingAcceptance = queuedAcceptance;
      if (member.delegationDepth === 1) {
        await assertNestedChildAdmission(teamName, member, parentLifecycleLock);
        const parent = pendingParentForMember(teamName, member);
        if (!parent) throw new Error(`Nested read agent ${member.name} is missing exact parent identity.`);
        pendingAcceptance ??= pendingChildController.acceptChild(parent, member.name);
      }

      try {
        if (lifecycleProbeCleanedUp) throw new Error("Agent session is closing; admission cancelled.");
        assertPending?.();
        await teams.addMember(teamName, member);
      } catch (error) {
        settlePendingChild(pendingAcceptance);
        throw error;
      }

      try {
        if (member.completionGroup) {
          if (!member.lifecycleRunId) throw new Error("Grouped admission requires an actual lifecycle run.");
          await new CompletionGroup(teamName, member.completionGroup.groupId).apply({
            type: "running", ...member.completionGroup, runId: member.lifecycleRunId,
          });
        }
        if (lifecycleProbeCleanedUp) throw new Error("Agent session is closing; admission cancelled.");
        assertPending?.();
      } catch (error) {
        return rollbackAgentAdmission(teamName, member, error, pendingAcceptance);
      }
      let pendingChildRun: PendingChildRun | undefined;
      if (member.delegationDepth === 1) {
        const runId = member.lifecycleRunId;
        if (!pendingAcceptance || !runId) {
          return rollbackAgentAdmission(
            teamName,
            member,
            new Error(`Nested read agent ${member.name} did not receive an exact lifecycle run identity.`),
            pendingAcceptance
          );
        }
        pendingChildRun = pendingChildController.bindAcceptedChild(pendingAcceptance, member.name, runId);
        if (!pendingChildRun) {
          return rollbackAgentAdmission(
            teamName,
            member,
            new Error(`Nested read agent ${member.name} lost its parent acceptance before launch.`),
            pendingAcceptance
          );
        }

        try {
          await assertNestedChildAdmission(teamName, member, parentLifecycleLock);
        } catch (error) {
          return rollbackAgentAdmission(teamName, member, error, pendingChildRun);
        }
      }

      let sessionContextReference: ReturnType<typeof createSessionContextReference> = null;
      if (member.sessionContext === "lazy" && member.lifecycleRunId) {
        try {
          sessionContextReference = createSessionContextReference({
            teamName,
            agentName: member.name,
            lifecycleRunId: member.lifecycleRunId,
            sessionManager: ctx?.sessionManager,
          });
        } catch {
          // Context fallback is optional and must never block an otherwise valid spawn.
          sessionContextReference = null;
        }
      }
      const launchPrompt = sessionContextReference
        ? `${prompt}${sessionContextReference.promptSuffix}`
        : prompt;
      const removeReference = () => {
        try {
          removeSessionContextReference(sessionContextReference);
        } catch {
          // Exact-run teardown remains authoritative; stale reference cleanup is best effort.
        }
      };

      try {
        if (lifecycleProbeCleanedUp) throw new Error("Agent session is closing; admission cancelled.");
        assertPending?.();
        commitLaunch?.();
        const launch = options.runReadAgentInProcess(teamName, member, launchPrompt, ctx, options.readAgentOptions());
        return {
          launch: sessionContextReference
            ? Promise.resolve(launch).finally(removeReference)
            : launch,
          pendingChildRun,
          sessionContextAvailable: !!sessionContextReference,
        };
      } catch (error) {
        removeReference();
        return rollbackAgentAdmission(teamName, member, error, pendingChildRun);
      }
    };

    if (member.delegationDepth !== 1 || !member.parentAgentName) {
      return addValidateAndLaunch();
    }
    return withLifecycleTombstoneLock(teamName, member.parentAgentName, async parentLifecycleLock => {
      return addValidateAndLaunch(parentLifecycleLock);
    });
  }

  async function startReadAgentMember(
    teamName: string,
    member: Member,
    prompt: string,
    ctx: any,
    nameReservationId?: string,
    releaseNameOnFailure = true,
    queuedAcceptance?: PendingChildAcceptance,
    assertPending?: () => void,
    commitLaunch?: () => void,
  ): Promise<boolean> {
    const key = options.readAgentKey(teamName, member.name);
    reserveReadAdmission(teamName, key, member.role || "read");

    const releaseNameReservation = () => {
      releaseNestedReadName(teamName, member.name, nameReservationId);
    };
    const releaseReservationAndDrain = () => {
      if (releaseNameOnFailure) releaseNameReservation();
      releaseReadAdmission(teamName, key);
      void drainQueuedReadSpawns(teamName);
    };
    const finishRun = (pendingChildRun: PendingChildRun | undefined) => {
      settlePendingChild(pendingChildRun);
      releaseReadAdmission(teamName, key);
      void drainQueuedReadSpawns(teamName);
    };
    const drainAfterRun = (pendingChildRun: PendingChildRun | undefined) => {
      const currentState = options.runningReadAgents.get(key);
      if (currentState?.teardownFinalizationPromise) {
        // A completing runner can resolve before lifecycle finalization releases
        // capacity or exact child ownership. Attach one observer; finalization
        // remains authoritative while the run is quarantined.
        void Promise.resolve(currentState.teardownFinalizationPromise).then(
          () => finishRun(pendingChildRun),
          () => finishRun(pendingChildRun),
        );
        return;
      }
      finishRun(pendingChildRun);
    };

    try {
      const admitted = await admitAndLaunchReadAgentMember(teamName, member, prompt, ctx, queuedAcceptance, assertPending, commitLaunch);
      releaseNameReservation();
      void Promise.resolve(admitted.launch).then(
        () => drainAfterRun(admitted.pendingChildRun),
        () => drainAfterRun(admitted.pendingChildRun)
      );
      return admitted.sessionContextAvailable;
    } catch (error) {
      settlePendingChild(queuedAcceptance);
      releaseReservationAndDrain();
      throw error;
    }
  }

  async function enqueueReadSpawn(
    teamName: string,
    member: Member,
    prompt: string,
    params: any,
    resolved: ReturnType<typeof resolveModel>,
    ctx: any,
    nameReservationId?: string
  ): Promise<QueuedReadSpawn> {
    const append = async (pendingChildAcceptance?: PendingChildAcceptance): Promise<QueuedReadSpawn> => {
      const queued: QueuedReadSpawn = {
        id: crypto.randomUUID(),
        teamName,
        member,
        prompt,
        params,
        resolved,
        ctx,
        requestedAt: Date.now(),
        nameReservationId,
        pendingChildAcceptance,
      };
      if (member.completionGroup) {
        const group = new CompletionGroup(teamName, member.completionGroup.groupId);
        await group.apply({ type: "queued", ...member.completionGroup, queueId: queued.id });
        if (lifecycleProbeCleanedUp) {
          await group.apply({ type: "cancelled", ...member.completionGroup, reason: "Agent session is closing." });
          throw new Error("Agent session is closing; admission cancelled.");
        }
      }
      if (readQueue(teamName).some(item => item.member.name === member.name)) {
        throw new Error(`Nested read agent ${member.name} is already active or queued; nested delegation cannot replace an existing run.`);
      }
      setReadQueue(teamName, [...readQueue(teamName), queued]);
      void drainQueuedReadSpawns(teamName);
      return queued;
    };

    if (member.delegationDepth !== 1 || !member.parentAgentName) return append();
    return withLifecycleTombstoneLock(teamName, member.parentAgentName, async parentLifecycleLock => {
      await assertNestedChildAdmission(teamName, member, parentLifecycleLock);
      const currentConfig = await teams.readConfig(teamName);
      if (currentConfig.members.some((candidate) => candidate.name === member.name)) {
        throw new Error(`Nested read agent ${member.name} is already active or queued; nested delegation cannot replace an existing run.`);
      }
      const parent = pendingParentForMember(teamName, member);
      if (!parent) throw new Error(`Nested read agent ${member.name} is missing exact parent identity.`);
      const pendingChildAcceptance = pendingChildController.acceptChild(parent, member.name);
      try {
        return await append(pendingChildAcceptance);
      } catch (error) {
        pendingChildController.settleAcceptance(pendingChildAcceptance);
        throw error;
      }
    });
  }

  async function drainQueuedReadSpawns(teamName: string): Promise<void> {
    if (lifecycleProbeCleanedUp) return;
    if (readQueueDrainingTeams.has(teamName)) {
      pendingQueueDrains.add(teamName);
      return;
    }
    readQueueDrainingTeams.add(teamName);
    try {
      let progressed = true;
      while (progressed && !lifecycleProbeCleanedUp) {
        progressed = false;
        for (const queued of readQueue(teamName)) {
          if (queued.admissionError) continue;
          const role = queued.member.role || "read";
          const settings = loadSettings({ projectDir: queued.member.cwd });
          const capacity = role === "write" ? settings.writeAgents : settings.readAgents;
          if (activeAgentCount(teamName, role, true) >= capacity.maxConcurrent) continue;
          const assertPending = () => {
            if (!readQueue(teamName).some(item => item.id === queued.id)) throw new Error(`Queued agent ${queued.member.name} was cancelled.`);
          };
          try {
            const fence = await readLifecycleTombstone(teamName, queued.member.name);
            if (fence.status !== "absent") {
              queued.quarantineError = fence.status === "corrupt" ? fence.error : `Lifecycle run ${fence.tombstone.runId} is quarantined.`;
              continue;
            }
            queued.quarantineError = undefined;
            const config = await teams.readConfig(teamName);
            assertPending();
            if (config.members.some(member => member.name === queued.member.name)) throw new Error(`A teammate named ${queued.member.name} already exists.`);
            if (activeAgentCount(teamName, role, true) >= capacity.maxConcurrent) continue;
            queued.member.joinedAt = Date.now();
            await startReadAgentMember(teamName, queued.member, queued.prompt, queued.ctx,
              queued.nameReservationId, false, queued.pendingChildAcceptance, assertPending,
              () => { queued.launchCommitted = true; });
            removeQueuedReadSpawnById(teamName, queued.id, false);
            progressed = true;
          } catch (error) {
            if (!readQueue(teamName).some(item => item.id === queued.id)) continue;
            queued.launchCommitted = false;
            const latestFence = await readLifecycleTombstone(teamName, queued.member.name).catch(() => null);
            if (latestFence && latestFence.status !== "absent") {
              queued.quarantineError = "Lifecycle quarantine appeared before admission.";
              continue;
            }
            queued.admissionError = error instanceof Error ? error.message : String(error);
            failedAdmissionsByTeam.set(teamName, [...(failedAdmissionsByTeam.get(teamName) ?? []), queued].slice(-20));
            const removed = removeQueuedReadSpawnById(teamName, queued.id);
            let groupSettlementFailed = false;
            await removed?.groupSettlement?.catch(error => {
              groupSettlementFailed = true;
              queued.admissionError += ` Group settlement failed: ${error instanceof Error ? error.message : String(error)}`;
            });
            if (!queued.member.completionGroup || groupSettlementFailed) {
              await messaging.sendPlainMessage(teamName, "system", queued.member.parentAgentName || "team-lead",
                `Queued agent ${queued.member.name} failed admission: ${queued.admissionError}`,
                `Queued agent ${queued.member.name} failed`, "red").catch(() => {});
            }
          }
        }
      }
    } finally {
      readQueueDrainingTeams.delete(teamName);
      if (pendingQueueDrains.delete(teamName)) void drainQueuedReadSpawns(teamName);
    }
  }

  function currentSessionAgentGroupName(ctx: any): string {
    const sessionId = getPiSessionId(ctx) || "local-session";
    return paths.sanitizeName(`session-${sessionId}`);
  }

  let admittingPublicTeam: string | undefined;
  let publicAdmissions = 0;
  async function withPublicScope<T>(teamName: string, action: () => Promise<T>): Promise<T> {
    if (teamName.startsWith("prompt-build-")) return action();
    if (publicAdmissions > 0 && admittingPublicTeam !== teamName) {
      throw new Error(`Cannot switch to ${teamName}: ${admittingPublicTeam} has unfinished agents being admitted.`);
    }
    admittingPublicTeam = teamName;
    publicAdmissions += 1;
    try {
      return await action();
    } finally {
      if (--publicAdmissions === 0) admittingPublicTeam = undefined;
    }
  }

  async function requireSettledPublicScope(nextTeamName: string): Promise<void> {
    if (lifecycleProbeCleanedUp) throw new Error("Agent session is closing; admission cancelled.");
    const current = options.getTeamName();
    if (!current || current === nextTeamName || nextTeamName.startsWith("prompt-build-")) return;
    const [config, fences, queued] = await Promise.all([
      teams.readConfig(current), listLifecycleTombstones(current), listQueuedAgentStatuses(current),
    ]);
    const unfinished = config.members.some(member => member.name !== "team-lead")
      || fences.length > 0 || queued.some(item => !item.failed)
      || Array.from(options.runningReadAgents.values()).some(agent => agent.teamName === current && agent.teardownState !== "finalized");
    if (unfinished) throw new Error(`Cannot switch from ${current} to ${nextTeamName}: unfinished agents must remain visible. Finish or stop them first.`);
  }

  async function ensureCurrentSessionAgentGroup(ctx: any, explicitDefaultModel: string): Promise<string> {
    const sessionName = currentSessionAgentGroupName(ctx);
    await requireSettledPublicScope(sessionName);
    if (teams.teamExists(sessionName)) {
      options.adoptTeamAsLead(sessionName, ctx);
      return sessionName;
    }

    const { availableModels } = await getModelSelectionState(ctx, ctx.cwd, [explicitDefaultModel]);
    const defaultModel = requireQualifiedKnownModel(explicitDefaultModel, availableModels, "model_slot");
    if (!defaultModel) throw new Error("Agent sessions require a configured model_slot level before spawning.");
    try {
      teams.createTeamIfAbsent(sessionName, getPiSessionId(ctx) || "local-session", "lead-agent", "Pi session agents", defaultModel);
    } catch (error) {
      if (!(error instanceof teams.TeamAlreadyExistsError)) throw error;
    }
    options.adoptTeamAsLead(sessionName, ctx);
    return sessionName;
  }

  async function spawnTeammate(params: any, ctx: any, spawnOptions: SpawnTeammateOptions = {}): Promise<{ content: any[]; details: any }> {
    const assignedChecks = normalizeCheckPolicy(params.checks);
    const repairPolicy = normalizeRepairPolicy(params.repair);
    if (repairPolicy && !assignedChecks?.length) throw new Error("Repair policy requires explicitly assigned checks.");
    const safeName = paths.sanitizeName(params.name);
    const safeTeamName = paths.sanitizeName(params.team_name);
    const cwd = params.cwd || ctx.cwd;
    const teamConfig = await teams.readConfig(safeTeamName);
    failedAdmissionsByTeam.set(safeTeamName, (failedAdmissionsByTeam.get(safeTeamName) ?? []).filter(item => item.member.name !== safeName));
    let nestedNameReservationId: string | undefined;
    let nestedNameReservationTransferred = false;

    if (spawnOptions.nestedParent) {
      rejectUnexpectedNestedParams(params, ["name", "prompt", "model_slot", "team_name", "cwd"], `Nested read agent ${safeName}`);
      requireNestedReadSpawnLevel(params, `Nested read agent ${safeName}`);
      if (safeTeamName !== spawnOptions.nestedParent.teamName || params.team_name !== spawnOptions.nestedParent.teamName) {
        throw new Error("Nested read agents must remain in the bound parent team.");
      }
      if (cwd !== spawnOptions.nestedParent.cwd || params.cwd !== spawnOptions.nestedParent.cwd) {
        throw new Error("Nested read agents must use the bound parent cwd.");
      }
      await assertNestedParentAuthorized(
        safeTeamName,
        spawnOptions.nestedParent.name,
        spawnOptions.nestedParent.lifecycleRunId,
        spawnOptions.nestedParent.cwd
      );

      const activeDuplicate = teamConfig.members.find((candidate) => candidate.name === safeName);
      const queuedReadDuplicate = findQueuedReadSpawn(safeTeamName, { name: safeName });
      const queuedWriteDuplicate = await writeQueue.findQueuedWriteSpawn(safeTeamName, { name: safeName });
      if (activeDuplicate || queuedReadDuplicate || queuedWriteDuplicate) {
        throw new Error(`Nested read agent ${safeName} is already active or queued; nested delegation cannot replace an existing run.`);
      }
      nestedNameReservationId = reserveNestedReadName(safeTeamName, safeName);
    }

    try {
    if (spawnOptions.once) {
      const existingOnceMember = teamConfig.members.find(m => m.agentType === "teammate" && (m.name === safeName || memberMatchesOperation(m, params)));
      if (existingOnceMember) {
        return {
          content: [{ type: "text", text: `Teammate ${safeName} already exists; reusing existing member.` }],
          details: memberResolutionDetails(existingOnceMember, params, {
            existing: true,
            idempotent: true,
            queued: false,
            terminalId: existingOnceMember.tmuxPaneId || null,
            modelSource: "existing",
          }),
        };
      }

      const queuedRead = findQueuedReadSpawn(safeTeamName, { ...params, name: safeName });
      if (queuedRead) {
        const queuePosition = readQueue(safeTeamName).findIndex((item) => item.id === queuedRead.id) + 1;
        return {
          content: [{ type: "text", text: `Read teammate ${safeName} is already queued at position ${queuePosition}.` }],
          details: queuedReadResolutionDetails(queuedRead, params, { queuePosition, existing: true, idempotent: true }),
        };
      }

      const queued = await writeQueue.findQueuedWriteSpawn(safeTeamName, {
        name: safeName,
        operationId: params.operation_id,
        workflowRunId: params.workflow_run_id,
      });
      if (queued) {
        const queuedItems = await writeQueue.listWriteQueue(safeTeamName);
        const queuePosition = queuedItems.findIndex(item => item.id === queued.id) + 1;
        return {
          content: [{ type: "text", text: `Write teammate ${safeName} is already queued at position ${queuePosition}.` }],
          details: queuedResolutionDetails(safeTeamName, queued, params, { queued: true, queueId: queued.id, queuePosition, existing: true, idempotent: true }),
        };
      }
    }

    const existingMember = teamConfig.members.find(m => m.name === safeName && m.agentType === "teammate");
    if (existingMember) {
      const key = options.readAgentKey(safeTeamName, existingMember.name);
      const expectedState = options.runningReadAgents.get(key);
      const teardown = await options.shutdownTeammate(safeTeamName, existingMember);
      const currentState = options.runningReadAgents.get(key);
      const lifecycleBlocked = teardown.status !== "settled"
        || !teardown.finalized
        || !teardown.removedMember
        || (currentState === expectedState && !!currentState && (
          currentState.status === "finishing"
          || currentState.teardownState === "stopping"
          || currentState.teardownState === "quarantined"
          || currentState.teardownState === "persistence_failed"
        ));
      if (lifecycleBlocked) {
        const reason = teardown.status === "persistence_failed"
          ? "cleanup is blocked because persisted message admission could not be closed"
          : teardown.status === "cleanup_failed"
            ? `cleanup failed${teardown.error ? `: ${teardown.error}` : ""}`
            : "the previous run is still finishing or quarantined";
        throw new Error(`Agent ${safeName} cannot be restarted yet: ${reason}. Retry after lifecycle cleanup settles.`);
      }
    }

    const settings = loadSettings({ projectDir: cwd });
    const modelSlot = spawnOptions.nestedParent
      ? requireNestedReadSpawnLevel(params, `Nested read agent ${safeName}`)
      : requireSpawnLevel(params, `Agent ${safeName}`);
    const role: AgentRole = roleForFavoriteModelSlot(modelSlot);
    const configuredFavorite = settings.favoriteModels[modelSlot];
    const requestedFavoriteModel = configuredFavorite?.model && configuredFavorite.thinking ? configuredFavorite.model : undefined;
    const currentModel = getCurrentQualifiedModel(ctx);
    const { availableModels } = await getModelSelectionState(ctx, ctx.cwd, [teamConfig.defaultModel, requestedFavoriteModel, currentModel].filter(Boolean) as string[]);
    const resolved = resolveModel(settings, {
      role,
      modelSlot,
      explicitModel: null,
      explicitThinking: null,
      teamDefaultModel: teamConfig.defaultModel,
      currentModel,
      currentThinking: ctx.thinkingLevel,
    });

    const chosenModel = requireQualifiedKnownModel(resolved.model ?? undefined, availableModels, "resolved model");
    if (!chosenModel) {
      throw new Error(
        `Agent ${safeName} could not resolve model_slot "${modelSlot}": it is not configured and neither the team nor current lead session has a model.`
      );
    }

    const chosenThinking = (resolved.thinking ?? ctx.thinkingLevel ?? null) as Member["thinking"];
    const debugLogPath = role === "write" && isTeamsDebugEnabled(settings) ? teamDebugLogPath(safeTeamName) : undefined;

    const member: Member = {
      agentId: `${safeName}@${safeTeamName}`,
      name: safeName,
      agentType: "teammate",
      role,
      category: params.category,
      modelSlot,
      model: chosenModel,
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd,
      subscriptions: [],
      prompt: params.prompt,
      color: role === "read" ? "cyan" : "blue",
      thinking: chosenThinking,
      planModeRequired: params.plan_mode_required,
      assignedChecks,
      repairPolicy,
      completionGroup: spawnOptions.completionGroup,
      metadata: operationMetadataFromParams(params),
      delegationDepth: spawnOptions.nestedParent ? 1 : 0,
      allowNestedReadAgents: !spawnOptions.nestedParent && spawnOptions.allowNestedReadAgents === true,
      sessionContext: !spawnOptions.nestedParent && params.session_context === "lazy" ? "lazy" : undefined,
      parentAgentName: spawnOptions.nestedParent?.name,
      parentLifecycleRunId: spawnOptions.nestedParent?.lifecycleRunId,
      requestedBy: spawnOptions.nestedParent?.name,
      helperKind: spawnOptions.nestedParent ? "read_helper" : undefined,
    };

    if (role === "write") await writeQueue.removeQueuedWriteSpawnsByName(safeTeamName, safeName);
    if (!spawnOptions.nestedParent) {
      const removed = removeQueuedReadSpawnsByName(safeTeamName, safeName);
      if (removed.some(item => item.groupSettlement)) await Promise.all(removed.map(item => item.groupSettlement));
    }
    if (lifecycleProbeCleanedUp) throw new Error("Agent session is closing; admission cancelled.");
    const capacity = role === "write" ? settings.writeAgents : settings.readAgents;
    const activeCount = activeAgentCount(safeTeamName, role, true);
    if (activeCount >= capacity.maxConcurrent) {
      if (!capacity.queueOverflow) {
        throw new Error(`${role === "write" ? "Edit" : "Read"}-agent capacity reached (${activeCount}/${capacity.maxConcurrent}) and queueOverflow is disabled.`);
      }
      const queued = await enqueueReadSpawn(safeTeamName, member, params.prompt, params, resolved, ctx, nestedNameReservationId);
      nestedNameReservationTransferred = !!nestedNameReservationId;
      const queuePosition = readQueue(safeTeamName).findIndex(item => item.id === queued.id) + 1;
      return {
        content: [{ type: "text", text: `Agent ${params.name} queued at position ${queuePosition}; capacity is ${activeCount}/${capacity.maxConcurrent}.` }],
        details: queuedReadResolutionDetails(queued, params, { queuePosition }),
      };
    }

    const sessionContextAvailable = await startReadAgentMember(safeTeamName, member, params.prompt, ctx, nestedNameReservationId);
    if (role === "write") {
      await writeTeamsDebugEvent(safeTeamName, "write-agent.spawn.success", {
        agentName: safeName, cwd, requestedRole: role, model: chosenModel,
        modelSource: resolved.modelSource, thinking: chosenThinking ?? null,
        activeWriteCount: activeCount, maxConcurrent: capacity.maxConcurrent,
        queueOverflow: capacity.queueOverflow, terminalId: null, mode: "in-process",
        debugLogPath: debugLogPath ?? null,
      }, settings);
    }
    options.renderReadAgentStatus();
    const debugSuffix = debugLogPath ? ` Debug log: ${debugLogPath}.` : "";
    return {
      content: [{ type: "text", text: `${role === "write" ? "Edit agent" : "Read teammate"} ${params.name} started in-process and is followable from Pi.${debugSuffix}` }],
      details: spawnResolutionDetails(member, params, resolved, {
        mode: "in-process", terminalId: null, queued: false, debugLogPath, sessionContextAvailable,
      }),
    };
    } finally {
      if (!nestedNameReservationTransferred) {
        releaseNestedReadName(safeTeamName, safeName, nestedNameReservationId);
      }
    }
  }

  async function handleOrchestrationRequest(payload: any): Promise<void> {
    const requestId = payload?.requestId;
    const type = String(payload?.type || "");
    const params = payload?.params || {};
    const requestCtx = payload?.ctx;
    const ctx = requestCtx || options.getSessionCtx?.();
    if (requestCtx) options.setSessionCtx?.(requestCtx);

    try {
      if (options.isTeammate) throw new Error("Teammates cannot satisfy orchestration requests directly.");
      if (!ctx) throw new Error("No active lead session context is available for orchestration request. If pi-extended-teams was registered after session_start, include the current Pi command context as payload.ctx.");

      if (type === "ensure_team" || type === "spawn_teammate_once") {
        await requireSettledPublicScope(paths.sanitizeName(params.team_name));
      }
      if (type === "ensure_team") {
        const safeTeamName = paths.sanitizeName(params.team_name);
        if (teams.teamExists(safeTeamName)) {
          const config = await teams.readConfig(safeTeamName);
          options.adoptTeamAsLead(safeTeamName, ctx);
          emitOrchestrationResponse(requestId, type, { ok: true, details: { config, created: false, idempotent: true } });
          return;
        }

        if (params.default_model || params.model || params.thinking || params.role) {
          throw new Error("ensure_team must use default_model_slot only; direct model, thinking, or role is not allowed.");
        }
        const level = requireFavoriteModelLevel(loadSettings({ projectDir: ctx.cwd }), params.default_model_slot || "read-review");
        const { availableModels } = await getModelSelectionState(ctx, ctx.cwd, [level.model]);
        const defaultModel = requireQualifiedKnownModel(level.model, availableModels, "default_model_slot");
        if (!defaultModel) throw new Error(`Favorite level ${level.slot} resolved to unavailable model ${level.model}.`);
        const result = await teams.ensureTeam({
          name: safeTeamName,
          sessionId: "local-session",
          leadAgentId: "lead-agent",
          description: params.description,
          defaultModel,
          metadata: operationMetadataFromParams(params),
        });
        options.adoptTeamAsLead(safeTeamName, ctx);
        emitOrchestrationResponse(requestId, type, { ok: true, details: { config: result.config, created: result.created, idempotent: true } });
        return;
      }

      if (type === "spawn_teammate_once") {
        const safeTeamName = paths.sanitizeName(params.team_name);
        if (!teams.teamExists(safeTeamName)) throw new Error(`Team ${params.team_name} does not exist`);
        options.adoptTeamAsLead(safeTeamName, ctx);
        const result = await spawnTeammate(params, ctx, {
          once: true,
          allowNestedReadAgents: params.allow_nested_read_agents === true,
        });
        emitOrchestrationResponse(requestId, type, { ok: true, details: result.details, content: result.content });
        return;
      }

      if (type === "spawn_agent") {
        const result = await spawnPublicAgent(params, ctx);
        emitOrchestrationResponse(requestId, type, { ok: true, details: result.details, content: result.content });
        return;
      }

      throw new Error(`Unsupported orchestration request type: ${type}`);
    } catch (error) {
      emitOrchestrationResponse(requestId, type, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  pi.events?.on?.("pi-extended-teams:orchestration-request", (payload: any) => {
    if (payload?.type !== "ensure_team" && payload?.type !== "spawn_teammate_once") return handleOrchestrationRequest(payload);
    return withPublicScope(String(payload?.params?.team_name || ""), () => handleOrchestrationRequest(payload))
      .catch(error => emitOrchestrationResponse(payload?.requestId, payload?.type, { ok: false, error: error instanceof Error ? error.message : String(error) }));
  });

  const levelDescription = "Required intent tier. Configured favorites take priority; an unconfigured tier inherits the current lead model and thinking. Read tiers: read-collect gathers bounded facts without owning the conclusion; read-review is the normal default for focused review, verification, and bounded synthesis; read-analyze explains behavior or root cause across connected evidence; read-critical is only for irreducible high-stakes security, architecture, concurrency, migration, or data-correctness reasoning. Write tiers: write-patch makes a narrow localized change; write-feature implements a bounded feature with a known design; write-system owns a cross-cutting integration or refactor within explicitly claimed files; write-critical is only for high-risk security, concurrency, recovery, migration, or data-integrity changes. Prefer canonical tiers; legacy reading-*/writing-* aliases remain accepted for this minor release. Do not pass role, model, or thinking directly; see README.md.";
  const publicAgentBaseParams = {
    name: Type.Optional(Type.String({ description: "Stable display name. Defaults to a generated agent name." })),
    prompt: Type.String({ description: "The agent's assignment, relevant prior context, evidence already gathered, constraints, and report shape." }),
    cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the lead session cwd." })),
    checks: Type.Optional(CheckPolicySchema),
    repair: Type.Optional(RepairPolicySchema),
    session_context: Type.Optional(StringEnum(["none", "lazy"] as const, { description: "Optional filtered snapshot of the lead's active session branch. Use lazy only when omitted session history may materially affect the lane; the child reads it on demand rather than receiving transcript content in its prompt.", default: "none" })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
    allow_nested_read_agents: Type.Optional(Type.Boolean({ description: "Opt in eligible depth-0 write-feature/write-critical agents to restricted read-only child spawning.", default: false })),
  };
  const publicAgentParams = {
    ...publicAgentBaseParams,
    model_slot: StringEnum(ACCEPTED_FAVORITE_MODEL_SLOTS, { description: levelDescription, default: "read-review" }),
  };
  const publicSwarmAgentParams = {
    ...publicAgentBaseParams,
    model_slot: Type.Optional(StringEnum(ACCEPTED_FAVORITE_MODEL_SLOTS, { description: levelDescription })),
  };

  function generatedAgentName(index?: number): string {
    const position = index === undefined ? "" : `-${index + 1}`;
    return `agent-${Date.now().toString(36)}${position}-${crypto.randomUUID().slice(0, 8)}`;
  }

  function spawnPublicAgent(params: any, ctx: any): Promise<{ content: any[]; details: any }> {
    return withPublicScope(currentSessionAgentGroupName(ctx), () => spawnPublicAgentInScope(params, ctx));
  }

  async function spawnPublicAgentInScope(params: any, ctx: any): Promise<{ content: any[]; details: any }> {
    if (options.isTeammate) throw new Error("Only the lead session can spawn agents.");
    if (!ctx) throw new Error("No active Pi session context is available for spawn_agent.");

    const sessionDefaultModel = configuredFavoriteModelForSpawn(params, ctx);
    const sessionName = await ensureCurrentSessionAgentGroup(ctx, sessionDefaultModel);
    const name = params.name || generatedAgentName();
    const result = await spawnTeammate({
      ...params,
      name,
      team_name: sessionName,
    }, ctx, { allowNestedReadAgents: params.allow_nested_read_agents === true });

    const outcome = result.details.queued
      ? `Agent ${name} queued at position ${result.details.queuePosition}.`
      : `Agent ${name} started (${result.details.role}, ${result.details.mode || "in-process"}).`;
    return {
      content: [{ type: "text", text: `${outcome}\n${AGENT_WAIT_CONTRACT}` }],
      details: { ...result.details, name, session: sessionName },
    };
  }

  const nestedReadAgentParams = {
    name: Type.Optional(Type.String({ description: "Stable child name. Defaults to a generated name." })),
    prompt: Type.String({ description: "Read-only assignment and required report shape." }),
    model_slot: StringEnum(NESTED_READ_MODEL_SLOTS, { description: "Required canonical read-* intent tier." }),
  };
  const nestedSwarmAgentParams = {
    name: Type.Optional(Type.String({ description: "Stable child name. Defaults to a generated name." })),
    prompt: Type.String({ description: "Read-only assignment and required report shape." }),
    model_slot: Type.Optional(StringEnum(NESTED_READ_MODEL_SLOTS, { description: "Canonical read-* tier, or inherit defaults.model_slot." })),
  };

  async function spawnNestedReadAgent(
    params: any,
    binding: NestedReadAgentToolBinding,
    context = "spawn_agent"
  ): Promise<{ content: any[]; details: any }> {
    rejectUnexpectedNestedParams(params, ["name", "prompt", "model_slot"], context);
    requireNestedReadSpawnLevel(params, context);
    await assertNestedParentAuthorized(binding.teamName, binding.parent.name, binding.parentRunId, binding.parent.cwd);
    const name = params.name || generatedAgentName();
    const result = await spawnTeammate({
      name,
      prompt: params.prompt,
      model_slot: params.model_slot,
      team_name: binding.teamName,
      cwd: binding.parent.cwd,
    }, binding.outerCtx, {
      nestedParent: {
        teamName: binding.teamName,
        name: binding.parent.name,
        lifecycleRunId: binding.parentRunId,
        cwd: binding.parent.cwd,
      },
    });
    return {
      content: [...result.content, { type: "text", text: AGENT_WAIT_CONTRACT }],
      details: { ...result.details, name, session: binding.teamName },
    };
  }

  function createNestedReadAgentTools(binding: NestedReadAgentToolBinding): any[] {
    if (!isEligibleNestedReadParent(binding.parent)
      || binding.parent.lifecycleRunId !== binding.parentRunId
      || binding.parent.delegationDepth !== 0) {
      return [];
    }

    const statusScope: AgentStatusScope = {
      parentName: binding.parent.name,
      parentRunId: binding.parentRunId,
      parentStartedAt: binding.parent.joinedAt,
    };

    return [
      statusTool(statusScope, binding.teamName),
      {
        name: "spawn_agent",
        label: "Spawn Read Agent",
        description: "Spawn one depth-1 read-only child in this writer's team and cwd. Only canonical read-* model_slot values are accepted. The child reports back to this writer and cannot delegate.",
        parameters: Type.Object(nestedReadAgentParams),
        async execute(_toolCallId: string, params: any) {
          return spawnNestedReadAgent(params, binding);
        },
      },
      {
        name: "spawn_swarm_agents",
        label: "Spawn Read Swarm Agents",
        description: "Spawn any number of depth-1 read-only children in this writer's team and cwd, subject to the team's global read capacity and queue. Children report back to this writer and cannot delegate.",
        parameters: Type.Object({
          defaults: Type.Optional(Type.Object({
            model_slot: Type.Optional(StringEnum(NESTED_READ_MODEL_SLOTS, { description: "Shared canonical read-* tier." })),
          })),
          agents: Type.Array(Type.Object(nestedSwarmAgentParams), { description: "Read-only child assignments." }),
        }),
        async execute(_toolCallId: string, params: any) {
          rejectUnexpectedNestedParams(params, ["defaults", "agents"], "spawn_swarm_agents");
          rejectUnexpectedNestedParams(params.defaults || {}, ["model_slot"], "spawn_swarm_agents defaults");
          if (!Array.isArray(params.agents) || params.agents.length === 0) {
            throw new Error("spawn_swarm_agents requires at least one read-only child.");
          }
          const mergedAgents = params.agents.map((agent: any, index: number) => {
            rejectUnexpectedNestedParams(agent, ["name", "prompt", "model_slot"], `spawn_swarm_agents agent ${index + 1}`);
            const merged = mergeSwarmAgentParams(params.defaults || {}, agent);
            requireNestedReadSpawnLevel(merged, `spawn_swarm_agents agent ${merged.name || index + 1}`);
            return merged;
          });
          await assertNestedParentAuthorized(binding.teamName, binding.parent.name, binding.parentRunId, binding.parent.cwd);

          const spawned: any[] = [];
          const failed: Array<{ name: string; error: string }> = [];
          for (let index = 0; index < mergedAgents.length; index += 1) {
            const merged = mergedAgents[index];
            const name = merged.name || generatedAgentName(index);
            try {
              const result = await spawnNestedReadAgent({ ...merged, name }, binding, `spawn_swarm_agents agent ${name}`);
              spawned.push({ ...result.details, name });
            } catch (error) {
              failed.push({ name, error: error instanceof Error ? error.message : String(error) });
            }
          }

          const lines = [`Spawned ${spawned.length}/${params.agents.length} nested read agents.`];
          for (const item of spawned) lines.push(`- ${item.name}: ${item.queued ? "queued" : "started"}`);
          for (const item of failed) lines.push(`- ${item.name}: failed — ${item.error}`);
          lines.push(AGENT_WAIT_CONTRACT);
          return { content: [{ type: "text", text: lines.join("\n") }], details: { session: binding.teamName, spawned, failed } };
        },
      },
    ];
  }

  pi.registerTool(statusTool());

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Spawn one agent by intent tier only. Configured favorites take priority; an unconfigured tier inherits the current lead model and thinking. Give it the relevant goal, decisions, prior attempts, inspected evidence, constraints, and expected delta rather than a context-free task. Use session_context=lazy only as an on-demand fallback when omitted session history may materially matter; it never replaces a good mission prompt. read-review is the normal read default; use read-collect for bounded fact gathering, read-analyze for connected explanation/root cause, and read-critical only for irreducible high-stakes reasoning. For edits, choose write-patch, write-feature, write-system, or the rare high-risk write-critical by scope and risk. After spawning, do not duplicate or take over its lane; work only on unrelated work, then end the turn so the automatic report can resume you. One get_agent_status snapshot is allowed when current status is needed; never sleep, busy-wait, repeatedly read inbox/status, or treat healthy silence as failure. Wait for the actual report before synthesizing; intervene only on a reported blocker/error, actual health failure, or explicit user cancellation. model_slot selects behavior, model, and thinking; do not pass role, model, or thinking directly.",
    parameters: Type.Object(publicAgentParams),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      return spawnPublicAgent(params, ctx);
    },
  });

  pi.registerTool({
    name: "spawn_swarm_agents",
    label: "Spawn Swarm Agents",
    description: "Spawn a batch by intent tier only. Configured favorites take priority; unconfigured tiers inherit the current lead model and thinking. Give each lane the relevant goal, decisions, prior attempts, inspected evidence, constraints, and expected delta. Use session_context=lazy selectively as an on-demand fallback, never instead of a good mission prompt. Use read-review as the normal default, read-collect for bounded collection lanes, read-analyze for connected explanation, and read-critical only for irreducible high-stakes reasoning; choose write-patch/feature/system/critical by edit scope and risk. Each spawned lane is delegation-locked: do not duplicate or take it over. After unrelated work is done, end the turn so automatic reports can resume you. One get_agent_status snapshot is allowed when current status is needed; never sleep, busy-wait, repeatedly read inbox/status, or intervene early. Synthesize only after actual reports; intervene only on blocker/error, actual failure, or explicit cancellation. Each agent gets model_slot directly or from defaults; do not pass role, model, or thinking directly.",
    parameters: Type.Object({
      defaults: Type.Optional(Type.Object({
        cwd: Type.Optional(Type.String()),
        checks: Type.Optional(CheckPolicySchema),
        repair: Type.Optional(RepairPolicySchema),
        model_slot: Type.Optional(StringEnum(ACCEPTED_FAVORITE_MODEL_SLOTS, { description: levelDescription })),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
        session_context: Type.Optional(StringEnum(["none", "lazy"] as const, { description: "Shared lazy session-reference policy.", default: "none" })),
        allow_nested_read_agents: Type.Optional(Type.Boolean({ description: "Shared opt-in for eligible depth-0 write-feature/write-critical agents.", default: false })),
      })),
      completion_group: Type.Optional(CompletionGroupPolicySchema),
      agents: Type.Array(Type.Object(publicSwarmAgentParams), { description: "Agents to spawn as one batch. Each one must have model_slot directly or inherit it from defaults." }),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      if (options.isTeammate) throw new Error("Only the lead session can spawn agents.");
      if (!ctx) throw new Error("No active Pi session context is available for spawn_swarm_agents.");
      if (!Array.isArray(params.agents) || params.agents.length === 0) throw new Error("spawn_swarm_agents requires at least one agent.");

      const groupPolicy = normalizeCompletionGroupPolicy(params.completion_group);
      const sessionId = getPiSessionId(ctx);
      if (groupPolicy && (!sessionId || !_toolCallId?.trim())) throw new Error("Completion groups require a bound session and runtime submission identity.");
      const mergedAgents = params.agents.map((agent: any) => mergeSwarmAgentParams(params.defaults || {}, agent));
      const defaultModel = configuredFavoriteModelForSpawn(mergedAgents[0], ctx, "spawn_swarm_agents");
      for (let index = 0; index < mergedAgents.length; index += 1) {
        configuredFavoriteModelForSpawn(mergedAgents[index], ctx, `spawn_swarm_agents agent ${mergedAgents[index].name || index + 1}`);
      }
      const sessionName = await ensureCurrentSessionAgentGroup(ctx, defaultModel);
      let group: CompletionGroup | undefined;
      if (groupPolicy && sessionId) {
        const identity = { teamName: sessionName, sessionId, submissionId: `tool:${_toolCallId}` };
        const groupId = completionGroupIdentity(identity);
        options.onCompletionGroupUse?.(groupId);
        const config = await teams.readConfig(sessionName);
        const reports = await listStoredTeamReportEvents(sessionName);
        const inbox = await messaging.readInbox(sessionName, "team-lead", false, false);
        const entries = ctx.sessionManager?.getBranch?.() ?? [];
        const references = [...config.members.map(member => member.completionGroup),
          ...readQueue(sessionName).map(queued => queued.member.completionGroup),
          ...reports.map(report => report.completionGroup), ...inbox.map(message => message.metadata?.completionGroup),
          ...entries.map((entry: any) => entry.message?.details?.completionGroup)];
        if (references.some(binding => binding?.groupId === groupId)) new CompletionGroup(sessionName, groupId).read();
        group = await CompletionGroup.create({ ...identity, policy: groupPolicy, members: mergedAgents.map((agent: any, index: number) => ({
          name: paths.sanitizeName(agent.name || `agent-${crypto.createHash("sha256").update(`${_toolCallId}:${index}`).digest("hex").slice(0, 12)}`),
          assignmentKey: crypto.createHash("sha256").update(JSON.stringify([agent, ctx.cwd])).digest("hex"),
          suppressed: sessionName.startsWith("prompt-build-") || shouldSuppressLeadReportInjection(agent),
        })) });
        if (group && !group.created) return {
          content: [{ type: "text", text: `Completion group ${group.groupId} already exists; no assignments replayed. State: ${group.journalPath}\n${AGENT_WAIT_CONTRACT}` }],
          details: { session: sessionName, completionGroup: { groupId: group.groupId, journalPath: group.journalPath },
            idempotent: true, spawned: [], failed: [], members: group.read().members },
        };
      }
      const spawned: any[] = [];
      const failed: Array<{ name: string; error: string }> = [];

      for (let index = 0; index < mergedAgents.length; index += 1) {
        const merged = mergedAgents[index];
        const name = group?.read().members[index].name || merged.name || generatedAgentName(index);
        try {
          const result = await spawnTeammate({
            ...merged,
            name,
            team_name: sessionName,
          }, ctx, { allowNestedReadAgents: merged.allow_nested_read_agents === true, completionGroup: group?.binding(index) });
          spawned.push({ ...result.details, name });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failed.push({ name, error: message });
          if (group) await group.apply({ type: "rejected", ...group.binding(index), runId: group.read().members[index].runId, reason: message });
        }
      }
      if (group) {
        await group.seal();
        await enqueueCompletionGroupDeliveries(group);
      }

      const lines = [`Spawned ${spawned.length}/${params.agents.length} agents in the current Pi session.`];
      for (const item of spawned) lines.push(`- ${item.name}: ${item.queued ? `queued at position ${item.queuePosition}` : `${item.role}, ${item.mode || "in-process"}`}`);
      for (const item of failed) lines.push(`- ${item.name}: failed — ${item.error}`);
      lines.push(AGENT_WAIT_CONTRACT);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { session: sessionName, spawned, failed,
        ...(group ? { completionGroup: { groupId: group.groupId, journalPath: group.journalPath } } : {}) } };
    },
  });

  return {
    createNestedReadAgentTools,
    nestedChildSnapshot,
    cancelQueuedAgent: (teamName, agentName) => {
      // Retain the entry for admission bookkeeping, but let active teardown own cancellation after launch commits.
      if (readQueue(teamName).some(queued => queued.member.name === agentName && queued.launchCommitted)) return false;
      const removed = removeQueuedReadSpawnsByName(teamName, agentName);
      return removed.some(item => item.groupSettlement)
        ? Promise.all(removed.map(item => item.groupSettlement)).then(() => removed.length > 0)
        : removed.length > 0;
    },
  };
}
