import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import {
  clearGlobalFavoriteModels,
  FAVORITE_MODEL_SLOTS,
  globalSettingsPath,
  isFavoriteModelSlot,
  loadSettings,
  replaceGlobalFavoriteModels,
  setGlobalFavoriteModel,
  THINKING_LEVEL_NAMES,
  type FavoriteModelSlot,
  type FavoriteModelConfig,
} from "../../src/utils/settings";
import { normalizeQualifiedModel } from "../../src/utils/model-resolution";
import { getAvailableModels } from "../internal/model-selection";

interface AvailableModelOption {
  provider: string;
  model: string;
  qualified: string;
}

type FavoriteModelsDraft = Partial<Record<FavoriteModelSlot, FavoriteModelConfig>>;
type PickerColumn = "slots" | "models" | "thinking";

const DEFAULT_THINKING_BY_SLOT: Record<FavoriteModelSlot, string> = {
  "reading-fast": "low",
  "reading-default": "high",
  "reading-hard": "xhigh",
  "writing-basic": "high",
  "writing-hard": "xhigh",
};

const COLUMNS: PickerColumn[] = ["slots", "models", "thinking"];

function formatSlot(slot: FavoriteModelSlot, config?: FavoriteModelConfig): string {
  if (!config?.model || !config.thinking) return `- ${slot}: (empty)`;
  return `- ${slot}: ${config.model} · ${config.thinking}`;
}

function usage(): string {
  return [
    "Usage:",
    "  /agents-favorite-models",
    "  /agents-favorite-models set <slot> <provider/model> <thinking>",
    "  /agents-favorite-models clear <slot>",
    "  /agents-favorite-models clear",
    "",
    `Slots: ${FAVORITE_MODEL_SLOTS.join(", ")}`,
    `Thinking: ${THINKING_LEVEL_NAMES.join(", ")}`,
  ].join("\n");
}

function formatCurrentSettings(homeDir?: string): string {
  const settings = loadSettings({ homeDir });
  return [
    "Agent favorite models:",
    ...FAVORITE_MODEL_SLOTS.map((slot) => formatSlot(slot, settings.favoriteModels[slot])),
    "",
    usage(),
    "",
    `Saved in: ${globalSettingsPath(homeDir)}`,
  ].join("\n");
}

function normalizeSlot(raw: string | undefined): FavoriteModelSlot {
  if (!isFavoriteModelSlot(raw)) {
    throw new Error(`Unknown slot "${raw ?? ""}". Use one of: ${FAVORITE_MODEL_SLOTS.join(", ")}.`);
  }
  return raw;
}

function normalizeThinking(raw: string | undefined): string {
  if (!raw || !(THINKING_LEVEL_NAMES as readonly string[]).includes(raw)) {
    throw new Error(`Invalid thinking level "${raw ?? ""}". Use one of: ${THINKING_LEVEL_NAMES.join(", ")}.`);
  }
  return raw;
}

function normalizeModel(raw: string | undefined): string {
  const normalized = raw ? normalizeQualifiedModel(raw) : null;
  if (!normalized) {
    throw new Error("Model must be a fully qualified provider/model string.");
  }
  return normalized;
}

function formatQualifiedModel(model: { provider: string; model: string }): string {
  return `${model.provider}/${model.model}`;
}

function sortAvailableModels(models: Array<{ provider: string; model: string }>): AvailableModelOption[] {
  return models
    .map((model) => ({ ...model, qualified: formatQualifiedModel(model) }))
    .sort((a, b) => a.qualified.localeCompare(b.qualified));
}

function cloneFavoriteModels(input: FavoriteModelsDraft): FavoriteModelsDraft {
  const draft: FavoriteModelsDraft = {};
  for (const slot of FAVORITE_MODEL_SLOTS) {
    const config = input[slot];
    if (!config?.model || !config.thinking) continue;
    draft[slot] = { model: config.model, thinking: config.thinking };
  }
  return draft;
}

