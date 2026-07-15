import type { AgentSession, SessionShutdownEvent } from "@mariozechner/pi-coding-agent";

export const NESTED_SESSION_TEARDOWN_TIMEOUT_MS = 2500;

export type NestedSessionShutdownReason = SessionShutdownEvent["reason"];
export type NestedSessionTeardownStatus = "settled" | "timed_out";
export type ReadAgentTeardownStatus = NestedSessionTeardownStatus | "persistence_failed" | "cleanup_failed";
export type ReadAgentStartupState = "pending" | "session_created" | "failed";

export interface ReadAgentDeliveryCloseResult {
  cancelledDeliveries: number;
  rawDeliverySettlement: Promise<void>;
}

export interface ReadAgentDeliveryState {
  acceptingMessages?: boolean;
  messageDeliveryClosed?: boolean;
  messageDeliveryTail?: Promise<void>;
  messageDeliveryGeneration?: number;
  messageDeliveryCancellation?: Promise<void>;
  cancelMessageDelivery?: () => void;
  pendingMessageDeliveries?: number;
  cancelledMessageDeliveries?: number;
}

export interface ManagedReadAgentLifecycleState extends ReadAgentDeliveryState {
  session?: AgentSession;
  startupState?: ReadAgentStartupState;
  sessionCreation?: Promise<AgentSession | undefined>;
  stopRequested?: boolean;
  heartbeatTimer?: NodeJS.Timeout;
  recipientClosurePromise?: Promise<void>;
  persistedRecipientClosed?: boolean;
  teardownState?: "active" | "stopping" | "quarantined" | "finalized" | "persistence_failed";
  teardownPromise?: Promise<ReadAgentTeardownResult>;
  teardownCleanupPromise?: Promise<void>;
  teardownFinalizationPromise?: Promise<ReadAgentTeardownResult>;
  teardownResult?: ReadAgentTeardownResult;
  teardownError?: unknown;
  resolveFinished?: () => void;
}

export interface NestedSessionTeardownResult {
  status: NestedSessionTeardownStatus;
  reason: NestedSessionShutdownReason;
  extensionShutdown: "emitted" | "no_handlers" | "failed";
  abort: "settled" | "rejected" | "unavailable" | "timed_out";
  delivery: "settled" | "rejected" | "timed_out";
  dispose: "settled" | "failed" | "deferred";
}

export interface ReadAgentFinalizationResult {
  finalized: boolean;
  removedMember: boolean;
  releasedClaims: string[];
  error?: string;
}

export interface ReadAgentTeardownResult extends Omit<NestedSessionTeardownResult, "status">, ReadAgentFinalizationResult {
  status: ReadAgentTeardownStatus;
  cancelledDeliveries: number;
  persistenceClosed: boolean;
}

export interface ReadAgentTeardownOptions {
  reason?: unknown;
  closePersistence(): Promise<void>;
  finalize(): Promise<ReadAgentFinalizationResult | void>;
  onBoundedResult?(result: ReadAgentTeardownResult): Promise<void> | void;
}

interface DeliveryOutcome {
  status: "delivered" | "cancelled";
}

