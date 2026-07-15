import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as LegacyPiApi from "@mariozechner/pi-coding-agent";

export type PiRuntimeApi = typeof LegacyPiApi;

const CURRENT_PI_PACKAGE = "@earendil-works/pi-coding-agent";
const LEGACY_PI_PACKAGE = "@mariozechner/pi-coding-agent";
let runtimeApiPromise: Promise<PiRuntimeApi> | undefined;

function requireRoots(fromFile?: string): string[] {
  const roots = [fromFile, process.argv[1], __filename]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => path.resolve(value));
  return Array.from(new Set(roots));
}

function packageExportPath(packageDir: string, expectedName: string): string | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf-8"));
    if (manifest.name !== expectedName) return undefined;
    const rootExport = manifest.exports?.["."] ?? manifest.exports;
    const relativeEntrypoint = typeof rootExport === "string"
      ? rootExport
      : rootExport?.import ?? rootExport?.default ?? rootExport?.require ?? manifest.module ?? manifest.main;
    return typeof relativeEntrypoint === "string"
      ? path.resolve(packageDir, relativeEntrypoint)
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveImportOnlyPackage(packageName: string, fromFile: string): string | undefined {
  let directory = path.dirname(fromFile);
  while (true) {
    const ownPackage = packageExportPath(directory, packageName);
    if (ownPackage) return ownPackage;
    const dependencyPackage = packageExportPath(path.join(directory, "node_modules", packageName), packageName);
    if (dependencyPackage) return dependencyPackage;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Resolve package exports from the active Pi executable before local peer fallbacks. */
export function resolvePiRuntimeModulePath(fromFile?: string): string {
  const roots = requireRoots(fromFile);
  for (const packageName of [CURRENT_PI_PACKAGE, LEGACY_PI_PACKAGE]) {
    for (const root of roots) {
      try {
        return createRequire(root).resolve(packageName);
      } catch {
        const importOnlyPath = resolveImportOnlyPackage(packageName, root);
        if (importOnlyPath) return importOnlyPath;
      }
    }
  }
  throw new Error("Could not resolve the active Pi coding-agent API.");
}

async function importPiRuntimeApi(): Promise<PiRuntimeApi> {
  const modulePath = resolvePiRuntimeModulePath();
  return await import(pathToFileURL(modulePath).href) as PiRuntimeApi;
}

/**
 * Use the SDK/configuration classes belonging to the running Pi process.
 * This prevents a package-local legacy peer from replacing current resolver,
 * trust, loader, or session behavior.
 */
export function loadPiRuntimeApi(): Promise<PiRuntimeApi> {
  runtimeApiPromise ??= importPiRuntimeApi();
  return runtimeApiPromise;
}