function padToWidth(value: string, width: number): string {
  const truncated = truncateToWidth(value, width, "…", true);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function styledTitle(theme: any, label: string, active: boolean): string {
  const title = active ? `▶ ${label}` : `  ${label}`;
  return active ? theme.fg("accent", theme.bold(title)) : theme.fg("muted", title);
}

function defaultTheme(theme: any) {
  return {
    accent: (value: string) => theme.fg("accent", value),
    dim: (value: string) => theme.fg("dim", value),
    warning: (value: string) => theme.fg("warning", value),
    success: (value: string) => theme.fg("success", value),
    bold: (value: string) => theme.bold(value),
  };
}

async function loadScopedModels(ctx: any): Promise<AvailableModelOption[]> {
  return sortAvailableModels(await getAvailableModels(ctx));
}

async function showFavoriteModelsPicker(ctx: any): Promise<"saved" | "cancelled" | undefined> {
  const availableModels = await loadScopedModels(ctx);
  const availableSet = new Set(availableModels.map((model) => model.qualified));
  const draft = cloneFavoriteModels(loadSettings().favoriteModels);

  return ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value: "saved" | "cancelled") => void) => {
    const colors = defaultTheme(theme);
    let selectedSlotIndex = 0;
    let activeColumnIndex = 0;
    let modelFilter = "";
    let modelScroll = 0;
    let notice: string | undefined;

    const activeColumn = () => COLUMNS[activeColumnIndex];
    const selectedSlot = () => FAVORITE_MODEL_SLOTS[selectedSlotIndex];
    const selectedConfig = () => draft[selectedSlot()];
    const filteredModels = () => {
      const filter = modelFilter.trim().toLowerCase();
      if (!filter) return availableModels;
      return availableModels.filter((model) => model.qualified.toLowerCase().includes(filter));
    };

    const ensureModelVisible = (modelRows: number) => {
      const models = filteredModels();
      const currentModel = selectedConfig()?.model;
      const selectedModelIndex = Math.max(0, models.findIndex((model) => model.qualified === currentModel));
      if (selectedModelIndex < modelScroll) modelScroll = selectedModelIndex;
      if (selectedModelIndex >= modelScroll + modelRows) modelScroll = selectedModelIndex - modelRows + 1;
      modelScroll = Math.max(0, Math.min(modelScroll, Math.max(0, models.length - modelRows)));
    };

    const setModelByDelta = (delta: number) => {
      const models = filteredModels();
      if (models.length === 0) return;
      const slot = selectedSlot();
      const currentModel = draft[slot]?.model;
      const currentIndex = models.findIndex((model) => model.qualified === currentModel);
      const nextIndex = Math.max(0, Math.min(models.length - 1, (currentIndex >= 0 ? currentIndex : delta > 0 ? -1 : models.length) + delta));
      const currentThinking = draft[slot]?.thinking ?? DEFAULT_THINKING_BY_SLOT[slot];
      draft[slot] = { model: models[nextIndex].qualified, thinking: currentThinking };
      notice = undefined;
    };

    const setThinkingByDelta = (delta: number) => {
      const slot = selectedSlot();
      if (!draft[slot]?.model) {
        notice = `Pick a scoped model for ${slot} before choosing thinking.`;
        return;
      }
      const currentThinking = draft[slot]?.thinking ?? DEFAULT_THINKING_BY_SLOT[slot];
      const currentIndex = Math.max(0, THINKING_LEVEL_NAMES.findIndex((thinking) => thinking === currentThinking));
      const nextIndex = Math.max(0, Math.min(THINKING_LEVEL_NAMES.length - 1, currentIndex + delta));
      draft[slot] = {
        model: draft[slot]?.model ?? null,
        thinking: THINKING_LEVEL_NAMES[nextIndex],
      };
      notice = undefined;
    };

    const clearSelectedSlot = () => {
      delete draft[selectedSlot()];
      notice = undefined;
    };

    const clearAllSlots = () => {
      for (const slot of FAVORITE_MODEL_SLOTS) delete draft[slot];
      notice = undefined;
    };

    const saveAndClose = () => {
      replaceGlobalFavoriteModels(draft);
      done("saved");
    };

    const moveColumn = (delta: number) => {
      activeColumnIndex = Math.max(0, Math.min(COLUMNS.length - 1, activeColumnIndex + delta));
    };

    const moveActiveSelection = (delta: number) => {
      if (activeColumn() === "slots") {
        selectedSlotIndex = Math.max(0, Math.min(FAVORITE_MODEL_SLOTS.length - 1, selectedSlotIndex + delta));
        return;
      }
      if (activeColumn() === "models") {
        setModelByDelta(delta);
        return;
      }
      setThinkingByDelta(delta);
    };

    const modelRowsForTerminal = () => Math.max(5, Math.min(14, (tui.terminal?.rows ?? 24) - 13));

    const buildSlotRows = (): string[] => {
      return FAVORITE_MODEL_SLOTS.map((slot, index) => {
        const config = draft[slot];
        const selected = index === selectedSlotIndex;
        const pointer = selected ? "›" : " ";
        const model = config?.model ?? "empty";
        const thinking = config?.thinking ?? "unset";
        const unavailable = config?.model && !availableSet.has(config.model) ? " !unavailable" : "";
        return `${pointer} ${slot}  ${model} · ${thinking}${unavailable}`;
      });
    };

    const buildModelRows = (rowCount: number): string[] => {
      const models = filteredModels();
      ensureModelVisible(rowCount);
      if (models.length === 0) return [modelFilter ? "No scoped models match the filter." : "No scoped models available."];

      const currentModel = selectedConfig()?.model;
      const window = models.slice(modelScroll, modelScroll + rowCount);
      const rows = window.map((model) => {
        const selected = model.qualified === currentModel;
        return `${selected ? "›" : " "} ${model.qualified}`;
      });
      if (modelScroll > 0) rows.unshift(`… ${modelScroll} more above`);
      const below = models.length - modelScroll - window.length;
      if (below > 0) rows.push(`… ${below} more below`);
      return rows;
    };

    const buildThinkingRows = (): string[] => {
      const currentThinking = selectedConfig()?.thinking;
      return THINKING_LEVEL_NAMES.map((thinking) => `${thinking === currentThinking ? "›" : " "} ${thinking}`);
    };

    const columnRows = (title: string, rows: string[], width: number, active: boolean): string[] => {
      return [styledTitle(theme, title, active), ...rows].map((row) => padToWidth(row, width));
    };

    const render = (width: number): string[] => {
      const innerWidth = Math.max(1, width);
      const thinkingWidth = 16;
      const slotWidth = Math.max(28, Math.floor(innerWidth * 0.38));
      const modelWidth = Math.max(28, innerWidth - slotWidth - thinkingWidth - 6);
      const modelRowCount = modelRowsForTerminal();
      const slotRows = columnRows("slots", buildSlotRows(), slotWidth, activeColumn() === "slots");
      const modelRows = columnRows(
        `scoped models${modelFilter ? ` /${modelFilter}` : ""}`,
        buildModelRows(modelRowCount),
        modelWidth,
        activeColumn() === "models",
      );
      const thinkingRows = columnRows("thinking", buildThinkingRows(), thinkingWidth, activeColumn() === "thinking");
      const bodyRows = Math.max(slotRows.length, modelRows.length, thinkingRows.length);
      const lines = [
        colors.accent(colors.bold("Agent favorite models")),
        colors.dim(`${availableModels.length} scoped model(s) available from this Pi session · saves to ${globalSettingsPath()}`),
        colors.dim("←/→ or tab: move columns · ↑/↓: change selection · type while in scoped models to filter"),
        colors.dim("enter: save · esc: cancel · delete: clear selected slot · ctrl+a: clear all"),
        "",
      ];

      for (let index = 0; index < bodyRows; index += 1) {
        lines.push(`${slotRows[index] ?? " ".repeat(slotWidth)} │ ${modelRows[index] ?? " ".repeat(modelWidth)} │ ${thinkingRows[index] ?? ""}`);
      }

      const config = selectedConfig();
      lines.push("");
      lines.push(colors.dim(`Selected ${selectedSlot()}: ${config?.model ?? "empty"} · ${config?.thinking ?? "unset"}`));
      if (notice) {
        lines.push(colors.warning(notice));
      }
      if (config?.model && !availableSet.has(config.model)) {
        lines.push(colors.warning("This saved model is not in the scoped model list for the current session."));
      }
      if (activeColumn() === "models" && modelFilter) {
        lines.push(colors.dim(`Filter: ${modelFilter}  (backspace clears characters)`));
      }

      return lines.flatMap((line) => wrapTextWithAnsi(line, innerWidth));
    };

    const handleInput = (data: string) => {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        done("cancelled");
        return;
      }
      if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
        saveAndClose();
        return;
      }
      if (activeColumn() !== "models" && (data === "q" || data === "Q")) {
        done("cancelled");
        return;
      }
      if (matchesKey(data, Key.right) || data === "l" || data === "L" || matchesKey(data, Key.tab)) {
        moveColumn(1);
      } else if (matchesKey(data, Key.left) || data === "h" || data === "H" || matchesKey(data, Key.shift("tab"))) {
        moveColumn(-1);
      } else if (matchesKey(data, Key.down) || (activeColumn() !== "models" && (data === "j" || data === "J"))) {
        moveActiveSelection(1);
      } else if (matchesKey(data, Key.up) || (activeColumn() !== "models" && (data === "k" || data === "K"))) {
        moveActiveSelection(-1);
      } else if (matchesKey(data, Key.delete)) {
        clearSelectedSlot();
      } else if (matchesKey(data, Key.ctrl("a"))) {
        clearAllSlots();
      } else if (activeColumn() === "models" && matchesKey(data, Key.backspace)) {
        modelFilter = modelFilter.slice(0, -1);
        modelScroll = 0;
      } else if (activeColumn() === "models" && data.length === 1 && data.charCodeAt(0) >= 32) {
        modelFilter += data;
        modelScroll = 0;
      }
      tui.requestRender();
    };

    return { render, invalidate() {}, handleInput };
  }, {
    overlay: true,
    overlayOptions: { width: "94%", maxHeight: "86%", anchor: "center" },
  });
}

