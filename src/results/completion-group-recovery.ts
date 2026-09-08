import fs from "node:fs";
import path from "node:path";
import * as paths from "../utils/paths";
import { peekInbox } from "../utils/messaging";
import { listStoredTeamReportEvents } from "../utils/report-events";
import type { Member } from "../utils/models";
import { CompletionGroup } from "./completion-group";
import { deliverCompletionGroupReport, enqueueCompletionGroupDeliveries } from "./completion-group-delivery";

type Reference = { session?: string; completionGroup?: { groupId?: string; teamName?: string } };
type HistoryReference = { type?: string; details?: Reference; message?: { role?: string; toolName?: string; details?: Reference } };
export async function recoverCompletionGroups(
  teamName: string, sessionId: string, members: readonly Pick<Member, "name" | "lifecycleRunId" | "completionGroup">[],
  entries: readonly HistoryReference[], currentGroupIds: ReadonlySet<string>,
): Promise<string[]> {
  const root = paths.teamDir(teamName);
  const directory = path.join(root, "completion-groups");
  const reports = fs.existsSync(path.join(root, "reports.json")) ? await listStoredTeamReportEvents(teamName) : [];
  const inbox = await peekInbox(teamName, "team-lead");
  const ids = new Set(fs.existsSync(directory) ? fs.readdirSync(directory)
    .filter(file => /^[a-f0-9]{64}\.json$/.test(file)).map(file => `group:${file.slice(0, -5)}`) : []);
  const references = [...members.map(member => member.completionGroup), ...reports.map(report => report.completionGroup),
    ...inbox.map(message => message.metadata?.completionGroup), ...entries.flatMap(entry => [
      entry.type === "custom_message" && entry.details?.completionGroup?.teamName === teamName ? entry.details.completionGroup : undefined,
      entry.message?.role === "toolResult" && entry.message.toolName === "spawn_swarm_agents" && entry.message.details?.session === teamName
        ? entry.message.details.completionGroup : undefined])];
  for (const reference of references) if (reference?.groupId) ids.add(reference.groupId);
  const errors: string[] = [];
  for (const id of ids) {
    try {
      const group = new CompletionGroup(teamName, id);
      const state = group.read();
      if (state.sessionId !== sessionId || currentGroupIds.has(id)) continue;
      for (const slot of state.members) {
        if (["cancelled", "interrupted", "rejected"].includes(slot.status)) continue;
        const owner = members.find(member => member.name === slot.name
          && member.completionGroup?.groupId === id && member.completionGroup.slotId === slot.slotId);
        if (!slot.runId && owner?.lifecycleRunId) {
          await group.apply({ type: "running", slotId: slot.slotId, runId: owner.lifecycleRunId });
        }
        const current = group.read().members.find(member => member.slotId === slot.slotId)!;
        const report = reports.find(event => event.agentName === current.name && event.result?.runId === current.runId
          && event.completionGroup?.groupId === id && event.completionGroup.slotId === current.slotId);
        if (report) await deliverCompletionGroupReport(report);
        else if (["pending", "queued"].includes(current.status) && !owner) {
          await group.apply({ type: "interrupted", slotId: current.slotId,
            reason: "Assignment was not retained across extension reload; no work was restarted." });
        } else if (current.status === "reported") throw new Error(`Full grouped report is unavailable: ${current.report?.reportId}.`);
        else errors.push(`Completion group ${id}: ${current.name} (${current.runId ?? "unbound"}) remains unresolved after reload; no work was restarted.`);
      }
      await group.seal();
      await enqueueCompletionGroupDeliveries(group);
      for (const delivery of group.read().deliveries) if (delivery.wake?.state === "pending") {
        errors.push(`Completion group wake is unconfirmed (${delivery.id}). Use read_inbox for the saved index; no automatic retry. Journal: ${group.journalPath}`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}
