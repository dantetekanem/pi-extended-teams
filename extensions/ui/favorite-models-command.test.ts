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
  const ctx = {
    modelRegistry: {
      getAvailable: vi.fn(async (): Promise<any[]> => [{ provider: "provider", id: "model", reasoning: true }]),
    },
    ui: { notify: vi.fn() },
  };
  return { commands, ctx, pi };
}

function testTheme() {
  return {
    fg: (_name: string, value: string) => value,
    bg: (_name: string, value: string) => value,
    bold: (value: string) => value,
    inverse: (value: string) => value,
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

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("read-collect: (empty)"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("write-critical: (empty)"), "info");
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
      component.handleInput("\x1b[C"); // focus scoped models
      component.handleInput("\x1b[B"); // select first scoped model for read-collect
      component.handleInput("\r"); // save
      return doneValue;
    });
    const ctx = {
      mode: "tui",
      modelRegistry: {
        getAvailable: vi.fn(async () => [{ provider: "provider", id: "model", reasoning: true }]),
      },
      ui: { notify, custom },
    };

    await commands.get("agents-favorite-models").handler("", ctx);

    const raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels["read-collect"]).toEqual({ model: "provider/model", thinking: "high" });
    expect(custom).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Agent favorite models saved.", "info");
  });

  it.each(["claude", "HIGH", "llama", "jkq"])("filters model names with %s without navigating or matching providers", async query => {
    const { commands, ctx } = setupCommand();
    const modelName = query.toLowerCase();
    ctx.modelRegistry.getAvailable.mockResolvedValue([
      { provider: modelName, id: "unrelated", reasoning: true },
      { provider: "z-provider", id: modelName, reasoning: true },
    ]);
    const closed = vi.fn();
    const custom = async (factory: any) => {
      const component = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, testTheme(), {}, closed);
      component.handleInput("\x1b[C");
      for (const character of `${query}x`) component.handleInput(character);
      component.handleInput("\x7f");
      component.handleInput("\x1b[B");
      component.handleInput("\r");
      return closed.mock.lastCall?.[0];
    };
    await commands.get("agents-favorite-models").handler("", { ...ctx, mode: "tui", ui: { ...ctx.ui, custom } });
    expect(closed).toHaveBeenCalledExactlyOnceWith("saved");
    const raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels).toEqual({ "read-collect": { model: `z-provider/${modelName}`, thinking: "high" } });
  });

  it("uses only arrows to navigate blocks and selections before saving", async () => {
    const { commands, ctx } = setupCommand();
    const closed = vi.fn();
    const custom = async (factory: any) => {
      const component = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, testTheme(), {}, closed);
      for (const key of ["j", "l", "q", "k", "h", "Q", "J", "K", "L", "H", "\t"]) component.handleInput(key);
      component.handleInput("\x1b[C"); // models
      component.handleInput("\x1b[B"); // first model
      component.handleInput("\x1b[Z"); // shift-tab does not move focus
      component.handleInput("\x1b[C"); // thinking
      component.handleInput("\x1b[A"); // high -> medium
      for (const key of ["j", "k", "h", "l", "q", "Q"]) component.handleInput(key);
      component.handleInput("\x1b[D"); // models
      component.handleInput("\x1b[D"); // slots
      component.handleInput("\x1b[B"); // read-review
      component.handleInput("\x1b[C"); // models
      component.handleInput("\x1b[B");
      component.handleInput("\r");
      return closed.mock.lastCall?.[0];
    };
    await commands.get("agents-favorite-models").handler("", { ...ctx, mode: "tui", ui: { ...ctx.ui, custom } });
    expect(closed).toHaveBeenCalledExactlyOnceWith("saved");
    const raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels).toEqual({
      "read-collect": { model: "provider/model", thinking: "medium" },
      "read-review": { model: "provider/model", thinking: "high" },
    });
  });

  it("applies the calibrated thinking default for all eight canonical tiers", async () => {
    const { commands } = setupCommand();
    const custom = vi.fn(async (factory: any) => {
      let doneValue: "saved" | "cancelled" | undefined;
      const component = factory(
        { requestRender: vi.fn(), terminal: { rows: 30 } },
        testTheme(),
        {},
        (value: "saved" | "cancelled") => { doneValue = value; },
      );

      component.handleInput("\x1b[C");
      for (let index = 0; index < 8; index += 1) {
        component.handleInput("\x1b[B");
        if (index < 7) {
          component.handleInput("\x1b[D");
          component.handleInput("\x1b[B");
          component.handleInput("\x1b[C");
        }
      }
      component.handleInput("\r");
      return doneValue;
    });
    const ctx = {
      mode: "tui",
      modelRegistry: {
        getAvailable: vi.fn(async () => [{
          provider: "provider",
          id: "model",
          reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        }]),
      },
      ui: { notify: vi.fn(), custom },
    };

    await commands.get("agents-favorite-models").handler("", ctx);

    const raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels).toEqual({
      "read-collect": { model: "provider/model", thinking: "high" },
      "read-review": { model: "provider/model", thinking: "xhigh" },
      "read-analyze": { model: "provider/model", thinking: "medium" },
      "read-critical": { model: "provider/model", thinking: "xhigh" },
      "write-patch": { model: "provider/model", thinking: "max" },
      "write-feature": { model: "provider/model", thinking: "medium" },
      "write-system": { model: "provider/model", thinking: "high" },
      "write-critical": { model: "provider/model", thinking: "max" },
    });
  });

  it("shows max only when the selected Pi model advertises it", async () => {
    const { commands } = setupCommand();
    const custom = vi.fn(async (factory: any) => {
      const component = factory(
        { requestRender: vi.fn(), terminal: { rows: 30 } },
        testTheme(),
        {},
        vi.fn(),
      );

      component.handleInput("\x1b[C");
      component.handleInput("\x1b[B");
      component.handleInput("\x1b[C");
      const rendered = component.render(120).join("\n");
      expect(rendered).toContain("  max");
      expect(rendered).not.toContain("  xhigh");
      return "cancelled";
    });
    const ctx = {
      mode: "tui",
      modelRegistry: {
        getAvailable: vi.fn(async () => [{
          provider: "provider",
          id: "max-model",
          reasoning: true,
          thinkingLevelMap: { max: "max", xhigh: null },
        }]),
      },
      ui: { notify: vi.fn(), custom },
    };

    await commands.get("agents-favorite-models").handler("", ctx);
  });

  it("hides opt-in levels that the selected Pi model does not advertise", async () => {
    const { commands } = setupCommand();
    const custom = vi.fn(async (factory: any) => {
      const component = factory(
        { requestRender: vi.fn(), terminal: { rows: 30 } },
        testTheme(),
        {},
        vi.fn(),
      );

      component.handleInput("\x1b[C");
      component.handleInput("\x1b[B");
      component.handleInput("\x1b[C");
      const rendered = component.render(120).join("\n");
      expect(rendered).not.toContain("  max");
      expect(rendered).not.toContain("  xhigh");
      return "cancelled";
    });
    const ctx = {
      mode: "tui",
      modelRegistry: {
        getAvailable: vi.fn(async () => [{ provider: "provider", id: "standard-model", reasoning: true }]),
      },
      ui: { notify: vi.fn(), custom },
    };

    await commands.get("agents-favorite-models").handler("", ctx);
  });

  it("does not save a thinking-only empty slot from the picker", async () => {
    const { commands } = setupCommand();
    const notify = vi.fn();
    const custom = vi.fn(async (factory: any) => {
      let doneValue: "saved" | "cancelled" | undefined;
      const component = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, testTheme(), {}, (value: "saved" | "cancelled") => {
        doneValue = value;
      });

      component.handleInput("\x1b[C");
      component.handleInput("\x1b[C"); // focus thinking with no model selected
      component.handleInput("\x1b[B");
      expect(component.render(120).join("\n")).toContain("Pick a scoped model for read-collect before choosing thinking.");
      component.handleInput("\r");
      return doneValue;
    });
    const ctx = {
      mode: "tui",
      modelRegistry: {
        getAvailable: vi.fn(async () => [{ provider: "provider", id: "model", reasoning: true }]),
      },
      ui: { notify, custom },
    };

    await commands.get("agents-favorite-models").handler("", ctx);

    const raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels).toEqual({});
  });

  it("sets and clears canonical tiers while accepting legacy CLI aliases", async () => {
    const { commands, ctx } = setupCommand();
    const command = commands.get("agents-favorite-models");

    await command.handler("set reading-fast provider/model high", ctx);

    let raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels["read-collect"]).toEqual({ model: "provider/model", thinking: "high" });
    expect(raw.favoriteModels).not.toHaveProperty("reading-fast");
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("Set read-collect to provider/model · high.", "info");

    await command.handler("clear reading-fast", ctx);

    raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels).not.toHaveProperty("read-collect");
    expect(ctx.ui.notify).toHaveBeenLastCalledWith("Cleared read-collect.", "info");
  });

  it("accepts max only for a Pi model that advertises it", async () => {
    const { commands, ctx } = setupCommand();
    ctx.modelRegistry.getAvailable.mockResolvedValue([{
      provider: "provider",
      id: "max-model",
      reasoning: true,
      thinkingLevelMap: { max: "max" },
    }]);

    await commands.get("agents-favorite-models").handler("set read-critical provider/max-model max", ctx);

    const raw = JSON.parse(fs.readFileSync(globalSettingsPath(homeDir), "utf-8"));
    expect(raw.favoriteModels["read-critical"]).toEqual({ model: "provider/max-model", thinking: "max" });
  });

  it("rejects max when the Pi model does not advertise it", async () => {
    const { commands, ctx } = setupCommand();

    await commands.get("agents-favorite-models").handler("set read-critical provider/model max", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining('Thinking level "max" is not available for provider/model'),
      "warning",
    );
    expect(fs.existsSync(globalSettingsPath(homeDir))).toBe(false);
  });

  it("warns for invalid input without writing settings", async () => {
    const { commands, ctx } = setupCommand();

    await commands.get("agents-favorite-models").handler("set bad-slot provider/model low", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Unknown slot"), "warning");
    expect(fs.existsSync(globalSettingsPath(homeDir))).toBe(false);
  });
});
