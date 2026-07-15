import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "../internal/schema";
import { isTeamsDebugEnabled, teamDebugLogPath, writeTeamsDebugEvent } from "../internal/debug";
import { getModelSelectionState, requireQualifiedKnownModel } from "../internal/model-selection";
import { getPiSessionId } from "../internal/session-files";
import * as paths from "../../src/utils/paths";
import * as teams from "../../src/utils/teams";
import * as runtime from "../../src/utils/runtime";
import * as messaging from "../../src/utils/messaging";
import * as writeQueue from "../../src/utils/write-queue";
import { ACCEPTED_FAVORITE_MODEL_SLOTS, FAVORITE_MODEL_SLOTS, canonicalPersistedModelSlot, isFavoriteModelSlot, loadSettings, normalizeFavoriteModelSlot, requireFavoriteModelLevel, resolveModel, roleForFavoriteModelSlot, type AgentRole, type CanonicalFavoriteModelSlot } from "../../src/utils/settings";
import type { Member } from "../../src/utils/models";

import type { RunningReadAgent } from "../runtime/types";
import type { ReadAgentTeardownResult } from "../agents/read-agent-session-lifecycle";
import type { ShutdownTeammateOptions } from "../team/lifecycle";
import { onLifecycleTombstoneCleared, readLifecycleTombstone } from "../../src/utils/lifecycle-tombstone";

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
  buildRoster(teamName: string): Promise<any>;
  isTeammate: boolean;
  agentName: string;
  getTeamName(): string | null | undefined;
  getSessionCtx?(): any;
  setSessionCtx?(ctx: any): void;
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
}

