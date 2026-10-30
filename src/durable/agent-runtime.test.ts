import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitWithContext, BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AssistantMessage, type Message, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseStep,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  type Extension,
  Harness,
  type HarnessSettings,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DurableAgentRuntime, type DurableAgentReport } from "./agent-runtime";
import { DurableRuntimeBusyError } from "./owner-lock";

const FAUX = { provider: "faux", modelId: "faux-1" };
const NO_RETRY: HarnessSettings = { retry: { enabled: false } };

const directories: string[] = [];
const runtimes: DurableAgentRuntime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "durable-agents-"));
  directories.push(directory);
  return directory;
}

function textOf(message: Message | undefined): string {
  if (message === undefined || message.role === "system") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** The newest user or tool message of a request; system messages only carry prompt and tool changes. */
function latest(messages: readonly Message[]): Message | undefined {
  return messages.filter((message) => message.role === "user" || message.role === "toolResult").at(-1);
}

function answer(text: string): AssistantMessage {
  return fauxAssistantMessage([fauxText(text)]);
}

function call(name: string, args: Record<string, string> = {}): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function gate(name = "wait_for_gate") {
  let release!: () => void;
  let markStarted!: () => void;
  let runs = 0;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const tool = defineTool({
    name,
    description: "Wait until the test opens the gate.",
    parameters: Type.Object({}),
    execute: async (_args, _api, context) => {
      runs += 1;
      markStarted();
      await awaitWithContext(opened, context);
      return { content: [{ type: "text", text: "The gate opened." }] };
    },
  });
  return { extension: defineExtension({ name: `${name}-tools`, tools: [tool] }), release: () => release(), started, runs: () => runs };
}

interface Team {
  runtime: DurableAgentRuntime;
  reports: DurableAgentReport[];
  requests: string[];
}

async function openTeam(options: {
  file: string;
  route: (messages: readonly Message[]) => AssistantMessage;
  extensions?: Extension[];
  settings?: HarnessSettings;
}): Promise<Team> {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const requests: string[] = [];
  const step: FauxResponseStep = (context) => {
    requests.push(textOf(latest(context.messages)));
    return options.route(context.messages);
  };
  faux.setResponses(Array.from({ length: 40 }, () => step));
  const reports: DurableAgentReport[] = [];
  const runtime = await DurableAgentRuntime.open({
    file: options.file,
    models,
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    deliver: (report) => {
      reports.push(report);
      return true;
    },
  });
  runtimes.push(runtime);
  return { runtime, reports, requests };
}

async function agentState(runtime: DurableAgentRuntime, name: string) {
  return (await runtime.status()).find((status) => status.name === name);
}

/** Every Pi Durable conversation handle shares this prototype, so a spy on it reaches the runtime's handles. */
interface ConversationMethods {
  abort(...args: unknown[]): Promise<void>;
  submit(...args: unknown[]): Promise<unknown>;
}

async function conversationPrototype(): Promise<ConversationMethods> {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  const root = await harness.root(BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  return Object.getPrototypeOf(root);
}

/** Store the team document as a version this runtime does not know, as a newer release would. */
async function storeNewerTeamDocument(file: string): Promise<void> {
  const NewerTeam = defineDoc<{ seq: number }>({
    kind: "pi-extended-teams.team",
    version: 2,
    scope: "session",
    initial: () => ({ seq: 0 }),
    migrate: (value) => value as { seq: number },
  });
  const harness = await Harness.open(await openNodeSqliteStorage(file), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  await harness.commit(async (tx) => {
    (await tx.doc(NewerTeam)).seq += 1;
  }, BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
}

describe("DurableAgentRuntime", () => {
  it("reports an agent's answer once and acknowledges it after delivery", async () => {
    const directory = tempDirectory();
    const team = await openTeam({
      file: path.join(directory, "team.sqlite"),
      route: () => answer("The parser is fine."),
    });

    await team.runtime.spawn({
      name: "reader",
      role: "read",
      prompt: "Check the parser.",
      cwd: directory,
      model: FAUX,
      requestId: "spawn:reader",
    });

    await vi.waitFor(() => expect(team.reports).toHaveLength(1));
    expect(team.reports[0]).toMatchObject({ id: "spawn:reader", agent: "reader", outcome: "answered", text: "The parser is fine." });
    await vi.waitFor(async () => expect(await team.runtime.pendingReports()).toEqual([]));
    expect(await agentState(team.runtime, "reader")).toMatchObject({ state: "idle", openMessages: 0, role: "read" });
  });

  it("returns the first agent when a spawn is retried with the same request ID", async () => {
    const directory = tempDirectory();
    const team = await openTeam({ file: path.join(directory, "team.sqlite"), route: () => answer("Done.") });
    const spec = { name: "reader", role: "read", prompt: "Check it.", cwd: directory, model: FAUX, requestId: "spawn:1" } as const;

    const first = await team.runtime.spawn(spec);
    const retried = await team.runtime.spawn(spec);

    expect(first.created).toBe(true);
    expect(retried).toEqual({ name: "reader", conversationId: first.conversationId, created: false });
    await vi.waitFor(() => expect(team.reports).toHaveLength(1));
    expect(team.requests).toEqual(["Check it."]);
    await expect(team.runtime.spawn({ ...spec, requestId: "spawn:2" })).rejects.toThrow("already exists");
  });

  it("admits messages in call order", async () => {
    const directory = tempDirectory();
    const team = await openTeam({
      file: path.join(directory, "team.sqlite"),
      route: (messages) => answer(`Answered: ${textOf(latest(messages))}`),
    });

    await Promise.all([
      team.runtime.spawn({ name: "reader", role: "read", prompt: "First task.", cwd: directory, model: FAUX }),
      team.runtime.send("reader", "Second task."),
    ]);
    await team.runtime.send("reader", "Third task.");

    await vi.waitFor(() => expect(team.reports).toHaveLength(3));
    expect(team.requests).toEqual(["First task.", "Second task.", "Third task."]);
  });

  it("joins a steer into the running work and reports the shared answer once", async () => {
    const directory = tempDirectory();
    const held = gate();
    const team = await openTeam({
      file: path.join(directory, "team.sqlite"),
      extensions: [held.extension],
      route: (messages) => {
        const text = textOf(latest(messages));
        if (text === "Check the parser.") return call("wait_for_gate");
        if (text === "Also check the lexer.") return answer("Parser and lexer are fine.");
        return answer("Only the parser was checked.");
      },
    });

    await team.runtime.spawn({ name: "reader", role: "read", prompt: "Check the parser.", cwd: directory, model: FAUX });
    await held.started;
    await team.runtime.send("reader", "Also check the lexer.", { steer: true });
    expect(await agentState(team.runtime, "reader")).toMatchObject({ state: "working", runningTools: ["wait_for_gate"] });
    held.release();

    await vi.waitFor(async () => expect(await agentState(team.runtime, "reader")).toMatchObject({ state: "idle", openMessages: 0 }));
    await vi.waitFor(async () => expect(await team.runtime.pendingReports()).toEqual([]));
    expect(team.reports.map((report) => report.text)).toEqual(["Parser and lexer are fine."]);
  });

  it("reports a follow-up sent after an answer as its own run", async () => {
    const directory = tempDirectory();
    const team = await openTeam({
      file: path.join(directory, "team.sqlite"),
      route: (messages) => answer(textOf(latest(messages)) === "And the tests?" ? "The tests pass." : "The parser is fine."),
    });

    await team.runtime.spawn({ name: "reader", role: "read", prompt: "Check the parser.", cwd: directory, model: FAUX });
    await vi.waitFor(() => expect(team.reports).toHaveLength(1));
    await team.runtime.send("reader", "And the tests?", { requestId: "follow-up:1" });
    await team.runtime.send("reader", "And the tests?", { requestId: "follow-up:1" });

    await vi.waitFor(() => expect(team.reports).toHaveLength(2));
    expect(team.reports.map((report) => report.text)).toEqual(["The parser is fine.", "The tests pass."]);
    expect(team.requests).toEqual(["Check the parser.", "And the tests?"]);
  });

  it("interrupts a running tool and lets the agent finish its turn", async () => {
    const directory = tempDirectory();
    const held = gate();
    const team = await openTeam({
      file: path.join(directory, "team.sqlite"),
      extensions: [held.extension],
      route: (messages) => {
        const last = latest(messages);
        if (last?.role === "toolResult") return answer(`Stopped waiting: ${textOf(last)}`);
        return call("wait_for_gate");
      },
    });

    await team.runtime.spawn({ name: "reader", role: "read", prompt: "Wait for the gate.", cwd: directory, model: FAUX });
    await held.started;

    expect(await team.runtime.interrupt("reader")).toEqual(["wait_for_gate"]);
    await vi.waitFor(() => expect(team.reports).toHaveLength(1));
    expect(team.reports[0]!.text).toMatch(/^Stopped waiting: .*Tool wait_for_gate was aborted/s);
  });

  it("stops an agent without reporting the aborted work and refuses new messages", async () => {
    const directory = tempDirectory();
    const held = gate();
    const team = await openTeam({
      file: path.join(directory, "team.sqlite"),
      extensions: [held.extension],
      route: () => call("wait_for_gate"),
    });

    await team.runtime.spawn({ name: "reader", role: "read", prompt: "Wait for the gate.", cwd: directory, model: FAUX });
    await held.started;
    await team.runtime.stop("reader");

    await vi.waitFor(async () => expect(await agentState(team.runtime, "reader")).toMatchObject({ state: "stopped", openMessages: 0 }));
    expect(await team.runtime.pendingReports()).toEqual([]);
    await expect(team.runtime.send("reader", "Keep going.")).rejects.toThrow("reader was stopped.");
    expect(team.reports).toEqual([]);
  });

  it("finishes a stop that a crash cut off before its abort, without running more work", async () => {
    const directory = tempDirectory();
    const file = path.join(directory, "team.sqlite");
    const held = gate();
    const before = await openTeam({ file, extensions: [held.extension], route: () => call("wait_for_gate") });
    await before.runtime.spawn({ name: "reader", role: "read", prompt: "Wait for the gate.", cwd: directory, model: FAUX });
    await held.started;
    await before.runtime.send("reader", "More work.");
    vi.spyOn(await conversationPrototype(), "abort").mockRejectedValueOnce(new Error("crashed before the abort"));
    await expect(before.runtime.stop("reader")).rejects.toThrow("crashed before the abort");
    await before.runtime.close();

    const after = await openTeam({ file, extensions: [held.extension], route: () => call("wait_for_gate") });

    await vi.waitFor(async () => expect(await agentState(after.runtime, "reader")).toMatchObject({ state: "stopped", openMessages: 0, runningTools: [] }));
    expect(after.requests).toEqual([]);
    expect(held.runs()).toBe(1);
    expect(await after.runtime.pendingReports()).toEqual([]);
    expect(after.reports).toEqual([]);
  });

  it("moves on to a message that waited behind a failed run", async () => {
    const directory = tempDirectory();
    const held = gate();
    const team = await openTeam({
      file: path.join(directory, "team.sqlite"),
      extensions: [held.extension],
      settings: NO_RETRY,
      route: (messages) => {
        const last = latest(messages);
        if (last?.role === "toolResult") return fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider exploded" });
        if (textOf(last) === "Second task.") return answer("The second task is done.");
        return call("wait_for_gate");
      },
    });

    await team.runtime.spawn({ name: "reader", role: "read", prompt: "First task.", cwd: directory, model: FAUX });
    await held.started;
    await team.runtime.send("reader", "Second task.");
    held.release();

    await vi.waitFor(() => expect(team.reports).toHaveLength(2));
    expect(team.reports.map((report) => report.outcome)).toEqual(["failed", "answered"]);
    expect(team.reports[0]!.text).toContain("provider exploded");
    expect(team.reports[1]!.text).toBe("The second task is done.");
    expect(team.requests.at(-1)).toBe("Second task.");
    await vi.waitFor(async () => expect(await agentState(team.runtime, "reader")).toMatchObject({ state: "idle", openMessages: 0 }));
  });

  it("moves on to a waiting message after a restart that cut off the move", async () => {
    const directory = tempDirectory();
    const file = path.join(directory, "team.sqlite");
    const held = gate();
    const route = (messages: readonly Message[]) => {
      const last = latest(messages);
      if (last?.role === "toolResult") return fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider exploded" });
      if (textOf(last) === "Second task.") return answer("The second task is done.");
      return call("wait_for_gate");
    };
    const before = await openTeam({ file, extensions: [held.extension], settings: NO_RETRY, route });
    await before.runtime.spawn({ name: "reader", role: "read", prompt: "First task.", cwd: directory, model: FAUX });
    await held.started;
    await before.runtime.send("reader", "Second task.");
    const prototype = await conversationPrototype();
    const submit = prototype.submit;
    vi.spyOn(prototype, "submit").mockImplementation(function (this: unknown, ...args: unknown[]) {
      if ((args[0] as { type?: string }).type === "write") return Promise.reject(new Error("crashed before the move"));
      return submit.apply(this, args);
    });
    held.release();
    await vi.waitFor(() => expect(before.reports.map((report) => report.outcome)).toEqual(["failed"]));
    await vi.waitFor(async () => expect(await agentState(before.runtime, "reader")).toMatchObject({ state: "queued", openMessages: 1 }));
    vi.restoreAllMocks();
    await before.runtime.close();

    const after = await openTeam({ file, extensions: [held.extension], settings: NO_RETRY, route });

    await vi.waitFor(() => expect(after.reports.map((report) => report.text)).toEqual(["The second task is done."]));
    expect(after.requests).toEqual(["Second task."]);
  });

  it("reports a failed run once when a steer joined it", async () => {
    const directory = tempDirectory();
    const held = gate();
    const team = await openTeam({
      file: path.join(directory, "team.sqlite"),
      extensions: [held.extension],
      settings: NO_RETRY,
      route: (messages) => (textOf(latest(messages)) === "Check the parser."
        ? call("wait_for_gate")
        : fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider exploded" })),
    });

    await team.runtime.spawn({ name: "reader", role: "read", prompt: "Check the parser.", cwd: directory, model: FAUX });
    await held.started;
    await team.runtime.send("reader", "Also check the lexer.", { steer: true });
    held.release();

    await vi.waitFor(async () => expect(await agentState(team.runtime, "reader")).toMatchObject({ state: "idle", openMessages: 0 }));
    await vi.waitFor(async () => expect(await team.runtime.pendingReports()).toEqual([]));
    expect(team.requests).toEqual(["Check the parser.", "Also check the lexer."]);
    expect(team.reports).toHaveLength(1);
    expect(team.reports[0]).toMatchObject({ outcome: "failed" });
  });

  it("runs no agent work when the file cannot be opened", async () => {
    const directory = tempDirectory();
    const file = path.join(directory, "team.sqlite");
    const held = gate();
    const before = await openTeam({ file, extensions: [held.extension], route: () => call("wait_for_gate") });
    await before.runtime.spawn({ name: "reader", role: "read", prompt: "Wait for the gate.", cwd: directory, model: FAUX });
    await held.started;
    await before.runtime.close();
    await storeNewerTeamDocument(file);

    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    let requests = 0;
    faux.setResponses(Array.from({ length: 5 }, () => () => {
      requests += 1;
      return answer("This work should not run.");
    }));
    const reopen = () => DurableAgentRuntime.open({ file, models, extensions: [held.extension] });

    await expect(reopen()).rejects.toThrow("newer version 2");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(requests).toBe(0);
    await expect(reopen()).rejects.toThrow("newer version 2");
  });

  it("offers edit and write tools to write agents only", async () => {
    const directory = tempDirectory();
    const team = await openTeam({
      file: path.join(directory, "team.sqlite"),
      route: (messages) => {
        const last = latest(messages);
        if (last?.role === "toolResult") return answer(textOf(last));
        const file = textOf(last).replace("Create ", "");
        return call("write", { path: path.join(directory, file), content: "hello" });
      },
    });

    await team.runtime.spawn({ name: "reader", role: "read", prompt: "Create reader.txt", cwd: directory, model: FAUX });
    await team.runtime.spawn({ name: "writer", role: "write", prompt: "Create writer.txt", cwd: directory, model: FAUX });

    await vi.waitFor(() => expect(team.reports).toHaveLength(2));
    const byAgent = Object.fromEntries(team.reports.map((report) => [report.agent, report.text]));
    expect(byAgent.reader).toContain("Tool write is not available");
    expect(byAgent.writer).toContain("Successfully wrote");
    expect(fs.existsSync(path.join(directory, "reader.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(directory, "writer.txt"), "utf8")).toBe("hello");
  });

  it("reports a failed run", async () => {
    const directory = tempDirectory();
    const team = await openTeam({
      file: path.join(directory, "team.sqlite"),
      settings: NO_RETRY,
      route: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider exploded" }),
    });

    await team.runtime.spawn({ name: "reader", role: "read", prompt: "Check it.", cwd: directory, model: FAUX });

    await vi.waitFor(() => expect(team.reports).toHaveLength(1));
    expect(team.reports[0]).toMatchObject({ agent: "reader", outcome: "failed" });
    expect(team.reports[0]!.text).toContain("The agent stopped without an answer");
  });

  it("keeps a report pending until the host confirms delivery", async () => {
    const directory = tempDirectory();
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([answer("Done.")]);
    const attempts: string[] = [];
    let lead: "down" | "unconfirmed" | "confirmed" = "down";
    const runtime = await DurableAgentRuntime.open({
      file: path.join(directory, "team.sqlite"),
      models,
      deliver: (report) => {
        attempts.push(`${lead}:${report.id}`);
        if (lead === "down") throw new Error("lead unavailable");
        return lead === "confirmed";
      },
    });
    runtimes.push(runtime);

    await runtime.spawn({ name: "reader", role: "read", prompt: "Check it.", cwd: directory, model: FAUX, requestId: "spawn:reader" });
    await vi.waitFor(() => expect(attempts).toEqual(["down:spawn:reader"]));
    expect(await runtime.pendingReports()).toHaveLength(1);

    lead = "unconfirmed";
    await runtime.deliverReports();
    expect(await runtime.pendingReports()).toHaveLength(1);

    lead = "confirmed";
    await runtime.deliverReports();
    expect(attempts).toEqual(["down:spawn:reader", "unconfirmed:spawn:reader", "confirmed:spawn:reader"]);
    expect(await runtime.pendingReports()).toEqual([]);
  });

  it("keeps a message whose hand-over failed and admits it, in order, before the next one", async () => {
    const directory = tempDirectory();
    const team = await openTeam({
      file: path.join(directory, "team.sqlite"),
      route: (messages) => answer(`Answered: ${textOf(latest(messages))}`),
    });
    await team.runtime.spawn({ name: "reader", role: "read", prompt: "First task.", cwd: directory, model: FAUX, requestId: "first" });
    await vi.waitFor(() => expect(team.reports).toHaveLength(1));
    vi.spyOn(await conversationPrototype(), "submit").mockRejectedValueOnce(new Error("storage hiccup"));

    await expect(team.runtime.send("reader", "Second task.", { requestId: "second" })).rejects.toThrow(
      "reader has the message, but handing it over failed: storage hiccup",
    );
    expect(await agentState(team.runtime, "reader")).toMatchObject({ state: "queued", openMessages: 1 });
    await team.runtime.send("reader", "Third task.", { requestId: "third" });
    await team.runtime.send("reader", "Second task.", { requestId: "second" });

    await vi.waitFor(() => expect(team.reports).toHaveLength(3));
    expect(team.requests).toEqual(["First task.", "Second task.", "Third task."]);
    expect(team.reports.map((report) => report.id)).toEqual(["first", "second", "third"]);
  });

  it("reports a lock failure that is not another owner as itself", async () => {
    const file = path.join(tempDirectory(), "team.sqlite");
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementationOnce(() => {
      throw Object.assign(new Error("database or disk is full"), { errcode: 13 });
    });

    const opening = DurableAgentRuntime.open({ file, models: createModels() });

    await expect(opening).rejects.toThrow("database or disk is full");
    await expect(opening).rejects.not.toBeInstanceOf(DurableRuntimeBusyError);
  });

  it("refuses a second owner of the same file", async () => {
    const directory = tempDirectory();
    const file = path.join(directory, "team.sqlite");
    const first = await openTeam({ file, route: () => answer("Done.") });

    await expect(DurableAgentRuntime.open({ file, models: createModels() })).rejects.toBeInstanceOf(DurableRuntimeBusyError);
    await first.runtime.close();
    const second = await openTeam({ file, route: () => answer("Done.") });
    expect(await second.runtime.status()).toEqual([]);
  });

  it("continues an agent after its process is killed mid-tool and reports once", async () => {
    const directory = tempDirectory();
    const file = path.join(directory, "team.sqlite");
    const marker = path.join(directory, "hold.started");
    const child = spawn(
      process.execPath,
      ["--import", "jiti/register", path.join(__dirname, "agent-runtime.race.child.ts"), file, marker, directory],
      { cwd: path.resolve(__dirname, "../.."), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await vi.waitFor(() => {
        if (child.exitCode !== null) throw new Error(`child exited early: ${stderr}`);
        expect(fs.existsSync(marker)).toBe(true);
      }, { timeout: 20_000, interval: 25 });
      await expect(DurableAgentRuntime.open({ file, models: createModels() })).rejects.toBeInstanceOf(DurableRuntimeBusyError);
    } finally {
      child.kill("SIGKILL");
      await exited;
    }

    const team = await openTeam({
      file,
      route: (messages) => {
        const last = latest(messages);
        return answer(last?.role === "toolResult" ? `Recovered: ${textOf(last)}` : "Started over.");
      },
    });

    await vi.waitFor(() => expect(team.reports).toHaveLength(1), { timeout: 10_000 });
    expect(team.reports[0]).toMatchObject({ id: "spawn:reader", agent: "reader", outcome: "answered" });
    expect(team.reports[0]!.text).toMatch(/^Recovered: .*Tool hold was interrupted and may have partially run/s);
    expect(team.requests).toHaveLength(1);
    expect(team.requests[0]).toContain("Tool hold was interrupted and may have partially run");

    await team.runtime.close();
    const reopened = await openTeam({ file, route: () => answer("Unexpected request.") });
    expect(await reopened.runtime.pendingReports()).toEqual([]);
    expect(await agentState(reopened.runtime, "reader")).toMatchObject({ state: "idle", openMessages: 0 });
    expect(reopened.reports).toEqual([]);
    expect(reopened.requests).toEqual([]);
  }, 40_000);
});
