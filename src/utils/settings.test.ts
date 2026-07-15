import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACCEPTED_FAVORITE_MODEL_SLOTS,
  DEFAULT_SETTINGS,
  DEFAULT_READ_AGENT_MAX_CONCURRENT,
  DEFAULT_READ_HELPER_MAX_CONCURRENT,
  DEFAULT_WRITE_AGENT_MAX_CONCURRENT,
  FAVORITE_MODEL_SLOTS,
  LEGACY_FAVORITE_MODEL_SLOT_ALIASES,
  canonicalPersistedModelSlot,
  clearGlobalFavoriteModels,
  globalSettingsPath,
  loadSettings,
  normalizeFavoriteModelSlot,
  projectSettingsPath,
  readProjectExtensionAllowOverride,
  replaceGlobalExtensionAllow,
  replaceGlobalFavoriteModels,
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
    expect(s.extensions.allow).toBeNull();
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

  it("lets project settings override global, including resetting extension selection to default", () => {
    writeGlobal({
      watchdog: { bufferSeconds: 45 },
      writeAgents: { maxConcurrent: 5 },
      extensions: { allow: ["global-extension"] },
    });
    writeProject({ watchdog: { bufferSeconds: 10 }, extensions: { allow: null } });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.watchdog.bufferSeconds).toBe(10); // project wins
    expect(s.writeAgents.maxConcurrent).toBe(5); // global retained
    expect(s.extensions.allow).toBeNull();
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

  it("normalizes legacy favorite slots and lets canonical values win deterministically", () => {
    writeGlobal({
      favoriteModels: {
        "read-collect": { thinking: "high" },
        "reading-fast": { model: "provider/legacy-collect", thinking: "low" },
        "writing-hard": { model: "provider/legacy-system", thinking: "max" },
        "write-system": { model: "provider/system" },
        unknown: { model: "provider/ignored", thinking: "high" },
        "reading-hard": { model: "provider/hard", thinking: "ultra" },
      },
    });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.favoriteModels["read-collect"]).toEqual({ model: "provider/legacy-collect", thinking: "high" });
    expect(s.favoriteModels["write-system"]).toEqual({ model: "provider/system", thinking: "max" });
    expect(s.favoriteModels["read-critical"]).toEqual({ model: "provider/hard", thinking: null });
    expect(s.favoriteModels).not.toHaveProperty("reading-fast");
    expect(s.favoriteModels).not.toHaveProperty("writing-hard");
    expect(s.favoriteModels).not.toHaveProperty("unknown");
  });

  it("keeps favorite model slots global-only even when project settings exist", () => {
    writeGlobal({ favoriteModels: { "read-review": { model: "global/model", thinking: "xhigh" } } });
    writeProject({ favoriteModels: { "read-review": { model: "project/model", thinking: "high" } } });
    const s = loadSettings({ homeDir, projectDir });
    expect(s.favoriteModels["read-review"]).toEqual({ model: "global/model", thinking: "xhigh" });
  });
});

describe("favorite model persistence", () => {
  it("accepts a legacy slot on write and saves only canonical keys while preserving other settings", () => {
    writeGlobal({
      readAgents: { maxConcurrent: 3 },
      unknownKey: true,
      favoriteModels: {
        "reading-fast": { model: "provider/legacy-collect", thinking: "low" },
        "read-collect": { thinking: "high" },
      },
    });

    setGlobalFavoriteModel("writing-hard", { model: "provider/writer", thinking: "max" }, { homeDir });

    const raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.readAgents).toEqual({ maxConcurrent: 3 });
    expect(raw.unknownKey).toBe(true);
    expect(raw.favoriteModels["read-collect"]).toEqual({ model: "provider/legacy-collect", thinking: "high" });
    expect(raw.favoriteModels["write-system"]).toEqual({ model: "provider/writer", thinking: "max" });
    for (const legacySlot of Object.keys(LEGACY_FAVORITE_MODEL_SLOT_ALIASES)) {
      expect(raw.favoriteModels).not.toHaveProperty(legacySlot);
    }
  });

  it("clears canonical tiers through legacy aliases and canonicalizes retained values", () => {
    writeGlobal({
      favoriteModels: {
        "reading-fast": { model: "provider/collect", thinking: "high" },
        "reading-hard": { model: "provider/critical", thinking: "xhigh" },
      },
    });

    clearGlobalFavoriteModels({ homeDir, slot: "reading-fast" });
    let raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels).not.toHaveProperty("reading-fast");
    expect(raw.favoriteModels).not.toHaveProperty("read-collect");
    expect(raw.favoriteModels).not.toHaveProperty("reading-hard");
    expect(raw.favoriteModels).toHaveProperty("read-critical");

    clearGlobalFavoriteModels({ homeDir });
    raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels).toEqual({});
  });

  it("replaces mixed legacy/canonical input with canonical keys and canonical precedence", () => {
    replaceGlobalFavoriteModels({
      "reading-default": { model: "provider/legacy-review", thinking: "high" },
      "read-review": { model: "provider/review", thinking: "xhigh" },
      "writing-basic": { model: "provider/patch", thinking: "max" },
    }, { homeDir });

    const raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels).toEqual({
      "read-review": { model: "provider/review", thinking: "xhigh" },
      "write-patch": { model: "provider/patch", thinking: "max" },
    });
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
    settings.favoriteModels["write-critical"] = { model: "favorite/model", thinking: "max" };
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
      modelSlot: "write-critical",
      teamDefaultModel: "team/model",
      currentModel: "current/model",
    });
    expect(favorite.model).toBe("favorite/model");
    expect(favorite.modelSource).toBe("favorite-slot");
    expect(favorite.thinking).toBe("max");

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

