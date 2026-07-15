import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Text,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import {
  globalSettingsPath,
  loadSettings,
  readProjectExtensionAllowOverride,
  replaceGlobalExtensionAllow,
  type PiExtendedTeamsSettings,
} from "../../src/utils/settings";
import {
  createSpawnResourcePlan,
  EXTENSIONS_COMMAND_DESCRIPTION,
  parentProjectTrustForSpawn,
  type SpawnExtensionCandidate,
  type SpawnResourcePlan,
} from "../resources/spawn-resource-plan";

const MODE_SETTING_ID = "__selection_mode__";

interface ExtensionPickerResult {
  mode: "default" | "explicit";
  selectedIdentities: readonly string[];
}

export interface ExtensionsCommandOptions {
  createResourcePlan?(
    options: Parameters<typeof createSpawnResourcePlan>[0],
  ): ReturnType<typeof createSpawnResourcePlan> | Promise<ReturnType<typeof createSpawnResourcePlan>>;
  loadTeamsSettings?: typeof loadSettings;
  saveAllow?: typeof replaceGlobalExtensionAllow;
  readProjectExtensionAllowOverride?: typeof readProjectExtensionAllowOverride;
  getGlobalSettingsPath?: typeof globalSettingsPath;
}

function provenanceLabel(extension: SpawnExtensionCandidate): string {
  const sourceInfo = extension.sourceInfo;
  return [sourceInfo.scope, sourceInfo.origin, sourceInfo.source].filter(Boolean).join(" · ");
}

function displayLabel(extension: SpawnExtensionCandidate): string {
  const normalized = extension.path.replace(/\\/g, "/");
  const base = normalized.split("/").pop() || normalized;
  if (/^index\.(?:ts|js|mjs|cjs)$/.test(base)) {
    return normalized.split("/").at(-2) || normalized;
  }
  return base;
}

function stateLabel(extension: SpawnExtensionCandidate): string {
  switch (extension.state) {
    case "selected": return "enabled";
    case "available": return "disabled";
    case "blocked": return "blocked";
    case "self": return "internal";
  }
}

function preservedConfiguredEntries(plan: SpawnResourcePlan): string[] {
  const preservedCodes = new Set(["stale-selection", "blocked-selection"]);
  return plan.diagnostics.flatMap((diagnostic) => {
    return diagnostic.configuredEntry && preservedCodes.has(diagnostic.code)
      ? [diagnostic.configuredEntry]
      : [];
  });
}

export function explicitAllowFromPicker(
  plan: SpawnResourcePlan,
  result: ExtensionPickerResult,
): string[] | null {
  if (result.mode === "default") return null;
  const selected = new Set(result.selectedIdentities);
  return Array.from(new Set([
    ...plan.extensions
      .filter((extension) => selected.has(extension.identity) && (extension.state === "selected" || extension.state === "available"))
      .map((extension) => extension.identity),
    ...preservedConfiguredEntries(plan),
  ]));
}

export function formatExtensionsPlan(plan: SpawnResourcePlan): string {
  const lines = [
    "Agent extensions",
    "Skills use normal Pi discovery and trust. pi-extended-teams is handled internally.",
    "Visibility: Pi exposes sourceInfo for registered commands/tools; event-only extensions cannot be propagated.",
    `Selection: ${plan.selectionMode === "default" ? "default (all observable loaded)" : "explicit"}`,
    "",
  ];
  for (const extension of plan.extensions) {
    lines.push(`- ${stateLabel(extension)} · ${displayLabel(extension)} · ${provenanceLabel(extension)}`);
    lines.push(`  ${extension.path}`);
  }
  for (const diagnostic of plan.diagnostics) lines.push(`! ${diagnostic.message}`);
  return lines.join("\n");
}

