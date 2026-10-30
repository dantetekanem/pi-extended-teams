import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  type ConversationId,
  createRegistry,
  defineDoc,
  defineExtension,
  type EntryId,
  type Extension,
  Harness,
  type HarnessSettings,
  InboxDoc,
  LiveDoc,
  type ModelRef,
  type SettledSubmissionRecord,
  type Submission,
  type SubmissionId,
  type TaskId,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { sanitizeName } from "../utils/paths";
import { acquireOwnerLock, type OwnerLock } from "./owner-lock";

const context = BACKGROUND_CONTEXT;
const PLACE_QUEUED_ENTRY = "pi-extended-teams.place-queued";

export type DurableAgentRole = "read" | "write";

export interface DurableAgentSpec {
  name: string;
  role: DurableAgentRole;
  /** The first message the agent works on. */
  prompt: string;
  cwd: string;
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  instructions?: string;
  /** A retried spawn with the same ID returns the agent the first attempt created. */
  requestId?: string;
}

export interface DurableAgentSendOptions {
  /** Join the agent's current work instead of queueing after its current answer. */
  steer?: boolean;
  /** A retried send with the same ID is admitted once. */
  requestId?: string;
}

export interface DurableAgentStatus {
  name: string;
  role: DurableAgentRole;
  state: "working" | "queued" | "idle" | "stopping" | "stopped";
  conversationId: number;
  /** Messages whose answer has not been decided yet. */
  openMessages: number;
  runningTools: string[];
  costUsd: number;
}

export interface DurableAgentReport {
  /** The request ID of the message the report answers. */
  id: string;
  agent: string;
  outcome: "answered" | "failed";
  text: string;
  createdAt: number;
}

export interface DurableAgentRuntimeOptions {
  /** SQLite file holding every agent of one team. One process owns it at a time. */
  file: string;
  models: Models;
  settings?: HarnessSettings;
  /** Selected by every agent, after the built-in tools: prompt sections, extra tools, or hooks. */
  extensions?: readonly Extension[];
  /**
   * Receives each decided report, oldest first, and the backlog on open. Return true once the lead has the report;
   * false or a throw keeps it pending for the next `deliverReports()`. A crash before acknowledgement delivers it again.
   */
  deliver?: DeliverReport;
  onError?: (error: unknown) => void;
}

export type DeliverReport = (report: DurableAgentReport) => boolean | Promise<boolean>;

