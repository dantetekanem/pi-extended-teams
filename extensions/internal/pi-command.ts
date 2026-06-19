import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Build the command used to relaunch pi for teammate processes.
 *
 * There are three common cases:
 * - npm/node install: pi runs as `node .../dist/cli.js`
 * - standalone compiled binary: process.execPath is the actual `pi` executable
 * - shim-based installs (e.g. Volta): process.execPath is `node` and argv[1]
 *   may be a shim path, so the safest relaunch command is plain `pi`
 */
export function getPiLaunchCommand(): string {
  const argv1 = process.argv[1];
  const execPath = process.execPath;

  if (argv1) {
    const ext = path.extname(argv1).toLowerCase();
    const looksLikeScript = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(ext)
      || /(?:^|[/\\])dist[/\\]cli\.js$/i.test(argv1);

    if (looksLikeScript) {
      return `node ${JSON.stringify(argv1)}`;
    }
  }

  if (execPath) {
    const base = path.basename(execPath).toLowerCase();
    if (base !== "node" && base !== "node.exe" && base !== "bun" && base !== "bun.exe") {
      return JSON.stringify(execPath);
    }
  }

  return "pi";
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const EXTENSION_ENTRYPOINTS = ["index.ts", "index.js", "index.mjs", "index.cjs"];
const DISABLED_PREFLIGHT_VALUES = new Set(["", "0", "false", "no", "off"]);

interface ExtensionSourceFileSystem {
  existsSync(filePath: string): boolean;
  readFileSync(filePath: string, encoding: BufferEncoding): string;
}

export interface ExtensionSourceResolutionOptions {
  env?: Record<string, string | undefined>;
  filename?: string;
  cwd?: string;
  homeDir?: string;
  fileSystem?: ExtensionSourceFileSystem;
}

const defaultFileSystem: ExtensionSourceFileSystem = {
  existsSync: nodeFs.existsSync,
  readFileSync: (filePath, encoding) => nodeFs.readFileSync(filePath, encoding),
};

function firstExistingPath(candidates: string[], fileSystem: ExtensionSourceFileSystem): string | null {
  return candidates.find(candidate => fileSystem.existsSync(candidate)) ?? null;
}

function stripPiSettingMarker(value: string): string | null {
  const stripped = value.trim().replace(/^[+-]/, "");
  return stripped && stripped !== "-" ? stripped : null;
}

function resolveLocalPackageSource(settingsDir: string, source: string): string | null {
  if (source.startsWith("npm:") || source.startsWith("http://") || source.startsWith("https://")) return null;
  return path.resolve(settingsDir, source);
}

function findExtensionSourceFromPiSettings(homeDir: string, fileSystem: ExtensionSourceFileSystem): string | null {
  const settingsPath = path.join(homeDir, ".pi", "agent", "settings.json");
  if (!fileSystem.existsSync(settingsPath)) return null;

  try {
    const settings = JSON.parse(fileSystem.readFileSync(settingsPath, "utf-8"));
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    const settingsDir = path.dirname(settingsPath);

    for (const entry of packages) {
      const source = typeof entry === "string" ? entry : entry?.source;
      if (typeof source !== "string" || !source.includes("pi-extended-teams")) continue;

      const sourceDir = resolveLocalPackageSource(settingsDir, source);
      if (!sourceDir) continue;

      const configuredExtensions = Array.isArray(entry?.extensions)
        ? entry.extensions.map((value: unknown) => typeof value === "string" ? stripPiSettingMarker(value) : null).filter((value: string | null): value is string => !!value)
        : [];

      const configuredCandidates = configuredExtensions.map((extensionPath: string) => path.resolve(sourceDir, extensionPath));
      const defaultCandidates = EXTENSION_ENTRYPOINTS.map(entrypoint => path.join(sourceDir, "extensions", entrypoint));
      const found = firstExistingPath([...configuredCandidates, ...defaultCandidates], fileSystem);
      if (found) return found;
    }
  } catch {
    return null;
  }

  return null;
}

function findExtensionSourceFromCwd(cwd: string, fileSystem: ExtensionSourceFileSystem): string | null {
  return firstExistingPath([
    ...EXTENSION_ENTRYPOINTS.map(entrypoint => path.join(cwd, "extensions", entrypoint)),
    ...EXTENSION_ENTRYPOINTS.map(entrypoint => path.join(cwd, "pi-extended-teams", "extensions", entrypoint)),
    ...EXTENSION_ENTRYPOINTS.map(entrypoint => path.join(path.dirname(cwd), "pi-extended-teams", "extensions", entrypoint)),
  ], fileSystem);
}

function getExtensionEntrypointFallback(options: Required<Omit<ExtensionSourceResolutionOptions, "env">>): string {
  const ext = path.extname(options.filename) || ".js";
  const moduleRelativeCandidate = path.join(path.dirname(path.dirname(options.filename)), `index${ext}`);
  const moduleRelativeCandidates = [
    moduleRelativeCandidate,
    ...EXTENSION_ENTRYPOINTS.map(entrypoint => path.join(path.dirname(path.dirname(options.filename)), entrypoint)),
  ];

  return firstExistingPath(moduleRelativeCandidates, options.fileSystem)
    ?? findExtensionSourceFromPiSettings(options.homeDir, options.fileSystem)
    ?? findExtensionSourceFromCwd(options.cwd, options.fileSystem)
    ?? moduleRelativeCandidate;
}

export function resolvePiExtendedTeamsExtensionSource(options: ExtensionSourceResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const explicitSource = env.PI_EXTENDED_TEAMS_EXTENSION_SOURCE || env.PI_TEAMS_EXTENSION_SOURCE;
  if (explicitSource) return explicitSource;

  return getExtensionEntrypointFallback({
    filename: options.filename ?? __filename,
    cwd: options.cwd ?? process.cwd(),
    homeDir: options.homeDir ?? os.homedir(),
    fileSystem: options.fileSystem ?? defaultFileSystem,
  });
}

export function getPiExtendedTeamsExtensionSource(): string {
  return resolvePiExtendedTeamsExtensionSource();
}

export function buildExtensionArgs(allowedExtensions: string[] = []): string {
  const parts = ["--no-extensions", "--extension", shellQuote(getPiExtendedTeamsExtensionSource())];
  for (const source of allowedExtensions) {
    parts.push("--extension", shellQuote(source));
  }
  return parts.join(" ");
}

export function buildPiCommand(
  piBinary: string,
  chosenModel?: string,
  thinking?: string,
  allowedExtensions: string[] = [],
  noSkills = false
): string {
  const extensionArgs = buildExtensionArgs(allowedExtensions);
  const governanceArgs = noSkills ? " --no-skills" : "";

  if (chosenModel) {
    const modelArg = thinking ? `${chosenModel}:${thinking}` : chosenModel;
    return `${piBinary} ${extensionArgs}${governanceArgs} --model ${shellQuote(modelArg)}`;
  }

  if (thinking) {
    return `${piBinary} ${extensionArgs}${governanceArgs} --thinking ${shellQuote(thinking)}`;
  }

  return `${piBinary} ${extensionArgs}${governanceArgs}`;
}

export type ChildPiModelAvailabilityStatus = "available" | "missing" | "unknown" | "skipped";

export interface ChildPiModelAvailability {
  status: ChildPiModelAvailabilityStatus;
  command: string | null;
  stdout: string;
  stderr: string;
  exitStatus: number | null;
}

export interface ChildPiModelAvailabilityOptions {
  run?: (command: string) => { status: number | null; stdout: string; stderr: string };
  timeoutMs?: number;
}

function defaultRun(command: string, timeoutMs: number): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("sh", ["-c", command], { encoding: "utf-8", timeout: timeoutMs });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? result.error?.message ?? "",
  };
}

