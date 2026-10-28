import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as paths from "../../src/utils/paths";
import * as teams from "../../src/utils/teams";
import * as claims from "../../src/utils/claims";
import * as reports from "../../src/utils/report-events";
import * as messaging from "../../src/utils/messaging";
import { readLifecycleTombstone } from "../../src/utils/lifecycle-tombstone";
import type { Member } from "../../src/utils/models";
import type { RunningReadAgent } from "../runtime/types";
import { runExternalAgent } from "./external-agent";
import * as piRuntimeApi from "../internal/pi-runtime-api";
import { runReadAgentInProcess, sendMessageToRunningReadAgent } from "./read-agent";
import { createLifecycleRuntime } from "../team/lifecycle";
import { createTeammateInterrupter } from "../runtime/teammate-interrupt";
import { ExternalCapacityError, type ExternalHarnessResult } from "./external-harness";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "external-agent-test-"));
  vi.spyOn(paths, "teamDir").mockImplementation(team => path.join(root, team));
  for (const [name, suffix] of Object.entries({ configPath: "config.json", claimsPath: "claims.json", reportEventsPath: "reports.json", writeQueuePath: "write-queue.json" })) {
    vi.spyOn(paths, name as "configPath").mockImplementation(team => path.join(root, team, suffix));
  }
  vi.spyOn(paths, "runtimeStatusPath").mockImplementation((team, name) => path.join(root, team, "runtime", `${name}.json`));
  vi.spyOn(paths, "inboxPath").mockImplementation((team, name) => path.join(root, team, "inboxes", `${name}.json`));
  vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((team, name) => path.join(root, team, "lifecycle", `${name}.json`));
  vi.spyOn(paths, "reportFilesDir").mockReturnValue(path.join(root, "reports"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

async function setup(parentRun?: string) {
  teams.createTeam("test", "session-id", "lead", "test");
  const member: Member = {
    agentId: "reader@test",
    name: "reader",
    agentType: "teammate",
    role: "read",
    modelSlot: "read-review",
    joinedAt: Date.now(),
    tmuxPaneId: "",
    cwd: root,
    subscriptions: [],
    externalHarness: { name: "review", kind: "claude", command: "/bin/claude", args: [], instructions: "Keep scope." },
    ...(parentRun ? { requestedBy: "writer", parentAgentName: "writer", parentLifecycleRunId: parentRun, delegationDepth: 1 as const } : {}),
  };
  if (parentRun) {
    const parent: Member = { ...member, name: "writer", agentId: "writer@test", role: "write", externalHarness: undefined };
    await teams.addMember("test", parent);
    member.parentLifecycleRunId = parent.lifecycleRunId;
  }
  await teams.addMember("test", member);
  let resolve!: (result: ExternalHarnessResult) => void;
  let reject!: (error: Error) => void;
  const result = new Promise<ExternalHarnessResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const control = {
    reportPath: path.join(root, "external", "report.json"),
    start: vi.fn(async () => {}),
    result,
    stop: vi.fn(async () => { reject(new Error("Stopped")); }),
    focus: vi.fn(async () => {}),
    message: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
  };
  const states = new Map<string, RunningReadAgent>();
  const key = (team: string, name: string) => `${team}:${name}`;
  const shared = {
    isTeammate: false,
    getTeamName: () => "test",
    runningReadAgents: states,
    readAgentKey: key,
    isCurrentReadAgentRun: (id: string, state: RunningReadAgent) => states.get(id) === state,
    renderReadAgentStatus: vi.fn(),
    releaseAllClaimsForAgent: vi.fn(claims.releaseAllForAgent),
  };
  const lifecycle = createLifecycleRuntime({
    ...shared,
    terminal: null,
    drainWriteQueue: async () => {},
    getSessionCwd: () => root,
  });
  const options = {
    ...shared,
    ensureReadAgentStatusTicker: vi.fn(),
    rememberCompletedAgentReport: vi.fn(),
    emitAgentReport: vi.fn(),
    notifyFallback: vi.fn(),
    shutdownTeammate: lifecycle.shutdownTeammate,
    deliverMessageToActiveAgent: vi.fn(async () => true),
    notifyLeadOfInboxReports: vi.fn(async () => {}),
    createExternalRun: vi.fn(() => control),
    runNativeAgent: vi.fn<typeof runReadAgentInProcess>(async () => {}),
  };
  const launch = () => runExternalAgent("test", member, "Inspect source", {}, options);
  const complete = () => resolve({ outcome: "succeeded", content: "Reviewed the assigned source", artifacts: [] });
  return { member, control, states, options, launch, complete, fail: reject, lifecycle };
}

describe("external agent ownership and reports", () => {
  it("notifies the user and transfers the same run and claims to the lower tier only after external stop", async () => {
    const f = await setup();
    f.member.externalHarness!.nativeFallback = { modelSlot: "read-collect", model: "openai/test-model", thinking: "high" };
    let stopped = false;
    f.control.stop.mockImplementation(async () => {
      stopped = true;
    });
    f.options.notifyFallback.mockImplementation(content => {
      expect(stopped).toBe(true);
      for (const detail of ["reader", "read-review", "read-collect", "openai/test-model"]) {
        expect(content).toContain(detail);
      }
      expect(content).toMatch(/quota|rate limit/i);
    });
    f.options.runNativeAgent.mockImplementation(async (_team, member, prompt) => {
      expect(stopped).toBe(true);
      expect(f.options.notifyFallback).toHaveBeenCalledOnce();
      expect(f.options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
      expect(member).toMatchObject({ name: "reader", role: "read", modelSlot: "read-collect", lifecycleRunId: f.member.lifecycleRunId, model: "openai/test-model", thinking: "high" });
      expect(member.externalHarness).toBeUndefined();
      expect(prompt).toContain("Inspect source");
      expect((await teams.readConfig("test")).members.find(item => item.name === "reader")).toMatchObject({ modelSlot: "read-collect", model: "openai/test-model" });
      f.states.delete("test:reader");
    });
    const work = f.launch();
    await vi.waitFor(() => expect(f.control.start).toHaveBeenCalled());
    f.fail(new ExternalCapacityError("rate_limit"));
    await work;
    expect(f.options.runNativeAgent).toHaveBeenCalledOnce();
    expect(f.options.emitAgentReport).not.toHaveBeenCalled();
    expect(f.options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
  });

  it.each(["unchanged", "changed"])("uses the real native controller with %s tier configuration at handoff", async configuration => {
    const f = await setup();
    f.member.role = "write";
    f.member.modelSlot = "write-critical";
    await teams.updateMember("test", f.member.name, { role: "write", modelSlot: "write-critical" });
    vi.spyOn(os, "homedir").mockReturnValue(root);
    const settingsPath = path.join(root, ".pi/agent/pi-extended-teams/settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ favoriteModels: {
      "write-critical": { harness: "review" },
      "write-system": { model: "openai/test-model", thinking: "high" },
    } }));
    f.member.externalHarness!.nativeFallback = { modelSlot: "write-system", model: "openai/test-model", thinking: "high" };
    const api = await piRuntimeApi.loadPiRuntimeApi();
    const session = {
      messages: [{ role: "assistant", content: "Native fallback completed the assignment" }],
      getSessionStats: () => ({ tokens: { total: 1 } }),
      subscribe: vi.fn(),
      prompt: vi.fn(async () => {}),
      bindExtensions: vi.fn(async () => {}),
      isStreaming: false,
      hasExtensionHandlers: () => false,
      clearQueue: () => ({ steering: [], followUp: [] }),
      abort: vi.fn(async () => {}),
      dispose: vi.fn(),
    };
    const createAgentSession = vi.fn<typeof api.createAgentSession>().mockResolvedValue({ session } as unknown as Awaited<ReturnType<typeof api.createAgentSession>>);
    vi.spyOn(piRuntimeApi, "loadPiRuntimeApi").mockResolvedValue({
      ...api, createAgentSession, getAgentDir: () => path.join(root, "agent"),
      DefaultResourceLoader: class extends api.DefaultResourceLoader {
        async reload() {}
      },
    });
    const work = runExternalAgent("test", f.member, "Inspect source", {
      modelRegistry: { find: () => ({ provider: "openai", id: "test-model" }) },
    }, { ...f.options, runNativeAgent: undefined });
    await vi.waitFor(() => expect(f.control.start).toHaveBeenCalled());
    if (configuration === "changed") {
      fs.writeFileSync(settingsPath, JSON.stringify({ favoriteModels: {
        "write-critical": { harness: "review" },
        "write-system": { model: "openai/other-model", thinking: "high" },
      } }));
    }
    f.fail(new ExternalCapacityError("overloaded"));
    await work;

    if (configuration === "changed") {
      expect(createAgentSession).not.toHaveBeenCalled();
      const [report] = await reports.listStoredTeamReportEvents("test");
      expect(report.report).toContain("direct model/thinking overrides are not allowed");
      expect(report.status).toBe("failed");
      return;
    }
    expect(createAgentSession).toHaveBeenCalledOnce();
    expect(f.member).toMatchObject({ role: "write", modelSlot: "write-system" });
    expect(f.options.notifyFallback).toHaveBeenCalledWith(expect.stringMatching(/write-critical.*write-system/));
    expect(createAgentSession.mock.calls[0][0]).toMatchObject({ model: { provider: "openai", id: "test-model" }, thinkingLevel: "high" });
    expect(session.prompt).toHaveBeenCalledWith(expect.stringContaining("Inspect source"), { source: "extension" });
    const [report] = await reports.listStoredTeamReportEvents("test");
    expect(report.report).toContain("Native fallback completed");
    expect(f.options.emitAgentReport).toHaveBeenCalledOnce();
    expect(f.options.releaseAllClaimsForAgent).toHaveBeenCalledOnce();
    expect(f.states.size).toBe(0);
  });

  it.each(["no opt-in", "ordinary failure", "cleanup failed"])("does not launch a native fallback for %s", async reason => {
    const f = await setup();
    if (reason !== "no opt-in") f.member.externalHarness!.nativeFallback = { modelSlot: "read-collect", model: "openai/test-model", thinking: "high" };
    if (reason === "cleanup failed") f.control.stop.mockRejectedValue(new Error("process exit not confirmed"));
    const work = f.launch();
    await vi.waitFor(() => expect(f.control.start).toHaveBeenCalled());
    f.fail(reason === "ordinary failure" ? new Error("rate limit in an ordinary error string") : new ExternalCapacityError("overloaded"));
    await work;
    expect(f.options.runNativeAgent).not.toHaveBeenCalled();
    expect(f.options.notifyFallback).not.toHaveBeenCalled();
    if (reason === "cleanup failed") {
      expect(f.options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
      expect(f.states.get("test:reader")?.teardownState).toBe("quarantined");
    }
  });

  it("honors Stop during external fallback cleanup without starting native work", async () => {
    const f = await setup();
    f.member.externalHarness!.nativeFallback = { modelSlot: "read-collect", model: "openai/test-model", thinking: "high" };
    let finishStop!: () => void;
    const stopped = new Promise<void>(resolve => { finishStop = resolve; });
    f.control.stop.mockImplementation(() => stopped);
    const work = f.launch();
    await vi.waitFor(() => expect(f.control.start).toHaveBeenCalled());
    f.fail(new ExternalCapacityError("rate_limit"));
    await vi.waitFor(() => expect(f.control.stop).toHaveBeenCalled());
    const cancellation = f.lifecycle.shutdownTeammate("test", f.member);
    finishStop();
    await Promise.all([work, cancellation]);

    expect(f.options.runNativeAgent).not.toHaveBeenCalled();
    expect(f.options.notifyFallback).not.toHaveBeenCalled();
    expect(f.options.emitAgentReport).not.toHaveBeenCalled();
    expect(f.control.stop).toHaveBeenCalledOnce();
    expect(f.options.releaseAllClaimsForAgent).toHaveBeenCalledOnce();
    expect(f.states.size).toBe(0);
  });

  it("persists a run-bound report before delivery and cleans up through its own control", async () => {
    const f = await setup();
    f.options.emitAgentReport.mockImplementation(() => {
      expect(fs.readFileSync(paths.reportEventsPath("test"), "utf8")).toContain("Reviewed the assigned source");
    });
    const work = f.launch();
    expect(f.states.get("test:reader")?.session).toBeUndefined();
    await vi.waitFor(() => expect(f.control.start).toHaveBeenCalled());
    await sendMessageToRunningReadAgent(f.states.get("test:reader"), "Please include evidence");
    expect(f.control.message).toHaveBeenCalledWith("Please include evidence");
    await f.states.get("test:reader")!.moveToHerdr!();
    expect(f.control.focus).toHaveBeenCalledOnce();
    const interrupt = createTeammateInterrupter({ terminal: null, runningReadAgents: f.states, readAgentKey: (team, name) => `${team}:${name}`, getTeamName: () => "test" });
    expect((await interrupt("reader")).status).toBe("interrupt_sent");
    expect(f.control.interrupt).toHaveBeenCalledOnce();
    f.complete();
    await work;
    const [report] = await reports.listStoredTeamReportEvents("test");
    expect(report.result).toMatchObject({ runId: f.member.lifecycleRunId, outcome: "succeeded", verification: { state: "not-requested" }, acceptance: { state: "pending" } });
    expect(f.options.emitAgentReport).toHaveBeenCalledOnce();
    expect(f.control.stop).toHaveBeenCalledOnce();
    expect(f.states.size).toBe(0);
  });

  it("delivers a nested report to the exact parent run", async () => {
    const f = await setup("parent-run");
    const work = f.launch();
    f.complete();
    await work;
    expect(f.options.deliverMessageToActiveAgent).toHaveBeenCalledWith("test", "writer", expect.stringContaining("Reviewed"), f.member.parentLifecycleRunId, true);
    expect((await messaging.readInbox("test", "writer", false, false)).length).toBe(1);
  });

  it("falls back to lead rather than waking a replacement parent", async () => {
    const f = await setup("parent-run");
    const work = f.launch();
    await teams.updateMember("test", "writer", { lifecycleRunId: "replacement" });
    f.complete();
    await work;
    expect(f.options.deliverMessageToActiveAgent).not.toHaveBeenCalled();
    expect(f.options.emitAgentReport).toHaveBeenCalledWith("test", "reader", expect.any(Number), 0, expect.stringContaining("Reviewed"), true);
  });

  it("persists the report location when the external result fails validation", async () => {
    const f = await setup();
    const work = f.launch();
    await vi.waitFor(() => expect(f.control.start).toHaveBeenCalled());
    f.fail(new Error("Invalid external report: invalid report artifacts"));
    await work;

    const [report] = await reports.listStoredTeamReportEvents("test");
    expect(report.result).toMatchObject({
      outcome: "failed", artifacts: [{ path: f.control.reportPath, label: "External harness report" }],
    });
    expect(report.report).toContain(f.control.reportPath);
    expect(report.report).toContain("invalid report artifacts");
    expect(f.options.emitAgentReport).toHaveBeenCalledWith("test", "reader", expect.any(Number), 0,
      expect.stringContaining(f.control.reportPath), false);
  });

  it("retains identity and artifacts when canonical persistence fails", async () => {
    const f = await setup();
    vi.spyOn(reports, "appendTeamReportEvent").mockRejectedValue(new Error("disk full"));
    const work = f.launch();
    f.complete();
    await work;
    expect(f.options.emitAgentReport).toHaveBeenCalledWith("test", "reader", expect.any(Number), 0, expect.stringContaining("disk full"), false);
    expect(f.options.emitAgentReport).toHaveBeenCalledWith("test", "reader", expect.any(Number), 0, expect.stringContaining(f.control.reportPath), false);
    expect(f.states.get("test:reader")?.teardownState).toBe("quarantined");
    expect((await teams.readConfig("test")).members.some(m => m.name === "reader")).toBe(true);
  });

  it("keeps persisted external ownership when its controller is missing", async () => {
    const f = await setup();
    f.member.role = "write";
    await teams.updateMember("test", f.member.name, { role: "write" });
    await claims.claimFiles("test", f.member.name, ["owned.ts"]);
    expect(f.states.size).toBe(0);
    expect((await readLifecycleTombstone("test", f.member.name)).status).toBe("absent");

    const result = await f.lifecycle.shutdownTeammate("test", f.member);

    expect(await claims.listClaims("test")).toEqual([
      expect.objectContaining({ agent: f.member.name, path: "owned.ts" }),
    ]);
    expect(result).toMatchObject({
      status: "cleanup_failed",
      finalized: false,
      releasedClaims: [],
    });
    expect(result.error).toContain("External harness controller unavailable");
    expect(f.options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
    expect((await teams.readConfig("test")).members).toContainEqual(
      expect.objectContaining({ name: f.member.name, lifecycleRunId: f.member.lifecycleRunId }),
    );
    expect(await readLifecycleTombstone("test", f.member.name)).toMatchObject({
      status: "occupied",
      tombstone: { runId: f.member.lifecycleRunId, phase: "cleanup_failed" },
    });
  });

  it.each(["pane identity changed", "pane split outcome is uncertain"])("retains roster, claims and fence when cleanup fails: %s", async reason => {
    const f = await setup();
    f.control.stop.mockRejectedValue(new Error(reason));
    const work = f.launch();
    f.complete();
    await work;
    expect((await readLifecycleTombstone("test", "reader")).status).toBe("occupied");
    expect(f.states.has("test:reader")).toBe(true);
    expect((await teams.readConfig("test")).members.some(member => member.name === "reader")).toBe(true);
    expect(f.options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
  });

  it.each(["stop", "watchdog"])("recovers quarantined external cleanup through %s only after stop succeeds", async retry => {
    const f = await setup();
    f.control.stop.mockRejectedValue(new Error("process ownership unavailable"));
    const work = f.launch();
    f.complete();
    await work;
    expect(f.states.get("test:reader")?.teardownState).toBe("quarantined");
    expect(f.control.stop).toHaveBeenCalledOnce();
    await f.lifecycle.runWatchdogOnce("test");
    expect(f.states.get("test:reader")?.teardownState).toBe("quarantined");
    expect(f.options.releaseAllClaimsForAgent).not.toHaveBeenCalled();
    expect((await readLifecycleTombstone("test", "reader")).status).toBe("occupied");

    f.control.stop.mockResolvedValue(undefined);
    if (retry === "watchdog") await f.lifecycle.runWatchdogOnce("test");
    else expect((await f.lifecycle.shutdownTeammate("test", f.member)).finalized).toBe(true);
    expect(f.states.size).toBe(0);
    expect((await teams.readConfig("test")).members.map(member => member.name)).toEqual(["team-lead"]);
    expect((await readLifecycleTombstone("test", "reader")).status).toBe("absent");
    expect(f.options.releaseAllClaimsForAgent).toHaveBeenCalledOnce();
  });

  it("stops a live run without calling Pi session APIs or reporting success", async () => {
    const f = await setup();
    const work = f.launch();
    await vi.waitFor(() => expect(f.control.start).toHaveBeenCalled());
    const stopped = await f.lifecycle.shutdownTeammate("test", f.member);
    await work;
    expect(stopped.finalized).toBe(true);
    expect(f.control.stop).toHaveBeenCalledOnce();
    expect(f.options.emitAgentReport).not.toHaveBeenCalled();
  });
});
