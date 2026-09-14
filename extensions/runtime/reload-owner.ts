export interface ReloadOwner<Attachment> {
  attach(attachment: Attachment): void | Promise<void>;
  detach(): void;
  close(reason: string): Promise<void>;
  hasWork(): boolean;
}

interface RetainedOwner {
  owner: ReloadOwner<unknown>;
  state: "attaching" | "attached" | "detached" | "closing";
  generation: number;
  deadline?: number;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
}

interface Registry {
  version: 1;
  sessions: WeakMap<object, Map<string, RetainedOwner>>;
}

const REGISTRY_KEY = Symbol.for("pi-extended-teams.reload-owners.v1");
const RECOVERY_WINDOW_MS = 60_000;

// Pi re-evaluates modules on reload, but keeps the Node realm and (in the
// supported host) the root SessionManager. Session IDs alone can collide
// between two independent hosts opening the same saved conversation.
function registry(): Registry {
  const globals = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  return globals[REGISTRY_KEY] ??= { version: 1, sessions: new WeakMap() };
}

export async function connectReloadOwner<Attachment>(
  manager: object,
  sessionId: string,
  attachment: Attachment,
  createOwner: () => ReloadOwner<Attachment>,
): Promise<{ owner: ReloadOwner<Attachment>; shutdown(reason: string): Promise<void> }> {
  const sessions = registry().sessions;
  let owners = sessions.get(manager);
  if (!owners) sessions.set(manager, owners = new Map());
  let record = owners.get(sessionId);
  if (record && record.state !== "detached") {
    throw new Error(`Team execution owner is ${record.state}; refusing a replacement.`);
  }
  if (!record) {
    record = { owner: createOwner() as ReloadOwner<unknown>, state: "attaching", generation: 0 };
    owners.set(sessionId, record);
  }
  const current = record;
  const generation = ++current.generation;
  current.state = "attaching";

  const close = (reason: string): Promise<void> => {
    if (current.closing) return current.closing;
    current.state = "closing";
    current.generation++;
    clearTimeout(current.timer);
    current.closing = Promise.resolve().then(() => current.owner.close(reason)).then(() => {
      if (owners.get(sessionId) === current) owners.delete(sessionId);
    });
    return current.closing;
  };
  const armDeadline = (): void => {
    clearTimeout(current.timer);
    const epoch = current.generation;
    current.timer = setTimeout(() => {
      if (current.generation !== epoch || current.state === "attached") return;
      // A failed cleanup remains in the registry as a fence. Durable lifecycle
      // records retain the cleanup evidence; do not silently replace this owner.
      void close("reload-timeout").catch(() => {});
    }, Math.max(0, (current.deadline ?? Date.now()) - Date.now()));
    current.timer.unref?.();
  };

  const isClosing = () => current.state === "closing";
  if (current.deadline !== undefined) armDeadline();
  try {
    await current.owner.attach(attachment);
    if (current.generation !== generation || current.state !== "attaching") {
      throw new Error("Team reload attachment expired while reconnecting.");
    }
    clearTimeout(current.timer);
    current.deadline = undefined;
    current.state = "attached";
  } catch (error) {
    if (!isClosing()) {
      current.owner.detach();
      current.state = "detached";
      current.deadline ??= Date.now() + RECOVERY_WINDOW_MS;
      armDeadline();
    }
    throw error;
  }

  return {
    owner: current.owner as ReloadOwner<Attachment>,
    async shutdown(reason) {
      if (current.generation !== generation || current.state !== "attached") return;
      if (reason !== "reload" || !current.owner.hasWork()) return close(reason);
      current.owner.detach();
      current.state = "detached";
      current.deadline = Date.now() + RECOVERY_WINDOW_MS;
      armDeadline();
    },
  };
}
