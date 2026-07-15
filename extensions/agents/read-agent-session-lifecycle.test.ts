import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NESTED_SESSION_TEARDOWN_TIMEOUT_MS,
  closeReadAgentMessageDelivery,
  enqueueReadAgentMessageDelivery,
  installReadAgentSessionLifecycle,
  requestReadAgentTeardown,
  type ManagedReadAgentLifecycleState,
} from "./read-agent-session-lifecycle.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function makeSession(options: { handlers?: boolean } = {}) {
  const order: string[] = [];
  const session = {
    hasExtensionHandlers: vi.fn(() => options.handlers ?? true),
    extensionRunner: {
      emit: vi.fn(async (event: any) => { order.push(`emit:${event.reason}`); }),
    },
    clearQueue: vi.fn(() => { order.push("clearQueue"); return { steering: [], followUp: [] }; }),
    abort: vi.fn(async () => { order.push("abort"); }),
    dispose: vi.fn(() => { order.push("dispose"); }),
  };
  return { session: session as any, order };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("nested read-agent delivery lifecycle", () => {
  it("cancels sender-visible waits and drops a delayed second delivery after close", async () => {
    const firstRaw = deferred();
    const sends = vi.fn(() => firstRaw.promise);
    const state: ManagedReadAgentLifecycleState = {
      acceptingMessages: true,
      messageDeliveryClosed: false,
    };

    const first = enqueueReadAgentMessageDelivery(state, "reader", sends);
    await vi.waitFor(() => expect(sends).toHaveBeenCalledOnce());
    const second = enqueueReadAgentMessageDelivery(state, "reader", sends);
    const firstOutcome = first.then(() => "delivered", (error: Error) => error.message);
    const secondOutcome = second.then(() => "delivered", (error: Error) => error.message);

    const close = closeReadAgentMessageDelivery(state);
    expect(close.cancelledDeliveries).toBe(2);
    await expect(firstOutcome).resolves.toContain("was cancelled");
    await expect(secondOutcome).resolves.toContain("was cancelled");
    expect(sends).toHaveBeenCalledOnce();

    firstRaw.resolve();
    await close.rawDeliverySettlement;
    expect(sends).toHaveBeenCalledOnce();
  });
});

