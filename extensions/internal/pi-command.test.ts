import { afterEach, describe, expect, it } from "vitest";
import { buildExtensionArgs, buildPiCommand, getPiExtendedTeamsExtensionSource } from "./pi-command";

const originalExtendedSource = process.env.PI_EXTENDED_TEAMS_EXTENSION_SOURCE;
const originalLegacySource = process.env.PI_TEAMS_EXTENSION_SOURCE;

function restoreEnv() {
  if (originalExtendedSource === undefined) delete process.env.PI_EXTENDED_TEAMS_EXTENSION_SOURCE;
  else process.env.PI_EXTENDED_TEAMS_EXTENSION_SOURCE = originalExtendedSource;

  if (originalLegacySource === undefined) delete process.env.PI_TEAMS_EXTENSION_SOURCE;
  else process.env.PI_TEAMS_EXTENSION_SOURCE = originalLegacySource;
}

describe("pi command helpers", () => {
  afterEach(() => {
    restoreEnv();
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
});
