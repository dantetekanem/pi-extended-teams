import * as fs from "node:fs";
import { Type } from "@sinclair/typebox";
import * as paths from "../../src/utils/paths";
import * as teams from "../../src/utils/teams";
import * as tasks from "../../src/utils/tasks";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import * as claims from "../../src/utils/claims";
import * as sharedMemory from "../../src/utils/shared-memory";
import { formatInboxMessagesForModel, renderInboxMessages } from "../ui/renderers";

export interface CoordinationToolsOptions {
  agentName: string;
  isTeammate: boolean;
  terminal: any;
  getTeamName(): string | null | undefined;
  requireWriteAgentTeam(): Promise<string>;
  requireTeamContext(explicitTeamName?: string): string;
  releaseAllClaimsForAgent(teamName: string, agentName: string): Promise<string[]>;
  drainWriteQueue(teamName: string): Promise<void>;
  resolveSkillFile(skillName: string, cwd: string): string;
  adoptTeamAsLead(teamName: string): void;
  renderLeadInboxStatus(): Promise<void>;
  resetLeadWakeNotifiedCount(): void;
}

export function registerCoordinationTools(pi: any, options: CoordinationToolsOptions): void {
  pi.registerTool({
    name: "claim_file",
    label: "Claim File",
    description: "Claim one or more file paths before a write agent edits them. The claim is exclusive per path within the current team.",
    parameters: Type.Object({ paths: Type.Array(Type.String(), { description: "Repository-relative file paths to claim atomically." }) }),
    async execute(_toolCallId: string, params: any) {
      const targetTeamName = await options.requireWriteAgentTeam();
      const result = await claims.claimFiles(targetTeamName, options.agentName, params.paths);
      const blockedTasks = result.conflicts.length > 0
        ? await tasks.markOwnerTasksBlockedByFileClaims(targetTeamName, options.agentName, result.conflicts)
        : [];
      const unblockedTasks = result.granted.length > 0
        ? await tasks.clearOwnerFileClaimBlocks(targetTeamName, options.agentName, result.granted)
        : [];
      const text = result.conflicts.length > 0
        ? [
            `File claim request blocked for ${options.agentName}.`,
            "Conflicts:",
            ...result.conflicts.map(conflict => `- ${conflict.path} held by ${conflict.heldBy}`),
            blockedTasks.length > 0
              ? `Marked owned task(s) blocked: ${blockedTasks.map(task => task.id).join(", ")}`
              : "No owned open task was available to mark blocked.",
          ].join("\n")
        : result.granted.length > 0
          ? [
              `Claimed ${result.granted.length} file(s) for ${options.agentName}:`,
              ...result.granted.map(path => `- ${path}`),
              unblockedTasks.length > 0
                ? `Cleared file-claim blocker(s) from task(s): ${unblockedTasks.map(task => task.id).join(", ")}`
                : "No file-claim task blockers needed clearing.",
            ].join("\n")
          : `No file paths claimed for ${options.agentName}.`;

      return {
        content: [{ type: "text", text }],
        details: {
          agent: options.agentName,
          teamName: targetTeamName,
          ...result,
          blockedTaskIds: blockedTasks.map(task => task.id),
          unblockedTaskIds: unblockedTasks.map(task => task.id),
        },
      };
    },
  });

  pi.registerTool({
    name: "release_file",
    label: "Release File",
    description: "Release one or more file claims held by the current write agent.",
    parameters: Type.Object({ paths: Type.Array(Type.String(), { description: "Repository-relative file paths to release." }) }),
    async execute(_toolCallId: string, params: any) {
      const targetTeamName = await options.requireWriteAgentTeam();
      const released = await claims.releaseFiles(targetTeamName, options.agentName, params.paths);
      const text = released.length > 0
        ? `Released ${released.length} file claim(s) for ${options.agentName}:\n${released.map(path => `- ${path}`).join("\n")}`
        : `No matching file claims held by ${options.agentName} were released.`;
      return { content: [{ type: "text", text }], details: { agent: options.agentName, teamName: targetTeamName, released } };
    },
  });

  pi.registerTool({
    name: "list_file_claims",
    label: "List File Claims",
    description: "List the current file claims for a team. Defaults to the current team context when available.",
    parameters: Type.Object({ team_name: Type.Optional(Type.String({ description: "Team name. Defaults to the current team context." })) }),
    async execute(_toolCallId: string, params: any) {
      const targetTeamName = options.requireTeamContext(params.team_name);
      const currentClaims = (await claims.listClaims(targetTeamName)).sort((a, b) => a.path.localeCompare(b.path));
      const text = currentClaims.length > 0
        ? [`Current file claims for ${targetTeamName}:`, ...currentClaims.map(claim => `- ${claim.path} held by ${claim.agent} since ${new Date(claim.since).toISOString()}`)].join("\n")
        : `No current file claims for ${targetTeamName}.`;
      return { content: [{ type: "text", text }], details: { teamName: targetTeamName, claims: currentClaims } };
    },
  });

  pi.registerTool({
    name: "report_and_exit",
    label: "Report and Exit",
    description: "Send a final report to the team lead, release all file claims, and shut down this teammate.",
    parameters: Type.Object({
      team_name: Type.Optional(Type.String({ description: "Team name. Defaults to the current team context." })),
      content: Type.String({ description: "Final report to send to team-lead." }),
      summary: Type.Optional(Type.String({ description: "Short inbox summary for the final report." })),
    }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const targetTeamName = options.requireTeamContext(params.team_name);
      if (!options.isTeammate) throw new Error("report_and_exit is only available to teammates.");

      const config = await teams.readConfig(targetTeamName);
      const member = config.members.find(m => m.name === options.agentName);
      const tmuxPaneId = member?.tmuxPaneId;

      await messaging.sendPlainMessage(targetTeamName, options.agentName, "team-lead", params.content, params.summary || "Final report");
      const releasedClaims = await options.releaseAllClaimsForAgent(targetTeamName, options.agentName);
      await runtime.deleteRuntimeStatus(targetTeamName, options.agentName);
      await teams.removeMember(targetTeamName, options.agentName);
      await options.drainWriteQueue(targetTeamName);

      setTimeout(() => {
        void (async () => {
          try {
            if (tmuxPaneId && options.terminal) options.terminal.kill(tmuxPaneId);
          } catch {
            // Ignore shutdown cleanup races; this tool is already exiting.
          } finally {
            try { ctx.shutdown(); } catch { process.exit(0); }
          }
        })();
      }, 250);

      return {
        content: [{ type: "text", text: `Final report sent to team-lead. Released ${releasedClaims.length} file claim(s). Exiting.` }],
        details: { teamName: targetTeamName, releasedClaims },
      };
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send Message",
    description: "Send a message to a teammate.",
    parameters: Type.Object({ team_name: Type.String(), recipient: Type.String(), content: Type.String(), summary: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      await messaging.sendPlainMessage(params.team_name, options.agentName, params.recipient, params.content, params.summary);
      return { content: [{ type: "text", text: `Message sent to ${params.recipient}.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "broadcast_message",
    label: "Broadcast Message",
    description: "Broadcast a message to all team members except the sender.",
    parameters: Type.Object({ team_name: Type.String(), content: Type.String(), summary: Type.String(), color: Type.Optional(Type.String()) }),
    async execute(_toolCallId: string, params: any) {
      await messaging.broadcastMessage(params.team_name, options.agentName, params.content, params.summary, params.color);
      return { content: [{ type: "text", text: `Message broadcasted to all team members.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "write_shared_memory",
    label: "Write Shared Memory",
    description: "Write or replace a team-shared memory entry by key. Use for durable coordination facts within the current team.",
    parameters: Type.Object({ team_name: Type.String(), key: Type.String(), value: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const entry = await sharedMemory.writeSharedMemory(params.team_name, options.agentName, params.key, params.value);
      return { content: [{ type: "text", text: `Shared memory '${entry.key}' saved.` }], details: { entry } };
    },
  });

  pi.registerTool({
    name: "read_shared_memory",
    label: "Read Shared Memory",
    description: "Read team-shared memory entries. Omit key to list all entries.",
    parameters: Type.Object({ team_name: Type.String(), key: Type.Optional(Type.String()) }),
    async execute(_toolCallId: string, params: any) {
      const entries = await sharedMemory.readSharedMemory(params.team_name, params.key);
      const text = entries.length > 0
        ? entries.map(entry => `${entry.key} (${entry.author}, ${new Date(entry.updatedAt).toISOString()}):\n${entry.value}`).join("\n\n")
        : params.key ? `No shared memory entry for '${params.key}'.` : "No shared memory entries.";
      return { content: [{ type: "text", text }], details: { entries } };
    },
  });

  pi.registerTool({
    name: "delete_shared_memory",
    label: "Delete Shared Memory",
    description: "Delete one team-shared memory entry by key.",
    parameters: Type.Object({ team_name: Type.String(), key: Type.String() }),
    async execute(_toolCallId: string, params: any) {
      const entry = await sharedMemory.deleteSharedMemory(params.team_name, params.key);
      if (!entry) throw new Error(`Shared memory entry '${params.key}' not found.`);
      return { content: [{ type: "text", text: `Shared memory '${entry.key}' deleted.` }], details: { entry } };
    },
  });

  pi.registerTool({
    name: "use_skill",
    label: "Use Skill",
    description: "Load a named skill file into the current agent context.",
    parameters: Type.Object({ name: Type.String({ description: "Skill name, for example teams." }) }),
    async execute(_toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
      const file = options.resolveSkillFile(params.name, ctx.cwd);
      const content = fs.readFileSync(file, "utf-8");
      return { content: [{ type: "text", text: `Loaded skill '${params.name}' from ${file}:\n\n${content}` }], details: { name: params.name, path: file } };
    },
  });

  pi.registerTool({
    name: "read_inbox",
    label: "Read Inbox",
    description: "Read messages from an agent's inbox.",
    parameters: Type.Object({
      team_name: Type.String(),
      agent_name: Type.Optional(Type.String({ description: "Whose inbox to read. Defaults to your own." })),
      unread_only: Type.Optional(Type.Boolean({ default: true })),
    }),
    async execute(_toolCallId: string, params: any) {
      const targetAgent = params.agent_name || options.agentName;
      if (!options.isTeammate && teams.teamExists(paths.sanitizeName(params.team_name))) {
        options.adoptTeamAsLead(paths.sanitizeName(params.team_name));
      }
      const msgs = await messaging.readInbox(params.team_name, targetAgent, params.unread_only);

      if (options.isTeammate && options.getTeamName() && params.team_name === options.getTeamName() && targetAgent === options.agentName) {
        await runtime.writeRuntimeStatus(options.getTeamName()!, options.agentName, {
          lastHeartbeatAt: Date.now(),
          lastInboxReadAt: Date.now(),
          ready: true,
          lastError: undefined,
        });
      }

      if (!options.isTeammate && params.team_name === options.getTeamName() && targetAgent === options.agentName) {
        options.resetLeadWakeNotifiedCount();
        await options.renderLeadInboxStatus();
      }

      return { content: [{ type: "text", text: formatInboxMessagesForModel(msgs) }], details: { messages: msgs, targetAgent } };
    },
    renderResult(result: any, { expanded }: any, theme: any) {
      return renderInboxMessages(result, expanded, theme);
    },
  });
}
