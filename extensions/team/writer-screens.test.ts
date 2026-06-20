import { afterEach, describe, expect, it, vi } from "vitest";
import { createWriterScreenState, cycleWriterScreen, upsertWriterScreenTab } from "./writer-screens.js";
import * as teams from "../../src/utils/teams.js";

function ignorePersistedTeamConfig() {
  vi.spyOn(teams, "readConfig").mockRejectedValue(new Error("not found"));
}

describe("writer screen cycling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cycles extension-owned writer tabs without reading the current tmux pane", async () => {
    ignorePersistedTeamConfig();
    const state = createWriterScreenState();
    upsertWriterScreenTab(state, { teamName: "team", name: "writer-1", paneId: "%1", windowId: "@1", joinedAt: 1 });
    upsertWriterScreenTab(state, { teamName: "team", name: "writer-2", paneId: "%2", windowId: "@2", joinedAt: 2 });

    const terminal = {
      getCurrentPaneId: vi.fn(() => "%lead"),
      isAlive: vi.fn(() => true),
      focusPane: vi.fn((_paneId: string) => true),
    };

    await expect(cycleWriterScreen("team", terminal, state)).resolves.toMatchObject({ ok: true, target: { name: "writer-1", paneId: "%1" } });
    await expect(cycleWriterScreen("team", terminal, state)).resolves.toMatchObject({ ok: true, target: { name: "writer-2", paneId: "%2" } });

    expect(terminal.focusPane.mock.calls.map(([paneId]) => paneId)).toEqual(["%1", "%2"]);
    expect(terminal.getCurrentPaneId).not.toHaveBeenCalled();
  });

  it("prunes dead writer tabs before cycling", async () => {
    ignorePersistedTeamConfig();
    const state = createWriterScreenState();
    upsertWriterScreenTab(state, { teamName: "team", name: "gone", paneId: "%gone" });
    upsertWriterScreenTab(state, { teamName: "team", name: "writer", paneId: "%1" });

    const terminal = {
      isAlive: vi.fn((paneId: string) => paneId !== "%gone"),
      focusPane: vi.fn((_paneId: string) => true),
    };

    const result = await cycleWriterScreen("team", terminal, state);

    expect(result).toMatchObject({ ok: true, target: { name: "writer", paneId: "%1" } });
    expect(state.activeWritersTabs.map(tab => tab.paneId)).toEqual(["%1"]);
    expect(terminal.focusPane).toHaveBeenCalledWith("%1");
  });
});
