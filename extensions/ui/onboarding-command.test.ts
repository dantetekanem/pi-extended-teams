import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, globalSettingsPath, projectSettingsPath } from "../../src/utils/settings.js";
import type { SpawnResourcePlan } from "../resources/spawn-resource-plan.js";
import { registerOnboardingCommand } from "./onboarding-command.js";

function resourcePlan(): SpawnResourcePlan {
  return {
    selectionMode: "explicit",
    extensionPaths: ["/extensions/reviewer.ts"],
    selfExtensionPath: "/packages/pi-extended-teams/extensions/index.ts",
    extensions: [
      {
        name: "reviewer",
        selector: "reviewer",
        identity: "/extensions/reviewer.ts",
        path: "/extensions/reviewer.ts",
        selected: true,
        state: "selected",
        isSelf: false,
        sourceInfo: {
          path: "/extensions/reviewer.ts",
          source: "npm:reviewer",
          scope: "user",
          origin: "package",
        },
      },
      {
        name: "dangerous-events",
        selector: "dangerous-events",
        identity: "/extensions/dangerous-events.ts",
        path: "/extensions/dangerous-events.ts",
        selected: false,
        state: "available",
        isSelf: false,
        sourceInfo: {
          path: "/extensions/dangerous-events.ts",
          source: "local",
          scope: "project",
          origin: "top-level",
        },
      },
    ],
    diagnostics: [],
    skills: "all",
    trust: { cwd: "/project", projectTrusted: true },
  };
}

function setupCommand(options: { idle?: boolean; inventoryError?: Error } = {}) {
  const commands = new Map<string, any>();
  const pi = {
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    sendUserMessage: vi.fn(),
    getCommands: vi.fn(() => [{
      name: "pi-extended-teams-onboard",
      description: "Start agent-led setup for pi-extended-teams.",
      source: "extension",
      sourceInfo: {
        path: "/packages/pi-extended-teams/extensions/index.ts",
        source: "npm:pi-extended-teams",
        scope: "user",
        origin: "package",
      },
    }]),
  };
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.favoriteModels["read-review"] = { model: "anthropic/sonnet", thinking: "high" };
  settings.extensions.allow = ["/extensions/reviewer.ts"];

  const getAvailableModels = options.inventoryError
    ? vi.fn(async () => { throw options.inventoryError; })
    : vi.fn(async () => [
      { provider: "anthropic", model: "sonnet", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
      { provider: "openai", model: "fast", reasoning: false },
    ]);
  const loadTeamsSettings = vi.fn(() => settings);
  const createResourcePlan = vi.fn(async () => resourcePlan());
  registerOnboardingCommand(pi, { getAvailableModels, loadTeamsSettings, createResourcePlan });

  const ctx = {
    cwd: "/project",
    mode: "tui",
    model: { provider: "anthropic", id: "sonnet" },
    thinkingLevel: "high",
    isIdle: vi.fn(() => options.idle ?? true),
    isProjectTrusted: vi.fn(() => true),
    ui: { notify: vi.fn() },
  };

  return { command: commands.get("pi-extended-teams-onboard"), ctx, pi, getAvailableModels, loadTeamsSettings, createResourcePlan };
}

describe("/pi-extended-teams-onboard", () => {
  it("starts one read-only agent turn with the actual setup inventory", async () => {
    const setup = setupCommand();

    await setup.command.handler("", setup.ctx);

    expect(setup.loadTeamsSettings).toHaveBeenCalledWith({ projectDir: "/project" });
    expect(setup.createResourcePlan).toHaveBeenCalledWith({
      cwd: "/project",
      projectTrusted: true,
      settings: expect.any(Object),
      pi: setup.pi,
    });
    expect(setup.pi.sendUserMessage).toHaveBeenCalledOnce();

    const prompt = setup.pi.sendUserMessage.mock.calls[0]![0] as string;
    expect(prompt).toContain("This first pass is read-only");
    expect(prompt).toContain('"qualified": "anthropic/sonnet"');
    expect(prompt).toContain('"supportedThinking": [');
    expect(prompt).toContain('"read-review": {');
    expect(prompt).toContain('"model": "anthropic/sonnet"');
    expect(prompt).toContain('"state": "selected"');
    expect(prompt).toContain('"name": "dangerous-events"');
    expect(prompt).toContain('"source": "npm:pi-extended-teams"');
    expect(prompt).toContain(globalSettingsPath());
    expect(prompt).toContain(projectSettingsPath("/project"));
    expect(prompt).toContain("/agents-favorite-models set");
    expect(prompt).toContain("/agents-extensions");
    expect(prompt).toContain("pi update --extension");
    expect(prompt).toContain("one focused approval question");
  });

  it("refuses to queue onboarding behind an active agent turn", async () => {
    const setup = setupCommand({ idle: false });

    await setup.command.handler("", setup.ctx);

    expect(setup.ctx.ui.notify).toHaveBeenCalledWith(
      "Wait for the current agent turn to finish, then run /pi-extended-teams-onboard again.",
      "warning",
    );
    expect(setup.getAvailableModels).not.toHaveBeenCalled();
    expect(setup.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("reports inventory failure without sending a partial prompt", async () => {
    const setup = setupCommand({ inventoryError: new Error("catalog unavailable") });

    await setup.command.handler("", setup.ctx);

    expect(setup.ctx.ui.notify).toHaveBeenCalledWith(
      "Could not start pi-extended-teams onboarding: catalog unavailable",
      "warning",
    );
    expect(setup.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("rejects arguments instead of silently changing the onboarding request", async () => {
    const setup = setupCommand();

    await setup.command.handler("unexpected", setup.ctx);

    expect(setup.ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /pi-extended-teams-onboard",
      "warning",
    );
    expect(setup.getAvailableModels).not.toHaveBeenCalled();
    expect(setup.pi.sendUserMessage).not.toHaveBeenCalled();
  });
});