export function registerTeamTools(pi: any, options: TeamToolsOptions): void {
  if (options.isTeammate) return;

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
      `${context} must use model_slot only. Do not pass ${forbidden.join(", ")}; choose a configured intent tier from /agents-favorite-models. See TIPS.md for tier examples.`
    );
  }

  function requireSpawnLevel(params: any, context: string): CanonicalFavoriteModelSlot {
    rejectDirectModelSelection(params, context);
    const slot = normalizeFavoriteModelSlot(params?.model_slot);
    if (!slot) {
      throw new Error(
        `${context} requires a configured model_slot intent tier: ${FAVORITE_MODEL_SLOTS.join(", ")}. Define tiers with /agents-favorite-models and see TIPS.md for examples.`
      );
    }
    return slot;
  }

  function configuredFavoriteModelForSpawn(params: any, ctx: any, context = "spawn_agent"): string {
    const slot = requireSpawnLevel(params, context);
    const settings = loadSettings({ projectDir: params.cwd || ctx.cwd });
    return requireFavoriteModelLevel(settings, slot).model;
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

  const queuedReadSpawnsByTeam = new Map<string, QueuedReadSpawn[]>();
  const readQueueDrainingTeams = new Set<string>();
  const readAdmissionReservationsByTeam = new Map<string, Map<string, number>>();

  function activeAgentCount(teamName: string, role?: string): number {
    let count = 0;
    for (const agent of options.runningReadAgents.values()) {
      if (agent.teamName !== teamName) continue;
      if (role && (agent.role || "read") !== role) continue;
      count += 1;
    }
    return count;
  }

  function activeReadCount(teamName: string): number {
    const activeKeys = new Set(readAdmissionReservationsByTeam.get(teamName)?.keys() ?? []);
    for (const [key, agent] of options.runningReadAgents) {
      if (agent.teamName === teamName && (agent.role || "read") === "read") activeKeys.add(key);
    }
    return activeKeys.size;
  }

  function reserveReadAdmission(teamName: string, key: string): void {
    const reservations = readAdmissionReservationsByTeam.get(teamName) ?? new Map<string, number>();
    reservations.set(key, (reservations.get(key) ?? 0) + 1);
    readAdmissionReservationsByTeam.set(teamName, reservations);
  }

  function releaseReadAdmission(teamName: string, key: string): void {
    const reservations = readAdmissionReservationsByTeam.get(teamName);
    if (!reservations) return;
    const count = reservations.get(key) ?? 0;
    if (count > 1) reservations.set(key, count - 1);
    else reservations.delete(key);
    if (reservations.size === 0) readAdmissionReservationsByTeam.delete(teamName);
  }

  function readQueue(teamName: string): QueuedReadSpawn[] {
    return queuedReadSpawnsByTeam.get(teamName) ?? [];
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
  pi.on?.("session_shutdown", () => {
    if (lifecycleProbeCleanedUp) return;
    lifecycleProbeCleanedUp = true;
    if (typeof lifecycleProbeUnsubscribe === "function") lifecycleProbeUnsubscribe();
    lifecycleFenceUnsubscribe();
  });

  function setReadQueue(teamName: string, queue: QueuedReadSpawn[]): void {
    if (queue.length > 0) queuedReadSpawnsByTeam.set(teamName, queue);
    else queuedReadSpawnsByTeam.delete(teamName);
  }

  function findQueuedReadSpawn(teamName: string, params: any): QueuedReadSpawn | undefined {
    return readQueue(teamName).find((queued) => queued.member.name === params.name || memberMatchesOperation(queued.member, params));
  }

  function removeQueuedReadSpawnsByName(teamName: string, name: string): QueuedReadSpawn[] {
    const queue = readQueue(teamName);
    const removed = queue.filter((queued) => queued.member.name === name);
    if (removed.length === 0) return [];
    setReadQueue(teamName, queue.filter((queued) => queued.member.name !== name));
    return removed;
  }

  function queuedReadResolutionDetails(queued: QueuedReadSpawn, params: any, extras: Record<string, any> = {}): Record<string, any> {
    return spawnResolutionDetails(queued.member, params, queued.resolved, {
      mode: "in-process",
      terminalId: null,
      queued: true,
      queueId: queued.id,
      ...extras,
    });
  }

  async function startReadAgentMember(teamName: string, member: Member, prompt: string, ctx: any): Promise<void> {
    const key = options.readAgentKey(teamName, member.name);
    const reservesReadCapacity = (member.role || "read") === "read";
    if (reservesReadCapacity) reserveReadAdmission(teamName, key);

    const releaseReservationAndDrain = () => {
      if (reservesReadCapacity) releaseReadAdmission(teamName, key);
      void drainQueuedReadSpawns(teamName);
    };
    const drainAfterRun = () => {
      if (reservesReadCapacity) releaseReadAdmission(teamName, key);
      const currentState = options.runningReadAgents.get(key);
      if (currentState?.teardownFinalizationPromise) {
        // A completing runner can resolve before lifecycle finalization releases
        // capacity. Attach one observer and let that finalization own the drain.
        void Promise.resolve(currentState.teardownFinalizationPromise).then(
          () => { void drainQueuedReadSpawns(teamName); },
          () => { void drainQueuedReadSpawns(teamName); },
        );
        return;
      }
      void drainQueuedReadSpawns(teamName);
    };

    try {
      await teams.addMember(teamName, member);
    } catch (error) {
      releaseReservationAndDrain();
      throw error;
    }

    try {
      const result = options.runReadAgentInProcess(teamName, member, prompt, ctx, options.readAgentOptions());
      void Promise.resolve(result).then(drainAfterRun, drainAfterRun);
    } catch (error) {
      releaseReservationAndDrain();
      throw error;
    }
  }

  function enqueueReadSpawn(teamName: string, member: Member, prompt: string, params: any, resolved: ReturnType<typeof resolveModel>, ctx: any): QueuedReadSpawn {
    const queued: QueuedReadSpawn = {
      id: crypto.randomUUID(),
      teamName,
      member,
      prompt,
      params,
      resolved,
      ctx,
      requestedAt: Date.now(),
    };
    setReadQueue(teamName, [...readQueue(teamName), queued]);
    return queued;
  }

  async function drainQueuedReadSpawns(teamName: string): Promise<void> {
    if (readQueueDrainingTeams.has(teamName)) return;
    readQueueDrainingTeams.add(teamName);
    try {
      while (true) {
        const next = readQueue(teamName)[0];
        if (!next) return;
        const settings = loadSettings({ projectDir: next.member.cwd });
        if (activeReadCount(teamName) >= settings.readAgents.maxConcurrent) return;

        const queue = readQueue(teamName);
        const queued = queue[0];
        if (!queued) return;
        const fence = await readLifecycleTombstone(teamName, queued.member.name);
        if (fence.status !== "absent") return;
        try {
          const config = await teams.readConfig(teamName);
          if (config.members.some((member) => member.name === queued.member.name)) {
            setReadQueue(teamName, queue.slice(1));
            continue;
          }
          queued.member.joinedAt = Date.now();
          await startReadAgentMember(teamName, queued.member, queued.prompt, queued.ctx);
          setReadQueue(teamName, queue.slice(1));
        } catch (error) {
          const latestFence = await readLifecycleTombstone(teamName, queued.member.name);
          if (latestFence.status !== "absent") {
            await messaging.sendPlainMessage(
              teamName,
              "system",
              "team-lead",
              `Retained queued agent ${queued.member.name}: lifecycle quarantine appeared before admission.`,
              `Queued agent ${queued.member.name} retained by quarantine`,
              "yellow"
            ).catch(() => {});
            return;
          }
          // Invalid non-lifecycle requests may be dropped so later work can run.
          setReadQueue(teamName, queue.slice(1));
        }
      }
    } finally {
      readQueueDrainingTeams.delete(teamName);
    }
  }

  function currentSessionAgentGroupName(ctx: any): string {
    const sessionId = getPiSessionId(ctx) || "local-session";
    return paths.sanitizeName(`session-${sessionId}`);
  }

  async function ensureCurrentSessionAgentGroup(ctx: any, explicitDefaultModel: string): Promise<string> {
    const sessionName = currentSessionAgentGroupName(ctx);
    if (teams.teamExists(sessionName)) {
      options.adoptTeamAsLead(sessionName, ctx);
      return sessionName;
    }

    const { availableModels } = await getModelSelectionState(ctx, ctx.cwd, [explicitDefaultModel]);
    const defaultModel = requireQualifiedKnownModel(explicitDefaultModel, availableModels, "model_slot");
    if (!defaultModel) throw new Error("Agent sessions require a configured model_slot level before spawning.");
    teams.createTeam(sessionName, getPiSessionId(ctx) || "local-session", "lead-agent", "Pi session agents", defaultModel);
    options.adoptTeamAsLead(sessionName, ctx);
    return sessionName;
  }

  async function spawnTeammate(params: any, ctx: any, spawnOptions: { once?: boolean } = {}): Promise<{ content: any[]; details: any }> {
    const safeName = paths.sanitizeName(params.name);
    const safeTeamName = paths.sanitizeName(params.team_name);
    const cwd = params.cwd || ctx.cwd;
    const teamConfig = await teams.readConfig(safeTeamName);

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
    const modelSlot = requireSpawnLevel(params, `Agent ${safeName}`);
    const role: AgentRole = roleForFavoriteModelSlot(modelSlot);
    const requestedLevel = requireFavoriteModelLevel(settings, modelSlot);
    const requestedFavoriteModel = requestedLevel.model;
    const { availableModels } = await getModelSelectionState(ctx, ctx.cwd, [teamConfig.defaultModel, requestedFavoriteModel].filter(Boolean) as string[]);
    const resolved = resolveModel(settings, {
      role,
      modelSlot,
      explicitModel: null,
      explicitThinking: null,
      teamDefaultModel: teamConfig.defaultModel,
      currentModel: null,
    });

    const chosenModel = requireQualifiedKnownModel(resolved.model ?? undefined, availableModels, "resolved model");
    if (!chosenModel) {
      throw new Error(
        "No model could be resolved from the configured model_slot level. Define levels with /agents-favorite-models before spawning agents."
      );
    }

    const chosenThinking = requestedLevel.thinking as Member["thinking"];
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
      metadata: operationMetadataFromParams(params),
    };

    if (role === "read") {
      removeQueuedReadSpawnsByName(safeTeamName, safeName);
      const currentReadCount = activeReadCount(safeTeamName);
      if (currentReadCount >= settings.readAgents.maxConcurrent) {
        if (!settings.readAgents.queueOverflow) {
          throw new Error(`Read-agent capacity reached (${currentReadCount}/${settings.readAgents.maxConcurrent}) and queueOverflow is disabled.`);
        }
        const queued = enqueueReadSpawn(safeTeamName, member, params.prompt, params, resolved, ctx);
        const queuePosition = readQueue(safeTeamName).findIndex((item) => item.id === queued.id) + 1;
        return {
          content: [{ type: "text", text: `Read teammate ${params.name} queued at position ${queuePosition}; capacity is ${currentReadCount}/${settings.readAgents.maxConcurrent}.` }],
          details: queuedReadResolutionDetails(queued, params, { queuePosition }),
        };
      }

      await startReadAgentMember(safeTeamName, member, params.prompt, ctx);
      return {
        content: [{ type: "text", text: `Read teammate ${params.name} started in-process.` }],
        details: spawnResolutionDetails(member, params, resolved, { mode: "in-process", terminalId: null, queued: false }),
      };
    }

    await writeQueue.removeQueuedWriteSpawnsByName(safeTeamName, safeName);
    const activeWriteCount = activeAgentCount(safeTeamName, "write");
    await writeTeamsDebugEvent(safeTeamName, "write-agent.spawn.request", {
      agentName: safeName,
      cwd,
      category: params.category ?? null,
      requestedRole: role,
      resolvedRole: role,
      model: chosenModel,
      modelSource: resolved.modelSource,
      thinking: chosenThinking ?? null,
      activeWriteCount,
      maxConcurrent: settings.writeAgents.maxConcurrent,
      queueOverflow: false,
      mode: "in-process",
      debugLogPath: debugLogPath ?? null,
    }, settings);

    if (activeWriteCount >= settings.writeAgents.maxConcurrent) {
      await writeTeamsDebugEvent(safeTeamName, "write-agent.spawn.failure", {
        agentName: safeName,
        reason: "capacity-reached",
        activeWriteCount,
        maxConcurrent: settings.writeAgents.maxConcurrent,
        mode: "in-process",
        debugLogPath: debugLogPath ?? null,
      }, settings);
      throw new Error(`Edit-agent capacity reached (${activeWriteCount}/${settings.writeAgents.maxConcurrent}). Wait for an active edit agent to finish before spawning another.`);
    }

    await writeTeamsDebugEvent(safeTeamName, "write-agent.spawn.success", {
      agentName: safeName,
      terminalId: null,
      windowId: null,
      mode: "in-process",
      debugLogPath: debugLogPath ?? null,
    }, settings);
    await startReadAgentMember(safeTeamName, member, params.prompt, ctx);
    options.renderReadAgentStatus();
    const debugSuffix = debugLogPath ? ` Debug log: ${debugLogPath}.` : "";
    return {
      content: [{ type: "text", text: `Edit agent ${params.name} started in-process and is followable from Pi.${debugSuffix}` }],
      details: spawnResolutionDetails(member, params, resolved, { mode: "in-process", terminalId: null, queued: false, debugLogPath }),
    };
  }

  pi.events?.on?.("pi-extended-teams:orchestration-request", async (payload: any) => {
    const requestId = payload?.requestId;
    const type = String(payload?.type || "");
    const params = payload?.params || {};
    const requestCtx = payload?.ctx;
    const ctx = requestCtx || options.getSessionCtx?.();
    if (requestCtx) options.setSessionCtx?.(requestCtx);

    try {
      if (options.isTeammate) throw new Error("Teammates cannot satisfy orchestration requests directly.");
      if (!ctx) throw new Error("No active lead session context is available for orchestration request. If pi-extended-teams was registered after session_start, include the current Pi command context as payload.ctx.");

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
        const result = await spawnTeammate(params, ctx, { once: true });
        emitOrchestrationResponse(requestId, type, { ok: true, details: result.details, content: result.content });
        return;
      }

      throw new Error(`Unsupported orchestration request type: ${type}`);
    } catch (error) {
      emitOrchestrationResponse(requestId, type, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const levelDescription = "Required configured intent tier. Read tiers: read-collect gathers bounded facts without owning the conclusion; read-review is the normal default for focused review, verification, and bounded synthesis; read-analyze explains behavior or root cause across connected evidence; read-critical is only for irreducible high-stakes security, architecture, concurrency, migration, or data-correctness reasoning. Write tiers: write-patch makes a narrow localized change; write-feature implements a bounded feature with a known design; write-system owns a cross-cutting integration or refactor within explicitly claimed files; write-critical is only for high-risk security, concurrency, recovery, migration, or data-integrity changes. Prefer canonical tiers; legacy reading-*/writing-* aliases remain accepted for this minor release. Do not pass role, model, or thinking directly; see TIPS.md.";
  const publicAgentBaseParams = {
    name: Type.Optional(Type.String({ description: "Stable display name. Defaults to a generated agent name." })),
    prompt: Type.String({ description: "The agent's assignment and report shape." }),
    cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the lead session cwd." })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
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

  async function spawnPublicAgent(params: any, ctx: any): Promise<{ content: any[]; details: any }> {
    if (options.isTeammate) throw new Error("Only the lead session can spawn agents.");
    if (!ctx) throw new Error("No active Pi session context is available for spawn_agent.");

    const sessionDefaultModel = configuredFavoriteModelForSpawn(params, ctx);
    const sessionName = await ensureCurrentSessionAgentGroup(ctx, sessionDefaultModel);
    const name = params.name || generatedAgentName();
    const result = await spawnTeammate({
      ...params,
      name,
      team_name: sessionName,
    }, ctx);

    return {
      content: [{ type: "text", text: `Agent ${name} started (${result.details.role}, ${result.details.mode || "in-process"}).` }],
      details: { ...result.details, name, session: sessionName },
    };
  }

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Spawn one agent by configured intent tier only. read-review is the normal read default; use read-collect for bounded fact gathering, read-analyze for connected explanation/root cause, and read-critical only for irreducible high-stakes reasoning. For edits, choose write-patch, write-feature, write-system, or the rare high-risk write-critical by scope and risk. After spawning, do not duplicate or take over its lane; work only on unrelated work, then wait literally idle for the automatic report—never sleep, poll, repeatedly read inbox/status, or treat healthy silence as failure. Wait for the actual report before synthesizing; intervene only on a reported blocker/error, actual health failure, or explicit user cancellation. model_slot selects behavior, model, and thinking; do not pass role, model, or thinking directly.",
    parameters: Type.Object(publicAgentParams),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      return spawnPublicAgent(params, ctx);
    },
  });

  pi.registerTool({
    name: "spawn_swarm_agents",
    label: "Spawn Swarm Agents",
    description: "Spawn a batch by configured intent tiers only. Use read-review as the normal default, read-collect for bounded collection lanes, read-analyze for connected explanation, and read-critical only for irreducible high-stakes reasoning; choose write-patch/feature/system/critical by edit scope and risk. Each spawned lane is delegation-locked: do not duplicate/take it over, and after unrelated work is done wait literally idle for automatic reports without sleep, polling, repeated inbox/status reads, or premature intervention. Synthesize only after actual reports; intervene only on blocker/error, actual failure, or explicit cancellation. Each agent gets model_slot directly or from defaults; do not pass role, model, or thinking directly.",
    parameters: Type.Object({
      defaults: Type.Optional(Type.Object({
        cwd: Type.Optional(Type.String()),
        model_slot: Type.Optional(StringEnum(ACCEPTED_FAVORITE_MODEL_SLOTS, { description: levelDescription })),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
      })),
      agents: Type.Array(Type.Object(publicSwarmAgentParams), { description: "Agents to spawn as one batch. Each one must have model_slot directly or inherit it from defaults." }),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      if (options.isTeammate) throw new Error("Only the lead session can spawn agents.");
      if (!ctx) throw new Error("No active Pi session context is available for spawn_swarm_agents.");
      if (!Array.isArray(params.agents) || params.agents.length === 0) throw new Error("spawn_swarm_agents requires at least one agent.");

      const mergedAgents = params.agents.map((agent: any) => mergeSwarmAgentParams(params.defaults || {}, agent));
      const defaultModel = configuredFavoriteModelForSpawn(mergedAgents[0], ctx, "spawn_swarm_agents");
      for (let index = 0; index < mergedAgents.length; index += 1) {
        configuredFavoriteModelForSpawn(mergedAgents[index], ctx, `spawn_swarm_agents agent ${mergedAgents[index].name || index + 1}`);
      }
      const sessionName = await ensureCurrentSessionAgentGroup(ctx, defaultModel);
      const spawned: any[] = [];
      const failed: Array<{ name: string; error: string }> = [];

      for (let index = 0; index < mergedAgents.length; index += 1) {
        const merged = mergedAgents[index];
        const name = merged.name || generatedAgentName(index);
        try {
          const result = await spawnTeammate({
            ...merged,
            name,
            team_name: sessionName,
          }, ctx);
          spawned.push({ ...result.details, name });
        } catch (error) {
          failed.push({ name, error: error instanceof Error ? error.message : String(error) });
        }
      }

      const lines = [`Spawned ${spawned.length}/${params.agents.length} agents in the current Pi session.`];
      for (const item of spawned) lines.push(`- ${item.name}: ${item.role}, ${item.mode || "in-process"}`);
      for (const item of failed) lines.push(`- ${item.name}: failed — ${item.error}`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { session: sessionName, spawned, failed } };
    },
  });

}
