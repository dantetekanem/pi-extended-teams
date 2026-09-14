import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { Key } from "@mariozechner/pi-tui";
import { connectReloadOwner, type ReloadOwner } from "./reload-owner";
import { createTeamHost, type TeamHostBinding } from "./team-host";
import { registerAgentReportRenderer } from "../events/register-events";
import { publicTeamToolMetadata } from "../tools/public-team-tools";
import { registerCoordinationTools, type CoordinationToolsOptions } from "../tools/coordination-tools";
import { registerTaskRuntimeTools, type TaskRuntimeToolsOptions } from "../tools/task-runtime-tools";
import { registerFavoriteModelsCommand } from "../ui/favorite-models-command";
import { registerExtensionsCommand } from "../ui/extensions-command";
import { registerOnboardingCommand } from "../ui/onboarding-command";
import { registerCheckpointsCommand } from "../ui/checkpoints-command";

export interface TeamExecutionOwner extends ReloadOwner<TeamHostBinding> {
  host: ReturnType<typeof createTeamHost>;
  coordination: CoordinationToolsOptions;
  taskTools: TaskRuntimeToolsOptions;
  activate(): void;
}

export function registerLeadAttachment(pi: ExtensionAPI, createOwner: () => TeamExecutionOwner): void {
  let connection: Awaited<ReturnType<typeof connectReloadOwner<TeamHostBinding>>> | undefined;
  let attaching: Promise<void> | undefined;
  const attach = (ctx: any, event: any): Promise<void> => {
    if (connection) return Promise.resolve();
    return attaching ??= connectReloadOwner(ctx.sessionManager, ctx.sessionManager.getSessionId(), { pi, ctx, event }, createOwner)
      .then(value => { connection = value; execution().activate(); }).finally(() => { attaching = undefined; });
  };
  const execution = (): TeamExecutionOwner => {
    if (!connection) throw new Error("Team execution is not attached to this session.");
    return connection.owner as TeamExecutionOwner;
  };

  for (const metadata of Object.values(publicTeamToolMetadata)) {
    pi.registerTool<TSchema>({ ...metadata, async execute(id, params, signal, update, ctx) {
      await attach(ctx, { reason: "startup" });
      const owner = execution();
      return owner.host.tools.get(metadata.name).execute(id, params, signal, update, owner.host.snapshot(ctx));
    } });
  }
  // These lead-only adapters carry no running task state. In-process child
  // tools remain owned by the retained controller and its original imports.
  registerCoordinationTools(pi, {
    isTeammate: false, agentName: "team-lead",
    get terminal() { return execution().coordination.terminal; },
    getTeamName: () => execution().coordination.getTeamName(),
    requireWriteAgentTeam: () => execution().coordination.requireWriteAgentTeam(),
    requireTeamContext: name => execution().coordination.requireTeamContext(name),
    releaseAllClaimsForAgent: (...args) => execution().coordination.releaseAllClaimsForAgent(...args),
    drainWriteQueue: name => execution().coordination.drainWriteQueue(name),
    resolveSkillFile: (...args) => execution().coordination.resolveSkillFile(...args),
    adoptTeamAsLead: (name, ctx) => execution().coordination.adoptTeamAsLead(name, ctx && execution().host.snapshot(ctx)),
    renderLeadInboxStatus: () => execution().coordination.renderLeadInboxStatus(),
    resetLeadWakeNotifiedCount: () => execution().coordination.resetLeadWakeNotifiedCount(),
    deliverMessageToActiveAgent: (...args) => execution().coordination.deliverMessageToActiveAgent!(...args),
  });
  registerTaskRuntimeTools(pi, {
    isTeammate: false,
    get terminal() { return execution().taskTools.terminal; },
    get runningReadAgents() { return execution().taskTools.runningReadAgents; },
    readAgentKey: (...args) => execution().taskTools.readAgentKey(...args),
    getTeamName: () => execution().taskTools.getTeamName(),
    interruptTeammate: name => execution().taskTools.interruptTeammate!(name),
    cancelQueuedAgent: (...args) => execution().taskTools.cancelQueuedAgent!(...args),
    shutdownTeammate: (...args) => execution().taskTools.shutdownTeammate(...args),
  });
  registerAgentReportRenderer(pi);
  registerFavoriteModelsCommand(pi);
  registerExtensionsCommand(pi);
  registerOnboardingCommand(pi);
  registerCheckpointsCommand(pi);
  pi.registerShortcut(Key.alt("tab"), {
    description: "Cycle active writer-agent tmux screens",
    handler: ctx => execution().host.shortcuts.get(Key.alt("tab"))?.handler(execution().host.snapshot(ctx)),
  });

  pi.on("session_start", (event, ctx) => attach(ctx, event));
  pi.on("session_shutdown", async event => {
    const current = connection;
    connection = undefined;
    await current?.shutdown(event.reason ?? "quit");
  });
  for (const name of ["context", "turn_start", "tool_execution_start", "tool_execution_end", "message_end", "turn_end",
    "before_agent_start", "agent_end", "agent_settled", "session_compact", "session_tree"] as const) {
    (pi.on as any)(name, (event: unknown, ctx: unknown) => {
      const owner = execution();
      return owner.host.emit(name, event, owner.host.snapshot(ctx));
    });
  }
}
