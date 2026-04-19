import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_PRIORITY,
  loadModelResolutionConfig,
  resolveModelWithProvider,
  type AvailableModel,
} from "./model-resolution";

const availableModels: AvailableModel[] = [
  { provider: "openrouter", model: "gpt-5" },
  { provider: "openai-codex", model: "gpt-5.4" },
  { provider: "anthropic", model: "claude-sonnet-4" },
  { provider: "github-copilot", model: "claude-sonnet-4" },
];

describe("resolveModelWithProvider", () => {
  it("returns provider-qualified models as-is", () => {
    expect(resolveModelWithProvider("openrouter/gpt-5", availableModels)).toBe("openrouter/gpt-5");
  });

  it("uses configured provider priority for exact matches", () => {
    const resolved = resolveModelWithProvider("claude-sonnet-4", availableModels, {
      providerPriority: ["anthropic", "github-copilot"],
    });

    expect(resolved).toBe("anthropic/claude-sonnet-4");
  });

  it("supports explicit-only providers for bare model names", () => {
    const resolved = resolveModelWithProvider("gpt-5", availableModels, {
      explicitOnlyProviders: ["openrouter"],
    });

    expect(resolved).toBe("openai-codex/gpt-5.4");
  });

  it("returns null when only explicit-only providers match", () => {
    const resolved = resolveModelWithProvider(
      "gpt-5",
      [{ provider: "openrouter", model: "gpt-5" }],
      { explicitOnlyProviders: ["openrouter"] }
    );

    expect(resolved).toBeNull();
  });

  it("falls back to default provider priority when no config is supplied", () => {
    const resolved = resolveModelWithProvider("claude-sonnet-4", availableModels);
    const highestPriority = DEFAULT_PROVIDER_PRIORITY.find((provider) =>
      ["anthropic", "github-copilot"].includes(provider)
    );

    expect(resolved).toBe(`${highestPriority}/claude-sonnet-4`);
  });
});

describe("loadModelResolutionConfig", () => {
  const testRoot = path.join(os.tmpdir(), `pi-teams-model-config-${Date.now()}`);
  const homeDir = path.join(testRoot, "home");
  const projectDir = path.join(testRoot, "project");

  beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(homeDir, ".pi"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("loads defaults when no config files exist", () => {
    fs.rmSync(path.join(homeDir, ".pi"), { recursive: true, force: true });
    fs.rmSync(path.join(projectDir, ".pi"), { recursive: true, force: true });

    const config = loadModelResolutionConfig({ homeDir, projectDir });

    expect(config.providerPriority).toEqual(DEFAULT_PROVIDER_PRIORITY);
    expect(config.explicitOnlyProviders).toEqual([]);
  });

  it("loads global config", () => {
    fs.writeFileSync(
      path.join(homeDir, ".pi", "pi-teams.json"),
      JSON.stringify({ explicitOnlyProviders: ["openrouter"] }, null, 2)
    );

    const config = loadModelResolutionConfig({ homeDir, projectDir });

    expect(config.explicitOnlyProviders).toEqual(["openrouter"]);
  });

  it("lets project config override global config", () => {
    fs.writeFileSync(
      path.join(homeDir, ".pi", "pi-teams.json"),
      JSON.stringify({
        providerPriority: ["github-copilot", "anthropic"],
        explicitOnlyProviders: ["openrouter"],
      }, null, 2)
    );
    fs.writeFileSync(
      path.join(projectDir, ".pi", "pi-teams.json"),
      JSON.stringify({
        providerPriority: ["anthropic", "github-copilot"],
        explicitOnlyProviders: [],
      }, null, 2)
    );

    const config = loadModelResolutionConfig({ homeDir, projectDir });

    expect(config.providerPriority).toEqual(["anthropic", "github-copilot"]);
    expect(config.explicitOnlyProviders).toEqual([]);
  });
});
