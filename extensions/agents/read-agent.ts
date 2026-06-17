import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import * as runtime from "../../src/utils/runtime";
import * as messaging from "../../src/utils/messaging";
import * as teams from "../../src/utils/teams";
import type { Member } from "../../src/utils/models";
import type { CompletedAgentReport, RunningReadAgent } from "../runtime/types";
import { getLastAssistantText } from "../ui/renderers";
import { createAgentCommunicationTools } from "../tools/agent-communication-tools";

export interface RunReadAgentOptions {
  isTeammate: boolean;
  getTeamName(): string | null | undefined;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
  isCurrentReadAgentRun(key: string, state: RunningReadAgent): boolean;
  ensureReadAgentStatusTicker(): void;
  renderReadAgentStatus(): void;
  rememberCompletedAgentReport(teamName: string, report: CompletedAgentReport): void;
  emitAgentReport(name: string, startedAt: number, tokens: number, report: string, ok: boolean): void;
  releaseAllClaimsForAgent(teamName: string, agentName: string): Promise<string[]>;
  agentName?: string;
  quietTrigger?(content: string): void;
  renderLeadInboxStatus?(): Promise<void>;
}

function pushReadAgentEvent(agent: RunningReadAgent, text: string): void {
  agent.recentEvents.push(text);
  agent.recentEvents = agent.recentEvents.slice(-12);
}

function markReadAgentActivity(
  agent: RunningReadAgent,
  text: string,
  status: RunningReadAgent["status"],
  activeToolName?: string
): void {
  agent.status = status;
  agent.lastActivityAt = Date.now();
  agent.activeToolName = activeToolName;
  agent.idleNudgeLevel = undefined;
  pushReadAgentEvent(agent, text);
}

function refreshReadAgentStats(agent: RunningReadAgent, session: AgentSession): void {
  const tokensUsed = session.getSessionStats().tokens.total;
  if (tokensUsed !== agent.tokensUsed) {
    agent.lastActivityAt = Date.now();
    agent.idleNudgeLevel = undefined;
  }
  agent.tokensUsed = tokensUsed;
}

export async function shutdownReadAgentSession(session: AgentSession | undefined): Promise<void> {
  if (!session?.abort) return;

  try {
    await Promise.race([
      session.abort(),
      new Promise<void>((resolve) => setTimeout(resolve, 2500)),
    ]);
  } catch {
    // Ignore abort races: the read-agent should continue teardown regardless.
  }
}

async function hasRecentMessageFrom(teamName: string, fromName: string, toName: string, sinceMs: number): Promise<boolean> {
  const messages = await messaging.readInbox(teamName, toName, false, false).catch(() => []);
  return messages.some((message: any) => {
    const timestamp = message.timestamp ? new Date(message.timestamp).getTime() : 0;
    return message.from === fromName && timestamp >= sinceMs - 1000 && String(message.text || "").trim().length > 0;
  });
}

async function ensureReadHelperCompletionMessages(
  teamName: string,
  member: Member,
  startedAt: number,
  report: string,
  outcome: "completed" | "failed" = "completed",
  color = member.color
): Promise<void> {
  if (!member.requestedBy) return;

  const requesterHasReport = await hasRecentMessageFrom(teamName, member.name, member.requestedBy, startedAt);
  if (!requesterHasReport) {
    await messaging.sendPlainMessage(
      teamName,
      member.name,
      member.requestedBy,
      report,
      outcome === "failed" ? `Read helper ${member.name} failed` : `Read helper ${member.name} report`,
      color
    );
  }

  const leadHasNotice = await hasRecentMessageFrom(teamName, member.name, "team-lead", startedAt);
  if (!leadHasNotice) {
    await messaging.sendPlainMessage(
      teamName,
      member.name,
      "team-lead",
      outcome === "failed"
        ? `Read helper ${member.name} failed for ${member.requestedBy}. Failure report sent to ${member.requestedBy}.`
        : `Read helper ${member.name} completed for ${member.requestedBy}. Report sent to ${member.requestedBy}.`,
      outcome === "failed" ? `Read helper ${member.name} failed` : `Read helper ${member.name} done`,
      color
    );
  }
}

