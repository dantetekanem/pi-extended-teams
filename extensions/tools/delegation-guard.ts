import * as paths from "../../src/utils/paths";
import * as messaging from "../../src/utils/messaging";

export interface TeammateDelegationOptions {
  isTeammate: boolean;
  agentName: string;
  getTeamName(): string | null | undefined;
}

export interface LeadSpawnRequest {
  action: string;
  params: Record<string, unknown>;
  reason?: string;
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function resolveLeadRequestTeamName(options: TeammateDelegationOptions, requestedTeamName?: string): string {
  const currentTeamName = options.getTeamName();
  const targetTeamName = currentTeamName || requestedTeamName;
  if (targetTeamName == null || String(targetTeamName).trim().length === 0) {
    throw new Error("Cannot resolve team context without a current team or team_name.");
  }
  return paths.sanitizeName(String(targetTeamName));
}

export async function requestLeadForTeammateSpawn(
  options: TeammateDelegationOptions,
  request: LeadSpawnRequest,
): Promise<{ content: any[]; details: any }> {
  const requestedTeamName = typeof request.params.team_name === "string" ? request.params.team_name : undefined;
  const targetTeamName = resolveLeadRequestTeamName(options, requestedTeamName);
  const requestedAgentName = typeof request.params.name === "string" && request.params.name.trim().length > 0
    ? ` for ${request.params.name}`
    : "";
  const summary = `Agent spawn request from ${options.agentName}${requestedAgentName}`;
  const content = [
    `${options.agentName} requested a lead-owned agent action.`,
    "",
    "Teammates are not allowed to spawn or promote other agents directly. The team lead must decide whether to run this request.",
    "",
    `Requested action: ${request.action}`,
    request.reason ? `Reason: ${request.reason}` : undefined,
    "Requested parameters:",
    compactJson(request.params),
    "",
    `If appropriate, the lead should call ${request.action} with the requested parameters or adjust them before spawning.`,
  ].filter((line): line is string => line != null).join("\n");

  await messaging.sendPlainMessage(targetTeamName, options.agentName, "team-lead", content, summary, "yellow");

  return {
    content: [{ type: "text", text: `Teammates cannot spawn agents directly. Sent a request to team-lead for ${targetTeamName}.` }],
    details: {
      requested: true,
      requestedAction: request.action,
      teamName: targetTeamName,
      recipient: "team-lead",
      from: options.agentName,
      params: request.params,
    },
  };
}
