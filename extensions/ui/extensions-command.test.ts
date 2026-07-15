import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  globalSettingsPath,
  loadSettings,
  projectSettingsPath,
  replaceGlobalExtensionAllow,
} from "../../src/utils/settings";
import type { SpawnResourcePlan } from "../resources/spawn-resource-plan";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  getSettingsListTheme: () => ({
    label: (text: string) => text,
    value: (text: string) => text,
    description: (text: string) => text,
    cursor: ">",
    hint: (text: string) => text,
  }),
}));
import {
  explicitAllowFromPicker,
  formatExtensionsPlan,
  registerExtensionsCommand,
} from "./extensions-command";

function makePlan(): SpawnResourcePlan {
  return Object.freeze({
    selectionMode: "explicit" as const,
    extensionPaths: Object.freeze(["/extensions/selected/index.ts"]),
    selfExtensionPath: "/pi-extended-teams/extensions/index.ts",
    extensions: Object.freeze([
      Object.freeze({
        name: "selected",
        selector: "selected",
        identity: "/extensions/selected/index.ts",
        path: "/extensions/selected/index.ts",
        selected: true,
        state: "selected" as const,
        isSelf: false,
        sourceInfo: Object.freeze({ path: "/extensions/selected/index.ts", source: "npm:selected-package", scope: "user" as const, origin: "package" as const }),
      }),
      Object.freeze({
        name: "off",
        selector: "off",
        identity: "/project/.pi/extensions/off.ts",
        path: "/project/.pi/extensions/off.ts",
        selected: false,
        state: "available" as const,
        isSelf: false,
        sourceInfo: Object.freeze({ path: "/project/.pi/extensions/off.ts", source: "local", scope: "project" as const, origin: "top-level" as const }),
      }),
      Object.freeze({
        name: "pi-extended-teams",
        selector: "pi-extended-teams",
        identity: "/pi-extended-teams/extensions/index.ts",
        path: "/pi-extended-teams/extensions/index.ts",
        selected: false,
        state: "self" as const,
        isSelf: true,
        sourceInfo: Object.freeze({ path: "/pi-extended-teams/extensions/index.ts", source: "local", scope: "user" as const, origin: "top-level" as const }),
      }),
    ]),
    diagnostics: Object.freeze([
      Object.freeze({
        code: "stale-selection" as const,
        configuredEntry: "missing-extension",
        message: "Configured extension is not observable in the lead Pi session: missing-extension",
      }),
    ]),
    skills: "all" as const,
    trust: Object.freeze({ cwd: "/project", projectTrusted: true }),
  });
}

function theme() {
  return {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  };
}

function setupFileBackedCommand(options: {
  homeDir: string;
  projectDir: string;
  trusted: boolean;
  custom?: (factory: any) => Promise<any>;
}) {
  const commands = new Map<string, any>();
  const pi = { registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)) };
  const ctx = {
    cwd: options.projectDir,
    mode: "tui",
    isProjectTrusted: () => options.trusted,
    ui: {
      notify: vi.fn(),
      custom: options.custom ? vi.fn(options.custom) : vi.fn(),
    },
  };
  registerExtensionsCommand(pi, {
    createResourcePlan: vi.fn(async () => makePlan()),
    loadTeamsSettings: (loadOptions) => loadSettings({ homeDir: options.homeDir, projectDir: loadOptions?.projectDir }),
    saveAllow: (allow) => replaceGlobalExtensionAllow(allow, { homeDir: options.homeDir }),
    getGlobalSettingsPath: () => globalSettingsPath(options.homeDir),
  });
  return { command: commands.get("agents-extensions"), ctx };
}

function setupCommand(custom?: (factory: any) => Promise<any>) {
  const commands = new Map<string, any>();
  const pi = { registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)) };
  const saveAllow = vi.fn();
  const createResourcePlan = vi.fn(async () => makePlan());
  const loadTeamsSettings = vi.fn(() => ({ extensions: { allow: ["selected", "missing-extension"], block: [] } } as any));
  registerExtensionsCommand(pi, {
    createResourcePlan,
    loadTeamsSettings,
    saveAllow,
  });
  const ctx = {
    cwd: "/project",
    mode: "tui",
    isProjectTrusted: () => true,
    ui: {
      notify: vi.fn(),
      custom: custom ? vi.fn(custom) : vi.fn(),
    },
  };
  return { command: commands.get("agents-extensions"), ctx, saveAllow, createResourcePlan, loadTeamsSettings, pi };
}

