import { findInboxMessageByOperation, markInboxMessagesRead } from "../utils/messaging";
import type { InboxMessage } from "../utils/models";
import { CompletionGroup } from "./completion-group";

type WakeBinding = { teamName: string; groupId: string; deliveryId: string };
export interface CompletionWakeEntry {
  type: string; id: string; customType?: string; content?: unknown;
  details?: { completionGroup?: WakeBinding };
}
const wakeContent = (message: InboxMessage) => `Completion group index:\n${message.text}\nUse the referenced full reports as needed, integrate the evidence, and continue the active task. Group settlement is not task success or lead acceptance. Do not stop self-exiting reporting agents.`;

async function boundIndex(teamName: string, sessionId: string, binding: Pick<WakeBinding, "groupId" | "deliveryId">) {
  const group = new CompletionGroup(teamName, binding?.groupId);
  const state = group.read();
  const delivery = state.deliveries.find(item => item.id === binding.deliveryId);
  const message = await findInboxMessageByOperation(teamName, "team-lead", binding.deliveryId);
  if (state.sessionId !== sessionId || delivery?.status !== "enqueued" || !message
    || message.id !== delivery.id || message.operationId !== delivery.id
    || message.metadata?.completionGroup?.groupId !== group.groupId
    || message.metadata?.completionGroup?.deliveryId !== delivery.id) {
    throw new Error("Completion wake index binding is unavailable or changed.");
  }
  return { group, delivery, message };
}

export async function requestCompletionGroupWake(
  teamName: string, sessionId: string, message: InboxMessage,
  send: (content: string, details: { completionGroup: WakeBinding }) => void,
): Promise<boolean> {
  const binding = message.metadata?.completionGroup as WakeBinding;
  const bound = await boundIndex(teamName, sessionId, binding);
  if (message.id !== bound.message.id || message.text !== bound.message.text) throw new Error("Completion wake message binding has changed.");
  if (!await bound.group.reserveWake(binding.deliveryId)) return false;
  try {
    send(wakeContent(bound.message), { completionGroup: { teamName, groupId: bound.group.groupId, deliveryId: binding.deliveryId } });
  } catch (error) {
    await bound.group.recordWakeEvidence(binding.deliveryId, { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  return true;
}

export async function observeCompletionGroupWakes(
  teamName: string, sessionId: string, entries: readonly CompletionWakeEntry[],
): Promise<{ observed: string[]; errors: string[] }> {
  const observed: string[] = [];
  const errors: string[] = [];
  for (const entry of entries) {
    const binding = entry.details?.completionGroup;
    if (entry.type !== "custom_message" || entry.customType !== "pi-extended-teams-wake" || binding?.teamName !== teamName) continue;
    try {
      const bound = await boundIndex(teamName, sessionId, binding);
      if (entry.content !== wakeContent(bound.message)) throw new Error("Completion wake history binding has changed.");
      await bound.group.recordWakeEvidence(binding.deliveryId, { entryId: entry.id });
      await markInboxMessagesRead(teamName, "team-lead", [binding.deliveryId]);
      observed.push(entry.id);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { observed, errors };
}