export async function runReadAgentInProcess(
  readTeamName: string,
  member: Member,
  prompt: string,
  ctx: any,
  options: RunReadAgentOptions
): Promise<void> {
  const key = options.readAgentKey(readTeamName, member.name);
  const state: RunningReadAgent = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: member.name,
    teamName: readTeamName,
    startedAt: Date.now(),
    tokensUsed: 0,
    status: "starting",
    recentEvents: [],
    lastActivityAt: Date.now(),
    model: member.model,
    thinking: member.thinking,
  };
  options.runningReadAgents.set(key, state);
  options.ensureReadAgentStatusTicker();

  let heartbeatTimer: NodeJS.Timeout | null = null;
  try {
    const [provider, modelId] = (member.model || "").split("/", 2);
    const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
    if (!model) {
      throw new Error(`Read agent model "${member.model}" is not available.`);
    }

    await runtime.writeRuntimeStatus(readTeamName, member.name, {
      pid: process.pid,
      startedAt: state.startedAt,
      lastHeartbeatAt: Date.now(),
      ready: true,
      lastError: undefined,
    });

    heartbeatTimer = setInterval(async () => {
      try {
        await runtime.writeRuntimeStatus(readTeamName, member.name, {
          lastHeartbeatAt: Date.now(),
        });
      } catch {
        // Ignore heartbeat races during shutdown.
      }
    }, 5000);

    const loader = new DefaultResourceLoader({
      cwd: member.cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: [
        `You are read-only investigator '${member.name}' on team '${readTeamName}', running in-process in the lead session.`,
        "You have the full toolset and may run any read-only shell command you need to investigate — git status/log/diff/show, grep/rg, ls, cat, running tests or builds, etc.",
        "Even though the edit/write tools are available, do not use them: do not edit or write files, install or remove packages, start long-running services, commit, push, deploy, or make any other mutating or destructive change. Investigate and report; if a change is needed, recommend it to the lead instead of applying it.",
        "Use send_message, broadcast_message, and read_inbox to coordinate with the lead and other teammates when needed.",
        member.requestedBy
          ? `You are a read helper requested by '${member.requestedBy}'. When finished, you must call send_message to send your full report to '${member.requestedBy}', then call send_message to send only a short done notification to team-lead. After both messages are sent, write a brief final answer confirming the report was sent and stop. There is no exception to this rule.`
          : "You cannot spawn, promote, or create other agents. If another agent is needed, call request_teammate to ask the team lead to decide and spawn it.",
        "NEVER sleep, busy-wait, or poll. Do not use bash sleep, while-true, or any wait/poll loop. The extension wakes you when messages arrive.",
        "When finished, send or produce your final report as instructed, then stop. Do not wait for the lead to kill you — report and exit cleanly.",
      ],
    });
    await loader.reload();

    const communicationTools = createAgentCommunicationTools({
      isTeammate: true,
      agentName: member.name,
      getTeamName: () => readTeamName,
    });
    const communicationToolNames = communicationTools.map(tool => tool.name);

    const { session } = await createAgentSession({
      cwd: member.cwd,
      model,
      thinkingLevel: member.thinking as any,
      modelRegistry: ctx.modelRegistry,
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls", ...communicationToolNames],
      customTools: communicationTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(member.cwd),
    });

    state.session = session;
    markReadAgentActivity(state, "started", "thinking");
    options.renderReadAgentStatus();

    session.subscribe((event: any) => {
      if (event.type === "agent_start" || event.type === "turn_start") {
        markReadAgentActivity(state, "thinking", "thinking");
      }
      if (event.type === "message_start" && event.message?.role === "assistant") {
        markReadAgentActivity(state, "thinking", "thinking");
      }
      if (event.type === "message_update") {
        markReadAgentActivity(state, "thinking", "thinking");
      }
      if (event.type === "tool_execution_start") {
        markReadAgentActivity(state, `working: ${event.toolName}`, "working", event.toolName);
      }
      if (event.type === "tool_execution_update") {
        markReadAgentActivity(state, `working: ${event.toolName}`, "working", event.toolName);
      }
      if (event.type === "tool_execution_end") {
        markReadAgentActivity(state, "thinking", "thinking");
      }
      if (event.type === "agent_end") pushReadAgentEvent(state, "agent complete");
      if (event.type === "message_update" || event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") {
        try {
          refreshReadAgentStats(state, session);
          options.renderReadAgentStatus();
        } catch {
          // Ignore stats races while the nested session is shutting down.
        }
      }
    });

    await session.prompt(prompt, { source: "extension" as any });
    state.status = "finishing";
    state.activeToolName = undefined;
    refreshReadAgentStats(state, session);
    markReadAgentActivity(state, "sending report", "finishing");
    options.renderReadAgentStatus();

    if (state.stopRequested || !options.isCurrentReadAgentRun(key, state)) return;

    const report = getLastAssistantText(session.messages) || "Read agent completed, but produced no assistant text.";
    options.rememberCompletedAgentReport(readTeamName, {
      name: member.name,
      role: "read",
      status: "completed",
      report,
      summary: `Read agent ${member.name} completed`,
      completedAt: Date.now(),
      startedAt: state.startedAt,
      elapsedMs: Date.now() - state.startedAt,
      tokensUsed: state.tokensUsed,
      model: member.model,
      thinking: member.thinking,
      color: member.color,
      requestedBy: member.requestedBy,
      source: "read-agent",
    });
    if (member.requestedBy) {
      await ensureReadHelperCompletionMessages(readTeamName, member, state.startedAt, report);
      await options.renderLeadInboxStatus?.().catch(() => {});
      if (member.requestedBy === options.agentName) {
        options.quietTrigger?.(`Read helper ${member.name} finished. Read its report now with read_inbox(team_name="${readTeamName}") and continue your task. Do not poll.`);
      }
    } else if (!options.isTeammate && options.getTeamName() === readTeamName) {
      options.emitAgentReport(member.name, state.startedAt, state.tokensUsed, report, true);
    } else {
      await messaging.sendPlainMessage(readTeamName, member.name, "team-lead", report, `Read agent ${member.name} completed`, member.color);
    }
  } catch (e) {
    if (!state.stopRequested && options.isCurrentReadAgentRun(key, state)) {
      const failureReport = `Read agent ${member.name} failed: ${e instanceof Error ? e.message : String(e)}`;
      options.rememberCompletedAgentReport(readTeamName, {
        name: member.name,
        role: "read",
        status: "failed",
        report: failureReport,
        summary: `Read agent ${member.name} failed`,
        completedAt: Date.now(),
        startedAt: state.startedAt,
        elapsedMs: Date.now() - state.startedAt,
        tokensUsed: state.tokensUsed,
        model: member.model,
        thinking: member.thinking,
        color: "red",
        requestedBy: member.requestedBy,
        source: "read-agent",
      });
      if (member.requestedBy) {
        await ensureReadHelperCompletionMessages(readTeamName, member, state.startedAt, failureReport, "failed", "red");
        await options.renderLeadInboxStatus?.().catch(() => {});
        if (member.requestedBy === options.agentName) {
          options.quietTrigger?.(`Read helper ${member.name} failed. Read the failure report with read_inbox(team_name="${readTeamName}") and continue or report the blocker. Do not poll.`);
        }
      } else if (!options.isTeammate && options.getTeamName() === readTeamName) {
        options.emitAgentReport(member.name, state.startedAt, state.tokensUsed, failureReport, false);
      } else {
        await messaging.sendPlainMessage(readTeamName, member.name, "team-lead", failureReport, `Read agent ${member.name} failed`, "red");
      }
      try {
        await runtime.writeRuntimeStatus(readTeamName, member.name, {
          lastHeartbeatAt: Date.now(),
          lastError: runtime.createRuntimeError(e),
        });
      } catch {
        // Ignore runtime cleanup races.
      }
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (state.session) await shutdownReadAgentSession(state.session);
    state.session?.dispose();
    if (options.isCurrentReadAgentRun(key, state)) {
      options.runningReadAgents.delete(key);
      await options.releaseAllClaimsForAgent(readTeamName, member.name);
      try { await runtime.deleteRuntimeStatus(readTeamName, member.name); } catch {}
      try { await teams.removeMember(readTeamName, member.name); } catch {}
    }
    options.renderReadAgentStatus();
  }
}
