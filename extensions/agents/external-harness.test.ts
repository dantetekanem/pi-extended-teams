import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createExternalHarnessRun, type ExternalHarnessTransport } from "./external-harness";
import { createReportResult } from "../../src/results/report-result";

let root: string;
const runs: Array<ReturnType<typeof createExternalHarnessRun>> = [];
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "external-harness-tests-"));
  vi.spyOn(os, "tmpdir").mockReturnValue(root);
  vi.spyOn(process, "kill").mockReturnValue(true);
});
afterEach(async () => {
  await Promise.all(runs.splice(0).map(run => run.stop().catch(() => {})));
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "external-harness-test-"));
  const calls: string[][] = [];
  let promptText = "";
  let started = false;
  const transport: ExternalHarnessTransport = {
    async call(...args) {
      calls.push(args);
      if (args[0] === "pane" && args[1] === "current") return { pane: { pane_id: "w1:p1" } };
      if (args[0] === "pane" && args[1] === "layout") return { layout: { focused_pane_id: "w1:p2", panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 50 } }] } };
      if (args[0] === "pane" && args[1] === "split") return { pane: { pane_id: "w1:p900", terminal_id: "term-900" } };
      if (args[0] === "pane" && args[1] === "get") return { pane: { pane_id: "w1:p900", terminal_id: "term-900", agent: started ? "claude" : undefined } };
      if (args[0] === "pane" && args[1] === "process-info") return { process_info: { pane_id: "w1:p900", shell_pid: 900, foreground_process_group_id: started ? 901 : 900 } };
      if (args[0] === "pane" && args[1] === "close") {
        vi.mocked(process.kill).mockImplementation(() => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        });
      }
      if (args[0] === "agent" && args[1] === "get") return { agent: { pane_id: "w1:p900", terminal_id: "term-900", agent: "claude" } };
      if (args[0] === "agent" && args[1] === "start") started = true;
      if (args[0] === "agent" && args[1] === "prompt") promptText = args[3];
      return {};
    },
  };
  const profile = { name: "review", kind: "claude" as const, command: "claude", args: ["--model", "haiku; touch /tmp/nope"], instructions: "Do not edit. Keep literal {{runId}} and $&." };
  const make = (overrides: Record<string, unknown> = {}) => {
    const run = createExternalHarnessRun({
      profile, cwd, prompt: "Check this change", runId: "run-123", agentName: "ext_review",
      transport, herdrEnv: true, ...overrides,
    });
    runs.push(run);
    return run;
  };
  return { cwd, calls, make, transport, profile, getPrompt: () => promptText };
}

function pathFromPrompt(prompt: string, key: string) {
  const line = prompt.split("\n").find(line => line.startsWith(`${key}: `));
  if (!line) throw new Error(`Missing ${key}`);
  return line.slice(key.length + 2);
}

async function submit(prompt: string, completion: unknown, report: unknown) {
  const reportPath = pathFromPrompt(prompt, "Report file");
  const markerPath = pathFromPrompt(prompt, "Completion file");
  await fs.writeFile(`${reportPath}.tmp`, JSON.stringify(report), { mode: 0o600 });
  await fs.rename(`${reportPath}.tmp`, reportPath);
  await fs.writeFile(`${markerPath}.tmp`, JSON.stringify(completion), { mode: 0o600 });
  await fs.rename(`${markerPath}.tmp`, markerPath);
}