interface NestedSessionLifecycle {
  requestShutdown(
    reason: unknown,
    rawDeliverySettlement: Promise<void>,
    timeoutMs?: number
  ): Promise<NestedSessionTeardownResult>;
  finalized: Promise<void>;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

const VALID_SHUTDOWN_REASONS = new Set<NestedSessionShutdownReason>([
  "quit",
  "reload",
  "new",
  "resume",
  "fork",
]);

const sessionLifecycles = new WeakMap<AgentSession, NestedSessionLifecycle>();

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function normalizeShutdownReason(reason: unknown): NestedSessionShutdownReason {
  return typeof reason === "string" && VALID_SHUTDOWN_REASONS.has(reason as NestedSessionShutdownReason)
    ? reason as NestedSessionShutdownReason
    : "quit";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeFinalizationResult(result: ReadAgentFinalizationResult | void): ReadAgentFinalizationResult {
  return result ?? {
    finalized: true,
    removedMember: false,
    releasedClaims: [],
  };
}

function ensureDeliveryCancellation(state: ReadAgentDeliveryState): Promise<void> {
  if (state.messageDeliveryCancellation) return state.messageDeliveryCancellation;
  const cancellation = createDeferred();
  state.messageDeliveryCancellation = cancellation.promise;
  state.cancelMessageDelivery = cancellation.resolve;
  return cancellation.promise;
}

export class ReadAgentDeliveryCancelledError extends Error {
  constructor(agentName: string) {
    super(`Message delivery to ${agentName} was cancelled because the agent is finishing.`);
    this.name = "ReadAgentDeliveryCancelledError";
  }
}

export function closeReadAgentMessageDelivery(state: ReadAgentDeliveryState): ReadAgentDeliveryCloseResult {
  const rawDeliverySettlement = state.messageDeliveryTail ?? Promise.resolve();
  if (state.messageDeliveryClosed) {
    return { cancelledDeliveries: 0, rawDeliverySettlement };
  }

  state.messageDeliveryClosed = true;
  state.acceptingMessages = false;
  state.messageDeliveryGeneration = (state.messageDeliveryGeneration ?? 0) + 1;
  const cancelledDeliveries = state.pendingMessageDeliveries ?? 0;
  state.cancelledMessageDeliveries = (state.cancelledMessageDeliveries ?? 0) + cancelledDeliveries;
  state.cancelMessageDelivery?.();
  return { cancelledDeliveries, rawDeliverySettlement };
}

export async function enqueueReadAgentMessageDelivery(
  state: ReadAgentDeliveryState,
  agentName: string,
  send: () => Promise<void>
): Promise<DeliveryOutcome> {
  if (!state.acceptingMessages || state.messageDeliveryClosed) {
    throw new Error(`Cannot send message to ${agentName}: agent is finishing.`);
  }

  const generation = state.messageDeliveryGeneration ?? 0;
  state.messageDeliveryGeneration = generation;
  const cancellation = ensureDeliveryCancellation(state);
  state.pendingMessageDeliveries = (state.pendingMessageDeliveries ?? 0) + 1;

  const previousDelivery = state.messageDeliveryTail ?? Promise.resolve();
  const rawOutcome = previousDelivery.catch(() => {}).then(async (): Promise<DeliveryOutcome> => {
    if (state.messageDeliveryClosed || state.messageDeliveryGeneration !== generation) {
      return { status: "cancelled" };
    }

    let rawDelivery: Promise<void>;
    try {
      rawDelivery = Promise.resolve(send());
    } catch (error) {
      rawDelivery = Promise.reject(error);
    }
    // The sender-visible wait may be cancelled before the Pi promise settles. Keep a
    // rejection observer on that raw promise so late provider failures are handled.
    void rawDelivery.catch(() => {});
    await rawDelivery;
    return { status: "delivered" };
  });
  state.messageDeliveryTail = rawOutcome.then(() => {}, () => {});

  try {
    const outcome = await Promise.race([
      rawOutcome,
      cancellation.then((): DeliveryOutcome => ({ status: "cancelled" })),
    ]);
    if (outcome.status === "cancelled") throw new ReadAgentDeliveryCancelledError(agentName);
    return outcome;
  } finally {
    state.pendingMessageDeliveries = Math.max(0, (state.pendingMessageDeliveries ?? 1) - 1);
  }
}

async function operationTimedOut(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let settled = false;
  const observed = operation.then(() => { settled = true; });
  await Promise.resolve();
  if (settled) return false;
  if (timeoutMs <= 0) return true;

  let timeout: NodeJS.Timeout | undefined;
  const timedOut = await Promise.race([
    observed.then(() => false),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(true), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return timedOut;
}

function installNestedSessionLifecycle(session: AgentSession): NestedSessionLifecycle {
  const existing = sessionLifecycles.get(session);
  if (existing) return existing;

  const finalized = createDeferred();
  let shutdownPromise: Promise<NestedSessionTeardownResult> | undefined;
  let disposeOutcome: "settled" | "failed" = "settled";
  let disposed = false;

  const disposeOnce = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      session.dispose();
      finalized.resolve();
    } catch (error) {
      disposeOutcome = "failed";
      finalized.reject(error);
    }
  };

  const lifecycle: NestedSessionLifecycle = {
    finalized: finalized.promise,
    requestShutdown(reasonInput, rawDeliverySettlement, timeoutMs = NESTED_SESSION_TEARDOWN_TIMEOUT_MS) {
      if (shutdownPromise) return shutdownPromise;
      const reason = normalizeShutdownReason(reasonInput);

      shutdownPromise = (async (): Promise<NestedSessionTeardownResult> => {
        let extensionShutdown: NestedSessionTeardownResult["extensionShutdown"] = "no_handlers";
        let rawExtensionShutdown = Promise.resolve();
        try {
          if (session.hasExtensionHandlers("session_shutdown")) {
            extensionShutdown = "emitted";
            rawExtensionShutdown = Promise.resolve(
              session.extensionRunner.emit({ type: "session_shutdown", reason })
            );
          }
        } catch {
          extensionShutdown = "failed";
        }
        void rawExtensionShutdown.catch(() => {});

        try {
          session.clearQueue();
        } catch {
          // Queue clearing is defensive; abort still owns cancellation of active work.
        }

        let abortOutcome: NestedSessionTeardownResult["abort"] = "unavailable";
        let rawAbort: Promise<void>;
        if (typeof session.abort === "function") {
          try {
            rawAbort = Promise.resolve(session.abort());
          } catch (error) {
            rawAbort = Promise.reject(error);
          }
          void rawAbort.catch(() => {});
        } else {
          rawAbort = Promise.resolve();
        }

        let deliveryOutcome: NestedSessionTeardownResult["delivery"] = "settled";
        let deliverySettled = false;
        let abortSettled = typeof session.abort !== "function";
        const observedExtensionShutdown = rawExtensionShutdown.then(
          () => {},
          () => { extensionShutdown = "failed"; }
        );
        const observedDelivery = Promise.resolve(rawDeliverySettlement).then(
          () => { deliverySettled = true; },
          () => {
            deliverySettled = true;
            deliveryOutcome = "rejected";
          }
        );
        const observedAbort = rawAbort.then(
          () => {
            abortSettled = true;
            abortOutcome = typeof session.abort === "function" ? "settled" : "unavailable";
          },
          () => {
            abortSettled = true;
            abortOutcome = "rejected";
          }
        );
        const rawOperations = Promise.all([
          observedExtensionShutdown,
          observedDelivery,
          observedAbort,
        ]).then(() => {});
        void rawOperations.then(disposeOnce);

        const timedOut = await operationTimedOut(rawOperations, timeoutMs);
        if (timedOut) {
          if (!deliverySettled) deliveryOutcome = "timed_out";
          if (!abortSettled) abortOutcome = "timed_out";
          return {
            status: "timed_out",
            reason,
            extensionShutdown,
            abort: abortOutcome,
            delivery: deliveryOutcome,
            dispose: "deferred",
          };
        }

        disposeOnce();
        await finalized.promise.catch(() => {});
        return {
          status: "settled",
          reason,
          extensionShutdown,
          abort: abortOutcome,
          delivery: deliveryOutcome,
          dispose: disposeOutcome,
        };
      })();
      return shutdownPromise;
    },
  };

  // A failed dispose is authoritative failure proof, not an unhandled promise.
  // Teardown owners still await this observer to decide whether cleanup may run.
  void lifecycle.finalized.catch(() => {});
  sessionLifecycles.set(session, lifecycle);
  return lifecycle;
}

export function installReadAgentSessionLifecycle(session: AgentSession): NestedSessionLifecycle {
  return installNestedSessionLifecycle(session);
}

export function requestReadAgentTeardown(
  state: ManagedReadAgentLifecycleState,
  options: ReadAgentTeardownOptions
): Promise<ReadAgentTeardownResult> {
  state.stopRequested = true;
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = undefined;
  const deliveryClose = closeReadAgentMessageDelivery(state);
  // Request callers receive only the bounded public snapshot. The raw observer
  // is explicit on teardownFinalizationPromise and is never returned implicitly.
  if (state.teardownResult) return Promise.resolve(state.teardownResult);
  if (state.teardownPromise) return state.teardownPromise;
  state.teardownState = "stopping";

  let finalizationResult: ReadAgentFinalizationResult | undefined;
  const finalizeOnce = (): Promise<ReadAgentFinalizationResult> => {
    if (!state.teardownCleanupPromise) {
      state.teardownCleanupPromise = Promise.resolve()
        .then(options.finalize)
        .then((result) => {
          finalizationResult = normalizeFinalizationResult(result);
          if (finalizationResult.finalized && !finalizationResult.error) {
            state.teardownState = "finalized";
            state.resolveFinished?.();
          } else {
            state.teardownState = "quarantined";
            if (finalizationResult.error) state.teardownError = new Error(finalizationResult.error);
          }
        })
        .catch((error) => {
          state.teardownError = error;
          state.teardownState = "quarantined";
          finalizationResult = {
            finalized: false,
            removedMember: false,
            releasedClaims: [],
            error: errorText(error),
          };
        });
    }
    return state.teardownCleanupPromise.then(() => finalizationResult ?? {
      finalized: false,
      removedMember: false,
      releasedClaims: [],
      error: "Lifecycle finalizer completed without a verified result.",
    });
  };

  const unfinishedResult = (
    status: "timed_out" | "persistence_failed",
    reason: NestedSessionShutdownReason,
    sessionResult: Omit<NestedSessionTeardownResult, "status" | "reason">,
    error?: string
  ): ReadAgentTeardownResult => ({
    status,
    reason,
    ...sessionResult,
    cancelledDeliveries: deliveryClose.cancelledDeliveries,
    persistenceClosed: status !== "persistence_failed",
    finalized: false,
    removedMember: false,
    releasedClaims: [],
    ...(error ? { error } : {}),
  });

  const finalizedResult = (
    sessionResult: NestedSessionTeardownResult,
    finalization: ReadAgentFinalizationResult
  ): ReadAgentTeardownResult => ({
    ...sessionResult,
    status: finalization.finalized && !finalization.error ? "settled" : "cleanup_failed",
    cancelledDeliveries: deliveryClose.cancelledDeliveries,
    persistenceClosed: true,
    ...finalization,
  });

  const publishBoundedResult = (result: ReadAgentTeardownResult): ReadAgentTeardownResult => {
    state.teardownResult = result;
    void Promise.resolve(options.onBoundedResult?.(result)).catch(() => {});
    return result;
  };

  const deferFinalization = (
    rawOperations: Promise<void>,
    timedOutResult: ReadAgentTeardownResult
  ): void => {
    state.teardownState = "quarantined";
    state.teardownFinalizationPromise = rawOperations.then(async () => {
      const finalization = await finalizeOnce();
      const result: ReadAgentTeardownResult = {
        ...timedOutResult,
        status: finalization.finalized && !finalization.error ? "settled" : "cleanup_failed",
        ...finalization,
      };
      state.teardownResult = result;
      return result;
    }).catch((error) => {
      state.teardownError = error;
      state.teardownState = "quarantined";
      return publishBoundedResult({
        ...timedOutResult,
        status: "cleanup_failed",
        finalized: false,
        removedMember: false,
        releasedClaims: [],
        error: `Nested session disposal failed: ${errorText(error)}`,
      });
    });
  };

  const reason = normalizeShutdownReason(options.reason);
  const continueAfterPersistence = async (deadline: number): Promise<ReadAgentTeardownResult> => {
    let deliveryOutcome: NestedSessionTeardownResult["delivery"] = "settled";
    let deliverySettled = false;
    const observedDelivery = Promise.resolve(deliveryClose.rawDeliverySettlement).then(
      () => { deliverySettled = true; },
      () => {
        deliverySettled = true;
        deliveryOutcome = "rejected";
      }
    );

    let session = state.session;
    if (state.startupState === "pending" && state.sessionCreation) {
      let startupSettled = false;
      const observedStartup = Promise.resolve(state.sessionCreation).then(
        (createdSession) => {
          session = createdSession ?? state.session;
          startupSettled = true;
        },
        (error) => {
          state.teardownError = error;
          session = state.session;
          startupSettled = true;
        }
      );
      const startupTimedOut = await operationTimedOut(
        observedStartup,
        Math.max(0, deadline - Date.now())
      );

      if (startupTimedOut && !startupSettled) {
        const lateRawOperations = observedStartup.then(async () => {
          if (session) {
            const sessionLifecycle = installNestedSessionLifecycle(session);
            await sessionLifecycle.requestShutdown(reason, deliveryClose.rawDeliverySettlement, 0);
            await sessionLifecycle.finalized;
          } else {
            await observedDelivery;
          }
        });
        if (!deliverySettled) deliveryOutcome = "timed_out";
        const timedOutResult = unfinishedResult("timed_out", reason, {
          extensionShutdown: "no_handlers",
          abort: "timed_out",
          delivery: deliveryOutcome,
          dispose: "deferred",
        });
        deferFinalization(lateRawOperations, timedOutResult);
        return publishBoundedResult(timedOutResult);
      }
    }

    session ??= state.session;
    if (!session) {
      const deliveryTimedOut = await operationTimedOut(
        observedDelivery,
        Math.max(0, deadline - Date.now())
      );
      if (deliveryTimedOut) {
        deliveryOutcome = "timed_out";
        const timedOutResult = unfinishedResult("timed_out", reason, {
          extensionShutdown: "no_handlers",
          abort: "unavailable",
          delivery: deliveryOutcome,
          dispose: "deferred",
        });
        deferFinalization(observedDelivery, timedOutResult);
        return publishBoundedResult(timedOutResult);
      }

      const finalization = await finalizeOnce();
      return finalizedResult({
        status: "settled",
        reason,
        extensionShutdown: "no_handlers",
        abort: "unavailable",
        delivery: deliveryOutcome,
        dispose: "settled",
      }, finalization);
    }

    const sessionLifecycle = installNestedSessionLifecycle(session);
    const sessionResult = await sessionLifecycle.requestShutdown(
      reason,
      deliveryClose.rawDeliverySettlement,
      Math.max(0, deadline - Date.now())
    );
    if (sessionResult.status === "timed_out") {
      const timedOutResult = unfinishedResult("timed_out", sessionResult.reason, {
        extensionShutdown: sessionResult.extensionShutdown,
        abort: sessionResult.abort,
        delivery: sessionResult.delivery,
        dispose: sessionResult.dispose,
      });
      deferFinalization(sessionLifecycle.finalized, timedOutResult);
      return publishBoundedResult(timedOutResult);
    }

    if (sessionResult.dispose === "failed") {
      state.teardownState = "quarantined";
      return publishBoundedResult({
        ...sessionResult,
        status: "cleanup_failed",
        cancelledDeliveries: deliveryClose.cancelledDeliveries,
        persistenceClosed: true,
        finalized: false,
        removedMember: false,
        releasedClaims: [],
        error: "Nested session disposal failed.",
      });
    }

    const finalization = await finalizeOnce();
    return finalizedResult(sessionResult, finalization);
  };

  state.teardownPromise = (async (): Promise<ReadAgentTeardownResult> => {
    // Persistence closure and nested teardown share one budget. Closure proof is the
    // hard gate: no nested or external cleanup may begin until this operation fulfills.
    const deadline = Date.now() + NESTED_SESSION_TEARDOWN_TIMEOUT_MS;
    let rawPersistenceClosure: Promise<void>;
    try {
      rawPersistenceClosure = Promise.resolve(options.closePersistence());
    } catch (error) {
      rawPersistenceClosure = Promise.reject(error);
    }

    let persistenceOutcome:
      | { status: "closed" }
      | { status: "rejected"; error: unknown }
      | undefined;
    const observedPersistenceClosure = rawPersistenceClosure.then(
      () => {
        state.persistedRecipientClosed = true;
        persistenceOutcome = { status: "closed" };
      },
      (error) => {
        persistenceOutcome = { status: "rejected", error };
      }
    );
    const persistenceTimedOut = await operationTimedOut(
      observedPersistenceClosure,
      Math.max(0, deadline - Date.now())
    );

    if (persistenceTimedOut) {
      const timeoutError = new Error(
        `Persistence closure timed out after ${NESTED_SESSION_TEARDOWN_TIMEOUT_MS}ms.`
      );
      state.teardownError = timeoutError;
      state.teardownState = "persistence_failed";
      const timedOutResult = unfinishedResult("persistence_failed", reason, {
        extensionShutdown: "no_handlers",
        abort: "unavailable",
        delivery: "settled",
        dispose: "deferred",
      }, timeoutError.message);

      // Keep the raw operation observed. A late rejection remains non-destructive;
      // a late fulfillment proves closure and is allowed exactly one continuation.
      let persistenceContinuation!: Promise<ReadAgentTeardownResult>;
      persistenceContinuation = observedPersistenceClosure.then(async () => {
        if (persistenceOutcome?.status === "rejected") {
          state.teardownError = persistenceOutcome.error;
          state.teardownState = "persistence_failed";
          const rejectedResult = unfinishedResult("persistence_failed", reason, {
            extensionShutdown: "no_handlers",
            abort: "unavailable",
            delivery: "settled",
            dispose: "deferred",
          }, errorText(persistenceOutcome.error));
          return publishBoundedResult(rejectedResult);
        }

        const continuationResult = await continueAfterPersistence(deadline);
        const deferredContinuation = state.teardownFinalizationPromise;
        if (
          continuationResult.status === "timed_out"
          && deferredContinuation
          && deferredContinuation !== persistenceContinuation
        ) {
          return deferredContinuation;
        }
        state.teardownResult = continuationResult;
        return continuationResult;
      });
      state.teardownFinalizationPromise = persistenceContinuation;
      return publishBoundedResult(timedOutResult);
    }

    if (persistenceOutcome?.status === "rejected") {
      state.teardownError = persistenceOutcome.error;
      state.teardownState = "persistence_failed";
      return publishBoundedResult(unfinishedResult("persistence_failed", reason, {
        extensionShutdown: "no_handlers",
        abort: "unavailable",
        delivery: "settled",
        dispose: "deferred",
      }, errorText(persistenceOutcome.error)));
    }

    return continueAfterPersistence(deadline);
  })();
  void state.teardownPromise.then((result) => {
    if (!state.teardownResult || state.teardownResult.status === "timed_out") {
      state.teardownResult = result;
    }
  });

  return state.teardownPromise;
}
