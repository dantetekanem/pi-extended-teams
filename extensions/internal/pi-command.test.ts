import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExtensionArgs, buildPiCommand, checkChildPiModelAvailability, getPiExtendedTeamsExtensionSource, isModelListed, resolvePiExtendedTeamsExtensionSource } from "./pi-command";

const originalExtendedSource = process.env.PI_EXTENDED_TEAMS_EXTENSION_SOURCE;
const originalLegacySource = process.env.PI_TEAMS_EXTENSION_SOURCE;
const originalPreflight = process.env.PI_EXTENDED_TEAMS_MODEL_PREFLIGHT;
const originalLegacyPreflight = process.env.PI_TEAMS_MODEL_PREFLIGHT;

function restoreEnv() {
  if (originalExtendedSource === undefined) delete process.env.PI_EXTENDED_TEAMS_EXTENSION_SOURCE;
  else process.env.PI_EXTENDED_TEAMS_EXTENSION_SOURCE = originalExtendedSource;

  if (originalLegacySource === undefined) delete process.env.PI_TEAMS_EXTENSION_SOURCE;
  else process.env.PI_TEAMS_EXTENSION_SOURCE = originalLegacySource;

  if (originalPreflight === undefined) delete process.env.PI_EXTENDED_TEAMS_MODEL_PREFLIGHT;
  else process.env.PI_EXTENDED_TEAMS_MODEL_PREFLIGHT = originalPreflight;

  if (originalLegacyPreflight === undefined) delete process.env.PI_TEAMS_MODEL_PREFLIGHT;
  else process.env.PI_TEAMS_MODEL_PREFLIGHT = originalLegacyPreflight;
}

describe("pi command helpers", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("uses the local pi-extended-teams package configured in Pi settings when module-relative lookup misses", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-pi-home-"));
    try {
      const settingsPath = path.join(homeDir, ".pi", "agent", "settings.json");
      const packageDir = path.join(homeDir, "src", "pi-extended-teams");
      const extensionPath = path.join(packageDir, "extensions", "index.ts");
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
      fs.writeFileSync(extensionPath, "export default function () {}\n");
      fs.writeFileSync(settingsPath, JSON.stringify({
        packages: [{ source: "../../src/pi-extended-teams", extensions: ["+extensions/index.ts"] }],
      }));

      expect(resolvePiExtendedTeamsExtensionSource({
        env: {},
        filename: path.join(homeDir, "missing-install", "extensions", "internal", "pi-command.js"),
        cwd: path.join(homeDir, "other-project"),
        homeDir,
      })).toBe(extensionPath);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("falls back to a nearby checkout from cwd when the installed module path cannot find the extension", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-pi-cwd-"));
    try {
      const cwd = path.join(root, "pi-extended-teams");
      const extensionPath = path.join(cwd, "extensions", "index.ts");
      fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
      fs.writeFileSync(extensionPath, "export default function () {}\n");

      expect(resolvePiExtendedTeamsExtensionSource({
        env: {},
        filename: path.join(root, "missing-install", "extensions", "internal", "pi-command.js"),
        cwd,
        homeDir: path.join(root, "home"),
      })).toBe(extensionPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the extension entrypoint instead of the internal command helper", () => {
    delete process.env.PI_EXTENDED_TEAMS_EXTENSION_SOURCE;
    delete process.env.PI_TEAMS_EXTENSION_SOURCE;

    const source = getPiExtendedTeamsExtensionSource().replace(/\\/g, "/");

    expect(source).toMatch(/\/extensions\/index\.(ts|js|mjs|cjs)$/);
    expect(source).not.toContain("/extensions/internal/");
    expect(buildExtensionArgs()).toContain("--extension");
    expect(buildPiCommand("pi", "provider/model")).toContain("/extensions/index.");
  });

  it("still honors explicit extension source environment overrides", () => {
    process.env.PI_EXTENDED_TEAMS_EXTENSION_SOURCE = "/tmp/custom-extension.ts";
    delete process.env.PI_TEAMS_EXTENSION_SOURCE;

    expect(getPiExtendedTeamsExtensionSource()).toBe("/tmp/custom-extension.ts");
    expect(buildExtensionArgs()).toContain("'/tmp/custom-extension.ts'");
  });

  it("matches fully qualified models in pi list output", () => {
    const output = [
      "provider                              model                     context  max-out  thinking  images",
      "anthropic-250k-prefer-using-this-one  claude-opus-4-8           250K     128K     yes       yes",
      "anthropic                             claude-opus-4-8           1M       128K     yes       yes",
    ].join("\n");

    expect(isModelListed(output, "anthropic-250k-prefer-using-this-one/claude-opus-4-8")).toBe(true);
    expect(isModelListed(output, "anthropic-250k-prefer-using-this-one/claude-opus-4-7")).toBe(false);
  });

  it("checks the child Pi model registry with the spawn extension set", () => {
    delete process.env.PI_EXTENDED_TEAMS_MODEL_PREFLIGHT;
    delete process.env.PI_TEAMS_MODEL_PREFLIGHT;

    const result = checkChildPiModelAvailability("pi", "provider/model", ["/tmp/bootstrap"], {
      run: (command) => ({
        status: 0,
        stdout: command.includes("--extension '/tmp/bootstrap'") ? "provider  model  context" : "",
        stderr: "",
      }),
    });

    expect(result.status).toBe("available");
    expect(result.command).toContain("--no-extensions");
    expect(result.command).toContain("--extension '/tmp/bootstrap'");
  });

  it("checks stderr when Pi writes the model table there", () => {
    delete process.env.PI_EXTENDED_TEAMS_MODEL_PREFLIGHT;
    delete process.env.PI_TEAMS_MODEL_PREFLIGHT;

    const result = checkChildPiModelAvailability("pi", "provider/model", ["/tmp/bootstrap"], {
      run: () => ({
        status: 0,
        stdout: "",
        stderr: "provider  model  context",
      }),
    });

    expect(result.status).toBe("available");
  });

  it("skips child Pi model checks when preflight is disabled", () => {
    process.env.PI_EXTENDED_TEAMS_MODEL_PREFLIGHT = "0";

    const result = checkChildPiModelAvailability("pi", "provider/model", ["/tmp/bootstrap"], {
      run: () => { throw new Error("preflight should not run"); },
    });

    expect(result.status).toBe("skipped");
    expect(result.command).toBeNull();
  });
});
