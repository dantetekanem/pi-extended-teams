import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import type {
  DeliverReport,
  DurableAgentReport,
  DurableAgentRole,
  DurableAgentRuntime,
  DurableAgentStatus,
} from "../../src/durable/agent-runtime";
import { parseQualifiedModel } from "../../src/utils/model-resolution";
import { sanitizeName } from "../../src/utils/paths";
import {
  ACCEPTED_FAVORITE_MODEL_SLOTS,
  loadSettings,
  normalizeFavoriteModelSlot,
  resolveModel,
  roleForFavoriteModelSlot,
} from "../../src/utils/settings";
import { THINKING_LEVEL_NAMES } from "../../src/utils/thinking-levels";
import { getCurrentQualifiedModel } from "../internal/model-selection";
import { loadPiRuntimeApi } from "../internal/pi-runtime-api";
import { StringEnum } from "../internal/schema";
import { getPiSessionId } from "../internal/session-files";

export const DURABLE_REPORT_MESSAGE_TYPE = "pi-extended-teams-durable-report";
const RELOAD_HOLD_MS = 60_000;
const SLOTS = Symbol.for("pi-extended-teams.durable-agent-runtimes.v1");

export interface ProjectContext {
  contextFiles: Array<{ path: string; content: string }>;
  skills: string;
}

export interface DurableAgentsOptions {
  /** Default: the `experimental.durableAgents` setting. */
  enabled?: boolean;
  /** Default: ~/.pi/agent. */
  agentDir?: string;
  /** Default: AGENTS.md files and skills, loaded through the running Pi. */
  loadContext?: (cwd: string) => Promise<ProjectContext>;
}

/** One open runtime per session file. It lives on globalThis so a same-process /reload reuses it. */
interface RuntimeSlot {
  runtime: Promise<DurableAgentRuntime>;
  deliver?: DeliverReport;
  warn?: (error: unknown) => void;
  release?: ReturnType<typeof setTimeout>;
}

function runtimeSlots(): Map<string, RuntimeSlot> {
  const scope = globalThis as typeof globalThis & { [SLOTS]?: Map<string, RuntimeSlot> };
  return (scope[SLOTS] ??= new Map());
}

/** Outside ~/.pi/teams, which the next Pi start removes once the lead process is gone. */
export function durableAgentsFile(agentDir: string, sessionId: string): string {
  return path.join(agentDir, "pi-extended-teams", "durable-agents", sanitizeName(sessionId), "agents.sqlite");
}

const parameters = Type.Object({
  action: StringEnum(["spawn", "send", "interrupt", "stop", "status"] as const, { description: "What to do." }),
  name: Type.Optional(Type.String({ description: "The agent. Required for every action except status." })),
  prompt: Type.Optional(Type.String({ description: "spawn: the assignment, relevant context and evidence, constraints, and report shape." })),
  model_slot: Type.Optional(StringEnum(ACCEPTED_FAVORITE_MODEL_SLOTS, {
    description: "spawn: intent tier. read-* tiers get read and bash; write-* tiers add edit and write. Unconfigured tiers inherit the lead model and thinking.",
    default: "read-review",
  })),
  cwd: Type.Optional(Type.String({ description: "spawn: working directory. Defaults to the lead session cwd." })),
  message: Type.Optional(Type.String({ description: "send: the message." })),
  steer: Type.Optional(Type.Boolean({ description: "send: join the agent's current work instead of queueing after its current answer." })),
});

const description = [
  "Experimental. Run agents on Pi Durable that survive Pi restarts and crashes.",
  "Actions: spawn (name, prompt, model_slot, optional cwd); send (name, message; steer: true joins the agent's current work, otherwise the message queues after its current answer); interrupt (name: abort its running tool calls, it keeps working); stop (name: abort its work and refuse new messages); status.",
  "Every answer arrives automatically as a report message, so end your turn instead of polling. If Pi stops, reopening this session continues unfinished work.",
  "Agents see AGENTS.md and skills, but not Pi extensions, team tools, file claims, checks, or completion groups; use spawn_agent when you need those.",
].join(" ");

function roleInstructions(name: string, role: DurableAgentRole): string {
  const common = [
    `You are durable agent '${name}', working for the lead agent of this Pi session.`,
    "Your final answer is your report to the lead: lead with the result, cite file paths and lines as evidence, and name what you could not verify.",
    "Never sleep, busy-wait, or poll. New messages from the lead reach you automatically.",
  ];
  const scope = role === "write"
    ? "You may edit only the files your assignment names. Keep changes small, report every changed path, and report the exact checks you ran with their results. Do not install or remove packages, commit, push, deploy, or make destructive changes unless the assignment says so."
    : "You are read-only. Investigate with read and bash, but do not edit or write files, install or remove packages, commit, push, or make any other change. If a change is needed, recommend it in your report.";
  return [...common, scope].join("\n");
}

