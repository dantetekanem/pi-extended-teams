import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "../internal/schema";
import { isTeamsDebugEnabled, teamDebugLogPath, writeTeamsDebugEvent } from "../internal/debug";
import { getCurrentQualifiedModel, getModelSelectionState, requireQualifiedKnownModel } from "../internal/model-selection";
import { cleanupStaleTeam, getPiSessionId } from "../internal/session-files";
import { shutdownReadAgentSession } from "../agents/read-agent";
import * as paths from "../../src/utils/paths";
import * as teams from "../../src/utils/teams";
import * as runtime from "../../src/utils/runtime";
import * as writeQueue from "../../src/utils/write-queue";
import { loadSettings, resolveModel, resolveRole, type AgentRole } from "../../src/utils/settings";
import type { Member } from "../../src/utils/models";
import { countWriteMembers, formatRosterForPrompt } from "../team/roster";
import type { RunningReadAgent } from "../runtime/types";
import { requestLeadForTeammateSpawn } from "./delegation-guard";

export interface TeamToolsOptions {
  terminal: any;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
  isCurrentReadAgentRun(key: string, state: RunningReadAgent): boolean;
  renderReadAgentStatus(): void;
  readAgentOptions(): any;
  runReadAgentInProcess(teamName: string, member: Member, prompt: string, ctx: any, options: any): Promise<void> | void;
  startWriteAgent(teamName: string, member: Member, prompt: string): Promise<string>;
  shutdownTeammate(teamName: string, member: Member, options?: { drainQueue?: boolean }): Promise<void>;
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

  function memberMatchesOperation(member: Member, params: any): boolean {
    if (!params.operation_id) return false;
    const operationId = member.metadata?.operationId || member.metadata?.orchestration?.operationId;
    const workflowRunId = member.metadata?.workflowRunId || member.metadata?.orchestration?.workflowRunId;
    return operationId === params.operation_id && (params.workflow_run_id === undefined || workflowRunId === params.workflow_run_id);
  }

  function memberResolutionDetails(member: Member, params: any, extras: Record<string, any> = {}): Record<string, any> {
    const role = member.role ?? "write";
    const category = member.category ?? null;
    return {
      agentId: member.agentId,
      role,
      requestedRole: params.role ?? "read",
      resolvedRole: role,
      requestedCategory: params.category ?? null,
      category,
      resolvedCategory: category,
      model: member.model ?? null,
      thinking: member.thinking ?? null,
      ...extras,
    };
  }

