import { describe, expect, it, vi } from "vitest";
import { registerCoordinationTools } from "./coordination-tools.js";

describe("coordination public tool surface", () => {
  it("does not register helper, broadcast, shared-memory, or skill-loading tools", () => {
    const tools = new Map<string, any>();

    registerCoordinationTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
      agentName: "agent",
      isTeammate: true,
      terminal: null,
      getTeamName: () => "session",
      requireWriteAgentTeam: async () => "session",
      requireTeamContext: () => "session",
      releaseAllClaimsForAgent: vi.fn(async () => []),
      drainWriteQueue: vi.fn(async () => {}),
      resolveSkillFile: vi.fn(),
      adoptTeamAsLead: vi.fn(),
      renderLeadInboxStatus: vi.fn(async () => {}),
      resetLeadWakeNotifiedCount: vi.fn(),
    });

    expect(Array.from(tools.keys()).sort()).toEqual([
      "claim_file",
      "list_file_claims",
      "read_inbox",
      "release_file",
      "report_and_exit",
      "send_message",
    ]);
    expect(tools.has("request_read_helper")).toBe(false);
    expect(tools.has("broadcast_message")).toBe(false);
    expect(tools.has("use_skill")).toBe(false);
  });
});
