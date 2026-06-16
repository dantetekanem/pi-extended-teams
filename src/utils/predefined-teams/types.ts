import type { ThinkingLevel } from "../models";

/**
 * Represents an agent definition from a .md file
 */
export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: ThinkingLevel;
  prompt: string;
  filePath: string;
}

/**
 * Represents a predefined team from teams.yaml
 */
export interface PredefinedTeam {
  name: string;
  agents: string[];
  description?: string;
}

/**
 * Options for saving a team as a template
 */
export interface SaveTeamTemplateOptions {
  templateName: string;
  description?: string;
  scope: "user" | "project";
  projectDir?: string;
}

/**
 * Result of saving a team as a template
 */
export interface SaveTeamTemplateResult {
  templateName: string;
  agentsDir: string;
  teamsYamlPath: string;
  savedAgents: Array<{
    name: string;
    path: string;
    existed: boolean;
  }>;
  templateExisted: boolean;
}
