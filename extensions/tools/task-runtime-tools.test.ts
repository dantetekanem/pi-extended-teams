import { describe, expect, it, vi } from "vitest";
import { registerTaskRuntimeTools } from "./task-runtime-tools.js";

function registerTools(isTeammate: boolean) {
  const tools = new Map<string, any>();
  registerTaskRuntimeTools({ registerTool: (tool: any) => tools.set(tool.name, tool) }, {
    isTeammate,
    terminal: null,
    runningReadAgents: new Map(),
    readAgentKey: (teamName: string, agentName: string) => `${teamName}:${agentName}`,
    shutdownTeammate: vi.fn(async () => {}),
    releaseAllClaimsForAgent: vi.fn(async () => []),
    getTeamName: () => "team",
  });
  return tools;
}

describe("task runtime tools", () => {
  it("keeps stop_teammate lead-only while leaving diagnostics available", () => {
    const leadTools = registerTools(false);
    const teammateTools = registerTools(true);

    expect(leadTools.has("stop_teammate")).toBe(true);
    expect(leadTools.has("check_teammate")).toBe(true);
    expect(teammateTools.has("stop_teammate")).toBe(false);
    expect(teammateTools.has("check_teammate")).toBe(true);
  });
});
