import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPredefinedTools } from "./predefined-tools.js";
import * as teams from "../../src/utils/teams.js";
import * as paths from "../../src/utils/paths.js";
import * as messaging from "../../src/utils/messaging.js";
import * as runtime from "../../src/utils/runtime.js";
import { readLifecycleTombstone } from "../../src/utils/lifecycle-tombstone.js";
import type { Member } from "../../src/utils/models.js";

type RegisteredTool = {
  name: string;
  description?: string;
  parameters?: any;
  execute: (toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) => Promise<any>;
};

let root: string;

function writePredefinedFixture() {
  fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "teams.yaml"), "writers:\n  - writer\n");
  fs.writeFileSync(path.join(root, ".pi", "agents", "writer.md"), "---\nname: writer\ndescription: Applies a change\n---\nImplement the assigned change.\n");
  const settingsPath = path.join(root, ".pi", "agent", "pi-extended-teams", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    favoriteModels: {
      "read-review": { model: "provider/model", thinking: "xhigh" },
      "writing-hard": { model: "provider/model", thinking: "xhigh" },
      "write-critical": { model: "provider/model", thinking: "max" },
    },
  }));
}

function writeProjectSessionSetting(projectDir: string, showInResume: boolean) {
  const settingsPath = path.join(projectDir, ".pi", "pi-extended-teams.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ agentSessions: { showInResume } }));
}

function registerTools(terminal: { spawn: ReturnType<typeof vi.fn> } = { spawn: vi.fn(() => "%writer") }) {
  const tools = new Map<string, RegisteredTool>();
  registerPredefinedTools({
    registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
  }, {
    terminal,
    adoptTeamAsLead: vi.fn(),
    isTeammate: false,
    agentName: "team-lead",
    getTeamName: () => null,
  });
  return tools;
}

function makeCtx() {
  return {
    cwd: root,
    model: { provider: "provider", id: "model" },
    modelRegistry: {
      getAvailable: vi.fn(async () => [{ provider: "provider", id: "model" }]),
      find: vi.fn(() => ({ provider: "provider", id: "model" })),
    },
    isProjectTrusted: vi.fn(() => true),
  };
}

function installReplacementArtifacts(teamName: string, replacementRunId: string) {
  const configFile = paths.configPath(teamName);
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const currentMember = config.members.find((member: Member) => member.name === "writer");
  const member = { ...currentMember, lifecycleRunId: replacementRunId, tmuxPaneId: "%r2" };
  config.members = config.members.map((item: Member) => item.name === "writer" ? member : item);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  const runtimeStatus = {
    teamName,
    agentName: "writer",
    lifecycleRunId: replacementRunId,
    currentAction: "working",
  };
  fs.writeFileSync(paths.runtimeStatusPath(teamName, "writer"), JSON.stringify(runtimeStatus, null, 2));

  const inbox = [{
    from: "team-lead",
    text: "R2 prompt",
    summary: "R2 bootstrap",
    timestamp: new Date(0).toISOString(),
    read: false,
    operationId: `bootstrap:${replacementRunId}:initial-prompt`,
  }];
  fs.writeFileSync(paths.inboxPath(teamName, "writer"), JSON.stringify(inbox, null, 2));

  const sessionMarker = path.join(
    paths.teamDir(teamName),
    "agent-sessions",
    "writer",
    replacementRunId,
    "r2-session",
  );
  fs.mkdirSync(path.dirname(sessionMarker), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sessionMarker, "R2");

  const tombstone = {
    version: 1,
    team: teamName,
    agent: "writer",
    runId: replacementRunId,
    role: "write",
    reason: "replacement",
    phase: "closing",
    ownerPid: process.pid,
    extensionInstanceId: "replacement-extension",
    timestamps: { createdAt: 1, updatedAt: 1 },
  };
  const tombstoneFile = paths.lifecycleTombstonePath(teamName, "writer");
  fs.mkdirSync(path.dirname(tombstoneFile), { recursive: true });
  fs.writeFileSync(tombstoneFile, JSON.stringify(tombstone, null, 2));

  return { member, runtimeStatus, inbox, sessionMarker, tombstone };
}

describe("create_predefined_team tiers", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extended-teams-predefined-"));
    vi.spyOn(os, "homedir").mockReturnValue(root);
    vi.spyOn(paths, "teamDir").mockImplementation(teamName => path.join(root, ".pi", "teams", String(teamName)));
    vi.spyOn(paths, "configPath").mockImplementation(teamName => path.join(root, ".pi", "teams", String(teamName), "config.json"));
    vi.spyOn(paths, "inboxPath").mockImplementation((teamName, agentName) => path.join(root, ".pi", "teams", String(teamName), "inboxes", `${String(agentName)}.json`));
    vi.spyOn(paths, "runtimeStatusPath").mockImplementation((teamName, agentName) => path.join(root, ".pi", "teams", String(teamName), "runtime", `${String(agentName)}.json`));
    vi.spyOn(paths, "lifecycleTombstonePath").mockImplementation((teamName, agentName) => path.join(root, ".pi", "teams", String(teamName), "lifecycle", "quarantine", `${String(agentName)}.json`));
    writePredefinedFixture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("defaults to write-critical and canonicalizes legacy model_slot input in outward results", async () => {
    const terminal = { spawn: vi.fn(() => "%writer") };
    const tools = registerTools(terminal);
    const create = tools.get("create_predefined_team")!;
    const ctx = makeCtx();

    expect(create.description).toContain("write-critical");
    expect(create.parameters.properties.model_slot.description).toContain("write-critical");

    const defaultResult = await create.execute("default", {
      team_name: "default-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, ctx);
    const legacyResult = await create.execute("legacy", {
      team_name: "legacy-writers",
      predefined_team: "writers",
      cwd: root,
      model_slot: "writing-hard",
    }, new AbortController().signal, undefined, ctx);

    expect(defaultResult.details).toMatchObject({ modelSlot: "write-critical" });
    expect(legacyResult.details).toMatchObject({ modelSlot: "write-system" });
    const defaultWriter = (await teams.readConfig("default-writers")).members.find(member => member.name === "writer")!;
    expect(defaultWriter).toMatchObject({
      modelSlot: "write-critical",
      role: "write",
      thinking: "max",
    });
    const defaultSpawn = (terminal.spawn.mock.calls as any[][])[0][0];
    expect(defaultSpawn.command).toContain("--model 'provider/model:max'");
    expect(defaultSpawn.command).toContain(
      `--session-dir '${path.join(paths.teamDir("default-writers"), "agent-sessions", "writer", defaultWriter.lifecycleRunId!)}'`,
    );
    expect(defaultSpawn.env).toMatchObject({
      PI_TEAM_NAME: "default-writers",
      PI_AGENT_NAME: "writer",
      PI_LIFECYCLE_RUN_ID: defaultWriter.lifecycleRunId,
    });
    expect(await runtime.readRuntimeStatus("default-writers", "writer")).toMatchObject({
      lifecycleRunId: defaultWriter.lifecycleRunId,
      currentAction: "starting",
    });
    expect(await messaging.peekInbox("default-writers", "writer", false)).toEqual([
      expect.objectContaining({
        text: "Implement the assigned change.",
        operationId: `bootstrap:${defaultWriter.lifecycleRunId}:initial-prompt`,
      }),
    ]);
    expect((await teams.readConfig("legacy-writers")).members.find(member => member.name === "writer")).toMatchObject({
      modelSlot: "write-system",
      role: "write",
    });
  });

  it("refuses to recreate a team that already has members", async () => {
    const create = registerTools().get("create_predefined_team")!;
    const ctx = makeCtx();

    await create.execute("first", {
      team_name: "live-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, ctx);

    // An agent spawned separately into the same team, e.g. via spawn_agent.
    await teams.addMember("live-writers", {
      agentId: "reviewer@live-writers",
      name: "reviewer",
      agentType: "teammate",
      role: "read",
      model: "provider/model",
      thinking: "high",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
    } as Member);

    const before = (await teams.readConfig("live-writers")).members.map(member => member.name);
    expect(before).toContain("writer");
    expect(before).toContain("reviewer");

    await expect(create.execute("second", {
      team_name: "live-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, ctx)).rejects.toThrow(/already exists/);

    const after = (await teams.readConfig("live-writers")).members.map(member => member.name);
    expect(after).toEqual(before);
  });

  it("preserves a concurrently created team when exclusive creation loses", async () => {
    const terminal = { spawn: vi.fn(() => "%writer") };
    const create = registerTools(terminal).get("create_predefined_team")!;
    const configFile = paths.configPath("raced-writers");
    const winnerBytes = JSON.stringify({
      name: "raced-writers",
      description: "Concurrent winner",
      createdAt: 1,
      leadAgentId: "winner-lead",
      leadSessionId: "winner-session",
      members: [
        {
          agentId: "winner-lead",
          name: "team-lead",
          agentType: "lead",
          joinedAt: 1,
          tmuxPaneId: "",
          cwd: root,
          subscriptions: [],
        },
        {
          agentId: "winner@raced-writers",
          name: "winner",
          agentType: "teammate",
          joinedAt: 1,
          tmuxPaneId: "",
          cwd: root,
          subscriptions: [],
        },
      ],
    }, null, 2);
    const writeFileSync = fs.writeFileSync.bind(fs) as any;
    let winnerCreated = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: any, data: any, options?: any) => {
      if (!winnerCreated && String(file) === configFile) {
        winnerCreated = true;
        writeFileSync(configFile, winnerBytes);
      }
      return writeFileSync(file, data, options);
    }) as any);

    await expect(create.execute("loser", {
      team_name: "raced-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
      'Team "raced-writers" already exists. Choose a different team_name, or stop that team first.'
    );

    expect(winnerCreated).toBe(true);
    expect(fs.readFileSync(configFile, "utf-8")).toBe(winnerBytes);
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("retains createTeam's replacement semantics for existing callers", async () => {
    teams.createTeam("replaceable", "first-session", "first-lead");
    await teams.addMember("replaceable", {
      agentId: "writer@replaceable",
      name: "writer",
      agentType: "teammate",
      joinedAt: 1,
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
    } as Member);

    teams.createTeam("replaceable", "replacement-session", "replacement-lead");

    expect(await teams.readConfig("replaceable")).toMatchObject({
      leadAgentId: "replacement-lead",
      leadSessionId: "replacement-session",
      members: [{ agentId: "replacement-lead", name: "team-lead" }],
    });
  });

  it("preserves unexpected config creation failures", async () => {
    const create = registerTools().get("create_predefined_team")!;
    const configFile = paths.configPath("unwritable-writers");
    const failure = Object.assign(new Error("filesystem unavailable"), { code: "EACCES" });
    const writeFileSync = fs.writeFileSync.bind(fs) as any;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: any, data: any, options?: any) => {
      if (String(file) === configFile) throw failure;
      return writeFileSync(file, data, options);
    }) as any);

    await expect(create.execute("io-failure", {
      team_name: "unwritable-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, makeCtx())).rejects.toBe(failure);
  });

  it("uses Pi's resumable session store only after an explicit opt-in", async () => {
    const settingsPath = path.join(root, ".pi", "agent", "pi-extended-teams", "settings.json");
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    settings.agentSessions = { showInResume: true };
    fs.writeFileSync(settingsPath, JSON.stringify(settings));
    const terminal = { spawn: vi.fn(() => "%writer") };
    const create = registerTools(terminal).get("create_predefined_team")!;

    await create.execute("resumable", {
      team_name: "resumable-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, makeCtx());

    const spawn = (terminal.spawn.mock.calls as any[][])[0]?.[0];
    expect(spawn.command).not.toContain("--session-dir");
  });

  it("resolves session visibility from the spawned target project, not the lead project", async () => {
    const privateTarget = path.join(root, "private-target");
    const resumableTarget = path.join(root, "resumable-target");
    fs.mkdirSync(privateTarget, { recursive: true });
    fs.mkdirSync(resumableTarget, { recursive: true });
    writeProjectSessionSetting(root, true);
    writeProjectSessionSetting(privateTarget, false);
    writeProjectSessionSetting(resumableTarget, true);

    const terminal = { spawn: vi.fn(() => "%writer") };
    const create = registerTools(terminal).get("create_predefined_team")!;
    const leadCtx = makeCtx();

    await create.execute("private-target", {
      team_name: "private-target-writers",
      predefined_team: "writers",
      cwd: privateTarget,
    }, new AbortController().signal, undefined, leadCtx);
    const privateWriter = (await teams.readConfig("private-target-writers")).members.find(member => member.name === "writer")!;
    const privateSpawn = (terminal.spawn.mock.calls as any[][])[0][0];
    expect(privateSpawn.command).toContain(
      `--session-dir '${path.join(paths.teamDir("private-target-writers"), "agent-sessions", "writer", privateWriter.lifecycleRunId!)}'`,
    );

    writeProjectSessionSetting(root, false);
    await create.execute("resumable-target", {
      team_name: "resumable-target-writers",
      predefined_team: "writers",
      cwd: resumableTarget,
    }, new AbortController().signal, undefined, leadCtx);
    const resumableSpawn = (terminal.spawn.mock.calls as any[][])[1][0];
    expect(resumableSpawn.command).not.toContain("--session-dir");
  });

  it("rejects direct thinking from a predefined agent definition", async () => {
    fs.writeFileSync(
      path.join(root, ".pi", "agents", "writer.md"),
      "---\nname: writer\ndescription: Applies a change\nthinking: high\n---\nImplement the assigned change.\n",
    );
    const terminal = { spawn: vi.fn(() => "%writer") };
    const create = registerTools(terminal).get("create_predefined_team")!;

    const result = await create.execute("direct-thinking", {
      team_name: "direct-thinking-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, makeCtx());

    expect(result.details.results).toEqual([
      expect.objectContaining({ status: "error", error: expect.stringContaining("must not declare direct model or thinking") }),
    ]);
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")("rolls back admission when private session storage is untrusted", async () => {
    const teamDirectory = paths.teamDir("unsafe-session-writers");
    const external = path.join(root, "external-sessions");
    fs.mkdirSync(teamDirectory, { recursive: true });
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(teamDirectory, "agent-sessions"), "dir");
    const terminal = { spawn: vi.fn(() => "%writer") };
    const create = registerTools(terminal).get("create_predefined_team")!;

    const result = await create.execute("unsafe-session", {
      team_name: "unsafe-session-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, makeCtx());

    expect(result.details.results).toEqual([
      expect.objectContaining({ status: "error", error: expect.stringMatching(/private agent session directory/i) }),
    ]);
    expect((await teams.readConfig("unsafe-session-writers")).members.find(member => member.name === "writer")).toBeUndefined();
    expect(await runtime.readRuntimeStatus("unsafe-session-writers", "writer")).toBeNull();
    expect(terminal.spawn).not.toHaveBeenCalled();
  });

  it("stops and verifies the exact spawned pane before rolling back an updateMember failure", async () => {
    vi.spyOn(teams, "updateMember").mockRejectedValueOnce(new Error("update failed"));
    const deleteRuntimeStatus = vi.spyOn(runtime, "deleteRuntimeStatusUnderLifecycleLock");
    const terminal = {
      spawn: vi.fn(() => "%writer"),
      kill: vi.fn(),
      isAlive: vi.fn(() => false),
    };
    const create = registerTools(terminal).get("create_predefined_team")!;

    const result = await create.execute("update-failure", {
      team_name: "update-failed-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, makeCtx());

    const runId = (terminal.spawn.mock.calls as any[][])[0][0].env.PI_LIFECYCLE_RUN_ID;
    expect(result.details.results).toEqual([
      expect.objectContaining({ status: "error", error: expect.stringContaining("Failed to spawn: Error: update failed") }),
    ]);
    expect(terminal.kill).toHaveBeenCalledWith("%writer");
    expect(terminal.isAlive).toHaveBeenCalledWith("%writer");
    expect((await teams.readConfig("update-failed-writers")).members.find(member => member.name === "writer")).toBeUndefined();
    expect(await runtime.readRuntimeStatus("update-failed-writers", "writer")).toBeNull();
    expect(deleteRuntimeStatus).toHaveBeenCalledWith("update-failed-writers", "writer", runId);
    expect(terminal.isAlive.mock.invocationCallOrder[0]).toBeLessThan(deleteRuntimeStatus.mock.invocationCallOrder[0]!);
    expect(await messaging.readInbox("update-failed-writers", "writer", false, false)).toEqual([]);
    expect(fs.existsSync(path.join(paths.teamDir("update-failed-writers"), "agent-sessions", "writer", runId))).toBe(false);
    expect(await readLifecycleTombstone("update-failed-writers", "writer")).toEqual({ status: "absent" });
  });

  it("stops and verifies a returned R1 pane before rollback reads and leaves all R2 artifacts untouched", async () => {
    const configReads = vi.spyOn(teams, "readConfig");
    vi.spyOn(teams, "updateMember").mockRejectedValueOnce(new Error("update failed"));
    const replacementRunId = "replacement-run";
    let artifacts!: ReturnType<typeof installReplacementArtifacts>;
    const terminal = {
      spawn: vi.fn(() => "%r1"),
      kill: vi.fn(() => {
        artifacts = installReplacementArtifacts("replacement-writers", replacementRunId);
      }),
      isAlive: vi.fn(() => false),
    };
    const create = registerTools(terminal).get("create_predefined_team")!;

    const result = await create.execute("replacement-race", {
      team_name: "replacement-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, makeCtx());

    expect(result.details.results).toEqual([
      expect.objectContaining({ status: "error", error: expect.stringContaining("Failed to spawn: Error: update failed") }),
    ]);
    expect(terminal.kill).toHaveBeenCalledWith("%r1");
    expect(terminal.isAlive).toHaveBeenCalledWith("%r1");
    expect(configReads).toHaveBeenCalledTimes(1);
    expect((await teams.readConfig("replacement-writers")).members.find(member => member.name === "writer")).toEqual(artifacts.member);
    expect(await runtime.readRuntimeStatus("replacement-writers", "writer")).toEqual(artifacts.runtimeStatus);
    expect(await messaging.peekInbox("replacement-writers", "writer", false)).toEqual(artifacts.inbox);
    expect(fs.readFileSync(artifacts.sessionMarker, "utf8")).toBe("R2");
    expect(await readLifecycleTombstone("replacement-writers", "writer")).toEqual({
      status: "occupied",
      tombstone: artifacts.tombstone,
    });
  });

  it("does not fence or delete R2 artifacts when R1 pane termination cannot be proven", async () => {
    const configReads = vi.spyOn(teams, "readConfig");
    vi.spyOn(teams, "updateMember").mockRejectedValueOnce(new Error("update failed"));
    const replacementRunId = "replacement-run";
    let artifacts!: ReturnType<typeof installReplacementArtifacts>;
    const terminal = {
      spawn: vi.fn(() => "%r1"),
      kill: vi.fn(() => {
        artifacts = installReplacementArtifacts("unproven-replacement-writers", replacementRunId);
      }),
      isAlive: vi.fn(() => true),
    };
    const create = registerTools(terminal).get("create_predefined_team")!;

    const result = await create.execute("unproven-replacement-race", {
      team_name: "unproven-replacement-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, makeCtx());

    expect(result.details.results).toEqual([
      expect.objectContaining({ status: "error", error: expect.stringContaining("Failed to spawn: Error: update failed") }),
    ]);
    expect(terminal.kill).toHaveBeenCalledWith("%r1");
    expect(terminal.isAlive).toHaveBeenCalledWith("%r1");
    expect(configReads).toHaveBeenCalledTimes(1);
    expect((await teams.readConfig("unproven-replacement-writers")).members.find(member => member.name === "writer")).toEqual(artifacts.member);
    expect(await runtime.readRuntimeStatus("unproven-replacement-writers", "writer")).toEqual(artifacts.runtimeStatus);
    expect(await messaging.peekInbox("unproven-replacement-writers", "writer", false)).toEqual(artifacts.inbox);
    expect(fs.readFileSync(artifacts.sessionMarker, "utf8")).toBe("R2");
    expect(await readLifecycleTombstone("unproven-replacement-writers", "writer")).toEqual({
      status: "occupied",
      tombstone: artifacts.tombstone,
    });
  });

  it("fences the exact spawned pane and retains recovery artifacts when termination cannot be proven", async () => {
    vi.spyOn(teams, "updateMember").mockRejectedValueOnce(new Error("update failed"));
    const terminal = {
      spawn: vi.fn(() => "%writer"),
      kill: vi.fn(),
      isAlive: vi.fn(() => true),
    };
    const create = registerTools(terminal).get("create_predefined_team")!;

    const result = await create.execute("termination-failure", {
      team_name: "retained-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, makeCtx());

    const runId = (terminal.spawn.mock.calls as any[][])[0][0].env.PI_LIFECYCLE_RUN_ID;
    expect(result.details.results).toEqual([
      expect.objectContaining({ status: "error", error: expect.stringContaining("Failed to spawn: Error: update failed") }),
    ]);
    expect(terminal.kill).toHaveBeenCalledWith("%writer");
    expect(terminal.isAlive).toHaveBeenCalledWith("%writer");
    expect((await teams.readConfig("retained-writers")).members.find(member => member.name === "writer")).toMatchObject({
      lifecycleRunId: runId,
    });
    expect(await runtime.readRuntimeStatus("retained-writers", "writer")).toMatchObject({ lifecycleRunId: runId });
    expect(await messaging.peekInbox("retained-writers", "writer", false)).toEqual([
      expect.objectContaining({ operationId: `bootstrap:${runId}:initial-prompt` }),
    ]);
    expect(fs.existsSync(path.join(paths.teamDir("retained-writers"), "agent-sessions", "writer", runId))).toBe(true);
    expect(await readLifecycleTombstone("retained-writers", "writer")).toMatchObject({
      status: "occupied",
      tombstone: {
        runId,
        phase: "cleanup_failed",
        error: expect.stringContaining("%writer"),
      },
    });
  });

  it("rolls back only the admitted run when terminal spawn fails and permits same-name readmission", async () => {
    const terminal = { spawn: vi.fn(() => { throw new Error("spawn failed"); }) };
    const create = registerTools(terminal).get("create_predefined_team")!;

    const result = await create.execute("spawn-failure", {
      team_name: "failed-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, makeCtx());

    const failedRunId = (terminal.spawn.mock.calls as any[][])[0][0].env.PI_LIFECYCLE_RUN_ID;
    expect(result.details.results).toEqual([
      expect.objectContaining({ status: "error", error: expect.stringContaining("Failed to spawn: Error: spawn failed") }),
    ]);
    expect((await teams.readConfig("failed-writers")).members.find(member => member.name === "writer")).toBeUndefined();
    expect(await runtime.readRuntimeStatus("failed-writers", "writer")).toBeNull();
    expect(await messaging.readInbox("failed-writers", "writer", false, false)).toEqual([]);

    const replacement: Member = {
      agentId: "writer@failed-writers",
      name: "writer",
      agentType: "teammate",
      role: "write" as const,
      model: "provider/model",
      joinedAt: Date.now(),
      tmuxPaneId: "",
      cwd: root,
      subscriptions: [],
      thinking: "max" as const,
      modelSlot: "write-critical",
    };
    await expect(teams.addMember("failed-writers", replacement)).resolves.toBeUndefined();
    expect(replacement.lifecycleRunId).toBeTruthy();
    expect(replacement.lifecycleRunId).not.toBe(failedRunId);
  });

  it("preserves a replacement run admitted before spawn-failure rollback acquires the lifecycle lock", async () => {
    const replacementRunId = "replacement-run";
    const terminal = { spawn: vi.fn(() => {
      const configPath = paths.configPath("raced-writers");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const writer = config.members.find((member: any) => member.name === "writer");
      writer.lifecycleRunId = replacementRunId;
      writer.tmuxPaneId = "%replacement";
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      fs.writeFileSync(paths.runtimeStatusPath("raced-writers", "writer"), JSON.stringify({
        teamName: "raced-writers",
        agentName: "writer",
        lifecycleRunId: replacementRunId,
        currentAction: "working",
      }, null, 2));
      throw new Error("spawn failed after replacement");
    }) };
    const create = registerTools(terminal).get("create_predefined_team")!;

    const result = await create.execute("raced-failure", {
      team_name: "raced-writers",
      predefined_team: "writers",
      cwd: root,
    }, new AbortController().signal, undefined, makeCtx());

    expect(result.details.results[0]).toMatchObject({ status: "error" });
    expect((await teams.readConfig("raced-writers")).members.find(member => member.name === "writer")).toMatchObject({
      lifecycleRunId: replacementRunId,
      tmuxPaneId: "%replacement",
    });
    expect(await runtime.readRuntimeStatus("raced-writers", "writer")).toMatchObject({
      lifecycleRunId: replacementRunId,
      currentAction: "working",
    });
  });

  it("uses canonical write-* intent-tier wording for read-tier validation failures", async () => {
    const create = registerTools().get("create_predefined_team")!;

    await expect(create.execute("wrong-tier", {
      team_name: "readers",
      predefined_team: "writers",
      cwd: root,
      model_slot: "read-review",
    }, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
      "create_predefined_team requires a write-* intent tier configured via /agents-favorite-models, got read-review."
    );
  });
});
