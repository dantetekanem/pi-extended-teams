import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { DurableAgentRuntime } from "../../src/durable/agent-runtime";
import { DURABLE_REPORT_MESSAGE_TYPE, durableAgentsFile, registerDurableAgents } from "./durable-agents";

const SLOTS = Symbol.for("pi-extended-teams.durable-agent-runtimes.v1");
const directories: string[] = [];
let previousHome: string | undefined;

beforeAll(() => {
  // Favorite tiers come from ~/.pi/agent; an empty home makes every tier inherit the lead's faux model.
  previousHome = process.env.HOME;
  process.env.HOME = tempDirectory();
});

afterAll(() => {
  process.env.HOME = previousHome;
});

afterEach(async () => {
  const slots = (globalThis as any)[SLOTS] as Map<string, { runtime: Promise<{ close(): Promise<void> }>; release?: ReturnType<typeof setTimeout> }> | undefined;
  for (const [file, slot] of slots ?? []) {
    clearTimeout(slot.release);
    slots!.delete(file);
    await (await slot.runtime.catch(() => undefined))?.close();
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "durable-agents-tool-"));
  directories.push(directory);
  return directory;
}

/** Pi Durable sends prompt sections as system messages at the position where they changed. */
function systemPrompt(messages: readonly Message[]): string {
  return messages
    .flatMap((message) => (message.role === "system" ? Object.values((message as { sections?: Record<string, string> }).sections ?? {}) : []))
    .join("\n");
}

/** A faux model whose answers wait for `release()`, so a test can stop Pi mid-request. */
function heldModel(answerFor: (messages: readonly Message[]) => string) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: Array<readonly Message[]> = [];
  const step: FauxResponseStep = async (context, options): Promise<AssistantMessage> => {
    requests.push(context.messages);
    await new Promise<void>((resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      void released.then(resolve);
    });
    return fauxAssistantMessage([fauxText(answerFor(context.messages))]);
  };
  faux.setResponses(Array.from({ length: 10 }, () => step));
  return { models, requests, release: () => release() };
}

interface Delivery {
  message: { customType: string; content: string; display: boolean; details: { reportId: string; agent: string; outcome: string } };
  options: unknown;
}

