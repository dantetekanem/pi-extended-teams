import { describe, expect, it, vi } from "vitest";
import { createPendingChildController, type ParentRunIdentity } from "./pending-child-controller.js";

function parent(overrides: Partial<ParentRunIdentity> = {}): ParentRunIdentity {
  return {
    teamName: "team",
    parentName: "writer",
    parentRunId: "parent-run",
    ...overrides,
  };
}

describe("pending child controller", () => {
  it("registers acceptance before exact-run binding and settles a fast child without losing the empty event", async () => {
    const controller = createPendingChildController();
    const identity = parent();
    const accepted = controller.acceptChild(identity, "fast-child");
    const waiting = controller.waitForEmptyOrCancelled(identity);

    expect(controller.pendingCount(identity)).toBe(1);
    const run = controller.bindAcceptedChild(accepted, "fast-child", "fast-run");
    expect(run).toEqual(expect.objectContaining({ childName: "fast-child", childRunId: "fast-run" }));
    expect(controller.settleChildRun(run!)).toBe(true);

    await expect(waiting).resolves.toBe("empty");
    expect(controller.hasPendingChildren(identity)).toBe(false);
    expect(controller.trackedParentCount()).toBe(1);
    expect(controller.forgetParent(identity)).toBe(true);
    expect(controller.trackedParentCount()).toBe(0);
  });

  it("keeps a queued token pending while transferring it atomically to the assigned lifecycle run", async () => {
    const controller = createPendingChildController();
    const identity = parent();
    const queued = controller.acceptChild(identity, "queued-child");
    const waiting = controller.waitForEmptyOrCancelled(identity);
    let latchSettled = false;
    void waiting.then(() => { latchSettled = true; });

    const promoted = controller.bindAcceptedChild(queued, "queued-child", "promoted-run");
    await Promise.resolve();
    expect(latchSettled).toBe(false);
    expect(controller.pendingCount(identity)).toBe(1);

    expect(controller.settleChildRun(promoted!)).toBe(true);
    await expect(waiting).resolves.toBe("empty");
    expect(controller.forgetParent(identity)).toBe(true);
  });

  it("requires exact child-run settlement so stale run A cannot clear same-name run B", async () => {
    const controller = createPendingChildController();
    const identity = parent();
    const acceptedA = controller.acceptChild(identity, "same-name");
    const runA = controller.bindAcceptedChild(acceptedA, "same-name", "run-a")!;
    expect(controller.settleChildRun(runA)).toBe(true);

    const acceptedB = controller.acceptChild(identity, "same-name");
    const runB = controller.bindAcceptedChild(acceptedB, "same-name", "run-b")!;
    const waitingForB = controller.waitForEmptyOrCancelled(identity);

    expect(controller.settleChildRun(runA)).toBe(false);
    expect(controller.pendingCount(identity)).toBe(1);
    expect(controller.settleChildRun(runB)).toBe(true);
    await expect(waitingForB).resolves.toBe("empty");
    expect(controller.forgetParent(identity)).toBe(true);
  });

  it("cancels waiters immediately, notifies once, and leaves duplicate cleanup idempotent", async () => {
    const controller = createPendingChildController();
    const identity = parent();
    const cancelled = vi.fn();
    controller.onParentCancelled(cancelled);
    const accepted = controller.acceptChild(identity, "queued-child");
    const waiting = controller.waitForEmptyOrCancelled(identity);

    expect(controller.cancelParent(identity)).toBe(true);
    expect(controller.cancelParent(identity)).toBe(false);
    expect(controller.settleAcceptance(accepted)).toBe(false);
    await expect(waiting).resolves.toBe("cancelled");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(controller.pendingCount(identity)).toBe(0);

    expect(controller.forgetParent(identity)).toBe(true);
    expect(controller.trackedParentCount()).toBe(0);
  });

  it("creates a durable unseen cancellation sentinel, notifies once, and isolates a newer same-name run", async () => {
    const controller = createPendingChildController();
    const exactRun = parent();
    const newerRun = parent({ parentRunId: "parent-run-newer" });
    const cancelled = vi.fn();
    controller.onParentCancelled(cancelled);

    expect(controller.cancelParent(exactRun)).toBe(true);
    expect(controller.cancelParent(exactRun)).toBe(false);
    expect(controller.trackedParentCount()).toBe(1);
    expect(controller.observeParent(exactRun)).toMatchObject({ cancelled: true, pendingCount: 0 });
    expect(() => controller.acceptChild(exactRun, "late-child")).toThrow("is closing");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(cancelled).toHaveBeenCalledWith(exactRun);

    const newerAcceptance = controller.acceptChild(newerRun, "newer-child");
    const newerChild = controller.bindAcceptedChild(newerAcceptance, "newer-child", "newer-child-run");
    expect(newerChild).toBeDefined();
    expect(controller.pendingCount(newerRun)).toBe(1);
    expect(controller.observeParent(newerRun).cancelled).toBe(false);
    expect(controller.observeParent(exactRun).cancelled).toBe(true);

    expect(controller.settleChildRun(newerChild!)).toBe(true);
    expect(controller.trackedParentCount()).toBe(2);
    expect(controller.forgetParent(newerRun)).toBe(true);
    expect(controller.trackedParentCount()).toBe(1);
    expect(controller.observeParent(exactRun).cancelled).toBe(true);
    expect(controller.forgetParent(exactRun)).toBe(true);
    expect(controller.trackedParentCount()).toBe(0);
  });

  it("wakes and rearms exact-parent generation waiters for accept, bind, settle, signal, and cancel", async () => {
    const controller = createPendingChildController();
    const identity = parent();
    let snapshot = controller.observeParent(identity);

    let changed = controller.waitForChangeOrCancelled(identity, snapshot.generation);
    const acceptance = controller.acceptChild(identity, "child");
    await expect(changed).resolves.toMatchObject({ status: "changed" });

    snapshot = controller.observeParent(identity);
    changed = controller.waitForChangeOrCancelled(identity, snapshot.generation);
    const child = controller.bindAcceptedChild(acceptance, "child", "child-run")!;
    await expect(changed).resolves.toMatchObject({ status: "changed" });

    snapshot = controller.observeParent(identity);
    changed = controller.waitForChangeOrCancelled(identity, snapshot.generation);
    expect(controller.settleChildRun(child)).toBe(true);
    await expect(changed).resolves.toMatchObject({ status: "changed" });

    snapshot = controller.observeParent(identity);
    changed = controller.waitForChangeOrCancelled(identity, snapshot.generation);
    expect(controller.signalParentChange(identity)).toBe(true);
    await expect(changed).resolves.toMatchObject({ status: "changed" });

    snapshot = controller.observeParent(identity);
    changed = controller.waitForChangeOrCancelled(identity, snapshot.generation);
    expect(controller.cancelParent(identity)).toBe(true);
    await expect(changed).resolves.toMatchObject({ status: "cancelled" });
    expect(controller.trackedParentCount()).toBe(1);
    expect(controller.forgetParent(identity)).toBe(true);
  });

  it("reclaims only an exact zero-child state and retains cancelled quarantine until successful forget", () => {
    const controller = createPendingChildController();
    const quarantined = parent({ parentRunId: "quarantined-run" });
    const active = parent({ parentRunId: "active-run" });
    const acceptance = controller.acceptChild(active, "child");

    expect(controller.cancelParent(quarantined)).toBe(true);
    expect(controller.forgetParent(active)).toBe(false);
    expect(controller.trackedParentCount()).toBe(2);
    expect(controller.settleAcceptance(acceptance)).toBe(true);
    expect(controller.trackedParentCount()).toBe(2);
    expect(controller.observeParent(quarantined).cancelled).toBe(true);

    expect(controller.forgetParent(active)).toBe(true);
    expect(controller.trackedParentCount()).toBe(1);
    expect(controller.observeParent(quarantined).cancelled).toBe(true);
    expect(controller.forgetParent(quarantined)).toBe(true);
    expect(controller.trackedParentCount()).toBe(0);
  });
});
