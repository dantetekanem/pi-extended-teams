import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { InboxMessage, TeamConfig } from "./models";
import { withLock } from "./lock";
import { configPath, inboxPath } from "./paths";
import { readConfig } from "./teams";
import { assertLifecycleTombstoneAbsent, withLifecycleTombstoneLock } from "./lifecycle-tombstone";

export interface MessageMetadataOptions {
  id?: string;
  operationId?: string;
  workflowRunId?: string;
  metadata?: Record<string, any>;
  /** Admission fence for startup messages that belong to one lifecycle run. */
  expectedRecipientRunId?: string;
}

export interface SendPlainMessageOptions extends MessageMetadataOptions {
  color?: string;
}

export interface SendPlainMessageOnceResult {
  message: InboxMessage;
  delivered: boolean;
}

export interface ReadInboxTailOptions {
  unreadOnly?: boolean;
  markAsRead?: boolean;
}

export function nowIso(): string {
  return new Date().toISOString();
}

interface AppendRunningMessageOptions {
  operationId?: string;
  workflowRunId?: string;
  expectedRecipientRunId?: string;
}

async function appendRunningMessage(
  teamName: string,
  agentName: string,
  message: InboxMessage,
  options: AppendRunningMessageOptions = {}
): Promise<SendPlainMessageOnceResult> {
  const appendUnderInboxLock = async (): Promise<SendPlainMessageOnceResult> => {
    const p = ensureInboxFile(teamName, agentName);
    return withLock(p, async () => {
      const messages = readInboxRaw(p);
      if (options.operationId) {
        const existing = messages.find(item => messageOperationMatches(item, options.operationId!, options.workflowRunId));
        if (existing) return { message: existing, delivered: false };
      }
      messages.push(message);
      fs.writeFileSync(p, JSON.stringify(messages, null, 2));
      return { message, delivered: true };
    });
  };

  // The lead has always been an out-of-band recipient: final reports must remain
  // deliverable after the sender is fenced and the lead roster entry has no run id.
  if (agentName === "team-lead") return appendUnderInboxLock();

  const teamConfigPath = configPath(teamName);
  return withLifecycleTombstoneLock(teamName, agentName, async lifecycleLock => {
    assertLifecycleTombstoneAbsent(teamName, agentName, lifecycleLock.read());
    return withLock(teamConfigPath, async () => {
      if (!fs.existsSync(teamConfigPath)) {
        throw new Error(`Cannot send message to ${agentName}: agent is not running.`);
      }
      const config = JSON.parse(fs.readFileSync(teamConfigPath, "utf-8")) as TeamConfig;
      const recipient = Array.isArray(config.members)
        ? config.members.find(member => member.name === agentName)
        : undefined;
      if (
        !recipient
        || recipient.isActive === false
        || (options.expectedRecipientRunId !== undefined && recipient.lifecycleRunId !== options.expectedRecipientRunId)
      ) {
        throw new Error(`Cannot send message to ${agentName}: agent is not running.`);
      }
      return appendUnderInboxLock();
    });
  });
}

export async function requireRunningMessageRecipient(teamName: string, recipient: string): Promise<void> {
  if (recipient === "team-lead") return;
  const teamConfigPath = configPath(teamName);
  await withLifecycleTombstoneLock(teamName, recipient, async lifecycleLock => {
    assertLifecycleTombstoneAbsent(teamName, recipient, lifecycleLock.read());
    await withLock(teamConfigPath, async () => {
      if (!fs.existsSync(teamConfigPath)) throw new Error(`Cannot send message to ${recipient}: agent is not running.`);
      const config = JSON.parse(fs.readFileSync(teamConfigPath, "utf-8")) as TeamConfig;
      const recipientMember = config.members.find(member => member.name === recipient);
      if (!recipientMember || recipientMember.isActive === false) {
        throw new Error(`Cannot send message to ${recipient}: agent is not running.`);
      }
    });
  });
}

export async function sendPlainMessageIfRunning(
  teamName: string,
  fromName: string,
  toName: string,
  text: string,
  summary: string,
  color?: string,
  options: MessageMetadataOptions = {}
): Promise<void> {
  const message = buildInboxMessage(fromName, text, summary, { ...options, color });
  await appendRunningMessage(teamName, toName, message, {
    expectedRecipientRunId: options.expectedRecipientRunId,
  });
}

function ensureInboxFile(teamName: string, agentName: string): string {
  const p = inboxPath(teamName, agentName);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return p;
}

function readInboxRaw(p: string): InboxMessage[] {
  if (!fs.existsSync(p)) return [];
  const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Array.isArray(parsed) ? parsed : [];
}