export function registerFavoriteModelsCommand(pi: any): void {
  pi.registerCommand("agents-favorite-models", {
    description: "View or configure favorite model/thinking slots for spawned agents.",
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0];

      try {
        if (!action) {
          if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
            const result = await showFavoriteModelsPicker(ctx);
            if (result === "saved") ctx.ui.notify("Agent favorite models saved.", "info");
            return;
          }
          ctx.ui.notify(formatCurrentSettings(), "info");
          return;
        }

        if (action === "set") {
          if (parts.length !== 4) throw new Error(`Expected: set <slot> <provider/model> <thinking>.\n${usage()}`);
          const slot = normalizeSlot(parts[1]);
          const model = normalizeModel(parts[2]);
          const thinking = normalizeThinking(parts[3]);
          setGlobalFavoriteModel(slot, { model, thinking });
          ctx.ui.notify(`Set ${slot} to ${model} · ${thinking}.`, "info");
          return;
        }

        if (action === "clear") {
          if (parts.length > 2) throw new Error(`Expected: clear [slot].\n${usage()}`);
          if (parts[1]) {
            const slot = normalizeSlot(parts[1]);
            clearGlobalFavoriteModels({ slot });
            ctx.ui.notify(`Cleared ${slot}.`, "info");
          } else {
            clearGlobalFavoriteModels();
            ctx.ui.notify("Cleared all agent favorite model slots.", "info");
          }
          return;
        }

        throw new Error(`Unknown action "${action}".\n${usage()}`);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });
}
