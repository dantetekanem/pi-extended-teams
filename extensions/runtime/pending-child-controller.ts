import crypto from "node:crypto";

export interface ParentRunIdentity {
  teamName: string;
  parentName: string;
  parentRunId: string;
}

export interface PendingChildAcceptance extends ParentRunIdentity {
  token: string;
  childName: string;
}

export interface PendingChildRun extends ParentRunIdentity {
  childName: string;
  childRunId: string;
}

export type PendingChildrenLatchResult = "empty" | "cancelled";

export interface PendingParentSnapshot {
  generation: number;
  pendingCount: number;
  cancelled: boolean;
}

export type PendingParentChangeResult =
  | { status: "changed"; generation: number }
  | { status: "cancelled"; generation: number };

type PendingChildEntry =
  | { phase: "accepted"; acceptance: PendingChildAcceptance }
  | { phase: "running"; acceptance: PendingChildAcceptance; run: PendingChildRun };

interface ParentRunState {
  identity: ParentRunIdentity;
  cancelled: boolean;
  generation: number;
  childrenByToken: Map<string, PendingChildEntry>;
  emptyWaiters: Set<(result: PendingChildrenLatchResult) => void>;
  changeWaiters: Set<(result: PendingParentChangeResult) => void>;
}

export interface PendingChildController {
  acceptChild(parent: ParentRunIdentity, childName: string): PendingChildAcceptance;
  bindAcceptedChild(
    acceptance: PendingChildAcceptance,
    childName: string,
    childRunId: string
  ): PendingChildRun | undefined;
  settleAcceptance(acceptance: PendingChildAcceptance): boolean;
  settleChildRun(child: PendingChildRun): boolean;
  hasPendingChildren(parent: ParentRunIdentity): boolean;
  pendingCount(parent: ParentRunIdentity): number;
  observeParent(parent: ParentRunIdentity): PendingParentSnapshot;
  signalParentChange(parent: ParentRunIdentity): boolean;
  waitForChangeOrCancelled(
    parent: ParentRunIdentity,
    afterGeneration: number
  ): Promise<PendingParentChangeResult>;
  waitForEmptyOrCancelled(parent: ParentRunIdentity): Promise<PendingChildrenLatchResult>;
  cancelParent(parent: ParentRunIdentity): boolean;
  forgetParent(parent: ParentRunIdentity): boolean;
  onParentCancelled(listener: (parent: ParentRunIdentity) => void): () => void;
  trackedParentCount(): number;
}

function parentKey(parent: ParentRunIdentity): string {
  return `${parent.teamName}\u0000${parent.parentName}\u0000${parent.parentRunId}`;
}

function sameParent(left: ParentRunIdentity, right: ParentRunIdentity): boolean {
  return left.teamName === right.teamName
    && left.parentName === right.parentName
    && left.parentRunId === right.parentRunId;
}

function immutableParent(parent: ParentRunIdentity): ParentRunIdentity {
  return Object.freeze({
    teamName: parent.teamName,
    parentName: parent.parentName,
    parentRunId: parent.parentRunId,
  });
}