export function messageOperationMatches(message: InboxMessage, operationId: string, workflowRunId?: string): boolean {
  const messageOperationId = message.operationId || message.metadata?.operationId;
  const messageWorkflowRunId = message.workflowRunId || message.metadata?.workflowRunId;
  return messageOperationId === operationId && (workflowRunId === undefined || messageWorkflowRunId === workflowRunId);
}

function cloneInboxMessage(message: InboxMessage): InboxMessage {
  return {
    ...message,
    metadata: message.metadata ? { ...message.metadata } : undefined,
  };
}

function cloneInboxMessages(messages: InboxMessage[]): InboxMessage[] {
  return messages.map(cloneInboxMessage);
}

function normalizeInboxLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("Inbox limit must be a non-negative integer");
  }
  return limit;
}

function selectInboxMessages(allMsgs: InboxMessage[], unreadOnly: boolean, limit?: number): InboxMessage[] {
  const matches = (message: InboxMessage) => !unreadOnly || !message.read;

  if (limit === undefined) {
    return unreadOnly ? allMsgs.filter(matches) : allMsgs;
  }

  const normalizedLimit = normalizeInboxLimit(limit);
  if (normalizedLimit === 0) return [];

  const result: InboxMessage[] = [];
  for (let index = allMsgs.length - 1; index >= 0 && result.length < normalizedLimit; index--) {
    const message = allMsgs[index];
    if (matches(message)) result.push(message);
  }

  return result.reverse();
}

function markMessagesRead(messages: InboxMessage[]): boolean {
  let changed = false;
  for (const message of messages) {
    if (!message.read) {
      message.read = true;
      changed = true;
    }
  }
  return changed;
}

export async function appendMessage(teamName: string, agentName: string, message: InboxMessage) {
  const p = ensureInboxFile(teamName, agentName);

  await withLock(p, async () => {
    const msgs = readInboxRaw(p);
    msgs.push(message);
    fs.writeFileSync(p, JSON.stringify(msgs, null, 2));
  });
}

export async function appendMessageOnce(
  teamName: string,
  agentName: string,
  message: InboxMessage & { operationId: string }
): Promise<SendPlainMessageOnceResult> {
  const p = ensureInboxFile(teamName, agentName);

  return await withLock(p, async () => {
    const msgs = readInboxRaw(p);
    const existing = msgs.find((item) => messageOperationMatches(item, message.operationId, message.workflowRunId));
    if (existing) return { message: existing, delivered: false };

    msgs.push(message);
    fs.writeFileSync(p, JSON.stringify(msgs, null, 2));
    return { message, delivered: true };
  });
}

export async function appendMessageOnceIfRunning(
  teamName: string,
  agentName: string,
  message: InboxMessage & { operationId: string },
  options: Pick<MessageMetadataOptions, "expectedRecipientRunId"> = {}
): Promise<SendPlainMessageOnceResult> {
  return appendRunningMessage(teamName, agentName, message, {
    operationId: message.operationId,
    workflowRunId: message.workflowRunId,
    expectedRecipientRunId: options.expectedRecipientRunId,
  });
}

export async function readInbox(
  teamName: string,
  agentName: string,
  unreadOnly = false,
  markAsRead = true
): Promise<InboxMessage[]> {
  const p = inboxPath(teamName, agentName);
  if (!fs.existsSync(p)) return [];

  return await withLock(p, async () => {
    const allMsgs = readInboxRaw(p);
    const result = selectInboxMessages(allMsgs, unreadOnly);

    if (markAsRead && result.length > 0 && markMessagesRead(result)) {
      fs.writeFileSync(p, JSON.stringify(allMsgs, null, 2));
    }

    return cloneInboxMessages(result);
  });
}

export async function readInboxTail(
  teamName: string,
  agentName: string,
  limit: number,
  options: ReadInboxTailOptions = {}
): Promise<InboxMessage[]> {
  const normalizedLimit = normalizeInboxLimit(limit);
  const p = inboxPath(teamName, agentName);
  if (!fs.existsSync(p)) return [];

  return await withLock(p, async () => {
    const allMsgs = readInboxRaw(p);
    const result = selectInboxMessages(allMsgs, options.unreadOnly === true, normalizedLimit);

    if (options.markAsRead === true && result.length > 0 && markMessagesRead(result)) {
      fs.writeFileSync(p, JSON.stringify(allMsgs, null, 2));
    }

    return cloneInboxMessages(result);
  });
}