async function showExtensionsPicker(
  ctx: any,
  plan: SpawnResourcePlan,
): Promise<ExtensionPickerResult | null> {
  return ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: ExtensionPickerResult | null) => void) => {
    let mode = plan.selectionMode;
    const selectedIdentities = new Set(
      plan.extensions.filter((extension) => extension.selected).map((extension) => extension.identity),
    );
    const candidateByItemId = new Map<string, SpawnExtensionCandidate>();
    const itemIdByIdentity = new Map<string, string>();

    const items: SettingItem[] = [{
      id: MODE_SETTING_ID,
      label: "Selection policy",
      currentValue: mode,
      values: ["default", "explicit"],
      description: "default follows all observable loaded Pi extensions; explicit uses only saved choices",
    }];
    plan.extensions.forEach((extension, index) => {
      const id = `extension:${index}`;
      candidateByItemId.set(id, extension);
      itemIdByIdentity.set(extension.identity, id);
      const selectable = extension.state === "selected" || extension.state === "available";
      items.push({
        id,
        label: displayLabel(extension),
        currentValue: stateLabel(extension),
        values: selectable ? ["enabled", "disabled"] : undefined,
        description: `${provenanceLabel(extension)} · ${extension.path}`,
      });
    });
    plan.diagnostics.forEach((diagnostic, index) => {
      if (!diagnostic.configuredEntry) return;
      items.push({
        id: `diagnostic:${index}`,
        label: diagnostic.configuredEntry,
        currentValue: diagnostic.code === "stale-selection" ? "missing" : "unavailable",
        description: diagnostic.message,
      });
    });

    const container = new Container();
    container.addChild(new Text([
      theme.fg("accent", theme.bold("Agent extension selection")),
      theme.fg("dim", "Skills use normal Pi discovery and trust. pi-extended-teams is handled internally."),
      theme.fg("dim", `ctrl+s: save explicit choices · esc: cancel · ${globalSettingsPath()}`),
      "",
    ].join("\n"), 1, 0));

    let settingsList: SettingsList;
    const refreshValues = () => {
      settingsList.updateValue(MODE_SETTING_ID, mode);
      for (const extension of plan.extensions) {
        const id = itemIdByIdentity.get(extension.identity);
        if (!id || (extension.state !== "selected" && extension.state !== "available")) continue;
        settingsList.updateValue(id, selectedIdentities.has(extension.identity) ? "enabled" : "disabled");
      }
    };
    settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 18),
      getSettingsListTheme(),
      (id, newValue) => {
        if (id === MODE_SETTING_ID) {
          mode = newValue === "default" ? "default" : "explicit";
          if (mode === "default") {
            for (const extension of plan.extensions) {
              if (extension.state !== "blocked" && extension.state !== "self") {
                selectedIdentities.add(extension.identity);
              }
            }
          }
          refreshValues();
          return;
        }
        const extension = candidateByItemId.get(id);
        if (!extension) return;
        mode = "explicit";
        if (newValue === "enabled") selectedIdentities.add(extension.identity);
        else selectedIdentities.delete(extension.identity);
        refreshValues();
      },
      () => done(null),
      { enableSearch: true },
    );
    container.addChild(settingsList);

    return {
      render(width: number) {
        return container.render(width).map((line) => truncateToWidth(line, width));
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("s"))) {
          done({ mode, selectedIdentities: [...selectedIdentities] });
          return;
        }
        settingsList.handleInput(data);
        tui.requestRender();
      },
    };
  }, {
    overlay: true,
    overlayOptions: { width: "92%", maxHeight: "88%", anchor: "center" },
  });
}

export function registerExtensionsCommand(pi: any, options: ExtensionsCommandOptions = {}): void {
  const createResourcePlan = options.createResourcePlan ?? createSpawnResourcePlan;
  const loadTeamsSettings = options.loadTeamsSettings ?? loadSettings;
  const saveAllow = options.saveAllow ?? replaceGlobalExtensionAllow;
  const readProjectOverride = options.readProjectExtensionAllowOverride ?? readProjectExtensionAllowOverride;
  const getGlobalSettingsPath = options.getGlobalSettingsPath ?? globalSettingsPath;

  const savePolicy = (allow: string[] | null, ctx: any, successMessage: string): void => {
    const projectTrusted = parentProjectTrustForSpawn(ctx, ctx.cwd);
    const projectOverride = projectTrusted ? readProjectOverride(ctx.cwd) : null;
    saveAllow(allow);
    if (projectOverride) {
      ctx.ui.notify(
        `Global spawned-agent extension policy was saved to ${getGlobalSettingsPath()}. The trusted project override at ${projectOverride.filePath} remains authoritative for spawned agents in this project.`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(successMessage, "info");
  };

  pi.registerCommand("agents-extensions", {
    description: EXTENSIONS_COMMAND_DESCRIPTION,
    handler: async (args: string, ctx: any) => {
      try {
        const action = args.trim().toLowerCase();
        if (action === "default") {
          savePolicy(null, ctx, "Spawned agents now follow all effective enabled Pi extensions.");
          return;
        }
        if (action === "none") {
          savePolicy([], ctx, "Spawned agents will load no external extensions. Skills remain enabled.");
          return;
        }
        if (action && action !== "list") {
          throw new Error("Usage: /agents-extensions [list|default|none]");
        }

        const projectTrusted = parentProjectTrustForSpawn(ctx, ctx.cwd);
        const settings: PiExtendedTeamsSettings = loadTeamsSettings({
          projectDir: projectTrusted ? ctx.cwd : undefined,
        });
        const plan = await createResourcePlan({
          cwd: ctx.cwd,
          projectTrusted,
          settings,
          pi,
        });
        if (action === "list" || ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
          ctx.ui.notify(formatExtensionsPlan(plan), "info");
          return;
        }

        const result = await showExtensionsPicker(ctx, plan);
        if (!result) return;
        savePolicy(
          explicitAllowFromPicker(plan, result),
          ctx,
          result.mode === "default"
            ? "Spawned-agent extensions reset to default."
            : "Spawned-agent extension choices saved.",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });
}
