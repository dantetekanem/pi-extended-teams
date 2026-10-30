import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as paths from "../../src/utils/paths";
import type { Member } from "../../src/utils/models";
import { registerNativeChildPolicy, type NativeChildPolicy, type NativeChildPreparation } from "../../src/native-child-policy";
import { runReadAgentInProcess } from "./read-agent";

const sdk = vi.hoisted(() => ({ create: vi.fn(), settings: vi.fn(), loaders: vi.fn(), order: [] as string[] }));
vi.mock("../internal/pi-runtime-api", () => ({ loadPiRuntimeApi: async () => ({
  createAgentSession: sdk.create, getAgentDir: () => "/unused-agent-dir",
  createEventBus: () => ({ on: () => () => {}, emit: () => {} }),
  SettingsManager: { create: sdk.settings },
  SessionManager: { create: () => ({ getSessionId: () => "child", getEntries: () => [] }) },
  DefaultResourceLoader: class {
    constructor(options: unknown) { sdk.loaders(options); }
    async reload() {}
    getExtensions() { return { extensions: [], errors: [], runtime: {} }; }
  },
}) }));

let root: string;
let session: any;
let parent: { getSessionId(): string };
let prepareInput: NativeChildPreparation;
let ctx: any;
let options: any;
let member: Member;
let policy: NativeChildPolicy;