export async function removeInboxMessagesByOperationUnderLifecycleLock(
  teamName: string,
  agentName: string,
  operationId: string,
  workflowRunId?: string
): Promise<number> {
  const p = inboxPath(teamName, agentName);
  if (!fs.existsSync(p)) return 0;

  return withLock(p, async () => {
    if (!fs.existsSync(p)) return 0;
    const messages = readInboxRaw(p);
    const remaining = messages.filter((message) => !messageOperationMatches(message, operationId, workflowRunId));
    const removed = messages.length - remaining.length;
    if (removed > 0) fs.writeFileSync(p, JSON.stringify(remaining, null, 2));
    return removed;
  });
}

export async function findInboxMessageByOperation(
  teamName: string,
  agentName: string,
  operationId: string,
  workflowRunId?: string
): Promise<InboxMessage | undefined> {
  const p = inboxPath(teamName, agentName);
  if (!fs.existsSync(p)) return undefined;

  return await withLock(p, async () => {
    const message = readInboxRaw(p).find((item) => messageOperationMatches(item, operationId, workflowRunId));
    return message ? cloneInboxMessage(message) : undefined;
  });
}

export function buildInboxMessage(
  fromName: string,
  text: string,
  summary: string,
  options: SendPlainMessageOptions = {}
): InboxMessage {
  return {
    id: options.id || crypto.randomUUID(),
    from: fromName,
    text,
    timestamp: nowIso(),
    read: false,
    summary,
    color: options.color,
    operationId: options.operationId,
    workflowRunId: options.workflowRunId,
    metadata: options.metadata,
  };
}

export async function sendPlainMessage(
  teamName: string,
  fromName: string,
  toName: string,
  text: string,
  summary: string,
  color?: string,
  options: MessageMetadataOptions = {}
) {
  const msg = buildInboxMessage(fromName, text, summary, { ...options, color });
  await appendMessage(teamName, toName, msg);
}

export async function sendPlainMessageOnce(
  teamName: string,
  fromName: string,
  toName: string,
  text: string,
  summary: string,
  options: SendPlainMessageOptions & { operationId: string }
): Promise<SendPlainMessageOnceResult> {
  const msg = buildInboxMessage(fromName, text, summary, options) as InboxMessage & { operationId: string };
  return await appendMessageOnce(teamName, toName, msg);
}

export async function sendPlainMessageOnceIfRunning(
  teamName: string,
  fromName: string,
  toName: string,
  text: string,
  summary: string,
  options: SendPlainMessageOptions & { operationId: string }
): Promise<SendPlainMessageOnceResult> {
  const msg = buildInboxMessage(fromName, text, summary, options) as InboxMessage & { operationId: string };
  return appendMessageOnceIfRunning(teamName, toName, msg, {
    expectedRecipientRunId: options.expectedRecipientRunId,
  });
}

export async function peekInbox(
  teamName: string,
  agentName: string,
  unreadOnly = false
): Promise<InboxMessage[]> {
  return await readInbox(teamName, agentName, unreadOnly, false);
}

/**
 * Broadcasts a message to all team members except the sender.
 * @param teamName The name of the team
 * @param fromName The name of the sender
 * @param text The message text
 * @param summary A short summary of the message
 * @param color An optional color for the message
 */
export async function broadcastMessage(
  teamName: string,
  fromName: string,
  text: string,
  summary: string,
  color?: string,
  options: MessageMetadataOptions = {}
) {
  const config = await readConfig(teamName);

  // Create an array of delivery promises for all members except the sender
  const deliveryPromises = config.members
    .filter((member) => member.name !== fromName)
    .map((member) => sendPlainMessageIfRunning(teamName, fromName, member.name, text, summary, color, options));

  // Execute deliveries in parallel and wait for all to settle
  const results = await Promise.allSettled(deliveryPromises);

  // Log failures for diagnostics
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 0) {
    console.error(`Broadcast partially failed: ${failures.length} messages could not be delivered.`);
    // Optionally log individual errors
    failures.forEach((f) => console.error(`- Delivery error:`, f.reason));
  }
}

export async function broadcastMessageOnce(
  teamName: string,
  fromName: string,
  text: string,
  summary: string,
  options: SendPlainMessageOptions & { operationId: string }
): Promise<Array<SendPlainMessageOnceResult & { recipient: string }>> {
  const config = await readConfig(teamName);
  const deliveryPromises = config.members
    .filter((member) => member.name !== fromName)
    .map(async (member) => ({ recipient: member.name, ...(await sendPlainMessageOnceIfRunning(teamName, fromName, member.name, text, summary, options)) }));

  return await Promise.all(deliveryPromises);
}
