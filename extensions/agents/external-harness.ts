import { execFile } from "node:child_process";
import fs from "node:fs";
import { promises as files, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExternalHarnessProfile } from "../../src/utils/external-harness-config";
import { shellQuote } from "../internal/pi-command";

export class ExternalCapacityError extends Error {
  constructor(readonly reason: "rate_limit" | "overloaded") {
    super(`External provider unavailable: ${reason}`);
    this.name = "ExternalCapacityError";
  }
}

export type ExternalHarnessOutcome = "succeeded" | "blocked" | "failed" | "cancelled";
export interface ExternalHarnessResult {
  outcome: ExternalHarnessOutcome;
  content: string;
  artifacts: Array<{ path: string; label?: string }>;
}

/** call returns the JSON `result` envelope from the installed Herdr CLI. */
export interface ExternalHarnessTransport {
  call(...args: string[]): Promise<Record<string, unknown>>;
}

const cli: ExternalHarnessTransport = {
  call: (...args) => new Promise((resolve, reject) => {
    const options = {
      encoding: "utf8" as const,
      timeout: args[1] === "start" ? 35_000 : 5_000,
      maxBuffer: 1024 * 1024,
    };
    execFile("herdr", args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Herdr ${args[0]} ${args[1]} failed: ${stderr.trim() || error.message}`));
        return;
      }
      try {
        const envelope = JSON.parse(stdout) as { result?: Record<string, unknown> };
        if (!envelope.result || typeof envelope.result !== "object") throw new Error("missing result");
        resolve(envelope.result);
      } catch (cause) {
        reject(new Error(`Invalid Herdr response: ${String(cause)}`));
      }
    });
  }),
};

interface RunOptions {
  profile: ExternalHarnessProfile;
  cwd: string;
  prompt: string;
  runId: string;
  agentName: string;
  onPane?(paneId: string): Promise<void>;
  /** Test seam; production always uses the installed Herdr CLI. */
  transport?: ExternalHarnessTransport;
  herdrEnv?: boolean;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Herdr/result object");
  return value as Record<string, unknown>;
}

function outcome(value: unknown): value is ExternalHarnessOutcome {
  return value === "succeeded" || value === "blocked" || value === "failed" || value === "cancelled";
}

async function boundedJson(filename: string, maxBytes: number): Promise<Record<string, unknown>> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | fsConstants.O_NONBLOCK;
  const handle = await files.open(filename, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes || stat.size === 0) throw new Error(`Invalid or oversized artifact: ${filename}`);
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) throw new Error(`Incomplete artifact: ${filename}`);
    return object(JSON.parse(bytes.toString("utf8")));
  } finally {
    await handle.close();
  }
}

export function createExternalHarnessRun({ profile, cwd, prompt, runId, agentName, onPane, transport = cli, herdrEnv = process.env.HERDR_ENV === "1" }: RunOptions) {
  let paneId: string | undefined;
  let terminalId: string | undefined;
  let splitAttempted = false;
  let launchAttempted = false;
  let processGroupId: number | undefined;
  let stopped = false;
  let cleanupComplete = false;
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let watcher: fs.FSWatcher | undefined;
  let fallback: NodeJS.Timeout | undefined;
  let settled = false;
  let resolveResult!: (result: ExternalHarnessResult) => void;
  let rejectResult!: (reason: Error) => void;
  const result = new Promise<ExternalHarnessResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A startup failure may precede the caller attaching to result.
  void result.catch(() => {});
  let directory: string | undefined;
  let markerPath: string | undefined;
  let reportPath: string | undefined;
  let capacityPath: string | undefined;

  function settle(value: ExternalHarnessResult | Error) {
    if (settled) return;
    settled = true;
    watcher?.close();
    if (fallback) clearInterval(fallback);
    if (value instanceof Error) rejectResult(value);
    else resolveResult(value);
  }

  async function checkCompletion() {
    if (settled || !markerPath || !reportPath) return;
    let marker: Record<string, unknown>;
    try {
      marker = await boundedJson(markerPath, 4096);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      settle(new Error(`Invalid external completion: ${String(error)}`));
      return;
    }
    try {
      if (marker.runId !== runId || !outcome(marker.outcome)) throw new Error("completion runId/outcome identity mismatch");
      const report = await boundedJson(reportPath, 1024 * 1024);
      if (report.runId !== runId || report.outcome !== marker.outcome) throw new Error("report runId/outcome identity mismatch");
      if (typeof report.content !== "string" || !report.content.trim()) throw new Error("empty report content");
      if (!Array.isArray(report.artifacts) || report.artifacts.length > 64 || !report.artifacts.every(item => {
        if (!item || typeof item !== "object") return false;
        const entry = item as Record<string, unknown>;
        return typeof entry.path === "string" && path.isAbsolute(entry.path) && entry.path.length <= 4096 &&
          (entry.label === undefined || (typeof entry.label === "string" && entry.label.length <= 256));
      })) throw new Error("invalid report artifacts");
      settle({
        outcome: marker.outcome,
        content: report.content,
        artifacts: [
          { path: reportPath, label: "External harness report" },
          ...(report.artifacts as ExternalHarnessResult["artifacts"]).map(({ path, label }) => ({
            path,
            ...(label !== undefined ? { label } : {}),
          })),
        ],
      });
    } catch (error) {
      settle(new Error(`Invalid external report: ${String(error)}`));
    }
  }

  function processExited(): boolean {
    if (processGroupId === undefined) return false;
    try {
      process.kill(-processGroupId, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  async function checkCapacity() {
    if (settled || !capacityPath) return;
    try {
      const failure = await boundedJson(capacityPath, 4096);
      if (failure.runId !== runId || (failure.reason !== "rate_limit" && failure.reason !== "overloaded")) {
        throw new Error("Invalid external capacity signal identity or reason");
      }
      settle(new ExternalCapacityError(failure.reason));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        settle(new Error(`Invalid external capacity signal: ${String(error)}`));
      }
    }
  }

  async function checkRun() {
    await checkCompletion();
    await checkCapacity();
    if (settled || !processExited()) return;
    // Re-read after exit proof so a final marker written during the first read wins.
    await checkCompletion();
    if (!settled) settle(new Error("External harness process exited without an explicit report."));
  }

  function observe() {
    if (!directory) throw new Error("No external run directory");
    // Watch is an acceleration; bounded-interval filesystem checks cover dropped watch events.
    try {
      watcher = fs.watch(directory, () => { void checkRun(); });
    } catch {
      // The fallback still observes marker creation.
    }
    fallback = setInterval(() => { void checkRun(); }, 500);
    fallback.unref();
    void checkRun();
  }

  async function ownedPane(): Promise<boolean> {
    if (!paneId || !terminalId) return false;
    try {
      const pane = object((await transport.call("pane", "get", paneId)).pane);
      if (pane.pane_id !== paneId || pane.terminal_id !== terminalId) return false;
      if (!launchAttempted && pane.agent) return false;
      if (!pane.agent) {
        const info = object((await transport.call("pane", "process-info", "--pane", paneId)).process_info);
        return info.pane_id === paneId && typeof info.shell_pid === "number" &&
          info.foreground_process_group_id === info.shell_pid;
      }
      const agent = object((await transport.call("agent", "get", agentName)).agent);
      if (agent.pane_id !== paneId || agent.terminal_id !== terminalId || agent.agent !== profile.kind) return false;
      if (processGroupId === undefined) return false;
      const processInfo = object((await transport.call("pane", "process-info", "--pane", paneId)).process_info);
      return processInfo.pane_id === paneId && (
        processInfo.foreground_process_group_id === processGroupId || (
          typeof processInfo.shell_pid === "number" &&
          processInfo.foreground_process_group_id === processInfo.shell_pid && processExited()
        )
      );
    } catch {
      return false;
    }
  }

  async function closeOwnedPane() {
    if (!splitAttempted || cleanupComplete) return;
    if (!paneId || !terminalId) {
      throw new Error(`Herdr pane split outcome is uncertain; cleanup cannot be verified. Artifacts retained at ${directory}.`);
    }
    try {
      if (!(await ownedPane())) throw new Error(`External harness cleanup could not verify pane identity (${paneId}). Artifacts retained at ${directory}.`);
      await transport.call("pane", "close", paneId);
    } catch (error) {
      // A dead process needs no termination. Never close a missing/reused/unverified pane.
      if (!processExited()) throw error;
    }
    if (launchAttempted && !processExited()) {
      throw new Error(`External harness process exit is not confirmed; cleanup remains fenced. Artifacts retained at ${directory}.`);
    }
    cleanupComplete = true;
  }

  async function performStart() {
    if (!herdrEnv) throw new Error("External harness requires Herdr (HERDR_ENV=1).");
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agentName)) throw new Error("Invalid Herdr agent name.");
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(runId) || !Array.isArray(profile.args) || !["claude", "opencode", "amp", "codex"].includes(profile.kind)) throw new Error("Invalid external harness run/profile.");
    if (Buffer.byteLength(prompt) > 128 * 1024 || Buffer.byteLength(profile.instructions) > 128 * 1024) throw new Error("External harness prompt is too large.");
    directory = await files.mkdtemp(path.join(os.tmpdir(), "pi-external-harness-"));
    await files.chmod(directory, 0o700);
    const promptPath = path.join(directory, "prompt.md");
    reportPath = path.join(directory, "report.json");
    markerPath = path.join(directory, "complete.json");
    const args = [...profile.args];
    if (profile.nativeFallback) {
      capacityPath = path.join(directory, "provider-error.json");
      const settingsPath = path.join(directory, "settings.json");
      const command = [process.execPath, path.join(__dirname, "external-capacity-hook.mjs"), capacityPath, runId].map(shellQuote).join(" ");
      const hookSettings = {
        hooks: {
          StopFailure: [{
            matcher: "rate_limit|overloaded",
            hooks: [{ type: "command", command, timeout: 5 }],
          }],
        },
      };
      await files.writeFile(settingsPath, JSON.stringify(hookSettings), { mode: 0o600, flag: "wx" });
      args.push("--settings", settingsPath);
    }
    await files.writeFile(promptPath, prompt, { mode: 0o600, flag: "wx" });
    const template = await files.readFile(path.join(__dirname, "../prompts/external-harness.md"), "utf8");
    const values: Record<string, string> = { instructions: profile.instructions, runId, promptPath, reportPath, completionPath: markerPath };
    const launchPrompt = template.replace(/\{\{(instructions|runId|promptPath|reportPath|completionPath)\}\}/g, (_match, name: string) => values[name]);
    const caller = object((await transport.call("pane", "current", "--current")).pane);
    const layout = object((await transport.call("pane", "layout", "--current")).layout);
    const panes = Array.isArray(layout.panes) ? layout.panes : [];
    const current = panes.find(item => object(item).pane_id === caller.pane_id) as Record<string, unknown> | undefined;
    const rect = current?.rect ? object(current.rect) : {};
    const direction = typeof rect.width === "number" && typeof rect.height === "number" && rect.width < rect.height * 2 ? "down" : "right";
    splitAttempted = true;
    const split = object((await transport.call("pane", "split", "--current", "--direction", direction, "--cwd", cwd, "--no-focus")).pane);
    if (typeof split.pane_id !== "string" || typeof split.terminal_id !== "string") throw new Error("Herdr split omitted pane identity.");
    paneId = split.pane_id;
    terminalId = split.terminal_id;
    await onPane?.(paneId);
    if (stopped) throw new Error("External harness startup stopped.");
    launchAttempted = true;
    try {
      await transport.call("agent", "start", agentName, "--kind", profile.kind, "--pane", paneId, "--timeout", "30000", "--", ...args);
    } finally {
      // A blocked startup can still leave an agent. Capture its process identity if present.
      const info = await transport.call("pane", "process-info", "--pane", paneId).catch(() => undefined);
      const processInfo = info?.process_info ? object(info.process_info) : undefined;
      const group = processInfo?.foreground_process_group_id;
      if (typeof group === "number" && Number.isSafeInteger(group) && group > 0 && group !== processInfo?.shell_pid) {
        processGroupId = group;
      }
    }
    if (processGroupId === undefined) throw new Error("Herdr did not expose the started agent process identity.");
    if (stopped) throw new Error("External harness startup stopped.");
    await transport.call("agent", "prompt", agentName, launchPrompt);
    if (stopped) throw new Error("External harness startup stopped.");
    observe();
  }

  function start() {
    if (starting) return starting;
    if (stopped) return Promise.reject(new Error("External harness already stopped."));
    starting = performStart().catch(async error => {
      const failure = new Error(`${String(error)}${directory ? ` Artifacts retained at ${directory}.` : ""}`);
      settle(failure);
      try {
        await closeOwnedPane();
      } catch {
        // stop() must surface unresolved cleanup to the owner.
      }
      throw failure;
    });
    return starting;
  }

  function stop() {
    if (stopping) return stopping;
    stopped = true;
    stopping = (async () => {
      // Startup commands have bounded CLI timeouts; never wait for report processing.
      try {
        await starting;
      } catch {
        // Startup owns its error.
      }
      settle(new Error("External harness stopped before an explicit result."));
      await closeOwnedPane();
    })().catch(error => {
      stopping = undefined;
      throw error;
    });
    return stopping;
  }

  async function control(action: "focus" | "message" | "interrupt", content?: string) {
    if (!starting) throw new Error("External harness has not started.");
    await starting;
    if (stopped || processExited() || !(await ownedPane()) || stopped) throw new Error("External harness agent identity changed or stopped.");
    if (action === "focus") await transport.call("agent", "focus", agentName);
    else if (action === "message") await transport.call("agent", "prompt", agentName, content!);
    else await transport.call("agent", "send-keys", agentName, "esc");
  }

  return {
    get reportPath() { return reportPath; },
    start, result, stop,
    focus: () => control("focus"),
    message: (content: string) => control("message", content),
    interrupt: () => control("interrupt"),
  };
}