describe("extension selection persistence", () => {
  it("identifies a project-local extension policy without using merged settings", () => {
    writeGlobal({ extensions: { allow: ["global-extension"] } });
    writeProject({ extensions: { allow: [] } });

    expect(readProjectExtensionAllowOverride(projectDir)).toEqual({
      filePath: projectSettingsPath(projectDir),
      allow: [],
    });
    expect(loadSettings({ homeDir, projectDir }).extensions.allow).toEqual([]);

    writeProject({ extensions: { allow: null } });
    expect(readProjectExtensionAllowOverride(projectDir)?.allow).toBeNull();

    writeProject({ extensions: { block: ["only-block"] } });
    expect(readProjectExtensionAllowOverride(projectDir)).toBeNull();
  });

  it("writes explicit/default choices while preserving unknown and block settings", () => {
    writeGlobal({
      unknownKey: true,
      extensions: { block: ["unsafe"], unknownNested: "keep" },
    });

    replaceGlobalExtensionAllow(["/one.ts", "/one.ts", " /two.ts "], { homeDir });
    let raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw).toMatchObject({
      unknownKey: true,
      extensions: {
        allow: ["/one.ts", "/two.ts"],
        block: ["unsafe"],
        unknownNested: "keep",
      },
    });

    replaceGlobalExtensionAllow(null, { homeDir });
    raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.extensions.allow).toBeNull();
    expect(raw.extensions.block).toEqual(["unsafe"]);
  });
});

describe("favorite model tier names", () => {
  it("defines exactly four canonical read and four canonical write tiers", () => {
    expect(FAVORITE_MODEL_SLOTS).toEqual([
      "read-collect",
      "read-review",
      "read-analyze",
      "read-critical",
      "write-patch",
      "write-feature",
      "write-system",
      "write-critical",
    ]);
    expect(FAVORITE_MODEL_SLOTS.filter((slot) => slot.startsWith("read-"))).toHaveLength(4);
    expect(FAVORITE_MODEL_SLOTS.filter((slot) => slot.startsWith("write-"))).toHaveLength(4);
  });

  it("normalizes every compatibility alias to its canonical tier", () => {
    expect(ACCEPTED_FAVORITE_MODEL_SLOTS).toEqual([
      ...FAVORITE_MODEL_SLOTS,
      ...Object.keys(LEGACY_FAVORITE_MODEL_SLOT_ALIASES),
    ]);
    for (const [legacy, canonical] of Object.entries(LEGACY_FAVORITE_MODEL_SLOT_ALIASES)) {
      expect(normalizeFavoriteModelSlot(legacy)).toBe(canonical);
    }
    expect(normalizeFavoriteModelSlot("not-a-tier")).toBeNull();
  });

  it("projects persisted aliases without changing canonical, unknown, or absent values", () => {
    expect(canonicalPersistedModelSlot("writing-hard")).toBe("write-system");
    expect(canonicalPersistedModelSlot("write-critical")).toBe("write-critical");
    expect(canonicalPersistedModelSlot("future-write-tier")).toBe("future-write-tier");
    expect(canonicalPersistedModelSlot(null)).toBeNull();
    expect(canonicalPersistedModelSlot(undefined)).toBeUndefined();
  });

  it("preserves read/write role mapping for canonical tiers and aliases", () => {
    for (const slot of FAVORITE_MODEL_SLOTS) {
      expect(roleForFavoriteModelSlot(slot)).toBe(slot.startsWith("read-") ? "read" : "write");
    }
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
