import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { resolvePiRuntimeModulePath } from "../internal/pi-runtime-api";
import { registerLeadAttachment, type TeamExecutionOwner } from "./lead-attachment";
import { createTeamHost } from "./team-host";

it("reattaches through the installed SDK reload with stale APIs and no child restart", async () => {
  const sdk = await import(pathToFileURL(resolvePiRuntimeModulePath(process.env.PI_RELOAD_HOST_ENTRY)).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-host-reload-"));
  const apis: any[] = [];
  const contexts: any[] = [];
  const errors: unknown[] = [];
  const close = vi.fn(async () => {});
  let owner: TeamExecutionOwner | undefined;
  const createOwner = vi.fn(() => {
    const host = createTeamHost();
    owner = {
      host,
      // This test exercises the actual host lifecycle, not team persistence or
      // provider execution. Those contracts have separate integration fixtures.
      coordination: {} as TeamExecutionOwner["coordination"],
      taskTools: {} as TeamExecutionOwner["taskTools"],
      hasWork: () => true,
      attach(binding) { contexts.push(binding.ctx); host.attach(binding); },
      activate: () => host.flush(),
      detach: () => host.detach(),
      async close() { host.close(); await close(); },
    };
    return owner;
  });
  const settingsManager = sdk.SettingsManager.inMemory({});
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [(pi: any) => {
      apis.push(pi);
      if (apis.length === 2) owner!.host.api.sendMessage({ customType: "reload-fixture", content: "Full report in reload gap", display: false }, { triggerTurn: false });
      registerLeadAttachment(pi, createOwner);
    }],
  });
  let session: any;
  try {
    await resourceLoader.reload();
    const modelRuntime = sdk.ModelRuntime ? await sdk.ModelRuntime.create({ authPath: path.join(root, "auth.json"),
      modelsPath: null, modelsStorePath: path.join(root, "models-store"), allowModelNetwork: false, refreshOnCreate: false }) : undefined;
    const authStorage = modelRuntime ? undefined : sdk.AuthStorage.inMemory();
    ({ session } = await sdk.createAgentSession({
      cwd: root, agentDir: root, resourceLoader, settingsManager, authStorage, modelRuntime,
      modelRegistry: modelRuntime ? new sdk.ModelRegistry(modelRuntime) : new sdk.ModelRegistry(authStorage, path.join(root, "models.json")),
      sessionManager: sdk.SessionManager.inMemory(root),
      model: { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false,
        input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128 },
    }));
    await session.bindExtensions({ onError: (error: unknown) => errors.push(error) });
    const manager = contexts[0].sessionManager;
    await session.reload();
    expect(errors).toEqual([]);
    expect(createOwner).toHaveBeenCalledOnce();
    expect(contexts[1].sessionManager).toBe(manager);
    expect(close).not.toHaveBeenCalled();
    // Current hosts poison old facades. The package-local 0.73 peer predates
    // that guard; both still exercise actual reload and owner identity.
    const [major, minor] = sdk.VERSION.split(".").map(Number);
    if (major > 0 || minor >= 85) {
      expect(() => apis[0].getCommands()).toThrow();
      expect(() => contexts[0].cwd).toThrow();
    }
    expect(session.sessionManager.getEntries().filter((entry: any) => entry.type === "custom_message" && entry.customType === "reload-fixture"
      && entry.content === "Full report in reload gap")).toHaveLength(1);
    await session.reload();
    expect(createOwner).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    expect(close).toHaveBeenCalledOnce();
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
