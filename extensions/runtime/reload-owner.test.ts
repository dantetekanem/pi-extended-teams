import { afterEach, describe, expect, it, vi } from "vitest";
import { connectReloadOwner, type ReloadOwner } from "./reload-owner";

function owner(): ReloadOwner<string> {
  return { attach: vi.fn(), detach: vi.fn(), close: vi.fn(async () => {}), hasWork: () => true };
}

afterEach(() => vi.useRealTimers());

describe("reload ownership", () => {
  it("reattaches the original owner across module reload without reconstructing it", async () => {
    const manager = {};
    const runtime = owner();
    const first = await connectReloadOwner(manager, "session", "host-1", () => runtime);
    await first.shutdown("reload");
    expect(runtime.detach).toHaveBeenCalledOnce();
    expect(runtime.close).not.toHaveBeenCalled();
    vi.resetModules();
    const reloaded = await import("./reload-owner.js");
    const replacement = vi.fn(() => owner());
    const second = await reloaded.connectReloadOwner(manager, "session", "host-2", replacement);
    expect(second.owner).toBe(runtime);
    expect(replacement).not.toHaveBeenCalled();
    expect(runtime.attach).toHaveBeenLastCalledWith("host-2");
    await first.shutdown("quit");
    expect(runtime.close).not.toHaveBeenCalled();
    await second.shutdown("quit");
    expect(runtime.close).toHaveBeenCalledExactlyOnceWith("quit");
  });

  it("does not mix hosts opening the same saved session", async () => {
    const a = await connectReloadOwner({}, "same-id", "host-a", owner);
    const b = await connectReloadOwner({}, "same-id", "host-b", owner);
    expect(a.owner).not.toBe(b.owner);
    await a.shutdown("quit");
    expect(b.owner.close).not.toHaveBeenCalled();
    await b.shutdown("quit");
  });

  it.each(["quit", "new", "resume", "fork"])("closes on %s rather than retaining an owner", async reason => {
    const manager = {};
    const first = await connectReloadOwner(manager, "session", "host-1", owner);
    await first.shutdown(reason);
    expect(first.owner.close).toHaveBeenCalledExactlyOnceWith(reason);
    const second = await connectReloadOwner(manager, "session", "host-2", owner);
    expect(second.owner).not.toBe(first.owner);
    await second.shutdown("quit");
  });

  it("starts cleanup after the recovery window and fences late reattachment until cleanup settles", async () => {
    vi.useFakeTimers();
    const manager = {};
    let finish!: () => void;
    const runtime = owner();
    runtime.close = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = await connectReloadOwner(manager, "session", "host-1", () => runtime);
    await first.shutdown("reload");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runtime.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.close).toHaveBeenCalledExactlyOnceWith("reload-timeout");
    await expect(connectReloadOwner(manager, "session", "late-host", owner)).rejects.toThrow("closing");
    finish();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not let a prior reload deadline close a reattached owner", async () => {
    vi.useFakeTimers();
    const manager = {};
    const first = await connectReloadOwner(manager, "session", "host-1", owner);
    await first.shutdown("reload");
    await vi.advanceTimersByTimeAsync(30_000);
    const second = await connectReloadOwner(manager, "session", "host-2", owner);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(second.owner.close).not.toHaveBeenCalled();
    await second.shutdown("quit");
  });

  it("does not extend recovery indefinitely when reattachment fails", async () => {
    vi.useFakeTimers();
    const manager = {};
    const runtime = owner();
    const first = await connectReloadOwner(manager, "session", "host", () => runtime);
    await first.shutdown("reload");
    await vi.advanceTimersByTimeAsync(59_000);
    runtime.attach = vi.fn(async () => { throw new Error("Reload failed"); });
    await expect(connectReloadOwner(manager, "session", "broken", owner)).rejects.toThrow("Reload failed");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.close).toHaveBeenCalledExactlyOnceWith("reload-timeout");
  });

  it("rejects a late attachment after the recovery deadline began cleanup", async () => {
    vi.useFakeTimers();
    const manager = {};
    const runtime = owner();
    const first = await connectReloadOwner(manager, "session", "host", () => runtime);
    await first.shutdown("reload");
    let finish!: () => void;
    runtime.attach = () => new Promise<void>(resolve => { finish = resolve; });
    const pending = connectReloadOwner(manager, "session", "slow-host", owner);
    const rejected = expect(pending).rejects.toThrow("expired while reconnecting");
    await vi.advanceTimersByTimeAsync(60_000);
    finish();
    await rejected;
    expect(runtime.close).toHaveBeenCalledExactlyOnceWith("reload-timeout");
  });

  it("keeps failed cleanup fenced rather than creating a replacement owner", async () => {
    const manager = {};
    const runtime = owner();
    runtime.close = vi.fn(async () => { throw new Error("unsettled cleanup"); });
    const first = await connectReloadOwner(manager, "session", "host", () => runtime);
    await expect(first.shutdown("quit")).rejects.toThrow("unsettled cleanup");
    await expect(connectReloadOwner(manager, "session", "other-host", owner)).rejects.toThrow("closing");
  });
});
