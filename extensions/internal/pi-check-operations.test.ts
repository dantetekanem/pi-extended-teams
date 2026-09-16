import { describe, expect, it, vi } from "vitest";
import { loadNativeCheckOperations } from "./pi-check-operations";

describe("native Pi check execution boundary", () => {
  it("uses the supported local operations factory and preserves its execution receiver", async () => {
    const port = { marker: "native", async exec(this: { marker: string }, command: string) {
      expect(this.marker).toBe("native");
      expect(command).toBe("assigned command");
      return { exitCode: 0 };
    } };
    const createLocalBashOperations = vi.fn(() => port);
    const operations = await loadNativeCheckOperations({ createLocalBashOperations });
    expect(await operations?.exec("assigned command", "/workspace", { onData: () => {} })).toEqual({ exitCode: 0 });
    expect(createLocalBashOperations).toHaveBeenCalledOnce();
  });

  it("reports unsupported APIs without substituting an unrelated shell runner", async () => {
    expect(await loadNativeCheckOperations({})).toBeUndefined();
    expect(await loadNativeCheckOperations({ createLocalBashOperations: () => ({}) })).toBeUndefined();
  });

  it("rejects malformed native exit evidence", async () => {
    const operations = await loadNativeCheckOperations({ createLocalBashOperations: () => ({ exec: async () => ({ exitCode: "0" }) }) });
    await expect(operations?.exec("assigned command", "/workspace", { onData: () => {} })).rejects.toThrow(/exit/i);
  });
});
