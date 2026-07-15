import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerPredefinedTools } from "./predefined-tools.js";
import * as teams from "../../src/utils/teams.js";
import * as paths from "../../src/utils/paths.js";
import * as messaging from "../../src/utils/messaging.js";
import * as runtime from "../../src/utils/runtime.js";
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
