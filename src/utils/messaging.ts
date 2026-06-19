import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { InboxMessage } from "./models";
import { withLock } from "./lock";
import { inboxPath } from "./paths";
import { readConfig } from "./teams";

export interface MessageMetadataOptions {
  id?: string;
  operationId?: string;
  workflowRunId?: string;
  metadata?: Record<string, any>;
}

export interface SendPlainMessageOptions extends MessageMetadataOptions {
  color?: string;
}

export interface SendPlainMessageOnceResult {
  message: InboxMessage;
  delivered: boolean;
}

export function nowIso(): string {
  return new Date().toISOString();
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

function messageOperationMatches(message: InboxMessage, operationId: string, workflowRunId?: string): boolean {
  const messageOperationId = message.operationId || message.metadata?.operationId;
  const messageWorkflowRunId = message.workflowRunId || message.metadata?.workflowRunId;
  return messageOperationId === operationId && (workflowRunId === undefined || messageWorkflowRunId === workflowRunId);
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
    let result = allMsgs;

    if (unreadOnly) {
      result = allMsgs.filter(m => !m.read);
    }

    if (markAsRead && result.length > 0) {
      for (const m of allMsgs) {
        if (result.includes(m)) {
          m.read = true;
        }
      }
      fs.writeFileSync(p, JSON.stringify(allMsgs, null, 2));
    }

    return result;
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
    .map((member) => sendPlainMessage(teamName, fromName, member.name, text, summary, color, options));

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
    .map(async (member) => ({ recipient: member.name, ...(await sendPlainMessageOnce(teamName, fromName, member.name, text, summary, options)) }));

  return await Promise.all(deliveryPromises);
}
