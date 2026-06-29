import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  DEFAULT_READ_AGENT_MAX_CONCURRENT,
  DEFAULT_READ_HELPER_MAX_CONCURRENT,
  DEFAULT_WRITE_AGENT_MAX_CONCURRENT,
  clearGlobalFavoriteModels,
  globalSettingsPath,
  loadSettings,
  projectSettingsPath,
  resolveAllowedExtensions,
  resolveModel,
  resolveRole,
  roleForFavoriteModelSlot,
  setGlobalFavoriteModel,
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
    expect(s.writeAgents.maxConcurrent).toBe(DEFAULT_WRITE_AGENT_MAX_CONCURRENT);
    expect(s.writeAgents.queueOverflow).toBe(true);
    expect(s.readAgents.maxConcurrent).toBe(DEFAULT_READ_AGENT_MAX_CONCURRENT);
    expect(s.readAgents.queueOverflow).toBe(true);
    expect(s.readHelpers.maxConcurrent).toBe(DEFAULT_READ_HELPER_MAX_CONCURRENT);
    expect(s.readHelpers.queueOverflow).toBe(true);
    expect(s.roles.read.model).toBeNull();
    expect(s.favoriteModels).toEqual({});
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
      readAgents: { maxConcurrent: 7, queueOverflow: false },
      readHelpers: { maxConcurrent: 2, queueOverflow: false },
      roles: { write: { thinking: "high" } },
      extensions: { allow: ["pi-emote", "my-ext"] },
      debug: { enabled: true },
    });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.watchdog.bufferSeconds).toBe(45);
    expect(s.writeAgents.maxConcurrent).toBe(5);
    expect(s.writeAgents.queueOverflow).toBe(false);
    expect(s.readAgents.maxConcurrent).toBe(7);
    expect(s.readAgents.queueOverflow).toBe(false);
    expect(s.readHelpers.maxConcurrent).toBe(2);
    expect(s.readHelpers.queueOverflow).toBe(false);
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

  it("accepts high configured concurrency for large fanouts", () => {
    writeProject({
      writeAgents: { maxConcurrent: 300 },
      readAgents: { maxConcurrent: 300 },
      readHelpers: { maxConcurrent: 75 },
    });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.writeAgents.maxConcurrent).toBe(300);
    expect(s.readAgents.maxConcurrent).toBe(300);
    expect(s.readHelpers.maxConcurrent).toBe(75);
  });

  it("ignores invalid values", () => {
    writeGlobal({
      watchdog: { bufferSeconds: -5 },
      writeAgents: { maxConcurrent: 0 },
      readAgents: { maxConcurrent: 0 },
      readHelpers: { maxConcurrent: 0 },
      debug: "yes",
    });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.watchdog.bufferSeconds).toBe(30);
    expect(s.writeAgents.maxConcurrent).toBe(DEFAULT_WRITE_AGENT_MAX_CONCURRENT);
    expect(s.readAgents.maxConcurrent).toBe(DEFAULT_READ_AGENT_MAX_CONCURRENT);
    expect(s.readHelpers.maxConcurrent).toBe(DEFAULT_READ_HELPER_MAX_CONCURRENT);
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

  it("loads configured favorite model slots and ignores unknown slots", () => {
    writeGlobal({
      favoriteModels: {
        "reading-fast": { model: "provider/fast", thinking: "low" },
        unknown: { model: "provider/ignored", thinking: "high" },
        "reading-hard": { model: "provider/hard", thinking: "ultra" },
      },
    });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.favoriteModels["reading-fast"]).toEqual({ model: "provider/fast", thinking: "low" });
    expect(s.favoriteModels["reading-hard"]).toEqual({ model: "provider/hard", thinking: null });
    expect(s.favoriteModels).not.toHaveProperty("unknown");
  });

  it("keeps favorite model slots global-only even when project settings exist", () => {
    writeGlobal({ favoriteModels: { "reading-default": { model: "global/model", thinking: "high" } } });
    writeProject({ favoriteModels: { "reading-default": { model: "project/model", thinking: "xhigh" } } });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.favoriteModels["reading-default"]).toEqual({ model: "global/model", thinking: "high" });
  });
});

