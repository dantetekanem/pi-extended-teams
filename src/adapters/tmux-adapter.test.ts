/**
 * Tmux Adapter Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TmuxAdapter } from "./tmux-adapter";
import * as terminalAdapter from "../utils/terminal-adapter";

describe("TmuxAdapter", () => {
  let adapter: TmuxAdapter;
  let mockExecCommand: ReturnType<typeof vi.spyOn>;
  const originalTmux = process.env.TMUX;
  const originalTmuxPane = process.env.TMUX_PANE;

  beforeEach(() => {
    adapter = new TmuxAdapter();
    mockExecCommand = vi.spyOn(terminalAdapter, "execCommand");
    process.env.TMUX = "/tmp/tmux-1000/default,123,0";
    process.env.TMUX_PANE = "%16";
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;

    if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = originalTmuxPane;
  });

  it("should have the correct name", () => {
    expect(adapter.name).toBe("tmux");
  });

  it("should detect tmux when TMUX is set", () => {
    expect(adapter.detect()).toBe(true);
  });

  it("spawns a detached background window in the originating tmux session", () => {
    mockExecCommand.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "list-panes") {
        return { stdout: "%16\t@7\n", stderr: "", status: 0 };
      }

      if (args[0] === "new-window") {
        return { stdout: "%42", stderr: "", status: 0 };
      }

      return { stdout: "", stderr: "", status: 0 };
    });

    const paneId = adapter.spawn({
      name: "agent-1",
      cwd: "/tmp/project",
      command: "pi",
      env: { PI_TEAM_NAME: "team-1", PI_AGENT_NAME: "agent-1", OTHER: "ignored" },
    });

    expect(paneId).toBe("%42");
    expect(mockExecCommand).toHaveBeenCalledWith(
      "tmux",
      [
        "new-window",
        "-dP",
        "-F", "#{pane_id}",
        "-n", "agent-1",
        "-a", "-t", "@7",
        "-c", "/tmp/project",
        "env", "PI_TEAM_NAME=team-1", "PI_AGENT_NAME=agent-1",
        "sh", "-c", "pi",
      ]
    );
    expect(mockExecCommand).toHaveBeenCalledWith(
      "tmux",
      ["select-pane", "-t", "%42", "-T", "agent-1"]
    );
    expect(mockExecCommand).not.toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["select-layout"])
    );
  });

  it("should prefer an explicit anchor pane when spawning", () => {
    mockExecCommand.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "list-panes") {
        return { stdout: "%3\t@9\n%16\t@7\n", stderr: "", status: 0 };
      }

      if (args[0] === "new-window") {
        return { stdout: "%42", stderr: "", status: 0 };
      }

      return { stdout: "", stderr: "", status: 0 };
    });

    const paneId = adapter.spawn({
      name: "agent-1",
      cwd: "/tmp/project",
      command: "pi",
      env: { PI_TEAM_NAME: "team-1", PI_AGENT_NAME: "agent-1" },
      anchorPaneId: "%3",
    });

    expect(paneId).toBe("%42");
    expect(mockExecCommand).toHaveBeenCalledWith(
      "tmux",
      [
        "new-window",
        "-dP",
        "-F", "#{pane_id}",
        "-n", "agent-1",
        "-a", "-t", "@9",
        "-c", "/tmp/project",
        "env", "PI_TEAM_NAME=team-1", "PI_AGENT_NAME=agent-1",
        "sh", "-c", "pi",
      ]
    );
    expect(mockExecCommand).toHaveBeenCalledWith(
      "tmux",
      ["select-pane", "-t", "%42", "-T", "agent-1"]
    );
  });

  it("should fall back to the current pane when the explicit anchor is stale", () => {
    mockExecCommand.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "list-panes") {
        return { stdout: "%16\t@7\n", stderr: "", status: 0 };
      }

      if (args[0] === "new-window") {
        return { stdout: "%42", stderr: "", status: 0 };
      }

      return { stdout: "", stderr: "", status: 0 };
    });

    const paneId = adapter.spawn({
      name: "agent-1",
      cwd: "/tmp/project",
      command: "pi",
      env: { PI_TEAM_NAME: "team-1", PI_AGENT_NAME: "agent-1" },
      anchorPaneId: "%3",
    });

    expect(paneId).toBe("%42");
    expect(mockExecCommand).toHaveBeenCalledWith(
      "tmux",
      [
        "new-window",
        "-dP",
        "-F", "#{pane_id}",
        "-n", "agent-1",
        "-a", "-t", "@7",
        "-c", "/tmp/project",
        "env", "PI_TEAM_NAME=team-1", "PI_AGENT_NAME=agent-1",
        "sh", "-c", "pi",
      ]
    );
  });

  it("checks many pane liveness calls from one list-panes snapshot", () => {
    mockExecCommand.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "list-panes") {
        return { stdout: "%1\t@7\n%2\t@7\n", stderr: "", status: 0 };
      }

      return { stdout: "", stderr: "", status: 0 };
    });

    expect(adapter.isAlive("%1")).toBe(true);
    expect(adapter.isAlive("%2")).toBe(true);
    expect(adapter.isAlive("%3")).toBe(false);

    expect(mockExecCommand).toHaveBeenCalledTimes(1);
    expect(mockExecCommand).toHaveBeenCalledWith(
      "tmux",
      ["list-panes", "-a", "-F", "#{pane_id}\t#{window_id}"]
    );
  });

  it("refreshes the pane snapshot after the short TTL expires", () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mockExecCommand
      .mockReturnValueOnce({ stdout: "%1\t@7\n", stderr: "", status: 0 })
      .mockReturnValueOnce({ stdout: "%2\t@7\n", stderr: "", status: 0 });

    expect(adapter.isAlive("%1")).toBe(true);

    now = 1050;
    expect(adapter.isAlive("%2")).toBe(false);

    now = 1200;
    expect(adapter.isAlive("%2")).toBe(true);
    expect(mockExecCommand).toHaveBeenCalledTimes(2);
  });

  it("invalidates the cached pane snapshot after spawning", () => {
    let listPaneCalls = 0;
    mockExecCommand.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "list-panes") {
        listPaneCalls += 1;
        return {
          stdout: listPaneCalls === 1 ? "%16\t@7\n" : "%16\t@7\n%42\t@8\n",
          stderr: "",
          status: 0,
        };
      }

      if (args[0] === "new-window") {
        return { stdout: "%42", stderr: "", status: 0 };
      }

      return { stdout: "", stderr: "", status: 0 };
    });

    expect(adapter.isAlive("%16")).toBe(true);

    const paneId = adapter.spawn({
      name: "agent-1",
      cwd: "/tmp/project",
      command: "pi",
      env: { PI_TEAM_NAME: "team-1", PI_AGENT_NAME: "agent-1" },
    });

    expect(paneId).toBe("%42");
    expect(adapter.isAlive("%42")).toBe(true);
    expect(listPaneCalls).toBe(2);
  });

  it("falls back to display-message when list-panes is unavailable", () => {
    mockExecCommand.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "list-panes") {
        return { stdout: "", stderr: "tmux too old", status: 1 };
      }

      if (args[0] === "display-message") {
        return { stdout: "%42", stderr: "", status: 0 };
      }

      return { stdout: "", stderr: "", status: 0 };
    });

    expect(adapter.isAlive("%42")).toBe(true);
    expect(mockExecCommand).toHaveBeenCalledWith(
      "tmux",
      ["display-message", "-p", "-t", "%42", "#{pane_id}"]
    );
  });

  it("focuses a pane by selecting its window and pane", () => {
    mockExecCommand.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "list-panes") {
        return { stdout: "%42\t@9\n", stderr: "", status: 0 };
      }

      return { stdout: "", stderr: "", status: 0 };
    });

    expect(adapter.focusPane("%42")).toBe(true);
    expect(mockExecCommand).toHaveBeenCalledWith("tmux", ["select-window", "-t", "@9"]);
    expect(mockExecCommand).toHaveBeenCalledWith("tmux", ["select-pane", "-t", "%42"]);
  });

  it("should target the current pane when setting the title", () => {
    mockExecCommand.mockReturnValue({ stdout: "", stderr: "", status: 0 });

    adapter.setTitle("team: agent-1");

    expect(mockExecCommand).toHaveBeenCalledWith(
      "tmux",
      ["select-pane", "-t", "%16", "-T", "team: agent-1"]
    );
  });
});
