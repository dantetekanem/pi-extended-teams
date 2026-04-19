import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AvailableModel {
  provider: string;
  model: string;
}

export interface ModelResolutionConfig {
  providerPriority?: string[];
  explicitOnlyProviders?: string[];
}

export interface ResolvedModelResolutionConfig {
  providerPriority: string[];
  explicitOnlyProviders: string[];
}

/**
 * Default provider priority used for bare model names.
 * OAuth/subscription providers go first, then API-key providers.
 */
export const DEFAULT_PROVIDER_PRIORITY = [
  "google-gemini-cli",
  "github-copilot",
  "kimi-sub",
  "anthropic",
  "openai",
  "google",
  "zai",
  "openrouter",
  "azure-openai",
  "amazon-bedrock",
  "mistral",
  "groq",
  "cerebras",
  "xai",
  "vercel-ai-gateway",
];

function normalizeList(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const normalized = values
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean);

  return normalized.length > 0 ? Array.from(new Set(normalized)) : [];
}

function readConfigFile(configPath: string): ModelResolutionConfig {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as ModelResolutionConfig;
    return {
      providerPriority: normalizeList(parsed.providerPriority),
      explicitOnlyProviders: normalizeList(parsed.explicitOnlyProviders),
    };
  } catch {
    return {};
  }
}

/**
 * Loads model resolution config.
 *
 * Supported locations:
 * - ~/.pi/pi-teams.json
 * - <project>/.pi/pi-teams.json
 *
 * Project-local config overrides global config.
 */
export function loadModelResolutionConfig(options?: {
  projectDir?: string;
  homeDir?: string;
}): ResolvedModelResolutionConfig {
  const homeDir = options?.homeDir ?? os.homedir();
  const projectDir = options?.projectDir;

  const globalConfigPath = path.join(homeDir, ".pi", "pi-teams.json");
  const projectConfigPath = projectDir ? path.join(projectDir, ".pi", "pi-teams.json") : null;

  const merged: ResolvedModelResolutionConfig = {
    providerPriority: [...DEFAULT_PROVIDER_PRIORITY],
    explicitOnlyProviders: [],
  };

  for (const configPath of [globalConfigPath, projectConfigPath]) {
    if (!configPath) continue;

    const config = readConfigFile(configPath);
    if (config.providerPriority && config.providerPriority.length > 0) {
      merged.providerPriority = config.providerPriority;
    }
    if (config.explicitOnlyProviders) {
      merged.explicitOnlyProviders = config.explicitOnlyProviders;
    }
  }

  return merged;
}

function sortByProviderPriority(
  models: AvailableModel[],
  providerPriority: string[]
): AvailableModel[] {
  return [...models].sort((a, b) => {
    const aIndex = providerPriority.indexOf(a.provider.toLowerCase());
    const bIndex = providerPriority.indexOf(b.provider.toLowerCase());
    const aPriority = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
    const bPriority = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
    return aPriority - bPriority;
  });
}

/**
 * Finds the best matching provider/model string for an unqualified model name.
 * Providers listed in explicitOnlyProviders are ignored unless the caller passes
 * a fully qualified provider/model string.
 */
export function resolveModelWithProvider(
  modelName: string,
  availableModels: AvailableModel[],
  config?: Partial<ResolvedModelResolutionConfig>
): string | null {
  if (modelName.includes("/")) {
    return modelName;
  }

  if (availableModels.length === 0) {
    return null;
  }

  const providerPriority = config?.providerPriority?.length
    ? config.providerPriority.map((value) => value.toLowerCase())
    : DEFAULT_PROVIDER_PRIORITY;
  const explicitOnlyProviders = new Set(
    (config?.explicitOnlyProviders ?? []).map((value) => value.toLowerCase())
  );

  const candidates = availableModels.filter(
    (model) => !explicitOnlyProviders.has(model.provider.toLowerCase())
  );

  if (candidates.length === 0) {
    return null;
  }

  const lowerModelName = modelName.toLowerCase();

  const exactMatches = candidates.filter(
    (model) => model.model.toLowerCase() === lowerModelName
  );
  if (exactMatches.length > 0) {
    const preferred = sortByProviderPriority(exactMatches, providerPriority)[0];
    return `${preferred.provider}/${preferred.model}`;
  }

  const partialMatches = candidates.filter((model) =>
    model.model.toLowerCase().includes(lowerModelName)
  );
  if (partialMatches.length > 0) {
    const preferred = sortByProviderPriority(partialMatches, providerPriority)[0];
    return `${preferred.provider}/${preferred.model}`;
  }

  return null;
}
