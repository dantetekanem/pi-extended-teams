import { describe, expect, it, vi } from "vitest";
import { installAgentNavigation, wrapEditorForAgentNavigation } from "./agent-navigation";

describe("agent navigation editor", () => {
  it("opens the agent view on down only when the editor is empty", () => {
    let text = "";
    const originalHandleInput = vi.fn();
    const editor = {
      getText: () => text,
      handleInput: originalHandleInput,
    };
    const openAgentView = vi.fn(() => true);
    const wrapped = wrapEditorForAgentNavigation(editor, openAgentView);

    wrapped.handleInput("\x1b[B");
    expect(openAgentView).toHaveBeenCalledOnce();
    expect(originalHandleInput).not.toHaveBeenCalled();

    text = "draft";
    wrapped.handleInput("\x1b[B");
    expect(openAgentView).toHaveBeenCalledOnce();
    expect(originalHandleInput).toHaveBeenCalledWith("\x1b[B");
  });

  it("replaces its own editor wrapper on reload instead of stacking wrappers", () => {
    let currentFactory: any;
    const ctx = {
      mode: "tui",
      ui: {
        getEditorComponent: () => currentFactory,
        setEditorComponent: vi.fn((factory: any) => { currentFactory = factory; }),
      },
    };

    installAgentNavigation(ctx, { getAgents: () => [] });
    const firstFactory = currentFactory;
    installAgentNavigation(ctx, { getAgents: () => [] });

    expect(currentFactory).not.toBe(firstFactory);
    expect(currentFactory.piExtendedTeamsBaseFactory).toBeNull();
  });

  it("preserves normal down behavior when there is no active agent", () => {
    const originalHandleInput = vi.fn();
    const editor = { getText: () => "", handleInput: originalHandleInput };
    const wrapped = wrapEditorForAgentNavigation(editor, () => false);

    wrapped.handleInput("\x1b[B");

    expect(originalHandleInput).toHaveBeenCalledWith("\x1b[B");
  });
});
