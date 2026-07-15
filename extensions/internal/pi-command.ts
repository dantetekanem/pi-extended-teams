import { spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
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

function extensionPathIdentity(source: string): string {
  const absolute = path.resolve(source);
  try {
    return nodeFs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

const EXTENSION_ENTRYPOINTS = ["index.ts", "index.js", "index.mjs", "index.cjs"];
const DISABLED_PREFLIGHT_VALUES = new Set(["", "0", "false", "no", "off"]);

interface ExtensionSourceFileSystem {
  existsSync(filePath: string): boolean;
}

export interface ExtensionSourceResolutionOptions {
  env?: Record<string, string | undefined>;
  filename?: string;
  cwd?: string;
  fileSystem?: ExtensionSourceFileSystem;
}

const defaultFileSystem: ExtensionSourceFileSystem = {
  existsSync: nodeFs.existsSync,
};

function firstExistingPath(candidates: string[], fileSystem: ExtensionSourceFileSystem): string | null {
  return candidates.find(candidate => fileSystem.existsSync(candidate)) ?? null;
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
    fileSystem: options.fileSystem ?? defaultFileSystem,
  });
}

export function getPiExtendedTeamsExtensionSource(): string {
  return resolvePiExtendedTeamsExtensionSource();
}

export function buildExtensionArgs(
  allowedExtensions: readonly string[] = [],
  projectTrusted?: boolean,
  selfExtensionSource = getPiExtendedTeamsExtensionSource(),
): string {
  const trustArgs = projectTrusted === undefined ? [] : [projectTrusted ? "--approve" : "--no-approve"];
  const parts = [...trustArgs, "--no-extensions", "--extension", shellQuote(selfExtensionSource)];
  const seen = new Set([extensionPathIdentity(selfExtensionSource)]);
  for (const source of allowedExtensions) {
    const identity = extensionPathIdentity(source);
    if (seen.has(identity)) continue;
    seen.add(identity);
    parts.push("--extension", shellQuote(source));
  }
  return parts.join(" ");
}

export function buildPiCommand(
  piBinary: string,
  chosenModel?: string,
  thinking?: string,
  allowedExtensions: readonly string[] = [],
  projectTrusted?: boolean,
  selfExtensionSource?: string,
): string {
  const extensionArgs = buildExtensionArgs(allowedExtensions, projectTrusted, selfExtensionSource);

  if (chosenModel) {
    const modelArg = thinking ? `${chosenModel}:${thinking}` : chosenModel;
    return `${piBinary} ${extensionArgs} --model ${shellQuote(modelArg)}`;
  }

  if (thinking) {
    return `${piBinary} ${extensionArgs} --thinking ${shellQuote(thinking)}`;
  }

  return `${piBinary} ${extensionArgs}`;
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
  projectTrusted?: boolean;
  selfExtensionSource?: string;
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
  allowedExtensions: readonly string[] = [],
  options: ChildPiModelAvailabilityOptions = {}
): ChildPiModelAvailability {
  const preflightSetting = process.env.PI_EXTENDED_TEAMS_MODEL_PREFLIGHT ?? process.env.PI_TEAMS_MODEL_PREFLIGHT;
  if (!chosenModel || DISABLED_PREFLIGHT_VALUES.has(preflightSetting?.trim().toLowerCase() ?? "enabled")) {
    return { status: "skipped", command: null, stdout: "", stderr: "", exitStatus: null };
  }

  const command = `${piBinary} ${buildExtensionArgs(allowedExtensions, options.projectTrusted, options.selfExtensionSource)} --list-models`;
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
