import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createCombinedSessionCost, recordedSessionCost, COST_ENTRY_TYPE } from "./session-cost.js";

const usage = (total: number) => ({ cost: { total } });
const message = (role: string, total?: number) => ({ type: "message", message: { role, ...(total === undefined ? {} : { usage: usage(total) }) } });
function harness() {
  const handlers = new Map<string, Function>();
  const entries: any[] = [];
  let root = "root-a";
  const events = new EventEmitter();
  const pi = {
    events: {
      emit: vi.fn((name, data) => events.emit(name, data)),
      on: (name: string, handler: (...args: any[]) => void) => {
        events.on(name, handler);
        return () => events.off(name, handler);
      },
    },
    on: (event: string, handler: Function) => handlers.set(event, handler),
    appendEntry: vi.fn((customType, data) => { entries.push({ type: "custom", customType, data }); }),
  };
  const ctx = { sessionManager: { getEntries: () => entries, getSessionId: () => root } };
  const cost = createCombinedSessionCost(pi as any);
  handlers.get("session_start")!({}, ctx);
  return { cost, entries, pi, ctx, handlers, switchTo: (id: string) => { root = id; handlers.get("session_start")!({}, ctx); } };
}

function reloadedHost(entries: any[], root: string) {
  const handlers = new Map<string, Function>();
  const events = new EventEmitter();
  const pi = {
    events: { emit: vi.fn((name, data) => events.emit(name, data)), on: (name: string, handler: (...args: any[]) => void) => {
      events.on(name, handler);
      return () => events.off(name, handler);
    } },
    on: (event: string, handler: Function) => handlers.set(event, handler),
    appendEntry: vi.fn((customType, data) => entries.push({ type: "custom", customType, data })),
  };
  return { pi, handlers, ctx: { sessionManager: { getEntries: () => entries, getSessionId: () => root } } };
}