  function queuedResolutionDetails(safeTeamName: string, queued: writeQueue.QueuedWriteSpawn, params: any, extras: Record<string, any> = {}): Record<string, any> {
    const category = queued.category ?? null;
    return {
      agentId: `${queued.name}@${safeTeamName}`,
      role: "write",
      requestedRole: params.role ?? "read",
      resolvedRole: "write",
      requestedCategory: params.category ?? null,
      category,
      resolvedCategory: category,
      model: queued.model,
      thinking: queued.thinking ?? null,
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
    return activeAgentCount(teamName, "read");
  }

  function readQueue(teamName: string): QueuedReadSpawn[] {
    return queuedReadSpawnsByTeam.get(teamName) ?? [];
  }

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
    await teams.addMember(teamName, member);
    const result = options.runReadAgentInProcess(teamName, member, prompt, ctx, options.readAgentOptions());
    void Promise.resolve(result)
      .catch(() => {})
      .finally(() => { void drainQueuedReadSpawns(teamName); });
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
        setReadQueue(teamName, queue.slice(1));
        try {
          const config = await teams.readConfig(teamName);
          if (config.members.some((member) => member.name === queued.member.name)) continue;
          queued.member.joinedAt = Date.now();
          await startReadAgentMember(teamName, queued.member, queued.prompt, queued.ctx);
        } catch {
          // Drop invalid queued read spawns rather than blocking the rest of the queue.
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

  async function ensureCurrentSessionAgentGroup(ctx: any, explicitDefaultModel?: string): Promise<string> {
    const sessionName = currentSessionAgentGroupName(ctx);
    if (teams.teamExists(sessionName)) {
      options.adoptTeamAsLead(sessionName, ctx);
      return sessionName;
    }

    const { availableModels } = await getModelSelectionState(ctx, ctx.cwd);
    const defaultModel = requireQualifiedKnownModel(explicitDefaultModel, availableModels, "default_model")
      || requireQualifiedKnownModel(getCurrentQualifiedModel(ctx), availableModels, "current model");
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
    if (existingMember) await options.shutdownTeammate(safeTeamName, existingMember);

    const settings = loadSettings({ projectDir: cwd });
    const role: AgentRole = resolveRole(settings, params.role ?? "read", params.category);
    const currentModelHint = getCurrentQualifiedModel(ctx);
    const { availableModels } = await getModelSelectionState(ctx, ctx.cwd, [teamConfig.defaultModel, currentModelHint].filter(Boolean) as string[]);
    const resolved = resolveModel(settings, {
      role,
      category: params.category,
      explicitModel: params.model,
      explicitThinking: params.thinking,
      teamDefaultModel: teamConfig.defaultModel,
      currentModel: currentModelHint,
    });

    const chosenModel = requireQualifiedKnownModel(resolved.model ?? undefined, availableModels, "resolved model");
    if (!chosenModel) {
      throw new Error(
        "No model could be resolved. Pass a fully qualified model, configure a category/role default in settings.json, create the team with a default_model, or ensure the current session has an active model."
      );
    }

    const chosenThinking = (resolved.thinking ?? undefined) as Member["thinking"];
    const debugLogPath = role === "write" && isTeamsDebugEnabled(settings) ? teamDebugLogPath(safeTeamName) : undefined;

    const member: Member = {
      agentId: `${safeName}@${safeTeamName}`,
      name: safeName,
      agentType: "teammate",
      role,
      category: params.category,
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
      requestedRole: params.role ?? "read",
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

        const { availableModels } = await getModelSelectionState(ctx, ctx.cwd);
        const explicitDefaultModel = requireQualifiedKnownModel(params.default_model, availableModels, "default_model");
        const currentModel = requireQualifiedKnownModel(getCurrentQualifiedModel(ctx), availableModels, "current model");
        const defaultModel = explicitDefaultModel || currentModel;
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

  const publicAgentParams = {
    name: Type.Optional(Type.String({ description: "Stable display name. Defaults to a generated agent name." })),
    prompt: Type.String({ description: "The agent's assignment and report shape." }),
    role: Type.Optional(StringEnum(["read", "write"], { description: "Defaults to read. Use write only for edit-allowed assignments." })),
    cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the lead session cwd." })),
    model: Type.Optional(Type.String({ description: "Optional fully qualified provider/model. Defaults to the current Pi session model." })),
    thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"])),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
  };

  function generatedAgentName(index?: number): string {
    const position = index === undefined ? "" : `-${index + 1}`;
    return `agent-${Date.now().toString(36)}${position}-${crypto.randomUUID().slice(0, 8)}`;
  }

  async function spawnPublicAgent(params: any, ctx: any): Promise<{ content: any[]; details: any }> {
    if (options.isTeammate) throw new Error("Only the lead session can spawn agents.");
    if (!ctx) throw new Error("No active Pi session context is available for spawn_agent.");

    const sessionName = await ensureCurrentSessionAgentGroup(ctx, params.model);
    const name = params.name || generatedAgentName();
    const result = await spawnTeammate({
      ...params,
      name,
      team_name: sessionName,
      role: params.role ?? "read",
    }, ctx);

    return {
      content: [{ type: "text", text: `Agent ${name} started (${result.details.role}, ${result.details.mode || "in-process"}).` }],
      details: { ...result.details, name, session: sessionName },
    };
  }

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Spawn one agent in the current Pi session. The session is implicit; no team setup is required. Agents run in-process so Pi can follow, track, and control them.",
    parameters: Type.Object(publicAgentParams),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      return spawnPublicAgent(params, ctx);
    },
  });

  pi.registerTool({
    name: "spawn_swarm_agents",
    label: "Spawn Swarm Agents",
    description: "Spawn a batch of agents in the current Pi session. Use per-agent model/thinking overrides or defaults for the whole swarm; scheduling and tracking are handled internally.",
    parameters: Type.Object({
      defaults: Type.Optional(Type.Object({
        role: Type.Optional(StringEnum(["read", "write"])),
        cwd: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"])),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
      })),
      agents: Type.Array(Type.Object(publicAgentParams), { description: "Agents to spawn as one batch." }),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      if (options.isTeammate) throw new Error("Only the lead session can spawn agents.");
      if (!ctx) throw new Error("No active Pi session context is available for spawn_swarm_agents.");
      if (!Array.isArray(params.agents) || params.agents.length === 0) throw new Error("spawn_swarm_agents requires at least one agent.");

      const defaultModel = params.defaults?.model || params.agents.find((agent: any) => agent.model)?.model;
      const sessionName = await ensureCurrentSessionAgentGroup(ctx, defaultModel);
      const spawned: any[] = [];
      const failed: Array<{ name: string; error: string }> = [];

      for (let index = 0; index < params.agents.length; index += 1) {
        const agent = params.agents[index];
        const merged = { ...(params.defaults || {}), ...agent };
        const name = merged.name || generatedAgentName(index);
        try {
          const result = await spawnTeammate({
            ...merged,
            name,
            team_name: sessionName,
            role: merged.role ?? "read",
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

  return;

  pi.registerTool({
    name: "team_create",
    label: "Create Team",
    description: "Create a team and (optionally) spawn its agents in one call. Pass `agents` to spawn them immediately — they start running and report back on their own; you do not need to create tasks, poll, or read an inbox. Agents default to read-only (investigation/review/testing); use role 'write' only for isolated independent edit work. If default_model is given it must be a fully qualified provider/model from list_available_models; otherwise the current model is used.",
    parameters: Type.Object({
      team_name: Type.String(),
      description: Type.Optional(Type.String()),
      default_model: Type.Optional(Type.String({ description: "Fully qualified default model (provider/model). Use list_available_models first. If omitted, the current active model is used." })),
      agents: Type.Optional(Type.Array(Type.Object({
        name: Type.String(),
        prompt: Type.String({ description: "The agent's mission and the report shape you want back." }),
        role: Type.Optional(StringEnum(["read", "write"], { description: "Defaults to 'read'. Use 'write' only for isolated independent edit work." })),
        cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the lead's cwd." })),
        category: Type.Optional(Type.String()),
        model: Type.Optional(Type.String({ description: "Fully qualified provider/model." })),
        thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"])),
      }, { description: "An agent to spawn immediately." }), { description: "Agents to define and spawn as soon as the team is created." })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      if (options.isTeammate) {
        return requestLeadForTeammateSpawn(options, {
          action: "team_create",
          params,
          reason: "Teammate attempted to create a team or spawn inline agents.",
        });
      }

      const { availableModels } = await getModelSelectionState(ctx, ctx.cwd);
      const explicitDefaultModel = requireQualifiedKnownModel(params.default_model, availableModels, "default_model");
      const currentModel = requireQualifiedKnownModel(getCurrentQualifiedModel(ctx), availableModels, "current model");
      const defaultModel = explicitDefaultModel || currentModel;

      if (teams.teamExists(params.team_name)) cleanupStaleTeam(params.team_name, options.terminal);

      const config = teams.createTeam(params.team_name, "local-session", "lead-agent", params.description, defaultModel);
      options.adoptTeamAsLead(paths.sanitizeName(params.team_name), ctx);

      const lines = [`Team ${params.team_name} created.`];
      const spawned: any[] = [];
      for (const agent of (params.agents ?? [])) {
        try {
          const result = await spawnTeammate({ ...agent, team_name: params.team_name }, ctx);
          spawned.push(result.details);
          lines.push(`- ${result.content?.[0]?.text ?? agent.name}`);
        } catch (e) {
          lines.push(`- ${agent.name}: failed to spawn — ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (spawned.length > 0) {
        lines.push("", "Agents are running. Their reports will arrive here automatically as open report entries and you will synthesize them — no polling needed.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: { config, spawned } };
    },
  });

  pi.registerTool({
    name: "ensure_team",
    label: "Ensure Team",
    description: "Idempotently create a team if it does not exist; returns the existing team without cleanup or overwrite when it already exists.",
    parameters: Type.Object({
      team_name: Type.String(),
      description: Type.Optional(Type.String()),
      default_model: Type.Optional(Type.String({ description: "Fully qualified default model (provider/model). If omitted, the current active model is used for new teams." })),
      operation_id: Type.Optional(Type.String()),
      workflow_run_id: Type.Optional(Type.String()),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      if (options.isTeammate) {
        return requestLeadForTeammateSpawn(options, {
          action: "team_create",
          params,
          reason: "Teammate attempted to ensure/create a team.",
        });
      }

      const safeTeamName = paths.sanitizeName(params.team_name);
      if (teams.teamExists(safeTeamName)) {
        const config = await teams.readConfig(safeTeamName);
        options.adoptTeamAsLead(safeTeamName, ctx);
        return { content: [{ type: "text", text: `Team ${safeTeamName} already exists.` }], details: { config, created: false, idempotent: true } };
      }

      const { availableModels } = await getModelSelectionState(ctx, ctx.cwd);
      const explicitDefaultModel = requireQualifiedKnownModel(params.default_model, availableModels, "default_model");
      const currentModel = requireQualifiedKnownModel(getCurrentQualifiedModel(ctx), availableModels, "current model");
      const defaultModel = explicitDefaultModel || currentModel;
      const result = await teams.ensureTeam({
        name: safeTeamName,
        sessionId: "local-session",
        leadAgentId: "lead-agent",
        description: params.description,
        defaultModel,
        metadata: operationMetadataFromParams(params),
      });
      options.adoptTeamAsLead(safeTeamName, ctx);
      return { content: [{ type: "text", text: `Team ${safeTeamName} created.` }], details: { config: result.config, created: result.created, idempotent: true } };
    },
  });

  pi.registerTool({
    name: "spawn_teammate_once",
    label: "Spawn Teammate Once",
    description: "Idempotently spawn a teammate using name and optional operation_id/workflow_run_id metadata. Existing or queued same-key teammates are returned instead of replaced.",
    parameters: Type.Object({
      team_name: Type.String(),
      name: Type.String(),
      prompt: Type.String(),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the lead's cwd." })),
      role: Type.Optional(StringEnum(["read", "write"], { description: "Agent role. Defaults to read." })),
      category: Type.Optional(Type.String({ description: "Optional category preset name from settings.json." })),
      model: Type.Optional(Type.String({ description: "Fully qualified model." })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"])),
      plan_mode_required: Type.Optional(Type.Boolean({ default: false })),
      operation_id: Type.Optional(Type.String()),
      workflow_run_id: Type.Optional(Type.String()),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      if (options.isTeammate) {
        return requestLeadForTeammateSpawn(options, {
          action: "spawn_teammate",
          params,
          reason: "Teammate attempted to spawn another agent directly.",
        });
      }

      const safeTeamName = paths.sanitizeName(params.team_name);
      if (!teams.teamExists(safeTeamName)) throw new Error(`Team ${params.team_name} does not exist`);
      options.adoptTeamAsLead(safeTeamName, ctx);
      return spawnTeammate(params, ctx, { once: true });
    },
  });

  pi.registerTool({
    name: "spawn_teammate",
    label: "Spawn Teammate",
    description: "Spawn one teammate. Default role is 'read' (read-only, in-process, unlimited, parallel — for investigation/review/testing). Use role 'write' only for isolated, independent edit work that should run in a background tmux screen; the lead normally writes itself. Model resolves from explicit arg -> category -> role default -> team default -> current model. Any explicit model must be a fully qualified provider/model from list_available_models.",
    parameters: Type.Object({
      team_name: Type.String(),
      name: Type.String(),
      prompt: Type.String(),
      cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the lead's cwd." })),
      role: Type.Optional(StringEnum(["read", "write"], { description: "Agent role. 'read' (default) is read-only and in-process. 'write' spawns in tmux and can edit files — use only for isolated independent work." })),
      category: Type.Optional(Type.String({ description: "Optional category preset name from settings.json (bundles role + model + thinking)." })),
      model: Type.Optional(Type.String({ description: "Fully qualified model (provider/model). Use list_available_models first. If omitted, the category/role/team default or current model is used." })),
      thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"])),
      plan_mode_required: Type.Optional(Type.Boolean({ default: false })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      if (options.isTeammate) {
        return requestLeadForTeammateSpawn(options, {
          action: "spawn_teammate",
          params,
          reason: "Teammate attempted to spawn another agent directly.",
        });
      }

      const safeTeamName = paths.sanitizeName(params.team_name);
      if (!teams.teamExists(safeTeamName)) throw new Error(`Team ${params.team_name} does not exist`);
      options.adoptTeamAsLead(safeTeamName, ctx);
      return spawnTeammate(params, ctx);
    },
  });

  pi.registerTool({
    name: "promote_teammate",
    label: "Move Teammate to background tmux screen",
    description: "Move a running in-process read agent into its own background tmux screen so you can watch and interact with it there. Stops the in-process session and re-spawns the same mission as a tmux teammate. Requires running inside tmux.",
    parameters: Type.Object({
      team_name: Type.String(),
      name: Type.String(),
      prompt: Type.Optional(Type.String({ description: "Optional updated mission. Defaults to the agent's original mission." })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      if (options.isTeammate) {
        return requestLeadForTeammateSpawn(options, {
          action: "promote_teammate",
          params,
          reason: "Teammate attempted to move/spawn another agent into a pane.",
        });
      }

      const safeTeamName = paths.sanitizeName(params.team_name);
      const safeName = paths.sanitizeName(params.name);
      if (!teams.teamExists(safeTeamName)) throw new Error(`Team ${params.team_name} does not exist`);
      options.adoptTeamAsLead(safeTeamName, ctx);
      if (!options.terminal) throw new Error("pi-extended-teams requires running inside tmux to move an agent into a pane.");

      const config = await teams.readConfig(safeTeamName);
      const member = config.members.find(m => m.name === safeName);
      const key = options.readAgentKey(safeTeamName, safeName);
      const state = options.runningReadAgents.get(key);
      const prompt = params.prompt || member?.prompt;
      if (!prompt) throw new Error(`No mission found for ${params.name}; pass prompt to set one.`);

      if (state) state.stopRequested = true;
      if (state?.session) {
        await shutdownReadAgentSession(state.session);
        state.session.dispose();
      }
      if (state && options.isCurrentReadAgentRun(key, state)) options.runningReadAgents.delete(key);
      options.renderReadAgentStatus();
      await runtime.deleteRuntimeStatus(safeTeamName, safeName).catch(() => {});
      if (member) await teams.removeMember(safeTeamName, safeName).catch(() => {});

      const result = await spawnTeammate({
        team_name: safeTeamName,
        name: safeName,
        prompt,
        role: "write",
        model: member?.model,
        thinking: member?.thinking,
        cwd: member?.cwd,
      }, ctx);

      return {
        content: [{ type: "text", text: `Moved ${params.name} into a background tmux screen. ${result.content?.[0]?.text ?? ""}`.trim() }],
        details: { ...result.details, promoted: true },
      };
    },
  });

  pi.registerTool({
    name: "list_teammates",
    label: "List Teammates",
    description: "List live team roster with roles, status, current tasks, held claims, unread inbox counts, and queued writers.",
    parameters: Type.Object({ team_name: Type.String() }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      if (teams.teamExists(paths.sanitizeName(params.team_name))) options.adoptTeamAsLead(paths.sanitizeName(params.team_name), ctx);
      const roster = await options.buildRoster(params.team_name);
      return { content: [{ type: "text", text: formatRosterForPrompt(roster) }], details: roster };
    },
  });

  pi.registerTool({
    name: "list_write_queue",
    label: "List Write Queue",
    description: "List queued write-agent spawns for a team.",
    parameters: Type.Object({ team_name: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const queue = await writeQueue.listWriteQueue(params.team_name);
      const text = queue.length > 0
        ? [`Queued write agents for ${params.team_name}:`, ...queue.map((item, index) => `${index + 1}. ${item.name} (${item.id}) requested ${new Date(item.requestedAt).toISOString()}`)].join("\n")
        : `No queued write agents for ${params.team_name}.`;
      return { content: [{ type: "text", text }], details: { teamName: params.team_name, queue } };
    },
  });

  pi.registerTool({
    name: "cancel_write_queue",
    label: "Cancel Write Queue Item",
    description: "Cancel one pending write-agent spawn by queue id.",
    parameters: Type.Object({
      team_name: Type.String(),
      id: Type.String({ description: "Queue item id returned by list_write_queue or a queued spawn." }),
    }),
    async execute(_toolCallId: string, params: any) {
      const removed = await writeQueue.cancelQueuedWriteSpawn(params.team_name, params.id);
      if (!removed) throw new Error(`Queued write-agent spawn ${params.id} not found for team ${params.team_name}.`);
      return {
        content: [{ type: "text", text: `Canceled queued writer ${removed.name} (${removed.id}).` }],
        details: { teamName: params.team_name, canceled: removed },
      };
    },
  });
}
