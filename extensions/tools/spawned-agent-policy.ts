import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const USER_INTERACTION_TOOLS = ["ask_user", "ask_user_batch", "orb_ask", "orb_say"];
export const SPAWNED_AGENT_COMMUNICATION_GUIDANCE = readFileSync(
  path.join(__dirname, "../prompts/spawned-agent-communication.md"), "utf8"
).trim();

export function requireLeadRecipient(recipient: string): void {
  if (recipient !== "team-lead") {
    throw new Error("Spawned agents may send messages only to team-lead.");
  }
}

export function registerSpawnedAgentCommunicationGuard(pi: Pick<ExtensionAPI, "on">): void {
  pi.on("tool_call", event => {
    if (USER_INTERACTION_TOOLS.includes(event.toolName)) {
      return { block: true, reason: "Spawned agents cannot contact the user. Send your question to team-lead using send_message." };
    }
  });
}