describe("combined Pi-recorded session cost", () => {
  it("serves live totals only to the current session's display, including incomplete and replayed costs", () => {
    const h = harness();
    const query = (sessionId = "root-a") => {
      const request = { sessionId, result: undefined };
      h.pi.events.emit("pi-extended-teams:cost-request", request);
      return request.result;
    };
    h.entries.push(message("assistant", 1));
    const run = h.cost.begin("root-a", "team", "display");
    expect(query()).toEqual({ usd: 1, complete: false });
    run.settle({ childSessionId: "child", costUsd: 2 }, "completed");
    expect(query()).toEqual({ usd: 3, complete: true });
    h.entries.push(message("assistant", 4));
    h.handlers.get("turn_end")!({}, h.ctx);
    expect(query()).toEqual({ usd: 7, complete: true });
    h.switchTo("fork-b");
    expect(query()).toBeUndefined();
    expect(query("fork-b")).toEqual({ usd: 7, complete: true });
    h.cost.deactivate();
    expect(query("fork-b")).toBeUndefined();
  });

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

  it("retains detached admissions until matching attach and settlement", () => {
    const h = harness();
    h.cost.detach();
    h.pi.appendEntry.mockImplementation(() => { throw new Error("old host used"); });
    h.ctx.sessionManager.getEntries = () => { throw new Error("old context used"); };
    h.ctx.sessionManager.getSessionId = () => { throw new Error("old context used"); };

    const run = h.cost.begin("root-a", "team", "detached");
    const fresh = reloadedHost(h.entries, "root-a");
    h.cost.attach(fresh.pi as any, fresh.ctx as any);
    expect(h.cost.total()).toEqual({ usd: 0, complete: false });
    expect(fresh.pi.appendEntry).not.toHaveBeenCalled();

    run.settle({ childSessionId: "child", costUsd: 2 }, "completed");
    expect(h.cost.total()).toEqual({ usd: 2, complete: true });
    expect(fresh.pi.appendEntry.mock.calls.filter(call => call[1].lifecycleRunId === "detached")).toHaveLength(1);
    h.cost.detach();
    h.cost.attach(fresh.pi as any, fresh.ctx as any);
    expect(fresh.pi.appendEntry.mock.calls.filter(call => call[1].lifecycleRunId === "detached")).toHaveLength(1);
  });

  it("replays only the first detached terminal receipt on attach", () => {
    const h = harness();
    h.cost.detach();
    h.pi.appendEntry.mockImplementation(() => { throw new Error("old host used"); });
    h.ctx.sessionManager.getEntries = () => { throw new Error("old context used"); };
    h.ctx.sessionManager.getSessionId = () => { throw new Error("old context used"); };

    const run = h.cost.begin("root-a", "team", "detached-terminal");
    run.settle({ childSessionId: "child", costUsd: 3 }, "completed");
    run.settle({ childSessionId: "later", costUsd: 99 }, "failed");
    const fresh = reloadedHost(h.entries, "root-a");
    h.cost.attach(fresh.pi as any, fresh.ctx as any);
    expect(h.cost.total()).toEqual({ usd: 3, complete: true });
    expect(fresh.pi.appendEntry).toHaveBeenCalledExactlyOnceWith(COST_ENTRY_TYPE,
      expect.objectContaining({ lifecycleRunId: "detached-terminal", phase: "final", outcome: "completed", costUsd: 3 }));
    h.cost.detach();
    h.cost.attach(fresh.pi as any, fresh.ctx as any);
    expect(fresh.pi.appendEntry).toHaveBeenCalledOnce();
  });

  it("detaches from invalidated hosts, restores matching roots once, and deactivates finally", () => {
    const h = harness();
    const run = h.cost.begin("root-a", "team", "reload");
    const retry = h.cost.begin("root-a", "team", "retry");
    h.pi.appendEntry.mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    retry.settle({ childSessionId: "retry-child", costUsd: 3 }, "completed");
    h.cost.detach();
    h.pi.appendEntry.mockImplementation(() => { throw new Error("old host used"); });
    h.ctx.sessionManager.getEntries = () => { throw new Error("old context used"); };
    h.ctx.sessionManager.getSessionId = () => { throw new Error("old context used"); };
    run.settle({ childSessionId: "child", costUsd: 2 }, "completed");
    const fresh = reloadedHost(h.entries, "root-a");
    h.cost.attach(fresh.pi as any, fresh.ctx as any);
    expect(h.cost.total()).toEqual({ usd: 5, complete: true });
    expect(fresh.pi.appendEntry.mock.calls.filter(call => call[1].lifecycleRunId === "reload")).toHaveLength(1);
    expect(fresh.pi.appendEntry.mock.calls.find(call => call[1].lifecycleRunId === "retry")?.[1].phase).toBe("final");
    h.cost.detach();
    h.cost.attach(fresh.pi as any, fresh.ctx as any);
    expect(fresh.pi.appendEntry.mock.calls.filter(call => call[1].lifecycleRunId === "reload")).toHaveLength(1);
    h.cost.detach();
    h.cost.attach(reloadedHost(h.entries, "other-root").pi as any, reloadedHost(h.entries, "other-root").ctx as any);
    expect(h.cost.total()).toEqual({ usd: 0, complete: false });
    h.cost.deactivate();
    expect(h.cost.total()).toEqual({ usd: 0, complete: false });
  });

  it("persists detached terminal cost even when the initial receipt was never appended", () => {
    const h = harness();
    h.pi.appendEntry.mockImplementationOnce(() => { throw new Error("initial write failed"); });
    const run = h.cost.begin("root-a", "team", "initially-unpersisted");
    h.cost.detach();
    run.settle({ childSessionId: "child", costUsd: 4 }, "completed");
    const fresh = reloadedHost(h.entries, "root-a");
    h.cost.attach(fresh.pi as any, fresh.ctx as any);
    expect(h.cost.total()).toEqual({ usd: 4, complete: true });
    expect(fresh.pi.appendEntry).toHaveBeenCalledExactlyOnceWith(COST_ENTRY_TYPE,
      expect.objectContaining({ lifecycleRunId: "initially-unpersisted", phase: "final", costUsd: 4 }));
    h.cost.detach();
    h.cost.attach(fresh.pi as any, fresh.ctx as any);
    expect(fresh.pi.appendEntry).toHaveBeenCalledOnce();
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
      h.pi.events.emit.mockClear();
      h.handlers.get(event)!({}, h.ctx);
      expect(h.pi.events.emit).toHaveBeenCalledWith("pi-extended-teams:cost-changed", undefined);
    }
    expect(h.cost.total()).toEqual({ usd: 4, complete: true });
    const pending = h.cost.begin("root-b", "team", "shutdown");
    h.cost.deactivate();
    pending.settle({ childSessionId: "shutdown-child", costUsd: 20 }, "cancelled");
    expect(h.entries.filter(entry => entry.data?.lifecycleRunId === "shutdown")).toHaveLength(1);
  });
});
