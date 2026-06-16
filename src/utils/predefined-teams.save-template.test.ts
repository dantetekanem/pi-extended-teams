import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { saveTeamTemplate } from "./predefined-teams";

describe("saveTeamTemplate", () => {
  const rootPiDir = path.join(os.homedir(), ".pi");
  const globalAgentsDir = path.join(rootPiDir, "agent", "agents");
  const globalTeamsPath = path.join(rootPiDir, "teams.yaml");
  const projectDir = path.join(os.tmpdir(), "pi-extended-teams-test-save-" + Date.now());

  let originalGlobalTeams: string | null = null;
  let originalAgentFiles = new Set<string>();

  beforeEach(() => {
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true });
    }

    if (fs.existsSync(globalTeamsPath)) {
      originalGlobalTeams = fs.readFileSync(globalTeamsPath, "utf-8");
    }
    if (fs.existsSync(globalAgentsDir)) {
      originalAgentFiles = new Set(fs.readdirSync(globalAgentsDir));
    }
  });

  afterEach(() => {
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true });
    }

    if (originalGlobalTeams === null) {
      if (fs.existsSync(globalTeamsPath)) fs.rmSync(globalTeamsPath);
    } else {
      fs.mkdirSync(path.dirname(globalTeamsPath), { recursive: true });
      fs.writeFileSync(globalTeamsPath, originalGlobalTeams);
    }

    if (fs.existsSync(globalAgentsDir)) {
      for (const file of fs.readdirSync(globalAgentsDir)) {
        if (!originalAgentFiles.has(file)) {
          fs.rmSync(path.join(globalAgentsDir, file));
        }
      }
    }
  });

  it("writes user-scoped teams to ~/.pi/teams.yaml and agents to ~/.pi/agent/agents", () => {
    const result = saveTeamTemplate(
      {
        name: "audit-team",
        members: [
          {
            name: "security-worker",
            agentType: "teammate",
            prompt: "Audit security issues",
          },
        ],
      },
      {
        templateName: "audit-team",
        scope: "user",
      }
    );

    expect(result.teamsYamlPath).toBe(globalTeamsPath);
    expect(result.agentsDir).toBe(globalAgentsDir);
    expect(fs.existsSync(globalTeamsPath)).toBe(true);
    expect(fs.readFileSync(globalTeamsPath, "utf-8")).toContain("audit-team:");
    expect(fs.existsSync(path.join(globalAgentsDir, "security-worker.md"))).toBe(true);
  });
});
