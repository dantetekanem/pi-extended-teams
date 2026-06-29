import { Type } from "@sinclair/typebox";
import { StringEnum } from "../internal/schema";
import { buildPiCommand, getPiLaunchCommand } from "../internal/pi-command";
import { getModelSelectionState, requireQualifiedKnownModel } from "../internal/model-selection";
import * as predefined from "../../src/utils/predefined-teams";
import * as teams from "../../src/utils/teams";
import * as messaging from "../../src/utils/messaging";
import * as paths from "../../src/utils/paths";
import { loadSettings, requireFavoriteModelLevel, resolveAllowedExtensions } from "../../src/utils/settings";
import type { Member } from "../../src/utils/models";
import { requestLeadForTeammateSpawn } from "./delegation-guard";

export interface PredefinedToolsOptions {
  terminal: any;
  adoptTeamAsLead(teamName: string, ctx?: any): void;
  isTeammate: boolean;
  agentName: string;
  getTeamName(): string | null | undefined;
}

export function registerPredefinedTools(pi: any, options: PredefinedToolsOptions): void {
  pi.registerTool({
    name: "list_predefined_teams",
    label: "List Predefined Teams",
    description: "List all available predefined team configurations from teams.yaml files. These are team templates that can be instantiated with create_predefined_team.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const projectDir = ctx.cwd;
      const predefinedTeams = predefined.getAllPredefinedTeams(projectDir);
      const agents = predefined.getAllAgentDefinitions(projectDir);
      const result = predefinedTeams.map(team => ({
        name: team.name,
        agents: team.agents.map(agentName => {
          const agentDef = agents.find(a => a.name === agentName);
          return { name: agentName, description: agentDef?.description || "(agent definition not found)", found: !!agentDef };
        }),
      }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { teams: result } };
    },
  });

  pi.registerTool({
    name: "list_predefined_agents",
    label: "List Predefined Agents",
    description: "List all available predefined agent definitions from .md files. These can be used individually or as part of predefined teams.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const projectDir = ctx.cwd;
      const agents = predefined.getAllAgentDefinitions(projectDir);
      const result = agents.map(agent => ({ name: agent.name, description: agent.description, tools: agent.tools, model: agent.model, thinking: agent.thinking }));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { agents: result } };
    },
  });

  pi.registerTool({
    name: "create_predefined_team",
    label: "Create Predefined Team",
    description: "Create a team from a predefined team configuration by configured level only. model_slot selects write-agent behavior, model, and thinking; direct model/thinking/default_model overrides are not allowed.",
    parameters: Type.Object({
      team_name: Type.String({ description: "Name for the new team instance" }),
      predefined_team: Type.String({ description: "Name of the predefined team template from teams.yaml" }),
      cwd: Type.String({ description: "Working directory for spawned agents" }),
      model_slot: Type.Optional(Type.String({ description: "Favorite writing level from /agents-favorite-models. Defaults to writing-hard." })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      if (options.isTeammate) {
        return requestLeadForTeammateSpawn(options, {
          action: "create_predefined_team",
          params,
          reason: "Teammate attempted to create a predefined team directly.",
        });
      }

      const projectDir = ctx.cwd;
      const predefinedTeam = predefined.getPredefinedTeam(params.predefined_team, projectDir);
      if (!predefinedTeam) {
        const available = predefined.getAllPredefinedTeams(projectDir).map(t => t.name);
        throw new Error(`Predefined team "${params.predefined_team}" not found. Available teams: ${available.join(", ") || "none"}`);
      }
      if (!options.terminal) throw new Error("pi-extended-teams requires running inside tmux.");

      if (params.default_model || params.model || params.thinking || params.role) {
        throw new Error("create_predefined_team must use model_slot only; direct model, thinking, role, or default_model is not allowed.");
      }
      const settings = loadSettings({ projectDir: ctx.cwd });
      const level = requireFavoriteModelLevel(settings, params.model_slot || "writing-hard");
      if (level.role !== "write") throw new Error(`create_predefined_team requires a writing-* level, got ${level.slot}.`);
      const { availableModels } = await getModelSelectionState(ctx, ctx.cwd, [level.model]);
      const defaultModel = requireQualifiedKnownModel(level.model, availableModels, "model_slot");
      if (!defaultModel) throw new Error(`Favorite level ${level.slot} resolved to unavailable model ${level.model}.`);
      const allowedExtensions = resolveAllowedExtensions(settings);

      const config = teams.createTeam(params.team_name, "local-session", "lead-agent", `Predefined team: ${params.predefined_team}`, defaultModel);
      options.adoptTeamAsLead(paths.sanitizeName(params.team_name), ctx);

      const agentDefinitions = predefined.getAllAgentDefinitions(projectDir);
      const spawnResults: Array<{ name: string; status: string; error?: string }> = [];
      for (const agentName of predefinedTeam.agents) {
        const agentDef = agentDefinitions.find(a => a.name === agentName);
        if (!agentDef) {
          spawnResults.push({ name: agentName, status: "skipped", error: "Agent definition not found" });
          continue;
        }

        try {
          const safeName = paths.sanitizeName(agentName);
          const safeTeamName = paths.sanitizeName(params.team_name);
          if (agentDef.model || agentDef.thinking) {
            throw new Error(`Predefined agent \"${agentName}\" must not declare direct model or thinking; choose model_slot when creating the team.`);
          }
          const chosenModel = defaultModel || config.defaultModel;
          if (!chosenModel) throw new Error(`No configured model found for favorite level ${level.slot}.`);

          const member: Member = {
            agentId: `${safeName}@${safeTeamName}`,
            name: safeName,
            agentType: "teammate",
            role: "write",
            model: chosenModel,
            joinedAt: Date.now(),
            tmuxPaneId: "",
            cwd: params.cwd,
            subscriptions: [],
            prompt: agentDef.prompt,
            color: "blue",
            thinking: level.thinking,
            modelSlot: level.slot,
          };

          await teams.addMember(safeTeamName, member);
          await messaging.sendPlainMessage(safeTeamName, "team-lead", safeName, agentDef.prompt, "Initial prompt from predefined team");
          const piBinary = getPiLaunchCommand();
          const piCmd = buildPiCommand(piBinary, chosenModel, agentDef.thinking, allowedExtensions);
          const env: Record<string, string> = { ...process.env, PI_TEAM_NAME: safeTeamName, PI_AGENT_NAME: safeName };

          try {
            const leadMember = (await teams.readConfig(safeTeamName)).members.find(m => m.name === "team-lead");
            const anchorPaneId = leadMember?.tmuxPaneId || process.env.TMUX_PANE || undefined;
            const terminalId = options.terminal.spawn({ name: safeName, cwd: params.cwd, command: piCmd, env, anchorPaneId });
            await teams.updateMember(safeTeamName, safeName, { tmuxPaneId: terminalId });
            spawnResults.push({ name: agentName, status: "spawned", error: undefined });
          } catch (e) {
            spawnResults.push({ name: agentName, status: "error", error: `Failed to spawn: ${e}` });
          }
        } catch (e) {
          spawnResults.push({ name: agentName, status: "error", error: String(e) });
        }
      }

      const summary = spawnResults.map(r => `${r.name}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join("\n");
      return {
        content: [{ type: "text", text: `Team "${params.team_name}" created from predefined team "${params.predefined_team}".\n\nAgent spawn results:\n${summary}` }],
        details: { teamName: params.team_name, predefinedTeam: params.predefined_team, results: spawnResults },
      };
    },
  });

  pi.registerTool({
    name: "save_team_as_template",
    label: "Save Team as Template",
    description: "Save a runtime team as a reusable predefined team template. Creates agent definition files and updates teams.yaml. Use this when you've created a team with custom prompts and want to reuse it later.",
    parameters: Type.Object({
      team_name: Type.String({ description: "Name of the runtime team to save" }),
      template_name: Type.String({ description: "Name for the template (e.g., 'modularization', 'frontend-team')" }),
      description: Type.Optional(Type.String({ description: "Description for the template" })),
      scope: Type.Optional(StringEnum(["user", "project"], { description: "Where to save: 'user' for global (~/.pi), 'project' for project-local (.pi). Defaults to 'user'." })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const teamName = params.team_name;
      if (!teams.teamExists(teamName)) throw new Error(`Team "${teamName}" does not exist. Use list_runtime_teams to see available teams.`);
      const config = await teams.readConfig(teamName);
      const teammates = config.members.filter(m => m.agentType === "teammate");
      if (teammates.length === 0) throw new Error(`Team "${teamName}" has no teammates to save. Only teams with spawned teammates can be saved as templates.`);

      const result = predefined.saveTeamTemplate(config, { templateName: params.template_name, description: params.description, scope: params.scope || "user", projectDir: ctx.cwd });
      const agentSummary = result.savedAgents.map(a => `  - ${a.name}: ${a.existed ? "updated" : "created"} at ${a.path}`).join("\n");
      const message = `Team "${teamName}" saved as template "${params.template_name}".

Agents saved:
${agentSummary}

Template location: ${result.teamsYamlPath}

You can now use this template with:
  create_predefined_team({ team_name: "new-team", predefined_team: "${params.template_name}", cwd: "..." })`;

      return { content: [{ type: "text", text: message }], details: { teamName, templateName: params.template_name, agentsDir: result.agentsDir, teamsYamlPath: result.teamsYamlPath, savedAgents: result.savedAgents, templateExisted: result.templateExisted } };
    },
  });

  pi.registerTool({
    name: "list_runtime_teams",
    label: "List Runtime Teams",
    description: "List all runtime team configurations that can be saved as templates. These are active or saved teams from ~/.pi/teams/.",
    parameters: Type.Object({}),
    async execute() {
      const runtimeTeams = predefined.listRuntimeTeams();
      if (runtimeTeams.length === 0) return { content: [{ type: "text", text: "No runtime teams found. Create a team with team_create first." }], details: { teams: [] } };
      const result = runtimeTeams.map(team => ({ name: team.name, description: team.description, memberCount: team.memberCount, createdAt: team.createdAt ? new Date(team.createdAt).toISOString() : undefined }));
      const summary = result.map(t => `- ${t.name}: ${t.memberCount} teammate(s)${t.description ? ` - ${t.description}` : ""}`).join("\n");
      return { content: [{ type: "text", text: `Runtime teams:\n${summary}` }], details: { teams: result } };
    },
  });
}
