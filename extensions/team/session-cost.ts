import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export const COST_ENTRY_TYPE = "pi-extended-teams-cost-v1";
export type CostOutcome = "completed" | "failed" | "cancelled";
export interface RecordedUsage {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  totalTokens?: number | null;
  /** Reasoning tokens are a subset of output, never an additional contribution. */
  reasoning?: number | null;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  } | null;
}
export interface RecordedUsageEntry {
  id?: string;
  type: "message" | "compaction" | "branch_summary" | "usage";
  timestamp?: string | number;
  message?: {
    role: "assistant" | "toolResult";
    provider?: string;
    model?: string;
    responseModel?: string;
    timestamp?: number;
    durationMs?: number;
    stopReason?: string;
    usage?: RecordedUsage | null;
  };
  kind?: string;
  provider?: string;
  model?: string;
  usage?: RecordedUsage | null;
}
export interface AgentUsageTelemetry {
  schemaVersion: 1;
  agentName: string;
  role: "read" | "write";
  startedAt: number;
  completedAt: number;
  parentLifecycleRunId?: string;
  modelSlot?: string;
  entries: RecordedUsageEntry[];
}
export interface AgentCostSnapshot {
  childSessionId: string;
  costUsd: number | null;
  telemetry?: AgentUsageTelemetry;
}
export interface CostRun {
  settle(snapshot: AgentCostSnapshot | undefined, outcome: CostOutcome): void;
  exclude(): void;
}
export type SessionCostContext = Pick<ExtensionContext, "sessionManager">;
type CostHost = Pick<ExtensionAPI, "on" | "appendEntry" | "events">;
interface Receipt {
  rootSessionId: string;
  teamName: string;
  lifecycleRunId: string;
  phase: "pending" | "final" | "excluded";
  childSessionId?: string;
  costUsd?: number | null;
  outcome?: CostOutcome;
  telemetry?: AgentUsageTelemetry;
}
interface Scope {
  root: string;
  failed: Set<string>;
  pending: Map<string, Receipt>;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const validCost = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const identity = (receipt: Receipt) => JSON.stringify([receipt.rootSessionId, receipt.teamName, receipt.lifecycleRunId]);

function recordedUsage(value: unknown): RecordedUsage | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const source = object(value);
  const usage: RecordedUsage = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "reasoning"] as const) {
    if (source[key] === null || validCost(source[key])) usage[key] = source[key];
  }
  if (source.cost === null) usage.cost = null;
  else if (source.cost && typeof source.cost === "object") {
    usage.cost = {};
    const cost = object(source.cost);
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      if (validCost(cost[key])) usage.cost[key] = cost[key];
    }
  }
  return usage;
}

/** Own native evidence only: never recurse into content, retained tails or descendant receipts. */
export function recordedUsageEntries(entries: readonly unknown[]): RecordedUsageEntry[] {
  const result: RecordedUsageEntry[] = [];
  for (const item of entries) {
    const entry = object(item);
    const message = object(entry.message);
    if (entry.type !== "message" && entry.type !== "compaction" && entry.type !== "branch_summary" && entry.type !== "usage") {
      continue;
    }
    if (entry.type === "message" && message.role !== "assistant" && !(message.role === "toolResult" && message.usage !== undefined)) {
      continue;
    }
    const selected: RecordedUsageEntry = { type: entry.type };
    if (typeof entry.id === "string") selected.id = entry.id;
    if (typeof entry.timestamp === "string" || validCost(entry.timestamp)) selected.timestamp = entry.timestamp;
    if (entry.type === "message") {
      const own: NonNullable<RecordedUsageEntry["message"]> = { role: message.role as "assistant" | "toolResult" };
      if (message.role === "assistant") {
        for (const key of ["provider", "model", "responseModel", "stopReason"] as const) {
          if (typeof message[key] === "string") own[key] = message[key];
        }
        for (const key of ["timestamp", "durationMs"] as const) {
          if (validCost(message[key])) own[key] = message[key];
        }
      }
      const usage = recordedUsage(message.usage);
      if (usage !== undefined) own.usage = usage;
      selected.message = own;
    } else {
      if (entry.type === "usage") {
        for (const key of ["kind", "provider", "model"] as const) {
          if (typeof entry[key] === "string") selected[key] = entry[key];
        }
      }
      const usage = recordedUsage(entry.usage);
      if (usage !== undefined) selected.usage = usage;
    }
    result.push(selected);
  }
  return result;
}

