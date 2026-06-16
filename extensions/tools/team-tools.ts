import { Type } from "@sinclair/typebox";
import { StringEnum } from "../internal/schema";
import { getCurrentQualifiedModel, getModelSelectionState, requireQualifiedKnownModel } from "../internal/model-selection";
import { cleanupStaleTeam } from "../internal/session-files";
import { shutdownReadAgentSession } from "../agents/read-agent";
import * as paths from "../../src/utils/paths";
import * as teams from "../../src/utils/teams";
import * as runtime from "../../src/utils/runtime";
import * as writeQueue from "../../src/utils/write-queue";
import { loadSettings, resolveModel, resolveRole, type AgentRole } from "../../src/utils/settings";
import type { Member } from "../../src/utils/models";
import { countWriteMembers, formatRosterForPrompt } from "../team/roster";
import type { RunningReadAgent } from "../runtime/types";

export interface TeamToolsOptions {
  terminal: any;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
  isCurrentReadAgentRun(key: string, state: RunningReadAgent): boolean;
  renderReadAgentStatus(): void;
  readAgentOptions(): any;
  runReadAgentInProcess(teamName: string, member: Member, prompt: string, ctx: any, options: any): void;
  startWriteAgent(teamName: string, member: Member, prompt: string): Promise<string>;
  shutdownTeammate(teamName: string, member: Member, options?: { drainQueue?: boolean }): Promise<void>;
  adoptTeamAsLead(teamName: string): void;
  buildRoster(teamName: string): Promise<any>;
}

export function registerTeamTools(pi: any, options: TeamToolsOptions): void {
  async function spawnTeammate(params: any, ctx: any): Promise<{ content: any[]; details: any }> {
    const safeName = paths.sanitizeName(params.name);
    const safeTeamName = paths.sanitizeName(params.team_name);
    const cwd = params.cwd || ctx.cwd;
    const teamConfig = await teams.readConfig(safeTeamName);

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
    if (role === "write" && !options.terminal) {
      throw new Error("pi-extended-teams requires running inside tmux for write agents.");
    }

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
    };

    if (role === "read") {
      await teams.addMember(safeTeamName, member);
      void options.runReadAgentInProcess(safeTeamName, member, params.prompt, ctx, options.readAgentOptions());
      return {
        content: [{ type: "text", text: `Read teammate ${params.name} started in-process.` }],
        details: { agentId: member.agentId, role, mode: "in-process", terminalId: null },
      };
    }

    await writeQueue.removeQueuedWriteSpawnsByName(safeTeamName, safeName);
    const activeWriteCount = await countWriteMembers(safeTeamName);
    if (activeWriteCount >= settings.writeAgents.maxConcurrent) {
      if (!settings.writeAgents.queueOverflow) {
        throw new Error(`Write-agent capacity reached (${activeWriteCount}/${settings.writeAgents.maxConcurrent}) and queueOverflow is disabled.`);
      }
      const queued = await writeQueue.enqueueWriteSpawn(safeTeamName, {
        name: safeName,
        prompt: params.prompt,
        cwd,
        category: params.category,
        model: chosenModel,
        thinking: chosenThinking,
        planModeRequired: params.plan_mode_required,
        color: "blue",
      });
      const queuedItems = await writeQueue.listWriteQueue(safeTeamName);
      const queuePosition = queuedItems.findIndex(item => item.id === queued.id) + 1;
      return {
        content: [{ type: "text", text: `Write teammate ${params.name} queued at position ${queuePosition}; capacity is ${activeWriteCount}/${settings.writeAgents.maxConcurrent}.` }],
        details: { agentId: member.agentId, role, queued: true, queueId: queued.id, queuePosition },
      };
    }

    const terminalId = await options.startWriteAgent(safeTeamName, member, params.prompt);
    return {
      content: [{ type: "text", text: `Teammate ${params.name} spawned in pane ${terminalId}.` }],
      details: { agentId: member.agentId, role, terminalId, queued: false },
    };
  }

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
      const { availableModels } = await getModelSelectionState(ctx, ctx.cwd);
      const explicitDefaultModel = requireQualifiedKnownModel(params.default_model, availableModels, "default_model");
      const currentModel = requireQualifiedKnownModel(getCurrentQualifiedModel(ctx), availableModels, "current model");
      const defaultModel = explicitDefaultModel || currentModel;

      if (teams.teamExists(params.team_name)) cleanupStaleTeam(params.team_name, options.terminal);

      const config = teams.createTeam(params.team_name, "local-session", "lead-agent", params.description, defaultModel);
      options.adoptTeamAsLead(paths.sanitizeName(params.team_name));

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
        lines.push("", "Agents are running. Their reports will arrive here automatically (collapsed; ctrl+o to expand) and you will synthesize them — no polling needed.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }], details: { config, spawned } };
    },
  });

  pi.registerTool({
    name: "spawn_teammate",
    label: "Spawn Teammate",
    description: "Spawn one teammate. Default role is 'read' (read-only, in-process, unlimited, parallel — for investigation/review/testing). Use role 'write' only for isolated, independent edit work that should run in its own tmux pane; the lead normally writes itself. Model resolves from explicit arg -> category -> role default -> team default -> current model. Any explicit model must be a fully qualified provider/model from list_available_models.",
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
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const safeTeamName = paths.sanitizeName(params.team_name);
      if (!teams.teamExists(safeTeamName)) throw new Error(`Team ${params.team_name} does not exist`);
      options.adoptTeamAsLead(safeTeamName);
      return spawnTeammate(params, ctx);
    },
  });

  pi.registerTool({
    name: "promote_teammate",
    label: "Move Teammate to tmux pane",
    description: "Move a running in-process read agent into its own tmux pane so you can watch and interact with it there. Stops the in-process session and re-spawns the same mission as a tmux teammate. Requires running inside tmux.",
    parameters: Type.Object({
      team_name: Type.String(),
      name: Type.String(),
      prompt: Type.Optional(Type.String({ description: "Optional updated mission. Defaults to the agent's original mission." })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const safeTeamName = paths.sanitizeName(params.team_name);
      const safeName = paths.sanitizeName(params.name);
      if (!teams.teamExists(safeTeamName)) throw new Error(`Team ${params.team_name} does not exist`);
      options.adoptTeamAsLead(safeTeamName);
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
        content: [{ type: "text", text: `Moved ${params.name} into a tmux pane. ${result.content?.[0]?.text ?? ""}`.trim() }],
        details: { ...result.details, promoted: true },
      };
    },
  });

  pi.registerTool({
    name: "list_teammates",
    label: "List Teammates",
    description: "List live team roster with roles, status, current tasks, held claims, unread inbox counts, and queued writers.",
    parameters: Type.Object({ team_name: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      if (teams.teamExists(paths.sanitizeName(params.team_name))) options.adoptTeamAsLead(paths.sanitizeName(params.team_name));
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
