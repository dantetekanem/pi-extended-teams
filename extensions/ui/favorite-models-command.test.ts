import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerFavoriteModelsCommand } from "./favorite-models-command.js";
import { globalSettingsPath } from "../../src/utils/settings";

let homeDir: string;

function setupCommand() {
  const commands = new Map<string, any>();
  const pi = { registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)) };
  registerFavoriteModelsCommand(pi);
  const ctx = { ui: { notify: vi.fn() } };
  return { commands, ctx, pi };
}

function testTheme() {
  return {
    fg: (_name: string, value: string) => value,
    bold: (value: string) => value,
  };
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-favorite-models-"));
  vi.spyOn(os, "homedir").mockReturnValue(homeDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("/agents-favorite-models", () => {
  it("registers and displays empty slots", async () => {
    const { commands, ctx } = setupCommand();

    await commands.get("agents-favorite-models").handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("reading-fast: (empty)"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Saved in:"), "info");
  });

  it("opens a single-screen picker with scoped available models and saves a slot", async () => {
    const { commands } = setupCommand();
    const notify = vi.fn();
    const requestRender = vi.fn();
    const custom = vi.fn(async (factory: any) => {
      let doneValue: "saved" | "cancelled" | undefined;
      const component = factory({ requestRender, terminal: { rows: 30 } }, testTheme(), {}, (value: "saved" | "cancelled") => {
        doneValue = value;
      });

      expect(component.render(120).join("\n")).toContain("provider/model");
      component.handleInput("l"); // focus scoped models
      component.handleInput("\x1b[B"); // select first scoped model for reading-fast
      component.handleInput("\r"); // save
      return doneValue;
    });
    const ctx = {
      mode: "tui",
      modelRegistry: {
        getAvailable: vi.fn(async () => [{ provider: "provider", id: "model" }]),
      },
      ui: { notify, custom },
    };

    await commands.get("agents-favorite-models").handler("", ctx);

    const raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels["reading-fast"]).toEqual({ model: "provider/model", thinking: "low" });
    expect(custom).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Agent favorite models saved.", "info");
  });

  it("does not save a thinking-only empty slot from the picker", async () => {
    const { commands } = setupCommand();
    const notify = vi.fn();
    const custom = vi.fn(async (factory: any) => {
      let doneValue: "saved" | "cancelled" | undefined;
      const component = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, testTheme(), {}, (value: "saved" | "cancelled") => {
        doneValue = value;
      });

      component.handleInput("l");
      component.handleInput("l"); // focus thinking with no model selected
      component.handleInput("\x1b[B");
      expect(component.render(120).join("\n")).toContain("Pick a scoped model for reading-fast before choosing thinking.");
      component.handleInput("\r");
      return doneValue;
    });
    const ctx = {
      mode: "tui",
      modelRegistry: {
        getAvailable: vi.fn(async () => [{ provider: "provider", id: "model" }]),
      },
      ui: { notify, custom },
    };

    await commands.get("agents-favorite-models").handler("", ctx);

    const raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels).toEqual({});
  });

  it("sets and clears favorite model slots", async () => {
    const { commands, ctx } = setupCommand();
    const command = commands.get("agents-favorite-models");

    await command.handler("set reading-fast provider/model low", ctx);

    let raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels["reading-fast"]).toEqual({ model: "provider/model", thinking: "low" });
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("Set reading-fast to provider/model · low.", "info");

    await command.handler("clear reading-fast", ctx);

    raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels).not.toHaveProperty("reading-fast");
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("Cleared reading-fast.", "info");
  });

  it("warns for invalid input without writing settings", async () => {
    const { commands, ctx } = setupCommand();

    await commands.get("agents-favorite-models").handler("set bad-slot provider/model low", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Unknown slot"), "warning");
    expect(fs.existsSync(globalSettingsPath(homeDir))).toBe(false);
  });
});
