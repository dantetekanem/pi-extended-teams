import { describe, expect, it, vi } from "vitest";
import { createCombinedSessionCost, recordedSessionCost, COST_ENTRY_TYPE } from "./session-cost.js";

const usage = (total: number) => ({ cost: { total } });
const message = (role: string, total?: number) => ({ type: "message", message: { role, ...(total === undefined ? {} : { usage: usage(total) }) } });
function harness() {
  const handlers = new Map<string, Function>();
  const entries: any[] = [];
  let root = "root-a";
  const status = vi.fn();
  const pi = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    appendEntry: vi.fn((customType, data) => { entries.push({ type: "custom", customType, data }); }),
  };
  const ctx = { sessionManager: { getEntries: () => entries, getSessionId: () => root }, ui: { setStatus: status } };
  const cost = createCombinedSessionCost(pi as any);
  handlers.get("session_start")!({}, ctx);
  return { cost, entries, pi, ctx, status, handlers, switchTo: (id: string) => { root = id; handlers.get("session_start")!({}, ctx); } };
}

describe("combined Pi-recorded session cost", () => {
  it("sums all own assistant/tool/summary usage, never retained tails or custom subtotals", () => {
    const entries = [message("assistant", 1), message("toolResult", 2), message("toolResult"),
      { type: "compaction", usage: usage(3), retainedTail: [message("assistant", 90)] },
      { type: "branch_summary", usage: usage(4) }, { type: "custom", usage: usage(100) }];
    const original = structuredClone(entries);
    expect(recordedSessionCost(entries)).toEqual({ usd: 10, complete: true });
    expect(entries).toEqual(original);
    for (const entry of [message("assistant"), message("assistant", -1), message("assistant", Infinity),
      { type: "compaction" }, { type: "branch_summary" }]) {
      expect(recordedSessionCost([entry])).toEqual({ usd: 0, complete: false });
    }
    expect(recordedSessionCost([message("assistant", 0)])).toEqual({ usd: 0, complete: true });
  });

  it("deduplicates public-entry replay by root/team/run and child session while counting new runs and nested own spend", () => {
    const h = harness();
    h.entries.push(message("assistant", 1));
    const run = h.cost.begin("root-a", "team", "run-1");
    expect(h.cost.total()).toEqual({ usd: 1, complete: false });
    run.settle({ childSessionId: "child-a", costUsd: 2 }, "completed");
    run.settle({ childSessionId: "child-a", costUsd: 2 }, "completed");
    h.cost.begin("root-a", "team", "run-2").settle({ childSessionId: "child-b", costUsd: 3 }, "failed");
    h.cost.begin("root-a", "nested-team", "run-3").settle({ childSessionId: "child-c", costUsd: 4 }, "cancelled");
    h.cost.begin("root-a", "team", "run-4").settle({ childSessionId: "child-a", costUsd: 2 }, "completed");
    expect(h.cost.total()).toEqual({ usd: 10, complete: true });
    h.entries.push(...structuredClone(h.entries.filter(entry => entry.type === "custom")));
    h.switchTo("fork-b");
    expect(h.cost.total()).toEqual({ usd: 10, complete: true });
    expect(h.entries.filter(entry => entry.customType === COST_ENTRY_TYPE).every(entry => entry.data.rootSessionId === "root-a")).toBe(true);
    h.cost.begin("fork-b", "team", "run-1").settle({ childSessionId: "child-d", costUsd: 5 }, "completed");
    expect(h.cost.total()).toEqual({ usd: 15, complete: true });
  });

  it("keeps missing snapshots and failed final persistence incomplete, and reconciles failed pending writes", () => {
    const h = harness();
    h.cost.begin("root-a", "team", "zero").settle({ childSessionId: "zero-child", costUsd: 0 }, "completed");
    expect(h.cost.total()).toEqual({ usd: 0, complete: true });
    h.cost.begin("root-a", "team", "unknown").settle(undefined, "failed");
    const run = h.cost.begin("root-a", "team", "pending");
    h.pi.appendEntry.mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    run.settle({ childSessionId: "child", costUsd: 2 }, "completed");
    h.switchTo("root-a");
    expect(h.cost.total()).toEqual({ usd: 0, complete: false });
    h.pi.appendEntry.mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    const unpersisted = h.cost.begin("root-a", "team", "unpersisted");
    expect(h.cost.total().complete).toBe(false);
    unpersisted.settle({ childSessionId: "recovered", costUsd: 3 }, "completed");
    expect(h.cost.total()).toEqual({ usd: 3, complete: false });
  });

  it("binds callbacks to their origin, excludes terminal handoffs, and refreshes only on post-persistence events", () => {
    const h = harness();
    const late = h.cost.begin("root-a", "team", "late");
    h.cost.begin("root-a", "team", "terminal").exclude();
    const before = h.pi.appendEntry.mock.calls.length;
    h.switchTo("root-b");
    late.settle({ childSessionId: "late-child", costUsd: 100 }, "cancelled");
    expect(h.pi.appendEntry).toHaveBeenCalledTimes(before);
    h.cost.begin("root-a", "team", "stale-nested").settle({ childSessionId: "stale", costUsd: 1 }, "completed");
    expect(h.pi.appendEntry).toHaveBeenCalledTimes(before);
    h.entries.length = 0;
    h.switchTo("root-b");
    expect(h.cost.total()).toEqual({ usd: 0, complete: true });
    expect(h.handlers.has("message_end")).toBe(false);
    for (const event of ["turn_end", "agent_end", "session_compact", "session_tree"]) {
      h.entries.push(message("assistant", 1));
      h.status.mockClear();
      h.handlers.get(event)!({}, h.ctx);
      expect(h.status).toHaveBeenCalledOnce();
    }
    expect(h.cost.total()).toEqual({ usd: 4, complete: true });
    const pending = h.cost.begin("root-b", "team", "shutdown");
    h.cost.deactivate();
    pending.settle({ childSessionId: "shutdown-child", costUsd: 20 }, "cancelled");
    expect(h.entries.filter(entry => entry.data?.lifecycleRunId === "shutdown")).toHaveLength(1);
  });
});
