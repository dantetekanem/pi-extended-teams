export interface SessionUsageSummary {
  tokensUsed?: number;
  costUsd?: number;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function assistantMessageKey(message: any): string | undefined {
  if (!message || message.role !== "assistant") return undefined;
  const timestamp = numberOrZero(message.timestamp);
  const provider = typeof message.provider === "string" ? message.provider : "";
  const model = typeof message.model === "string" ? message.model : "";
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
  return `${timestamp}:${provider}:${model}:${stopReason}`;
}

function usageTokens(usage: any): number {
  return (
    numberOrZero(usage?.input) +
    numberOrZero(usage?.output) +
    numberOrZero(usage?.cacheRead) +
    numberOrZero(usage?.cacheWrite)
  );
}

function addAssistantUsage(message: any, totals: { tokens: number; cost: number; seen: boolean }): void {
  if (!message || message.role !== "assistant" || !message.usage) return;
  totals.tokens += usageTokens(message.usage);
  totals.cost += numberOrZero(message.usage.cost?.total);
  totals.seen = true;
}

export function summarizeSessionUsage(ctx: any, currentAssistantMessage?: any): SessionUsageSummary {
  const sessionManager = ctx?.sessionManager;
  const entries = typeof sessionManager?.getBranch === "function"
    ? sessionManager.getBranch()
    : typeof sessionManager?.getEntries === "function"
      ? sessionManager.getEntries()
      : [];

  const totals = { tokens: 0, cost: 0, seen: false };
  const currentKey = assistantMessageKey(currentAssistantMessage);
  let currentAlreadyIncluded = false;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const message = entry?.type === "message" ? entry.message : entry?.message;
    if (!message || message.role !== "assistant") continue;
    if (currentKey && assistantMessageKey(message) === currentKey) currentAlreadyIncluded = true;
    addAssistantUsage(message, totals);
  }

  if (currentAssistantMessage && !currentAlreadyIncluded) {
    addAssistantUsage(currentAssistantMessage, totals);
  }

  return totals.seen ? { tokensUsed: totals.tokens, costUsd: totals.cost } : {};
}
