import type { AgentSession, EventBus, ExtensionFactory, ResourceLoader, SettingsManager, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { PiRuntimeApi } from "../extensions/internal/pi-runtime-api";

type ParentSession = { getSessionId(): string };
export interface NativeChildPreparation {
  parentSessionId: string;
  teamName: string;
  agentName: string;
  cwd: string;
  role: "read" | "write";
  piRuntimeApi: PiRuntimeApi;
  eventBus: EventBus;
  mandatoryFactories: ExtensionFactory[];
  rolePrompt: string[];
}
export interface NativeChildServices {
  resourceLoader: ResourceLoader;
  settingsManager: SettingsManager;
  tools: string[];
  excludeTools?: string[];
  customTools?: ToolDefinition[];
}
export interface NativeChildPolicy {
  prepare(input: NativeChildPreparation): NativeChildServices | Promise<NativeChildServices>;
  enroll(session: AgentSession): void | Promise<void>;
  assertReady(session: AgentSession): void | Promise<void>;
}

type Registration = { policy: NativeChildPolicy; retired: boolean };
const registryKey = Symbol.for("pi-extended-teams.native-child-policy.v1");
const host = globalThis as typeof globalThis & { [registryKey]?: WeakMap<ParentSession, Map<string, Registration>> };
// Shared by separately loaded package copies, without retaining dead parent managers.
const registrations = host[registryKey] ??= new WeakMap<ParentSession, Map<string, Registration>>();

/** Trusted host API only. Retirement fences queued launches rather than restoring ambient defaults. */
export function registerNativeChildPolicy(parent: ParentSession, policy: NativeChildPolicy): () => void {
  const id = parent.getSessionId();
  if (!id || !policy || [policy.prepare, policy.enroll, policy.assertReady].some(fn => typeof fn !== "function")) {
    throw new Error("Native child policy requires a parent session and all startup hooks.");
  }
  let entries = registrations.get(parent);
  if (!entries) {
    entries = new Map();
    registrations.set(parent, entries);
  }
  if (entries.has(id)) throw new Error("Native child policy already registered for this parent session.");
  const entry = { policy, retired: false };
  entries.set(id, entry);
  return () => { entry.retired = true; };
}

export function hasNativeChildPolicy(parent: ParentSession | undefined): boolean {
  return !!parent && registrations.get(parent)?.has(parent.getSessionId()) === true;
}

/** Runner boundary; no public spawn parameter can select or bypass this registration. */
export async function prepareNativeChildPolicy(parent: ParentSession | undefined, input: Omit<NativeChildPreparation, "parentSessionId">) {
  const parentSessionId = parent?.getSessionId();
  const entry = parent && parentSessionId ? registrations.get(parent)?.get(parentSessionId) : undefined;
  if (!entry) return undefined;
  const assertActive = () => {
    if (entry.retired || parent?.getSessionId() !== parentSessionId) throw new Error("Native child policy retired or parent session changed.");
  };
  assertActive();
  const services = await entry.policy.prepare({ ...input, parentSessionId: parentSessionId! });
  assertActive();
  if (!services?.resourceLoader || !services.settingsManager || !Array.isArray(services.tools)) {
    throw new Error("Native child policy did not provide explicit child services.");
  }
  return {
    ...services,
    enroll: async (session: AgentSession) => {
      assertActive();
      await entry.policy.enroll(session);
      assertActive();
    },
    assertReady: async (session: AgentSession) => {
      assertActive();
      await entry.policy.assertReady(session);
      assertActive();
    },
  };
}
