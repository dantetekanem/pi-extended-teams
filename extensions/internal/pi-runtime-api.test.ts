import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePiRuntimeModulePath } from "./pi-runtime-api";

const roots: string[] = [];

function packageEntrypoint(root: string, scope: string, name: string): string {
  const packageDir = path.join(root, "node_modules", scope, name);
  const entrypoint = path.join(packageDir, "index.js");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: `${scope}/${name}`,
    type: "module",
    exports: "./index.js",
  }));
  fs.writeFileSync(entrypoint, "export const marker = true;\n");
  return entrypoint;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("active Pi runtime API resolution", () => {
  it("prefers the active @earendil package over legacy local peers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-pi-runtime-"));
    roots.push(root);
    const current = packageEntrypoint(root, "@earendil-works", "pi-coding-agent");
    packageEntrypoint(root, "@mariozechner", "pi-coding-agent");

    expect(resolvePiRuntimeModulePath(path.join(root, "pi-cli.js"))).toBe(fs.realpathSync(current));
  });

  it("retains the legacy package as a compatibility fallback", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-pi-runtime-"));
    roots.push(root);
    const legacy = packageEntrypoint(root, "@mariozechner", "pi-coding-agent");

    expect(resolvePiRuntimeModulePath(path.join(root, "pi-cli.js"))).toBe(fs.realpathSync(legacy));
  });
});
