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
}

function pushReadAgentEvent(agent: RunningReadAgent, text: string): void {
  agent.recentEvents.push(`${new Date().toLocaleTimeString()} ${text}`);
  agent.recentEvents = agent.recentEvents.slice(-12);
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
        "NEVER sleep, busy-wait, or poll. Do not use bash sleep, while-true, or any wait/poll loop. The extension wakes you when messages arrive.",
        "When finished, produce your final report and stop. Do not wait for the lead to kill you — report and exit cleanly.",
      ],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: member.cwd,
      model,
      thinkingLevel: member.thinking as any,
      modelRegistry: ctx.modelRegistry,
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(member.cwd),
    });

    state.session = session;
    state.status = "running";
    pushReadAgentEvent(state, "started");
    options.renderReadAgentStatus();

    session.subscribe((event: any) => {
      if (event.type === "tool_execution_start") pushReadAgentEvent(state, `tool ${event.toolName}`);
      if (event.type === "turn_end") pushReadAgentEvent(state, "turn complete");
      if (event.type === "agent_end") pushReadAgentEvent(state, "agent complete");
      if (event.type === "message_end" || event.type === "turn_end" || event.type === "agent_end") {
        try {
          state.tokensUsed = session.getSessionStats().tokens.total;
          options.renderReadAgentStatus();
        } catch {
          // Ignore stats races while the nested session is shutting down.
        }
      }
    });

    await session.prompt(prompt, { source: "extension" as any });
    state.status = "finishing";
    state.tokensUsed = session.getSessionStats().tokens.total;
    pushReadAgentEvent(state, "sending report");
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
      source: "read-agent",
    });
    if (!options.isTeammate && options.getTeamName() === readTeamName) {
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
        source: "read-agent",
      });
      if (!options.isTeammate && options.getTeamName() === readTeamName) {
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
