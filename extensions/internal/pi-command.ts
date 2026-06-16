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

function getExtensionEntrypointFallback(): string {
  const ext = path.extname(__filename) || ".js";
  return path.join(path.dirname(path.dirname(__filename)), `index${ext}`);
}

export function getPiExtendedTeamsExtensionSource(): string {
  return process.env.PI_EXTENDED_TEAMS_EXTENSION_SOURCE || process.env.PI_TEAMS_EXTENSION_SOURCE || getExtensionEntrypointFallback();
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
  allowedExtensions: string[] = []
): string {
  const extensionArgs = buildExtensionArgs(allowedExtensions);

  if (chosenModel) {
    const modelArg = thinking ? `${chosenModel}:${thinking}` : chosenModel;
    return `${piBinary} ${extensionArgs} --model ${shellQuote(modelArg)}`;
  }

  if (thinking) {
    return `${piBinary} ${extensionArgs} --thinking ${shellQuote(thinking)}`;
  }

  return `${piBinary} ${extensionArgs}`;
}
