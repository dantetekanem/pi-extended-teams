import { describe, expect, it, vi } from "vitest";
import { createNativeExtensionFactories } from "./native-extensions";

describe("native extension capabilities", () => {
  it("leaves legacy hosts on their existing external-extension path", () => {
    expect(createNativeExtensionFactories({}, ["/extensions/review.ts"])).toEqual([]);
  });

  it("instantiates only selected builtins without replacing native configuration", () => {
    const factory = vi.fn();
    const api = {
      createMcpExtension: vi.fn(() => factory),
      createCodemodeExtension: vi.fn(),
      createToolSearchExtension: vi.fn(),
    };
    expect(createNativeExtensionFactories(api, ["/extensions/review.ts", "builtin:mcp"])).toEqual([
      { name: "mcp", factory, builtin: true, replaceable: true },
    ]);
    expect(api.createMcpExtension).toHaveBeenCalledExactlyOnceWith();
    expect(api.createCodemodeExtension).not.toHaveBeenCalled();
    expect(api.createToolSearchExtension).not.toHaveBeenCalled();
  });

  it("rejects an unavailable requested capability before invoking the loader", () => {
    expect(() => createNativeExtensionFactories({}, ["builtin:mcp"])).toThrow("builtin:mcp is not supported by this Pi host");
  });
});
