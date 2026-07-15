import fs from "node:fs";
import path from "node:path";
import { TeamConfig, Member } from "./models";
import { configPath, teamDir, taskDir } from "./paths";
import { withLock } from "./lock";
import {
  assertLifecycleTombstoneAbsent,
  generateLifecycleRunId,
  withLifecycleTombstoneLock,
} from "./lifecycle-tombstone";

export function teamExists(teamName: string) {
  return fs.existsSync(configPath(teamName));
}

export function createTeam(
  name: string,
  sessionId: string,
  leadAgentId: string,
  description = "",
  defaultModel?: string,
  separateWindows?: boolean,
  metadata?: Record<string, any>
): TeamConfig {
  const dir = teamDir(name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tasksDir = taskDir(name);
  if (!fs.existsSync(tasksDir)) fs.mkdirSync(tasksDir, { recursive: true });

  const leadMember: Member = {
    agentId: leadAgentId,
    name: "team-lead",
    agentType: "lead",
    joinedAt: Date.now(),
    tmuxPaneId: process.env.TMUX_PANE || "",
    cwd: process.cwd(),
    subscriptions: [],
  };

  const config: TeamConfig = {
    name,
    description,
    createdAt: Date.now(),
    leadAgentId,
    leadSessionId: sessionId,
    members: [leadMember],
    defaultModel,
    separateWindows,
    metadata,
  };

  fs.writeFileSync(configPath(name), JSON.stringify(config, null, 2));
  return config;
}

function readConfigRaw(p: string): TeamConfig {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export async function readConfig(teamName: string): Promise<TeamConfig> {
  const p = configPath(teamName);
  if (!fs.existsSync(p)) throw new Error(`Team ${teamName} not found`);
  return await withLock(p, async () => {
    return readConfigRaw(p);
  });
}

export interface EnsureTeamOptions {
  name: string;
  sessionId?: string;
  leadAgentId?: string;
  description?: string;
  defaultModel?: string;
  separateWindows?: boolean;
  metadata?: Record<string, any>;
}

export interface EnsureTeamResult {
  config: TeamConfig;
  created: boolean;
}

export async function ensureTeam(options: EnsureTeamOptions): Promise<EnsureTeamResult> {
  if (teamExists(options.name)) {
    return { config: await readConfig(options.name), created: false };
  }

  const config = createTeam(
    options.name,
    options.sessionId || "local-session",
    options.leadAgentId || "lead-agent",
    options.description || "",
    options.defaultModel,
    options.separateWindows,
    options.metadata
  );
  return { config, created: true };
}

export async function addMember(teamName: string, member: Member) {
  const p = configPath(teamName);
  if (member.name === "team-lead") {
    await withLock(p, async () => {
      const config = readConfigRaw(p);
      config.members.push(member);
      fs.writeFileSync(p, JSON.stringify(config, null, 2));
    });
    return;
  }

  // Every successful admission is a distinct lifecycle run, even when a caller
  // accidentally reuses a previously admitted Member object.
  member.lifecycleRunId = generateLifecycleRunId();
  await withLifecycleTombstoneLock(teamName, member.name, async lifecycleLock => {
    assertLifecycleTombstoneAbsent(teamName, member.name, lifecycleLock.read());
    await withLock(p, async () => {
      const config = readConfigRaw(p);
      if (config.members.some(existing => existing.name === member.name)) {
        throw new Error(`Teammate ${member.name} already exists in team ${teamName}.`);
      }
      config.members.push(member);
      fs.writeFileSync(p, JSON.stringify(config, null, 2));
    });
  });
}

export async function ensureMemberLifecycleRunId(teamName: string, agentName: string, preferredCompatibilityRunId?: string): Promise<string> {
  const p = configPath(teamName);
  return withLifecycleTombstoneLock(teamName, agentName, async lifecycleLock => {
    const tombstone = lifecycleLock.read();
    if (tombstone.status === "corrupt") {
      assertLifecycleTombstoneAbsent(teamName, agentName, tombstone);
    }
    return withLock(p, async () => {
      const config = readConfigRaw(p);
      const member = config.members.find(item => item.name === agentName);
      if (!member) throw new Error(`Agent ${agentName} is not a member of team ${teamName}.`);
      if (member.lifecycleRunId) return member.lifecycleRunId;

      // Compatibility identity for persisted pre-v1 members. If closure already
      // fenced the member, adopt that authoritative run instead of inventing a
      // second identity. This field is lifecycle state, never user metadata.
      member.lifecycleRunId = tombstone.status === "occupied"
        ? tombstone.tombstone.runId
        : preferredCompatibilityRunId || `compat-${generateLifecycleRunId()}`;
      fs.writeFileSync(p, JSON.stringify(config, null, 2));
      return member.lifecycleRunId;
    });
  });
}

export async function removeMember(teamName: string, agentName: string) {
  const p = configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    config.members = config.members.filter(m => m.name !== agentName);
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
  });
}

export async function removeMemberMatchingRun(
  teamName: string,
  agentName: string,
  expectedRunId: string
): Promise<boolean> {
  const p = configPath(teamName);
  return withLock(p, async () => {
    const config = readConfigRaw(p);
    const index = config.members.findIndex(member => member.name === agentName);
    if (index < 0 || config.members[index].lifecycleRunId !== expectedRunId) return false;
    config.members.splice(index, 1);
    fs.writeFileSync(p, JSON.stringify(config, null, 2));
    return true;
  });
}

export async function updateMember(teamName: string, agentName: string, updates: Partial<Member>) {
  const p = configPath(teamName);
  await withLock(p, async () => {
    const config = readConfigRaw(p);
    const m = config.members.find(m => m.name === agentName);
    if (m) {
      Object.assign(m, updates);
      fs.writeFileSync(p, JSON.stringify(config, null, 2));
    }
  });
}
