import type { CheckOperations } from "../../src/results/check-runner";
import { loadPiRuntimeApi } from "./pi-runtime-api";

export async function loadNativeCheckOperations(suppliedApi?: unknown): Promise<CheckOperations | undefined> {
  const api: unknown = suppliedApi === undefined ? await loadPiRuntimeApi() : suppliedApi;
  if (typeof api !== "object" || api === null) return undefined;
  const factory: unknown = Reflect.get(api, "createLocalBashOperations");
  if (typeof factory !== "function") return undefined;
  const operations: unknown = factory();
  if (typeof operations !== "object" || operations === null) return undefined;
  const exec: unknown = Reflect.get(operations, "exec");
  if (typeof exec !== "function") return undefined;
  return {
    async exec(command, cwd, options) {
      const result: unknown = await Reflect.apply(exec, operations, [command, cwd, options]);
      if (typeof result !== "object" || result === null) throw new Error("Native check returned no exit evidence.");
      const exitCode: unknown = Reflect.get(result, "exitCode");
      if (exitCode !== null && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) {
        throw new Error("Native check returned invalid exit evidence.");
      }
      return { exitCode };
    },
  };
}