export function recordedSessionCost(entries: readonly unknown[]): { usd: number; complete: boolean } {
  let usd = 0;
  let complete = true;
  for (const item of entries) {
    const entry = object(item);
    const message = object(entry.message);
    const summary = entry.type === "compaction" || entry.type === "branch_summary";
    const assistant = entry.type === "message" && message.role === "assistant";
    const tool = entry.type === "message" && message.role === "toolResult";
    const standalone = entry.type === "usage";
    if (!summary && !assistant && !tool && !standalone) continue;
    const usage = summary || standalone ? entry.usage : message.usage;
    if (tool && usage === undefined) continue; // Optional native nested-tool accounting.
    const cost = object(object(usage).cost).total;
    if (validCost(cost) && validCost(usd + cost)) usd += cost;
    else complete = false; // Includes legacy summaries without recorded usage.
  }
  return { usd, complete };
}

export function createCombinedSessionCost(initialHost: CostHost) {
  let scope: Scope | undefined;
  let host: CostHost | undefined;
  let context: SessionCostContext | undefined;
  let displayTotal: ReturnType<typeof recordedSessionCost> | undefined;
  let unsubscribeDisplay: (() => void) | undefined;
  let listenerGeneration = 0;
  const receipts = (entries: readonly unknown[]) => {
    const runs = new Map<string, Receipt>();
    let complete = true;
    for (const item of entries) {
      const entry = object(item);
      if (entry.type !== "custom" || entry.customType !== COST_ENTRY_TYPE) continue;
      const data = object(entry.data);
      if (![data.rootSessionId, data.teamName, data.lifecycleRunId].every(value => typeof value === "string" && value.length > 0)
        || !["pending", "final", "excluded"].includes(String(data.phase))
        || (data.phase === "final" && (!["completed", "failed", "cancelled"].includes(String(data.outcome))
          || !(data.costUsd === null || (validCost(data.costUsd) && typeof data.childSessionId === "string" && data.childSessionId.length > 0))))) {
        complete = false;
        continue;
      }
      const receipt = data as unknown as Receipt;
      const key = identity(receipt);
      if (!runs.has(key) || runs.get(key)?.phase === "pending") runs.set(key, receipt);
    }
    return { runs, complete };
  };
  const active = () => !!scope && !!host && !!context && context.sessionManager.getSessionId() === scope.root;
  const total = () => {
    try {
      if (!active() || !scope || !context) return { usd: 0, complete: false };
      const entries = context.sessionManager.getEntries();
      const own = recordedSessionCost(entries);
      const replay = receipts(entries);
      let complete = own.complete && replay.complete && scope.failed.size === 0;
      let usd = own.usd;
      const sessions = new Set([scope.root]);
      for (const [key, receipt] of new Map([...replay.runs, ...scope.pending])) {
        if (receipt.phase === "excluded") continue;
        if (scope.failed.has(key) || receipt.phase !== "final" || !validCost(receipt.costUsd) || !receipt.childSessionId) {
          complete = false;
          continue;
        }
        if (sessions.has(receipt.childSessionId)) continue;
        sessions.add(receipt.childSessionId);
        if (validCost(usd + receipt.costUsd)) usd += receipt.costUsd;
        else complete = false;
      }
      return { usd, complete };
    } catch { return { usd: 0, complete: false }; }
  };
  const refresh = () => {
    if (!host) {
      displayTotal = undefined;
      return;
    }
    displayTotal = total();
    try { host.events.emit("pi-extended-teams:cost-changed", undefined); }
    catch { /* Display observers must not affect lifecycle cleanup. */ }
  };
  const append = (origin: Scope, key: string, receipt: Receipt) => {
    if (!active() || scope !== origin || !host) return false;
    try {
      host.appendEntry(COST_ENTRY_TYPE, receipt);
      origin.failed.delete(key);
      origin.pending.delete(key);
      refresh();
      return true;
    } catch {
      // Keep the terminal receipt, not its pending predecessor, for reload retry.
      origin.failed.add(key);
      origin.pending.set(key, receipt);
      refresh();
      return false;
    }
  };
  const listen = (nextHost: CostHost) => {
    host = nextHost;
    const generation = ++listenerGeneration;
    unsubscribeDisplay = nextHost.events.on("pi-extended-teams:cost-request", (value) => {
      const request = object(value);
      if (generation === listenerGeneration && scope && context && request.sessionId === scope.root
        && context.sessionManager.getSessionId() === scope.root) request.result = displayTotal;
    });
    nextHost.on("session_start", (_event, nextContext) => {
      if (generation !== listenerGeneration) return;
      const root = nextContext.sessionManager.getSessionId();
      if (!scope || scope.root !== root) scope = { root, failed: new Set(), pending: new Map() };
      context = nextContext;
      refresh();
    });
    const refreshCurrent = () => { if (generation === listenerGeneration) refresh(); };
    nextHost.on("turn_end", refreshCurrent);
    nextHost.on("agent_end", refreshCurrent);
    nextHost.on("session_compact", refreshCurrent);
    nextHost.on("session_tree", refreshCurrent);
  };
  const flushFinalReceipts = () => {
    if (!scope || !context) return;
    const durable = receipts(context.sessionManager.getEntries()).runs;
    for (const [key, receipt] of scope.pending) {
      if (receipt.phase === "pending") continue;
      const persisted = durable.get(key);
      if (persisted && persisted.phase !== "pending") {
        scope.pending.delete(key);
        scope.failed.delete(key);
      } else append(scope, key, receipt);
    }
  };
  const detach = () => {
    listenerGeneration++;
    unsubscribeDisplay?.();
    unsubscribeDisplay = undefined;
    host = undefined;
    context = undefined;
    displayTotal = undefined;
  };
  listen(initialHost);
  return {
    total,
    // The reload owner must pass the newly supplied context for this saved root; other roots are never adopted.
    attach(nextHost: CostHost, nextContext: SessionCostContext) {
      try {
        if (!scope || scope.root !== nextContext.sessionManager.getSessionId()) return false;
      } catch { return false; }
      detach();
      context = nextContext;
      listen(nextHost);
      try { flushFinalReceipts(); }
      catch { refresh(); }
      refresh();
      return true;
    },
    detach,
    deactivate() {
      detach();
      scope = undefined;
    },
    begin(rootSessionId: string, teamName: string, lifecycleRunId: string): CostRun {
      const origin = scope;
      if (!origin || origin.root !== rootSessionId) return { settle() {}, exclude() {} };
      const pending: Receipt = { rootSessionId, teamName, lifecycleRunId, phase: "pending" };
      const key = identity(pending);
      if (!origin.pending.has(key)) {
        if (!context) origin.pending.set(key, pending);
        else {
          try {
            if (!receipts(context.sessionManager.getEntries()).runs.has(key)) append(origin, key, pending);
          } catch { origin.failed.add(key); origin.pending.set(key, pending); refresh(); }
        }
      }
      const finish = (receipt: Receipt) => {
        if (scope !== origin) return;
        const previous = origin.pending.get(key);
        if (!active() || !context) {
          if (!previous || previous.phase === "pending") {
            origin.failed.add(key);
            origin.pending.set(key, receipt);
          }
          return;
        }
        try {
          const durable = receipts(context.sessionManager.getEntries()).runs.get(key);
          const current = previous ?? durable;
          if (current?.phase !== "pending") return;
          append(origin, key, receipt);
        } catch { origin.failed.add(key); origin.pending.set(key, receipt); refresh(); }
      };
      return {
        settle: (snapshot, outcome) => finish({
          ...pending,
          phase: "final",
          outcome,
          childSessionId: snapshot?.childSessionId,
          costUsd: snapshot?.costUsd ?? null,
          ...(snapshot?.telemetry ? { telemetry: snapshot.telemetry } : {}),
        }),
        exclude: () => finish({ ...pending, phase: "excluded" }),
      };
    },
  };
}
