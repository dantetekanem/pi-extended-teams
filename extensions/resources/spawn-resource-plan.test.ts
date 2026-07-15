import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/utils/settings";
import {
  createSpawnResourcePlan,
  EXTENSIONS_COMMAND_DESCRIPTION,
  parentProjectTrustForSpawn,
  snapshotLeadExtensions,
  type ExtensionSourceInfo,
} from "./spawn-resource-plan";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-resource-plan-"));
  roots.push(root);
  return root;
}

function touch(filePath: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "export default function () {}\n");
  return filePath;
}

function sourceInfo(filePath: string, overrides: Partial<ExtensionSourceInfo> = {}): ExtensionSourceInfo {
  return {
    path: filePath,
    source: "local",
    scope: "user",
    origin: "top-level",
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("lead extension snapshots", () => {
  it("uses only public command/tool sourceInfo, dedupes canonical paths, and identifies self", () => {
    const root = tempRoot();
    const self = touch(path.join(root, "pi-extended-teams", "extensions", "index.ts"));
    const selected = touch(path.join(root, "selected", "index.ts"));
    const selectedLink = path.join(root, "selected-link.ts");
    fs.symlinkSync(selected, selectedLink);

    const snapshot = snapshotLeadExtensions({
      getCommands: () => [
        { name: "agents-extensions", source: "extension", sourceInfo: sourceInfo(self) },
        { name: "selected-command", source: "extension", sourceInfo: sourceInfo(selected) },
        { name: "skill:anything", source: "skill", sourceInfo: sourceInfo("/skills/anything.md") },
      ],
      getAllTools: () => [
        { name: "read", sourceInfo: sourceInfo("<builtin:read>", { source: "builtin", scope: "temporary" }) },
        { name: "selected-tool", sourceInfo: sourceInfo(selectedLink) },
        { name: "other", sourceInfo: sourceInfo(path.join(root, "other.ts"), { source: "npm:other", origin: "package" }) },
      ],
    });

    expect(snapshot.map((extension) => extension.path)).toEqual([self, selected, path.join(root, "other.ts")]);
    expect(snapshot.map((extension) => extension.name)).toEqual(["pi-extended-teams", "selected", "other"]);
    expect(snapshot.map((extension) => extension.isSelf)).toEqual([true, false, false]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0]?.sourceInfo)).toBe(true);
  });

  it("identifies self by its public command description when invocation names collide", () => {
    const root = tempRoot();
    const other = touch(path.join(root, "other.ts"));
    const self = touch(path.join(root, "pi-extended-teams", "extensions", "index.ts"));
    const snapshot = snapshotLeadExtensions({
      getCommands: () => [
        { name: "agents-extensions", description: "Another command", source: "extension", sourceInfo: sourceInfo(other) },
        { name: "agents-extensions:2", description: EXTENSIONS_COMMAND_DESCRIPTION, source: "extension", sourceInfo: sourceInfo(self) },
      ],
      getAllTools: () => [],
    });

    expect(snapshot.map((extension) => extension.isSelf)).toEqual([false, true]);
  });

  it("cannot observe event-only or synthetic inline extensions through the public registration surface", () => {
    const snapshot = snapshotLeadExtensions({
      getCommands: () => [],
      getAllTools: () => [
        { name: "sdk-tool", sourceInfo: sourceInfo("<sdk:sdk-tool>", { source: "sdk", scope: "temporary" }) },
      ],
    });

    expect(snapshot).toEqual([]);
  });
});

