import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveExternalHarness } from "./external-harness-config";
import { globalSettingsPath } from "./settings";

let homeDir: string;
let binDir: string;

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-harness-"));
  binDir = path.join(homeDir, "bin");
  fs.mkdirSync(binDir);
});

afterEach(() => fs.rmSync(homeDir, { recursive: true, force: true }));

function writeSettings(value: unknown): void {
  const file = globalSettingsPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function executable(name: string, mode = 0o755): string {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, "#!/bin/sh\n", { mode });
  fs.chmodSync(file, mode);
  return file;
}

const options = () => ({ homeDir, env: { PATH: binDir } });

describe("resolveExternalHarness", () => {
  it.each(["claude", "opencode", "amp", "codex"] as const)("resolves a configured %s profile without executing its binary", (kind) => {
    const command = executable(kind);
    writeSettings({ externalHarnesses: { researcher: { kind, args: ["--model", "custom"], instructions: "Read only." } } });
    expect(resolveExternalHarness("researcher", options())).toEqual({
      name: "researcher", kind, command, args: ["--model", "custom"], instructions: "Read only.",
    });
  });

  it.each([
    ["write-critical", "write-system"],
    ["write-system", "write-feature"],
    ["write-feature", "write-patch"],
    ["read-critical", "read-analyze"],
    ["read-analyze", "read-review"],
    ["read-review", "read-collect"],
    ["writing-hard", "write-feature"],
  ] as const)("snapshots the immediately lower native tier %s → %s without changing settings", (source, target) => {
    executable("claude");
    writeSettings({
      favoriteModels: {
        [source]: { harness: "researcher", model: "openai/ignored", thinking: "low" },
        [target]: { model: "openai/test-model", thinking: "high" },
      },
      externalHarnesses: { researcher: { kind: "claude", nativeFallback: true } },
    });
    const before = fs.readFileSync(globalSettingsPath(homeDir), "utf8");
    const profile = resolveExternalHarness("researcher", { ...options(), modelSlot: source });
    const fallback = { modelSlot: target, model: "openai/test-model", thinking: "high" };
    expect(profile.nativeFallback).toEqual(fallback);
    expect(fs.readFileSync(globalSettingsPath(homeDir), "utf8")).toBe(before);
    writeSettings({});
    expect(profile.nativeFallback).toEqual(fallback);
  });

  it.each([
    { kind: "codex", nativeFallback: true },
    { kind: "claude", nativeFallback: "yes" },
    { kind: "claude", nativeFallback: true, args: ["--settings", "custom.json"] },
    { kind: "claude", nativeFallback: true, args: ["--bare"] },
  ])("rejects unsupported fallback configuration before execution: %j", profile => {
    executable(profile.kind);
    writeSettings({
      favoriteModels: { "write-critical": { harness: "researcher", model: "openai/test-model", thinking: "high" } },
      externalHarnesses: { researcher: profile },
    });
    expect(() => resolveExternalHarness("researcher", { ...options(), modelSlot: "write-critical" })).toThrow(/fallback|profile/i);
  });

  it.each([undefined, {}, { model: "openai/test-model" }, { model: "openai/test-model", thinking: "high", harness: "other" }])(
    "rejects a missing, incomplete or external predecessor instead of skipping it: %j", tier => {
      executable("claude");
      writeSettings({
        favoriteModels: {
          "write-critical": { harness: "researcher", model: "openai/ignored", thinking: "low" },
          "write-system": tier,
          "write-feature": { model: "openai/test-model", thinking: "high" },
        },
        externalHarnesses: { researcher: { kind: "claude", nativeFallback: true } },
      });
      expect(() => resolveExternalHarness("researcher", { ...options(), modelSlot: "write-critical" })).toThrow();
    },
  );

  it.each(["read-collect", "write-patch"] as const)("rejects fallback from the lowest %s tier without crossing roles", source => {
    executable("claude");
    writeSettings({
      favoriteModels: {
        [source]: { harness: "researcher", model: "openai/ignored", thinking: "low" },
        "read-critical": { model: "openai/test-model", thinking: "high" },
      },
      externalHarnesses: { researcher: { kind: "claude", nativeFallback: true } },
    });
    expect(() => resolveExternalHarness("researcher", { ...options(), modelSlot: source })).toThrow(/lower tier/i);
  });

  it("requires the source tier to bind this profile without requiring a source native model", () => {
    executable("claude");
    const favoriteModels = {
      "write-critical": { harness: "researcher" },
      "write-system": { model: "openai/test-model", thinking: "high" },
    };
    writeSettings({ favoriteModels, externalHarnesses: { researcher: { kind: "claude", nativeFallback: true } } });
    expect(resolveExternalHarness("researcher", { ...options(), modelSlot: "write-critical" }).nativeFallback?.modelSlot).toBe("write-system");
    favoriteModels["write-critical"].harness = "other";
    writeSettings({ favoriteModels, externalHarnesses: { researcher: { kind: "claude", nativeFallback: true } } });
    expect(() => resolveExternalHarness("researcher", { ...options(), modelSlot: "write-critical" })).toThrow(/bound/i);
  });

  it("defaults optional argv and instructions", () => {
    executable("claude");
    writeSettings({ externalHarnesses: { researcher: { kind: "claude" } } });
    expect(resolveExternalHarness("researcher", options())).toMatchObject({ args: [], instructions: "" });
  });

  it("fails clearly for missing global settings, invalid JSON, and missing profile", () => {
    expect(() => resolveExternalHarness("researcher", options())).toThrow(/not configured/i);
    const file = globalSettingsPath(homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{");
    expect(() => resolveExternalHarness("researcher", options())).toThrow(/invalid JSON/i);
    writeSettings({ externalHarnesses: { other: { kind: "claude" } } });
    expect(() => resolveExternalHarness("researcher", options())).toThrow(/not configured/i);
  });

  it.each([
    { kind: "unknown" },
    { kind: "claude", args: "--model custom" },
    { kind: "claude", args: ["--model", 7] },
    { kind: "claude", instructions: ["read"] },
    { kind: "claude", command: "/bin/sh" },
    null,
  ])("rejects invalid profile entries rather than silently dropping values: %j", (entry) => {
    writeSettings({ externalHarnesses: { researcher: entry } });
    expect(() => resolveExternalHarness("researcher", options())).toThrow(/invalid/i);
  });

  it("rejects invalid profile collections and names", () => {
    writeSettings({ externalHarnesses: ["claude"] });
    expect(() => resolveExternalHarness("researcher", options())).toThrow(/invalid/i);
    writeSettings({ externalHarnesses: { researcher: { kind: "claude" } } });
    expect(() => resolveExternalHarness("", options())).toThrow(/name/i);
  });

  it("checks PATH executability without falling back to another executable or the process PATH", () => {
    executable("claude", 0o644);
    writeSettings({ externalHarnesses: { researcher: { kind: "claude" } } });
    expect(() => resolveExternalHarness("researcher", options())).toThrow(/executable.*PATH/i);
    fs.rmSync(path.join(binDir, "claude"));
    fs.mkdirSync(path.join(binDir, "claude"));
    expect(() => resolveExternalHarness("researcher", options())).toThrow(/executable.*PATH/i);
    expect(() => resolveExternalHarness("researcher", { homeDir, env: { PATH: "" } })).toThrow(/executable.*PATH/i);
  });
});
