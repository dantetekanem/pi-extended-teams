import * as teams from "../../src/utils/teams";
import * as tasks from "../../src/utils/tasks";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import * as claims from "../../src/utils/claims";
import * as writeQueue from "../../src/utils/write-queue";
import type { TaskFile } from "../../src/utils/models";
import type { FileClaim } from "../../src/utils/claims";
import type { RunningReadAgent } from "../runtime/types";
import { listLifecycleTombstones } from "../../src/utils/lifecycle-tombstone";

type RosterTask = Pick<TaskFile, "id" | "subject" | "status">;

export interface BuildRosterOptions {
  terminal: any;
  runningReadAgents: Map<string, RunningReadAgent>;
  readAgentKey(teamName: string, agentName: string): string;
}

export function requireTeamContext(currentTeamName: string | null | undefined, explicitTeamName?: string): string {
  const targetTeamName = explicitTeamName || currentTeamName;
  if (!targetTeamName) {
    throw new Error("No team name supplied and no current team context detected.");
  }
  return targetTeamName;
}

export async function requireWriteAgentTeam(
  teamName: string | null | undefined,
  isTeammate: boolean,
  agentName: string
): Promise<string> {
  if (!teamName) {
    throw new Error("No team context available for file claims.");
  }
  if (!isTeammate) {
    throw new Error("claim_file and release_file are only available to teammates; leads should use list_file_claims.");
  }

  const teamConfig = await teams.readConfig(teamName);
  const member = teamConfig.members.find(m => m.name === agentName);
  if (!member) {
    throw new Error(`Agent ${agentName} is not a member of session ${teamName}.`);
  }
  const role = member.role ?? "write";
  if (role !== "write") {
    throw new Error("File claim tools are only available to write agents.");
  }

  return teamName;
}

export async function releaseAllClaimsForAgent(teamName: string, agentName: string): Promise<string[]> {
  return claims.releaseAllForAgent(teamName, agentName);
}

export function isWriteMemberAlive(member: any, terminal: any): boolean {
  return !!(member.tmuxPaneId && terminal?.isAlive?.(member.tmuxPaneId));
}

export async function countWriteMembers(teamName: string, terminal?: any): Promise<number> {
  const config = await teams.readConfig(teamName);
  return config.members.filter(member => {
    if (member.agentType !== "teammate" || (member.role ?? "write") !== "write") return false;
    return terminal ? isWriteMemberAlive(member, terminal) : true;
  }).length;
}

function indexOpenTasksByOwner(allTasks: TaskFile[]): Map<string, RosterTask[]> {
  const tasksByOwner = new Map<string, RosterTask[]>();

  for (const task of allTasks) {
    if (!task.owner || task.status === "completed" || task.status === "deleted") continue;
    const memberTasks = tasksByOwner.get(task.owner) ?? [];
    memberTasks.push({ id: task.id, subject: task.subject, status: task.status });
    if (memberTasks.length === 1) tasksByOwner.set(task.owner, memberTasks);
  }

  return tasksByOwner;
}

function indexClaimsByAgent(allClaims: FileClaim[]): Map<string, string[]> {
  const claimsByAgent = new Map<string, string[]>();

  for (const claim of allClaims) {
    const memberClaims = claimsByAgent.get(claim.agent) ?? [];
    memberClaims.push(claim.path);
    if (memberClaims.length === 1) claimsByAgent.set(claim.agent, memberClaims);
  }

  return claimsByAgent;
}

export async function buildRoster(teamName: string, options: BuildRosterOptions) {
  const config = await teams.readConfig(teamName);
  const allTasks = await tasks.listTasks(teamName).catch(() => []);
  const allClaims = await claims.listClaims(teamName).catch(() => []);
  const queue = await writeQueue.listWriteQueue(teamName).catch(() => []);
  const tasksByOwner = indexOpenTasksByOwner(allTasks);
  const claimsByAgent = indexClaimsByAgent(allClaims);
  const tombstones = await listLifecycleTombstones(teamName).catch(() => []);
  const tombstoneByAgent = new Map(tombstones.map(entry => [entry.agentName, entry.result]));

  const members = await Promise.all(config.members.map(async (member) => {
    const role = member.role ?? (member.name === "team-lead" ? "lead" : "write");
    const runtimeStatus = member.name === "team-lead" ? null : await runtime.readRuntimeStatus(teamName, member.name).catch(() => null);
    const unreadCount = member.name === "team-lead" ? 0 : (await messaging.readInbox(teamName, member.name, true, false).catch(() => [])).length;
    const memberTasks = tasksByOwner.get(member.name) ?? [];
    const memberClaims = claimsByAgent.get(member.name) ?? [];
    const readState = options.runningReadAgents.get(options.readAgentKey(teamName, member.name));
    const alive = member.name === "team-lead"
      ? true
      : !!readState || !!runtimeStatus?.ready || (role === "write" && isWriteMemberAlive(member, options.terminal));

    const tombstone = tombstoneByAgent.get(member.name);
    return {
      name: member.name,
      role,
      status: member.name === "team-lead" ? "lead" : tombstone ? "quarantined" : alive ? (readState?.status || "running") : "dead/idle",
      model: member.model,
      cwd: member.cwd,
      unreadCount,
      tasks: memberTasks,
      claims: memberClaims,
      tmuxPaneId: member.tmuxPaneId || undefined,
      runtime: runtimeStatus,
    };
  }));

  const knownNames = new Set(config.members.map(member => member.name));
  for (const { agentName, result } of tombstones) {
    if (knownNames.has(agentName)) continue;
    members.push({
      name: agentName,
      role: result.status === "occupied" ? result.tombstone.role : "read",
      status: "quarantined",
      model: undefined,
      cwd: "",
      unreadCount: 0,
      tasks: tasksByOwner.get(agentName) ?? [],
      claims: claimsByAgent.get(agentName) ?? [],
      tmuxPaneId: undefined,
      runtime: await runtime.readRuntimeStatus(teamName, agentName).catch(() => null),
    });
  }

  return {
    teamName,
    members,
    writeQueue: queue.map((item, index) => ({ position: index + 1, id: item.id, name: item.name, requestedAt: item.requestedAt })),
  };
}

export function formatRosterForPrompt(roster: Awaited<ReturnType<typeof buildRoster>>): string {
  const lines = [`Agents for session ${roster.teamName}:`];
  for (const member of roster.members) {
    const taskText = member.tasks.length > 0 ? ` tasks=${member.tasks.map(task => `#${task.id}:${task.status}`).join(",")}` : "";
    const claimText = member.claims.length > 0 ? ` claims=${member.claims.join(",")}` : "";
    lines.push(`- ${member.name}: ${member.role}, ${member.status}, unread=${member.unreadCount}${taskText}${claimText}`);
  }
  if (roster.writeQueue.length > 0) {
    lines.push(`Queued edit agents: ${roster.writeQueue.map(item => `${item.position}.${item.name}`).join(", ")}`);
  }
  return lines.join("\n");
}
