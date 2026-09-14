import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export const COST_ENTRY_TYPE = "pi-extended-teams-cost-v1";
export type CostOutcome = "completed" | "failed" | "cancelled";
export interface AgentCostSnapshot { childSessionId: string; costUsd: number | null }
export interface CostRun {
  settle(snapshot: AgentCostSnapshot | undefined, outcome: CostOutcome): void;
  exclude(): void;
}
interface Receipt {
  rootSessionId: string;
  teamName: string;
  lifecycleRunId: string;
  phase: "pending" | "final" | "excluded";
  childSessionId?: string;
  costUsd?: number | null;
  outcome?: CostOutcome;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const validCost = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const identity = (receipt: Receipt) => JSON.stringify([receipt.rootSessionId, receipt.teamName, receipt.lifecycleRunId]);

export function recordedSessionCost(entries: readonly unknown[]): { usd: number; complete: boolean } {
  let usd = 0;
  let complete = true;
  for (const item of entries) {
    const entry = object(item);
    const message = object(entry.message);
    const summary = entry.type === "compaction" || entry.type === "branch_summary";
    const assistant = entry.type === "message" && message.role === "assistant";
    const tool = entry.type === "message" && message.role === "toolResult";
    if (!summary && !assistant && !tool) continue;
    const usage = summary ? entry.usage : message.usage;
    if (tool && usage === undefined) continue; // Optional native nested-tool accounting.
    const cost = object(object(usage).cost).total;
    if (validCost(cost) && validCost(usd + cost)) usd += cost;
    else complete = false; // Includes legacy summaries without recorded usage.
  }
  return { usd, complete };
}

export function createCombinedSessionCost(pi: Pick<ExtensionAPI, "on" | "appendEntry">) {
  let scope: { root: string; ctx: ExtensionContext; failed: Set<string>; pending: Map<string, Receipt> } | undefined;
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
  const total = () => {
    try {
      if (!scope || scope.ctx.sessionManager.getSessionId() !== scope.root) return { usd: 0, complete: false };
      const entries = scope.ctx.sessionManager.getEntries();
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
    if (!scope) return;
    const result = total();
    try {
      scope.ctx.ui.setStatus("pi-extended-teams-cost", `Combined $${result.usd.toFixed(4)} USD · main + finalized in-process · Pi-recorded${result.complete ? "" : " · incomplete"}`);
    } catch { /* Status observers must not affect lifecycle cleanup. */ }
  };
  pi.on("session_start", (_event, ctx) => {
    scope = { root: ctx.sessionManager.getSessionId(), ctx, failed: new Set(), pending: new Map() };
    refresh();
  });
  pi.on("turn_end", refresh);
  pi.on("agent_end", refresh);
  pi.on("session_compact", refresh);
  pi.on("session_tree", refresh);
  return {
    total,
    deactivate() {
      try { scope?.ctx.ui.setStatus("pi-extended-teams-cost", undefined); } catch { /* Best effort only. */ }
      scope = undefined;
    },
    begin(rootSessionId: string, teamName: string, lifecycleRunId: string): CostRun {
      const origin = scope;
      if (!origin || origin.root !== rootSessionId) return { settle() {}, exclude() {} };
      const pending: Receipt = { rootSessionId, teamName, lifecycleRunId, phase: "pending" };
      const key = identity(pending);
      const active = () => scope === origin && origin.ctx.sessionManager.getSessionId() === rootSessionId;
      const append = (receipt: Receipt) => {
        try {
          if (!active()) return false;
          pi.appendEntry(COST_ENTRY_TYPE, receipt);
          origin.failed.delete(key);
          origin.pending.delete(key);
          refresh();
          return true;
        } catch {
          origin.failed.add(key);
          origin.pending.set(key, pending);
          refresh();
          return false;
        }
      };
      try {
        if (!receipts(origin.ctx.sessionManager.getEntries()).runs.has(key)) append(pending);
      } catch { origin.failed.add(key); origin.pending.set(key, pending); refresh(); }
      const finish = (receipt: Receipt) => {
        try {
          if (!active()) return;
          const previous = origin.pending.get(key) ?? receipts(origin.ctx.sessionManager.getEntries()).runs.get(key);
          if (previous?.phase !== "pending") return;
          append(receipt);
        } catch { origin.failed.add(key); refresh(); }
      };
      return {
        settle: (snapshot, outcome) => finish({ ...pending, phase: "final", outcome,
          childSessionId: snapshot?.childSessionId, costUsd: snapshot?.costUsd ?? null }),
        exclude: () => finish({ ...pending, phase: "excluded" }),
      };
    },
  };
}
