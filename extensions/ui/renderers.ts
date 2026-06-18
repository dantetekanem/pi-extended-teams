import { Text, truncateToWidth } from "@mariozechner/pi-tui";
import { dimAnsi, pink, purple } from "./ansi";

const ANSI_ESCAPE_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\)|[PX^][^\x1b]*(?:\x1b\\|\x07)|[@-Z\\-_])/g;
const SAFE_SGR_SEQUENCE = /^\x1b\[[0-9;]*m$/;

export function sanitizeTuiText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "   ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F-\u009F]/g, "")
    .replace(ANSI_ESCAPE_SEQUENCE, (sequence) => SAFE_SGR_SEQUENCE.test(sequence) ? sequence : "")
    .replace(/\x1b(?!\[[0-9;]*m)/g, "");
}

export function sanitizeTuiLine(text: string): string {
  return sanitizeTuiText(text).replace(/\n/g, " ");
}

export function formatModelLabel(model?: string, thinking?: string): string {
  const shortModel = model ? model.split("/").pop() || model : "";
  const t = thinking && thinking !== "off" ? ` · ${thinking}` : "";
  return shortModel ? `${shortModel}${t}` : "";
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1000000) return `${(count / 1000).toFixed(count < 10000 ? 1 : 0)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function extractTextParts(content: any): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}

export function getLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    const text = extractTextParts(messages[i].content);
    if (text) return text;
  }
  return "";
}

export function formatTranscriptLines(messages: any[]): string[] {
  const out: string[] = [];
  for (const message of messages || []) {
    if (message?.role === "user") {
      const text = sanitizeTuiText(extractTextParts(message.content));
      if (text) out.push(`${pink("user ▸")} ${text}`);
    } else if (message?.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "text" && part.text?.trim()) out.push(sanitizeTuiText(part.text.trim()));
        else if (part?.type === "toolCall") out.push(purple(`⚙ ${sanitizeTuiLine(String(part.name || "tool"))}`));
      }
    } else if (message?.role === "toolResult") {
      const text = sanitizeTuiText(extractTextParts(message.content));
      const head = text.split("\n").find((line: string) => line.trim()) || "(no output)";
      out.push(dimAnsi(`  ↳ ${sanitizeTuiLine(String(message.toolName || "tool"))}: ${head}`));
    }
  }
  return out;
}

export function summarizeInboxMessage(message: any): string {
  const from = message?.from || "unknown";
  const summary = message?.summary || "message";
  const timestamp = message?.timestamp ? new Date(message.timestamp).toLocaleTimeString() : "";
  return `${from}${timestamp ? ` ${timestamp}` : ""}: ${summary}`;
}

export function formatInboxMessagesForModel(messages: any[]): string {
  if (messages.length === 0) return "No inbox messages.";

  return messages.map((message, index) => {
    const header = `[${index + 1}] ${summarizeInboxMessage(message)}`;
    const text = String(message?.text || "").trim() || "(empty message)";
    return `${header}\n${text}`;
  }).join("\n\n");
}

export function renderInboxMessages(result: any, expanded: boolean, theme: any) {
  const messages = result.details?.messages || [];
  if (messages.length === 0) {
    return new Text(theme.fg("muted", "inbox: no messages"), 0, 0);
  }

  const lines = [theme.fg("toolTitle", theme.bold(`inbox: ${messages.length} message${messages.length === 1 ? "" : "s"}`))];
  if (expanded) {
    for (const [index, message] of messages.entries()) {
      lines.push(theme.fg("muted", `\n${index + 1}. ${summarizeInboxMessage(message)}`));
      lines.push(String(message?.text || "").trim() || theme.fg("dim", "(empty message)"));
    }
  } else {
    for (const [index, message] of messages.slice(0, 5).entries()) {
      lines.push(truncateToWidth(`${index + 1}. ${summarizeInboxMessage(message)}`, 120));
    }
    if (messages.length > 5) lines.push(theme.fg("dim", `… ${messages.length - 5} more`));
    lines.push(theme.fg("dim", "expand tool output to read full message text"));
  }

  return new Text(lines.join("\n"), 0, 0);
}

export function formatTeammateStatusForModel(agentName: string, details: any): string {
  const heartbeat = details.hasRecentHeartbeat ? "fresh heartbeat" : "stale/no heartbeat";
  const ready = details.agentLoopReady ? "ready" : "not ready";
  const unread = `${details.unreadCount ?? 0} unread`;
  const released = details.releasedClaims?.length ? `; released claims: ${details.releasedClaims.join(", ")}` : "";
  return `${agentName}: ${details.health}; ${unread}; ${ready}; ${heartbeat}${released}`;
}

export function renderTeammateStatus(result: any, expanded: boolean, theme: any) {
  const details = result.details || {};
  const agentName = details.agentName || "teammate";
  const health = details.health || (details.alive ? "alive" : "dead");
  const color = health === "dead" || health === "stalled" ? "warning" : "success";
  const headline = `${agentName}: ${health} • ${details.unreadCount ?? 0} unread • ${details.agentLoopReady ? "ready" : "not ready"}`;

  if (!expanded) {
    return new Text(theme.fg(color, headline), 0, 0);
  }

  const runtimeStatus = details.runtime || {};
  const lines = [theme.fg(color, theme.bold(headline))];
  lines.push(`alive: ${details.alive ? "yes" : "no"}`);
  lines.push(`heartbeat: ${details.hasRecentHeartbeat ? "fresh" : "stale/missing"}`);
  if (runtimeStatus.startedAt) lines.push(`started: ${new Date(runtimeStatus.startedAt).toLocaleString()}`);
  if (runtimeStatus.lastHeartbeatAt) lines.push(`last heartbeat: ${new Date(runtimeStatus.lastHeartbeatAt).toLocaleString()}`);
  if (details.startupStalled) lines.push(theme.fg("warning", "startup appears stalled"));
  if (details.releasedClaims?.length) lines.push(`released claims: ${details.releasedClaims.join(", ")}`);
  return new Text(lines.join("\n"), 0, 0);
}