function fakePi(onSend?: (message: Delivery["message"]) => void) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, any>();
  const sent: Delivery[] = [];
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    sendMessage(message: Delivery["message"], options: unknown) {
      sent.push({ message, options });
      onSend?.(message);
    },
  };
  return {
    pi,
    tools,
    sent,
    handlerNames: () => [...handlers.keys()],
    async emit(name: string, event: unknown, ctx?: unknown) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

type Host = ReturnType<typeof fakePi>;

/**
 * Models Pi's AgentSession around a lead turn: a send during a run waits in a queue that Esc can clear, a send during
 * the agent_settled emission runs after the emission in order, and any other send starts a turn at once.
 */
function deferringPi(sessionId: string, models: unknown, cwd: string) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, any>();
  const entries: any[] = [];
  const lead = { running: false, emitting: false };
  const deferred: Array<() => Promise<void>> = [];
  const ctx = {
    cwd,
    model: { provider: "faux", id: "faux-1" },
    thinkingLevel: "off",
    modelRegistry: { runtime: models },
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries.slice() },
    isIdle: () => !lead.running,
    ui: { notify: vi.fn() },
  };
  async function emitSettled(): Promise<void> {
    lead.running = false;
    lead.emitting = true;
    try {
      for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
    } finally {
      lead.emitting = false;
    }
    for (const action of deferred.splice(0)) await action();
  }
  async function runTurn(message: Delivery["message"]): Promise<void> {
    lead.running = true;
    try {
      entries.push({ type: "custom_message", customType: message.customType, details: message.details });
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      await emitSettled();
    }
  }
  const pi = {
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    sendMessage(message: Delivery["message"]) {
      if (lead.running) return;
      if (lead.emitting) deferred.push(() => runTurn(message));
      else void runTurn(message);
    },
  };
  return {
    pi,
    tools,
    ctx,
    entries,
    lead,
    emitSettled,
    async emit(name: string, event: unknown) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

function fakeSession(sessionId: string, models: unknown, cwd: string) {
  const entries: any[] = [];
  const lead = { idle: true };
  return {
    entries,
    lead,
    ctx: {
      cwd,
      model: { provider: "faux", id: "faux-1" },
      thinkingLevel: "off",
      modelRegistry: { runtime: models },
      sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
      isIdle: () => lead.idle,
      ui: { notify: vi.fn() },
    },
  };
}

/** What Pi does once a sent report reaches the session: append it as a custom message entry. */
function showInHistory(session: ReturnType<typeof fakeSession>, delivery: Delivery): void {
  session.entries.push({ type: "custom_message", customType: delivery.message.customType, details: delivery.message.details });
}

function register(agentDir: string, onSend?: (message: Delivery["message"]) => void) {
  const host = fakePi(onSend);
  registerDurableAgents(host.pi, {
    enabled: true,
    agentDir,
    loadContext: async (cwd) => ({ contextFiles: [{ path: path.join(cwd, "AGENTS.md"), content: "Cite every claim." }], skills: "" }),
  });
  return host;
}

async function runtimeOf(agentDir: string, sessionId: string): Promise<DurableAgentRuntime> {
  const slots = (globalThis as any)[SLOTS] as Map<string, { runtime: Promise<DurableAgentRuntime> }> | undefined;
  const slot = slots?.get(durableAgentsFile(agentDir, sessionId));
  if (slot === undefined) throw new Error(`No durable runtime is open for ${sessionId}.`);
  return slot.runtime;
}

async function spawnAgent(host: { tools: Map<string, any> }, ctx: unknown, name = "reader", toolCallId = "call-1") {
  return host.tools.get("durable_agents").execute(toolCallId, { action: "spawn", name, prompt: "Check the parser.", model_slot: "read-review" }, undefined, undefined, ctx);
}

async function statusText(host: Host, ctx: unknown): Promise<string> {
  return (await host.tools.get("durable_agents").execute("status-call", { action: "status" }, undefined, undefined, ctx)).content[0].text;
}

describe("durable_agents tool", () => {
  it("registers nothing unless the experimental setting is on", () => {
    const host = fakePi();
    registerDurableAgents(host.pi, { enabled: false });
    expect(host.tools.size).toBe(0);
    expect(host.handlerNames()).toEqual([]);
  });

  it("keeps the database outside the team folders that startup cleanup removes", () => {
    expect(durableAgentsFile("/home/leo/.pi/agent", "01a0f993-b240")).toBe(
      "/home/leo/.pi/agent/pi-extended-teams/durable-agents/01a0f993-b240/agents.sqlite",
    );
  });

  it("delivers a report once and acknowledges it after the session shows it", async () => {
    const agentDir = tempDirectory();
    const model = heldModel(() => "The parser is fine.");
    const session = fakeSession("session-a", model.models, tempDirectory());
    const host = register(agentDir);
    await host.emit("session_start", { reason: "startup" }, session.ctx);
    expect(fs.existsSync(durableAgentsFile(agentDir, "session-a"))).toBe(false);

    const result = await spawnAgent(host, session.ctx);
    expect(result.content[0].text).toBe("Started durable agent reader (read-review, faux/faux-1). Its report arrives automatically, also after a Pi restart.");
    model.release();

    await vi.waitFor(() => expect(host.sent).toHaveLength(1));
    const system = systemPrompt(model.requests[0]!);
    expect(system).toContain("Cite every claim.");
    expect(system).toContain("You are durable agent 'reader'");
    expect(system).toContain("You are read-only.");
    expect(host.sent[0]).toEqual({
      message: {
        customType: DURABLE_REPORT_MESSAGE_TYPE,
        content: "Durable agent reader reported:\n\nThe parser is fine.",
        display: true,
        details: { reportId: "spawn:call-1", agent: "reader", outcome: "answered" },
      },
      options: { triggerTurn: true },
    });
    const runtime = await runtimeOf(agentDir, "session-a");
    expect(await runtime.pendingReports()).toHaveLength(1);

    showInHistory(session, host.sent[0]!);
    await host.emit("agent_settled", {}, session.ctx);
    await vi.waitFor(async () => expect(await runtime.pendingReports()).toEqual([]));
    await host.emit("session_shutdown", { reason: "quit" });

    const restarted = register(agentDir);
    await restarted.emit("session_start", { reason: "resume" }, session.ctx);
    await restarted.emit("agent_settled", {}, session.ctx);
    expect(await statusText(restarted, session.ctx)).toBe("reader (read): idle, $0.0000");
    expect(host.sent).toHaveLength(1);
    expect(restarted.sent).toEqual([]);
  });

  it("waits until the lead is idle before sending a report", async () => {
    const agentDir = tempDirectory();
    const model = heldModel(() => "The parser is fine.");
    const session = fakeSession("session-busy", model.models, tempDirectory());
    const host = register(agentDir);
    await host.emit("session_start", { reason: "startup" }, session.ctx);
    await spawnAgent(host, session.ctx);
    session.lead.idle = false;
    model.release();

    const runtime = await runtimeOf(agentDir, "session-busy");
    await vi.waitFor(async () => expect(await runtime.pendingReports()).toHaveLength(1));
    await runtime.deliverReports();
    expect(host.sent).toEqual([]);

    session.lead.idle = true;
    await host.emit("agent_settled", {}, session.ctx);
    await vi.waitFor(() => expect(host.sent).toHaveLength(1));
    expect(host.sent[0]!.message.details.reportId).toBe("spawn:call-1");
  });

  it("sends one report per lead turn", async () => {
    const agentDir = tempDirectory();
    const model = heldModel(() => "Done.");
    const session = fakeSession("session-turns", model.models, tempDirectory());
    const host = register(agentDir);
    await host.emit("session_start", { reason: "startup" }, session.ctx);
    await spawnAgent(host, session.ctx, "reader", "call-1");
    await spawnAgent(host, session.ctx, "checker", "call-2");
    model.release();

    const runtime = await runtimeOf(agentDir, "session-turns");
    await vi.waitFor(async () => expect(await runtime.pendingReports()).toHaveLength(2));
    await runtime.deliverReports();
    expect(host.sent).toHaveLength(1);

    showInHistory(session, host.sent[0]!);
    await host.emit("agent_settled", {}, session.ctx);
    await vi.waitFor(() => expect(host.sent).toHaveLength(2));
    expect(new Set(host.sent.map((delivery) => delivery.message.details.agent))).toEqual(new Set(["reader", "checker"]));
  });

  it("sends a report again when Pi dropped it before the session showed it", async () => {
    const agentDir = tempDirectory();
    const model = heldModel(() => "The parser is fine.");
    const session = fakeSession("session-dropped", model.models, tempDirectory());
    // As in Pi, a report sent to an idle lead starts a turn at once.
    const host = register(agentDir, () => {
      session.lead.idle = false;
    });
    await host.emit("session_start", { reason: "startup" }, session.ctx);
    await spawnAgent(host, session.ctx);
    model.release();
    await vi.waitFor(() => expect(host.sent).toHaveLength(1));

    // The turn settled, and the report never reached the history.
    session.lead.idle = true;
    await host.emit("agent_settled", {}, session.ctx);
    await vi.waitFor(() => expect(host.sent).toHaveLength(2));
    expect(host.sent[1]!.message.details).toEqual(host.sent[0]!.message.details);

    showInHistory(session, host.sent[1]!);
    session.lead.idle = true;
    await host.emit("agent_settled", {}, session.ctx);
    const runtime = await runtimeOf(agentDir, "session-dropped");
    await vi.waitFor(async () => expect(await runtime.pendingReports()).toEqual([]));
    expect(host.sent).toHaveLength(2);
  });

  it("sends a report once when Pi defers it behind another prompt", async () => {
    const agentDir = tempDirectory();
    const model = heldModel(() => "The parser is fine.");
    const host = deferringPi("session-deferred", model.models, tempDirectory());
    let teamReportSent = false;
    // Registered first: another report goes out during the same settle and is deferred ahead of this one.
    host.pi.on("agent_settled", () => {
      if (teamReportSent) return;
      teamReportSent = true;
      host.pi.sendMessage({ customType: "pi-extended-teams-report", content: "team", display: false, details: { reportId: "team", agent: "team", outcome: "answered" } });
    });
    registerDurableAgents(host.pi, { enabled: true, agentDir, loadContext: async () => ({ contextFiles: [], skills: "" }) });
    // Another extension's slower handler runs after this one.
    host.pi.on("agent_settled", () => new Promise((resolve) => setTimeout(resolve, 30)));
    await host.emit("session_start", { reason: "startup" });
    host.lead.running = true;
    await spawnAgent(host, host.ctx);
    model.release();
    const runtime = await runtimeOf(agentDir, "session-deferred");
    await vi.waitFor(async () => expect(await runtime.pendingReports()).toHaveLength(1));

    await host.emitSettled();

    await vi.waitFor(async () => expect(await runtime.pendingReports()).toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.entries.map((entry) => entry.customType)).toEqual(["pi-extended-teams-report", DURABLE_REPORT_MESSAGE_TYPE]);
  });

  it("delivers a report that waited for a manual compaction", async () => {
    const agentDir = tempDirectory();
    const model = heldModel(() => "The parser is fine.");
    const session = fakeSession("session-compact", model.models, tempDirectory());
    const host = register(agentDir);
    // Another extension's slower handler runs after this one, so Pi is still compacting when this one returns.
    host.pi.on("session_compact", () => new Promise((resolve) => setTimeout(resolve, 30)));
    await host.emit("session_start", { reason: "startup" }, session.ctx);
    await spawnAgent(host, session.ctx);
    session.lead.idle = false;
    model.release();
    const runtime = await runtimeOf(agentDir, "session-compact");
    await vi.waitFor(async () => expect(await runtime.pendingReports()).toHaveLength(1));

    await host.emit("session_compact", {}, session.ctx);
    session.lead.idle = true;

    await vi.waitFor(() => expect(host.sent).toHaveLength(1));
  });

  it("sends a report again after a restart when the session never showed it", async () => {
    const agentDir = tempDirectory();
    const model = heldModel(() => "The parser is fine.");
    const session = fakeSession("session-b", model.models, tempDirectory());
    const host = register(agentDir);
    await host.emit("session_start", { reason: "startup" }, session.ctx);
    await spawnAgent(host, session.ctx);
    model.release();
    await vi.waitFor(() => expect(host.sent).toHaveLength(1));
    await host.emit("session_shutdown", { reason: "quit" });

    const restarted = register(agentDir);
    await restarted.emit("session_start", { reason: "resume" }, session.ctx);
    await vi.waitFor(() => expect(restarted.sent).toHaveLength(1));
    expect(restarted.sent[0]!.message.details.reportId).toBe("spawn:call-1");

    showInHistory(session, restarted.sent[0]!);
    await restarted.emit("agent_settled", {}, session.ctx);
    const runtime = await runtimeOf(agentDir, "session-b");
    await vi.waitFor(async () => expect(await runtime.pendingReports()).toEqual([]));
    expect(restarted.sent).toHaveLength(1);
  });

  it("keeps a working agent running through a same-process reload", async () => {
    const agentDir = tempDirectory();
    const model = heldModel(() => "Done after the reload.");
    const session = fakeSession("session-c", model.models, tempDirectory());
    const before = register(agentDir);
    await before.emit("session_start", { reason: "startup" }, session.ctx);
    await spawnAgent(before, session.ctx);
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));

    await before.emit("session_shutdown", { reason: "reload" });
    const after = register(agentDir);
    await after.emit("session_start", { reason: "reload" }, session.ctx);
    model.release();

    await vi.waitFor(() => expect(after.sent).toHaveLength(1));
    expect(after.sent[0]!.message.content).toBe("Durable agent reader reported:\n\nDone after the reload.");
    expect(before.sent).toEqual([]);
    expect(model.requests).toHaveLength(1);
  });

  it("pauses agents when Pi quits and resumes them when the session opens again", async () => {
    const agentDir = tempDirectory();
    const model = heldModel(() => "Done after the restart.");
    const session = fakeSession("session-d", model.models, tempDirectory());
    const before = register(agentDir);
    await before.emit("session_start", { reason: "startup" }, session.ctx);
    await spawnAgent(before, session.ctx);
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));
    await before.emit("session_shutdown", { reason: "quit" });

    const after = register(agentDir);
    await after.emit("session_start", { reason: "resume" }, session.ctx);
    await vi.waitFor(() => expect(model.requests).toHaveLength(2));
    model.release();

    await vi.waitFor(() => expect(after.sent).toHaveLength(1));
    expect(after.sent[0]!.message.content).toBe("Durable agent reader reported:\n\nDone after the restart.");
    expect(before.sent).toEqual([]);
  });

  it("keeps each session's agents in that session", async () => {
    const agentDir = tempDirectory();
    const cwd = tempDirectory();
    const model = heldModel(() => "Done in the first session.");
    const first = fakeSession("session-first", model.models, cwd);
    const second = fakeSession("session-second", model.models, cwd);
    const host = register(agentDir);
    await host.emit("session_start", { reason: "startup" }, first.ctx);
    await spawnAgent(host, first.ctx);
    await vi.waitFor(() => expect(model.requests).toHaveLength(1));

    await host.emit("session_shutdown", { reason: "new" });
    await host.emit("session_start", { reason: "new" }, second.ctx);
    expect(await statusText(host, second.ctx)).toBe("No durable agents in this session.");
    model.release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.sent).toEqual([]);
    expect(model.requests).toHaveLength(1);

    await host.emit("session_shutdown", { reason: "resume" });
    await host.emit("session_start", { reason: "resume" }, first.ctx);
    await vi.waitFor(() => expect(host.sent).toHaveLength(1));
    expect(host.sent[0]!.message.content).toBe("Durable agent reader reported:\n\nDone in the first session.");
    expect(second.entries).toEqual([]);
  });

  it("rejects incomplete spawns", async () => {
    const agentDir = tempDirectory();
    const model = heldModel(() => "Unused.");
    const session = fakeSession("session-e", model.models, tempDirectory());
    const host = register(agentDir);
    const tool = host.tools.get("durable_agents");
    await expect(tool.execute("call-1", { action: "spawn", prompt: "Check it." }, undefined, undefined, session.ctx)).rejects.toThrow("spawn needs a name.");
    await expect(tool.execute("call-2", { action: "spawn", name: "reader", prompt: "Check it.", model_slot: "fast" }, undefined, undefined, session.ctx)).rejects.toThrow("Unknown model_slot fast.");
  });
});