describe("spawn resource planning", () => {
  it("preserves null, empty, explicit, and block semantics over the lead snapshot", () => {
    const root = tempRoot();
    const self = touch(path.join(root, "pi-extended-teams", "extensions", "index.ts"));
    const first = touch(path.join(root, "first", "index.ts"));
    const second = touch(path.join(root, "second.ts"));
    const blocked = touch(path.join(root, "blocked.ts"));
    const leadExtensions = snapshotLeadExtensions({
      getCommands: () => [
        { name: "agents-extensions", source: "extension", sourceInfo: sourceInfo(self) },
        { name: "first-command", source: "extension", sourceInfo: sourceInfo(first) },
      ],
      getAllTools: () => [
        { name: "second-tool", sourceInfo: sourceInfo(second) },
        { name: "blocked-tool", sourceInfo: sourceInfo(blocked) },
      ],
    });

    const defaultSettings = structuredClone(DEFAULT_SETTINGS);
    defaultSettings.extensions.block = ["blocked"];
    const defaultPlan = createSpawnResourcePlan({
      cwd: root,
      projectTrusted: true,
      settings: defaultSettings,
      leadExtensions,
    });
    expect(defaultPlan.extensionPaths).toEqual([first, second]);
    expect(defaultPlan.selfExtensionPath).toBe(self);
    expect(defaultPlan.extensions.map((extension) => extension.state)).toEqual([
      "self",
      "selected",
      "selected",
      "blocked",
    ]);

    const noneSettings = structuredClone(DEFAULT_SETTINGS);
    noneSettings.extensions.allow = [];
    const none = createSpawnResourcePlan({ cwd: root, projectTrusted: true, settings: noneSettings, leadExtensions });
    expect(none.selectionMode).toBe("explicit");
    expect(none.extensionPaths).toEqual([]);

    const explicitSettings = structuredClone(DEFAULT_SETTINGS);
    explicitSettings.extensions.allow = ["first", second, "blocked", "missing-extension", "pi-extended-teams"];
    explicitSettings.extensions.block = ["blocked"];
    const explicit = createSpawnResourcePlan({ cwd: root, projectTrusted: true, settings: explicitSettings, leadExtensions });
    expect(explicit.extensionPaths).toEqual([first, second]);
    expect(explicit.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "blocked-selection", configuredEntry: "blocked" }),
      expect.objectContaining({ code: "stale-selection", configuredEntry: "missing-extension" }),
      expect.objectContaining({ code: "self-excluded", configuredEntry: "pi-extended-teams" }),
    ]));
    expect(Object.isFrozen(explicit)).toBe(true);
    expect(Object.isFrozen(explicit.extensionPaths)).toBe(true);
  });

  it("uses names when unique and paths when names collide", () => {
    const root = tempRoot();
    const first = touch(path.join(root, "a", "same", "index.ts"));
    const second = touch(path.join(root, "b", "same", "index.ts"));
    const unique = touch(path.join(root, "unique.ts"));
    const leadExtensions = snapshotLeadExtensions({
      getCommands: () => [
        { name: "one", source: "extension", sourceInfo: sourceInfo(first) },
        { name: "two", source: "extension", sourceInfo: sourceInfo(second) },
        { name: "three", source: "extension", sourceInfo: sourceInfo(unique) },
      ],
      getAllTools: () => [],
    });

    const plan = createSpawnResourcePlan({
      cwd: root,
      projectTrusted: false,
      settings: structuredClone(DEFAULT_SETTINGS),
      leadExtensions,
    });

    expect(plan.extensions.map((extension) => extension.selector)).toEqual([first, second, "unique"]);
  });

  it("keeps canonical selections stable when a same-name extension is later observed", () => {
    const root = tempRoot();
    const original = touch(path.join(root, "first", "same.ts"));
    const second = touch(path.join(root, "second", "same.ts"));
    const oneExtension = snapshotLeadExtensions({
      getCommands: () => [{ name: "first", source: "extension", sourceInfo: sourceInfo(original) }],
      getAllTools: () => [],
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.extensions.allow = [oneExtension[0]!.identity];

    const rebuilt = snapshotLeadExtensions({
      getCommands: () => [
        { name: "first", source: "extension", sourceInfo: sourceInfo(original) },
        { name: "second", source: "extension", sourceInfo: sourceInfo(second) },
      ],
      getAllTools: () => [],
    });
    const canonical = createSpawnResourcePlan({ cwd: root, projectTrusted: true, settings, leadExtensions: rebuilt });
    expect(canonical.extensionPaths).toEqual([original]);

    const legacySettings = structuredClone(DEFAULT_SETTINGS);
    legacySettings.extensions.allow = ["same"];
    const legacy = createSpawnResourcePlan({ cwd: root, projectTrusted: true, settings: legacySettings, leadExtensions: rebuilt });
    expect(legacy.extensionPaths).toEqual([original, second]);
  });

  it("matches canonical and symlink entries while blocks always override allow", () => {
    const root = tempRoot();
    const extension = touch(path.join(root, "extension.ts"));
    const extensionLink = path.join(root, "extension-link.ts");
    fs.symlinkSync(extension, extensionLink);
    const leadExtensions = snapshotLeadExtensions({
      getCommands: () => [{ name: "extension", source: "extension", sourceInfo: sourceInfo(extension) }],
      getAllTools: () => [],
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.extensions.allow = [leadExtensions[0]!.identity];
    settings.extensions.block = [extensionLink];

    const plan = createSpawnResourcePlan({ cwd: root, projectTrusted: true, settings, leadExtensions });
    expect(plan.extensionPaths).toEqual([]);
    expect(plan.extensions[0]?.state).toBe("blocked");
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ code: "blocked-selection", configuredEntry: leadExtensions[0]!.identity }),
    ]);
  });

  it("never transfers project trust across cwd", () => {
    const root = tempRoot();
    const project = path.join(root, "project");
    const ctx = { cwd: project, isProjectTrusted: () => true };

    expect(parentProjectTrustForSpawn(ctx, project)).toBe(true);
    expect(parentProjectTrustForSpawn(ctx, path.join(root, "other-project"))).toBe(false);
    expect(parentProjectTrustForSpawn({ cwd: project }, project)).toBe(false);
  });
});