describe("external Herdr harness transport", () => {
  it.each(["rate_limit", "overloaded"])("observes the real StopFailure hook for %s without treating it as success", async error => {
    const f = await fixture();
    const run = f.make({ profile: { ...f.profile, nativeFallback: { modelSlot: "read-collect", model: "openai/test-model", thinking: "high" } } });
    await run.start();
    const args = f.calls.find(call => call[0] === "agent" && call[1] === "start")!;
    const settingsPath = args[args.indexOf("--settings") + 1];
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect((await fs.stat(settingsPath)).mode & 0o777).toBe(0o600);
    execFileSync("/bin/sh", ["-c", settings.hooks.StopFailure[0].hooks[0].command], {
      input: JSON.stringify({ hook_event_name: "StopFailure", error }), timeout: 5000,
    });
    await expect(run.result).rejects.toMatchObject({ name: "ExternalCapacityError", reason: error });
    expect(f.calls.some(call => call[1] === "close")).toBe(false);
    await run.stop();
  });

  it.each([
    { hook_event_name: "StopFailure", error: "authentication_failed" },
    { hook_event_name: "StopFailure", error: "billing_error" },
    { hook_event_name: "Stop", error: "rate_limit" },
    { hook_event_name: "StopFailure", error: "rate_limit", agent_id: "child" },
  ])("keeps non-capacity or child hook failures out of fallback: %j", async event => {
    const f = await fixture();
    const run = f.make({ profile: { ...f.profile, nativeFallback: { modelSlot: "read-collect", model: "openai/test-model", thinking: "high" } } });
    await run.start();
    const args = f.calls.find(call => call[0] === "agent" && call[1] === "start")!;
    const settings = JSON.parse(await fs.readFile(args[args.indexOf("--settings") + 1], "utf8"));
    execFileSync("/bin/sh", ["-c", settings.hooks.StopFailure[0].hooks[0].command], { input: JSON.stringify(event), timeout: 5000 });
    expect(await fs.readdir(path.dirname(run.reportPath!))).not.toContain("provider-error.json");
    await submit(f.getPrompt(), { runId: "run-123", outcome: "succeeded" }, { runId: "run-123", outcome: "succeeded", content: "Actual report", artifacts: [] });
    await expect(run.result).resolves.toMatchObject({ content: "Actual report" });
  });

  it("requires Herdr before creating a pane", async () => {
    const f = await fixture();
    const run = f.make({ herdrEnv: false });
    await expect(run.start()).rejects.toThrow(/Herdr/);
    expect(f.calls).toEqual([]);
    await expect(run.result).rejects.toThrow(/Herdr/);
    await expect(run.stop()).resolves.toBeUndefined();
  });

  it("persists pane before launch and passes literal argv without shell interpolation", async () => {
    const f = await fixture();
    let persisted = false;
    const run = f.make({ onPane: async (id: string) => { expect(id).toBe("w1:p900"); persisted = true; } });
    await run.start();
    expect(f.calls.find(c => c[0] === "agent" && c[1] === "start")).toEqual([
      "agent", "start", "ext_review", "--kind", "claude", "--pane", "w1:p900", "--timeout", "30000", "--", "--model", "haiku; touch /tmp/nope",
    ]);
    expect(persisted).toBe(true);
    expect(f.getPrompt()).toContain("Do not edit. Keep literal {{runId}} and $&.");
    expect(pathFromPrompt(f.getPrompt(), "Run ID")).toBe("run-123");
    const promptFile = pathFromPrompt(f.getPrompt(), "Prompt file");
    expect(await fs.readFile(promptFile, "utf8")).toBe("Check this change");
    expect((await fs.stat(path.dirname(promptFile))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(promptFile)).mode & 0o777).toBe(0o600);
    const pending = Promise.race([run.result.then(() => "settled", () => "rejected"), new Promise(resolve => setTimeout(() => resolve("pending"), 20))]);
    expect(await pending).toBe("pending");
    await submit(f.getPrompt(), { runId: "run-123", outcome: "succeeded" }, { runId: "run-123", outcome: "succeeded", content: "All good", artifacts: [] });
    await expect(run.result).resolves.toEqual({ outcome: "succeeded", content: "All good", artifacts: [
      { path: pathFromPrompt(f.getPrompt(), "Report file"), label: "External harness report" },
    ] });
    await run.stop();
  });

  it("normalizes extra artifact metadata for canonical report publication", async () => {
    const f = await fixture();
    const run = f.make();
    await run.start();
    const notesPath = path.join(f.cwd, "notes.md");
    await submit(f.getPrompt(), { runId: "run-123", outcome: "succeeded" }, {
      runId: "run-123", outcome: "succeeded", content: "Actual review findings",
      artifacts: [{ path: notesPath, label: "Notes", description: "Extra CLI metadata" }],
    });

    const result = await run.result;
    expect(result).toEqual({
      outcome: "succeeded", content: "Actual review findings", artifacts: [
        { path: pathFromPrompt(f.getPrompt(), "Report file"), label: "External harness report" },
        { path: notesPath, label: "Notes" },
      ],
    });
    expect(createReportResult("test", "reviewer", "run-123", {
      outcome: result.outcome, artifacts: result.artifacts,
    })).toMatchObject({ outcome: "succeeded", artifacts: result.artifacts });
  });

  it("rejects malformed or mismatched explicit completion and retains files", async () => {
    const f = await fixture();
    const run = f.make();
    await run.start();
    await submit(f.getPrompt(), { runId: "another", outcome: "succeeded" }, { runId: "run-123", outcome: "succeeded", content: "fake", artifacts: [] });
    await expect(run.result).rejects.toThrow(/runId|identity/);
    expect(await fs.readFile(pathFromPrompt(f.getPrompt(), "Report file"), "utf8")).toContain("fake");
    await run.stop();
  });

  it("stop during startup settles before exact cleanup and does not prompt", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const run = f.make({ onPane: async () => gate });
    const starting = run.start();
    await vi.waitFor(() => expect(f.calls.some(c => c[1] === "split")).toBe(true));
    const stopping = run.stop();
    release();
    await expect(starting).rejects.toThrow(/stopp|cancel/i);
    await stopping;
    expect(f.calls.some(c => c[1] === "start" || c[1] === "prompt")).toBe(false);
    expect(f.calls.some(c => c[0] === "pane" && c[1] === "close")).toBe(true);
  });

  it("stop during agent start waits for command settlement and closes only owned process", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.transport.call;
    let entered = false;
    f.transport.call = async (...args) => {
      if (args[0] === "agent" && args[1] === "start") { entered = true; await gate; }
      return original(...args);
    };
    const run = f.make();
    const starting = run.start();
    await vi.waitFor(() => expect(entered).toBe(true));
    const stopping = run.stop();
    release();
    await expect(starting).rejects.toThrow(/stopp/);
    await stopping;
    expect(f.calls.some(c => c[1] === "prompt")).toBe(false);
    expect(f.calls.some(c => c[1] === "close")).toBe(true);
  });

  it.each(["timeout", "incomplete receipt"])("retains uncertain cleanup after pane split %s", async failure => {
    const f = await fixture();
    const original = f.transport.call;
    let created = false;
    f.transport.call = async (...args) => {
      const response = await original(...args);
      if (args[0] === "pane" && args[1] === "split") {
        created = true;
        if (failure === "timeout") throw new Error("split timed out after creating pane");
        return { pane: { pane_id: "w1:p900" } };
      }
      return response;
    };
    const run = f.make();

    await expect(run.start()).rejects.toThrow(/split|identity/);
    await expect(run.stop()).rejects.toThrow(/uncertain|identity/);

    expect(created).toBe(true);
    expect(f.calls.some(call => call[0] === "pane" && call[1] === "close")).toBe(false);
  });

  it("does not close a replacement foreground command before agent launch", async () => {
    const f = await fixture();
    const original = f.transport.call;
    f.transport.call = async (...args) => {
      const response = await original(...args);
      if (args[1] === "process-info") return { process_info: { pane_id: "w1:p900", shell_pid: 900, foreground_process_group_id: 901 } };
      return response;
    };
    const run = f.make({ onPane: async () => { throw new Error("admission stopped"); } });

    await expect(run.start()).rejects.toThrow(/admission stopped/);
    await expect(run.stop()).rejects.toThrow(/identity/);

    expect(f.calls.some(call => call[1] === "start")).toBe(false);
    expect(f.calls.some(call => call[1] === "close")).toBe(false);
  });

  it("rejects a missing report even when completion claims success", async () => {
    const f = await fixture();
    const run = f.make();
    await run.start();
    await fs.writeFile(pathFromPrompt(f.getPrompt(), "Completion file"), JSON.stringify({ runId: "run-123", outcome: "succeeded" }));
    await expect(run.result).rejects.toThrow(/report/);
    await run.stop();
  });

  it("rejects non-regular completion artifacts without following symlinks", async () => {
    const f = await fixture();
    const run = f.make();
    await run.start();
    const marker = pathFromPrompt(f.getPrompt(), "Completion file");
    const outside = path.join(f.cwd, "forged.json");
    await fs.writeFile(outside, JSON.stringify({ runId: "run-123", outcome: "succeeded" }));
    await fs.symlink(outside, marker);
    await expect(run.result).rejects.toThrow(/completion/);
    await run.stop();
  });

  it("controls only the owned named agent, without treating focus as completion", async () => {
    const f = await fixture();
    const run = f.make();
    await run.start();
    await run.message("next task; no shell");
    await run.interrupt();
    await run.focus();
    expect(f.calls.filter(c => c[0] === "agent" && ["prompt", "send-keys", "focus"].includes(c[1])).slice(1)).toEqual([
      ["agent", "prompt", "ext_review", "next task; no shell"],
      ["agent", "send-keys", "ext_review", "esc"],
      ["agent", "focus", "ext_review"],
    ]);
    await run.stop();
  });

  it.each(["shell", "closed", "replacement"])("settles a killed process without a report when its pane is %s", async paneState => {
    const f = await fixture();
    const run = f.make();
    await run.start();
    const original = f.transport.call;
    f.transport.call = async (...args) => {
      if (args[0] === "pane" && args[1] === "get" && paneState === "closed") throw new Error("pane not found");
      if (args[1] === "process-info") return { process_info: {
        pane_id: "w1:p900", shell_pid: 900,
        foreground_process_group_id: paneState === "replacement" ? 902 : 900,
      } };
      return original(...args);
    };
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    await vi.waitFor(() => expect(process.kill).toHaveBeenCalledWith(-901, 0));
    await expect(run.result).rejects.toThrow(/exited.*report/i);
    await expect(run.message("do not send into the shell")).rejects.toThrow(/identity|stopped/);
    await expect(run.stop()).resolves.toBeUndefined();
    expect(f.calls.filter(call => call[1] === "close")).toHaveLength(paneState === "shell" ? 1 : 0);
  });

  it("keeps unknown process liveness pending until an explicit report", async () => {
    const f = await fixture();
    const run = f.make();
    await run.start();
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); });
    await vi.waitFor(() => expect(process.kill).toHaveBeenCalledWith(-901, 0));
    await submit(f.getPrompt(), { runId: "run-123", outcome: "succeeded" }, {
      runId: "run-123", outcome: "succeeded", content: "Actual result", artifacts: [],
    });
    await expect(run.result).resolves.toMatchObject({ outcome: "succeeded", content: "Actual result" });
  });

  it.each([
    ["alive", (): true => true],
    ["unknown", (): never => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    }],
  ] as const)("keeps cleanup blocked after successful pane close while the original group is %s", async (_state, probe) => {
    const f = await fixture();
    const run = f.make();
    await run.start();
    vi.mocked(process.kill).mockImplementation(probe);
    const original = f.transport.call;
    let paneClosed = false;
    f.transport.call = async (...args) => {
      if (args[0] === "pane" && args[1] === "get" && paneClosed) {
        throw new Error("pane not found");
      }
      if (args[0] === "pane" && args[1] === "close") {
        f.calls.push(args);
        paneClosed = true;
        return {};
      }
      return original(...args);
    };

    await expect(run.stop()).rejects.toThrow(/process exit.*not confirmed/i);
    expect(paneClosed).toBe(true);
    await expect(run.stop()).rejects.toThrow(/identity/);

    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    await expect(run.stop()).resolves.toBeUndefined();
    expect(f.calls.filter(call => call[0] === "pane" && call[1] === "close")).toHaveLength(1);
  });

  it("rechecks ownership after a failed cleanup instead of caching the failure forever", async () => {
    const f = await fixture();
    const run = f.make();
    await run.start();
    const original = f.transport.call;
    f.transport.call = async () => { throw new Error("Herdr unavailable"); };
    await expect(run.stop()).rejects.toThrow(/identity/);
    f.transport.call = original;
    await expect(run.stop()).resolves.toBeUndefined();
    expect(f.calls.filter(call => call[1] === "close")).toHaveLength(1);
  });

  it("refuses cleanup when the same pane/name holds a replacement process", async () => {
    const f = await fixture();
    const run = f.make();
    await run.start();
    const original = f.transport.call;
    f.transport.call = (...args) => args[1] === "process-info"
      ? Promise.resolve({ process_info: { pane_id: "w1:p900", foreground_process_group_id: 902 } })
      : original(...args);
    await expect(run.stop()).rejects.toThrow(/identity|cleanup/i);
    expect(f.calls.some(c => c[1] === "close")).toBe(false);
  });

  it("never closes a replacement occupant or a moved/replaced terminal", async () => {
    const f = await fixture();
    const run = f.make();
    await run.start();
    f.transport.call = async (...args) => {
      f.calls.push(args);
      if (args[1] === "get") return args[0] === "agent" ? { agent: { pane_id: "w1:p901", terminal_id: "other", agent: "claude" } } : { pane: { pane_id: "w1:p900", terminal_id: "other" } };
      return {};
    };
    await expect(run.stop()).rejects.toThrow(/identity|cleanup/i);
    expect(f.calls.some(c => c[1] === "close")).toBe(false);
    await expect(run.result).rejects.toThrow(/stopp|cancel/i);
  });
});
