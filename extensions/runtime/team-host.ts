import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Handler = (...args: any[]) => any;
export interface TeamHostBinding { pi: ExtensionAPI; ctx: any; event: any }

// Explicit root-facing capabilities used by the execution owner. This is not
// an ExtensionAPI proxy: registrations are data, and detached sends are kept
// separate from native agent work and its raw delivery promises.
export function createTeamHost() {
  let binding: TeamHostBinding | undefined;
  let generation = 0;
  let ready = false;
  let closed = false;
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const subscriptions = new Set<{ name: string; handler: Handler; unsubscribe?: () => void }>();
  const pending: Array<(pi: ExtensionAPI) => void> = [];
  const waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  const current = () => {
    if (!binding) throw new Error("The team host is detached during reload.");
    return binding;
  };
  function send(action: (pi: ExtensionAPI) => void) {
    if (binding && ready) action(binding.pi);
    else if (!closed) pending.push(action);
  }
  const api = {
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerShortcut(key: string, shortcut: any) { shortcuts.set(key, shortcut); },
    getCommands: () => current().pi.getCommands(),
    getAllTools: () => current().pi.getAllTools(),
    appendEntry: (...args: Parameters<ExtensionAPI["appendEntry"]>) => current().pi.appendEntry(...args),
    sendUserMessage: (...args: Parameters<ExtensionAPI["sendUserMessage"]>) => send(pi => pi.sendUserMessage(...args)),
    sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => send(pi => {
      if (typeof pi.sendMessage === "function") pi.sendMessage(...args);
      else pi.sendUserMessage(args[0].content);
    }),
    events: {
      emit(name: string, payload: unknown) { send(pi => pi.events.emit(name, payload)); },
      on(name: string, handler: Handler) {
        const subscription = { name, handler, unsubscribe: binding?.pi.events.on(name, handler) };
        subscriptions.add(subscription);
        return () => { subscription.unsubscribe?.(); subscriptions.delete(subscription); };
      },
    },
  };
  function detach() {
    ready = false;
    binding = undefined;
    generation++;
    for (const subscription of subscriptions) {
      subscription.unsubscribe?.();
      subscription.unsubscribe = undefined;
    }
  }
  function snapshot(ctx: any) {
    const epoch = generation;
    const available = () => binding && generation === epoch;
    const ui: Record<string, unknown> = {};
    for (const name of ["notify", "setStatus", "setWidget", "setTitle", "setEditorComponent", "setWorkingMessage", "setHeader", "setFooter"]) {
      ui[name] = (...args: unknown[]) => { if (available()) return binding!.ctx.ui?.[name]?.(...args); };
    }
    for (const name of ["custom", "select", "confirm", "input", "editor", "getEditorComponent", "getToolsExpanded"]) {
      ui[name] = (...args: unknown[]) => { if (available()) return binding!.ctx.ui?.[name]?.(...args); };
    }
    Object.defineProperty(ui, "theme", { get: () => available() ? binding!.ctx.ui?.theme : undefined });
    const trusted = ctx.isProjectTrusted?.() === true;
    return {
      cwd: ctx.cwd, sessionManager: ctx.sessionManager, modelRegistry: ctx.modelRegistry,
      model: ctx.model, thinkingLevel: ctx.thinkingLevel, hasUI: ctx.hasUI, mode: ctx.mode, ui,
      isProjectTrusted: () => trusted,
      isIdle: () => available() ? binding!.ctx.isIdle() : false,
      getContextUsage: () => available() ? binding!.ctx.getContextUsage?.() : undefined,
      getSystemPrompt: () => available() ? binding!.ctx.getSystemPrompt?.() : "",
      shutdown: () => { if (available()) return binding!.ctx.shutdown(); },
    };
  }
  return {
    api, tools, shortcuts, snapshot,
    get attached() { return !!binding; },
    get ready() { return ready && !!binding; },
    get context() { return binding ? snapshot(binding.ctx) : undefined; },
    attach(next: TeamHostBinding) {
      if (closed) throw new Error("The team execution owner is closing.");
      binding = next;
      ready = false;
      generation++;
      for (const subscription of subscriptions) subscription.unsubscribe = next.pi.events.on(subscription.name, subscription.handler);
    },
    detach,
    async emit(name: string, event: any, ctx: any) {
      let result: any;
      for (const handler of handlers.get(name) ?? []) {
        const value = await handler(event, ctx);
        if (value !== undefined) result = value;
      }
      return result;
    },
    flush() {
      ready = !!binding && !closed;
      while (ready && binding && pending.length) {
        const action = pending.shift()!;
        // Remove before invoking: a thrown/uncertain host send is not replayed.
        try { action(binding.pi); }
        catch (error) { binding.ctx.ui?.notify?.(`Team delivery needs attention: ${String(error)}. Read the saved inbox/reports.`, "warning"); }
      }
      if (binding) { for (const waiter of waiters) waiter.resolve(); waiters.clear(); }
    },
    whenAttached(): Promise<void> {
      if (closed) return Promise.reject(new Error("Team execution is closing."));
      if (binding && ready) return Promise.resolve();
      return new Promise((resolve, reject) => waiters.add({ resolve, reject }));
    },
    close() {
      closed = true;
      detach();
      for (const waiter of waiters) waiter.reject(new Error("Team reload recovery expired or the session closed."));
      waiters.clear();
    },
  };
}
