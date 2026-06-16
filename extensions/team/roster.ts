import * as teams from "../../src/utils/teams";
import * as tasks from "../../src/utils/tasks";
import * as messaging from "../../src/utils/messaging";
import * as runtime from "../../src/utils/runtime";
import * as claims from "../../src/utils/claims";
import * as writeQueue from "../../src/utils/write-queue";
import type { RunningReadAgent } from "../runtime/types";

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
  const role = member?.role ?? "write";
  if (role !== "write") {
    throw new Error("File claim tools are only available to write agents.");
  }

  return teamName;
}

export async function releaseAllClaimsForAgent(teamName: string, agentName: string): Promise<string[]> {
  try {
    return await claims.releaseAllForAgent(teamName, agentName);
  } catch {
    return [];
  }
}

export async function countWriteMembers(teamName: string): Promise<number> {
  const config = await teams.readConfig(teamName);
  return config.members.filter(member => member.agentType === "teammate" && (member.role ?? "write") === "write").length;
}

export async function buildRoster(teamName: string, options: BuildRosterOptions) {
  const config = await teams.readConfig(teamName);
  const allTasks = await tasks.listTasks(teamName).catch(() => []);
  const allClaims = await claims.listClaims(teamName).catch(() => []);
  const queue = await writeQueue.listWriteQueue(teamName).catch(() => []);

  const members = await Promise.all(config.members.map(async (member) => {
    const role = member.role ?? (member.name === "team-lead" ? "lead" : "write");
    const runtimeStatus = member.name === "team-lead" ? null : await runtime.readRuntimeStatus(teamName, member.name).catch(() => null);
    const unreadCount = member.name === "team-lead" ? 0 : (await messaging.readInbox(teamName, member.name, true, false).catch(() => [])).length;
    const memberTasks = allTasks.filter((task: any) => task.owner === member.name && task.status !== "completed" && task.status !== "deleted");
    const memberClaims = allClaims.filter(claim => claim.agent === member.name);
    const readState = options.runningReadAgents.get(options.readAgentKey(teamName, member.name));
    const alive = member.name === "team-lead"
      ? true
      : role === "read"
        ? !!readState || !!runtimeStatus?.ready
        : !!(member.tmuxPaneId && options.terminal?.isAlive(member.tmuxPaneId));

    return {
      name: member.name,
      role,
      status: member.name === "team-lead" ? "lead" : alive ? (readState?.status || "running") : "dead/idle",
      model: member.model,
      cwd: member.cwd,
      unreadCount,
      tasks: memberTasks.map((task: any) => ({ id: task.id, subject: task.subject, status: task.status })),
      claims: memberClaims.map(claim => claim.path),
      tmuxPaneId: member.tmuxPaneId || undefined,
      runtime: runtimeStatus,
    };
  }));

  return {
    teamName,
    members,
    writeQueue: queue.map((item, index) => ({ position: index + 1, id: item.id, name: item.name, requestedAt: item.requestedAt })),
  };
}

export function formatRosterForPrompt(roster: Awaited<ReturnType<typeof buildRoster>>): string {
  const lines = [`Team roster for ${roster.teamName}:`];
  for (const member of roster.members) {
    const taskText = member.tasks.length > 0 ? ` tasks=${member.tasks.map(task => `#${task.id}:${task.status}`).join(",")}` : "";
    const claimText = member.claims.length > 0 ? ` claims=${member.claims.join(",")}` : "";
    lines.push(`- ${member.name}: ${member.role}, ${member.status}, unread=${member.unreadCount}${taskText}${claimText}`);
  }
  if (roster.writeQueue.length > 0) {
    lines.push(`Queued writers: ${roster.writeQueue.map(item => `${item.position}.${item.name}`).join(", ")}`);
  }
  return lines.join("\n");
}
