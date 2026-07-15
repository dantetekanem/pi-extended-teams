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

  it("keeps normal Pi skill discovery enabled and propagates an untrusted parent", () => {
    const command = buildPiCommand("pi", "provider/model", "high", [], false);
    expect(command).toContain("--no-approve --no-extensions");
    expect(command).toContain("--model 'provider/model:high'");
    expect(command).not.toContain("--no-skills");
  });

  it("still honors explicit extension source environment overrides and loads self exactly once", () => {
    process.env.PI_EXTENDED_TEAMS_EXTENSION_SOURCE = "/tmp/custom-extension.ts";
    delete process.env.PI_TEAMS_EXTENSION_SOURCE;

    expect(getPiExtendedTeamsExtensionSource()).toBe("/tmp/custom-extension.ts");
    const args = buildExtensionArgs(["/tmp/custom-extension.ts", "/tmp/external.ts", "/tmp/external.ts"]);
    expect(args.match(/'\/tmp\/custom-extension\.ts'/g)).toHaveLength(1);
    expect(args.match(/'\/tmp\/external\.ts'/g)).toHaveLength(1);
  });

  it("canonical-dedupes self and selected extension symlinks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-pi-extension-args-"));
    try {
      const self = path.join(root, "self.ts");
      const selfLink = path.join(root, "self-link.ts");
      const selected = path.join(root, "selected.ts");
      const selectedLink = path.join(root, "selected-link.ts");
      fs.writeFileSync(self, "export default function () {}\n");
      fs.writeFileSync(selected, "export default function () {}\n");
      fs.symlinkSync(self, selfLink);
      fs.symlinkSync(selected, selectedLink);

      const args = buildExtensionArgs([selfLink, selected, selectedLink], true, self);
      expect(args).toContain(`--approve --no-extensions --extension '${self}'`);
      expect(args.match(/--extension/g)).toHaveLength(2);
      expect(args).toContain(`--extension '${selected}'`);
      expect(args).not.toContain(selfLink);
      expect(args).not.toContain(selectedLink);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("single-quotes arbitrary selected paths so sh -c cannot expand dollar signs", () => {
    const args = buildExtensionArgs(["/tmp/$HOME/selected extension.ts"]);
    expect(args).toContain("--extension '/tmp/$HOME/selected extension.ts'");
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
      projectTrusted: true,
      run: (command) => ({
        status: 0,
        stdout: command.includes("--extension '/tmp/bootstrap'") ? "provider  model  context" : "",
        stderr: "",
      }),
    });

    expect(result.status).toBe("available");
    expect(result.command).toContain("--approve --no-extensions");
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
