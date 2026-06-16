import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  globalSettingsPath,
  loadSettings,
  projectSettingsPath,
  resolveAllowedExtensions,
  resolveModel,
  resolveRole,
  type PiExtendedTeamsSettings,
} from "./settings";

let homeDir: string;
let projectDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-home-"));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-proj-"));
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function writeGlobal(obj: unknown) {
  const p = globalSettingsPath(homeDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}

function writeProject(obj: unknown) {
  const p = projectSettingsPath(projectDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}

describe("loadSettings", () => {
  it("returns defaults when no files exist", () => {
    const s = loadSettings({ homeDir, projectDir });
    expect(s.watchdog.bufferSeconds).toBe(30);
    expect(s.writeAgents.maxConcurrent).toBe(3);
    expect(s.writeAgents.queueOverflow).toBe(true);
    expect(s.roles.read.model).toBeNull();
    expect(s.extensions.allow).toEqual([]);
    expect(s.debug.enabled).toBe(false);
  });

  it("does not mutate DEFAULT_SETTINGS", () => {
    writeGlobal({ watchdog: { bufferSeconds: 99 } });
    loadSettings({ homeDir, projectDir });
    expect(DEFAULT_SETTINGS.watchdog.bufferSeconds).toBe(30);
  });

  it("reads global settings", () => {
    writeGlobal({
      watchdog: { bufferSeconds: 45 },
      writeAgents: { maxConcurrent: 5, queueOverflow: false },
      roles: { write: { thinking: "high" } },
      extensions: { allow: ["pi-emote", "my-ext"] },
      debug: { enabled: true },
    });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.watchdog.bufferSeconds).toBe(45);
    expect(s.writeAgents.maxConcurrent).toBe(5);
    expect(s.writeAgents.queueOverflow).toBe(false);
    expect(s.roles.write.thinking).toBe("high");
    expect(s.extensions.allow).toEqual(["pi-emote", "my-ext"]);
    expect(s.debug.enabled).toBe(true);
  });

  it("lets project settings override global", () => {
    writeGlobal({ watchdog: { bufferSeconds: 45 }, writeAgents: { maxConcurrent: 5 } });
    writeProject({ watchdog: { bufferSeconds: 10 } });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.watchdog.bufferSeconds).toBe(10); // project wins
    expect(s.writeAgents.maxConcurrent).toBe(5); // global retained
  });

  it("ignores invalid values", () => {
    writeGlobal({ watchdog: { bufferSeconds: -5 }, writeAgents: { maxConcurrent: 0 }, debug: "yes" });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.watchdog.bufferSeconds).toBe(30);
    expect(s.writeAgents.maxConcurrent).toBe(3);
    expect(s.debug.enabled).toBe(false);
  });

  it("supports boolean shorthand for debug mode", () => {
    writeProject({ debug: true });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.debug.enabled).toBe(true);
  });

  it("normalizes categories and rejects bad thinking levels", () => {
    writeGlobal({
      categories: {
        researcher: { role: "read", model: "openai-codex/gpt-5.4", thinking: "low" },
        bad: { role: "sideways", thinking: "ultra" },
      },
    });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.categories.researcher).toEqual({
      role: "read",
      model: "openai-codex/gpt-5.4",
      thinking: "low",
    });
    expect(s.categories.bad.role).toBeUndefined();
    expect(s.categories.bad.thinking).toBeNull();
  });
});

function withCategories(categories: PiExtendedTeamsSettings["categories"]): PiExtendedTeamsSettings {
  return { ...structuredClone(DEFAULT_SETTINGS), categories };
}

describe("resolveModel", () => {
  it("inherits current model when nothing else is set", () => {
    const r = resolveModel(structuredClone(DEFAULT_SETTINGS), {
      role: "write",
      currentModel: "openai-codex/gpt-5.4",
    });
    expect(r.model).toBe("openai-codex/gpt-5.4");
    expect(r.modelSource).toBe("current");
  });

  it("honors precedence: explicit > category > role > team > current", () => {
    const settings = withCategories({
      impl: { role: "write", model: "cat/model", thinking: null },
    });
    settings.roles.write = { model: "role/model", thinking: "medium" };

    expect(
      resolveModel(settings, {
        role: "write",
        category: "impl",
        explicitModel: "explicit/model",
        teamDefaultModel: "team/model",
        currentModel: "current/model",
      }).model
    ).toBe("explicit/model");

    expect(
      resolveModel(settings, {
        role: "write",
        category: "impl",
        teamDefaultModel: "team/model",
        currentModel: "current/model",
      }).model
    ).toBe("cat/model");

    expect(
      resolveModel(settings, {
        role: "write",
        teamDefaultModel: "team/model",
        currentModel: "current/model",
      }).model
    ).toBe("role/model");
  });

  it("falls back to team default before current", () => {
    const r = resolveModel(structuredClone(DEFAULT_SETTINGS), {
      role: "read",
      teamDefaultModel: "team/model",
      currentModel: "current/model",
    });
    expect(r.model).toBe("team/model");
    expect(r.modelSource).toBe("team");
  });

  it("resolves thinking precedence", () => {
    const settings = withCategories({
      deep: { role: "read", model: null, thinking: "high" },
    });
    settings.roles.read = { model: null, thinking: "low" };

    expect(resolveModel(settings, { role: "read", category: "deep" }).thinking).toBe("high");
    expect(resolveModel(settings, { role: "read" }).thinking).toBe("low");
    expect(
      resolveModel(settings, { role: "read", category: "deep", explicitThinking: "minimal" })
        .thinking
    ).toBe("minimal");
  });

  it("throws on unknown category", () => {
    expect(() =>
      resolveModel(structuredClone(DEFAULT_SETTINGS), { role: "read", category: "nope" })
    ).toThrow(/Unknown category/);
  });
});

describe("resolveAllowedExtensions", () => {
  it("returns allow minus block", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.extensions.allow = ["pi-emote", "my-ext", "noisy"];
    s.extensions.block = ["noisy"];
    expect(resolveAllowedExtensions(s)).toEqual(["pi-emote", "my-ext"]);
  });

  it("is empty by default", () => {
    expect(resolveAllowedExtensions(structuredClone(DEFAULT_SETTINGS))).toEqual([]);
  });
});

describe("resolveRole", () => {
  it("uses category role over requested role", () => {
    const settings = withCategories({
      reviewer: { role: "read", model: null, thinking: null },
    });
    expect(resolveRole(settings, "write", "reviewer")).toBe("read");
  });

  it("falls back to requested role without a category", () => {
    expect(resolveRole(structuredClone(DEFAULT_SETTINGS), "write")).toBe("write");
  });
});