export function createPendingChildController(): PendingChildController {
  const parents = new Map<string, ParentRunState>();
  const cancellationListeners = new Set<(parent: ParentRunIdentity) => void>();

  const createParentState = (parent: ParentRunIdentity): ParentRunState => ({
    identity: immutableParent(parent),
    cancelled: false,
    generation: 0,
    childrenByToken: new Map(),
    emptyWaiters: new Set(),
    changeWaiters: new Set(),
  });

  const ensureParentState = (parent: ParentRunIdentity): ParentRunState => {
    const key = parentKey(parent);
    let state = parents.get(key);
    if (!state) {
      state = createParentState(parent);
      parents.set(key, state);
    }
    return state;
  };

  const resolveEmptyWaiters = (state: ParentRunState, result: PendingChildrenLatchResult): void => {
    const waiters = Array.from(state.emptyWaiters);
    state.emptyWaiters.clear();
    for (const resolve of waiters) resolve(result);
  };

  const signalChange = (state: ParentRunState): void => {
    state.generation += 1;
    const result: PendingParentChangeResult = state.cancelled
      ? { status: "cancelled", generation: state.generation }
      : { status: "changed", generation: state.generation };
    const waiters = Array.from(state.changeWaiters);
    state.changeWaiters.clear();
    for (const resolve of waiters) resolve(result);
  };

  const settleToken = (acceptance: PendingChildAcceptance): boolean => {
    const key = parentKey(acceptance);
    const state = parents.get(key);
    const entry = state?.childrenByToken.get(acceptance.token);
    if (!state || !entry || entry.acceptance !== acceptance) return false;

    state.childrenByToken.delete(acceptance.token);
    signalChange(state);
    if (state.childrenByToken.size === 0) resolveEmptyWaiters(state, "empty");
    return true;
  };

  return {
    acceptChild(parent, childName) {
      const key = parentKey(parent);
      let state = parents.get(key);
      if (state?.cancelled) {
        throw new Error(`Cannot accept child ${childName}: parent ${parent.parentName} run ${parent.parentRunId} is closing.`);
      }
      if (!state) state = ensureParentState(parent);

      const acceptance = Object.freeze({
        ...state.identity,
        token: crypto.randomUUID(),
        childName,
      });
      state.childrenByToken.set(acceptance.token, { phase: "accepted", acceptance });
      signalChange(state);
      return acceptance;
    },

    bindAcceptedChild(acceptance, childName, childRunId) {
      const state = parents.get(parentKey(acceptance));
      const entry = state?.childrenByToken.get(acceptance.token);
      if (!state || state.cancelled || !entry || entry.phase !== "accepted" || entry.acceptance !== acceptance) {
        return undefined;
      }
      if (acceptance.childName !== childName) return undefined;

      const run = Object.freeze({
        teamName: acceptance.teamName,
        parentName: acceptance.parentName,
        parentRunId: acceptance.parentRunId,
        childName,
        childRunId,
      });
      state.childrenByToken.set(acceptance.token, { phase: "running", acceptance, run });
      signalChange(state);
      return run;
    },

    settleAcceptance(acceptance) {
      return settleToken(acceptance);
    },

    settleChildRun(child) {
      const state = parents.get(parentKey(child));
      if (!state || state.cancelled) return false;
      for (const entry of state.childrenByToken.values()) {
        if (entry.phase !== "running") continue;
        if (entry.run.childName !== child.childName || entry.run.childRunId !== child.childRunId) continue;
        if (!sameParent(entry.run, child)) continue;
        return settleToken(entry.acceptance);
      }
      return false;
    },

    hasPendingChildren(parent) {
      return (parents.get(parentKey(parent))?.childrenByToken.size ?? 0) > 0;
    },

    pendingCount(parent) {
      return parents.get(parentKey(parent))?.childrenByToken.size ?? 0;
    },

    observeParent(parent) {
      const state = ensureParentState(parent);
      return {
        generation: state.generation,
        pendingCount: state.childrenByToken.size,
        cancelled: state.cancelled,
      };
    },

    signalParentChange(parent) {
      const state = ensureParentState(parent);
      if (state.cancelled) return false;
      signalChange(state);
      return true;
    },

    waitForChangeOrCancelled(parent, afterGeneration) {
      const state = ensureParentState(parent);
      if (state.cancelled) {
        return Promise.resolve({ status: "cancelled", generation: state.generation });
      }
      if (state.generation !== afterGeneration) {
        return Promise.resolve({ status: "changed", generation: state.generation });
      }
      return new Promise<PendingParentChangeResult>((resolve) => {
        state.changeWaiters.add(resolve);
      });
    },

    waitForEmptyOrCancelled(parent) {
      const state = parents.get(parentKey(parent));
      if (!state) return Promise.resolve("empty");
      if (state.cancelled) return Promise.resolve("cancelled");
      if (state.childrenByToken.size === 0) return Promise.resolve("empty");
      return new Promise<PendingChildrenLatchResult>((resolve) => {
        state.emptyWaiters.add(resolve);
      });
    },

    cancelParent(parent) {
      const state = ensureParentState(parent);
      if (state.cancelled) return false;
      state.cancelled = true;
      state.childrenByToken.clear();
      signalChange(state);
      resolveEmptyWaiters(state, "cancelled");
      for (const listener of cancellationListeners) {
        try {
          listener(state.identity);
        } catch {
          // Cancellation is authoritative even if an in-memory observer fails.
        }
      }
      return true;
    },

    forgetParent(parent) {
      const key = parentKey(parent);
      const state = parents.get(key);
      if (!state || state.childrenByToken.size > 0) return false;
      parents.delete(key);
      resolveEmptyWaiters(state, state.cancelled ? "cancelled" : "empty");
      const changeResult: PendingParentChangeResult = state.cancelled
        ? { status: "cancelled", generation: state.generation }
        : { status: "changed", generation: state.generation };
      const changeWaiters = Array.from(state.changeWaiters);
      state.changeWaiters.clear();
      for (const resolve of changeWaiters) resolve(changeResult);
      return true;
    },

    onParentCancelled(listener) {
      cancellationListeners.add(listener);
      return () => { cancellationListeners.delete(listener); };
    },

    trackedParentCount() {
      return parents.size;
    },
  };
}
