import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as teams from "../../src/utils/teams";
import * as runtime from "../../src/utils/runtime";
import * as messaging from "../../src/utils/messaging";
import { appendTeamReportEvent } from "../../src/utils/report-events";
import { createReportResult } from "../../src/results/report-result";
import type { Member } from "../../src/utils/models";
import type { RunningReadAgent } from "../runtime/types";
import { runReadAgentInProcess, type RunReadAgentOptions } from "./read-agent";
import { closeReadAgentMessageDelivery } from "./read-agent-session-lifecycle";
import { createExternalHarnessRun, ExternalCapacityError, type ExternalHarnessResult } from "./external-harness";

interface ExternalAgentOptions extends RunReadAgentOptions {
  createExternalRun?: typeof createExternalHarnessRun;
  runNativeAgent?: typeof runReadAgentInProcess;
  notifyFallback(content: string): void;
}

/** Adapts an external result to team ownership, not to a synthetic Pi AgentSession. */
export async function runExternalAgent(
  teamName: string,
  member: Member,
  prompt: string,
  ctx: unknown,
  options: ExternalAgentOptions,
): Promise<void> {
  const profile = member.externalHarness;
  const runId = member.lifecycleRunId;
  if (!profile || !runId || !options.shutdownTeammate) throw new Error("External agent requires an admitted profile, run identity and lifecycle owner.");
  const key = options.readAgentKey(teamName, member.name);
  let resolveFinished!: () => void;
  const state: RunningReadAgent = {
    runId,
    name: member.name,
    teamName,
    role: member.role,
    modelSlot: member.modelSlot,
    startedAt: Date.now(),
    tokensUsed: 0,
    status: "starting",
    recentEvents: [],
    lastActivityAt: Date.now(),
    latestProgress: `Starting ${profile.kind} in Herdr`,
    acceptingMessages: true,
    teardownState: "active",
    finished: new Promise<void>(resolve => { resolveFinished = resolve; }),
    // External work has no Pi tool telemetry. Missing tokens must not trigger an idle kill.
    activeWork: new Set(["external-harness"]),
  };
  state.resolveFinished = resolveFinished;
  const isCurrent = () => options.isCurrentReadAgentRun(key, state);
  const control = (options.createExternalRun ?? createExternalHarnessRun)({
    profile,
    cwd: member.cwd,
    prompt: `Assignment role: ${member.role === "read" ? "read-only (do not edit project files)" : "edit-allowed within the assignment"}.\n\n${prompt}`,
    runId,
    agentName: `pet-${crypto.createHash("sha256").update(`${teamName}:${member.name}:${runId}`).digest("hex").slice(0, 24)}`,
    onPane: async paneId => {
      const current = (await teams.readConfig(teamName)).members.find(item => item.name === member.name);
      if (!isCurrent() || state.stopRequested || current?.lifecycleRunId !== runId) throw new Error("External agent admission closed during startup.");
      member.herdrPaneId = paneId;
      await teams.updateMember(teamName, member.name, { herdrPaneId: paneId });
    },
  });
  let stopping: Promise<void> | undefined;
  const externalControl = {
    ...control,
    stop: () => stopping ??= control.stop().catch(error => {
      stopping = undefined;
      throw error;
    }),
  };
  state.externalControl = externalControl;
  state.moveToHerdr = control.focus;
  options.runningReadAgents.set(key, state);
  options.ensureReadAgentStatusTicker();
  options.renderReadAgentStatus();

  const tellLead = (text: string, ok: boolean) => {
    options.emitAgentReport(teamName, member.name, state.startedAt, 0, text, ok);
  };
  const reportReference = () => control.reportPath ? ` Report file: ${control.reportPath}.` : "";
  const publish = async (external: ExternalHarnessResult) => {
    const result = createReportResult(teamName, member.name, runId, { outcome: external.outcome, artifacts: external.artifacts });
    const status = external.outcome === "failed" ? "failed" : "completed";
    let event;
    try {
      event = await appendTeamReportEvent(teamName, {
        agentName: member.name,
        role: member.role,
        status,
        result,
        report: external.content,
        summary: `${profile.kind}: ${external.outcome}`,
        startedAt: state.startedAt,
        elapsedMs: Date.now() - state.startedAt,
        requestedBy: member.requestedBy,
        modelSlot: member.modelSlot,
        source: "external-harness",
        metadata: {
          harness: profile.name,
          parentLifecycleRunId: member.parentLifecycleRunId,
          reportSource: "external-harness",
          initialPrompt: prompt,
        },
      });
    } catch (error) {
      state.finalizationBlockedReason = `External report persistence failed: ${String(error)}. Temporary artifacts are retained.${reportReference()}`;
      throw new Error(state.finalizationBlockedReason);
    }
    options.rememberCompletedAgentReport(teamName, {
      name: member.name,
      role: member.role ?? "read",
      status,
      result,
      report: event.report,
      summary: event.summary,
      completedAt: Date.now(),
      startedAt: state.startedAt,
      requestedBy: member.requestedBy,
      modelSlot: member.modelSlot,
      source: "report-event",
      reportSource: "external-harness",
    });
    const attributed = `External harness report ${JSON.stringify({ name: member.name, runId, harness: profile.name, outcome: external.outcome })}\n\n${event.report}`;
    const parent = member.parentAgentName;
    const parentRun = member.parentLifecycleRunId;
    if (parent && parentRun && member.requestedBy === parent) {
      try {
        await messaging.sendPlainMessageOnceIfRunning(teamName, member.name, parent, attributed, event.summary ?? "External harness report", {
          expectedRecipientRunId: parentRun, operationId: `external-report:${runId}`,
          metadata: { helperReport: true, helperCompletion: true, runId, requestedBy: parent },
        });
        // Persisted inbox delivery owns the report; waking is not the parent's entire model turn.
        void Promise.resolve()
          .then(() => options.deliverMessageToActiveAgent?.(teamName, parent, attributed, parentRun, true))
          .then(delivered => {
            if (!delivered) throw new Error("exact owner wake unconfirmed");
          })
          .catch(error => tellLead(`External report could not wake ${parent} (${parentRun}): ${String(error)}. Do not replay into a replacement.\n\n${attributed}`, status !== "failed"));
        return;
      } catch {
        // The bound owner is gone. Retain the report and route to the lead.
      }
    }
    tellLead(attributed, status !== "failed");
  };

  try {
    await runtime.writeRuntimeStatus(teamName, member.name, runId, { startedAt: state.startedAt, ready: false, currentAction: "starting" });
    if (state.stopRequested || !isCurrent()) return;
    await control.start();
    if (state.stopRequested || !isCurrent()) return;
    state.status = "working";
    state.latestProgress = `${profile.kind} in Herdr; awaiting explicit report`;
    await runtime.writeRuntimeStatus(teamName, member.name, runId, { ready: true, currentAction: "working", lastHeartbeatAt: Date.now() });
    state.heartbeatTimer = setInterval(() => {
      if (!state.stopRequested && isCurrent()) void runtime.writeRuntimeStatus(teamName, member.name, runId, { lastHeartbeatAt: Date.now() }).catch(() => {});
    }, 30_000);
    state.heartbeatTimer.unref();
    options.renderReadAgentStatus();
    const external = await control.result;
    if (state.stopRequested || !isCurrent()) return;
    state.status = "finishing";
    state.acceptingMessages = false;
    const publishing = publish(external);
    state.activeOperationSettlementPromise = publishing.catch(() => {});
    await publishing;
  } catch (error) {
    if (error instanceof ExternalCapacityError && profile.nativeFallback && !state.stopRequested && isCurrent()) {
      try {
        await closeReadAgentMessageDelivery(state).rawDeliverySettlement;
        await externalControl.stop();
        if (state.stopRequested || !isCurrent()) return;
        const template = await readFile(path.join(__dirname, "../prompts/external-fallback.md"), "utf8");
        const values: Record<string, string> = { reason: error.reason, prompt };
        const continuation = template.replace(/\{\{(reason|prompt)\}\}/g, (_match, key: string) => values[key]);
        const updates: Partial<Member> = {
          ...profile.nativeFallback,
          externalHarness: undefined,
          herdrPaneId: undefined,
          backendType: "in-process",
        };
        if (state.stopRequested || !isCurrent()) return;
        await teams.updateMember(teamName, member.name, updates);
        if (state.stopRequested || !isCurrent()) return;
        Object.assign(member, updates);
        const reason = error.reason === "rate_limit" ? "provider quota/rate limit reached" : "provider capacity unavailable";
        const fallback = profile.nativeFallback;
        options.notifyFallback(
          `${member.name}: ${reason}; attempting fallback ${state.modelSlot} → ${fallback.modelSlot} (${fallback.model}, ${fallback.thinking}).`,
        );
        if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
        state.activeWork?.clear();
        resolveFinished();
        return await (options.runNativeAgent ?? runReadAgentInProcess)(teamName, member, continuation, ctx, options);
      } catch (fallbackError) {
        error = fallbackError;
      }
    }
    if (!state.stopRequested && isCurrent()) {
      state.lastError = { message: String(error), timestamp: Date.now() };
      if (state.finalizationBlockedReason) {
        tellLead(state.finalizationBlockedReason, false);
      } else {
        const publishing = publish({
          outcome: "failed",
          content: `External harness ${profile.kind} failed: ${String(error)}${reportReference()}`,
          artifacts: control.reportPath ? [{ path: control.reportPath, label: "External harness report" }] : [],
        });
        state.activeOperationSettlementPromise = publishing.catch(() => {});
        await publishing.catch(persistError => tellLead(String(persistError), false));
      }
    }
  } finally {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    state.activeWork?.clear();
    state.activeOperationSettlementPromise = undefined;
    if (!state.stopRequested && isCurrent()) {
      const cleanup = await options.shutdownTeammate(teamName, member);
      if (!cleanup.finalized) tellLead(`External harness ${member.name} cleanup remains fenced: ${cleanup.error ?? cleanup.status}.`, false);
    }
    options.renderReadAgentStatus();
  }
}
