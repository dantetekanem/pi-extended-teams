import { isDeepStrictEqual } from "node:util";
import * as messaging from "../utils/messaging";
import { resyncStoredTeamReportEvent } from "../utils/report-events";
import type { TeamReportEvent } from "../utils/models";
import { effectiveTaskOutcome } from "./report-result";
import { CompletionGroup, type CompletionGroupState } from "./completion-group";

type GroupMember = CompletionGroupState["members"][number];
const compact = (text: string | undefined, limit = 400) => text && text.length > limit ? `${text.slice(0, limit)}…` : text;

function assertReportBinding(group: CompletionGroup, member: GroupMember, event: TeamReportEvent): void {
  if (event.teamName !== group.teamName || event.agentName !== member.name || !event.result
    || event.result.reportId !== event.id || event.result.runId !== member.runId
    || !isDeepStrictEqual(event.completionGroup, { groupId: group.groupId, slotId: member.slotId })) {
    throw new Error("Completion report provenance binding has changed.");
  }
}

async function indexMember(group: CompletionGroup, member: GroupMember) {
  const identity = { name: member.name, slotId: member.slotId, status: member.status, runId: member.runId };
  if (!member.report) return { ...identity, reason: compact(member.reason) };
  const event = await resyncStoredTeamReportEvent(group.teamName, member.report.reportId);
  assertReportBinding(group, member, event);
  const result = event.result!;
  if (result.outcome !== member.report.outcome || effectiveTaskOutcome(result) !== member.report.effectiveOutcome
    || result.verification.state !== member.report.verification || event.status !== member.report.runtimeStatus) {
    throw new Error("Completion report evidence differs from its receipt.");
  }
  return { ...identity, taskId: result.taskId, runtimeStatus: event.status, role: event.role, summary: compact(event.summary),
    outcome: result.outcome, effectiveOutcome: effectiveTaskOutcome(result), verification: result.verification,
    acceptance: result.acceptance, findings: result.findings?.map(finding => ({ ...finding, text: compact(finding.text) })),
    questions: result.questions, report: { id: event.id, path: event.reportPath } };
}

export async function enqueueCompletionGroupDeliveries(group: CompletionGroup): Promise<number> {
  let enqueued = 0;
  for (const delivery of await group.prepareDeliveries()) {
    const state = group.read();
    const members = await Promise.all(delivery.slotIds.map(slotId => {
      const member = state.members.find(candidate => candidate.slotId === slotId);
      if (!member || member.suppressed) throw new Error("Invalid completion index member.");
      return indexMember(group, member);
    }));
    const index = { version: 1, groupId: group.groupId, deliveryId: delivery.id, kind: delivery.kind, members };
    const receipt = await messaging.sendPlainMessageOnce(group.teamName, "system", "team-lead", JSON.stringify(index),
      `Completion group ${delivery.kind}: ${members.length} result(s)`, { id: delivery.id, operationId: delivery.id,
        metadata: { finalReport: true, completionGroup: { groupId: group.groupId, deliveryId: delivery.id, journalPath: group.journalPath } } });
    await group.markEnqueued(delivery.id);
    if (receipt.delivered) enqueued++;
  }
  return enqueued;
}

export async function deliverCompletionGroupReport(event: TeamReportEvent, onDurableReport?: () => void): Promise<boolean> {
  const binding = event.completionGroup;
  if (!binding) return false;
  const stored = await resyncStoredTeamReportEvent(event.teamName, event.id);
  const group = new CompletionGroup(event.teamName, binding.groupId);
  const member = group.read().members.find(candidate => candidate.slotId === binding.slotId);
  if (!member) throw new Error("Unknown completion report slot.");
  assertReportBinding(group, member, stored);
  onDurableReport?.();
  await group.recordReport(binding.slotId, stored.result!, stored.status);
  await enqueueCompletionGroupDeliveries(group);
  return true;
}