describe("/agents-extensions", () => {
  it("formats textual enabled, disabled, self, missing, and provenance states", async () => {
    const plan = makePlan();
    const text = formatExtensionsPlan(plan);
    expect(text).toContain("Skills use normal Pi discovery and trust. pi-extended-teams is handled internally.");
    expect(text).toContain("event-only extensions cannot be propagated");
    expect(text).toContain("enabled · selected · user · package · npm:selected-package");
    expect(text).toContain("disabled · off.ts · project · top-level · local");
    expect(text).toContain("internal · extensions · user · top-level · local");
    expect(text).toContain("Configured extension is not observable in the lead Pi session: missing-extension");

    const setup = setupCommand();
    await setup.command.handler("list", setup.ctx);
    expect(setup.loadTeamsSettings).toHaveBeenCalledWith({ projectDir: "/project" });
    expect(setup.createResourcePlan).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/project",
      projectTrusted: true,
    }));
    expect(setup.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("missing-extension"), "info");
    expect(setup.saveAllow).not.toHaveBeenCalled();
  });

  it("does not read project-local policy when the parent project is untrusted", async () => {
    const setup = setupCommand();
    setup.ctx.mode = "print";
    setup.ctx.isProjectTrusted = () => false;

    await setup.command.handler("list", setup.ctx);

    expect(setup.loadTeamsSettings).toHaveBeenCalledWith({ projectDir: undefined });
    expect(setup.createResourcePlan).toHaveBeenCalledWith(expect.objectContaining({ projectTrusted: false }));
  });

  it("writes nothing when the native SettingsList is cancelled", async () => {
    const setup = setupCommand(async (factory: any) => {
      return new Promise((resolve) => {
        const component = factory({ requestRender: vi.fn() }, theme(), {}, resolve);
        component.handleInput("\u001b");
      });
    });

    await setup.command.handler("", setup.ctx);
    expect(setup.saveAllow).not.toHaveBeenCalled();
  });

  it("saves explicit resolver-ordered paths while retaining stale configured entries", async () => {
    const setup = setupCommand(async (factory: any) => {
      return new Promise((resolve) => {
        const component = factory({ requestRender: vi.fn() }, theme(), {}, resolve);
        component.handleInput("\u001b[B");
        component.handleInput("\r");
        component.handleInput("\u0013");
      });
    });

    await setup.command.handler("", setup.ctx);
    expect(setup.saveAllow).toHaveBeenCalledWith(["missing-extension"]);
    expect(setup.ctx.ui.notify).toHaveBeenCalledWith("Spawned-agent extension choices saved.", "info");
  });

  it("supports durable default and none policies without opening the selector", async () => {
    const setup = setupCommand();
    await setup.command.handler("default", setup.ctx);
    await setup.command.handler("none", setup.ctx);

    expect(setup.saveAllow.mock.calls).toEqual([[null], [[]]]);
    expect(setup.createResourcePlan).not.toHaveBeenCalled();
    expect(setup.ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("saves default and none globally while a trusted project policy remains effective", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-command-home-"));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-command-project-"));
    try {
      const globalPath = globalSettingsPath(homeDir);
      const projectPath = projectSettingsPath(projectDir);
      fs.mkdirSync(path.dirname(globalPath), { recursive: true });
      fs.mkdirSync(path.dirname(projectPath), { recursive: true });
      fs.writeFileSync(globalPath, JSON.stringify({ unknownGlobal: true, extensions: { allow: ["global"], block: ["blocked"] } }));
      fs.writeFileSync(projectPath, JSON.stringify({ unknownProject: true, extensions: { allow: ["project"], block: ["project-block"] } }));
      const projectBefore = fs.readFileSync(projectPath, "utf-8");
      const setup = setupFileBackedCommand({ homeDir, projectDir, trusted: true });

      await setup.command.handler("default", setup.ctx);
      expect(JSON.parse(fs.readFileSync(globalPath, "utf-8"))).toMatchObject({
        unknownGlobal: true,
        extensions: { allow: null, block: ["blocked"] },
      });
      expect(loadSettings({ homeDir, projectDir }).extensions.allow).toEqual(["project"]);
      expect(fs.readFileSync(projectPath, "utf-8")).toBe(projectBefore);
      expect(setup.ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining(`Global spawned-agent extension policy was saved to ${globalPath}`),
        "warning",
      );
      expect(setup.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(projectPath), "warning");

      await setup.command.handler("none", setup.ctx);
      expect(JSON.parse(fs.readFileSync(globalPath, "utf-8")).extensions.allow).toEqual([]);
      expect(loadSettings({ homeDir, projectDir }).extensions.allow).toEqual(["project"]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("saves picker choices globally but leaves a trusted project override authoritative", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-command-home-"));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-command-project-"));
    try {
      const globalPath = globalSettingsPath(homeDir);
      const projectPath = projectSettingsPath(projectDir);
      fs.mkdirSync(path.dirname(globalPath), { recursive: true });
      fs.mkdirSync(path.dirname(projectPath), { recursive: true });
      fs.writeFileSync(globalPath, JSON.stringify({ extensions: { allow: ["global"], block: ["blocked"], unknownNested: true } }));
      fs.writeFileSync(projectPath, JSON.stringify({ extensions: { allow: [], block: ["project-block"] }, projectOnly: true }));
      const projectBefore = fs.readFileSync(projectPath, "utf-8");
      const setup = setupFileBackedCommand({
        homeDir,
        projectDir,
        trusted: true,
        custom: async () => ({ mode: "explicit", selectedIdentities: ["/extensions/selected/index.ts"] }),
      });

      await setup.command.handler("", setup.ctx);

      expect(JSON.parse(fs.readFileSync(globalPath, "utf-8"))).toMatchObject({
        extensions: { allow: ["/extensions/selected/index.ts", "missing-extension"], block: ["blocked"], unknownNested: true },
      });
      expect(fs.readFileSync(projectPath, "utf-8")).toBe(projectBefore);
      expect(loadSettings({ homeDir, projectDir }).extensions.allow).toEqual([]);
      expect(setup.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(projectPath), "warning");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("ignores an untrusted project override and leaves files unchanged when picker is cancelled", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-command-home-"));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-command-project-"));
    try {
      const globalPath = globalSettingsPath(homeDir);
      const projectPath = projectSettingsPath(projectDir);
      fs.mkdirSync(path.dirname(globalPath), { recursive: true });
      fs.mkdirSync(path.dirname(projectPath), { recursive: true });
      fs.writeFileSync(globalPath, JSON.stringify({ extensions: { allow: ["global"], block: ["blocked"] } }));
      fs.writeFileSync(projectPath, JSON.stringify({ extensions: { allow: ["project"] } }));
      const projectBefore = fs.readFileSync(projectPath, "utf-8");
      const setup = setupFileBackedCommand({ homeDir, projectDir, trusted: false });

      await setup.command.handler("none", setup.ctx);
      expect(JSON.parse(fs.readFileSync(globalPath, "utf-8")).extensions.allow).toEqual([]);
      expect(loadSettings({ homeDir }).extensions.allow).toEqual([]);
      expect(fs.readFileSync(projectPath, "utf-8")).toBe(projectBefore);
      expect(setup.ctx.ui.notify).toHaveBeenLastCalledWith(
        "Spawned agents will load no external extensions. Skills remain enabled.",
        "info",
      );

      const globalBeforeCancel = fs.readFileSync(globalPath, "utf-8");
      const cancelled = setupFileBackedCommand({
        homeDir,
        projectDir,
        trusted: true,
        custom: async () => null,
      });
      await cancelled.command.handler("", cancelled.ctx);
      expect(fs.readFileSync(globalPath, "utf-8")).toBe(globalBeforeCancel);
      expect(fs.readFileSync(projectPath, "utf-8")).toBe(projectBefore);
      expect(loadSettings({ homeDir, projectDir }).extensions.allow).toEqual(["project"]);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("persists canonical identities, excludes self, and preserves stale or blocked entries", () => {
    const plan = makePlan();
    const withBlockedDiagnostic: SpawnResourcePlan = Object.freeze({
      ...plan,
      diagnostics: Object.freeze([
        ...plan.diagnostics,
        Object.freeze({
          code: "blocked-selection" as const,
          configuredEntry: "/extensions/blocked/index.ts",
          message: "Configured extension is blocked for spawned agents: /extensions/blocked/index.ts",
        }),
      ]),
    });

    expect(explicitAllowFromPicker(withBlockedDiagnostic, {
      mode: "explicit",
      selectedIdentities: [
        "/extensions/selected/index.ts",
        "/pi-extended-teams/extensions/index.ts",
      ],
    })).toEqual([
      "/extensions/selected/index.ts",
      "missing-extension",
      "/extensions/blocked/index.ts",
    ]);
    expect(explicitAllowFromPicker(plan, { mode: "default", selectedIdentities: [] })).toBeNull();
  });
});
