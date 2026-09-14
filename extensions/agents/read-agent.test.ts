import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { CheckJournal } from "../../src/results/check-journal";
import { createReportResult, effectiveTaskOutcome, type ReportResult } from "../../src/results/report-result";
import { VerificationController } from "../../src/results/verification-controller";
import { CompletionGroup } from "../../src/results/completion-group";
import * as checkpointStore from "../../src/results/specialist-checkpoint";
import * as checkpointSource from "../../src/results/source-identity";
import * as checkpointDurability from "../../src/results/durable-json";
import * as messaging from "../../src/utils/messaging";
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawnSync: vi.fn(),
}));
import * as paths from "../../src/utils/paths.js";
import * as claims from "../../src/utils/claims.js";
import * as teams from "../../src/utils/teams.js";
import * as runtime from "../../src/utils/runtime.js";
import { readLifecycleTombstone } from "../../src/utils/lifecycle-tombstone.js";
import * as lifecycleTombstones from "../../src/utils/lifecycle-tombstone.js";
import { readInbox, requireRunningMessageRecipient, sendPlainMessage, sendPlainMessageIfRunning } from "../../src/utils/messaging.js";
import { listTeamReportEvents } from "../../src/utils/report-events.js";
import * as reportEvents from "../../src/utils/report-events.js";
import type { Member } from "../../src/utils/models.js";

const piMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  loaderOptions: [] as any[],
  loaderExtensions: [] as any[],
  settingsManagers: [] as any[],
  sessionManagerCreate: vi.fn(),
  sessionManagerOpen: vi.fn(),
  persistedSessionEntries: new Map<string, any[]>(),
  sessionManagerCounter: 0,
  eventBuses: [] as Array<{ on(name: string, handler: (payload: any) => void): () => void; emit(name: string, payload: any): void }>,
}));

function mockedPiRuntimeApi() {
  return {
  createAgentSession: piMocks.createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: any) {
      piMocks.loaderOptions.push(options);
    }

    async reload() {}

    getExtensions() {
      return { extensions: piMocks.loaderExtensions, errors: [], runtime: {} };
    }
  },
  getAgentDir: () => "/mock-agent-dir",
  SettingsManager: {
    create: vi.fn((_cwd: string, _agentDir: string, options?: any) => {
      const manager = {
        projectTrusted: options?.projectTrusted ?? false,
        setProjectTrusted(trusted: boolean) { this.projectTrusted = trusted; },
        isProjectTrusted() { return this.projectTrusted; },
        getGlobalSettings: () => ({}),
        getProjectSettings: () => ({}),
      };
      piMocks.settingsManagers.push(manager);
      return manager;
    }),
  },
  SessionManager: {
    create: piMocks.sessionManagerCreate,
    open: piMocks.sessionManagerOpen,
  },
  createEventBus: () => {
    const handlers = new Map<string, Array<(payload: any) => void>>();
    const eventBus = {
      on(name: string, handler: (payload: any) => void) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        return () => handlers.set(name, (handlers.get(name) ?? []).filter(candidate => candidate !== handler));
      },
      emit(name: string, payload: any) {
        for (const handler of handlers.get(name) ?? []) handler(payload);
      },
    };
    piMocks.eventBuses.push(eventBus);
    return eventBus;
  },
  };
}

vi.mock("@mariozechner/pi-coding-agent", mockedPiRuntimeApi);
vi.mock("../internal/pi-runtime-api", () => ({
  loadPiRuntimeApi: async () => mockedPiRuntimeApi(),
}));

import { closeReadAgentMessageDelivery, handleReadAgentSessionEvent, runReadAgentInProcess, sendMessageToRunningReadAgent } from "./read-agent.js";
import { createLifecycleRuntime } from "../team/lifecycle.js";
import { registerTaskRuntimeTools } from "../tools/task-runtime-tools.js";
import { sanitizeTuiLine } from "../ui/renderers.js";
import { NESTED_SESSION_TEARDOWN_TIMEOUT_MS } from "./read-agent-session-lifecycle.js";
import type { RunningReadAgent } from "../runtime/types.js";
import { createPendingChildController, type PendingChildRun } from "../runtime/pending-child-controller.js";
import { createTeammateInterrupter } from "../runtime/teammate-interrupt.js";

let root: string;

function installPathSpies() {
  vi.spyOn(paths, "teamDir").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName))));
  vi.spyOn(paths, "configPath").mockImplementation((teamName: unknown) => path.join(root, "teams", paths.sanitizeName(String(teamName)), "config.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "runtime", `${paths.sanitizeName(String(agentName))}.json`);
  });
  vi.spyOn(paths, "inboxPath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "inboxes", `${paths.sanitizeName(String(agentName))}.json`);
  });
  vi.spyOn(paths, "claimsPath").mockImplementation((teamName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "claims.json");
  });
  vi.spyOn(paths, "reportEventsPath").mockImplementation((teamName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "reports.json");
  });
  vi.spyOn(paths, "reportFilesDir").mockReturnValue(path.join(root, "agent", "reports"));
  vi.spyOn(paths, "checkpointFilesDir").mockReturnValue(path.join(fs.realpathSync(root), "checkpoints"));
  vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName: unknown, agentName: unknown) => {
    return path.join(root, "teams", paths.sanitizeName(String(teamName)), "lifecycle", "quarantine", `${paths.sanitizeName(String(agentName))}.json`);
  });
}

function writeFavoriteLevels(overrides: Record<string, unknown> = {}) {
  const settingsPath = path.join(root, ".pi", "agent", "pi-extended-teams", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...overrides,
    favoriteModels: {
      "reading-default": { model: "provider/model", thinking: "high" },
      "writing-basic": { model: "provider/model", thinking: "high" },
      "writing-hard": { model: "provider/model", thinking: "xhigh" },
      "write-feature": { model: "provider/model", thinking: "medium" },
      "write-critical": { model: "provider/model", thinking: "xhigh" },
    },
  }));
}

function writeTeamConfig(teamName: string, teammate: Member, additionalMembers: Member[] = []) {
  const configFile = paths.configPath(teamName);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({
    name: teamName,
    description: "",
    createdAt: Date.now(),
    leadAgentId: "lead",
    leadSessionId: "lead-session",
    members: [
      {
        agentId: `team-lead@${teamName}`,
        name: "team-lead",
        agentType: "lead",
        joinedAt: Date.now(),
        tmuxPaneId: "",
        cwd: root,
        subscriptions: [],
      },
      ...additionalMembers,
      teammate,
    ],
  }, null, 2));
}

function fixtureMember(name: string, role: "read" | "write" = "read", modelSlot?: string): Member {
  return {
    agentId: `${name}@fixture`,
    name,
    agentType: "teammate",
    role,
    model: "provider/model",
    thinking: role === "write" && modelSlot !== "writing-basic" ? "xhigh" : "high",
    modelSlot: modelSlot ?? (role === "write" ? "writing-hard" : "reading-default"),
    joinedAt: Date.now(),
    tmuxPaneId: "",
    cwd: root,
    subscriptions: [],
  };
}

function eligibleNestedParent(name = "feature-writer"): Member {
  return {
    ...fixtureMember(name, "write", "write-feature"),
    thinking: "medium",
    prompt: "implement a bounded feature",
    delegationDepth: 0,
    allowNestedReadAgents: true,
  };
}