/** The runtime recorded the message, but handing it to the agent failed. The next spawn, send, or open retries it. */
export class AdmissionDeferredError extends Error {
  constructor(agent: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${agent} has the message, but handing it over failed: ${reason}. The next spawn or send, or the next open, retries it, so do not send it again.`, { cause });
    this.name = "AdmissionDeferredError";
  }
}

type AgentRecord = {
  conversationId: number;
  role: DurableAgentRole;
  spawnedAt: number;
  stoppedAt?: number;
  /** A steer joins the running work, so two messages can end in one answer; it is reported once. */
  reportedAnswers: number[];
};

type MessageRecord = {
  agent: string;
  seq: number;
  steer: boolean;
  /** Dropped once the agent's conversation admits the message. */
  content?: string;
  submissionId?: number;
  settled?: boolean;
};

type ReportRecord = {
  agent: string;
  outcome: "answered" | "failed";
  text: string;
  createdAt: number;
  deliveredAt?: number;
};

type TeamState = {
  seq: number;
  agents: Record<string, AgentRecord>;
  /** Spawn request ID to agent name. */
  spawns: Record<string, string>;
  /** Keyed by request ID, which is also the request ID of the agent conversation's submission. */
  messages: Record<string, MessageRecord>;
  /** Keyed by the request ID of the message the report answers. */
  reports: Record<string, ReportRecord>;
};

const TeamDoc = defineDoc<TeamState>({
  kind: "pi-extended-teams.team",
  version: 1,
  scope: "session",
  initial: () => ({ seq: 0, agents: {}, spawns: {}, messages: {}, reports: {} }),
});

const readTool = createReadTool();
const bashTool = createBashTool();
const editTool = createEditTool();
const writeTool = createWriteTool();

const AgentTools = defineExtension({
  name: "pi-extended-teams.agent-tools",
  tools: [readTool, bashTool, editTool, writeTool],
});

function answerText(message: AssistantMessage | undefined): string {
  const text = (message?.content ?? [])
    .flatMap((content) => (content.type === "text" ? [content.text] : []))
    .join("")
    .trim();
  return text.length > 0 ? text : "(The agent answered without text.)";
}

function totalCost(usage: { models: Record<string, unknown>; tools: Record<string, unknown> } | undefined): number {
  let total = 0;
  for (const bucket of [usage?.models ?? {}, usage?.tools ?? {}]) {
    for (const value of Object.values(bucket)) {
      const cost = (value as { cost?: { total?: unknown } }).cost?.total;
      if (typeof cost === "number") total += cost;
    }
  }
  return total;
}

/**
 * Team agents as Pi Durable conversations in one SQLite file. Turns, tool calls, queued messages, and decided reports
 * are committed before anything is shown, so a process that dies mid-turn continues on the next `open()`.
 *
 * Messages to an agent are admitted in call order through one serial line, and every message records its intent before
 * admission, so `open()` can admit what a crash left behind. Reports are delivered at least once, through `deliver`.
 */
export class DurableAgentRuntime {
  readonly #harness: Harness;
  readonly #lock: OwnerLock;
  readonly #envs: Map<string, NodeExecutionEnv>;
  readonly #onError: (error: unknown) => void;
  readonly #deliver: DeliverReport | undefined;
  /** Request IDs whose submission this process already waits for. */
  readonly #watched = new Set<string>();
  #line: Promise<unknown> = Promise.resolve();
  #delivery: Promise<void> | undefined;
  #deliveryRequested = false;
  #closing: Promise<void> | undefined;

  static async open(options: DurableAgentRuntimeOptions): Promise<DurableAgentRuntime> {
    const lock = acquireOwnerLock(`${options.file}.owner`);
    const envs = new Map<string, NodeExecutionEnv>();
    const onError = options.onError ?? (() => {});
    let runtime: DurableAgentRuntime | undefined;
    try {
      const registry = createRegistry();
      registry.install(AgentTools);
      for (const extension of options.extensions ?? []) registry.install(extension);
      const harness = await Harness.open(
        await openNodeSqliteStorage(options.file),
        {
          models: options.models,
          registry,
          ...(options.settings === undefined ? {} : { settings: options.settings }),
          env: ({ cwd }) => {
            if (cwd === undefined) return undefined;
            let env = envs.get(cwd);
            if (env === undefined) {
              env = new NodeExecutionEnv({ cwd });
              envs.set(cwd, env);
            }
            return env;
          },
          onReport: onError,
        },
        context,
      );
      runtime = new DurableAgentRuntime(harness, lock, envs, onError, options.deliver);
      await runtime.#recover();
      return runtime;
    } catch (error) {
      if (runtime === undefined) lock.release();
      else await runtime.close().catch(onError);
      throw error;
    }
  }

  private constructor(
    harness: Harness,
    lock: OwnerLock,
    envs: Map<string, NodeExecutionEnv>,
    onError: (error: unknown) => void,
    deliver: DeliverReport | undefined,
  ) {
    this.#harness = harness;
    this.#lock = lock;
    this.#envs = envs;
    this.#onError = onError;
    this.#deliver = deliver;
  }

  async spawn(spec: DurableAgentSpec): Promise<{ name: string; conversationId: number; created: boolean }> {
    const name = sanitizeName(spec.name);
    const requestId = spec.requestId ?? `spawn:${randomUUID()}`;
    const spawned = await this.#harness.commit(async (tx) => {
      const team = await tx.doc(TeamDoc);
      const existing = team.spawns[requestId];
      if (existing !== undefined) {
        return { name: existing, conversationId: team.agents[existing]!.conversationId, created: false };
      }
      if (Object.hasOwn(team.messages, requestId)) throw new Error(`Request ${requestId} already identifies a message.`);
      if (Object.hasOwn(team.agents, name)) throw new Error(`An agent named ${name} already exists.`);
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, conversation.id, {
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.thinkingLevel === undefined ? {} : { thinkingLevel: spec.thinkingLevel }),
        ...(spec.role === "read" ? { tools: { remove: [editTool, writeTool] } } : {}),
        ...(spec.instructions === undefined ? {} : { instructions: spec.instructions }),
        cwd: spec.cwd,
      });
      team.agents[name] = { conversationId: conversation.id, role: spec.role, spawnedAt: Date.now(), reportedAnswers: [] };
      team.spawns[requestId] = name;
      team.seq += 1;
      team.messages[requestId] = { agent: name, seq: team.seq, steer: false, content: spec.prompt };
      return { name, conversationId: conversation.id as number, created: true };
    }, context);
    await this.#admitPending(spawned.name);
    return spawned;
  }

  async send(name: string, message: string, options: DurableAgentSendOptions = {}): Promise<void> {
    const requestId = options.requestId ?? `send:${randomUUID()}`;
    await this.#harness.commit(async (tx) => {
      const team = await tx.doc(TeamDoc);
      if (Object.hasOwn(team.messages, requestId)) return;
      const agent = team.agents[name];
      if (agent === undefined) throw new Error(`No agent named ${name}.`);
      if (agent.stoppedAt !== undefined) throw new Error(`${name} was stopped.`);
      team.seq += 1;
      team.messages[requestId] = { agent: name, seq: team.seq, steer: options.steer === true, content: message };
    }, context);
    await this.#admitPending(name);
  }

  /**
   * Abort the agent's running tool calls. Each call gets an aborted result and the agent continues its turn, as the
   * current in-process runtime does.
   */
  async interrupt(name: string): Promise<string[]> {
    const agent = await this.#agent(name);
    const live = await this.#harness.snapshot(LiveDoc, agent.conversationId as ConversationId, context);
    const running = (live?.tools ?? []).filter((slot) => slot.status === "running" && slot.taskId !== undefined);
    for (const slot of running) await this.#harness.abortTask(slot.taskId as TaskId, context);
    return running.map((slot) => slot.name);
  }

  /** Abort the agent's work, withdraw its queued messages, and refuse new ones. Aborted messages are not reported. */
  stop(name: string): Promise<void> {
    return this.#serial(async () => {
      const agent = await this.#agent(name);
      await this.#harness.commit(async (tx) => {
        const record = (await tx.doc(TeamDoc)).agents[name];
        if (record !== undefined && record.stoppedAt === undefined) record.stoppedAt = Date.now();
      }, context);
      const conversation = await this.#harness.conversation(agent.conversationId as ConversationId, context);
      // Background work such as a threshold compaction would keep spending on an agent nobody will use.
      await conversation?.abort(context, { background: true });
    });
  }

  async status(): Promise<DurableAgentStatus[]> {
    const team = await this.#team();
    const statuses: DurableAgentStatus[] = [];
    for (const [name, agent] of Object.entries(team.agents)) {
      const id = agent.conversationId as ConversationId;
      const live = await this.#harness.snapshot(LiveDoc, id, context);
      const inbox = await this.#harness.snapshot(InboxDoc, id, context);
      const usage = await this.#harness.snapshot(UsageDoc, id, context);
      const openMessages = Object.values(team.messages).filter((message) => message.agent === name && !message.settled);
      const state = agent.stoppedAt !== undefined
        ? live?.run !== undefined ? "stopping" : "stopped"
        : live?.run !== undefined
          ? "working"
          : (inbox?.items.length ?? 0) > 0 || openMessages.length > 0
            ? "queued"
            : "idle";
      statuses.push({
        name,
        role: agent.role,
        state,
        conversationId: agent.conversationId,
        openMessages: openMessages.length,
        runningTools: (live?.tools ?? []).filter((slot) => slot.status === "running").map((slot) => slot.name),
        costUsd: totalCost(usage),
      });
    }
    return statuses;
  }

  /** Reports not acknowledged yet, oldest first. */
  async pendingReports(): Promise<DurableAgentReport[]> {
    const team = await this.#team();
    return Object.entries(team.reports)
      .filter(([, report]) => report.deliveredAt === undefined)
      .map(([id, report]) => ({ id, agent: report.agent, outcome: report.outcome, text: report.text, createdAt: report.createdAt }))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  /** Deliver pending reports now, for example after `deliver` failed earlier. Resolves when this pass ends. */
  deliverReports(): Promise<void> {
    const deliver = this.#deliver;
    if (deliver === undefined || this.#closing !== undefined) return Promise.resolve();
    this.#deliveryRequested = true;
    this.#delivery ??= this.#deliverPending(deliver);
    return this.#delivery;
  }

  /** Close without writing outcomes: unfinished work continues on the next `open()` of the same file. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      try {
        await this.#harness.close(context);
      } finally {
        for (const env of this.#envs.values()) await env.cleanup(context).catch(this.#onError);
        this.#envs.clear();
        this.#lock.release();
      }
    })();
    return this.#closing;
  }

  async #recover(): Promise<void> {
    // Read before scheduling starts, so a document this version cannot use fails open before any agent work runs.
    const team = await this.#team();
    await this.#finishStops(team);
    this.#harness.resume();
    this.#admitPending().catch((error) => this.#report(error));
    for (const agent of Object.values(team.agents)) {
      if (agent.stoppedAt === undefined) this.#placeQueued(agent.conversationId);
    }
    void this.deliverReports();
  }

  /**
   * A crash between stop()'s commit and its abort leaves the stopped agent's work pending. Abort marks and withdrawals
   * do not start the scheduler, so that work reaches its abort handlers instead of running again.
   */
  async #finishStops(team: Readonly<TeamState>): Promise<void> {
    const stopped = new Set<number>();
    for (const agent of Object.values(team.agents)) if (agent.stoppedAt !== undefined) stopped.add(agent.conversationId);
    if (stopped.size === 0) return;
    const { tasks, submissions } = await this.#harness.inspect(context);
    for (const { record } of tasks) {
      if (stopped.has(record.conversationId)) await this.#harness.abortTask(record.id, context);
    }
    for (const submission of submissions) {
      if (stopped.has(submission.conversationId) && submission.type === "input" && submission.status === "queued") {
        await this.#harness.abortSubmission(submission.id, context, submission.conversationId);
      }
    }
  }

  /** Pi Durable keeps the queue of a failed run until the next submission, so a passive write places it. */
  #placeQueued(conversationId: number): void {
    this.#serial(async () => {
      const id = conversationId as ConversationId;
      const live = await this.#harness.snapshot(LiveDoc, id, context);
      const first = (await this.#harness.snapshot(InboxDoc, id, context))?.items[0];
      if (live?.run !== undefined || first === undefined) return;
      const conversation = await this.#harness.conversation(id, context);
      await conversation?.submit({ type: "write", entry: { kind: PLACE_QUEUED_ENTRY }, requestId: `${PLACE_QUEUED_ENTRY}:${first.id}` }, context);
    }).catch((error) => this.#report(error));
  }

  #report(error: unknown): void {
    if (this.#closing === undefined) this.#onError(error);
  }

  async #deliverPending(deliver: DeliverReport): Promise<void> {
    try {
      do {
        this.#deliveryRequested = false;
        for (const report of await this.pendingReports()) {
          if (this.#closing !== undefined) return;
          if (await deliver(report)) await this.#acknowledge(report.id);
        }
      } while (this.#deliveryRequested && this.#closing === undefined);
    } catch (error) {
      this.#report(error);
    } finally {
      // Cleared with no await after the last check, so a request that arrives later starts a new pass.
      this.#delivery = undefined;
    }
  }

  async #acknowledge(reportId: string): Promise<void> {
    await this.#harness.commit(async (tx) => {
      const report = (await tx.doc(TeamDoc)).reports[reportId];
      if (report !== undefined && report.deliveredAt === undefined) report.deliveredAt = Date.now();
    }, context);
  }

  async #team(): Promise<Readonly<TeamState>> {
    return (await this.#harness.snapshot(TeamDoc, context)) ?? TeamDoc.definition.initial();
  }

  async #agent(name: string): Promise<Readonly<AgentRecord>> {
    const agent = (await this.#team()).agents[name];
    if (agent === undefined) throw new Error(`No agent named ${name}.`);
    return agent;
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#line.then(operation);
    this.#line = result.catch(() => {});
    return result;
  }

  /**
   * Admit every recorded message in call order, and watch the ones admitted before this process opened. When admitting
   * one fails, the same agent's later messages wait so none overtakes it; the next spawn, send, or open retries them.
   * Rejects only when `target`'s own message could not be admitted.
   */
  #admitPending(target?: string): Promise<void> {
    return this.#serial(async () => {
      const team = await this.#team();
      const failures = new Map<string, unknown>();
      const open = Object.entries(team.messages)
        .filter(([, message]) => !message.settled)
        .sort(([, left], [, right]) => left.seq - right.seq);
      for (const [requestId, message] of open) {
        if (failures.has(message.agent)) continue;
        const agent = team.agents[message.agent];
        try {
          if (agent === undefined || agent.stoppedAt !== undefined) await this.#settle(requestId, undefined);
          else if (message.submissionId === undefined) await this.#submit(requestId, message, agent);
          else if (!this.#watched.has(requestId)) {
            const submission = await this.#harness.submission(message.submissionId as SubmissionId, context);
            if (submission === undefined) throw new Error(`The submission of ${requestId} is missing.`);
            this.#watch(requestId, submission);
          }
        } catch (error) {
          failures.set(message.agent, error);
        }
      }
      for (const [agent, error] of failures) if (agent !== target) this.#report(error);
      if (target !== undefined && failures.has(target)) throw new AdmissionDeferredError(target, failures.get(target));
    });
  }

  async #submit(requestId: string, message: Readonly<MessageRecord>, agent: Readonly<AgentRecord>): Promise<void> {
    const conversation = await this.#harness.conversation(agent.conversationId as ConversationId, context);
    if (conversation === undefined) throw new Error(`The conversation of ${message.agent} is missing.`);
    // The request ID makes a retry after a failed or interrupted attempt return the first submission.
    const submission = await conversation.submit({
      type: "input",
      content: message.content ?? "",
      whenBusy: message.steer ? "steer" : "followUp",
      requestId,
    }, context);
    await this.#harness.commit(async (tx) => {
      const current = (await tx.doc(TeamDoc)).messages[requestId];
      if (current === undefined) return;
      current.submissionId = submission.id as number;
      delete current.content;
    }, context);
    this.#watch(requestId, submission);
  }

  #watch(requestId: string, submission: Submission): void {
    if (this.#watched.has(requestId)) return;
    this.#watched.add(requestId);
    submission.wait(context).then(
      (settled) => this.#settle(requestId, settled),
      (error) => {
        this.#watched.delete(requestId);
        this.#report(error);
      },
    );
  }

  /** Decide the report of a settled message in one commit, so a restart never decides twice. */
  async #settle(requestId: string, settled: SettledSubmissionRecord | undefined): Promise<void> {
    const decided = await this.#harness.commit(async (tx) => {
      const team = await tx.doc(TeamDoc);
      const message = team.messages[requestId];
      if (message === undefined || message.settled) return undefined;
      const agent = team.agents[message.agent];
      const settledIds = [requestId];
      let report: ReportRecord | undefined;
      if (agent !== undefined && settled?.status === "done" && settled.type === "input") {
        if (!agent.reportedAnswers.includes(settled.answer)) {
          const entry = await tx.entry(AssistantEntry, settled.answer as EntryId);
          agent.reportedAnswers.push(settled.answer);
          report = {
            agent: message.agent,
            outcome: "answered",
            text: answerText(entry?.model?.[0] as AssistantMessage | undefined),
            createdAt: Date.now(),
          };
        }
      } else if (agent !== undefined && settled?.status === "unanswered" && settled.reason !== "aborted") {
        // Every input of a failed run settles the same way. Report the run once, as an answered run is.
        for (const [id, other] of Object.entries(team.messages)) {
          if (id === requestId || other.agent !== message.agent || other.settled || other.submissionId === undefined) continue;
          const record = await tx.submissionByRequest(agent.conversationId as ConversationId, id);
          if (record?.status === "unanswered" && record.reason === settled.reason
            && JSON.stringify(record.detail) === JSON.stringify(settled.detail)) settledIds.push(id);
        }
        const detail = settled.detail === undefined ? "" : ` ${JSON.stringify(settled.detail)}`;
        report = {
          agent: message.agent,
          outcome: "failed",
          text: `The agent stopped without an answer: ${settled.reason}${detail}`,
          createdAt: Date.now(),
        };
      }
      for (const id of settledIds) {
        const each = team.messages[id]!;
        each.settled = true;
        delete each.content;
      }
      if (report !== undefined) team.reports[requestId] = report;
      const placeQueue = report?.outcome === "failed" && agent?.stoppedAt === undefined;
      return { reported: report !== undefined, placeQueue, conversationId: agent?.conversationId };
    }, context).catch((error) => {
      // The next admission pass watches the message again and retries this decision.
      this.#watched.delete(requestId);
      this.#report(error);
      return undefined;
    });
    if (decided?.reported) void this.deliverReports();
    if (decided?.placeQueue && decided.conversationId !== undefined) this.#placeQueued(decided.conversationId);
  }
}