function formatReport(report: DurableAgentReport): string {
  const heading = report.outcome === "answered" ? `Durable agent ${report.agent} reported:` : `Durable agent ${report.agent} failed:`;
  return `${heading}\n\n${report.text}`;
}

function formatStatus(statuses: DurableAgentStatus[]): string {
  if (statuses.length === 0) return "No durable agents in this session.";
  return statuses.map((status) => {
    const parts = [`${status.name} (${status.role}): ${status.state}`];
    if (status.runningTools.length > 0) parts.push(`running ${status.runningTools.join(", ")}`);
    if (status.openMessages > 0) parts.push(`${status.openMessages} open message${status.openMessages === 1 ? "" : "s"}`);
    parts.push(`$${status.costUsd.toFixed(4)}`);
    return parts.join(", ");
  }).join("\n");
}

function reportInHistory(ctx: any, reportId: string): boolean {
  const entries: any[] = ctx?.sessionManager?.getEntries?.() ?? [];
  return entries.some((entry) => entry?.type === "custom_message"
    && entry.customType === DURABLE_REPORT_MESSAGE_TYPE
    && entry.details?.reportId === reportId);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function required(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(message);
  return value;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

async function piProjectContext(cwd: string): Promise<ProjectContext> {
  const api: any = await loadPiRuntimeApi();
  const agentDir = api.getAgentDir();
  const contextFiles = api.loadProjectContextFiles({ cwd, agentDir });
  const { skills } = api.loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
  return { contextFiles, skills: api.formatSkillsForPrompt(skills) };
}

function projectContextExtension(
  { defineExtension, section }: typeof import("@earendil-works/pi-durable"),
  load: (cwd: string) => Promise<ProjectContext>,
  fallbackCwd: string,
  warn: (error: unknown) => void,
): Extension {
  const loaded = new Map<string, Promise<ProjectContext>>();
  const context = (cwd: string | undefined): Promise<ProjectContext> => {
    const key = cwd ?? fallbackCwd;
    let found = loaded.get(key);
    if (found === undefined) {
      found = load(key).catch((error) => {
        warn(error);
        return { contextFiles: [], skills: "" };
      });
      loaded.set(key, found);
    }
    return found;
  };
  return defineExtension({
    name: "pi-extended-teams.project-context",
    sections: [
      section("project_context", async (input) => {
        const { contextFiles } = await context(input.agent.cwd);
        if (contextFiles.length === 0) return undefined;
        return contextFiles
          .map((file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`)
          .join("\n\n");
      }),
      section("skills", async (input) => (await context(input.agent.cwd)).skills || undefined, { tag: false }),
    ],
  });
}

function resolveLevel(modelSlot: unknown, cwd: string, ctx: any, pi: any) {
  const slot = normalizeFavoriteModelSlot(modelSlot ?? "read-review");
  if (!slot) throw new Error(`Unknown model_slot ${String(modelSlot)}.`);
  const role = roleForFavoriteModelSlot(slot);
  const resolved = resolveModel(loadSettings({ projectDir: cwd }), {
    role,
    modelSlot: slot,
    currentModel: getCurrentQualifiedModel(ctx) ?? null,
    currentThinking: ctx.thinkingLevel ?? pi.getThinkingLevel?.() ?? null,
  });
  const parsed = resolved.model ? parseQualifiedModel(resolved.model) : null;
  if (!parsed) throw new Error(`Could not resolve model_slot ${slot}: it is not configured and the lead session has no model.`);
  const thinking = (THINKING_LEVEL_NAMES as readonly string[]).includes(resolved.thinking ?? "")
    ? resolved.thinking as ModelThinkingLevel
    : undefined;
  return { slot, role, model: { provider: parsed.provider, modelId: parsed.model }, thinking };
}

/** Registers `durable_agents` and its session lifecycle on the real Pi API when the setting is on. */
export function registerDurableAgents(pi: any, options: DurableAgentsOptions = {}): void {
  const enabled = options.enabled ?? loadSettings({ projectDir: process.cwd() }).experimental.durableAgents;
  if (!enabled) return;
  const agentDir = options.agentDir ?? path.join(os.homedir(), ".pi", "agent");
  const loadContext = options.loadContext ?? piProjectContext;
  let ctx: any;
  let file: string | undefined;
  /** Reports sent in this process but not yet seen in the session history. */
  const sent = new Set<string>();
  /** Sent while Pi emitted agent_settled: Pi runs them after the emission, possibly behind other deferred prompts. */
  const deferred = new Set<string>();
  /** A sent report starts a lead turn; the next one waits until that turn settles. */
  let reportTurnPending = false;
  let deliveryRetry: ReturnType<typeof setTimeout> | undefined;

  const warn = (error: unknown): void => {
    try {
      ctx?.ui?.notify?.(`Durable agents: ${errorText(error)}`, "warning");
    } catch {
      // A replaced session's context throws; there is nobody left to warn.
    }
  };

  const leadIsIdle = (): boolean => {
    try {
      return typeof ctx.isIdle !== "function" || ctx.isIdle() === true;
    } catch {
      return false;
    }
  };

  // Pi queues a message sent while the lead works, and Esc throws that queue away. So a report goes out only while the
  // lead is idle, and it counts as delivered only once the session history shows it.
  const deliver: DeliverReport = (report) => {
    if (ctx === undefined) return false;
    if (reportInHistory(ctx, report.id)) {
      sent.delete(report.id);
      deferred.delete(report.id);
      return true;
    }
    if (sent.has(report.id) || reportTurnPending || !leadIsIdle()) return false;
    const sending = pi.sendMessage(
      {
        customType: DURABLE_REPORT_MESSAGE_TYPE,
        content: formatReport(report),
        display: true,
        details: { reportId: report.id, agent: report.agent, outcome: report.outcome },
      },
      { triggerTurn: true },
    );
    Promise.resolve(sending).catch(warn);
    sent.add(report.id);
    // A send that starts a turn marks the lead busy before it returns; one that leaves the lead idle was deferred.
    if (leadIsIdle()) deferred.add(report.id);
    reportTurnPending = true;
    return reportInHistory(ctx, report.id);
  };

  // Pi emits session_compact before it clears its compacting state, and a manual compaction ends without
  // agent_settled, so retry for a few seconds until the lead is idle.
  function retryDelivery(attempt = 0): void {
    clearTimeout(deliveryRetry);
    deliveryRetry = setTimeout(() => {
      deliveryRetry = undefined;
      if (file === undefined) return;
      if (leadIsIdle()) void deliverPending();
      else if (attempt < 40) retryDelivery(attempt + 1);
    }, attempt === 0 ? 0 : 250);
    deliveryRetry.unref?.();
  }

  async function attach(nextCtx: any, create: boolean): Promise<DurableAgentRuntime | undefined> {
    ctx = nextCtx;
    const sessionId = getPiSessionId(nextCtx);
    if (sessionId === undefined) {
      if (create) throw new Error("Durable agents need a saved Pi session.");
      return undefined;
    }
    const target = durableAgentsFile(agentDir, sessionId);
    if (file !== target) {
      sent.clear();
      deferred.clear();
      reportTurnPending = false;
    }
    file = target;
    const slots = runtimeSlots();
    let slot = slots.get(target);
    if (slot === undefined) {
      if (!create && !fs.existsSync(target)) return undefined;
      const models = nextCtx.modelRegistry ? Reflect.get(nextCtx.modelRegistry, "runtime") : undefined;
      if (models === undefined) throw new Error("Durable agents need Pi 1.0 or newer; this session exposes no model runtime.");
      const opened = {} as RuntimeSlot;
      const cwd = nextCtx.cwd;
      // Loaded on first use, so Pi Durable and node:sqlite cost nothing until a session uses durable agents.
      opened.runtime = Promise.all([import("../../src/durable/agent-runtime.js"), import("@earendil-works/pi-durable")])
        .then(([{ DurableAgentRuntime }, durable]) => DurableAgentRuntime.open({
          file: target,
          models,
          extensions: [projectContextExtension(durable, loadContext, cwd, (error) => opened.warn?.(error))],
          deliver: (report) => opened.deliver?.(report) ?? false,
          onError: (error) => opened.warn?.(error),
        }));
      opened.runtime.catch(() => {
        if (slots.get(target) === opened) slots.delete(target);
      });
      slots.set(target, opened);
      slot = opened;
    }
    if (slot.release !== undefined) clearTimeout(slot.release);
    slot.release = undefined;
    slot.deliver = deliver;
    slot.warn = warn;
    const runtime = await slot.runtime;
    void runtime.deliverReports();
    return runtime;
  }

  async function close(target: string): Promise<void> {
    const slots = runtimeSlots();
    const slot = slots.get(target);
    if (slot === undefined) return;
    slots.delete(target);
    if (slot.release !== undefined) clearTimeout(slot.release);
    const runtime = await slot.runtime.catch(() => undefined);
    await runtime?.close();
  }

  async function detach(reason: unknown): Promise<void> {
    const target = file;
    ctx = undefined;
    file = undefined;
    sent.clear();
    deferred.clear();
    reportTurnPending = false;
    clearTimeout(deliveryRetry);
    deliveryRetry = undefined;
    if (target === undefined) return;
    const slot = runtimeSlots().get(target);
    if (slot === undefined) return;
    slot.deliver = undefined;
    slot.warn = undefined;
    if (reason !== "reload") return close(target);
    // The reloaded module reattaches within this window; otherwise the runtime closes and resumes on the next open.
    slot.release = setTimeout(() => void close(target), RELOAD_HOLD_MS);
    slot.release.unref?.();
  }

  pi.on("session_start", async (_event: unknown, nextCtx: any) => {
    try {
      await attach(nextCtx, false);
    } catch (error) {
      warn(error);
    }
  });

  pi.on("session_shutdown", async (event: any) => {
    await detach(event?.reason);
  });

  async function deliverPending(): Promise<void> {
    const slot = file === undefined ? undefined : runtimeSlots().get(file);
    void (await slot?.runtime.catch(() => undefined))?.deliverReports();
  }

  // A report whose turn started is in the history once that turn settles, unless Pi dropped it. A deferred report can
  // still wait behind another deferred prompt, so only its arrival clears it; if it never arrives, the next open sends it.
  pi.on("agent_settled", async (_event: unknown, nextCtx: any) => {
    if (file === undefined) return;
    ctx = nextCtx ?? ctx;
    reportTurnPending = false;
    for (const id of [...sent]) {
      if (reportInHistory(ctx, id)) {
        sent.delete(id);
        deferred.delete(id);
      } else if (!deferred.has(id)) sent.delete(id);
    }
    await deliverPending();
  });

  pi.on("session_compact", async (_event: unknown, nextCtx: any) => {
    if (file === undefined) return;
    ctx = nextCtx ?? ctx;
    retryDelivery();
  });

  pi.registerTool({
    name: "durable_agents",
    label: "Durable Agents",
    description,
    parameters,
    async execute(toolCallId: string, params: any, _signal: AbortSignal, _onUpdate: unknown, toolCtx: any) {
      const runtime = (await attach(toolCtx, true))!;
      switch (params.action) {
        case "spawn": {
          const name = required(params.name, "spawn needs a name.");
          const prompt = required(params.prompt, "spawn needs a prompt.");
          const cwd = params.cwd ?? toolCtx.cwd;
          const level = resolveLevel(params.model_slot, cwd, toolCtx, pi);
          const spawned = await runtime.spawn({
            name,
            role: level.role,
            prompt,
            cwd,
            model: level.model,
            ...(level.thinking === undefined ? {} : { thinkingLevel: level.thinking }),
            instructions: roleInstructions(name, level.role),
            requestId: `spawn:${toolCallId}`,
          });
          const model = `${level.model.provider}/${level.model.modelId}`;
          return textResult(
            `Started durable agent ${spawned.name} (${level.slot}, ${model}). Its report arrives automatically, also after a Pi restart.`,
            { name: spawned.name, modelSlot: level.slot, model, thinking: level.thinking ?? null },
          );
        }
        case "send": {
          const name = required(params.name, "send needs a name.");
          const message = required(params.message, "send needs a message.");
          await runtime.send(name, message, { steer: params.steer === true, requestId: `send:${toolCallId}` });
          return textResult(params.steer === true ? `Steered ${name}.` : `Sent to ${name}.`, { name });
        }
        case "interrupt": {
          const name = required(params.name, "interrupt needs a name.");
          const tools = await runtime.interrupt(name);
          return textResult(tools.length > 0 ? `Interrupted ${name}: ${tools.join(", ")}.` : `${name} had no running tool call.`, { name, tools });
        }
        case "stop": {
          const name = required(params.name, "stop needs a name.");
          await runtime.stop(name);
          return textResult(`Stopped ${name}.`, { name });
        }
        case "status": {
          const statuses = await runtime.status();
          return textResult(formatStatus(statuses), { agents: statuses });
        }
        default:
          throw new Error(`Unknown action ${String(params.action)}.`);
      }
    },
  });
}
