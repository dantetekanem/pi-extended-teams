import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

const NATIVE_FACTORIES = {
  "builtin:mcp": "createMcpExtension",
  "builtin:codemode": "createCodemodeExtension",
  "builtin:tool-search": "createToolSearchExtension",
} as const;

type NativeExtensionPath = keyof typeof NATIVE_FACTORIES;

export function isNativeExtensionPath(value: string): value is NativeExtensionPath {
  return Object.hasOwn(NATIVE_FACTORIES, value);
}

export interface NativeExtensionFactory {
  name: string;
  factory: ExtensionFactory;
  builtin: true;
  replaceable: true;
}

/** Only selected builtins are instantiated, using exports from the running host. */
export function createNativeExtensionFactories(api: object, paths: readonly string[]): NativeExtensionFactory[] {
  return paths.filter(isNativeExtensionPath).map(identity => {
    const createFactory: unknown = Reflect.get(api, NATIVE_FACTORIES[identity]);
    if (typeof createFactory !== "function") {
      throw new Error(`Selected extension ${identity} is not supported by this Pi host.`);
    }
    return {
      name: identity.slice("builtin:".length),
      factory: createFactory(),
      builtin: true,
      replaceable: true,
    };
  });
}