describe("favorite model persistence", () => {
  it("writes favorite slots to the global settings path while preserving other keys", () => {
    writeGlobal({ readAgents: { maxConcurrent: 3 }, unknownKey: true });

    setGlobalFavoriteModel("writing-hard", { model: "provider/writer", thinking: "xhigh" }, { homeDir });

    const raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.readAgents).toEqual({ maxConcurrent: 3 });
    expect(raw.unknownKey).toBe(true);
    expect(raw.favoriteModels["writing-hard"]).toEqual({ model: "provider/writer", thinking: "xhigh" });
  });

  it("clears one or all favorite slots", () => {
    writeGlobal({
      favoriteModels: {
        "reading-fast": { model: "provider/fast", thinking: "low" },
        "reading-hard": { model: "provider/hard", thinking: "xhigh" },
      },
    });

    clearGlobalFavoriteModels({ homeDir, slot: "reading-fast" });
    let raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels).not.toHaveProperty("reading-fast");
    expect(raw.favoriteModels).toHaveProperty("reading-hard");

    clearGlobalFavoriteModels({ homeDir });
    raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels).toEqual({});
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

  it("honors precedence: explicit > favorite slot > category > role > team > current", () => {
    const settings = withCategories({
      impl: { role: "write", model: "cat/model", thinking: null },
    });
    settings.favoriteModels["writing-hard"] = { model: "favorite/model", thinking: "xhigh" };
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

    const favorite = resolveModel(settings, {
      role: "write",
      category: "impl",
      modelSlot: "writing-hard",
      teamDefaultModel: "team/model",
      currentModel: "current/model",
    });
    expect(favorite.model).toBe("favorite/model");
    expect(favorite.modelSource).toBe("favorite-slot");
    expect(favorite.thinking).toBe("xhigh");

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

  it("throws when a requested favorite slot is unset or combined with explicit overrides", () => {
    expect(() =>
      resolveModel(structuredClone(DEFAULT_SETTINGS), { role: "read", modelSlot: "reading-fast" })
    ).toThrow(/not configured/);

    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.favoriteModels["reading-fast"] = { model: "provider/fast", thinking: "low" };
    expect(() =>
      resolveModel(settings, { role: "read", modelSlot: "reading-fast", explicitThinking: "high" })
    ).toThrow(/cannot be combined/);
  });
});

describe("resolveAllowedExtensions", () => {
  it("returns allow minus block", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.extensions.allow = ["pi-emote", "my-ext", "noisy"];
    s.extensions.block = ["noisy"];
    expect(resolveAllowedExtensions(s, { homeDir })).toEqual(["pi-emote", "my-ext"]);
  });

  it("is empty by default", () => {
    expect(resolveAllowedExtensions(structuredClone(DEFAULT_SETTINGS), { homeDir })).toEqual([]);
  });

  it("auto-loads an installed provider bootstrap extension", () => {
    const bootstrap = path.join(homeDir, ".pi", "agent", "extensions", "shopify-proxy");
    fs.mkdirSync(bootstrap, { recursive: true });

    expect(resolveAllowedExtensions(structuredClone(DEFAULT_SETTINGS), { homeDir })).toEqual([bootstrap]);
  });

  it("blocks provider bootstrap extensions by name", () => {
    const bootstrap = path.join(homeDir, ".pi", "agent", "extensions", "shopify-proxy");
    fs.mkdirSync(bootstrap, { recursive: true });
    const s = structuredClone(DEFAULT_SETTINGS);
    s.extensions.allow = ["custom-ext"];
    s.extensions.block = ["shopify-proxy"];

    expect(resolveAllowedExtensions(s, { homeDir })).toEqual(["custom-ext"]);
  });
});

describe("roleForFavoriteModelSlot", () => {
  it("derives agent role from the selected level", () => {
    expect(roleForFavoriteModelSlot("reading-fast")).toBe("read");
    expect(roleForFavoriteModelSlot("reading-default")).toBe("read");
    expect(roleForFavoriteModelSlot("reading-hard")).toBe("read");
    expect(roleForFavoriteModelSlot("writing-basic")).toBe("write");
    expect(roleForFavoriteModelSlot("writing-hard")).toBe("write");
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