function parseModelSpecifier(model: string): { provider: string; model: string } | null {
  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) return null;

  const provider = model.slice(0, slashIndex).trim();
  const modelId = model.slice(slashIndex + 1).trim();
  if (!provider || !modelId) return null;

  return { provider, model: modelId };
}

export function isModelListed(output: string, chosenModel: string): boolean {
  const parsed = parseModelSpecifier(chosenModel);
  if (!parsed) return false;

  return output.split("\n").some((line) => {
    const [provider, model] = line.trim().split(/\s+/);
    return provider === parsed.provider && model === parsed.model;
  });
}

export function checkChildPiModelAvailability(
  piBinary: string,
  chosenModel: string | undefined,
  allowedExtensions: string[] = [],
  options: ChildPiModelAvailabilityOptions = {}
): ChildPiModelAvailability {
  const preflightSetting = process.env.PI_EXTENDED_TEAMS_MODEL_PREFLIGHT ?? process.env.PI_TEAMS_MODEL_PREFLIGHT;
  if (!chosenModel || DISABLED_PREFLIGHT_VALUES.has(preflightSetting?.trim().toLowerCase() ?? "enabled")) {
    return { status: "skipped", command: null, stdout: "", stderr: "", exitStatus: null };
  }

  const command = `${piBinary} ${buildExtensionArgs(allowedExtensions)} --list-models`;
  const run = options.run ?? ((cmd: string) => defaultRun(cmd, options.timeoutMs ?? 10000));
  const result = run(command);
  const modelListOutput = `${result.stdout}\n${result.stderr}`;
  const status = result.status === 0
    ? isModelListed(modelListOutput, chosenModel) ? "available" : "missing"
    : "unknown";

  return {
    status,
    command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitStatus: result.status,
  };
}