describe("nested selected-extension session shutdown", () => {
  it("invokes shutdown before clear/abort and uses the first concurrent reason exactly once", async () => {
    const { session, order } = makeSession();
    const handler = deferred();
    session.extensionRunner.emit.mockImplementation(async (event: any) => {
      order.push(`emit:${event.reason}`);
      await handler.promise;
    });
    const lifecycle = installReadAgentSessionLifecycle(session);

    const first = lifecycle.requestShutdown("quit", Promise.resolve());
    const concurrent = lifecycle.requestShutdown("reload", Promise.resolve());
    await Promise.resolve();

    expect(order).toEqual(["emit:quit", "clearQueue", "abort"]);
    expect(session.clearQueue).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).not.toHaveBeenCalled();

    handler.resolve();
    await expect(first).resolves.toMatchObject({ status: "settled", reason: "quit", extensionShutdown: "emitted" });
    await expect(concurrent).resolves.toMatchObject({ status: "settled", reason: "quit" });
    expect(order).toEqual(["emit:quit", "clearQueue", "abort", "dispose"]);
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("times out a permanently pending shutdown handler and disposes exactly once only after it settles", async () => {
    vi.useFakeTimers();
    const { session, order } = makeSession();
    const handler = deferred();
    session.extensionRunner.emit.mockImplementation(async (event: any) => {
      order.push(`emit:${event.reason}`);
      await handler.promise;
    });
    const lifecycle = installReadAgentSessionLifecycle(session);

    const shutdown = lifecycle.requestShutdown("reload", Promise.resolve());
    await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
    await expect(shutdown).resolves.toMatchObject({
      status: "timed_out",
      reason: "reload",
      extensionShutdown: "emitted",
      abort: "settled",
      delivery: "settled",
      dispose: "deferred",
    });
    expect(order).toEqual(["emit:reload", "clearQueue", "abort"]);
    expect(session.dispose).not.toHaveBeenCalled();

    handler.resolve();
    await lifecycle.finalized;
    lifecycle.requestShutdown("quit", Promise.resolve());
    await Promise.resolve();

    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.clearQueue).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("continues through throwing and absent shutdown handlers", async () => {
    const throwing = makeSession();
    throwing.session.extensionRunner.emit.mockRejectedValue(new Error("handler failed"));
    const failedHandlerResult = await installReadAgentSessionLifecycle(throwing.session)
      .requestShutdown("quit", Promise.resolve());

    expect(failedHandlerResult).toMatchObject({ status: "settled", extensionShutdown: "failed" });
    expect(throwing.order).toEqual(["clearQueue", "abort", "dispose"]);

    const absent = makeSession({ handlers: false });
    const absentResult = await installReadAgentSessionLifecycle(absent.session)
      .requestShutdown("quit", Promise.resolve());

    expect(absentResult).toMatchObject({ status: "settled", extensionShutdown: "no_handlers" });
    expect(absent.session.extensionRunner.emit).not.toHaveBeenCalled();
    expect(absent.order).toEqual(["clearQueue", "abort", "dispose"]);
  });

  it("quarantines timed-out raw operations and disposes exactly once only after both settle", async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    const delivery = deferred();
    const abort = deferred();
    session.abort.mockImplementation(() => abort.promise);
    const lifecycle = installReadAgentSessionLifecycle(session);

    const shutdown = lifecycle.requestShutdown("reload", delivery.promise);
    await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
    await expect(shutdown).resolves.toMatchObject({
      status: "timed_out",
      reason: "reload",
      abort: "timed_out",
      delivery: "timed_out",
      dispose: "deferred",
    });
    expect(session.dispose).not.toHaveBeenCalled();

    delivery.resolve();
    await Promise.resolve();
    expect(session.dispose).not.toHaveBeenCalled();
    abort.resolve();
    await lifecycle.finalized;

    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.clearQueue).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("quarantines startup pending past the shared deadline and finalizes only after the late session settles", async () => {
    vi.useFakeTimers();
    const creation = deferred<any | undefined>();
    const abort = deferred();
    const { session } = makeSession();
    session.abort.mockImplementation(() => abort.promise);
    const finalize = vi.fn(async () => {});
    const state: ManagedReadAgentLifecycleState = {
      startupState: "pending",
      sessionCreation: creation.promise,
      acceptingMessages: true,
    };

    const teardown = requestReadAgentTeardown(state, {
      reason: "quit",
      closePersistence: vi.fn(async () => {}),
      finalize,
    });
    await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
    await expect(teardown).resolves.toMatchObject({
      status: "timed_out",
      abort: "timed_out",
      dispose: "deferred",
    });
    expect(state.teardownState).toBe("quarantined");
    expect(finalize).not.toHaveBeenCalled();

    state.session = session;
    creation.resolve(session);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.clearQueue).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();

    abort.resolve();
    await state.teardownFinalizationPromise;
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(state.teardownState).toBe("finalized");
  });

  it("finalizes safely when pending session creation rejects and no session can exist", async () => {
    const creation = deferred<any | undefined>();
    const finalize = vi.fn(async () => {});
    const state: ManagedReadAgentLifecycleState = {
      startupState: "pending",
      sessionCreation: creation.promise,
      acceptingMessages: true,
    };

    const teardown = requestReadAgentTeardown(state, {
      reason: "quit",
      closePersistence: vi.fn(async () => {}),
      finalize,
    });
    creation.reject(new Error("creation failed"));

    await expect(teardown).resolves.toMatchObject({
      status: "settled",
      extensionShutdown: "no_handlers",
      abort: "unavailable",
      dispose: "settled",
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(state.teardownState).toBe("finalized");
  });

  it("does not emit or destroy a session when persisted closure cannot be proven", async () => {
    const { session } = makeSession();
    const finalize = vi.fn(async () => {});
    const state: ManagedReadAgentLifecycleState = {
      session,
      acceptingMessages: true,
    };

    await expect(requestReadAgentTeardown(state, {
      reason: "quit",
      closePersistence: async () => { throw new Error("persistence unavailable"); },
      finalize,
    })).resolves.toMatchObject({
      status: "persistence_failed",
      persistenceClosed: false,
      finalized: false,
      removedMember: false,
      releasedClaims: [],
      error: "persistence unavailable",
    });

    expect(state.teardownState).toBe("persistence_failed");
    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
    expect(session.clearQueue).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("bounds a never-settling persistence close without any destructive cleanup", async () => {
    vi.useFakeTimers();
    const persistence = deferred();
    const { session } = makeSession();
    const finalize = vi.fn(async () => {});
    const state: ManagedReadAgentLifecycleState = {
      session,
      acceptingMessages: true,
    };

    const teardown = requestReadAgentTeardown(state, {
      reason: "quit",
      closePersistence: vi.fn(() => persistence.promise),
      finalize,
    });
    await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);

    await expect(teardown).resolves.toMatchObject({
      status: "persistence_failed",
      persistenceClosed: false,
      finalized: false,
      removedMember: false,
      releasedClaims: [],
      error: `Persistence closure timed out after ${NESTED_SESSION_TEARDOWN_TIMEOUT_MS}ms.`,
    });
    expect(state.teardownState).toBe("persistence_failed");
    expect(state.acceptingMessages).toBe(false);
    expect(state.messageDeliveryClosed).toBe(true);
    expect(state.persistedRecipientClosed).not.toBe(true);
    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
    expect(session.clearQueue).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("observes a late persistence rejection without cleanup or an unhandled rejection", async () => {
    vi.useFakeTimers();
    const persistence = deferred();
    const { session } = makeSession();
    const finalize = vi.fn(async () => {});
    const state: ManagedReadAgentLifecycleState = {
      session,
      acceptingMessages: true,
    };

    const teardown = requestReadAgentTeardown(state, {
      closePersistence: vi.fn(() => persistence.promise),
      finalize,
    });
    await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
    await expect(teardown).resolves.toMatchObject({
      status: "persistence_failed",
      error: `Persistence closure timed out after ${NESTED_SESSION_TEARDOWN_TIMEOUT_MS}ms.`,
    });

    persistence.reject(new Error("late persistence failure"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(state.teardownFinalizationPromise).resolves.toMatchObject({
      status: "persistence_failed",
      persistenceClosed: false,
      error: "late persistence failure",
    });
    expect(state.teardownState).toBe("persistence_failed");
    expect(session.extensionRunner.emit).not.toHaveBeenCalled();
    expect(session.clearQueue).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("continues exactly once after late persistence success and defers finalization for raw settlement", async () => {
    vi.useFakeTimers();
    const persistence = deferred();
    const shutdownHandler = deferred();
    const abort = deferred();
    const { session } = makeSession();
    session.extensionRunner.emit.mockImplementation(() => shutdownHandler.promise);
    session.abort.mockImplementation(() => abort.promise);
    const finalize = vi.fn(async () => {});
    const closePersistence = vi.fn(() => persistence.promise);
    const state: ManagedReadAgentLifecycleState = {
      session,
      acceptingMessages: true,
    };

    const teardown = requestReadAgentTeardown(state, { closePersistence, finalize });
    await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
    await expect(teardown).resolves.toMatchObject({ status: "persistence_failed" });
    const eventualFromPersistence = state.teardownFinalizationPromise;
    const concurrentContinuation = requestReadAgentTeardown(state, {
      closePersistence: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
    });
    await expect(concurrentContinuation).resolves.toMatchObject({ status: "persistence_failed" });

    persistence.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.persistedRecipientClosed).toBe(true);
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.clearQueue).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();

    shutdownHandler.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.dispose).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();

    abort.resolve();
    const eventualResult = await eventualFromPersistence;
    expect(eventualResult).toMatchObject({
      status: "settled",
      persistenceClosed: true,
      finalized: true,
    });
    expect(state.teardownResult).toEqual(eventualResult);
    expect(state.teardownState).toBe("finalized");
    expect(closePersistence).toHaveBeenCalledOnce();
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.clearQueue).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("uses only the persistence deadline remainder for nested shutdown", async () => {
    vi.useFakeTimers();
    const abort = deferred();
    const { session } = makeSession();
    session.abort.mockImplementation(() => abort.promise);
    const state: ManagedReadAgentLifecycleState = {
      session,
      acceptingMessages: true,
    };
    const closePersistence = vi.fn(() => new Promise<void>((resolve) => {
      setTimeout(resolve, 1000);
    }));

    const teardown = requestReadAgentTeardown(state, {
      closePersistence,
      finalize: vi.fn(async () => {}),
    });
    let settled = false;
    void teardown.then(() => { settled = true; });

    await vi.advanceTimersByTimeAsync(2499);
    expect(settled).toBe(false);
    expect(session.abort).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await expect(teardown).resolves.toMatchObject({
      status: "timed_out",
      persistenceClosed: true,
      abort: "timed_out",
    });
    expect(closePersistence).toHaveBeenCalledOnce();
  });

  it("shares concurrent close and continuation, including exact-deadline fulfillment", async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    const finalize = vi.fn(async () => {});
    const closePersistence = vi.fn(() => new Promise<void>((resolve) => {
      setTimeout(resolve, NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
    }));
    const state: ManagedReadAgentLifecycleState = {
      session,
      acceptingMessages: true,
    };
    const options = { closePersistence, finalize };

    const first = requestReadAgentTeardown(state, options);
    const concurrent = requestReadAgentTeardown(state, options);
    expect(concurrent).toBe(first);
    expect(closePersistence).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
    const boundaryResult = await first;
    expect(boundaryResult.persistenceClosed).toBe(true);
    expect(boundaryResult.status).not.toBe("persistence_failed");
    expect(state.persistedRecipientClosed).toBe(true);
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.clearQueue).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();

    const eventual = await state.teardownFinalizationPromise;
    expect(eventual).toMatchObject({ status: "settled", finalized: true });
    const subsequent = requestReadAgentTeardown(state, {
      closePersistence: vi.fn(async () => {}),
      finalize: vi.fn(async () => {}),
    });
    await expect(subsequent).resolves.toEqual(eventual);
    expect(closePersistence).toHaveBeenCalledOnce();
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.clearQueue).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("defers all external cleanup for a quarantined state until raw operations settle", async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    const delivery = deferred();
    const abort = deferred();
    session.abort.mockImplementation(() => abort.promise);
    const finalize = vi.fn(async () => {});
    const state: ManagedReadAgentLifecycleState = {
      session,
      acceptingMessages: true,
      messageDeliveryTail: delivery.promise,
    };

    const closePersistence = vi.fn(async () => {});
    const teardown = requestReadAgentTeardown(state, {
      reason: "watchdog",
      closePersistence,
      finalize,
    });
    await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
    const bounded = await teardown;
    expect(bounded).toMatchObject({ status: "timed_out", reason: "quit" });
    expect(state.teardownState).toBe("quarantined");
    expect(finalize).not.toHaveBeenCalled();
    expect(session.dispose).not.toHaveBeenCalled();

    const unusedClose = vi.fn(async () => {});
    const unusedFinalize = vi.fn(async () => {});
    const repeated = requestReadAgentTeardown(state, {
      reason: "reload",
      closePersistence: unusedClose,
      finalize: unusedFinalize,
    });
    await expect(repeated).resolves.toBe(bounded);
    expect(closePersistence).toHaveBeenCalledOnce();
    expect(unusedClose).not.toHaveBeenCalled();
    expect(unusedFinalize).not.toHaveBeenCalled();
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();

    delivery.resolve();
    abort.resolve();
    const finalization = await state.teardownFinalizationPromise;

    expect(finalization).toMatchObject({ status: "settled", finalized: true });
    expect(state.teardownResult).toEqual(finalization);
    expect(finalize).toHaveBeenCalledOnce();
    expect(session.extensionRunner.emit).toHaveBeenCalledOnce();
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(state.teardownState).toBe("finalized");
  });

  it("keeps cleanup quarantined when nested session disposal fails", async () => {
    const { session } = makeSession();
    session.dispose.mockImplementation(() => { throw new Error("dispose failed"); });
    const finalize = vi.fn(async () => {});
    const state: ManagedReadAgentLifecycleState = {
      session,
      acceptingMessages: true,
    };

    await expect(requestReadAgentTeardown(state, {
      closePersistence: vi.fn(async () => {}),
      finalize,
    })).resolves.toMatchObject({
      status: "cleanup_failed",
      dispose: "failed",
      finalized: false,
      error: "Nested session disposal failed.",
    });
    expect(finalize).not.toHaveBeenCalled();
    expect(state.teardownState).toBe("quarantined");
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("caches authoritative cleanup failure proof after a bounded timeout", async () => {
    vi.useFakeTimers();
    const { session } = makeSession();
    const delivery = deferred();
    const finalize = vi.fn(async () => ({
      finalized: false,
      removedMember: false,
      releasedClaims: ["src/released.ts"],
      error: "member cleanup failed",
    }));
    const state: ManagedReadAgentLifecycleState = {
      session,
      acceptingMessages: true,
      messageDeliveryTail: delivery.promise,
    };
    const closePersistence = vi.fn(async () => {});

    const teardown = requestReadAgentTeardown(state, {
      reason: "quit",
      closePersistence,
      finalize,
    });
    await vi.advanceTimersByTimeAsync(NESTED_SESSION_TEARDOWN_TIMEOUT_MS);
    await expect(teardown).resolves.toMatchObject({
      status: "timed_out",
      finalized: false,
      delivery: "timed_out",
    });
    expect(finalize).not.toHaveBeenCalled();

    delivery.resolve();
    const lateResult = await state.teardownFinalizationPromise;
    expect(lateResult).toMatchObject({
      status: "cleanup_failed",
      finalized: false,
      removedMember: false,
      releasedClaims: ["src/released.ts"],
      error: "member cleanup failed",
      delivery: "timed_out",
    });
    expect(state.teardownResult).toEqual(lateResult);

    const unusedClose = vi.fn(async () => {});
    const unusedFinalize = vi.fn(async () => {});
    await expect(requestReadAgentTeardown(state, {
      closePersistence: unusedClose,
      finalize: unusedFinalize,
    })).resolves.toEqual(lateResult);
    expect(closePersistence).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(unusedClose).not.toHaveBeenCalled();
    expect(unusedFinalize).not.toHaveBeenCalled();
  });
});