function makeSession() {
  return {
    messages: [{ role: "assistant", content: "final report" }],
    getSessionStats: vi.fn(() => ({ tokens: { total: 42 } })),
    subscribe: vi.fn(),
    prompt: vi.fn(async () => {}),
    bindExtensions: vi.fn(async () => {}),
    sendUserMessage: vi.fn(async () => {}),
    isStreaming: true,
    hasExtensionHandlers: vi.fn(() => false),
    extensionRunner: { emit: vi.fn(async () => {}) },
    clearQueue: vi.fn((): { steering: string[]; followUp: string[] } => ({ steering: [], followUp: [] })),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

function makeRunOptions(runningReadAgents = new Map<string, RunningReadAgent>()) {
  return {
    isTeammate: false,
    getTeamName: () => "team",
    runningReadAgents,
    readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
    isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
    ensureReadAgentStatusTicker: vi.fn(),
    renderReadAgentStatus: vi.fn(),
    rememberCompletedAgentReport: vi.fn(),
    emitAgentReport: vi.fn(),
    releaseAllClaimsForAgent: vi.fn(async () => []),
  };
}

describe("in-process read agent tool wiring", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-read-agent-"));
    piMocks.loaderOptions.length = 0;
    piMocks.loaderExtensions.length = 0;
    piMocks.settingsManagers.length = 0;
    piMocks.createAgentSession.mockReset();
    piMocks.sessionManagerCreate.mockReset();
    piMocks.sessionManagerOpen.mockReset();
    piMocks.persistedSessionEntries.clear();
    piMocks.sessionManagerCounter = 0;
    piMocks.eventBuses.length = 0;
    piMocks.sessionManagerCreate.mockImplementation((cwd: string, sessionDir?: string) => {
      const id = `child-session-${++piMocks.sessionManagerCounter}`;
      const sessionFile = path.join(sessionDir ?? path.join(root, "child-sessions"), `${id}.jsonl`);
      return {
        cwd,
        getSessionId: () => id,
        getSessionDir: () => sessionDir,
        getSessionFile: () => sessionFile,
      };
    });
    piMocks.sessionManagerOpen.mockImplementation((sessionFile: string) => ({
      getEntries: () => piMocks.persistedSessionEntries.get(sessionFile) ?? [],
    }));
    vi.spyOn(os, "homedir").mockReturnValue(root);
    installPathSpies();
    writeFavoriteLevels();
    writeTeamConfig("team", fixtureMember("reader"), [
      fixtureMember("writer", "write"),
      fixtureMember("workflow-reader"),
      fixtureMember("writer-reader"),
    ]);
    writeTeamConfig("prompt-build-123", fixtureMember("prompt-branch-1"));
    writeTeamConfig("session-main", fixtureMember("planner", "write", "writing-basic"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["completed-source", "completed-save", "failed-source", "stale-source"])("settles owned checkpoint publication without late delivery: %s", async mode => {
    const observed: checkpointSource.SourceIdentity = { version: 1, cwd: root, repositoryRoot: root, head: null, inputs: ["src"], fileCount: 1, fingerprint: "a".repeat(64) };
    const member: Member = { ...fixtureMember("reviewer"), lifecycleRunId: "checkpoint-run", prompt: "Review",
      checkpointAssignment: { originalPrompt: "Review", policy: { inputs: ["src"], retentionDays: 30, decisions: [] }, sourceBefore: observed } };
    writeTeamConfig("team", member); await claims.claimFiles("team", member.name, ["src/auth.ts"], 1);
    let begin!: () => void; let resume!: () => void; let aborted!: () => void; let sourceSignal!: AbortSignal;
    const began = new Promise<void>(resolve => { begin = resolve; }); const held = new Promise<void>(resolve => { resume = resolve; });
    const abortCalled = new Promise<void>(resolve => { aborted = resolve; });
    vi.spyOn(checkpointSource, "captureSourceIdentity").mockImplementation(async (_cwd, _inputs, signal) => {
      sourceSignal = signal!; if (mode !== "completed-save") { begin(); await held; } return observed;
    });
    if (mode === "completed-save") {
      const save = checkpointStore.saveCheckpoint;
      vi.spyOn(checkpointStore, "saveCheckpoint").mockImplementationOnce(async value => { begin(); await held; return save(value); });
    }
    const session = makeSession(); let transcript = "";
    session.abort.mockImplementation(async () => { aborted(); });
    session.prompt.mockImplementation(async () => {
      const created = piMocks.createAgentSession.mock.calls.at(-1)![0];
      transcript = created.sessionManager.getSessionFile(); fs.writeFileSync(transcript, "Private recovery transcript");
      if (mode === "failed-source") throw new Error("model failed");
      await created.customTools.find((tool: any) => tool.name === "report_and_exit").execute("report", { content: "Complete report" });
    });
    piMocks.createAgentSession.mockResolvedValue({ session }); const options = makeRunOptions();
    const lifecycle = createLifecycleRuntime({ ...options, terminal: null, drainWriteQueue: async () => {}, getSessionCwd: () => root });
    const run = runReadAgentInProcess("team", member, "Review", { modelRegistry: { find: () => ({ provider: "provider", id: "model" }) } }, { ...options, shutdownTeammate: lifecycle.shutdownTeammate });
    let stopping: ReturnType<typeof lifecycle.shutdownTeammate> | undefined;
    try {
      await began;
      if (mode === "stale-source") {
        await teams.updateMember("team", member.name, { lifecycleRunId: "replacement-run" });
        const state = options.runningReadAgents.get("team:reviewer")!;
        options.runningReadAgents.set("team:reviewer", { ...state, runId: "replacement-run" });
      } else {
        stopping = lifecycle.shutdownTeammate("team", member, { reason: "reload" }); await abortCalled;
        expect(sourceSignal.aborted).toBe(true); expect(session.dispose).not.toHaveBeenCalled();
        expect(options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
      }
    } finally { resume(); await run; await stopping; }
    expect(options.emitAgentReport).not.toHaveBeenCalled(); expect(options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
    expect(fs.readFileSync(transcript, "utf8")).toBe("Private recovery transcript");
    expect(await claims.listClaims("team")).toEqual([{ agent: member.name, path: "src/auth.ts", since: 1 }]);
    const [event] = await listTeamReportEvents("team"); expect(fs.existsSync(event.reportPath!)).toBe(true);
    expect(fs.existsSync(paths.runtimeStatusPath("team", member.name))).toBe(true);
    if (mode !== "stale-source") {
      expect(await stopping).toMatchObject({ status: "cleanup_failed", finalized: false });
      expect(await readLifecycleTombstone("team", member.name)).toMatchObject({ status: "occupied", tombstone: { phase: "cleanup_failed" } });
    }
    expect((await teams.readConfig("team")).members).toContainEqual(expect.objectContaining({ name: member.name, lifecycleRunId: mode === "stale-source" ? "replacement-run" : member.lifecycleRunId }));
  });

  it.each([
    { label: "4097-character finding", invalid: { findings: [{ id: "F1", text: "x".repeat(4097), evidence: ["src/auth.ts:4"] }] },
      corrected: { findings: [{ id: "F1", text: "x".repeat(4096), evidence: ["src/auth.ts:4"] }] }, error: /findings\/0\/text.*4096/ },
    { label: "33 distinct questions", invalid: { questions: Array.from({ length: 33 }, (_, index) => `Question ${index}?`) },
      corrected: { questions: Array.from({ length: 32 }, (_, index) => `Question ${index}?`) }, error: /questions.*32/ },
    { label: "aggregate findings overflow", invalid: { findings: Array.from({ length: 16 }, (_, index) => ({ id: `F${index}`, text: "x".repeat(4096), evidence: [] })) },
      corrected: { findings: [{ id: "F0", text: "Bounded finding", evidence: [] }] }, error: /65536.*bytes/i },
    { label: "UTF-8 aggregate overflow", invalid: { findings: Array.from({ length: 6 }, (_, index) => ({ id: `F${index}`, text: "界".repeat(4096), evidence: [] })) },
      corrected: { findings: [{ id: "F0", text: "Bounded finding", evidence: [] }] }, error: /65536.*bytes/i },
    { label: "assignment plus findings overflow", prompt: "p".repeat(4096),
      invalid: { findings: Array.from({ length: 15 }, (_, index) => ({ id: `F${index}`, text: "x".repeat(4096), evidence: [] })) },
      corrected: { findings: [{ id: "F0", text: "Bounded finding", evidence: [] }] }, error: /65536.*bytes/i },
  ])("rejects checkpoint $label before closure and accepts correction", async ({ invalid, corrected, error, prompt = "Review" }) => {
    const observed: checkpointSource.SourceIdentity = { version: 1, cwd: root, repositoryRoot: root, head: null, inputs: ["src"], fileCount: 1, fingerprint: "a".repeat(64) };
    vi.spyOn(checkpointSource, "captureSourceIdentity").mockResolvedValue(observed);
    const member: Member = { ...fixtureMember("reviewer"), lifecycleRunId: "checkpoint-run", prompt,
      checkpointAssignment: { originalPrompt: prompt, policy: { inputs: ["src"], retentionDays: 30, decisions: [] }, sourceBefore: observed } };
    writeTeamConfig("team", member);
    const options = makeRunOptions();
    const session = makeSession();
    let transcript = "";
    let rejection: unknown;
    let invalidReceipt: unknown;
    let correctedReceipt: any;
    let recipientOpen = false;
    let acceptingMessages = false;
    session.prompt.mockImplementation(async () => {
      const created = piMocks.createAgentSession.mock.calls.at(-1)![0];
      transcript = created.sessionManager.getSessionFile(); fs.writeFileSync(transcript, "private fixture transcript");
      const tool = created.customTools.find((item: any) => item.name === "report_and_exit");
      try { invalidReceipt = await tool.execute("invalid", { content: "Uncorrected report", ...invalid }); }
      catch (error) { rejection = error; }
      acceptingMessages = options.runningReadAgents.get("team:reviewer")!.acceptingMessages === true;
      recipientOpen = await requireRunningMessageRecipient("team", member.name).then(() => true, () => false);
      correctedReceipt = await tool.execute("corrected", { content: "Corrected complete report", ...corrected });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    await runReadAgentInProcess("team", member, "Review", { modelRegistry: { find: () => ({ provider: "provider", id: "model" }) } }, options);
    expect(rejection).toBeInstanceOf(Error);
    expect(String(rejection)).toMatch(/checkpoint.*correct.*resubmit/i);
    expect(String(rejection)).toMatch(error);
    expect(invalidReceipt).toBeUndefined();
    expect(recipientOpen).toBe(true);
    expect(acceptingMessages).toBe(true);
    expect(correctedReceipt.details.accepted).toBe(true);
    const events = await listTeamReportEvents("team");
    expect(events).toHaveLength(1);
    const [event] = events;
    const checkpoint = checkpointStore.readCheckpoint(event.checkpoint!.id);
    expect(checkpointStore.isSpecialistCheckpoint(checkpoint)).toBe(true);
    expect(checkpoint.findings).toEqual((corrected.findings ?? []).map(finding => ({ ...finding, reportId: event.id })));
    expect(checkpoint.questions).toEqual(corrected.questions ?? []);
    expect(fs.readFileSync(event.reportPath!, "utf8")).toBe("Corrected complete report");
    expect(options.releaseAllClaimsForAgent).toHaveBeenCalledWith("team", member.name);
    expect(options.runningReadAgents.size).toBe(0);
    expect(fs.existsSync(transcript)).toBe(false);
    expect(session.dispose).toHaveBeenCalledOnce();
    expect((await teams.readConfig("team")).members.some(item => item.name === member.name)).toBe(false);
  });

  it("preserves broader findings and questions for ordinary reports", async () => {
    const member = { ...fixtureMember("reviewer"), lifecycleRunId: "ordinary-run" };
    writeTeamConfig("team", member);
    const details = { findings: [{ id: "F1", text: "x".repeat(4097), evidence: [] }], questions: Array.from({ length: 33 }, (_, index) => `Question ${index}?`) };
    const session = makeSession();
    let receipt: any;
    session.prompt.mockImplementation(async () => {
      const tool = piMocks.createAgentSession.mock.calls.at(-1)![0].customTools.find((item: any) => item.name === "report_and_exit");
      receipt = await tool.execute("ordinary", { content: "Complete ordinary report", ...details });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const options = makeRunOptions();
    await runReadAgentInProcess("team", member, "Review", { modelRegistry: { find: () => ({ provider: "provider", id: "model" }) } }, options);
    expect(receipt.details.accepted).toBe(true);
    const [event] = await listTeamReportEvents("team");
    expect(event.result).toMatchObject(details);
    expect(options.runningReadAgents.size).toBe(0);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it.each(["read", "write", "storage-failure"])("publishes checkpoint evidence before %s cleanup", async mode => {
    const observed: checkpointSource.SourceIdentity = { version: 1, cwd: root, repositoryRoot: root, head: null, inputs: ["src"], fileCount: 1, fingerprint: "a".repeat(64) };
    vi.spyOn(checkpointSource, "captureSourceIdentity").mockResolvedValue(observed);
    const member: Member = { ...fixtureMember("reviewer", mode === "write" ? "write" : "read"), lifecycleRunId: "checkpoint-run", prompt: "Review",
      checkpointAssignment: { originalPrompt: "Review", policy: { inputs: ["src"], retentionDays: 30, decisions: [] }, sourceBefore: observed } };
    writeTeamConfig("team", member);
    const write = checkpointDurability.writeJsonDurably;
    if (mode === "storage-failure") vi.spyOn(checkpointDurability, "writeJsonDurably").mockImplementation((file, value) => {
      if (file.startsWith(paths.checkpointFilesDir())) throw new Error("checkpoint unavailable"); write(file, value);
    });
    const session = makeSession();
    let transcript = "";
    session.prompt.mockImplementation(async () => {
      const created = piMocks.createAgentSession.mock.calls.at(-1)![0];
      transcript = created.sessionManager.getSessionFile(); fs.writeFileSync(transcript, "private fixture transcript");
      await created.customTools.find((tool: any) => tool.name === "report_and_exit").execute("report", { content: "Complete report", inspectedEvidence: ["src/auth.ts:4"] });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const options = makeRunOptions();
    await runReadAgentInProcess("team", member, "Review", { modelRegistry: { find: () => ({ provider: "provider", id: "model" }) } }, options);
    const [event] = await listTeamReportEvents("team");
    expect(event.checkpoint?.draft).toBeDefined();
    expect(fs.readFileSync(event.reportPath!, "utf8")).toBe("Complete report");
    expect(fs.existsSync(transcript)).toBe(mode === "storage-failure");
    if (mode === "storage-failure") expect(options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
    else {
      expect(checkpointStore.readCheckpoint(event.checkpoint!.id).inspectedEvidence).toEqual([{ reference: "src/auth.ts:4", reportId: event.id }]);
      expect(options.emitAgentReport.mock.calls[0][4]).toContain(event.checkpoint!.id);
      expect(options.runningReadAgents.size).toBe(0);
    }
  });

  it.each(["complete", "suppressed", "runtime-failure", "delivery-failure"])("preserves native events and independent grouped reports: %s", async mode => {
    const suppressed = mode === "suppressed";
    const group = await CompletionGroup.create({ teamName: "team", sessionId: "session", submissionId: mode,
      policy: { delivery: "all-settled" }, members: [{ name: "reader", suppressed }, { name: "writer", suppressed }] });
    if (!group) throw new Error("Expected a group");
    await group.seal();
    const options = { ...makeRunOptions(), renderLeadInboxStatus: vi.fn(async () => {}), notifyLeadOfInboxReports: vi.fn(async () => {}) };
    if (mode === "delivery-failure") vi.spyOn(messaging, "sendPlainMessageOnce").mockRejectedValue(new Error("index unavailable"));
    const count = mode.endsWith("failure") ? 1 : 2;
    for (let index = 0; index < count; index++) {
      const member = { ...fixtureMember(index ? "writer" : "reader", index ? "write" : "read"), lifecycleRunId: `run-${index}`,
        completionGroup: group.binding(index), ...(suppressed ? { metadata: { piPromptPlanning: { version: 1 } } } : {}) };
      writeTeamConfig("team", member);
      await group.apply({ type: "running", ...member.completionGroup, runId: member.lifecycleRunId });
      const session = makeSession();
      let transcript = "";
      session.prompt.mockImplementation(async () => {
        const created = piMocks.createAgentSession.mock.calls.at(-1)![0];
        transcript = created.sessionManager.getSessionFile();
        fs.writeFileSync(transcript, `${JSON.stringify({ type: "session", id: `fixture-${index}` })}\n`);
        if (mode === "runtime-failure") throw new Error("model unavailable");
        const tool = created.customTools.find((item: any) => item.name === "report_and_exit");
        await tool.execute(`report-${index}`, { content: `Independent report ${index}`, outcome: mode === "delivery-failure" ? "blocked" : "succeeded" });
      });
      piMocks.createAgentSession.mockResolvedValue({ session });
      await runReadAgentInProcess("team", member, "Work", { modelRegistry: { find: () => ({ provider: "provider", id: "model" }) } }, options);
      expect(session.dispose).toHaveBeenCalledOnce();
      if (mode === "complete" || suppressed) expect(fs.existsSync(transcript)).toBe(false);
    }
    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(count);
    for (const report of reports) {
      expect(report.completionGroup?.groupId).toBe(group.groupId);
      expect(fs.readFileSync(report.reportPath!, "utf8")).toBe(report.report);
    }
    expect(options.emitAgentReport).toHaveBeenCalledTimes(count);
    for (const call of options.emitAgentReport.mock.calls) expect(call[6]).toBe(true);
    const inbox = await readInbox("team", "team-lead", false, false);
    expect(inbox).toHaveLength(suppressed || mode === "delivery-failure" ? 0 : 1);
    if (inbox.length) expect(JSON.parse(inbox[0].text).kind).toBe(mode === "runtime-failure" ? "urgent" : "settled");
    if (suppressed) expect(options.notifyLeadOfInboxReports).not.toHaveBeenCalled();
    if (mode === "delivery-failure") expect(options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
    else expect(options.runningReadAgents.size).toBe(0);
  });

  it.each(["read", "write"] as const)("keeps a blocked %s task distinct from clean completion and duplicate submission", async role => {
    const member = { ...fixtureMember("reporter", role), lifecycleRunId: `${role}-run` };
    writeTeamConfig("team", member);
    const session = makeSession();
    session.prompt.mockImplementation(async () => {
      const reportTool = piMocks.createAgentSession.mock.calls[0][0].customTools.find((tool: any) => tool.name === "report_and_exit");
      const first = await reportTool.execute("first", {
        content: "Full report: requires a decision", summary: "Decision needed", outcome: "blocked",
        changedPaths: ["src/api.ts"], questions: ["Which API?"],
      });
      expect(first.details.accepted).toBe(true);
      const duplicate = await reportTool.execute("duplicate", { content: "Later claim", outcome: "succeeded" });
      expect(duplicate.details.accepted).toBe(false);
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const options = makeRunOptions();
    options.emitAgentReport.mockImplementation(() => {
      const stored = JSON.parse(fs.readFileSync(path.join(paths.teamDir("team"), "reports.json"), "utf8"));
      expect(stored[0].result.outcome).toBe("blocked");
    });
    await runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);
    const [persisted] = await listTeamReportEvents("team");
    expect(persisted).toMatchObject({
      id: `report:team:reporter:${role}-run`, status: "completed", report: "Full report: requires a decision",
      result: { version: 1, runId: `${role}-run`, outcome: "blocked", changedPaths: ["src/api.ts"], questions: ["Which API?"],
        verification: { state: "not-requested" }, acceptance: { state: "pending" } },
    });
    expect(options.rememberCompletedAgentReport.mock.calls[0][1].result).toEqual(persisted.result);
    expect(options.emitAgentReport).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(options.runningReadAgents.size).toBe(0);
  });

  it.each([
    ["read", "tool", 1], ["write", "tool", 0], ["read", "fallback", 0], ["write", "fallback", 1],
  ] as const)("verifies %s %s reports before closure using observed exit %s", async (role, mode, exitCode) => {
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "input.ts"), "tested input");
    const member = { ...fixtureMember("checked", role), cwd, lifecycleRunId: "check-run",
      assignedChecks: [{ name: "tests", command: "authorized command", timeoutSeconds: 2 }] };
    writeTeamConfig("team", member);
    const options = makeRunOptions();
    const admission: unknown[] = [];
    const exec = vi.fn(async (command: string, commandCwd: string, execution: { onData(data: Buffer): void }) => {
      const state = options.runningReadAgents.get("team:checked")!;
      admission.push({ command, cwd: commandCwd, accepting: state.acceptingMessages,
        closed: state.messageDeliveryClosed === true, fence: await readLifecycleTombstone("team", "checked") });
      execution.onData(Buffer.from("complete private log"));
      return { exitCode };
    });
    const session = makeSession();
    if (mode === "tool") session.prompt.mockImplementation(async () => {
      const tool = piMocks.createAgentSession.mock.calls[0][0].customTools.find((tool: any) => tool.name === "report_and_exit");
      const accepted = await tool.execute("report", {
        content: "Agent claims success", outcome: "succeeded", verification: { state: "passed" },
        checks: [{ name: "evil", command: "unassigned command", timeoutSeconds: 2 }],
      }, new AbortController().signal);
      expect(accepted.details).toMatchObject({ accepted: true, verification: { state: exitCode ? "failed" : "passed" } });
      expect((await tool.execute("duplicate", { content: "Duplicate" })).details.accepted).toBe(false);
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    options.emitAgentReport.mockImplementation(() => {
      const persisted = JSON.parse(fs.readFileSync(paths.reportEventsPath("team"), "utf8"))[0];
      expect(persisted.result.verification.state).toBe(exitCode ? "failed" : "passed");
      if (mode === "fallback" && role === "write") throw new Error("lead delivery failed");
    });
    await runReadAgentInProcess("team", member, "Work", {
      modelRegistry: { find: () => ({ provider: "provider", id: "model" }) },
    }, { ...options, loadCheckOperations: async () => ({ exec }) });
    expect(exec).toHaveBeenCalledOnce();
    const events = await listTeamReportEvents("team");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "completed", result: {
      verification: { state: exitCode ? "failed" : "passed" }, acceptance: { state: "pending" },
    } });
    expect(admission).toEqual([{ command: "authorized command", cwd: fs.realpathSync(cwd), accepting: true, closed: false, fence: { status: "absent" } }]);
    const record = (await new CheckJournal("team").read(events[0].result!.verification.checkIds![0]))!;
    expect(fs.readFileSync(record.logPath, "utf8")).toBe("complete private log");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(options.runningReadAgents.size).toBe(0);
  });

  it.each([
    ["tool", "repaired"], ["tool", "exhausted"], ["fallback", "repaired"], ["fallback", "exhausted"],
    ["tool", "declined"], ["tool", "terminated"], ["fallback", "terminated"],
  ] as const)("retains observed evidence when %s repair is %s", async (mode, ending) => {
    const repaired = ending === "repaired";
    const terminated = ending === "terminated";
    const checkCount = terminated || ending === "declined" ? 1 : 2;
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    const input = path.join(cwd, "input.ts");
    fs.writeFileSync(input, "broken");
    const member = { ...fixtureMember("repairer", repaired ? "write" : "read"), cwd, lifecycleRunId: "repair-run",
      assignedChecks: [{ name: "tests", command: "authorized", timeoutSeconds: 2 }], repairPolicy: { maxAttempts: 1 } };
    writeTeamConfig("team", member);
    const options = makeRunOptions();
    const session = makeSession();
    const receipts: any[] = [];
    const duplicateReceipts: any[] = [];
    const closedDuringChecks: boolean[] = [];
    const releasedDuringChecks: number[] = [];
    const exec = vi.fn(async (_command: string, _cwd: string, execution: { onData(data: Buffer): void }) => {
      closedDuringChecks.push(options.runningReadAgents.get("team:repairer")?.messageDeliveryClosed === true);
      releasedDuringChecks.push(options.releaseAllClaimsForAgent.mock.calls.length);
      const exitCode = fs.readFileSync(input, "utf8") === "fixed" ? 0 : 1;
      execution.onData(Buffer.from(`observed exit ${exitCode}`));
      return { exitCode };
    });
    session.prompt.mockImplementation(async () => {
      session.isStreaming = true;
      try {
        if (mode === "tool") {
          const tool = piMocks.createAgentSession.mock.calls[0][0].customTools.find((item: any) => item.name === "report_and_exit");
          for (let attempt = 0; attempt < 2; attempt++) {
            const receipt = await tool.execute(`report-${attempt}`, {
              content: attempt ? "Final repair report" : "Initial claim", outcome: attempt && ending === "declined" ? "blocked" : "succeeded",
            });
            receipts.push(receipt.details);
            if (!receipt.details.repairRequest) break;
            duplicateReceipts.push((await tool.execute(`report-${attempt}`, { content: "Initial claim", outcome: "succeeded" })).details);
            if (terminated) throw new Error("repair model terminated");
            if (repaired) fs.writeFileSync(input, "fixed");
          }
        } else {
          const repairing = session.prompt.mock.calls.length > 1;
          if (repairing && terminated) throw new Error("repair model terminated");
          if (repairing && repaired) fs.writeFileSync(input, "fixed");
          session.messages.push({ role: "assistant", content: repairing ? "Final repair report" : "Initial claim" });
        }
      } finally { session.isStreaming = false; }
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    if (mode === "fallback" && repaired) options.emitAgentReport.mockImplementationOnce(() => { throw new Error("lead delivery failed"); });
    await runReadAgentInProcess("team", member, "Work", {
      modelRegistry: { find: () => ({ provider: "provider", id: "model" }) },
    }, { ...options, loadCheckOperations: async () => ({ exec }) });
    const [report] = await listTeamReportEvents("team");
    expect(report).toMatchObject({ status: terminated ? "failed" : "completed",
      report: terminated ? expect.stringContaining("repair model terminated") : "Final repair report", result: {
      verification: { state: repaired ? "passed" : "failed" }, acceptance: { state: "pending" },
      repair: { state: terminated ? "cancelled" : ending, attemptsUsed: 1 },
    } });
    if (!repaired) expect(report.result?.repair?.outcome).toBe("blocked");
    if (mode === "tool") {
      expect(receipts).toMatchObject(terminated
        ? [{ accepted: false, repairRequest: { attempt: 1 } }]
        : [{ accepted: false, repairRequest: { attempt: 1 } }, { accepted: true }]);
      expect(report.result?.outcome).toBe(ending === "declined" ? "blocked" : "succeeded");
      expect(duplicateReceipts).toEqual([receipts[0]]);
    }
    if (!terminated) {
      const effective = repaired ? mode === "tool" ? "succeeded" : "unspecified" : "blocked";
      expect(options.emitAgentReport.mock.calls[0][4]).toContain(`repair: ${ending}; effective task: ${effective}`);
    }
    expect(session.prompt).toHaveBeenCalledTimes(mode === "tool" ? 1 : 2);
    expect(exec).toHaveBeenCalledTimes(checkCount);
    expect(closedDuringChecks).toEqual(Array(checkCount).fill(false));
    expect(releasedDuringChecks).toEqual(Array(checkCount).fill(0));
    expect(options.releaseAllClaimsForAgent).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("cancels repair when a report tool aborts after the controller decision", async () => {
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "input.ts"), "broken");
    const member = { ...fixtureMember("repairer", "write"), cwd, lifecycleRunId: "repair-run",
      assignedChecks: [{ name: "tests", command: "authorized", timeoutSeconds: 2 }], repairPolicy: { maxAttempts: 1 } };
    writeTeamConfig("team", member);
    const options = makeRunOptions();
    const session = makeSession();
    const exec = vi.fn(async () => ({ exitCode: 1 }));
    const abort = new AbortController();
    const verify = VerificationController.prototype.verify;
    vi.spyOn(VerificationController.prototype, "verify").mockImplementationOnce(async function (this: VerificationController, ...args) {
      const decision = await verify.apply(this, args);
      abort.abort();
      return decision;
    });
    session.prompt.mockImplementation(async () => {
      const tool = piMocks.createAgentSession.mock.calls[0][0].customTools.find((item: any) => item.name === "report_and_exit");
      await expect(tool.execute("initial", { content: "Initial claim", outcome: "succeeded" }, abort.signal)).rejects.toThrow("cancelled");
      await tool.execute("later", { content: "Final report", outcome: "succeeded" });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    await runReadAgentInProcess("team", member, "Work", {
      modelRegistry: { find: () => ({ provider: "provider", id: "model" }) },
    }, { ...options, loadCheckOperations: async () => ({ exec }) });
    expect((await listTeamReportEvents("team"))[0]).toMatchObject({ report: "Final report", result: {
      outcome: "succeeded", verification: { state: "failed" }, repair: { state: "cancelled", outcome: "blocked" },
    } });
    expect(exec).toHaveBeenCalledOnce();
  });

  it.each([undefined, 0, 1])("retains the effective outcome when initial repair publication fails (maxAttempts=%s)", async maxAttempts => {
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "input.ts"), "input");
    const member = { ...fixtureMember("repairer", "write"), cwd, lifecycleRunId: "repair-run",
      assignedChecks: [{ name: "tests", command: "authorized", timeoutSeconds: 2 }],
      ...(maxAttempts === undefined ? {} : { repairPolicy: { maxAttempts } }) };
    writeTeamConfig("team", member);
    const result = createReportResult("team", member.name, member.lifecycleRunId, { outcome: "succeeded" });
    const journalPath = new VerificationController({ teamName: "team", result, cwd }).journalPath;
    const failure = new Error("initial repair temporary write failed");
    const write = fs.writeFileSync;
    let failedWrites = 0;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (path.dirname(String(file)) === path.dirname(journalPath) && String(file).endsWith(".tmp")) {
        failedWrites++;
        throw failure;
      }
      return write(file, data, options);
    });
    const rename = vi.spyOn(fs, "renameSync");
    const options = makeRunOptions();
    const session = makeSession();
    const exec = vi.fn(async () => ({ exitCode: 1 }));
    const loadCheckOperations = vi.fn(async () => ({ exec }));
    let submissionFailure: unknown;
    session.prompt.mockImplementation(async () => {
      const tool = piMocks.createAgentSession.mock.calls[0][0].customTools.find((item: any) => item.name === "report_and_exit");
      await tool.execute("initial", { content: "Claimed success", outcome: "succeeded" }).catch((error: unknown) => {
        submissionFailure = error;
        throw error;
      });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    await runReadAgentInProcess("team", member, "Work", {
      modelRegistry: { find: () => ({ provider: "provider", id: "model" }) },
    }, { ...options, loadCheckOperations });

    const [saved]: { result: ReportResult; status: string; report: string }[] = JSON.parse(fs.readFileSync(paths.reportEventsPath("team"), "utf8"));
    const [observed] = await listTeamReportEvents("team");
    expect(effectiveTaskOutcome(saved.result)).toBe(maxAttempts ? "blocked" : "succeeded");
    expect(effectiveTaskOutcome(observed.result!)).toBe(maxAttempts ? "blocked" : "succeeded");
    for (const report of [saved, observed]) {
      expect(report.result).toMatchObject({ taskId: result.taskId, runId: result.runId, reportId: result.reportId,
        outcome: "succeeded", acceptance: { state: "pending" } });
      if (maxAttempts) {
        expect(report).toMatchObject({ status: "failed", report: expect.stringContaining(failure.message), result: {
          verification: { state: "pending", error: expect.stringContaining(failure.message) },
          repair: { controllerId: `repair:${path.basename(journalPath, ".json")}`, journalPath,
            state: "pending", outcome: "blocked", error: expect.stringContaining(failure.message) },
        } });
      } else {
        expect(report).toMatchObject({ status: "completed", report: "Claimed success", result: { verification: { state: "failed" } } });
        expect(report.result?.repair).toBeUndefined();
      }
    }
    expect(failedWrites).toBe(maxAttempts ? 1 : 0);
    expect(rename.mock.calls.some(([, to]) => String(to) === journalPath)).toBe(false);
    expect(fs.existsSync(journalPath)).toBe(false);
    if (maxAttempts) {
      expect(submissionFailure).toBe(failure);
      expect(saved.result.repair?.error).toBe(failure.message);
      expect(loadCheckOperations).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      expect(options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
      expect(options.runningReadAgents.get("team:repairer")).toMatchObject({ teardownState: "quarantined",
        finalizationBlockedReason: expect.stringContaining(failure.message) });
    } else {
      expect(submissionFailure).toBeUndefined();
      expect(exec).toHaveBeenCalledOnce();
      expect(options.releaseAllClaimsForAgent).toHaveBeenCalledOnce();
    }
  });

  it.each(["uncertain-publication", "missing-history"])("fences further repair after %s", async failure => {
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "input.ts"), "broken");
    const member = { ...fixtureMember("repairer", "write"), cwd, lifecycleRunId: "repair-run",
      assignedChecks: [{ name: "tests", command: "authorized", timeoutSeconds: 2 }], repairPolicy: { maxAttempts: 1 } };
    writeTeamConfig("team", member);
    const options = makeRunOptions();
    const session = makeSession();
    const exec = vi.fn(async () => ({ exitCode: 1 }));
    const rename = fs.renameSync;
    let publications = 0;
    let publishingFeedback = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).includes(`${path.sep}repairs${path.sep}`)) publishingFeedback = ++publications === 2;
    });
    const sync = fs.fsyncSync;
    const fault = vi.spyOn(fs, "fsyncSync").mockImplementation(descriptor => {
      if (failure === "uncertain-publication" && publishingFeedback && fs.fstatSync(descriptor).isDirectory()) throw new Error("repair reservation not durable");
      sync(descriptor);
    });
    let firstFailure: unknown;
    let nextFailure: unknown;
    session.prompt.mockImplementation(async () => {
      const tool = piMocks.createAgentSession.mock.calls[0][0].customTools.find((item: any) => item.name === "report_and_exit");
      firstFailure = await tool.execute("initial", { content: "First report", outcome: "succeeded" }).catch((error: unknown) => error);
      if (failure === "missing-history") {
        const receipt = firstFailure as { details: { repairRequest: { checks: { logPath: string }[] } } };
        const result = createReportResult("team", member.name, member.lifecycleRunId, {});
        fs.unlinkSync(new VerificationController({ teamName: "team", result, cwd }).journalPath);
        for (const check of receipt.details.repairRequest.checks) fs.unlinkSync(check.logPath.replace(/\.log$/, ".json"));
      }
      fault.mockRestore();
      nextFailure = await tool.execute("retry", { content: "Second report", outcome: "succeeded" }).catch((error: unknown) => error);
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    await runReadAgentInProcess("team", member, "Work", {
      modelRegistry: { find: () => ({ provider: "provider", id: "model" }) },
    }, { ...options, loadCheckOperations: async () => ({ exec }) });
    if (failure === "uncertain-publication") expect(firstFailure).toBeInstanceOf(Error);
    expect(exec).toHaveBeenCalledOnce();
    expect(nextFailure).toBeInstanceOf(Error);
    const [report] = await listTeamReportEvents("team");
    expect(report).toMatchObject({ status: "failed", checks: failure === "missing-history" ? [] : [{ state: "failed", exitCode: 1 }], result: {
      verification: { state: "pending", error: expect.stringContaining(failure === "missing-history" ? "ledger is unavailable" : "repair reservation not durable") },
      repair: { state: "pending", outcome: "blocked" },
    } });
    expect(options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
  });

  it("waits for the existing idle-session operation before starting lead follow-up work", async () => {
    const session = makeSession();
    session.isStreaming = false;
    let settle!: () => void;
    const active = new Promise<void>(resolve => { settle = resolve; });
    const state: RunningReadAgent = {
      runId: "run", teamName: "team", name: "reader", session: session as unknown as RunningReadAgent["session"], startedAt: Date.now(), tokensUsed: 0,
      status: "thinking", recentEvents: [], lastActivityAt: Date.now(), acceptingMessages: true,
      operationGeneration: 1, activeOperationGeneration: 1, activeOperationSettlementPromise: active,
    };
    const delivery = sendMessageToRunningReadAgent(state, "Follow up after the owned operation");
    await Promise.resolve();
    await Promise.resolve();
    const startedEarly = session.sendUserMessage.mock.calls.length > 0;
    state.activeOperationGeneration = undefined;
    state.activeOperationSettlementPromise = undefined;
    settle();
    await delivery;
    expect(startedEarly).toBe(false);
    expect(session.sendUserMessage).toHaveBeenCalledOnce();
  });

  it("cancels automatic repair before admitting a follow-up after a repair-command interrupt", async () => {
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "input.ts"), "broken");
    const member = { ...fixtureMember("repairer", "write"), cwd, lifecycleRunId: "repair-run",
      assignedChecks: [{ name: "tests", command: "authorized", timeoutSeconds: 2 }], repairPolicy: { maxAttempts: 1 } };
    writeTeamConfig("team", member);
    const options = makeRunOptions();
    const session = makeSession();
    const exec = vi.fn(async () => ({ exitCode: 1 }));
    let started!: () => void;
    let abortWork!: () => void;
    const repairStarted = new Promise<void>(resolve => { started = resolve; });
    const repairAborted = new Promise<void>(resolve => { abortWork = resolve; });
    session.prompt.mockImplementation(async () => {
      session.isStreaming = true;
      try {
        if (session.prompt.mock.calls.length === 1) return;
        const state = options.runningReadAgents.get("team:repairer")!;
        handleReadAgentSessionEvent(state, state.session!, { type: "tool_execution_start", toolName: "bash" }, options.renderReadAgentStatus);
        started();
        await repairAborted;
        throw new Error("repair command aborted");
      } finally { session.isStreaming = false; }
    });
    session.abort.mockImplementation(async () => { abortWork(); });
    session.sendUserMessage.mockImplementation(async () => {
      const tool = piMocks.createAgentSession.mock.calls[0][0].customTools.find((item: any) => item.name === "report_and_exit");
      await tool.execute("follow-up", { content: "Stopped repair", outcome: "succeeded" });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const running = runReadAgentInProcess("team", member, "Work", {
      modelRegistry: { find: () => ({ provider: "provider", id: "model" }) },
    }, { ...options, loadCheckOperations: async () => ({ exec }) });
    await repairStarted;
    const state = options.runningReadAgents.get("team:repairer")!;
    const interrupt = createTeammateInterrupter({ ...options, terminal: null, settleTimeoutMs: 1000 });
    const interrupted = await interrupt("repairer");
    const followup = sendMessageToRunningReadAgent(state, "Report now; do not repair again").catch(() => {});
    await Promise.all([running, followup]);
    const [report] = await listTeamReportEvents("team");
    expect(interrupted.status).toBe("interrupted");
    expect(report).toMatchObject({ report: "Stopped repair", result: {
      outcome: "succeeded", verification: { state: "failed" }, repair: { state: "cancelled", outcome: "blocked" },
    } });
    expect(exec).toHaveBeenCalledOnce();
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(options.releaseAllClaimsForAgent).toHaveBeenCalledOnce();
  });

  it.each([
    ["tool", false], ["fallback", false], ["tool", true], ["fallback", true],
  ] as const)("resumes after interrupting an assigned %s check without replay (repair=%s)", async (mode, withRepair) => {
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "input.ts"), "input");
    const member = { ...fixtureMember("checked"), cwd, lifecycleRunId: "run",
      assignedChecks: [{ name: "tests", command: "authorized", timeoutSeconds: 2 }],
      ...(withRepair ? { repairPolicy: { maxAttempts: 1 } } : {}) };
    writeTeamConfig("team", member);
    const options = makeRunOptions();
    const session = makeSession();
    let started!: () => void;
    const commandStarted = new Promise<void>(resolve => { started = resolve; });
    const exec = vi.fn(async (_command: string, _cwd: string, execution: { signal?: AbortSignal }) => {
      started();
      const signal = execution.signal;
      if (!signal) throw new Error("Assigned checks require a cancellation signal.");
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { exitCode: null };
    });
    const reportTool = () => piMocks.createAgentSession.mock.calls[0][0].customTools.find((tool: any) => tool.name === "report_and_exit");
    session.prompt.mockImplementation(async () => {
      try {
        if (mode === "tool") await reportTool().execute("initial", { content: "Initial claim", outcome: "succeeded" });
      } finally { session.isStreaming = false; }
    });
    session.abort.mockImplementation(async () => { session.isStreaming = false; });
    session.sendUserMessage.mockImplementation(async () => {
      await reportTool().execute("resumed", { content: "New report after interruption", outcome: "blocked" });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const running = runReadAgentInProcess("team", member, "Work", {
      modelRegistry: { find: () => ({ provider: "provider", id: "model" }) },
    }, { ...options, loadCheckOperations: async () => ({ exec }) });
    await commandStarted;
    const state = options.runningReadAgents.get("team:checked")!;
    const interrupt = createTeammateInterrupter({ ...options, terminal: null, settleTimeoutMs: 1000 });
    expect((await interrupt("checked")).status).toBe("interrupted");
    expect(state.acceptingMessages).toBe(true);
    expect(state.messageDeliveryClosed).not.toBe(true);
    expect(session.dispose).not.toHaveBeenCalled();
    expect(options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
    await sendMessageToRunningReadAgent(state, "Report the blocker now").catch(() => {});
    await running;
    const [report] = await listTeamReportEvents("team");
    expect(report).toMatchObject({ report: "New report after interruption", result: {
      outcome: "blocked", verification: { state: "failed" }, acceptance: { state: "pending" },
      ...(withRepair ? { repair: { state: "cancelled" } } : {}),
    } });
    expect(exec).toHaveBeenCalledOnce();
    expect(options.releaseAllClaimsForAgent).toHaveBeenCalledOnce();
    expect(options.runningReadAgents.size).toBe(0);
  });

  it.each(["complete", "interrupt", "plaintext", "two-followups", "interrupt-recheck", "reject-report"])("preserves fallback verification ownership with overlapping lead work: %s", async mode => {
    const burst = mode === "two-followups" || mode === "interrupt-recheck";
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    };
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "input.ts"), "input");
    const member = { ...fixtureMember("checked"), cwd, lifecycleRunId: "run",
      assignedChecks: [{ name: "tests", command: "authorized", timeoutSeconds: 2 }] };
    writeTeamConfig("team", member);
    const options = makeRunOptions();
    const session = makeSession();
    const started = deferred();
    const finishCheck = deferred();
    const finishFollowup = deferred();
    const firstFollowupStarted = deferred();
    const secondFollowupStarted = deferred();
    const finishSecondFollowup = deferred();
    const tailCaptured = deferred();
    const recheckStarted = deferred();
    const finishRecheck = deferred();
    let recheckHeld = false;
    let recheckAdmission: boolean | undefined;
    let secondQueued = false;
    let secondCompleted = false;
    let verifiedBeforeSecondCompleted = false;
    const claim = CheckJournal.prototype.claim;
    vi.spyOn(CheckJournal.prototype, "claim").mockImplementation(function (this: CheckJournal, assignment) {
      verifiedBeforeSecondCompleted ||= secondQueued && !secondCompleted;
      if (secondCompleted && recheckAdmission === undefined) recheckAdmission = options.runningReadAgents.get("team:checked")?.acceptingMessages;
      if (secondCompleted && mode === "interrupt-recheck" && !recheckHeld) {
        recheckHeld = true;
        recheckStarted.resolve();
        return finishRecheck.promise.then(() => claim.call(this, assignment));
      }
      return claim.call(this, assignment);
    });
    let followupAborted = false;
    let overlapped = false;
    const exec = vi.fn(async (_command: string, _cwd: string, execution: { signal?: AbortSignal }) => {
      execution.signal?.addEventListener("abort", finishCheck.resolve, { once: true });
      started.resolve();
      await finishCheck.promise;
      return { exitCode: 0 };
    });
    const reportTool = () => piMocks.createAgentSession.mock.calls[0][0].customTools.find((tool: any) => tool.name === "report_and_exit");
    session.prompt.mockImplementation(async () => { session.isStreaming = false; });
    session.sendUserMessage.mockImplementation(async () => {
      overlapped ||= options.runningReadAgents.get("team:checked")?.checkOperation !== undefined;
      session.isStreaming = true;
      try {
        const second = session.sendUserMessage.mock.calls.length === 2;
        (second ? secondFollowupStarted : firstFollowupStarted).resolve();
        await (second ? finishSecondFollowup : finishFollowup).promise;
        if (!followupAborted) {
          if (mode === "plaintext" || (burst && session.sendUserMessage.mock.calls.length <= 2)) {
            session.messages.push({ role: "assistant", content: burst && !second ? "First follow-up" : "Follow-up report" });
          } else await reportTool().execute("followup", { content: "Follow-up report", outcome: "blocked" });
        }
        if (second) secondCompleted = true;
      } finally { session.isStreaming = false; }
    });
    session.abort.mockImplementation(async () => {
      if (session.isStreaming) { followupAborted = true; finishFollowup.resolve(); finishSecondFollowup.resolve(); }
      session.isStreaming = false;
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const running = runReadAgentInProcess("team", member, "Work", {
      modelRegistry: { find: () => ({ provider: "provider", id: "model" }) },
    }, { ...options, loadCheckOperations: async () => ({ exec }) });
    await started.promise;
    const state = options.runningReadAgents.get("team:checked")!;
    let rejected = false;
    let delivery = Promise.resolve();
    if (mode === "reject-report") {
      rejected = await reportTool().execute("overlap", { content: "Rejected report", outcome: "blocked" }).then(() => false, () => true);
    } else {
      delivery = sendMessageToRunningReadAgent(state, "Process this follow-up before finishing").then(() => {}, () => {});
    }
    if (burst) {
      let tail = state.messageDeliveryTail;
      Object.defineProperty(state, "messageDeliveryTail", {
        get: () => { if (!state.checkOperation) tailCaptured.resolve(); return tail; },
        set: value => { tail = value; },
      });
    }
    await Promise.resolve();
    let interruptStatus: string | undefined;
    if (mode === "interrupt") {
      const interrupt = createTeammateInterrupter({ ...options, terminal: null, settleTimeoutMs: 1000 });
      interruptStatus = (await interrupt("checked")).status;
    } else { finishCheck.resolve(); }
    if (burst) {
      await Promise.all([firstFollowupStarted.promise, tailCaptured.promise]);
      secondQueued = true;
      const secondDelivery = sendMessageToRunningReadAgent(state, "Include this second follow-up").then(() => {}, () => {});
      delivery = Promise.all([delivery, secondDelivery]).then(() => {});
      finishFollowup.resolve();
      await secondFollowupStarted.promise;
    }
    let closedEarly = state.messageDeliveryClosed === true;
    let releasedEarly = options.releaseAllClaimsForAgent.mock.calls.length > 0;
    finishFollowup.resolve();
    finishSecondFollowup.resolve();
    await delivery;
    let resumedAdmission: boolean | undefined;
    if (mode === "interrupt-recheck") {
      await recheckStarted.promise;
      const interrupt = createTeammateInterrupter({ ...options, terminal: null, settleTimeoutMs: 1000 });
      const interrupted = interrupt("checked");
      finishRecheck.resolve();
      interruptStatus = (await interrupted).status;
      resumedAdmission = state.acceptingMessages;
      closedEarly ||= state.messageDeliveryClosed === true;
      releasedEarly ||= options.releaseAllClaimsForAgent.mock.calls.length > 0;
      await sendMessageToRunningReadAgent(state, "Resume and report").catch(() => {});
    }
    await running;
    expect(overlapped).toBe(false);
    expect(verifiedBeforeSecondCompleted).toBe(false);
    if (burst) expect(recheckAdmission).toBe(false);
    if (mode === "two-followups") expect(session.sendUserMessage).toHaveBeenCalledTimes(2);
    if (mode === "interrupt-recheck") expect(resumedAdmission).toBe(true);
    expect(closedEarly).toBe(false);
    expect(releasedEarly).toBe(false);
    if (mode === "interrupt" || mode === "interrupt-recheck") expect(interruptStatus).toBe("interrupted");
    if (mode === "reject-report") expect(rejected).toBe(true);
    const [report] = JSON.parse(fs.readFileSync(paths.reportEventsPath("team"), "utf8"));
    expect(report.report).toBe(mode === "reject-report" ? "final report" : "Follow-up report");
    expect(report.result.outcome).toBe(["reject-report", "plaintext", "two-followups"].includes(mode) ? undefined : "blocked");
    expect(report.result.verification.state).toBe(mode === "interrupt" ? "failed" : "passed");
    expect(exec).toHaveBeenCalledOnce();
    expect(options.runningReadAgents.size).toBe(0);
  });

  it.each(["plaintext", "tool"])("preserves an admitted %s follow-up that finishes before fallback verification", async mode => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    };
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "input.ts"), "input");
    const member = { ...fixtureMember("checked"), cwd, lifecycleRunId: "run",
      assignedChecks: [{ name: "tests", command: "authorized", timeoutSeconds: 2 }] };
    writeTeamConfig("team", member);
    const options = makeRunOptions();
    const session = makeSession();
    const promptEnding = deferred();
    const finishPrompt = deferred();
    const followupStarted = deferred();
    const finishFollowup = deferred();
    const fallbackReached = deferred();
    const checkStarted = deferred();
    const finishCheck = deferred();
    const exec = vi.fn(async () => {
      checkStarted.resolve();
      await finishCheck.promise;
      return { exitCode: 0 };
    });
    session.prompt.mockImplementation(async () => {
      session.isStreaming = false;
      promptEnding.resolve();
      await finishPrompt.promise;
    });
    let reportAccepted: boolean | undefined;
    let reportError: unknown;
    session.sendUserMessage.mockImplementation(async () => {
      session.isStreaming = true;
      followupStarted.resolve();
      await finishFollowup.promise;
      try {
        if (mode === "plaintext") {
          session.messages.push({ role: "assistant", content: "Latest follow-up report" });
        } else {
          const tool = piMocks.createAgentSession.mock.calls[0][0].customTools.find((tool: any) => tool.name === "report_and_exit");
          const response = await tool.execute("followup", { content: "Latest follow-up report", outcome: "blocked" });
          reportAccepted = response.details.accepted;
        }
      } catch (error) { reportError = error; }
      finally { session.isStreaming = false; }
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const running = runReadAgentInProcess("team", member, "Work", {
      modelRegistry: { find: () => ({ provider: "provider", id: "model" }) },
    }, { ...options, loadCheckOperations: async () => ({ exec }) });
    await promptEnding.promise;
    const state = options.runningReadAgents.get("team:checked")!;
    const delivery = sendMessageToRunningReadAgent(state, "Include the latest findings").catch(() => false);
    let tail = state.messageDeliveryTail;
    Object.defineProperty(state, "messageDeliveryTail", {
      get: () => { fallbackReached.resolve(); return tail; },
      set: value => { tail = value; },
    });
    // The admitted idle-session delivery waits for the initial prompt to settle.
    // Reach the drain (fixed) or check (buggy), then finish delivery before the check.
    finishPrompt.resolve();
    await followupStarted.promise;
    await Promise.race([fallbackReached.promise, checkStarted.promise]);
    const overlapped = state.checkOperation !== undefined;
    finishFollowup.resolve();
    if (mode === "plaintext" || overlapped) await delivery;
    await checkStarted.promise;
    expect(session.dispose).not.toHaveBeenCalled();
    expect(options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
    finishCheck.resolve();
    await delivery;
    await running;

    expect(reportError).toBeUndefined();
    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: "completed", report: "Latest follow-up report", result: {
      runId: "run", verification: { state: "passed" }, acceptance: { state: "pending" },
    } });
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      report: "Latest follow-up report", result: reports[0].result,
    }));
    expect(options.emitAgentReport).toHaveBeenCalledOnce();
    expect(options.emitAgentReport.mock.calls[0][4]).toContain("Latest follow-up report");
    if (mode === "tool") {
      expect(reportAccepted).toBe(true);
      expect(reports[0].result?.outcome).toBe("blocked");
    }
    expect(overlapped).toBe(false);
    expect(exec).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(options.releaseAllClaimsForAgent).toHaveBeenCalledOnce();
    expect(options.runningReadAgents.size).toBe(0);
  });

  it("does not finalize a run with an unresolved durable check claim", async () => {
    const member = { ...fixtureMember("checked"), lifecycleRunId: "run",
      assignedChecks: [{ name: "tests", command: "authorized", timeoutSeconds: 2 }] };
    writeTeamConfig("team", member);
    const result = createReportResult("team", "checked", "run", {});
    const { record } = await new CheckJournal("team").claim({ ...member.assignedChecks[0],
      taskId: result.taskId, runId: result.runId, reportId: result.reportId, cwd: member.cwd, attempt: 1 });
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const options = makeRunOptions();
    const loadCheckOperations = vi.fn();
    await runReadAgentInProcess("team", member, "Work", {
      modelRegistry: { find: () => ({ provider: "provider", id: "model" }) },
    }, { ...options, loadCheckOperations });
    expect(options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
    expect(loadCheckOperations).not.toHaveBeenCalled();
    expect(options.runningReadAgents.get("team:checked")?.teardownState).toBe("quarantined");
    const reports = await listTeamReportEvents("team");
    expect(reports[0]).toMatchObject({ status: "failed", result: { verification: { state: "pending", checkIds: [record.checkId] } } });
  });

  it.each(["read", "write"] as const)("moves a direct %s agent to Herdr without finalizing its session or mailbox", async (role) => {
    vi.stubEnv("HERDR_ENV", "1");
    const member = fixtureMember(role === "read" ? "reader" : "writer", role);
    const session = Object.assign(makeSession(), {
      model: { provider: "host", id: "current/model" }, thinkingLevel: "high",
      agent: { state: { systemPrompt: `scoped ${role} authority`, tools: ["read", "read_inbox",
        ...Array.from({ length: 20 }, (_, i) => `allowed_extension_tool_${i}`)].map(name => ({ name })) } },
    });
    let finish!: () => void;
    let releaseAbort!: () => void;
    const abortGate = new Promise<void>(resolve => { releaseAbort = resolve; });
    let sessionFile = "";
    session.prompt.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    session.abort.mockImplementation(async () => { await abortGate; finish(); });
    session.clearQueue.mockReturnValueOnce({ steering: ["queued guidance"], followUp: [] });
    const append = vi.fn(message => fs.appendFileSync(sessionFile, `\n${JSON.stringify(message)}`));
    piMocks.sessionManagerOpen.mockImplementation(() => ({ appendMessage: append, getEntries: () => [] }));
    piMocks.createAgentSession.mockImplementation(async (options) => {
      sessionFile = options.sessionManager.getSessionFile();
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, "existing conversation");
      return { session };
    });
    const options = makeRunOptions();
    const run = runReadAgentInProcess("team", member, "finish the assigned work", { modelRegistry: { find: () => ({ id: "model" }) } }, options);
    try {
      await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledOnce());
      const state = options.runningReadAgents.get(`team:${member.name}`)!;
      let launches = 0;
      let refuseClose = role === "write";
      let paneGone = false;
      vi.mocked(spawnSync).mockImplementation((_command, argv) => {
        const args = argv as string[];
        // Pi can resume before Herdr's agent detection catches up.
        if (args[0] === "agent" && args[1] === "focus") return { pid: 0, output: [], signal: null, status: 1,
          stdout: "", stderr: "agent_not_found" };
        if (args[1] === "close" && refuseClose) return { pid: 0, output: [], signal: null, status: 1, stderr: "closure unconfirmed", stdout: "" };
        if (args[1] === "close" && paneGone) return { pid: 0, output: [], signal: null, status: 1, stdout: "",
          stderr: JSON.stringify({ error: { code: "pane_not_found" } }) };
        if (args[1] === "run") {
          expect(session.dispose).toHaveBeenCalledOnce();
          // A fresh macOS PTY can truncate a long line before the shell is ready.
          expect(Buffer.byteLength(args[3])).toBeLessThan(1024);
          const launchFile = path.join(path.dirname(sessionFile), "herdr-launch.sh");
          expect(args[3]).toBe(`/bin/sh '${launchFile}'`);
          const launch = fs.readFileSync(launchFile, "utf8");
          expect(fs.statSync(launchFile).mode & 0o777).toBe(0o600);
          expect(launch.startsWith("exec env ")).toBe(true);
          expect(launch).toContain(sessionFile);
          expect(launch).toContain(state.runId);
          expect(launch).toContain(`--tools '${session.agent.state.tools.map(tool => tool.name).join(",")}'`);
          expect(launch).toContain("--model 'host/current/model:high'");
          expect(launch).toContain(`HOME='${root}'`);
          if (++launches > 1) void runtime.writeRuntimeStatus("team", member.name, state.runId, { pid: process.pid + 1 });
        }
        return { pid: 0, output: [], signal: null, status: args[1] === "run" && launches === 1 ? 1 : 0,
          stderr: "launch refused", stdout: JSON.stringify({ result: { pane: { pane_id: "owned-pane" } } }) };
      });
      expect(state.moveToHerdr).toBeTypeOf("function");
      const moving = state.moveToHerdr!();
      expect(state.moveToHerdr!()).toBe(moving);
      await vi.waitFor(() => expect(session.abort).toHaveBeenCalledOnce());
      expect(launches).toBe(0);
      releaseAbort();
      await expect(moving).rejects.toThrow(/launch refused|closure unconfirmed/);
      if (refuseClose) {
        await expect(state.moveToHerdr!()).rejects.toThrow("closure unconfirmed");
        expect(launches).toBe(1);
        refuseClose = false;
      }
      expect(fs.readFileSync(sessionFile, "utf8")).toContain("existing conversation");
      expect(fs.readFileSync(path.join(path.dirname(sessionFile), "herdr-system-prompt.txt"), "utf8")).toBe(`scoped ${role} authority`);
      await sendPlainMessageIfRunning("team", "team-lead", member.name, "follow-up", "follow-up");
      await state.moveToHerdr!();
      expect(spawnSync).toHaveBeenCalledWith("herdr",
        ["pane", "split", "--current", "--direction", "right", "--cwd", member.cwd, "--focus"], expect.any(Object));
      expect(options.runningReadAgents.has(`team:${member.name}`)).toBe(false);
      expect(append).toHaveBeenCalledExactlyOnceWith({ role: "user", content: "queued guidance", timestamp: expect.any(Number) });
      expect(fs.readFileSync(sessionFile, "utf8")).toContain("queued guidance");
      expect((await teams.readConfig("team")).members.find(item => item.name === member.name)).toMatchObject({
        lifecycleRunId: state.runId, herdrPaneId: "owned-pane",
      });
      expect((await readInbox("team", member.name, true, false)).map(message => message.text)).toContain("follow-up");
      expect(options.emitAgentReport).not.toHaveBeenCalled();
      expect(options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
      expect(await readLifecycleTombstone("team", member.name)).toEqual({ status: "absent" });
      const pidFile = path.join(paths.teamDir("team"), `${member.name}.pid`);
      fs.writeFileSync(pidFile, "424242");
      paneGone = true;
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      await createLifecycleRuntime({ ...options, terminal: null, getSessionCwd: () => root, drainWriteQueue: async () => {} })
        .killTeammate("team", (await teams.readConfig("team")).members.find(item => item.name === member.name)!);
      expect(kill).not.toHaveBeenCalledWith(424242, "SIGKILL");
      const closedPanes = vi.mocked(spawnSync).mock.calls.map(([, args]) => args as string[]).filter(args => args[1] === "close");
      expect(closedPanes.map(args => args[2])).toEqual(Array(role === "write" ? 4 : 2).fill("owned-pane"));
      expect(fs.existsSync(pidFile)).toBe(false);
    } finally {
      releaseAbort();
      finish?.();
      await run;
      vi.mocked(spawnSync).mockReset();
      vi.unstubAllEnvs();
    }
  });

  it("rejects Herdr transfer while an assigned fallback check is active", async () => {
    vi.stubEnv("HERDR_ENV", "1");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet"], { cwd });
    fs.writeFileSync(path.join(cwd, "input.ts"), "input");
    const member = { ...fixtureMember("checked"), cwd, lifecycleRunId: "run",
      assignedChecks: [{ name: "tests", command: "authorized", timeoutSeconds: 2 }] };
    writeTeamConfig("team", member);
    const session = Object.assign(makeSession(), {
      model: { provider: "host", id: "current/model" }, thinkingLevel: "high",
      agent: { state: { systemPrompt: "scoped read authority", tools: ["read", "read_inbox"].map(name => ({ name })) } },
    });
    session.prompt.mockImplementation(async () => { session.isStreaming = false; });
    let sessionFile = "";
    piMocks.createAgentSession.mockImplementation(async (options) => {
      sessionFile = options.sessionManager.getSessionFile();
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, "existing conversation");
      return { session };
    });
    let releaseCheck!: () => void;
    const checkFinished = new Promise<void>(resolve => { releaseCheck = resolve; });
    let checkStarted!: () => void;
    const checkStartedPromise = new Promise<void>(resolve => { checkStarted = resolve; });
    const exec = vi.fn(async (_command: string, _commandCwd: string, execution: { signal?: AbortSignal }) => {
      checkStarted();
      await checkFinished;
      return { exitCode: 0 };
    });
    // Keep cleanup bounded if the regression is present: let the buggy transfer finish after release.
    vi.mocked(spawnSync).mockImplementation((_command, argv) => {
      const args = argv as string[];
      if (args[1] === "split") return { pid: 0, output: [], signal: null, status: 0, stderr: "", stdout: JSON.stringify({ result: { pane: { pane_id: "active-check-pane" } } }) };
      return { pid: 0, output: [], signal: null, status: 0, stderr: "", stdout: "" };
    });
    vi.spyOn(runtime, "readRuntimeStatus")
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ lifecycleRunId: "run", pid: process.pid + 1 } as any);
    const options = makeRunOptions();
    const running = runReadAgentInProcess("team", member, "finish the assigned work", {
      modelRegistry: { find: () => ({ id: "model" }) },
    }, { ...options, loadCheckOperations: async () => ({ exec }) });
    let moving: Promise<void> | undefined;
    let retry: Promise<void> | undefined;
    try {
      await checkStartedPromise;
      const state = options.runningReadAgents.get("team:checked")!;
      expect(state.checkOperation).toBeDefined();
      moving = state.moveToHerdr!();
      await Promise.resolve();
      expect(spawnSync).not.toHaveBeenCalled();
      await expect(moving).rejects.toThrow(/assigned check is active/);
      retry = state.moveToHerdr!();
      expect(retry).not.toBe(moving);
      await expect(retry).rejects.toThrow(/assigned check is active/);
      expect(spawnSync).not.toHaveBeenCalled();
      expect(session.dispose).not.toHaveBeenCalled();
      expect(state.stopRequested).not.toBe(true);
      expect(state.messageDeliveryClosed).not.toBe(true);
      expect(options.runningReadAgents.has("team:checked")).toBe(true);
    } finally {
      releaseCheck();
      await Promise.allSettled([running, moving, retry].filter((operation): operation is Promise<void> => Boolean(operation)));
      vi.mocked(spawnSync).mockReset();
    }
    expect(sessionFile).not.toBe("");
    expect(exec).toHaveBeenCalledOnce();
    expect((await listTeamReportEvents("team"))[0]).toMatchObject({
      status: "completed", report: "final report", result: { verification: { state: "passed" } },
    });
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(options.releaseAllClaimsForAgent).toHaveBeenCalledOnce();
    expect(options.runningReadAgents.size).toBe(0);
  });

  it.each([{ delegationDepth: 1 }, { allowNestedReadAgents: true }])("keeps unsupported Herdr runs in-process: %j", async (scope) => {
    vi.stubEnv("HERDR_ENV", "1");
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const options = makeRunOptions();
    const registration = vi.spyOn(options.runningReadAgents, "set");
    try {
      await runReadAgentInProcess("team", { ...fixtureMember("reader"), ...scope }, "inspect", { modelRegistry: { find: () => ({ id: "model" }) } }, options);
      expect(session.prompt).toHaveBeenCalledOnce();
      expect(registration.mock.calls[0][1].moveToHerdr).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });

  it("answers the child task probe on its private event bus and removes it during teardown", async () => {
    const member = eligibleNestedParent("writer");
    writeTeamConfig("team", member);
    const session = makeSession();
    const nestedChildSnapshot = vi.fn(() => ({ running: 1, queued: 2 }));
    const response = vi.fn();
    let childSessionId = "";
    session.bindExtensions.mockImplementation(async () => {
      const childSessionManager = piMocks.sessionManagerCreate.mock.results.at(-1)?.value;
      if (!childSessionManager) throw new Error("child session manager was not created");
      childSessionId = childSessionManager.getSessionId();
      piMocks.loaderOptions.at(-1)?.eventBus?.emit("pi-extended-teams:child-agent-lifecycle-probe", {
        sessionId: childSessionId, respond: response,
      });
    });
    session.prompt.mockImplementation(async () => {
      const reportTool = piMocks.createAgentSession.mock.calls[0][0].customTools
        .find((tool: any) => tool.name === "report_and_exit");
      await reportTool.execute("report", { content: "Finished", summary: "Done" });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const options = {
      ...makeRunOptions(),
      nestedChildSnapshot,
      pendingChildController: createPendingChildController(),
    };

    await runReadAgentInProcess("team", member, "finish", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);

    expect(nestedChildSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      teamName: "team", parent: member, parentRunId: expect.any(String),
    }));
    expect(response).toHaveBeenCalledWith({ sessionId: childSessionId, running: 1, queued: 2 });
    const responseAfterTeardown = vi.fn();
    piMocks.loaderOptions.at(-1).eventBus.emit("pi-extended-teams:child-agent-lifecycle-probe", {
      sessionId: childSessionId, respond: responseAfterTeardown,
    });
    expect(responseAfterTeardown).not.toHaveBeenCalled();
  });

  it("isolates completed report persistence in the test temp directory", () => {
    expect(paths.reportFilesDir()).toBe(path.join(root, "agent", "reports"));
  });

  it("steers scope updates directly into an active in-process agent", async () => {
    const session = makeSession();
    const state: RunningReadAgent = {
      runId: "run-1",
      name: "reader",
      teamName: "team",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "working",
      recentEvents: [],
      lastActivityAt: Date.now(),
      session: session as any,
      acceptingMessages: true,
    };

    await expect(sendMessageToRunningReadAgent(state, "Inspect the new bash screenshot too.")).resolves.toBe(true);

    expect(session.sendUserMessage).toHaveBeenCalledWith(
      "Inspect the new bash screenshot too.",
      { deliverAs: "steer" }
    );
    expect(state.status).toBe("thinking");
    expect(state.recentEvents).toContain("received lead message");
  });

  it("closes message admission without waiting for an in-flight session delivery", async () => {
    const session = makeSession();
    let finishDelivery!: () => void;
    session.sendUserMessage.mockImplementation(() => new Promise<void>((resolve) => { finishDelivery = resolve; }));
    const state: RunningReadAgent = {
      runId: "run-1",
      name: "reader",
      teamName: "team",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "working",
      recentEvents: [],
      lastActivityAt: Date.now(),
      session: session as any,
      acceptingMessages: true,
      messageDeliveryClosed: false,
    };

    const delivery = sendMessageToRunningReadAgent(state, "Finish this evidence source.");
    const deliveryOutcome = delivery.then(() => "delivered", (error: Error) => error.message);
    await vi.waitFor(() => expect(session.sendUserMessage).toHaveBeenCalledOnce());
    const close = closeReadAgentMessageDelivery(state);

    expect(state.messageDeliveryClosed).toBe(true);
    expect(close.cancelledDeliveries).toBe(1);
    await expect(deliveryOutcome).resolves.toContain("was cancelled");
    await expect(sendMessageToRunningReadAgent(state, "New work.")).rejects.toThrow("agent is finishing");

    finishDelivery();
    await close.rawDeliverySettlement;
  });

  it("rejects scope updates once an in-process agent is finishing", async () => {
    const session = makeSession();
    const state: RunningReadAgent = {
      runId: "run-1",
      name: "reader",
      teamName: "team",
      startedAt: Date.now(),
      tokensUsed: 0,
      status: "finishing",
      recentEvents: [],
      lastActivityAt: Date.now(),
      session: session as any,
      acceptingMessages: false,
    };

    await expect(sendMessageToRunningReadAgent(state, "Continue.")).rejects.toThrow(
      "Cannot send message to reader: agent is finishing."
    );
    expect(session.sendUserMessage).not.toHaveBeenCalled();
    await expect(sendMessageToRunningReadAgent(undefined, "Continue.")).resolves.toBe(false);
  });

  it("closes recipient delivery before asynchronous in-process cleanup", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    let finishClaimRelease!: () => void;
    const releaseAllClaimsForAgent = vi.fn(() => new Promise<string[]>((resolve) => {
      finishClaimRelease = () => resolve([]);
    }));
    const member: Member = {
      agentId: "reader@team",
      name: "reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
    };
    writeTeamConfig("team", member);
    const run = runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent,
    });

    await vi.waitFor(() => expect(releaseAllClaimsForAgent).toHaveBeenCalledWith("team", "reader"));
    const duringCleanup = JSON.parse(fs.readFileSync(paths.configPath("team"), "utf-8"));
    expect(duringCleanup.members.find((item: Member) => item.name === "reader")?.isActive).toBe(false);
    expect(runningReadAgents.has("team:reader")).toBe(true);
    const rejectedRecipient = expect(requireRunningMessageRecipient("team", "reader"))
      .rejects.toThrow("agent is not running");

    finishClaimRelease();
    await run;
    await rejectedRecipient;
    expect(runningReadAgents.size).toBe(0);
  });

  it("resolves models whose qualified key contains slashes in the model id", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const slashModelKey = "fireworks/fireworks:accounts/fireworks/routers/glm-5p3-fast";
    const settingsPath = path.join(root, ".pi", "agent", "pi-extended-teams", "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({
      favoriteModels: {
        "reading-default": { model: slashModelKey, thinking: "high" },
        "writing-basic": { model: "provider/model", thinking: "high" },
        "writing-hard": { model: "provider/model", thinking: "xhigh" },
        "write-feature": { model: "provider/model", thinking: "medium" },
        "write-critical": { model: "provider/model", thinking: "xhigh" },
      },
    }));
    const member = { ...fixtureMember("reader"), model: slashModelKey, prompt: "investigate" };
    writeTeamConfig("team", member);
    const find = vi.fn((provider: string, modelId: string) =>
      provider === "fireworks" && modelId === "fireworks:accounts/fireworks/routers/glm-5p3-fast"
        ? { provider: "fireworks", id: "fireworks:accounts/fireworks/routers/glm-5p3-fast" }
        : undefined);
    const releaseAllClaimsForAgent = vi.fn(async () => [] as string[]);

    const run = runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find },
    }, {
      ...makeRunOptions(),
      releaseAllClaimsForAgent,
    });

    await vi.waitFor(() => expect(releaseAllClaimsForAgent).toHaveBeenCalledWith("team", "reader"));
    expect(find).toHaveBeenCalledWith("fireworks", "fireworks:accounts/fireworks/routers/glm-5p3-fast");
    await run;
  });

  it("stops heartbeating when lifecycle teardown is refused by an unreadable fence", async () => {
    const session = makeSession();
    session.prompt.mockImplementation(async () => {
      const fence = paths.lifecycleTombstonePath("team", "reader");
      fs.mkdirSync(path.dirname(fence), { recursive: true });
      fs.writeFileSync(fence, "{ malformed");
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const member = { ...fixtureMember("reader"), prompt: "investigate" };
    writeTeamConfig("team", member);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    let observed: RunningReadAgent | undefined;

    await expect(runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => {
        observed = state;
        return runningReadAgents.get(key) === state;
      },
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    })).rejects.toThrow(/lifecycle-quarantined by a corrupt tombstone/);

    expect(observed).toBeDefined();
    expect(observed!.heartbeatTimer).toBeUndefined();
    expect(observed!.messageDeliveryClosed).toBe(true);
  });

  it("injects teammate-safe communication tools and guidance into nested read-agent sessions", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const modelRuntime = {};
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("team", {
      agentId: "reader@team",
      name: "reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
    }, "investigate", {
      modelRegistry: {
        runtime: modelRuntime,
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    expect(piMocks.createAgentSession).toHaveBeenCalledTimes(1);
    const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
    expect(sessionOptions.modelRuntime).toBe(modelRuntime);
    const communicationToolNames = ["send_message", "report_progress", "read_inbox", "report_and_exit"];
    expect(sessionOptions.tools).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ...communicationToolNames,
    ]);
    expect(sessionOptions.customTools.map((tool: any) => tool.name).sort()).toEqual([...communicationToolNames].sort());

    expect(piMocks.loaderOptions).toHaveLength(1);
    expect(piMocks.loaderOptions[0]).toMatchObject({
      noExtensions: true,
      additionalExtensionPaths: [],
      noSkills: false,
    });
    expect(piMocks.loaderOptions[0].skillsOverride).toBeUndefined();
    expect(piMocks.loaderOptions[0].noPromptTemplates).toBeUndefined();
    expect(piMocks.loaderOptions[0].noThemes).toBeUndefined();
    expect(sessionOptions.settingsManager).toBe(piMocks.loaderOptions[0].settingsManager);
    const privateSessionDir = piMocks.sessionManagerCreate.mock.calls[0][1];
    const expectedAgentRoot = path.join(root, "teams", "team", "agent-sessions", "reader");
    expect(typeof privateSessionDir).toBe("string");
    expect(path.dirname(privateSessionDir)).toBe(expectedAgentRoot);
    expect(privateSessionDir).not.toContain(path.join(".pi", "agent", "sessions"));
    expect(sessionOptions.sessionManager).toBe(piMocks.sessionManagerCreate.mock.results[0].value);
    const promptText = piMocks.loaderOptions[0].appendSystemPrompt.join("\n");
    expect(promptText).toContain("Use send_message for direct communication and read_inbox only when you were told a reply is waiting");
    expect(promptText).toContain("If another agent is needed, use send_message to ask team-lead");
    expect(promptText).toContain("only the lead decides and performs the spawn");
    expect(promptText).toContain("Progress reporting is required, not optional UI polish");
    expect(promptText).toContain("Call report_progress before your first work tool");
    expect(promptText).toContain("never make more than 3 work-tool calls without a fresh progress update");
    expect(promptText).toContain("Use a new phrase describing what you are doing now");
    expect(promptText).toContain("without messaging or waking the lead");
    expect(promptText).toContain("use report_and_exit with the complete required deliverable");
    expect(promptText).toContain("Never replace required output with a summary");

    expect(session.bindExtensions).toHaveBeenCalledWith({ mode: "print" });
    expect(session.bindExtensions.mock.invocationCallOrder[0]).toBeLessThan(session.prompt.mock.invocationCallOrder[0]);
    expect(session.prompt).toHaveBeenCalledWith("investigate", { source: "extension" });
    expect(options.emitAgentReport).toHaveBeenCalledWith("team", "reader", expect.any(Number), 42, "final report", true);
    expect(await readInbox("team", "team-lead", true, false)).toEqual([]);
    expect(await readInbox("team", "team-lead", false, false)).toEqual([]);
    expect(options.releaseAllClaimsForAgent).toHaveBeenCalledWith("team", "reader");
    expect(runningReadAgents.size).toBe(0);
  });

  it("uses Pi's resumable session store only after an explicit opt-in", async () => {
    const settingsPath = path.join(root, ".pi", "agent", "pi-extended-teams", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    settings.agentSessions = { showInResume: true };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });

    await runReadAgentInProcess(
      "team",
      { ...fixtureMember("reader"), prompt: "investigate" },
      "investigate",
      { modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) } },
      makeRunOptions(),
    );

    expect(piMocks.sessionManagerCreate).toHaveBeenCalledWith(root);
  });

  it("removes a normal completed private session only after reporting and teardown", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    let privateSessionDir = "";
    piMocks.sessionManagerCreate.mockImplementation((cwd: string, sessionDir?: string) => {
      privateSessionDir = sessionDir!;
      const sessionFile = path.join(privateSessionDir, "child-session.jsonl");
      fs.writeFileSync(sessionFile, "private transcript\n");
      return {
        cwd,
        getSessionId: () => "child-session",
        getSessionDir: () => privateSessionDir,
        getSessionFile: () => sessionFile,
      };
    });

    await runReadAgentInProcess(
      "team",
      { ...fixtureMember("reader"), prompt: "investigate" },
      "investigate",
      { modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) } },
      makeRunOptions(),
    );

    expect(privateSessionDir).not.toBe("");
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(fs.existsSync(privateSessionDir)).toBe(false);
  });

  it("preserves accepted task details in the recovery report after persistence fails", async () => {
    const session = makeSession();
    session.prompt.mockImplementation(async () => {
      const report = piMocks.createAgentSession.mock.calls[0][0].customTools.find((tool: any) => tool.name === "report_and_exit");
      await report.execute("report", { content: "Needs product input", outcome: "blocked", questions: ["Which API?"] });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    vi.spyOn(reportEvents, "appendTeamReportEvent").mockRejectedValueOnce(new Error("storage unavailable"));
    const options = makeRunOptions();
    await runReadAgentInProcess("team", fixtureMember("reader"), "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);
    const [persisted] = await listTeamReportEvents("team");
    expect(persisted).toMatchObject({ status: "failed", result: { outcome: "blocked", questions: ["Which API?"] } });
    expect(options.rememberCompletedAgentReport.mock.calls.at(-1)![1].result).toEqual(persisted.result);
    expect(await readLifecycleTombstone("team", "reader")).toMatchObject({ status: "occupied" });
  });

  it("retains the completed result when delivery fails for a resume-visible session", async () => {
    writeFavoriteLevels({ agentSessions: { showInResume: true } });
    const member = fixtureMember("reader");
    const session = makeSession();
    session.prompt.mockImplementation(async () => {
      const report = piMocks.createAgentSession.mock.calls[0][0].customTools.find((tool: any) => tool.name === "report_and_exit");
      await report.execute("report", { content: "Needs product input", outcome: "blocked" });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const options = makeRunOptions();
    options.emitAgentReport.mockImplementation(() => { throw new Error("lead delivery failed"); });
    await runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledOnce();
    const remembered = options.rememberCompletedAgentReport.mock.calls[0][1];
    expect(remembered).toMatchObject({ status: "completed", result: { outcome: "blocked" } });
    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(1);
    expect(reports[0].result).toEqual(remembered.result);
    expect(reports[0].report).toBe("Needs product input");
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("cleans a private session after completed report emission fails without stale recovery pointers", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    let privateSessionDir = "";
    session.dispose.mockImplementation(() => {
      expect(fs.existsSync(privateSessionDir)).toBe(true);
    });
    const options = makeRunOptions();
    options.emitAgentReport.mockImplementation(() => {
      throw new Error("lead notification failed");
    });
    piMocks.sessionManagerCreate.mockImplementation((cwd: string, sessionDir?: string) => {
      privateSessionDir = sessionDir!;
      const sessionFile = path.join(privateSessionDir, "child-session.jsonl");
      fs.writeFileSync(sessionFile, "private transcript\n");
      return {
        cwd,
        getSessionId: () => "child-session",
        getSessionDir: () => privateSessionDir,
        getSessionFile: () => sessionFile,
      };
    });

    await runReadAgentInProcess(
      "team",
      { ...fixtureMember("reader"), prompt: "investigate" },
      "investigate",
      { modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) } },
      options,
    );

    expect(session.dispose).toHaveBeenCalledOnce();
    expect(fs.existsSync(privateSessionDir)).toBe(false);
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledOnce();
    expect(options.rememberCompletedAgentReport.mock.calls[0][1]).toMatchObject({
      status: "completed",
      reportSource: "assistant-text",
    });
    expect(options.rememberCompletedAgentReport.mock.calls[0][1]).not.toHaveProperty("recoverySessionId");
    expect(options.rememberCompletedAgentReport.mock.calls[0][1]).not.toHaveProperty("recoverySessionFile");
    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "completed",
      metadata: { reportSource: "assistant-text", recoveryAttempted: false },
    });
    expect(reports[0]?.metadata).not.toHaveProperty("recoverySessionId");
    expect(reports[0]?.metadata).not.toHaveProperty("recoverySessionFile");
  });

  it("cleans a private session after report-only recovery without stale recovery pointers", async () => {
    const session = makeSession();
    session.messages = [];
    let privateSessionDir = "";
    const lifecycleOrder: string[] = [];
    session.dispose.mockImplementation(() => {
      lifecycleOrder.push("dispose");
      expect(fs.existsSync(privateSessionDir)).toBe(true);
    });
    session.prompt.mockImplementation(async () => {
      if (session.prompt.mock.calls.length === 1) return;
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const reportTool = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
      await reportTool.execute("recovered-report", {
        content: "Recovered on the report-only turn",
        summary: "Recovered",
      });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    piMocks.sessionManagerCreate.mockImplementation((cwd: string, sessionDir?: string) => {
      privateSessionDir = sessionDir!;
      const sessionFile = path.join(privateSessionDir, "child-session.jsonl");
      fs.writeFileSync(sessionFile, "private recovery transcript\n");
      return {
        cwd,
        getSessionId: () => "child-session",
        getSessionDir: () => privateSessionDir,
        getSessionFile: () => sessionFile,
      };
    });
    const options = makeRunOptions();

    await runReadAgentInProcess(
      "team",
      { ...fixtureMember("reader"), prompt: "investigate" },
      "investigate",
      { modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) } },
      options,
    );

    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(lifecycleOrder).toEqual(["dispose"]);
    expect(fs.existsSync(privateSessionDir)).toBe(false);
    const remembered = options.rememberCompletedAgentReport.mock.calls[0][1];
    expect(remembered).toMatchObject({
      status: "completed",
      reportSource: "report_and_exit",
      recoveryAttempted: true,
    });
    expect(remembered).not.toHaveProperty("recoverySessionId");
    expect(remembered).not.toHaveProperty("recoverySessionFile");
    const reports = await listTeamReportEvents("team");
    expect(reports.at(-1)).toMatchObject({
      status: "completed",
      metadata: { reportSource: "report_and_exit", recoveryAttempted: true },
    });
    expect(reports.at(-1)?.metadata).not.toHaveProperty("recoverySessionId");
    expect(reports.at(-1)?.metadata).not.toHaveProperty("recoverySessionFile");
  });

  it("cleans a private session after persisted report recovery without stale recovery pointers", async () => {
    const session = makeSession();
    session.messages = [];
    let privateSessionDir = "";
    const lifecycleOrder: string[] = [];
    session.dispose.mockImplementation(() => {
      lifecycleOrder.push("dispose");
      expect(fs.existsSync(privateSessionDir)).toBe(true);
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const sessionFile = () => path.join(privateSessionDir, "durable-child.jsonl");
    const options = makeRunOptions();
    const member = { ...fixtureMember("reader"), prompt: "investigate" };
    writeTeamConfig("team", member);

    piMocks.sessionManagerCreate.mockImplementation((cwd: string, sessionDir?: string) => {
      privateSessionDir = sessionDir!;
      const persistedFile = sessionFile();
      fs.writeFileSync(persistedFile, "durable private transcript\n");
      piMocks.persistedSessionEntries.set(persistedFile, [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "accepted-report-call",
              name: "report_and_exit",
              arguments: { content: "Recovered durable report", summary: "Durable" },
            }],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "accepted-report-call",
            toolName: "report_and_exit",
            content: [{ type: "text", text: "Final report accepted." }],
            details: { accepted: true },
            isError: false,
          },
        },
      ]);
      return {
        cwd,
        getSessionId: () => "durable-child",
        getSessionDir: () => privateSessionDir,
        getSessionFile: () => persistedFile,
      };
    });

    await runReadAgentInProcess(
      "team",
      member,
      "investigate",
      { modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) } },
      options,
    );

    expect(session.prompt).toHaveBeenCalledOnce();
    expect(lifecycleOrder).toEqual(["dispose"]);
    expect(fs.existsSync(privateSessionDir)).toBe(false);
    const remembered = options.rememberCompletedAgentReport.mock.calls[0][1];
    expect(remembered).toMatchObject({
      status: "completed",
      reportSource: "persisted-report_and_exit",
      recoveryAttempted: false,
    });
    expect(remembered).not.toHaveProperty("recoverySessionId");
    expect(remembered).not.toHaveProperty("recoverySessionFile");
    const reports = await listTeamReportEvents("team");
    expect(reports.at(-1)).toMatchObject({
      status: "completed",
      metadata: { reportSource: "persisted-report_and_exit", recoveryAttempted: false },
    });
    expect(reports.at(-1)?.metadata).not.toHaveProperty("recoverySessionId");
    expect(reports.at(-1)?.metadata).not.toHaveProperty("recoverySessionFile");
  });

  it("quarantines every recovery artifact when durable report persistence fails", async () => {
    vi.spyOn(reportEvents, "appendTeamReportEvent").mockRejectedValue(new Error("report store unavailable"));
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    let privateSessionDir = "";
    piMocks.sessionManagerCreate.mockImplementation((cwd: string, sessionDir?: string) => {
      privateSessionDir = sessionDir!;
      const sessionFile = path.join(privateSessionDir, "child-session.jsonl");
      fs.writeFileSync(sessionFile, "private transcript\n");
      return {
        cwd,
        getSessionId: () => "child-session",
        getSessionDir: () => privateSessionDir,
        getSessionFile: () => sessionFile,
      };
    });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = makeRunOptions(runningReadAgents);

    await runReadAgentInProcess(
      "team",
      { ...fixtureMember("reader"), prompt: "investigate" },
      "investigate",
      { modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) } },
      options,
    );

    const retainedMember = (await teams.readConfig("team")).members.find(member => member.name === "reader");
    expect(retainedMember).toMatchObject({ isActive: false, lifecycleRunId: expect.any(String) });
    const runId = retainedMember!.lifecycleRunId!;
    expect(fs.existsSync(privateSessionDir)).toBe(true);
    await expect(runtime.readRuntimeStatus("team", "reader")).resolves.toMatchObject({ lifecycleRunId: runId });
    await expect(readLifecycleTombstone("team", "reader")).resolves.toMatchObject({
      status: "occupied",
      tombstone: {
        runId,
        phase: "cleanup_failed",
        error: expect.stringContaining("report store unavailable"),
      },
    });
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(options.emitAgentReport).toHaveBeenCalledWith(
      "team",
      "reader",
      expect.any(Number),
      42,
      expect.stringContaining("Recovery pointer: pi-child-session/v1"),
      false,
    );
    expect(runningReadAgents.size).toBe(1);
  });

  it("retains a failed private session for bounded recovery", async () => {
    const session = makeSession();
    session.prompt.mockRejectedValue(new Error("provider failed"));
    piMocks.createAgentSession.mockResolvedValue({ session });
    let privateSessionDir = "";
    piMocks.sessionManagerCreate.mockImplementation((cwd: string, sessionDir?: string) => {
      privateSessionDir = sessionDir!;
      const sessionFile = path.join(privateSessionDir, "child-session.jsonl");
      fs.writeFileSync(sessionFile, "recoverable private transcript\n");
      return {
        cwd,
        getSessionId: () => "child-session",
        getSessionDir: () => privateSessionDir,
        getSessionFile: () => sessionFile,
      };
    });

    await runReadAgentInProcess(
      "team",
      { ...fixtureMember("reader"), prompt: "investigate" },
      "investigate",
      { modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) } },
      makeRunOptions(),
    );

    expect(privateSessionDir).not.toBe("");
    expect(fs.existsSync(privateSessionDir)).toBe(true);
  });

  it("quarantines a failed run when its failure report cannot be persisted", async () => {
    vi.spyOn(reportEvents, "appendTeamReportEvent").mockRejectedValue(new Error("failure report store unavailable"));
    const session = makeSession();
    session.prompt.mockRejectedValue(new Error("provider failed"));
    piMocks.createAgentSession.mockResolvedValue({ session });
    let privateSessionDir = "";
    piMocks.sessionManagerCreate.mockImplementation((cwd: string, sessionDir?: string) => {
      privateSessionDir = sessionDir!;
      const sessionFile = path.join(privateSessionDir, "child-session.jsonl");
      fs.writeFileSync(sessionFile, "recoverable failed transcript\n");
      return {
        cwd,
        getSessionId: () => "child-session",
        getSessionDir: () => privateSessionDir,
        getSessionFile: () => sessionFile,
      };
    });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = makeRunOptions(runningReadAgents);

    await runReadAgentInProcess(
      "team",
      { ...fixtureMember("reader"), prompt: "investigate" },
      "investigate",
      { modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) } },
      options,
    );

    const retainedMember = (await teams.readConfig("team")).members.find(member => member.name === "reader");
    expect(retainedMember).toMatchObject({ isActive: false, lifecycleRunId: expect.any(String) });
    const runId = retainedMember!.lifecycleRunId!;
    expect(fs.existsSync(privateSessionDir)).toBe(true);
    await expect(runtime.readRuntimeStatus("team", "reader")).resolves.toMatchObject({ lifecycleRunId: runId });
    await expect(readLifecycleTombstone("team", "reader")).resolves.toMatchObject({
      status: "occupied",
      tombstone: {
        runId,
        phase: "cleanup_failed",
        error: expect.stringContaining("failure report store unavailable"),
      },
    });
    expect(options.emitAgentReport).toHaveBeenCalledWith(
      "team",
      "reader",
      expect.any(Number),
      expect.any(Number),
      expect.stringContaining("Recovery pointer: pi-child-session/v1"),
      false,
    );
  });

  it("requests one report-only recovery turn when the first turn has no usable output", async () => {
    const session = makeSession();
    session.messages = [];
    session.prompt.mockImplementation(async () => {
      if (session.prompt.mock.calls.length === 1) return;
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const reportTool = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
      await reportTool.execute("recovered-report", {
        content: "Recovered on the report-only turn",
        summary: "Recovered",
      });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const member = { ...fixtureMember("reader"), prompt: "investigate" };
    writeTeamConfig("team", member);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const rememberCompletedAgentReport = vi.fn();
    const emitAgentReport = vi.fn();

    await runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key, state) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport,
      emitAgentReport,
      releaseAllClaimsForAgent: vi.fn(async () => []),
    });

    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect((session.prompt.mock.calls as any[][])[1][0]).toContain("previous turn ended without a usable final report");
    expect(rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      status: "completed",
      report: "Recovered on the report-only turn",
      summary: "Recovered",
      reportSource: "report_and_exit",
      recoveryAttempted: true,
    }));
    expect(rememberCompletedAgentReport.mock.calls[0][1]).not.toHaveProperty("recoverySessionId");
    expect(rememberCompletedAgentReport.mock.calls[0][1]).not.toHaveProperty("recoverySessionFile");
    expect(emitAgentReport).toHaveBeenCalledWith(
      "team", "reader", expect.any(Number), 42, "Recovered on the report-only turn", true,
    );
  });

  it("recovers an accepted report_and_exit payload from the durable child session", async () => {
    const session = makeSession();
    session.messages = [];
    piMocks.createAgentSession.mockResolvedValue({ session });
    const sessionFile = path.join(root, "child-sessions", "durable-child.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "durable fixture\n");
    piMocks.sessionManagerCreate.mockImplementationOnce(() => ({
      getSessionId: () => "durable-child",
      getSessionFile: () => sessionFile,
    }));
    piMocks.persistedSessionEntries.set(sessionFile, [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "accepted-report-call",
            name: "report_and_exit",
            arguments: { content: "Recovered durable report", summary: "Durable" },
          }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "accepted-report-call",
          toolName: "report_and_exit",
          content: [{ type: "text", text: "Final report accepted." }],
          details: { accepted: true },
          isError: false,
        },
      },
    ]);
    const member = { ...fixtureMember("reader"), prompt: "investigate" };
    writeTeamConfig("team", member);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const rememberCompletedAgentReport = vi.fn();
    const emitAgentReport = vi.fn();

    await runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key, state) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport,
      emitAgentReport,
      releaseAllClaimsForAgent: vi.fn(async () => []),
    });

    expect(session.prompt).toHaveBeenCalledOnce();
    expect(piMocks.sessionManagerOpen).toHaveBeenCalledWith(sessionFile);
    expect(rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      status: "completed",
      report: "Recovered durable report",
      summary: "Durable",
      reportSource: "persisted-report_and_exit",
      recoveryAttempted: false,
    }));
    expect(rememberCompletedAgentReport.mock.calls[0][1]).not.toHaveProperty("recoverySessionId");
    expect(rememberCompletedAgentReport.mock.calls[0][1]).not.toHaveProperty("recoverySessionFile");
    expect(emitAgentReport).toHaveBeenCalledWith(
      "team", "reader", expect.any(Number), 42, "Recovered durable report", true,
    );
    const reports = await listTeamReportEvents("team");
    expect(reports.at(-1)).toMatchObject({
      status: "completed",
      report: "Recovered durable report",
      metadata: {
        reportSource: "persisted-report_and_exit",
        recoveryAttempted: false,
      },
    });
    expect(reports.at(-1)?.metadata).not.toHaveProperty("recoverySessionId");
    expect(reports.at(-1)?.metadata).not.toHaveProperty("recoverySessionFile");
  });

  it("classifies a terminal provider error without report text as a failed recoverable run", async () => {
    const session = makeSession();
    (session as any).messages = [{
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "provider retries exhausted",
    }];
    piMocks.createAgentSession.mockResolvedValue({ session });
    const sessionFile = path.join(root, "child-sessions", "provider-error.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, "provider error fixture\n");
    piMocks.sessionManagerCreate.mockImplementationOnce(() => ({
      getSessionId: () => "provider-error",
      getSessionFile: () => sessionFile,
    }));
    const member = { ...fixtureMember("reader"), prompt: "investigate" };
    writeTeamConfig("team", member);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const rememberCompletedAgentReport = vi.fn();
    const emitAgentReport = vi.fn();

    await runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key, state) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport,
      emitAgentReport,
      releaseAllClaimsForAgent: vi.fn(async () => []),
    });

    expect(session.prompt).toHaveBeenCalledOnce();
    expect(rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      status: "failed",
      report: expect.stringContaining("stopReason=error: provider retries exhausted"),
      reportSource: "irrecoverable-empty",
      recoveryAttempted: false,
      recoverySessionId: "provider-error",
      recoverySessionFile: sessionFile,
    }));
    const failureText = rememberCompletedAgentReport.mock.calls[0][1].report;
    expect(failureText).toContain(`Recovery pointer: pi-child-session/v1`);
    expect(failureText).toContain(`sessionFile=${JSON.stringify(sessionFile)}`);
    expect(failureText).toContain("Retrieve the child transcript with the read tool");
    expect(failureText).not.toContain("produced no assistant text");
    expect(emitAgentReport).toHaveBeenCalledWith("team", "reader", expect.any(Number), 42, failureText, false);
  });

  it("emits a failed diagnostic and stable pointer when the recovery turn is also empty", async () => {
    const session = makeSession();
    session.messages = [];
    piMocks.createAgentSession.mockResolvedValue({ session });
    const member = { ...fixtureMember("reader"), prompt: "investigate" };
    writeTeamConfig("team", member);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const rememberCompletedAgentReport = vi.fn();
    const emitAgentReport = vi.fn();

    await runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName, agentName) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key, state) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport,
      emitAgentReport,
      releaseAllClaimsForAgent: vi.fn(async () => []),
    });

    expect(session.prompt).toHaveBeenCalledTimes(2);
    const failedReport = rememberCompletedAgentReport.mock.calls[0][1];
    expect(failedReport).toMatchObject({
      status: "failed",
      reportSource: "irrecoverable-empty",
      recoveryAttempted: true,
      recoverySessionId: "child-session-1",
      recoverySessionFile: expect.stringContaining("child-session-1.jsonl"),
    });
    expect(failedReport.report).toContain("report-only recovery turn without producing any usable final report");
    expect(failedReport.report).toContain("durableFile=false");
    expect(failedReport.report).toContain("lifecycleRunId=");
    expect(failedReport.report).not.toContain("produced no assistant text");
    expect(emitAgentReport).toHaveBeenCalledWith(
      "team", "reader", expect.any(Number), 42, failedReport.report, false,
    );
  });

  it("loads one immutable extension selection, activates its tools, and propagates parent trust", async () => {
    const session = makeSession();
    session.hasExtensionHandlers.mockReturnValue(true);
    piMocks.createAgentSession.mockResolvedValue({ session });
    piMocks.loaderExtensions.push({
      tools: new Map([
        ["selected_extension_tool", { definition: { name: "selected_extension_tool" } }],
        ["send_message", { definition: { name: "send_message", description: "untrusted override" } }],
        ["spawn_agent", { definition: { name: "spawn_agent", description: "untrusted external spawn" } }],
        ["spawn_swarm_agents", { definition: { name: "spawn_swarm_agents", description: "untrusted external swarm" } }],
      ]),
    });
    const createResourcePlan = vi.fn(async (input: { cwd: string; projectTrusted: boolean }) => Object.freeze({
      selectionMode: "explicit" as const,
      extensionPaths: Object.freeze(["/extensions/selected.ts"]),
      extensions: Object.freeze([]),
      diagnostics: Object.freeze([]),
      skills: "all" as const,
      trust: Object.freeze({ cwd: input.cwd, projectTrusted: input.projectTrusted }),
    }));
    const runningReadAgents = new Map<string, RunningReadAgent>();

    await runReadAgentInProcess("team", {
      agentId: "reader@team",
      name: "reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
    }, "investigate", {
      cwd: root,
      isProjectTrusted: () => true,
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      createResourcePlan,
    });

    expect(createResourcePlan).toHaveBeenCalledOnce();
    expect(createResourcePlan).toHaveBeenCalledWith({ cwd: root, projectTrusted: true });
    expect(piMocks.loaderOptions[0]).toMatchObject({
      additionalExtensionPaths: ["/extensions/selected.ts"],
      noExtensions: true,
      noSkills: false,
    });
    const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toContain("selected_extension_tool");
    expect(sessionOptions.tools.filter((name: string) => name === "send_message")).toHaveLength(1);
    expect(sessionOptions.tools).not.toContain("spawn_agent");
    expect(sessionOptions.tools).not.toContain("spawn_swarm_agents");
    expect(sessionOptions.customTools.find((tool: any) => tool.name === "send_message")?.description).not.toBe("untrusted override");
    expect(sessionOptions.customTools.some((tool: any) => tool.name === "spawn_agent" || tool.name === "spawn_swarm_agents")).toBe(false);
    expect(piMocks.settingsManagers.at(-1)?.isProjectTrusted()).toBe(true);
    expect(session.bindExtensions.mock.invocationCallOrder[0]).toBeLessThan(session.prompt.mock.invocationCallOrder[0]);
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(session.extensionRunner.emit.mock.invocationCallOrder[0]).toBeLessThan(session.clearQueue.mock.invocationCallOrder[0]);
    expect(session.clearQueue.mock.invocationCallOrder[0]).toBeLessThan(session.abort.mock.invocationCallOrder[0]);
    expect(session.abort.mock.invocationCallOrder[0]).toBeLessThan(session.dispose.mock.invocationCallOrder[0]);
  });

  it("replaces filtered external spawn collisions with restricted tools only for an opted-in write-feature parent", async () => {
    const session = makeSession();
    session.prompt.mockImplementation(async () => {
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const report = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
      await report.execute("report", { content: "tool wiring verified", summary: "Done" });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    piMocks.loaderExtensions.push({
      tools: new Map([
        ["get_agent_status", { definition: { name: "get_agent_status", description: "untrusted external status" } }],
        ["spawn_agent", { definition: { name: "spawn_agent", description: "untrusted external spawn" } }],
        ["spawn_swarm_agents", { definition: { name: "spawn_swarm_agents", description: "untrusted external swarm" } }],
      ]),
    });
    const restrictedTools = [
      { name: "get_agent_status", description: "restricted status", execute: vi.fn() },
      { name: "spawn_agent", description: "restricted single", execute: vi.fn() },
      { name: "spawn_swarm_agents", description: "restricted swarm", execute: vi.fn() },
    ];
    const createNestedReadAgentTools = vi.fn(() => restrictedTools);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const pendingChildController = createPendingChildController();
    const member: Member = {
      agentId: "feature-writer@team",
      name: "feature-writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "medium",
      modelSlot: "write-feature",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "implement a bounded feature",
      delegationDepth: 0,
      allowNestedReadAgents: true,
    };
    writeTeamConfig("team", member);
    const outerCtx = {
      cwd: root,
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    };

    await runReadAgentInProcess("team", member, "implement a bounded feature", outerCtx, {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      createNestedReadAgentTools,
      pendingChildController,
    });

    expect(createNestedReadAgentTools).toHaveBeenCalledOnce();
    expect(createNestedReadAgentTools).toHaveBeenCalledWith({
      teamName: "team",
      parent: member,
      parentRunId: member.lifecycleRunId,
      outerCtx,
    });
    const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools.filter((name: string) => name === "get_agent_status")).toEqual(["get_agent_status"]);
    expect(sessionOptions.tools.filter((name: string) => name === "spawn_agent")).toEqual(["spawn_agent"]);
    expect(sessionOptions.tools.filter((name: string) => name === "spawn_swarm_agents")).toEqual(["spawn_swarm_agents"]);
    expect(sessionOptions.customTools).toEqual(expect.arrayContaining(restrictedTools));
    expect(sessionOptions.customTools.find((tool: any) => tool.name === "spawn_agent")?.description).toBe("restricted single");
    expect(sessionOptions.customTools.find((tool: any) => tool.name === "spawn_swarm_agents")?.description).toBe("restricted swarm");
    const promptText = piMocks.loaderOptions[0].appendSystemPrompt.join("\n");
    expect(promptText).toContain("opted-in depth-0 write-feature/write-critical run");
    expect(promptText).toContain("restricted spawn_agent or spawn_swarm_agents");
    expect(promptText).toContain("any canonical read-* tier and any helper count");
    expect(promptText).toContain("global read capacity and queue");
    expect(promptText).toContain("Children report to you and cannot delegate");
    expect(promptText).toContain("end your turn without calling report_and_exit");
    expect(promptText).toContain("One get_agent_status snapshot is allowed");
  });

  it("keeps an opted-in writer live for an exact child report and lets the idle continuation submit the sole final report", async () => {
    const session = makeSession();
    session.messages = [{ role: "assistant", content: "initial turn ended without a final report" }];
    const pendingChildController = createPendingChildController();
    let exactChildRun: PendingChildRun | undefined;
    let sessionOptions: any;
    let continuationReportResult: any;
    const createNestedReadAgentTools = vi.fn((binding: any) => [{
      name: "spawn_agent",
      async execute() {
        const acceptance = pendingChildController.acceptChild({
          teamName: binding.teamName,
          parentName: binding.parent.name,
          parentRunId: binding.parentRunId,
        }, "child");
        exactChildRun = pendingChildController.bindAcceptedChild(acceptance, "child", "child-run");
        return { content: [{ type: "text", text: "child started" }] };
      },
    }]);
    session.prompt.mockImplementation(async () => {
      sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const spawn = sessionOptions.customTools.find((tool: any) => tool.name === "spawn_agent");
      await spawn.execute("spawn-child", {});
    });
    session.sendUserMessage.mockImplementation(async (...args: any[]) => {
      expect(args[0]).toBe("Exact child report");
      const report = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
      continuationReportResult = await report.execute("parent-report", {
        content: "Authoritative parent report",
        summary: "Parent done",
      });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });

    const writer: Member = {
      agentId: "feature-writer@team",
      name: "feature-writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "medium",
      modelSlot: "write-feature",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "implement a bounded feature",
      delegationDepth: 0,
      allowNestedReadAgents: true,
    };
    writeTeamConfig("team", writer);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const rememberCompletedAgentReport = vi.fn();
    const options = {
      isTeammate: false,
      getTeamName: () => "different-team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport,
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      createNestedReadAgentTools,
      pendingChildController,
    };

    let runSettled = false;
    const run = runReadAgentInProcess("team", writer, writer.prompt!, {
      cwd: root,
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options).then(() => { runSettled = true; });

    await vi.waitFor(() => {
      expect(exactChildRun).toBeDefined();
      expect(pendingChildController.pendingCount({
        teamName: "team",
        parentName: "feature-writer",
        parentRunId: writer.lifecycleRunId!,
      })).toBe(1);
    });
    const liveParent = runningReadAgents.get("team:feature-writer")!;
    expect(liveParent.acceptingMessages).toBe(true);
    expect(liveParent.persistedRecipientClosed).not.toBe(true);
    expect(runSettled).toBe(false);
    expect(rememberCompletedAgentReport).not.toHaveBeenCalled();
    expect((await teams.readConfig("team")).members.find(member => member.name === writer.name)?.isActive).not.toBe(false);

    const delivery = sendMessageToRunningReadAgent(liveParent, "Exact child report").catch((error: Error) => error);
    await expect(delivery).resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("was cancelled") }));
    expect(pendingChildController.settleChildRun(exactChildRun!)).toBe(false);
    await run;

    expect(pendingChildController.trackedParentCount()).toBe(0);
    expect(session.sendUserMessage).toHaveBeenCalledOnce();
    expect(continuationReportResult).toMatchObject({ details: { accepted: true } });
    expect(rememberCompletedAgentReport).toHaveBeenCalledOnce();
    expect(rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      report: "Authoritative parent report",
      summary: "Parent done",
    }));
    expect(JSON.stringify(rememberCompletedAgentReport.mock.calls)).not.toContain("initial turn ended without a final report");
  });

  it("keeps an eligible zero-child parent idle until a direct message submits the first authoritative report", async () => {
    const session = makeSession();
    session.messages = [{ role: "assistant", content: "non-authoritative initial assistant text" }];
    const pendingChildController = createPendingChildController();
    let firstReportResult: any;
    let duplicateReportResult: any;
    session.sendUserMessage.mockImplementation(async (...args: any[]) => {
      expect(args[0]).toBe("submit final report");
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const report = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
      firstReportResult = await report.execute("first", {
        content: "sole authoritative report",
        summary: "Authoritative",
      });
      duplicateReportResult = await report.execute("duplicate", {
        content: "must be ignored",
        summary: "Duplicate",
      });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });

    const writer = eligibleNestedParent("zero-idle-writer");
    writeTeamConfig("team", writer);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const rememberCompletedAgentReport = vi.fn();
    const options = {
      isTeammate: false,
      getTeamName: () => "different-team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport,
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      createNestedReadAgentTools: vi.fn(() => [{ name: "spawn_agent", execute: vi.fn() }]),
      pendingChildController,
    };

    let runSettled = false;
    const run = runReadAgentInProcess("team", writer, writer.prompt!, {
      cwd: root,
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options).then(() => { runSettled = true; });

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledOnce();
      expect(runningReadAgents.get("team:zero-idle-writer")?.acceptingMessages).toBe(true);
    });
    expect(runSettled).toBe(false);
    expect(rememberCompletedAgentReport).not.toHaveBeenCalled();
    expect(pendingChildController.pendingCount({
      teamName: "team",
      parentName: writer.name,
      parentRunId: writer.lifecycleRunId!,
    })).toBe(0);

    const delivery = sendMessageToRunningReadAgent(
      runningReadAgents.get("team:zero-idle-writer"),
      "submit final report"
    ).catch((error: Error) => error);
    await expect(delivery).resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("was cancelled") }));
    await run;

    expect(firstReportResult).toMatchObject({ details: { accepted: true } });
    expect(duplicateReportResult).toMatchObject({ details: { accepted: false } });
    expect(rememberCompletedAgentReport).toHaveBeenCalledOnce();
    expect(rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      report: "sole authoritative report",
      summary: "Authoritative",
    }));
    expect(JSON.stringify(rememberCompletedAgentReport.mock.calls)).not.toContain("non-authoritative initial assistant text");
    expect(JSON.stringify(rememberCompletedAgentReport.mock.calls)).not.toContain("must be ignored");
    expect(pendingChildController.trackedParentCount()).toBe(0);
  });

  it("keeps a parent live when a child-report continuation returns without a report, then accepts a later direct report", async () => {
    const session = makeSession();
    const pendingChildController = createPendingChildController();
    let childRun: PendingChildRun | undefined;
    session.prompt.mockImplementation(async () => {
      const identity = {
        teamName: "team",
        parentName: "continuation-writer",
        parentRunId: writer.lifecycleRunId!,
      };
      const acceptance = pendingChildController.acceptChild(identity, "child");
      childRun = pendingChildController.bindAcceptedChild(acceptance, "child", "child-run");
    });
    session.sendUserMessage.mockImplementation(async (...args: any[]) => {
      const content = args[0];
      if (content === "child report without parent final") return;
      expect(content).toBe("later direct report");
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const report = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
      await report.execute("final", { content: "later authoritative report", summary: "Done later" });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });

    const writer = eligibleNestedParent("continuation-writer");
    writeTeamConfig("team", writer);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const rememberCompletedAgentReport = vi.fn();
    const options = {
      isTeammate: false,
      getTeamName: () => "different-team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport,
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      createNestedReadAgentTools: vi.fn(() => [{ name: "spawn_agent", execute: vi.fn() }]),
      pendingChildController,
    };
    let runSettled = false;
    const run = runReadAgentInProcess("team", writer, writer.prompt!, {
      cwd: root,
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options).then(() => { runSettled = true; });

    await vi.waitFor(() => expect(childRun).toBeDefined());
    const liveParent = runningReadAgents.get("team:continuation-writer")!;
    expect(pendingChildController.settleChildRun(childRun!)).toBe(true);
    await expect(sendMessageToRunningReadAgent(liveParent, "child report without parent final")).resolves.toBe(true);
    expect(runSettled).toBe(false);
    expect(liveParent.acceptingMessages).toBe(true);
    expect(rememberCompletedAgentReport).not.toHaveBeenCalled();

    const finalDelivery = sendMessageToRunningReadAgent(liveParent, "later direct report").catch((error: Error) => error);
    await expect(finalDelivery).resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("was cancelled") }));
    await run;
    expect(rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      report: "later authoritative report",
      summary: "Done later",
    }));
    expect(pendingChildController.trackedParentCount()).toBe(0);
  });

  it("rearms across child waves when child B is accepted during child A's continuation", async () => {
    const session = makeSession();
    const pendingChildController = createPendingChildController();
    let childA: PendingChildRun | undefined;
    let childB: PendingChildRun | undefined;
    const writer = eligibleNestedParent("wave-writer");
    session.prompt.mockImplementation(async () => {
      const identity = { teamName: "team", parentName: writer.name, parentRunId: writer.lifecycleRunId! };
      const acceptance = pendingChildController.acceptChild(identity, "child-a");
      childA = pendingChildController.bindAcceptedChild(acceptance, "child-a", "child-a-run");
    });
    session.sendUserMessage.mockImplementation(async (...args: any[]) => {
      const content = args[0];
      const identity = { teamName: "team", parentName: writer.name, parentRunId: writer.lifecycleRunId! };
      if (content === "child A report") {
        const acceptance = pendingChildController.acceptChild(identity, "child-b");
        childB = pendingChildController.bindAcceptedChild(acceptance, "child-b", "child-b-run");
        return;
      }
      expect(content).toBe("child B report");
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const report = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
      await report.execute("waves-complete", { content: "all child waves integrated", summary: "Waves done" });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });

    writeTeamConfig("team", writer);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const rememberCompletedAgentReport = vi.fn();
    const options = {
      isTeammate: false,
      getTeamName: () => "different-team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport,
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      createNestedReadAgentTools: vi.fn(() => [{ name: "spawn_agent", execute: vi.fn() }]),
      pendingChildController,
    };
    let runSettled = false;
    const run = runReadAgentInProcess("team", writer, writer.prompt!, {
      cwd: root,
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options).then(() => { runSettled = true; });

    await vi.waitFor(() => expect(childA).toBeDefined());
    const liveParent = runningReadAgents.get("team:wave-writer")!;
    expect(pendingChildController.settleChildRun(childA!)).toBe(true);
    await expect(sendMessageToRunningReadAgent(liveParent, "child A report")).resolves.toBe(true);
    expect(childB).toBeDefined();
    expect(pendingChildController.pendingCount({
      teamName: "team",
      parentName: writer.name,
      parentRunId: writer.lifecycleRunId!,
    })).toBe(1);
    expect(runSettled).toBe(false);

    expect(pendingChildController.settleChildRun(childB!)).toBe(true);
    const finalDelivery = sendMessageToRunningReadAgent(liveParent, "child B report").catch((error: Error) => error);
    await expect(finalDelivery).resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("was cancelled") }));
    await run;
    expect(rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      report: "all child waves integrated",
      summary: "Waves done",
    }));
    expect(pendingChildController.trackedParentCount()).toBe(0);
  });

  it("unblocks an eligible zero-child idle parent immediately on explicit stop without fallback completion", async () => {
    const session = makeSession();
    session.messages = [{ role: "assistant", content: "must never become a completion report" }];
    piMocks.createAgentSession.mockResolvedValue({ session });
    const writer = eligibleNestedParent("stopped-idle-writer");
    writeTeamConfig("team", writer);
    const pendingChildController = createPendingChildController();
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const rememberCompletedAgentReport = vi.fn();
    const readAgentKey = (teamName: string, agentName: string) => `${teamName}:${agentName}`;
    const isCurrentReadAgentRun = (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state;
    const lifecycle = createLifecycleRuntime({
      isTeammate: false,
      terminal: null,
      runningReadAgents,
      readAgentKey,
      isCurrentReadAgentRun,
      renderReadAgentStatus: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      drainWriteQueue: vi.fn(async () => {}),
      getSessionCwd: () => root,
      getTeamName: () => "team",
      onTeammateClosing: (teamName, member) => {
        pendingChildController.cancelParent({
          teamName,
          parentName: member.name,
          parentRunId: member.lifecycleRunId!,
        });
      },
      onTeammateSettled: (teamName, member) => {
        pendingChildController.forgetParent({
          teamName,
          parentName: member.name,
          parentRunId: member.lifecycleRunId!,
        });
      },
    });
    const options = {
      isTeammate: false,
      getTeamName: () => "different-team",
      runningReadAgents,
      readAgentKey,
      isCurrentReadAgentRun,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport,
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      createNestedReadAgentTools: vi.fn(() => [{ name: "spawn_agent", execute: vi.fn() }]),
      pendingChildController,
      shutdownTeammate: lifecycle.shutdownTeammate,
    };
    const run = runReadAgentInProcess("team", writer, writer.prompt!, {
      cwd: root,
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledOnce();
      expect(runningReadAgents.get("team:stopped-idle-writer")?.acceptingMessages).toBe(true);
    });
    await expect(lifecycle.shutdownTeammate("team", writer, { reason: "reload" })).resolves.toMatchObject({
      status: "settled",
      finalized: true,
      removedMember: true,
    });
    await run;

    expect(rememberCompletedAgentReport).not.toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(runningReadAgents.size).toBe(0);
    expect(pendingChildController.trackedParentCount()).toBe(0);
  });

  it.each([
    { label: "non-opted-in write-feature", role: "write" as const, modelSlot: "write-feature", thinking: "medium" as const, delegationDepth: 0, allowNestedReadAgents: false },
    { label: "opted-in write-patch", role: "write" as const, modelSlot: "write-patch", thinking: "high" as const, delegationDepth: 0, allowNestedReadAgents: true },
    { label: "opted-in write-system", role: "write" as const, modelSlot: "write-system", thinking: "xhigh" as const, delegationDepth: 0, allowNestedReadAgents: true },
    { label: "depth-1 read child", role: "read" as const, modelSlot: "read-review", thinking: "high" as const, delegationDepth: 1, allowNestedReadAgents: true },
  ])("does not assign delegation tools to $label sessions", async ({ label, role, modelSlot, thinking, delegationDepth, allowNestedReadAgents }) => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    piMocks.loaderExtensions.push({
      tools: new Map([
        ["spawn_agent", { definition: { name: "spawn_agent", description: "untrusted external spawn" } }],
        ["spawn_swarm_agents", { definition: { name: "spawn_swarm_agents", description: "untrusted external swarm" } }],
      ]),
    });
    const createNestedReadAgentTools = vi.fn(() => [
      { name: "spawn_agent", execute: vi.fn() },
      { name: "spawn_swarm_agents", execute: vi.fn() },
    ]);
    const member: Member = {
      agentId: `${label}@team`,
      name: label.replaceAll(" ", "-"),
      agentType: "teammate",
      role,
      model: "provider/model",
      thinking,
      modelSlot,
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "bounded assignment",
      delegationDepth,
      allowNestedReadAgents,
      parentAgentName: delegationDepth === 1 ? "writer" : undefined,
      parentLifecycleRunId: delegationDepth === 1 ? "writer-run" : undefined,
      requestedBy: delegationDepth === 1 ? "writer" : undefined,
      helperKind: delegationDepth === 1 ? "read_helper" : undefined,
    };
    writeTeamConfig("team", member);
    const rememberCompletedAgentReport = vi.fn();

    await runReadAgentInProcess("team", member, "bounded assignment", {
      cwd: root,
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents: new Map<string, RunningReadAgent>(),
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: () => true,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport,
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      createNestedReadAgentTools,
    });

    expect(createNestedReadAgentTools).not.toHaveBeenCalled();
    expect(rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      report: "final report",
    }));
    const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).not.toContain("spawn_agent");
    expect(sessionOptions.tools).not.toContain("spawn_swarm_agents");
    expect(sessionOptions.customTools.some((tool: any) => tool.name === "spawn_agent" || tool.name === "spawn_swarm_agents")).toBe(false);
    const promptText = piMocks.loaderOptions[0].appendSystemPrompt.join("\n");
    expect(promptText).not.toContain("opted-in depth-0 write-feature/write-critical run");
    if (delegationDepth === 1) {
      expect(promptText).toContain(`depth-1 read helper requested by 'writer'`);
      expect(promptText).toContain("report_and_exit deliverable goes to that requesting writer");
      expect(promptText).toContain("lead receives only a classified completion notice");
      expect(promptText).toContain("You cannot delegate");
      expect(promptText).not.toContain("send your concise report to the lead");
    }
  });

  it("injects the complete writer coordination surface into nested write-agent sessions", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("team", {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "writing-hard",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "edit an isolated file",
    }, "edit an isolated file", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    expect(piMocks.createAgentSession).toHaveBeenCalledTimes(1);
    const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
    const communicationToolNames = [
      "send_message",
      "report_progress",
      "read_inbox",
      "claim_file",
      "release_file",
      "list_file_claims",
      "report_and_exit",
    ];
    expect(sessionOptions.tools).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      ...communicationToolNames,
    ]);
    expect(sessionOptions.customTools.map((tool: any) => tool.name).sort()).toEqual([...communicationToolNames].sort());
    expect(options.emitAgentReport).toHaveBeenCalledWith("team", "writer", expect.any(Number), 42, "final report", true);
    expect(options.releaseAllClaimsForAgent).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("accepts only the first writer report and finalizes only the nested run", async () => {
    const session = makeSession();
    session.messages = [{ role: "assistant", content: "trailing assistant text" }];
    let firstResult: any;
    let duplicateResult: any;
    let lateSendError: unknown;
    session.prompt.mockImplementation(async () => {
      expect(runningReadAgents.get("team:writer")).toMatchObject({ modelSlot: "write-system" });
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const tools = new Map<string, any>(sessionOptions.customTools.map((tool: any) => [tool.name, tool]));
      await tools.get("claim_file").execute("claim", { paths: ["./fixtures/writer.txt"] });
      firstResult = await tools.get("report_and_exit").execute("first", {
        content: "authoritative report",
        summary: "Authoritative summary",
      });
      lateSendError = await sendPlainMessageIfRunning("team", "other-agent", "writer", "late message", "Late")
        .then(() => undefined, error => error);
      duplicateResult = await tools.get("report_and_exit").execute("duplicate", {
        content: "duplicate report",
        summary: "Duplicate summary",
      });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const releaseAllClaimsForAgent = vi.fn(async (teamName: string, agentName: string) => {
      return claims.releaseAllForAgent(teamName, agentName);
    });
    const options = {
      isTeammate: false,
      getTeamName: () => "different-team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent,
    };
    const writer: Member = {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "writing-hard",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "edit an isolated file",
    };
    writeTeamConfig("team", writer);
    const leadShutdown = vi.fn();
    const terminalKill = vi.fn();

    await runReadAgentInProcess("team", writer, "edit an isolated file", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
      shutdown: leadShutdown,
      terminal: { kill: terminalKill },
    }, options);

    expect(firstResult.details).toEqual({
      session: "team",
      accepted: true,
      cancelledDeliveries: 0,
      deliveryOutcome: "none",
    });
    expect(lateSendError).toEqual(expect.objectContaining({ message: expect.stringContaining("lifecycle-quarantined") }));
    expect(await readInbox("team", "writer", false, false)).toEqual([]);
    expect(duplicateResult.details).toEqual({ session: "team", accepted: false });
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledTimes(1);
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      status: "completed",
      report: "authoritative report",
      summary: "Authoritative summary",
      modelSlot: "write-system",
    }));
    expect(options.emitAgentReport).not.toHaveBeenCalled();
    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0]).toMatchObject({ text: "authoritative report", summary: "Authoritative summary" });
    expect(leadInbox[0].metadata).toMatchObject({
      finalReport: true,
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "write-system",
      initialPrompt: "edit an isolated file",
    });
    expect(releaseAllClaimsForAgent).toHaveBeenCalledTimes(1);
    expect(await claims.listClaims("team")).toEqual([]);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(leadShutdown).not.toHaveBeenCalled();
    expect(terminalKill).not.toHaveBeenCalled();
    expect(runningReadAgents.size).toBe(0);
    expect(JSON.parse(fs.readFileSync(paths.configPath("team"), "utf-8")).members.map((item: Member) => item.name))
      .toEqual(["team-lead"]);

    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      agentName: "writer",
      role: "write",
      status: "completed",
      report: "authoritative report",
      summary: "Authoritative summary",
      source: "read-agent",
      modelSlot: "write-system",
      metadata: { initialPrompt: "edit an isolated file", modelSlot: "write-system" },
    });
    expect(JSON.stringify({ state: options.rememberCompletedAgentReport.mock.calls, leadInbox, reports })).not.toContain("writing-hard");
  });

  it.each(["read", "write"] as const)("runs an admitted %s after validating its identity", async (role) => {
    const member = { ...fixtureMember("starting", role), lifecycleRunId: "starting-run" };
    writeTeamConfig("team", member);
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const options = makeRunOptions();
    await runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);
    expect(session.prompt).toHaveBeenCalledWith("investigate", { source: "extension" });
    expect(options.runningReadAgents.size).toBe(0);
  });

  it("rejects a changed admitted identity before creating a session or touching the replacement", async () => {
    const member = { ...fixtureMember("starting"), lifecycleRunId: "starting-run" };
    const replacement = { ...member, lifecycleRunId: "replacement-run" };
    writeTeamConfig("team", replacement);
    piMocks.createAgentSession.mockResolvedValue({ session: makeSession() });
    await expect(runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, makeRunOptions())).rejects.toThrow("expected run starting-run, found replacement-run");
    expect(piMocks.createAgentSession).not.toHaveBeenCalled();
    expect((await teams.readConfig("team")).members.find(item => item.name === member.name)).toEqual(replacement);
  });

  it.each([
    ["read", false], ["write", false], ["read", true], ["write", true],
  ] as const)("stops an admitted %s during startup persistence (failure: %s)", async (role, failPersistence) => {
    const member = { ...fixtureMember("starting", role), lifecycleRunId: "starting-run" };
    writeTeamConfig("team", member);
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const options = makeRunOptions();
    const lifecycle = createLifecycleRuntime({
      ...options, terminal: null, drainWriteQueue: vi.fn(async () => {}), getSessionCwd: () => root,
    });
    const tools = new Map<string, any>();
    registerTaskRuntimeTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      ...options, terminal: null, shutdownTeammate: lifecycle.shutdownTeammate,
    });
    let releasePersistence!: () => void;
    const persistenceGate = new Promise<void>(resolve => { releasePersistence = resolve; });
    let persistenceStarted!: () => void;
    const started = new Promise<void>(resolve => { persistenceStarted = resolve; });
    const withLifecycleLock = lifecycleTombstones.withLifecycleTombstoneLock;
    vi.spyOn(lifecycleTombstones, "withLifecycleTombstoneLock").mockImplementationOnce(async (team, name, operation) => {
      persistenceStarted();
      await persistenceGate;
      if (failPersistence) throw new Error("startup persistence failed");
      return withLifecycleLock(team, name, operation);
    });
    const run = runReadAgentInProcess("team", member, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, { ...options, shutdownTeammate: lifecycle.shutdownTeammate });
    await started;
    const stopping = tools.get("stop_teammate").execute("stop", { agent_name: member.name });
    try {
      await vi.waitFor(() => expect(options.runningReadAgents.get("team:starting")?.stopRequested).toBe(true));
      releasePersistence();
      expect((await stopping).details.stopped).toBe(true);
      await run;
      expect(options.runningReadAgents.size).toBe(0);
      expect((await teams.readConfig("team")).members.map(item => item.name)).toEqual(["team-lead"]);
      expect(options.releaseAllClaimsForAgent).toHaveBeenCalledOnce();
      expect(piMocks.createAgentSession).not.toHaveBeenCalled();
    } finally {
      releasePersistence();
      await Promise.allSettled([run, stopping]);
    }
  });

  it("keeps stop-before-create quarantined until the late started session finishes shutdown", async () => {
    vi.useFakeTimers();
    try {
      let resolveCreation!: (value: { session: any }) => void;
      const creation = new Promise<{ session: any }>((resolve) => { resolveCreation = resolve; });
      let markCreationStarted!: () => void;
      const creationStarted = new Promise<void>((resolve) => { markCreationStarted = resolve; });
      piMocks.createAgentSession.mockImplementation(() => {
        markCreationStarted();
        return creation;
      });

      const order: string[] = [];
      const session = makeSession();
      session.hasExtensionHandlers.mockReturnValue(true);
      session.bindExtensions.mockImplementation(async () => { order.push("session_start"); });
      session.extensionRunner.emit.mockImplementation(async () => { order.push("session_shutdown"); });
      let resolveAbort!: () => void;
      const abort = new Promise<void>((resolve) => { resolveAbort = resolve; });
      session.abort.mockImplementation(() => abort);

      const reader: Member = {
        agentId: "reader@team",
        name: "reader",
        agentType: "teammate",
        role: "read",
        model: "provider/model",
        thinking: "high",
        modelSlot: "reading-default",
        joinedAt: Date.now(),
        tmuxPaneId: "",
        cwd: root,
        subscriptions: [],
        prompt: "investigate",
      };
      writeTeamConfig("team", reader);
      const runningReadAgents = new Map<string, RunningReadAgent>();
      const releaseAllClaimsForAgent = vi.fn(async () => []);
      const options = {
        isTeammate: false,
        getTeamName: () => "team",
        runningReadAgents,
        readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
        isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
        ensureReadAgentStatusTicker: vi.fn(),
        renderReadAgentStatus: vi.fn(),
        rememberCompletedAgentReport: vi.fn(),
        emitAgentReport: vi.fn(),
        releaseAllClaimsForAgent,
      };
      const run = runReadAgentInProcess("team", reader, "investigate", {
        modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
      }, options);
      await creationStarted;
      const state = runningReadAgents.get("team:reader")!;
      expect(state.startupState).toBe("pending");

      const lifecycle = createLifecycleRuntime({
        isTeammate: false,
        terminal: null,
        runningReadAgents,
        readAgentKey: options.readAgentKey,
        isCurrentReadAgentRun: options.isCurrentReadAgentRun,
        renderReadAgentStatus: options.renderReadAgentStatus,
        releaseAllClaimsForAgent,
        drainWriteQueue: vi.fn(async () => {}),
        getSessionCwd: () => root,
        getTeamName: () => "team",
      });
      const stopping = lifecycle.shutdownTeammate("team", reader);
      await vi.waitFor(() => {
        const persisted = JSON.parse(fs.readFileSync(paths.configPath("team"), "utf-8"));
        expect(persisted.members.find((item: Member) => item.name === "reader")?.isActive).toBe(false);
      });
      expect(state.stopRequested).toBe(true);
      expect(state.acceptingMessages).toBe(false);
      expect(session.prompt).not.toHaveBeenCalled();
      expect(releaseAllClaimsForAgent).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      resolveCreation({ session });
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["session_start", "session_shutdown"]);
      expect(session.prompt).not.toHaveBeenCalled();
      expect(session.abort).toHaveBeenCalledOnce();
      expect(session.dispose).not.toHaveBeenCalled();
      expect(releaseAllClaimsForAgent).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS - 1000);
      await expect(stopping).resolves.toMatchObject({
        status: "timed_out",
        abort: "timed_out",
        dispose: "deferred",
      });
      expect(state.teardownState).toBe("quarantined");
      expect(runningReadAgents.get("team:reader")).toBe(state);
      expect(session.dispose).not.toHaveBeenCalled();
      expect(releaseAllClaimsForAgent).not.toHaveBeenCalled();

      resolveAbort();
      await state.teardownFinalizationPromise;
      await run;
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(releaseAllClaimsForAgent).toHaveBeenCalledOnce();
      expect(runningReadAgents.has("team:reader")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts report_and_exit without aborting or waiting for a stuck direct delivery", async () => {
    vi.useFakeTimers();
    try {
      const session = makeSession();
      let settleRawDelivery!: () => void;
      const rawDelivery = new Promise<void>((resolve) => { settleRawDelivery = resolve; });
      let markDeliveryStarted!: () => void;
      const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
      session.sendUserMessage.mockImplementation(() => {
        markDeliveryStarted();
        return rawDelivery;
      });
      let releasePrompt!: () => void;
      const promptRelease = new Promise<void>((resolve) => { releasePrompt = resolve; });
      let reportSubmitted!: () => void;
      const submitted = new Promise<void>((resolve) => { reportSubmitted = resolve; });
      let abortStarted!: () => void;
      const aborting = new Promise<void>((resolve) => { abortStarted = resolve; });
      session.abort.mockImplementation(async () => { abortStarted(); });

      const runningReadAgents = new Map<string, RunningReadAgent>();
      let reportResult: any;
      let deliveryOutcome: Promise<unknown> | undefined;
      session.prompt.mockImplementation(async () => {
        const state = runningReadAgents.get("team:writer")!;
        deliveryOutcome = sendMessageToRunningReadAgent(state, "Queued scope update")
          .catch((error: Error) => error);
        await deliveryStarted;
        const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
        const reportTool = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
        reportResult = await reportTool.execute("report", {
          content: "authoritative report",
          summary: "Done",
        });
        reportSubmitted();
        await promptRelease;
      });
      piMocks.createAgentSession.mockResolvedValue({ session });
      const writer: Member = {
        agentId: "writer@team",
        name: "writer",
        agentType: "teammate",
        role: "write",
        model: "provider/model",
        thinking: "xhigh",
        modelSlot: "writing-hard",
        joinedAt: Date.now(),
        tmuxPaneId: "",
        cwd: root,
        subscriptions: [],
        prompt: "edit an isolated file",
      };
      writeTeamConfig("team", writer);
      const options = {
        isTeammate: false,
        getTeamName: () => "team",
        runningReadAgents,
        readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
        isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
        ensureReadAgentStatusTicker: vi.fn(),
        renderReadAgentStatus: vi.fn(),
        rememberCompletedAgentReport: vi.fn(),
        emitAgentReport: vi.fn(),
        releaseAllClaimsForAgent: vi.fn(async () => []),
      };

      const run = runReadAgentInProcess("team", writer, "edit an isolated file", {
        modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
      }, options);
      await submitted;

      expect(reportResult.details).toMatchObject({
        accepted: true,
        cancelledDeliveries: 1,
        deliveryOutcome: "cancelled",
      });
      expect(session.abort).not.toHaveBeenCalled();
      await expect(deliveryOutcome).resolves.toEqual(expect.objectContaining({
        message: expect.stringContaining("was cancelled"),
      }));

      releasePrompt();
      await aborting;
      await vi.advanceTimersByTimeAsync(2500);
      await run;
      const quarantined = runningReadAgents.get("team:writer")!;
      expect(quarantined.teardownState).toBe("quarantined");
      expect(session.dispose).not.toHaveBeenCalled();

      settleRawDelivery();
      await quarantined.teardownFinalizationPromise;
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(runningReadAgents.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not accept or dispose a nested run when persisted report admission cannot close", async () => {
    const session = makeSession();
    let reportError: unknown;
    session.prompt.mockImplementation(async () => {
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const reportTool = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
      reportError = await reportTool.execute("report", {
        content: "must not be accepted",
        summary: "Rejected report",
      }).then(() => undefined, (error: unknown) => error);
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    };
    const writer: Member = {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "writing-hard",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "edit an isolated file",
      isActive: true,
    };
    writeTeamConfig("team", writer);
    vi.spyOn(teams, "updateMember").mockRejectedValue(new Error("config lock unavailable"));
    vi.spyOn(teams, "removeMemberMatchingRun").mockRejectedValue(new Error("config removal unavailable"));

    await expect(runReadAgentInProcess("team", writer, "edit an isolated file", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options)).rejects.toThrow("Could not close message admission for writer in team");

    expect(reportError).toEqual(expect.objectContaining({
      message: expect.stringContaining("Could not close message admission for writer in team"),
    }));
    expect((await teams.readConfig("team")).members.find(member => member.name === "writer")?.isActive).toBe(true);
    expect(options.rememberCompletedAgentReport).not.toHaveBeenCalled();
    expect(options.emitAgentReport).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(runningReadAgents.has("team:writer")).toBe(true);
  });

  it("reports unexpected writer errors as failures even after report submission", async () => {
    const session = makeSession();
    session.hasExtensionHandlers.mockReturnValue(true);
    let reportResult: any;
    session.prompt.mockImplementation(async () => {
      expect(runningReadAgents.get("team:writer")).toMatchObject({ modelSlot: "write-system" });
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const reportTool = sessionOptions.customTools.find((tool: any) => tool.name === "report_and_exit");
      reportResult = await reportTool.execute("report", {
        content: "submitted before failure",
        summary: "Submitted summary",
      });
      throw new Error("unexpected provider failure");
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const releaseAllClaimsForAgent = vi.fn(async (teamName: string, agentName: string) => {
      return claims.releaseAllForAgent(teamName, agentName);
    });
    const options = {
      isTeammate: false,
      getTeamName: () => "different-team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent,
    };
    const writer: Member = {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "writing-hard",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "edit an isolated file",
    };
    writeTeamConfig("team", writer);
    const leadShutdown = vi.fn();
    const terminalKill = vi.fn();

    await runReadAgentInProcess("team", writer, "edit an isolated file", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
      shutdown: leadShutdown,
      terminal: { kill: terminalKill },
    }, options);

    expect(reportResult.details).toEqual({
      session: "team",
      accepted: true,
      cancelledDeliveries: 0,
      deliveryOutcome: "none",
    });
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledTimes(1);
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      status: "failed",
      report: "Edit agent writer failed: unexpected provider failure",
      modelSlot: "write-system",
    }));
    expect(options.emitAgentReport).not.toHaveBeenCalled();
    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0].metadata).toMatchObject({
      finalReport: true,
      model: "provider/model",
      thinking: "xhigh",
      modelSlot: "write-system",
      initialPrompt: "edit an isolated file",
    });
    expect(releaseAllClaimsForAgent).toHaveBeenCalledTimes(1);
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(leadShutdown).not.toHaveBeenCalled();
    expect(terminalKill).not.toHaveBeenCalled();
    expect(runningReadAgents.size).toBe(0);

    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      agentName: "writer",
      role: "write",
      status: "failed",
      report: "Edit agent writer failed: unexpected provider failure",
      source: "read-agent",
      modelSlot: "write-system",
      metadata: { initialPrompt: "edit an isolated file", modelSlot: "write-system" },
    });
    expect(JSON.stringify({ state: options.rememberCompletedAgentReport.mock.calls, leadInbox, reports })).not.toContain("writing-hard");
  });

  it("preserves the full per-update assistant snippet while processing text deltas incrementally", () => {
    const state = {
      runId: "run-reader",
      name: "reader",
      teamName: "team",
      startedAt: 0,
      tokensUsed: 0,
      status: "thinking",
      recentEvents: [],
      lastActivityAt: 0,
    } as RunningReadAgent;
    const session = { getSessionStats: () => ({ tokens: { total: 42 } }) } as any;
    const renderReadAgentStatus = vi.fn();
    const expectedSnippet = (text: string) => {
      const sanitized = sanitizeTuiLine(text).trim();
      return sanitized.length > 180 ? `…${sanitized.slice(-179)}` : sanitized;
    };

    let firstPart = "";
    handleReadAgentSessionEvent(state, session, {
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: firstPart }] },
    }, renderReadAgentStatus);

    for (const delta of ["Alpha\t", "beta\n", "gamma ", "x".repeat(2_500)]) {
      firstPart += delta;
      const message = { role: "assistant", content: [{ type: "text", text: firstPart }] };
      handleReadAgentSessionEvent(state, session, {
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
      }, renderReadAgentStatus);
      expect(state.latestAssistantSnippet).toBe(expectedSnippet(firstPart));
    }

    let secondPart = "";
    let message = {
      role: "assistant",
      content: [{ type: "text", text: firstPart }, { type: "text", text: secondPart }],
    };
    handleReadAgentSessionEvent(state, session, {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: message },
    }, renderReadAgentStatus);
    secondPart = "second part";
    message = {
      role: "assistant",
      content: [{ type: "text", text: firstPart }, { type: "text", text: secondPart }],
    };
    handleReadAgentSessionEvent(state, session, {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: secondPart, partial: message },
    }, renderReadAgentStatus);
    expect(state.latestAssistantSnippet).toBe(expectedSnippet(`${firstPart}\n${secondPart}`));

    secondPart += "\x1b[2K\runsafe tail";
    message = {
      role: "assistant",
      content: [{ type: "text", text: firstPart }, { type: "text", text: secondPart }],
    };
    handleReadAgentSessionEvent(state, session, {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "\x1b[2K\runsafe tail", partial: message },
    }, renderReadAgentStatus);
    expect(state.latestAssistantSnippet).toBe(expectedSnippet(`${firstPart}\n${secondPart}`));
    expect(state.tokensUsed).toBe(42);
    expect(renderReadAgentStatus).toHaveBeenCalledTimes(7);
  });

  it("ignores pre-response estimates and adopts provider context usage on the first measured update", () => {
    const state = {
      runId: "run-reader",
      name: "reader",
      teamName: "team",
      startedAt: 0,
      tokensUsed: 0,
      status: "thinking",
      recentEvents: [],
      lastActivityAt: 0,
    } as RunningReadAgent;
    let tokensUsed = 0;
    let contextTokens = 597;
    let contextPercent = 0.3;
    const session = {
      messages: [{ role: "user", content: "prompt" }],
      getSessionStats: vi.fn(() => ({
        tokens: { total: tokensUsed },
        contextUsage: { tokens: contextTokens, contextWindow: 200_000, percent: contextPercent },
      })),
    } as any;
    const renderReadAgentStatus = vi.fn();
    const update = { type: "message_update", message: { role: "toolResult", content: "partial" } };

    handleReadAgentSessionEvent(state, session, update, renderReadAgentStatus);
    expect(state.tokensUsed).toBe(0);
    expect(state.contextUsage).toEqual({ tokens: 0, contextWindow: 200_000, percent: 0 });
    tokensUsed = 2_300_000;
    contextTokens = 80_000;
    contextPercent = 40;
    handleReadAgentSessionEvent(state, session, update, renderReadAgentStatus);

    expect(session.getSessionStats).toHaveBeenCalledTimes(2);
    expect(state.tokensUsed).toBe(2_300_000);
    expect(state.contextUsage).toEqual({ tokens: 80_000, contextWindow: 200_000, percent: 40 });
    expect(renderReadAgentStatus).toHaveBeenCalledTimes(2);
  });

  it("emits normalized progress without resetting tool-working status for non-assistant message updates", async () => {
    let subscriber: ((event: any) => void) | undefined;
    const session = makeSession();
    session.subscribe.mockImplementation((callback: (event: any) => void) => {
      subscriber = callback;
    });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    session.prompt.mockImplementation(async () => {
      const sessionOptions = piMocks.createAgentSession.mock.calls[0][0];
      const progressTool = sessionOptions.customTools.find((tool: any) => tool.name === "report_progress");
      await progressTool.execute("progress", { status: "  Inspecting\n event   handling  " });
      expect(runningReadAgents.get("team:reader")).toMatchObject({
        status: "thinking",
        latestProgress: "Inspecting event handling",
        progressUpdatedAt: expect.any(Number),
      });

      subscriber?.({ type: "tool_execution_start", toolName: "bash" });
      subscriber?.({ type: "message_update", message: { role: "toolResult", content: "not assistant text" } });
      expect(runningReadAgents.get("team:reader")).toMatchObject({
        status: "working",
        activeToolName: "bash",
        latestProgress: "Inspecting event handling",
      });
      subscriber?.({ type: "tool_execution_end", toolName: "bash" });
      expect(runningReadAgents.get("team:reader")).toMatchObject({
        status: "thinking",
        latestProgress: "Inspecting event handling",
      });
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const options = {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      emitAgentProgress: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("team", {
      agentId: "reader@team",
      name: "reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
    }, "investigate", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    expect(options.emitAgentProgress).toHaveBeenCalledWith("team", "reader", "Inspecting event handling", expect.any(Number));
  });

  it("emits prompt-build reports even when prompt-build is not the adopted lead team", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      getTeamName: () => "active-user-team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("prompt-build-123", {
      agentId: "prompt-branch-1@prompt-build-123",
      name: "prompt-branch-1",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "build prompt options",
    }, "build prompt options", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    expect(options.emitAgentReport).toHaveBeenCalledWith("prompt-build-123", "prompt-branch-1", expect.any(Number), 42, "final report", true);
    const leadInbox = await readInbox("prompt-build-123", "team-lead", false, false);
    expect(leadInbox).toEqual([]);
  });

  it("emits a private pi-prompt writer report without requesting lead injection", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      getTeamName: () => "session-main",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(), renderReadAgentStatus: vi.fn(), rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(), releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("session-main", {
      agentId: "planner@session-main", name: "planner", agentType: "teammate", role: "write",
      model: "provider/model", thinking: "high", modelSlot: "writing-basic", joinedAt: Date.now(),
      tmuxPaneId: "", cwd: root, subscriptions: [], prompt: "write plan",
      metadata: { piPromptPlanning: { version: 1, correlation: "private" } },
    }, "write plan", { modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) } }, options);

    expect(options.emitAgentReport).toHaveBeenCalledWith("session-main", "planner", expect.any(Number), 42, "final report", true, true);
  });

  it("suppresses lead report injection for workflow-spawned read agents while persisting report events", async () => {
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("team", {
      agentId: "workflow-reader@team",
      name: "workflow-reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "workflow branch",
      metadata: { operationId: "op-1", workflowRunId: "run-1" },
    }, "workflow branch", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    expect(options.emitAgentReport).not.toHaveBeenCalled();
    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toEqual([]);

    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      agentName: "workflow-reader",
      status: "completed",
      report: "final report",
      operationId: "op-1",
      workflowRunId: "run-1",
      source: "read-agent",
    });
  });

  it("suppresses failed workflow read-agent injection while persisting failure events", async () => {
    const session = makeSession();
    session.prompt.mockRejectedValue(new Error("branch failed"));
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
    };

    await runReadAgentInProcess("team", {
      agentId: "workflow-reader@team",
      name: "workflow-reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "workflow branch",
      metadata: { orchestration: { operationId: "op-1", workflowRunId: "run-1" } },
    }, "workflow branch", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    expect(options.emitAgentReport).not.toHaveBeenCalled();
    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toEqual([]);

    const reports = await listTeamReportEvents("team");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      agentName: "workflow-reader",
      status: "failed",
      report: "Read agent workflow-reader failed: branch failed",
      operationId: "op-1",
      workflowRunId: "run-1",
      source: "read-agent",
    });
  });

  it("directly wakes an active helper requester even when the helper already persisted its report", async () => {
    const session = makeSession();
    session.prompt.mockImplementation(async () => {
      await sendPlainMessage("team", "writer-reader", "writer", "final report", "Read helper writer-reader report", "cyan");
      await sendPlainMessage("team", "writer-reader", "team-lead", "Read helper writer-reader completed for writer. Report sent to writer.", "Read helper writer-reader done", "cyan");
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      agentName: "team-lead",
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      quietTrigger: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      notifyLeadOfInboxReports: vi.fn(async () => {}),
      deliverMessageToActiveAgent: vi.fn(async () => true),
    };

    await runReadAgentInProcess("team", {
      agentId: "writer-reader@team",
      name: "writer-reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
      color: "cyan",
      requestedBy: "writer",
      helperKind: "read_helper",
    }, "investigate", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    const requesterInbox = await readInbox("team", "writer", false, false);
    expect(requesterInbox).toHaveLength(1);
    expect(requesterInbox[0]).toMatchObject({
      from: "writer-reader",
      text: "final report",
      summary: "Read helper writer-reader report",
      color: "cyan",
      read: false,
    });

    expect(options.deliverMessageToActiveAgent).toHaveBeenCalledWith("team", "writer", "final report");

    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(2);
    const classifiedNotice = leadInbox.find(message => message.metadata?.helperCompletion === true);
    expect(classifiedNotice).toMatchObject({
      from: "writer-reader",
      summary: "Read helper writer-reader done",
      color: "cyan",
      read: false,
      metadata: {
        finalReport: true,
        helperCompletion: true,
        outcome: "completed",
        requestedBy: "writer",
      },
    });
    expect(classifiedNotice?.text).toContain("Report sent to writer");
    expect(classifiedNotice?.text).not.toBe("final report");
    expect(options.emitAgentReport).not.toHaveBeenCalled();
    expect(options.quietTrigger).not.toHaveBeenCalled();
    expect(options.renderLeadInboxStatus).toHaveBeenCalled();
    expect(options.notifyLeadOfInboxReports).toHaveBeenCalledWith("team");

    const promptText = piMocks.loaderOptions[0].appendSystemPrompt.join("\n");
    expect(promptText).toContain("depth-1 read helper requested by 'writer'");
    expect(promptText).toContain("report_and_exit deliverable goes to that requesting writer");
    expect(promptText).toContain("lead receives only a classified completion notice");
    expect(promptText).not.toContain("send your concise report to the lead and stop");
  });

  it("retains an old child report instead of delivering it to a replacement parent run", async () => {
    const helper: Member = {
      agentId: "stale-child@team",
      name: "stale-child",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "read-review",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "inspect the old parent assignment",
      requestedBy: "writer",
      helperKind: "read_helper",
      delegationDepth: 1,
      parentAgentName: "writer",
      parentLifecycleRunId: "writer-run-A",
    };
    const replacementParent: Member = {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      thinking: "medium",
      modelSlot: "write-feature",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      lifecycleRunId: "writer-run-B",
      delegationDepth: 0,
      allowNestedReadAgents: true,
      isActive: true,
    };
    writeTeamConfig("team", helper, [replacementParent]);
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      agentName: "team-lead",
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      renderLeadInboxStatus: vi.fn(async () => {}),
      notifyLeadOfInboxReports: vi.fn(async () => {}),
      deliverMessageToActiveAgent: vi.fn(async () => false),
    };

    await runReadAgentInProcess("team", helper, helper.prompt!, {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);

    expect(options.deliverMessageToActiveAgent).toHaveBeenCalledWith(
      "team",
      "writer",
      "final report",
      "writer-run-A"
    );
    expect(await readInbox("team", "writer", false, false)).toEqual([]);
    expect((await listTeamReportEvents("team")).filter(event => event.agentName === "stale-child"))
      .toEqual([expect.objectContaining({ status: "completed", report: "final report" })]);
    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0].metadata).toMatchObject({
      finalReport: true,
      helperCompletion: true,
      requestedBy: "writer",
    });
    expect(leadInbox[0].text).toContain("writer is no longer running; the report is retained here");
  });

  it("uses a fallback delivery if a read helper exits without sending its required report", async () => {
    writeTeamConfig("team", {
      agentId: "writer-reader@team",
      name: "writer-reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
      color: "cyan",
      requestedBy: "writer",
      helperKind: "read_helper",
    }, [{
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%writer",
      cwd: root,
      subscriptions: [],
      isActive: true,
    }]);
    const session = makeSession();
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = {
      isTeammate: false,
      agentName: "team-lead",
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      quietTrigger: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      notifyLeadOfInboxReports: vi.fn(async () => {}),
    };

    await runReadAgentInProcess("team", {
      agentId: "writer-reader@team",
      name: "writer-reader",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
      color: "cyan",
      requestedBy: "writer",
      helperKind: "read_helper",
    }, "investigate", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);

    const requesterInbox = await readInbox("team", "writer", false, false);
    expect(requesterInbox).toHaveLength(1);
    expect(requesterInbox[0]).toMatchObject({
      from: "writer-reader",
      text: "final report",
      summary: "Read helper writer-reader report",
      color: "cyan",
      read: false,
    });

    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0]).toMatchObject({
      metadata: {
        finalReport: true,
        helperCompletion: true,
        outcome: "completed",
        requestedBy: "writer",
      },
    });
    expect(leadInbox[0].text).toContain("Report sent to writer");
    expect(options.notifyLeadOfInboxReports).toHaveBeenCalledWith("team");
  });

  it("keeps rapid same-name helper notices and tmux reports isolated by run id", async () => {
    const helper: Member = {
      agentId: "reused-helper@team",
      name: "reused-helper",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
      color: "cyan",
      requestedBy: "writer",
      helperKind: "read_helper",
      isActive: true,
    };
    const writer: Member = {
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%writer",
      cwd: root,
      subscriptions: [],
      isActive: true,
    };
    writeTeamConfig("team", helper, [writer]);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const notifyLeadOfInboxReports = vi.fn(async () => {});
    const options = {
      isTeammate: false,
      agentName: "team-lead",
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      renderLeadInboxStatus: vi.fn(async () => {}),
      notifyLeadOfInboxReports,
      deliverMessageToActiveAgent: vi.fn(async () => false),
    };

    const firstSession = makeSession();
    piMocks.createAgentSession.mockResolvedValueOnce({ session: firstSession });
    await runReadAgentInProcess("team", helper, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);
    const firstNotices = await readInbox("team", "team-lead", false, false);
    expect(firstNotices).toHaveLength(1);
    const firstRunId = firstNotices[0].metadata?.runId;
    expect(firstRunId).toEqual(expect.any(String));
    await readInbox("team", "team-lead", true, true);

    const secondHelper = { ...helper, joinedAt: Date.now(), isActive: true };
    await teams.addMember("team", secondHelper);
    const secondSession = makeSession();
    secondSession.prompt.mockRejectedValue(new Error("second run failed"));
    piMocks.createAgentSession.mockResolvedValueOnce({ session: secondSession });
    await runReadAgentInProcess("team", secondHelper, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);

    const classifiedNotices = (await readInbox("team", "team-lead", false, false))
      .filter(message => message.metadata?.helperCompletion === true);
    expect(classifiedNotices).toHaveLength(2);
    expect(classifiedNotices.map(message => message.metadata?.outcome)).toEqual(["completed", "failed"]);
    expect(classifiedNotices[1].metadata?.runId).toEqual(expect.any(String));
    expect(classifiedNotices[1].metadata?.runId).not.toBe(firstRunId);
    const unreadLead = await readInbox("team", "team-lead", true, false);
    expect(unreadLead).toHaveLength(1);
    expect(unreadLead[0].metadata?.runId).toBe(classifiedNotices[1].metadata?.runId);
    expect(notifyLeadOfInboxReports).toHaveBeenCalledTimes(2);

    const requesterReports = await readInbox("team", "writer", false, false);
    expect(requesterReports).toHaveLength(2);
    expect(requesterReports.map(message => message.metadata?.outcome)).toEqual(["completed", "failed"]);
    expect(new Set(requesterReports.map(message => message.metadata?.runId)).size).toBe(2);
  });

  it("publishes a rejected prompt failure while the helper remains live during deferred delivery", async () => {
    const helper: Member = {
      agentId: "failing-helper@team",
      name: "failing-helper",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      modelSlot: "reading-default",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      prompt: "investigate",
      color: "cyan",
      requestedBy: "writer",
      helperKind: "read_helper",
    };
    writeTeamConfig("team", helper, [{
      agentId: "writer@team",
      name: "writer",
      agentType: "teammate",
      role: "write",
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "%writer",
      cwd: root,
      subscriptions: [],
      isActive: true,
    }]);
    const session = makeSession();
    session.prompt.mockRejectedValue(new Error("source unavailable"));
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const liveFailureRenders: RunningReadAgent[] = [];
    let markFailureDeliveryStarted!: () => void;
    const failureDeliveryStarted = new Promise<void>((resolve) => { markFailureDeliveryStarted = resolve; });
    let releaseFailureDelivery!: () => void;
    const failureDeliveryGate = new Promise<void>((resolve) => { releaseFailureDelivery = resolve; });
    const options = {
      isTeammate: false,
      agentName: "team-lead",
      getTeamName: () => "team",
      runningReadAgents,
      readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
      isCurrentReadAgentRun: (key: string, state: RunningReadAgent) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(() => {
        const state = runningReadAgents.get("team:failing-helper");
        if (state?.lastError) liveFailureRenders.push(state);
      }),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      quietTrigger: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      notifyLeadOfInboxReports: vi.fn(async () => {}),
      deliverMessageToActiveAgent: vi.fn(async () => {
        markFailureDeliveryStarted();
        await failureDeliveryGate;
        return true;
      }),
    };

    const run = runReadAgentInProcess("team", helper, "investigate", {
      modelRegistry: {
        find: vi.fn(() => ({ provider: "provider", id: "model" })),
      },
    }, options);
    await failureDeliveryStarted;

    const liveFailureState = runningReadAgents.get("team:failing-helper");
    expect(session.prompt).toHaveBeenCalledWith("investigate", { source: "extension" });
    expect(liveFailureState?.lastError).toMatchObject({ message: "source unavailable" });
    expect(liveFailureState?.lastError?.timestamp).toEqual(expect.any(Number));
    expect(liveFailureRenders).toContain(liveFailureState);
    expect(runningReadAgents.get("team:failing-helper")).toBe(liveFailureState);

    releaseFailureDelivery();
    await run;
    expect(runningReadAgents.has("team:failing-helper")).toBe(false);
    expect(options.deliverMessageToActiveAgent).toHaveBeenCalledWith(
      "team",
      "writer",
      "Read agent failing-helper failed: source unavailable"
    );
    expect(await readInbox("team", "writer", false, false)).toEqual([]);
    const leadInbox = await readInbox("team", "team-lead", false, false);
    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0]).toMatchObject({
      metadata: {
        finalReport: true,
        helperCompletion: true,
        outcome: "failed",
        requestedBy: "writer",
      },
    });
    expect(options.notifyLeadOfInboxReports).toHaveBeenCalledTimes(1);
    expect(options.notifyLeadOfInboxReports).toHaveBeenCalledWith("team");
    expect(options.quietTrigger).not.toHaveBeenCalled();
  });

  it("keeps a report-recovery interruption alive for a follow-up on the same session", async () => {
    const reader = fixtureMember("reader");
    writeTeamConfig("team", reader);
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const session = makeSession();
    session.messages = [];
    let streaming = false;
    Object.defineProperty(session, "isStreaming", { get: () => streaming });
    let recoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { recoveryStarted = resolve; });
    let releaseRecovery!: () => void;
    const pendingRecovery = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    session.prompt.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      streaming = true;
      recoveryStarted();
      await pendingRecovery;
      streaming = false;
    });
    session.abort.mockImplementation(async () => {});
    let followUpGeneration: number | undefined;
    session.sendUserMessage.mockImplementation(async () => {
      followUpGeneration = runningReadAgents.get("team:reader")?.activeOperationGeneration;
      session.messages = [{ role: "assistant", content: "resumed recovery report" }];
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const options = makeRunOptions(runningReadAgents);
    const run = runReadAgentInProcess("team", reader, "investigate", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);

    await started;
    const state = runningReadAgents.get("team:reader")!;
    Object.assign(state, { status: "working", activeToolName: "bash" });
    const interrupt = createTeammateInterrupter({
      terminal: null, runningReadAgents, readAgentKey: (team, agent) => `${team}:${agent}`,
      getTeamName: () => "team", settleTimeoutMs: 50,
    });
    await expect(interrupt("reader")).resolves.toMatchObject({ status: "pending", lifecycleRunId: state.runId });

    const followUp = sendMessageToRunningReadAgent(state, "Finish with the recovered report");
    await Promise.resolve();
    expect(session.sendUserMessage).not.toHaveBeenCalled();
    expect(state.operationInterruptPromise).toBeDefined();
    expect(runningReadAgents.get("team:reader")).toBe(state);
    expect(state).toMatchObject({ acceptingMessages: true, teardownState: "active" });
    for (const cleanup of [session.clearQueue, session.dispose, options.releaseAllClaimsForAgent, options.rememberCompletedAgentReport]) {
      expect(cleanup).not.toHaveBeenCalled();
    }

    releaseRecovery();
    await expect(followUp).resolves.toBe(true);
    await run;
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(session.sendUserMessage).toHaveBeenCalledWith("Finish with the recovered report", undefined);
    expect(followUpGeneration).toBe(3);
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      name: "reader", status: "completed", report: "resumed recovery report",
    }));
  });

  it("keeps an interrupted read agent alive for a follow-up turn on the same session", async () => {
    const reader = fixtureMember("reader");
    writeTeamConfig("team", reader);
    const session = makeSession();
    session.messages = [];
    let streaming = false;
    Object.defineProperty(session, "isStreaming", { get: () => streaming });
    let promptStarted!: () => void;
    let releasePrompt!: () => void;
    const started = new Promise<void>((resolve) => { promptStarted = resolve; });
    const pending = new Promise<void>((resolve) => { releasePrompt = resolve; });
    session.prompt.mockImplementationOnce(async () => {
      streaming = true;
      promptStarted();
      await pending;
      streaming = false;
    });
    session.abort.mockImplementation(async () => { streaming = false; releasePrompt(); });
    session.sendUserMessage.mockImplementation(async () => {
      session.messages = [{ role: "assistant", content: "resumed final report" }];
    });
    piMocks.createAgentSession.mockResolvedValue({ session });
    const runningReadAgents = new Map<string, RunningReadAgent>();
    const options = makeRunOptions(runningReadAgents);
    const run = runReadAgentInProcess("team", reader, "run a long command", {
      modelRegistry: { find: vi.fn(() => ({ provider: "provider", id: "model" })) },
    }, options);

    await started;
    const state = runningReadAgents.get("team:reader")!;
    Object.assign(state, { status: "working", activeToolName: "bash" });
    const interrupt = createTeammateInterrupter({
      terminal: null, runningReadAgents, readAgentKey: (team, agent) => `${team}:${agent}`,
      getTeamName: () => "team", settleTimeoutMs: 50,
    });
    await expect(interrupt("reader")).resolves.toMatchObject({
      status: "interrupted", lifecycleRunId: state.runId, mechanism: "agent-session-abort",
    });
    await vi.waitFor(() => expect(state.operationAwaitingResume).toBe(true));

    const liveMember = (await teams.readConfig("team")).members.find(item => item.name === "reader");
    expect(liveMember).toMatchObject({ lifecycleRunId: state.runId, role: "read" });
    expect(liveMember?.isActive).not.toBe(false);
    expect(runningReadAgents.get("team:reader")).toBe(state);
    expect(state).toMatchObject({ acceptingMessages: true, teardownState: "active" });
    expect(state.stopRequested).not.toBe(true);
    for (const cleanup of [session.clearQueue, session.dispose, options.releaseAllClaimsForAgent, options.rememberCompletedAgentReport]) {
      expect(cleanup).not.toHaveBeenCalled();
    }

    await expect(sendMessageToRunningReadAgent(state, "Continue without the long command")).resolves.toBe(true);
    await run;
    expect(session.sendUserMessage).toHaveBeenCalledWith("Continue without the long command", undefined);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(options.rememberCompletedAgentReport).toHaveBeenCalledWith("team", expect.objectContaining({
      name: "reader", status: "completed", report: "resumed final report",
    }));
  });
});
