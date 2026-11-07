import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FAVORITE_MODEL_SLOTS,
  globalSettingsPath,
  loadSettings,
  normalizeFavoriteModelSlot,
  requireFavoriteModelLevel,
  roleForFavoriteModelSlot,
  type CanonicalFavoriteModelSlot,
  type FavoriteModelSlot,
  type ThinkingLevelName,
} from "./settings";

export interface ExternalHarnessProfile {
  name: string;
  kind: "claude" | "opencode" | "amp" | "codex";
  command: string;
  args: string[];
  instructions: string;
  nativeFallback?: {
    modelSlot: CanonicalFavoriteModelSlot;
    model: string;
    thinking: ThinkingLevelName;
  };
}

const KINDS = new Set<ExternalHarnessProfile["kind"]>(["claude", "opencode", "amp", "codex"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Resolve an explicitly selected global profile without starting a CLI. */
export function resolveExternalHarness(
  name: string,
  options: { homeDir?: string; env?: NodeJS.ProcessEnv; modelSlot?: FavoriteModelSlot } = {},
): ExternalHarnessProfile {
  if (typeof name !== "string" || !name.trim()) throw new Error("External harness profile name is required.");
  const file = globalSettingsPath(options.homeDir ?? os.homedir());
  let settings: unknown;
  try {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`External harness profile "${name}" is not configured in ${file}.`);
    }
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in external harness settings ${file}.`);
    throw error;
  }

  if (!record(settings)) throw new Error(`Invalid external harness settings in ${file}.`);
  const profiles = settings.externalHarnesses;
  if (profiles === undefined) throw new Error(`External harness profile "${name}" is not configured in ${file}.`);
  if (!record(profiles)) throw new Error(`Invalid externalHarnesses in ${file}: expected an object.`);
  if (!Object.hasOwn(profiles, name)) throw new Error(`External harness profile "${name}" is not configured in ${file}.`);

  const profile = profiles[name];
  if (!record(profile)
    || !KINDS.has(profile.kind as ExternalHarnessProfile["kind"])
    || Object.keys(profile).some((key) => !["kind", "args", "instructions", "nativeFallback"].includes(key))
    || (profile.nativeFallback !== undefined && typeof profile.nativeFallback !== "boolean")
    || (profile.args !== undefined && (!Array.isArray(profile.args) || !profile.args.every((arg) => typeof arg === "string")))
    || (profile.instructions !== undefined && typeof profile.instructions !== "string")) {
    throw new Error(`Invalid external harness profile "${name}" in ${file}. Expected { kind, args?, instructions?, nativeFallback? }.`);
  }

  const kind = profile.kind as ExternalHarnessProfile["kind"];
  const args = (profile.args as string[] | undefined) ?? [];
  let nativeFallback: ExternalHarnessProfile["nativeFallback"];
  if (profile.nativeFallback) {
    if (kind !== "claude" || args.some(arg => /^--(?:settings|bare)(?:=|$)/.test(arg))) {
      throw new Error("Native fallback requires Claude StopFailure hooks without --settings or --bare overrides.");
    }
    const global = loadSettings({ homeDir: options.homeDir });
    const slot = normalizeFavoriteModelSlot(options.modelSlot);
    if (!slot || global.favoriteModels[slot]?.harness !== name) {
      throw new Error("Native fallback must use the tier bound to this harness.");
    }
    const lowerSlot = FAVORITE_MODEL_SLOTS[FAVORITE_MODEL_SLOTS.indexOf(slot) - 1];
    if (!lowerSlot || roleForFavoriteModelSlot(lowerSlot) !== roleForFavoriteModelSlot(slot)) {
      throw new Error(`Native fallback has no lower tier for ${slot}.`);
    }
    if (global.favoriteModels[lowerSlot]?.harness !== undefined) {
      throw new Error(`Native fallback requires a native model on the immediately lower tier ${lowerSlot}.`);
    }
    const level = requireFavoriteModelLevel(global, lowerSlot);
    nativeFallback = { modelSlot: level.slot, model: level.model, thinking: level.thinking };
  }
  const env = options.env ?? process.env;
  const command = (env.PATH ?? "").split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.resolve(directory, kind))
    .find((candidate) => {
      try {
        if (!fs.statSync(candidate).isFile()) return false;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (!command) throw new Error(`External harness "${name}" requires executable ${kind} on PATH.`);

  return {
    name,
    kind,
    command,
    args,
    instructions: (profile.instructions as string | undefined) ?? "",
    ...(nativeFallback ? { nativeFallback } : {}),
  };
}
