import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";

const runtime = vi.hoisted(() => ({ api: undefined as any }));
vi.mock("../internal/pi-runtime-api", () => ({ loadPiRuntimeApi: async () => runtime.api }));

// An installed native SDK is optional: the package still supports legacy peers.
const nativeModule = process.env.PI_NATIVE_SDK_CONTRACT_MODULE;
describe.skipIf(!nativeModule)("native SDK child tools", () => {
  let root: string;
  let sdk: any;
  let ai: any;
  let mcpTesting: any;
  let runReadAgentInProcess: typeof import("./read-agent").runReadAgentInProcess;
  let snapshotLeadExtensions: typeof import("../resources/spawn-resource-plan").snapshotLeadExtensions;
  let observableBuiltins: string[];
  let modelRuntime: any;
  let model: any;
  let session: any;
  let pair: any;
  let transportClosed: boolean;
  let responses: number;
  let calls: any[];
  let connections: any[];
  let projectTrusted: boolean;
  let hooks: Array<{ type: string; event: any }>;
  let executionEvents: any[];
  let called: ReturnType<typeof Promise.withResolvers<any>>;
  let cancelled: ReturnType<typeof Promise.withResolvers<any>>;
  let forbiddenExecute: ReturnType<typeof vi.fn>;
  let member: any;
  let options: any;

  async function importPeer(name: string, subpath = ".") {
    const manifestPath = findPackageJSON(name, pathToFileURL(nativeModule!).href)!;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const exported = manifest.exports?.[subpath] ?? manifest.main;
    const entry = typeof exported === "string" ? exported : exported.import ?? exported.default;
    return import(pathToFileURL(path.resolve(path.dirname(manifestPath), entry)).href);
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-native-sdk-"));
    vi.spyOn(os, "homedir").mockReturnValue(root);
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
    vi.stubEnv("PI_OFFLINE", "1");
    vi.stubEnv("HERDR_ENV", "0");
    sdk = await import(pathToFileURL(nativeModule!).href);
    expect(sdk.createMcpExtension).toBeTypeOf("function");
    ai = await importPeer("@earendil-works/pi-ai");
    mcpTesting = await importPeer("@earendil-works/pi-mcp", "./testing");
    ({ runReadAgentInProcess } = await import("./read-agent.js"));
    ({ snapshotLeadExtensions } = await import("../resources/spawn-resource-plan.js"));
    modelRuntime = await sdk.ModelRuntime.create({
      authPath: path.join(root, "agent", "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey("anthropic", "offline-unused");
    model = modelRuntime.getModel("anthropic", "claude-sonnet-4-6");
    expect(model).toBeDefined();
  });

  beforeEach(async () => {
    fs.rmSync(path.join(root, ".pi"), { recursive: true, force: true });
    fs.rmSync(path.join(root, "cwd"), { recursive: true, force: true });
    for (const directory of ["agent", "cwd", ".pi/teams/fixture", ".pi/agent/pi-extended-teams"]) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    fs.writeFileSync(path.join(root, "agent", "settings.json"), JSON.stringify({
      cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false },
    }));
    const modelName = `${model.provider}/${model.id}`;
    fs.writeFileSync(path.join(root, ".pi/agent/pi-extended-teams/settings.json"), JSON.stringify({
      favoriteModels: {
        "read-review": { model: modelName, thinking: "off" },
        "write-feature": { model: modelName, thinking: "off" },
      },
    }));
    member = {
      name: "reader",
      agentId: "reader@fixture",
      agentType: "teammate",
      role: "read",
      model: modelName,
      modelSlot: "read-review",
      thinking: "off",
      joinedAt: Date.now(),
      cwd: path.join(root, "cwd"),
      tmuxPaneId: "",
      subscriptions: [],
    };
    fs.writeFileSync(path.join(root, ".pi/teams/fixture/config.json"), JSON.stringify({
      name: "fixture",
      description: "",
      createdAt: Date.now(),
      leadAgentId: "lead",
      leadSessionId: "lead-session",
      members: [{ ...member, name: "team-lead", agentId: "team-lead@fixture", agentType: "lead" }, member],
    }));
    const runningReadAgents = new Map();
    options = {
      isTeammate: false,
      getTeamName: () => "fixture",
      runningReadAgents,
      readAgentKey: (team: string, name: string) => `${team}:${name}`,
      isCurrentReadAgentRun: (key: string, state: unknown) => runningReadAgents.get(key) === state,
      ensureReadAgentStatusTicker: vi.fn(),
      renderReadAgentStatus: vi.fn(),
      rememberCompletedAgentReport: vi.fn(),
      emitAgentReport: vi.fn(),
      releaseAllClaimsForAgent: vi.fn(async () => []),
      createResourcePlan: async (input: { projectTrusted: boolean }) => ({
        selectionMode: "default",
        extensionPaths: ["builtin:mcp", "builtin:codemode", "builtin:tool-search"],
        extensions: [],
        diagnostics: [],
        skills: "all",
        trust: { cwd: member.cwd, projectTrusted: input.projectTrusted },
      }),
    };
    calls = [];
    connections = [];
    hooks = [];
    executionEvents = [];
    observableBuiltins = [];
    responses = 0;
    transportClosed = false;
    projectTrusted = false;
    called = Promise.withResolvers();
    cancelled = Promise.withResolvers();
    forbiddenExecute = vi.fn(async () => ({ content: [{ type: "text", text: "forbidden effect" }], details: {} }));
    pair = mcpTesting.createInMemoryTransportPair();
    pair.server.onClose(() => { transportClosed = true; });
    await pair.server.start();
  });

  afterEach(async () => {
    await session?.abort();
    await pair?.server.close();
    session?.dispose();
    session = undefined;
  });

  afterAll(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function configure(exposure: "codemode" | "direct" | "deferred", turns: any[][], holdCall = false) {
    fs.writeFileSync(path.join(root, "agent", "mcp.json"), JSON.stringify({
      mcpServers: { fixture: { command: "never-executed", exposure } },
    }));
    pair.server.onMessage(async (request: any) => {
      if (!("id" in request)) {
        if (request.method === "notifications/cancelled") cancelled.resolve(request.params.requestId);
        return;
      }
      let result: unknown;
      if (request.method === "initialize") {
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
      } else if (request.method === "tools/list") {
        result = {
          tools: [{
            name: "echo",
            description: "fixture echo",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          }],
        };
      } else if (request.method === "tools/call") {
        calls.push(request);
        called.resolve(request);
        if (holdCall) return;
        result = { content: [{ type: "text", text: `ok:${request.params.arguments.value}` }] };
      } else {
        throw new Error(`Unexpected fixture request: ${request.method}`);
      }
      await pair.server.send({ jsonrpc: "2.0", id: request.id, result });
    });
    runtime.api = {
      ...sdk,
      createMcpExtension: () => sdk.createMcpExtension({
        createTransport: (entry: any) => {
          connections.push(entry);
          return pair.client;
        },
        logPath: path.join(root, "agent", "mcp.log"),
        startupWaitMs: 1000,
      }),
      DefaultResourceLoader: class extends sdk.DefaultResourceLoader {
        constructor(configuration: any) {
          super({
            ...configuration,
            noSkills: true,
            noThemes: true,
            noPromptTemplates: true,
            noContextFiles: true,
            agentsFilesOverride: () => ({ agentsFiles: [] }),
            extensionFactories: [...configuration.extensionFactories, (pi: any) => {
              for (const name of ["ask_user", "spawn_agent", "hidden_tool"]) {
                pi.registerTool({
                  name,
                  label: name,
                  description: name,
                  parameters: { type: "object", properties: {} },
                  exposure: name === "hidden_tool" ? "hidden" : "codemode",
                  execute: forbiddenExecute,
                });
              }
              for (const type of ["tool_call", "tool_result"]) {
                pi.on(type, (event: any) => { hooks.push({ type, event }); });
              }
              pi.on("session_start", () => {
                observableBuiltins = snapshotLeadExtensions(pi).map(extension => extension.identity);
              });
            }],
          });
        }
      },
      createAgentSession: async (configuration: any) => {
        const created = await sdk.createAgentSession({ ...configuration, agentDir: path.join(root, "agent") });
        session = created.session;
        session.subscribe((event: any) => executionEvents.push(event));
        session.agent.streamFunction = () => {
          const stream = ai.createAssistantMessageEventStream();
          const tools = turns[responses++];
          const message = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            content: tools ?? [{ type: "text", text: "fixture done" }],
            stopReason: tools ? "toolUse" : "stop",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
          stream.end();
          return stream;
        };
        return created;
      },
    };
  }

  const toolCall = (name: string, args: unknown, id = name) => ({ type: "toolCall", id, name, arguments: args });
  const reportCall = () => toolCall("report_and_exit", { content: "native fixture report" });
  const run = () => runReadAgentInProcess("fixture", member, "Exercise the offline fixture", {
    cwd: member.cwd,
    isProjectTrusted: () => projectTrusted,
    modelRegistry: { runtime: modelRuntime, find: () => model },
  }, options);

  it("discovers codemode MCP tools and fences forbidden and post-report nested calls", async () => {
    configure("codemode", [[toolCall("codemode", { code: `
      if (!JSON.stringify(await searchTools("echo")).includes("mcp__fixture__echo")) throw new Error("Discovery failed");
      await tools.mcp__fixture__echo({ value: "hello" });
      for (const name of ["ask_user", "spawn_agent", "hidden_tool"]) {
        try { await tools[name]({}); } catch {}
      }
      await tools.report_and_exit({ content: "native fixture report" });
      await tools.mcp__fixture__echo({ value: "too-late" });
    ` }, "outer")]]);
    await run();
    expect(session, JSON.stringify(options.rememberCompletedAgentReport.mock.calls)).toBeDefined();
    expect(calls.map(call => call.params.arguments.value)).toEqual(["hello"]);
    expect(observableBuiltins).toEqual(expect.arrayContaining(["builtin:mcp", "builtin:codemode", "builtin:tool-search"]));
    expect(forbiddenExecute).not.toHaveBeenCalled();
    const nestedEcho = expect.objectContaining({ toolName: "mcp__fixture__echo", parentToolCallId: "outer" });
    expect(hooks).toEqual(expect.arrayContaining([
      { type: "tool_call", event: nestedEcho },
      { type: "tool_result", event: nestedEcho },
    ]));
    expect(executionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_execution_start", toolCallId: "outer/1" }),
    ]));
    expect(options.rememberCompletedAgentReport.mock.calls[0][1]).toMatchObject({ report: "native fixture report", status: "completed" });
    expect(responses).toBe(1);
    expect(transportClosed).toBe(true);
  }, 10000);

  it.each(["direct", "deferred"] as const)("reaches later MCP registrations with %s exposure", async exposure => {
    const turns = [
      ...(exposure === "deferred" ? [[toolCall("tool_search", { query: "fixture echo" })]] : []),
      [toolCall("mcp__fixture__echo", { value: exposure })],
      [reportCall()],
    ];
    configure(exposure, turns);
    await run();
    expect(session, JSON.stringify(options.rememberCompletedAgentReport.mock.calls)).toBeDefined();
    expect(calls.map(call => call.params.arguments.value)).toEqual([exposure]);
    expect(responses).toBe(turns.length);
    expect(transportClosed).toBe(true);
  }, 10000);

  it("keeps opted-in codemode delegation bound to the restricted SDK tool and its schema", async () => {
    Object.assign(member, { role: "write", modelSlot: "write-feature", allowNestedReadAgents: true, delegationDepth: 0 });
    const { createPendingChildController } = await import("../runtime/pending-child-controller.js");
    options.pendingChildController = createPendingChildController();
    const configPath = path.join(root, ".pi/teams/fixture/config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.members[1] = member;
    fs.writeFileSync(configPath, JSON.stringify(config));
    const restrictedSpawn = vi.fn(async (_id: string, _args: unknown) => ({
      content: [{ type: "text", text: "read helper admitted" }], details: {},
    }));
    options.createNestedReadAgentTools = () => [{
      name: "spawn_agent",
      label: "Restricted spawn",
      description: "Restricted fixture spawn",
      parameters: {
        type: "object",
        properties: { model_slot: { type: "string", enum: ["read-review"] } },
        required: ["model_slot"],
      },
      execute: restrictedSpawn,
    }];
    configure("codemode", [[toolCall("codemode", { code: `
      try { await tools.spawn_agent({ model_slot: "write-critical" }); } catch {}
      await tools.spawn_agent({ model_slot: "read-review" });
      await tools.report_and_exit({ content: "native fixture report" });
    ` })]]);
    await run();
    expect(session, JSON.stringify(options.rememberCompletedAgentReport.mock.calls)).toBeDefined();
    const toolResults = session.messages.filter((message: any) => message.role === "toolResult");
    expect(restrictedSpawn, JSON.stringify(toolResults)).toHaveBeenCalledOnce();
    expect(restrictedSpawn.mock.calls[0][1]).toEqual({ model_slot: "read-review" });
    expect(forbiddenExecute).not.toHaveBeenCalled();
    expect(responses).toBe(1);
    expect(transportClosed).toBe(true);
  }, 10000);

  it.each([false, true])("respects native project MCP configuration trust: %s", async trusted => {
    projectTrusted = trusted;
    configure("direct", [[toolCall("mcp__fixture__echo", { value: "trust" })], [reportCall()]]);
    fs.mkdirSync(path.join(member.cwd, ".pi"));
    fs.writeFileSync(path.join(member.cwd, ".pi", "mcp.json"), JSON.stringify({
      mcpServers: { fixture: { command: "project-not-executed", exposure: "direct" } },
    }));
    await run();
    expect(connections).toEqual([expect.objectContaining({
      scope: trusted ? "project" : "global",
      config: expect.objectContaining({ command: trusted ? "project-not-executed" : "never-executed" }),
    })]);
    expect(calls).toHaveLength(1);
    expect(transportClosed).toBe(true);
  }, 10000);

  it("propagates cancellation to a pending native MCP request", async () => {
    configure("direct", [[toolCall("mcp__fixture__echo", { value: "pending" })]], true);
    const running = run();
    const request = await called.promise;
    await session.abort();
    await running;
    expect(await cancelled.promise).toBe(request.id);
    expect(transportClosed).toBe(true);
  }, 10000);
});