beforeEach(() => {
  vi.clearAllMocks();
  sdk.order.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "native-child-policy-"));
  vi.spyOn(os, "homedir").mockReturnValue(root);
  vi.spyOn(paths, "teamDir").mockReturnValue(path.join(root, "team"));
  vi.spyOn(paths, "configPath").mockReturnValue(path.join(root, "team/config.json"));
  vi.spyOn(paths, "runtimeStatusPath").mockReturnValue(path.join(root, "team/runtime/reader.json"));
  vi.spyOn(paths, "inboxPath").mockImplementation((_team, name) => path.join(root, `team/inboxes/${name}.json`));
  vi.spyOn(paths, "claimsPath").mockReturnValue(path.join(root, "team/claims.json"));
  vi.spyOn(paths, "reportFilesDir").mockReturnValue(path.join(root, "reports"));
  vi.spyOn(paths, "lifecycleTombstonePath").mockReturnValue(path.join(root, "team/lifecycle/reader.json"));
  const settingsPath = path.join(root, ".pi/agent/pi-extended-teams/settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ favoriteModels: { "read-review": { model: "provider/model", thinking: "high" } } }));
  member = { name: "reader", agentId: "reader@team", agentType: "teammate", role: "read", modelSlot: "read-review",
    model: "provider/model", thinking: "high", cwd: root, joinedAt: Date.now(), tmuxPaneId: "", subscriptions: [] };
  fs.mkdirSync(path.join(root, "team"));
  fs.writeFileSync(paths.configPath("team"), JSON.stringify({ name: "team", leadSessionId: "parent", members: [member] }));
  parent = { getSessionId: () => "parent" };
  ctx = { sessionManager: parent, modelRegistry: { runtime: { parent: true }, find: () => ({ provider: "provider", id: "model" }) } };
  const runningReadAgents = new Map();
  options = {
    isTeammate: false, getTeamName: () => "team", runningReadAgents,
    readAgentKey: () => "reader", isCurrentReadAgentRun: (_key: string, state: unknown) => runningReadAgents.get("reader") === state,
    ensureReadAgentStatusTicker: vi.fn(), renderReadAgentStatus: vi.fn(), rememberCompletedAgentReport: vi.fn(),
    emitAgentReport: vi.fn(), releaseAllClaimsForAgent: vi.fn(async () => []),
    createResourcePlan: vi.fn(async () => ({ extensionPaths: [], trust: { projectTrusted: false } })),
  };
  session = {
    messages: [{ role: "assistant", content: "Final report" }],
    getSessionStats: () => ({ tokens: { total: 0 } }), getActiveToolNames: () => sdk.create.mock.calls.at(-1)?.[0].tools ?? [],
    setActiveToolsByName: vi.fn(), subscribe: vi.fn(), isStreaming: false,
    bindExtensions: vi.fn(async () => { sdk.order.push("bind"); }),
    prompt: vi.fn(async () => { sdk.order.push("prompt"); }), clearQueue: vi.fn(),
    hasExtensionHandlers: () => false, abort: vi.fn(async () => {}), dispose: vi.fn(),
  };
  sdk.create.mockImplementation(async () => { sdk.order.push("create"); return { session }; });
  sdk.settings.mockReturnValue({});
  policy = {
    prepare: vi.fn(async input => {
      sdk.order.push("prepare");
      prepareInput = input;
      for (const factory of input.mandatoryFactories) await factory({ on: vi.fn() } as any);
      return {
        resourceLoader: { getExtensions: () => ({ extensions: [], errors: [], runtime: {} }),
          getAppendSystemPrompt: () => input.rolePrompt } as any,
        settingsManager: {} as any, tools: ["read"], excludeTools: ["mcp__*"],
      };
    }),
    enroll: vi.fn(async actual => {
      expect(actual).toBe(session);
      expect(options.runningReadAgents.get("reader").session).toBe(session);
      sdk.order.push("enroll");
    }),
    assertReady: vi.fn(async actual => {
      expect(actual).toBe(session);
      sdk.order.push("ready");
    }),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
const run = () => runReadAgentInProcess("team", member, "Review only", ctx, options);
const failure = () => options.rememberCompletedAgentReport.mock.calls.at(-1)?.[1];

describe("host-only native child policy", () => {
  it("prepares before ambient construction, enrolls before bind, and asserts before prompt", async () => {
    vi.stubEnv("HERDR_ENV", "1");
    session.prompt.mockImplementation(async () => {
      sdk.order.push("prompt");
      expect(options.runningReadAgents.get("reader").moveToHerdr).toBeUndefined();
    });
    const prepare = policy.prepare;
    policy.prepare = async input => {
      const services = await prepare(input);
      services.resourceLoader.getExtensions = () => ({ extensions: [{ path: "builtin:codemode", tools: new Map([["codemode", {}]]) }], errors: [], runtime: {} }) as any;
      return services;
    };
    registerNativeChildPolicy(parent, policy);
    await run();
    expect(sdk.order).toEqual(["prepare", "create", "enroll", "bind", "ready", "prompt"]);
    expect(failure()?.status).toBe("completed");
    expect(options.createResourcePlan).not.toHaveBeenCalled();
    expect(sdk.settings).not.toHaveBeenCalled();
    expect(sdk.loaders).not.toHaveBeenCalled();
    expect(prepareInput).toMatchObject({ parentSessionId: "parent", teamName: "team", agentName: "reader", cwd: root, role: "read" });
    expect(prepareInput.rolePrompt.join("\n")).toContain("read-only agent");
    expect(prepareInput.rolePrompt.join("\n")).toContain("Communicate only with team-lead");
    const created = sdk.create.mock.calls[0][0];
    expect(created.modelRuntime).toBe(ctx.modelRegistry.runtime);
    expect(created.modelRegistry).toBe(ctx.modelRegistry);
    expect(created.thinkingLevel).toBe("high");
    expect(created.tools).toEqual(["read", ...created.customTools.map((tool: any) => tool.name)]);
    expect(created.tools).toEqual(expect.arrayContaining(["send_message", "report_progress", "report_and_exit"]));
    expect(created.excludeTools).toEqual(expect.arrayContaining(["mcp__*", "ask_user"]));
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("keeps ordinary construction unchanged for another manager with the same ID", async () => {
    registerNativeChildPolicy({ getSessionId: () => "parent" }, policy);
    await run();
    expect(policy.prepare).not.toHaveBeenCalled();
    expect(options.createResourcePlan).toHaveBeenCalledOnce();
    expect(sdk.settings).toHaveBeenCalledOnce();
    expect(sdk.loaders).toHaveBeenCalledOnce();
    expect(sdk.create.mock.calls[0][0].tools).toContain("bash");
    expect(session.prompt).toHaveBeenCalledOnce();
    expect(failure()?.status).toBe("completed");
  });

  it("shares registrations across module copies", async () => {
    vi.resetModules();
    const copy = await import("../../src/native-child-policy.js");
    copy.registerNativeChildPolicy(parent, policy);
    await run();
    expect(policy.prepare).toHaveBeenCalledOnce();
    expect(session.prompt).toHaveBeenCalledOnce();
    expect(failure()?.status).toBe("completed");
  });

  it.each(["prepare", "enroll", "assertReady"] as const)("requires the %s hook at registration", phase => {
    const invalid = { ...policy, [phase]: undefined } as unknown as NativeChildPolicy;
    expect(() => registerNativeChildPolicy(parent, invalid)).toThrow(/all startup hooks/);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("retains a denial tombstone for queued launches after retirement", async () => {
    const retire = registerNativeChildPolicy(parent, policy);
    retire();
    retire();
    expect(() => registerNativeChildPolicy(parent, policy)).toThrow(/registered/);
    await run();
    expect(failure()).toMatchObject({ status: "failed", report: expect.stringMatching(/retired/) });
    expect(options.createResourcePlan).not.toHaveBeenCalled();
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it.each(["prepare", "enroll", "assertReady"] as const)("denies a rejected %s without prompting", async phase => {
    vi.mocked(policy[phase]).mockRejectedValueOnce(new Error(`${phase} denied`));
    registerNativeChildPolicy(parent, policy); await run();
    expect(failure()).toMatchObject({ status: "failed", report: expect.stringContaining(`${phase} denied`) });
    expect(session.prompt).not.toHaveBeenCalled();
    if (phase === "prepare") expect(sdk.create).not.toHaveBeenCalled();
    else expect(session.dispose).toHaveBeenCalledOnce();
    if (phase === "enroll") expect(session.bindExtensions).not.toHaveBeenCalled();
  });

  it.each(["missing services", "missing guard", "missing role prompt"])("rejects %s instead of falling back", async omission => {
    const prepare = policy.prepare;
    policy.prepare = async input => {
      if (omission === "missing services") return undefined as any;
      const clean = await prepare({ ...input, mandatoryFactories: omission === "missing guard" ? [] : input.mandatoryFactories });
      if (omission === "missing role prompt") clean.resourceLoader.getAppendSystemPrompt = () => [];
      return clean;
    };
    registerNativeChildPolicy(parent, policy); await run();
    expect(failure()?.status).toBe("failed"); expect(sdk.create).not.toHaveBeenCalled();
    expect(options.createResourcePlan).not.toHaveBeenCalled();
  });

  it("checks retirement after an asynchronous preparation finishes", async () => {
    const retire = registerNativeChildPolicy(parent, policy);
    const prepare = policy.prepare;
    policy.prepare = async input => {
      const result = await prepare(input);
      retire();
      return result;
    };
    await run();
    expect(failure()?.report).toMatch(/retired/);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("denies a parent identity change while preparing", async () => {
    const prepare = policy.prepare;
    policy.prepare = async input => {
      const result = await prepare(input);
      parent.getSessionId = () => "replacement";
      return result;
    };
    registerNativeChildPolicy(parent, policy);
    await run();
    expect(failure()?.report).toMatch(/parent session changed/);
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("requires extension binding for an opted-in child", async () => {
    session.bindExtensions = undefined;
    registerNativeChildPolicy(parent, policy); await run();
    expect(failure()?.status).toBe("failed"); expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it.each(["extra tool", "missing communication"])("rejects final %s after binding", async change => {
    session.bindExtensions.mockImplementation(async () => {
      const allowed = sdk.create.mock.calls[0][0].tools;
      session.getActiveToolNames = () => change === "extra tool" ? [...allowed, "codemode"] : ["read"];
    });
    registerNativeChildPolicy(parent, policy); await run();
    expect(failure()?.status).toBe("failed"); expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});
